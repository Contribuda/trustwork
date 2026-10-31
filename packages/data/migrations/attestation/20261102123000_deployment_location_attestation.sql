-- SANC-009: deployment-location attestation (ADR 014 decisions 3 to 5; data model section 24a).
--
-- The engine never geolocates the server it runs on and never disables itself by location (ADR 014 decision 3).
-- Instead the operator states, in the setup wizard and under an elevated staff session, the country (and region where
-- the restricted list distinguishes regions) of its legal entity and of the hosting, and the jurisdiction-gate mode it
-- runs. A restricted place (the synced kernel list, mirrored from packages/country-packs/packs/restricted.json) is
-- refused. Each attestation is an append-only row bound by a trustwork-digest-1 statement digest to the attesting
-- person, the staff role and permission that authorized it and the elevation it was made under, and an
-- admin_audit_event row is written in the same transaction. It expires 365 days after it was made and is renewed by a
-- new row that supersedes the current one, at the latest yearly and whenever a location or the gate mode changes.
--
-- The attestation is evidence, not a guarantee (decision 5): an operator can state something untrue. It complements the
-- refusals in configuration, country packs and the kernel (kernel_place_restricted); it never replaces them.
--
-- Commands (SECURITY DEFINER, allowlisted for the runtime role):
--   attestation_attest            attest or renew: node or platform staff holding admin.node.hubs.manage or
--                                 admin.hub.jurisdiction.edit at the node, under an elevation; restricted places refused;
--                                 the caller names the attestation it supersedes (NULL for the first), so of two
--                                 simultaneous attestations exactly one is recorded and the other is told it is stale
--   attestation_record_refusal    the denied audit row of a refused attempt, written by the API in its own transaction
--                                 after the attest transaction rolled back (it re-checks authority and the refusal)
--   attestation_current           the current attestation without the attesting person (launch gate, node manifest)
--   attestation_in_force          is there a current, unexpired attestation naming no restricted place?
--   attestation_reader            row-level security: node staff who may read the full rows
-- No column of this module stores a network address or anything detected about the server.

-- 1. Attestations (append-only, superseding) -------------------------------------------------------------------------
CREATE TABLE trustwork.deployment_location_attestation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  operator_entity_country text NOT NULL CHECK (operator_entity_country ~ '^[A-Z]{2}$'),
  operator_entity_region text NULL CHECK (operator_entity_region ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  hosting_country text NOT NULL CHECK (hosting_country ~ '^[A-Z]{2}$'),
  hosting_region text NULL CHECK (hosting_region ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  gate_mode text NOT NULL CHECK (gate_mode IN ('ranges_file', 'edge_header', 'upstream_gate')),
  statement_version text NOT NULL CHECK (statement_version = 'deployment-location-1'),
  statement_digest text NOT NULL CHECK (statement_digest ~ '^[a-f0-9]{64}$'),
  attested_by uuid NOT NULL REFERENCES trustwork.person (id),
  attester_role text NOT NULL CHECK (attester_role = ANY (trustwork.admin_staff_roles())),
  permission text NOT NULL CHECK (permission IN ('admin.node.hubs.manage', 'admin.hub.jurisdiction.edit')),
  -- Stored without a foreign key like admin_audit_event.session_elevation_id: the record outlives swept elevations.
  session_elevation_id uuid NOT NULL,
  breakglass boolean NOT NULL DEFAULT false,
  attested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  supersedes_id uuid NULL UNIQUE REFERENCES trustwork.deployment_location_attestation (id),
  CONSTRAINT deployment_location_attestation_entity_region CHECK (operator_entity_region IS NULL OR left(operator_entity_region, 2) = operator_entity_country),
  CONSTRAINT deployment_location_attestation_hosting_region CHECK (hosting_region IS NULL OR left(hosting_region, 2) = hosting_country),
  CONSTRAINT deployment_location_attestation_yearly CHECK (expires_at = attested_at + interval '365 days'),
  CONSTRAINT deployment_location_attestation_not_self CHECK (supersedes_id IS DISTINCT FROM id)
);
-- One first attestation per node; every later one supersedes exactly one (the UNIQUE on supersedes_id), so the chain
-- has one head: the current attestation.
CREATE UNIQUE INDEX deployment_location_attestation_first ON trustwork.deployment_location_attestation (node_id) WHERE supersedes_id IS NULL;
CREATE INDEX deployment_location_attestation_node_idx ON trustwork.deployment_location_attestation (node_id, attested_at);

-- Inserts come only from the definer command (maintenance flag on); a superseded row belongs to the same node.
CREATE FUNCTION trustwork.attestation_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.maintenance_on() IS NOT TRUE THEN
    RAISE EXCEPTION 'attestations are recorded only through attestation_attest' USING ERRCODE = 'insufficient_privilege', HINT = 'attestation.command_only';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.deployment_location_attestation p WHERE p.id = NEW.supersedes_id AND p.node_id = NEW.node_id) THEN
    RAISE EXCEPTION 'an attestation supersedes one of the same node' USING ERRCODE = '23514', HINT = 'attestation.supersedes_other_node';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deployment_location_attestation_insert BEFORE INSERT ON trustwork.deployment_location_attestation FOR EACH ROW EXECUTE FUNCTION trustwork.attestation_insert_guard();
CREATE TRIGGER deployment_location_attestation_append_only BEFORE UPDATE OR DELETE ON trustwork.deployment_location_attestation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER deployment_location_attestation_no_truncate BEFORE TRUNCATE ON trustwork.deployment_location_attestation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Helpers (invoker; no grant except where stated) ---------------------------------------------------------------------
-- The permissions that authorize an attestation, in preference order (the audit row names the one used). Both are
-- resolved at the node: a hub-scoped assignment never covers it, so only node or platform staff attest.
CREATE FUNCTION trustwork.attestation_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.node.hubs.manage', 'admin.hub.jurisdiction.edit']::text[]
$$;

-- Must a place in this country be stated with its region? Yes when the restricted list names a region of the country
-- (for example UA-43 for UA): without the region the engine cannot tell a listed region from an unlisted one.
CREATE FUNCTION trustwork.attestation_region_required(p_country text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.restricted_place r WHERE r.code LIKE p_country || '-%')
$$;

-- Why a statement is refused: one 'field:place:reason' entry per refused place ('restricted' or 'region_required'),
-- empty when nothing is refused. An unsynced restricted list refuses every place (kernel_place_restricted fails closed).
CREATE FUNCTION trustwork.attestation_refusals(p_entity_country text, p_entity_region text, p_hosting_country text, p_hosting_region text) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(f.field || ':' || f.place || ':' || f.reason ORDER BY f.ord), ARRAY[]::text[])
  FROM (
    SELECT 1 AS ord, 'operator_entity_country' AS field, p_entity_country AS place, 'restricted' AS reason WHERE trustwork.kernel_place_restricted(p_entity_country)
    UNION ALL
    SELECT 2, 'operator_entity_region', p_entity_region, 'restricted' WHERE p_entity_region IS NOT NULL AND trustwork.kernel_place_restricted(p_entity_region)
    UNION ALL
    SELECT 3, 'operator_entity_region', p_entity_country, 'region_required'
     WHERE p_entity_region IS NULL AND NOT trustwork.kernel_place_restricted(p_entity_country) AND trustwork.attestation_region_required(p_entity_country)
    UNION ALL
    SELECT 4, 'hosting_country', p_hosting_country, 'restricted' WHERE trustwork.kernel_place_restricted(p_hosting_country)
    UNION ALL
    SELECT 5, 'hosting_region', p_hosting_region, 'restricted' WHERE p_hosting_region IS NOT NULL AND trustwork.kernel_place_restricted(p_hosting_region)
    UNION ALL
    SELECT 6, 'hosting_region', p_hosting_country, 'region_required'
     WHERE p_hosting_region IS NULL AND NOT trustwork.kernel_place_restricted(p_hosting_country) AND trustwork.attestation_region_required(p_hosting_country)
  ) f
$$;

-- The statement the digest binds (deploymentAttestationStatement in packages/contracts/src/sanctions-attestation.ts computes the
-- same bytes with computeDigest; tests compare both). Times are ISO 8601 UTC with milliseconds, as Date#toISOString.
CREATE FUNCTION trustwork.attestation_iso(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION trustwork.attestation_statement(p_row trustwork.deployment_location_attestation) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'statementVersion', p_row.statement_version, 'nodeId', p_row.node_id::text,
    'operatorEntityCountry', p_row.operator_entity_country, 'operatorEntityRegion', p_row.operator_entity_region,
    'hostingCountry', p_row.hosting_country, 'hostingRegion', p_row.hosting_region, 'gateMode', p_row.gate_mode,
    'attestedBy', p_row.attested_by::text, 'sessionElevationId', p_row.session_elevation_id::text,
    'attestedAt', trustwork.attestation_iso(p_row.attested_at), 'expiresAt', trustwork.attestation_iso(p_row.expires_at),
    'supersedesId', p_row.supersedes_id::text)
$$;

-- The current attestation of the node: the head of the chain (superseded by nobody).
CREATE FUNCTION trustwork.attestation_head(p_node uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT a.id FROM trustwork.deployment_location_attestation a
  WHERE a.node_id = p_node AND NOT EXISTS (SELECT 1 FROM trustwork.deployment_location_attestation n WHERE n.supersedes_id = a.id)
  ORDER BY a.attested_at DESC, a.id LIMIT 1
$$;

-- Shape checks shared by the attest and refusal commands.
CREATE FUNCTION trustwork.attestation_check_shape(p_entity_country text, p_entity_region text, p_hosting_country text, p_hosting_region text, p_gate_mode text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_entity_country IS NULL OR p_entity_country !~ '^[A-Z]{2}$' OR p_hosting_country IS NULL OR p_hosting_country !~ '^[A-Z]{2}$'
     OR (p_entity_region IS NOT NULL AND (p_entity_region !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' OR left(p_entity_region, 2) <> p_entity_country))
     OR (p_hosting_region IS NOT NULL AND (p_hosting_region !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' OR left(p_hosting_region, 2) <> p_hosting_country)) THEN
    RAISE EXCEPTION 'countries are ISO 3166-1 alpha-2 and regions ISO 3166-2 codes of the same country' USING ERRCODE = 'invalid_parameter_value', HINT = 'attestation.invalid_place';
  END IF;
  IF p_gate_mode IS NULL OR p_gate_mode NOT IN ('ranges_file', 'edge_header', 'upstream_gate') THEN
    RAISE EXCEPTION 'the gate mode is ranges_file, edge_header or upstream_gate' USING ERRCODE = 'invalid_parameter_value', HINT = 'attestation.invalid_gate_mode';
  END IF;
END $$;

-- 3. Commands ------------------------------------------------------------------------------------------------------------
-- Attest (first time) or renew (superseding the current attestation). Order of checks: the node exists; the caller is
-- authorized with an elevation (admin_authorize); the statement is well formed and confirmed in the current version;
-- the restricted list is synced; no place is refused; then, serialized per node, the named predecessor is still the
-- current attestation. The row and its audit row commit together.
CREATE FUNCTION trustwork.attestation_attest(p_ctx jsonb, p_entity_country text, p_entity_region text, p_hosting_country text, p_hosting_region text,
  p_gate_mode text, p_supersedes uuid, p_statement_version text) RETURNS trustwork.deployment_location_attestation
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.jurisdiction_node();
  v_actor trustwork.admin_actor;
  v_refusals text[];
  v_head uuid;
  v_before trustwork.deployment_location_attestation%ROWTYPE;
  v_row trustwork.deployment_location_attestation%ROWTYPE;
  v_now timestamptz := date_trunc('milliseconds', now());
BEGIN
  IF v_node IS NULL THEN
    RAISE EXCEPTION 'the node is not set up yet' USING ERRCODE = 'no_data_found', HINT = 'attestation.no_node';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.attestation_permissions(), v_node, NULL);
  IF p_statement_version IS DISTINCT FROM 'deployment-location-1' THEN
    RAISE EXCEPTION 'the attested statement is deployment-location-1' USING ERRCODE = 'invalid_parameter_value', HINT = 'attestation.statement_version';
  END IF;
  PERFORM trustwork.attestation_check_shape(p_entity_country, p_entity_region, p_hosting_country, p_hosting_region, p_gate_mode);
  IF NOT EXISTS (SELECT 1 FROM trustwork.restricted_place) THEN
    RAISE EXCEPTION 'the restricted places are not synced; nothing can be attested' USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'attestation.restricted_list_unsynced';
  END IF;
  v_refusals := trustwork.attestation_refusals(p_entity_country, p_entity_region, p_hosting_country, p_hosting_region);
  IF cardinality(v_refusals) > 0 THEN
    RAISE EXCEPTION 'refused: %', array_to_string(v_refusals, ', ') USING ERRCODE = 'check_violation',
      HINT = CASE WHEN EXISTS (SELECT 1 FROM unnest(v_refusals) r WHERE r LIKE '%:restricted') THEN 'attestation.restricted_place' ELSE 'attestation.region_required' END,
      DETAIL = array_to_string(v_refusals, ',');
  END IF;
  -- Concurrent attestations of the node serialize here; the loser sees a head other than the one it named.
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.deployment_location_attestation:' || v_node::text, 0));
  v_head := trustwork.attestation_head(v_node);
  IF v_head IS DISTINCT FROM p_supersedes THEN
    RAISE EXCEPTION 'the current attestation is not the one named' USING ERRCODE = 'check_violation', HINT = 'attestation.stale', DETAIL = coalesce(v_head::text, 'none');
  END IF;
  IF v_head IS NOT NULL THEN
    SELECT * INTO v_before FROM trustwork.deployment_location_attestation WHERE id = v_head;
  END IF;
  v_row.id := trustwork.new_uuid();
  v_row.node_id := v_node;
  v_row.operator_entity_country := p_entity_country;
  v_row.operator_entity_region := p_entity_region;
  v_row.hosting_country := p_hosting_country;
  v_row.hosting_region := p_hosting_region;
  v_row.gate_mode := p_gate_mode;
  v_row.statement_version := p_statement_version;
  v_row.attested_by := v_actor.person_id;
  v_row.attester_role := v_actor.role;
  v_row.permission := v_actor.permission;
  v_row.session_elevation_id := v_actor.elevation_id;
  v_row.breakglass := v_actor.breakglass;
  v_row.attested_at := v_now;
  v_row.expires_at := v_now + interval '365 days';
  v_row.supersedes_id := v_head;
  v_row.statement_digest := trustwork.admin_digest(trustwork.attestation_statement(v_row));
  INSERT INTO trustwork.deployment_location_attestation SELECT v_row.* RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, CASE WHEN v_head IS NULL THEN 'jurisdiction.location_attested' ELSE 'jurisdiction.location_renewed' END,
    'deployment_location_attestation', v_row.id, CASE WHEN v_head IS NULL THEN NULL ELSE to_jsonb(v_before) END, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- The denied audit row of a refused attempt (the attest transaction rolled back, so the API records it in its own
-- transaction). Only an authorized, elevated caller is recorded, and only for a statement that is in fact refused; the
-- reason text names the refused fields and places (never a person or an address) before the staff reason.
CREATE FUNCTION trustwork.attestation_record_refusal(p_ctx jsonb, p_entity_country text, p_entity_region text, p_hosting_country text, p_hosting_region text, p_gate_mode text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.jurisdiction_node();
  v_actor trustwork.admin_actor;
  v_refusals text[];
  v_sequence bigint;
BEGIN
  IF v_node IS NULL THEN
    RAISE EXCEPTION 'the node is not set up yet' USING ERRCODE = 'no_data_found', HINT = 'attestation.no_node';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.attestation_permissions(), v_node, NULL);
  PERFORM trustwork.attestation_check_shape(p_entity_country, p_entity_region, p_hosting_country, p_hosting_region, p_gate_mode);
  v_refusals := trustwork.attestation_refusals(p_entity_country, p_entity_region, p_hosting_country, p_hosting_region);
  IF cardinality(v_refusals) = 0 THEN
    RAISE EXCEPTION 'nothing in this statement is refused' USING ERRCODE = 'invalid_parameter_value', HINT = 'attestation.not_refused';
  END IF;
  INSERT INTO trustwork.admin_audit_event (actor_person_id, actor_role, scope_kind, node_id, hub_id, permission, session_elevation_id, breakglass, action, object_type, object_id,
    after_digest, reason_code, reason_text, outcome, request_id, client_fingerprint_hash)
  VALUES (v_actor.person_id, v_actor.role, 'node', v_node, NULL, v_actor.permission, v_actor.elevation_id, v_actor.breakglass, 'jurisdiction.location_refused', 'admin_node', v_node,
    trustwork.admin_digest(jsonb_build_object('operatorEntityCountry', p_entity_country, 'operatorEntityRegion', p_entity_region, 'hostingCountry', p_hosting_country,
      'hostingRegion', p_hosting_region, 'gateMode', p_gate_mode)),
    CASE WHEN EXISTS (SELECT 1 FROM unnest(v_refusals) r WHERE r LIKE '%:restricted') THEN 'denied_restricted_place' ELSE 'denied_region_required' END,
    left('refused ' || array_to_string(v_refusals, ', ') || '; ' || (p_ctx ->> 'reasonText'), 500), 'denied', p_ctx ->> 'requestId', NULLIF(p_ctx ->> 'clientFingerprintHash', ''))
  RETURNING sequence INTO v_sequence;
  RETURN v_sequence;
END $$;

-- The current attestation without the attesting person, for every reader of the deployment location (the launch gate
-- of every hub on the node, the node manifest of FED-001, the services of SANC-008). Empty before the first one.
CREATE FUNCTION trustwork.attestation_current() RETURNS TABLE (id uuid, node_id uuid, operator_entity_country text, operator_entity_region text, hosting_country text,
  hosting_region text, gate_mode text, statement_digest text, attested_at timestamptz, expires_at timestamptz, supersedes_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a.id, a.node_id, a.operator_entity_country, a.operator_entity_region, a.hosting_country, a.hosting_region, a.gate_mode, a.statement_digest, a.attested_at, a.expires_at, a.supersedes_id
  FROM trustwork.deployment_location_attestation a
  WHERE a.id = trustwork.attestation_head(trustwork.jurisdiction_node())
$$;

-- For SQL callers (federation admission, SANC-008): a current attestation that has not expired at p_at and names no
-- place that is refused now (the restricted list may have grown since it was made). The configured gate mode is the
-- API's to compare (deploymentAttestationStatus).
CREATE FUNCTION trustwork.attestation_in_force(p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.deployment_location_attestation a
    WHERE a.id = trustwork.attestation_head(trustwork.jurisdiction_node()) AND p_at IS NOT NULL AND a.attested_at <= p_at AND a.expires_at > p_at
      AND cardinality(trustwork.attestation_refusals(a.operator_entity_country, a.operator_entity_region, a.hosting_country, a.hosting_region)) = 0)
$$;

-- Who reads the full rows (with the attesting person): node or platform staff holding an attesting permission or
-- admin.audit.read at the node, and the node's compliance officers and auditors (jurisdiction_staff_reader, SANC-001).
CREATE FUNCTION trustwork.attestation_reader() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND trustwork.jurisdiction_node() IS NOT NULL
    AND (trustwork.admin_has_any_permission(trustwork.attestation_permissions() || ARRAY['admin.audit.read'], trustwork.jurisdiction_node(), NULL)
      OR trustwork.jurisdiction_staff_reader())
$$;

-- 4. Row-level security and grants ----------------------------------------------------------------------------------------
ALTER TABLE trustwork.deployment_location_attestation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.deployment_location_attestation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.deployment_location_attestation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY deployment_location_attestation_staff_read ON trustwork.deployment_location_attestation FOR SELECT TO trustwork_app USING (trustwork.attestation_reader());

GRANT SELECT ON trustwork.deployment_location_attestation TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.attestation_attest(jsonb, text, text, text, text, text, uuid, text), trustwork.attestation_record_refusal(jsonb, text, text, text, text, text),
  trustwork.attestation_current(), trustwork.attestation_in_force(timestamptz), trustwork.attestation_reader() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- REG-001 public-register and licence-board facts as sourced records (docs/engine/discovery-and-outreach.md sections 3
-- and 6, ADR 026). Contract: packages/contracts/src/sourced-facts.ts (vocabularies and value shapes tested against this
-- file).
--
-- A hub binds a register adapter from the engine catalogue to one of its active official-register sources. The adapter
-- runs as a deterministic fake until live mode consumes a second person's approval (`providers.enable_non_fake`) of
-- exactly that adapter version with a credential reference. Each observation becomes an append-only fact with the
-- source's licence flags as they were at that moment; a newer observation of the same record supersedes the older one.
--
-- Rules the schema holds:
--   * a fact is linked to a company only through an identifier the company holds (kind and normalised value), or for
--     registers without identifiers through a reviewed link a person makes with a reason; never by name;
--   * a fact's value has a strict shape per kind with no room for a person's name, address, phone or e-mail;
--   * the public projection shows a fact only when both the snapshot and the source's current licence allow display,
--     the source is not taken down or paused for its licence, and the holder is an organisation; past valid_until the
--     fact is stale;
--   * no function here reads or writes reputation, ranking or matching tables (a test reads every body);
--   * the expiry watch records one reminder per step (60, 30 and 7 days before valid_until) for claimed companies.
--
-- Authority model (DATA-002): every mutation is a SECURITY DEFINER command that resolves the caller's permission at the
-- hub, requires a live elevation and writes an admin_audit_event in the same transaction; the runtime role reads under
-- row-level security (staff of the hub with a sources or claims permission) and writes nothing directly. The worker
-- refreshes fake adapters and runs the expiry watch through its own functions.

-- 0. Vocabularies ------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.registers_fact_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['licence_status', 'entity_status', 'sam_registration', 'sam_exclusion', 'safety_inspection', 'lei_record', 'official_rating']::text[]
$$;
-- REGISTER_ADAPTERS: id, the kinds it reports, its identifier kind (NULL: none), method and maximum refresh cadence.
CREATE FUNCTION trustwork.registers_catalogue() RETURNS TABLE (adapter text, kinds text[], identifier_kind text, method text, refresh_days integer)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('us_ca_cslb_licence_file', ARRAY['licence_status'], 'US-CA-CSLB', 'structured_feed', 7),
    ('us_sam_entity', ARRAY['sam_registration', 'sam_exclusion'], 'US-UEI', 'register_api', 30),
    ('us_osha_inspections', ARRAY['safety_inspection'], NULL, 'structured_feed', 30),
    ('gleif_lei', ARRAY['lei_record'], 'XX-LEI', 'register_api', 30)
$$;
CREATE FUNCTION trustwork.registers_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.sources.read', 'admin.sources.manage', 'admin.sources.dedupe.decide', 'admin.claims.read', 'admin.claims.decide']::text[]
$$;
CREATE FUNCTION trustwork.registers_reminder_days() RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[60, 30, 7] $$;

-- normaliseIdentifier in the contract.
CREATE FUNCTION trustwork.registers_norm(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT upper(regexp_replace(p_value, '[\s./-]', '', 'g')) $$;

CREATE FUNCTION trustwork.registers_text_ok(p jsonb, p_key text, p_pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT jsonb_typeof(p -> p_key) = 'string' AND (p ->> p_key) ~ p_pattern $$;
CREATE FUNCTION trustwork.registers_enum_ok(p jsonb, p_key text, p_values text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT jsonb_typeof(p -> p_key) = 'string' AND (p ->> p_key) = ANY (p_values) $$;
CREATE FUNCTION trustwork.registers_date_ok(p jsonb, p_key text, p_nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p -> p_key) = 'null' THEN p_nullable
              ELSE jsonb_typeof(p -> p_key) = 'string' AND (p ->> p_key) ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' END
$$;
CREATE FUNCTION trustwork.registers_keys_are(p jsonb, p_keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND (SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) FROM jsonb_object_keys(p) k) = (SELECT array_agg(k ORDER BY k) FROM unnest(p_keys) k)
$$;

-- SourcedFactValueSchemas: strict shapes; a code is 1-32 characters of letters, digits, space, dot, underscore, dash; a
-- licence classification is 1-16 characters without spaces.
CREATE FUNCTION trustwork.registers_value_ok(p_kind text, p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(CASE p_kind
    WHEN 'licence_status' THEN trustwork.registers_keys_are(p, ARRAY['status', 'classifications', 'issuedOn'])
      AND trustwork.registers_enum_ok(p, 'status', ARRAY['active', 'inactive', 'suspended', 'revoked', 'expired'])
      AND jsonb_typeof(p -> 'classifications') = 'array' AND jsonb_array_length(p -> 'classifications') <= 30
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'classifications') c WHERE jsonb_typeof(c) <> 'string' OR (c #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$')
      AND trustwork.registers_date_ok(p, 'issuedOn', true)
    WHEN 'entity_status' THEN trustwork.registers_keys_are(p, ARRAY['status', 'entityType'])
      AND trustwork.registers_enum_ok(p, 'status', ARRAY['active', 'inactive', 'dissolved', 'suspended'])
      AND trustwork.registers_enum_ok(p, 'entityType', ARRAY['corporation', 'llc', 'partnership', 'sole_proprietor', 'nonprofit', 'other'])
    WHEN 'sam_registration' THEN trustwork.registers_keys_are(p, ARRAY['status', 'purpose'])
      AND trustwork.registers_enum_ok(p, 'status', ARRAY['active', 'inactive', 'expired'])
      AND trustwork.registers_enum_ok(p, 'purpose', ARRAY['all_awards', 'financial_assistance_only'])
    WHEN 'sam_exclusion' THEN trustwork.registers_keys_are(p, ARRAY['status', 'exclusionType'])
      AND trustwork.registers_enum_ok(p, 'status', ARRAY['excluded', 'not_excluded'])
      AND (jsonb_typeof(p -> 'exclusionType') = 'null'
        OR trustwork.registers_enum_ok(p, 'exclusionType', ARRAY['ineligible_proceedings_pending', 'ineligible_proceedings_completed', 'prohibition_restriction', 'voluntary_exclusion']))
    WHEN 'safety_inspection' THEN trustwork.registers_keys_are(p, ARRAY['inspectionRef', 'openedOn', 'inspectionType', 'status', 'citations'])
      AND trustwork.registers_text_ok(p, 'inspectionRef', '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$') AND trustwork.registers_date_ok(p, 'openedOn', false)
      AND trustwork.registers_enum_ok(p, 'inspectionType', ARRAY['planned', 'complaint', 'accident', 'referral', 'follow_up', 'other'])
      AND trustwork.registers_enum_ok(p, 'status', ARRAY['open', 'closed'])
      AND jsonb_typeof(p -> 'citations') = 'number' AND (p ->> 'citations') ~ '^\d{1,3}$'
    WHEN 'lei_record' THEN trustwork.registers_keys_are(p, ARRAY['registrationStatus', 'entityStatus'])
      AND trustwork.registers_enum_ok(p, 'registrationStatus', ARRAY['issued', 'lapsed', 'retired', 'annulled', 'pending_transfer', 'pending_archival', 'merged', 'duplicate'])
      AND trustwork.registers_enum_ok(p, 'entityStatus', ARRAY['active', 'inactive'])
    WHEN 'official_rating' THEN trustwork.registers_keys_are(p, ARRAY['scheme', 'grade'])
      AND trustwork.registers_text_ok(p, 'scheme', '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$') AND trustwork.registers_text_ok(p, 'grade', '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$')
  END, false)
$$;

-- 1. Adapters per hub --------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.register_adapter (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  adapter text NOT NULL CHECK (adapter ~ '^[a-z][a-z0-9_]{1,40}$'),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  mode text NOT NULL DEFAULT 'fake' CHECK (mode IN ('fake', 'live')),
  credential_ref_id uuid NULL REFERENCES trustwork.provider_credential_ref (id),
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  refresh_days integer NOT NULL CHECK (refresh_days BETWEEN 1 AND 30),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  last_run_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT register_adapter_live CHECK (mode <> 'live' OR (credential_ref_id IS NOT NULL AND approval_id IS NOT NULL))
);
CREATE UNIQUE INDEX register_adapter_active_uq ON trustwork.register_adapter (hub_id, adapter) WHERE status = 'active';

CREATE FUNCTION trustwork.registers_adapter_digest(p_adapter uuid, p_revision integer, p_credential uuid) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to('registers.adapter.live:' || p_adapter::text || ':' || p_revision::text || ':' || p_credential::text, 'UTF8')), 'hex')
$$;

-- 2. Facts (append-only; a newer observation of the same record supersedes the older one) ------------------------------
CREATE TABLE trustwork.register_fact (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  adapter_id uuid NOT NULL REFERENCES trustwork.register_adapter (id),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  mode text NOT NULL CHECK (mode IN ('fake', 'live')),
  method text NOT NULL CHECK (method IN ('register_api', 'structured_feed', 'manual')),
  kind text NOT NULL CHECK (kind = ANY (trustwork.registers_fact_kinds())),
  identifier_kind text NULL CHECK (identifier_kind ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?-[A-Z][A-Z0-9]{1,11}$'),
  identifier_value text NULL CHECK (identifier_value ~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{0,63}$'),
  identifier_norm text GENERATED ALWAYS AS (trustwork.registers_norm(identifier_value)) STORED,
  holder_kind text NOT NULL CHECK (holder_kind IN ('organisation', 'natural_person', 'unknown')),
  value jsonb NOT NULL,
  record_ref text NOT NULL CHECK (record_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$'),
  link text NOT NULL CHECK (link ~ '^https://[^\s]+$' AND length(link) <= 2000),
  licence_snapshot jsonb NOT NULL CHECK (trustwork.sources_uses_ok(licence_snapshot)),
  observed_at timestamptz NOT NULL,
  valid_until date NULL,
  recorded_by uuid NULL REFERENCES trustwork.person (id),
  superseded_at timestamptz NULL,
  superseded_by uuid NULL REFERENCES trustwork.register_fact (id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT register_fact_value CHECK (trustwork.registers_value_ok(kind, value)),
  CONSTRAINT register_fact_identifier CHECK ((identifier_kind IS NULL) = (identifier_value IS NULL)),
  CONSTRAINT register_fact_superseded CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)),
  -- A person records only fake observations (a staff run of a fake adapter); live results come from the adapter.
  CONSTRAINT register_fact_author CHECK (recorded_by IS NULL OR mode = 'fake')
);
CREATE UNIQUE INDEX register_fact_current_uq ON trustwork.register_fact (adapter_id, kind, coalesce(identifier_norm, ''), record_ref) WHERE superseded_at IS NULL;
CREATE INDEX register_fact_identifier_idx ON trustwork.register_fact (hub_id, identifier_kind, identifier_norm) WHERE superseded_at IS NULL;
CREATE INDEX register_fact_expiry_idx ON trustwork.register_fact (hub_id, valid_until) WHERE superseded_at IS NULL AND valid_until IS NOT NULL;

-- Only superseding is allowed, once: set superseded_at and superseded_by on a current fact. Nothing is deleted. (The
-- generated identifier_norm is not computed yet in a BEFORE trigger; it follows identifier_value, which is compared.)
CREATE FUNCTION trustwork.registers_fact_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at' - 'superseded_by' - 'identifier_norm') <> (to_jsonb(OLD) - 'superseded_at' - 'superseded_by' - 'identifier_norm') THEN
    RAISE EXCEPTION 'register facts are append-only' USING ERRCODE = 'integrity_constraint_violation', HINT = 'registers.append_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER register_fact_append_only BEFORE UPDATE OR DELETE ON trustwork.register_fact FOR EACH ROW EXECUTE FUNCTION trustwork.registers_fact_guard();

-- 3. Reviewed links (registers without identifiers) --------------------------------------------------------------------
-- A person decides that a register record (adapter and record reference) is about a company, with a reason. Machines
-- never propose such a link from a name; ending a link keeps the row.
CREATE TABLE trustwork.register_fact_link (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  adapter_id uuid NOT NULL REFERENCES trustwork.register_adapter (id),
  record_ref text NOT NULL CHECK (record_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$'),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  linked_by uuid NOT NULL REFERENCES trustwork.person (id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  ended_by uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT register_fact_link_ended CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX register_fact_link_active_uq ON trustwork.register_fact_link (adapter_id, record_ref) WHERE ended_at IS NULL;
CREATE INDEX register_fact_link_company_idx ON trustwork.register_fact_link (company_id) WHERE ended_at IS NULL;

-- 4. Expiry reminders (one per company, record, expiry date and step) -------------------------------------------------
CREATE TABLE trustwork.register_reminder (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  fact_id uuid NOT NULL REFERENCES trustwork.register_fact (id),
  adapter_id uuid NOT NULL REFERENCES trustwork.register_adapter (id),
  kind text NOT NULL,
  record_ref text NOT NULL,
  valid_until date NOT NULL,
  days_before integer NOT NULL CHECK (days_before = ANY (trustwork.registers_reminder_days())),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, adapter_id, kind, record_ref, valid_until, days_before)
);
CREATE INDEX register_reminder_company_idx ON trustwork.register_reminder (company_id, created_at DESC);
CREATE TRIGGER register_reminder_append_only BEFORE UPDATE OR DELETE ON trustwork.register_reminder FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Helpers -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.registers_require_hub(p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
END $$;
CREATE FUNCTION trustwork.registers_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.registers_require_hub(p_hub);
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;
CREATE FUNCTION trustwork.registers_check_revision(p_actual integer, p_expected integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_expected IS NULL OR p_actual <> p_expected THEN
    RAISE EXCEPTION 'the record changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'registers.revision_conflict';
  END IF;
END $$;

-- Whether a company holds the identifier (kind and normalised value) in its legal identifiers.
CREATE FUNCTION trustwork.registers_company_holds(p_company uuid, p_kind text, p_norm text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_kind IS NOT NULL AND p_norm IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.company c, jsonb_array_elements(c.legal_identifiers) i
     WHERE c.id = p_company AND jsonb_typeof(i) = 'object' AND i ->> 'kind' = p_kind AND trustwork.registers_norm(i ->> 'value') = p_norm)
$$;

-- Current facts of a hub about a company: by identifier, or by an active reviewed link.
CREATE FUNCTION trustwork.registers_company_fact_rows(p_hub uuid, p_company uuid) RETURNS SETOF trustwork.register_fact
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT f.* FROM trustwork.register_fact f
   WHERE f.hub_id = p_hub AND f.superseded_at IS NULL
     AND (trustwork.registers_company_holds(p_company, f.identifier_kind, f.identifier_norm)
       OR EXISTS (SELECT 1 FROM trustwork.register_fact_link l WHERE l.adapter_id = f.adapter_id AND l.record_ref = f.record_ref AND l.company_id = p_company AND l.ended_at IS NULL))
$$;

-- The observation shape (SourcedObservationSchema) checked before insert; returns the hint of the first problem.
CREATE FUNCTION trustwork.registers_observation_problem(p_catalogue_kinds text[], p_identifier_kind text, p_obs jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_obs) <> 'object' OR NOT coalesce((p_obs ->> 'kind') = ANY (p_catalogue_kinds), false) THEN 'registers.kind_not_reported'
    WHEN NOT (coalesce(p_obs #>> '{subject,identifierKind}', '') = coalesce(p_identifier_kind, '')) THEN 'registers.identifier_kind_mismatch'
    WHEN (p_obs #>> '{subject,identifierKind}') IS NOT NULL AND (p_obs #>> '{subject,identifierValue}') IS NULL THEN 'registers.identifier_kind_mismatch'
    WHEN NOT coalesce(p_obs #>> '{subject,holderKind}', '') IN ('organisation', 'natural_person', 'unknown') THEN 'registers.invalid_observation'
    WHEN NOT trustwork.registers_value_ok(p_obs ->> 'kind', p_obs -> 'value') THEN 'registers.invalid_value'
    WHEN NOT coalesce(p_obs ->> 'validUntil', '2000-01-01') ~ '^\d{4}-\d{2}-\d{2}$' OR (p_obs ->> 'observedAt') IS NULL THEN 'registers.invalid_observation'
  END
$$;

-- Records one observation for an active adapter; supersedes the current fact of the same record when it differs and
-- keeps it when nothing changed (returns it). p_recorded_by is the staff member running a fake adapter, or NULL.
CREATE FUNCTION trustwork.registers_record(p_adapter trustwork.register_adapter, p_obs jsonb, p_recorded_by uuid) RETURNS trustwork.register_fact
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_cat record;
  v_source trustwork.source%ROWTYPE;
  v_problem text;
  v_current trustwork.register_fact%ROWTYPE;
  v_row trustwork.register_fact%ROWTYPE;
  v_id uuid := trustwork.new_uuid();
BEGIN
  SELECT * INTO v_cat FROM trustwork.registers_catalogue() c WHERE c.adapter = p_adapter.adapter;
  v_problem := trustwork.registers_observation_problem(v_cat.kinds, v_cat.identifier_kind, p_obs);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'the observation does not fit the adapter' USING ERRCODE = 'check_violation', HINT = v_problem;
  END IF;
  SELECT * INTO v_source FROM trustwork.source WHERE id = p_adapter.source_id;
  IF v_source.status <> 'active' THEN
    RAISE EXCEPTION 'the source is %', v_source.status USING ERRCODE = 'check_violation', HINT = 'registers.source_not_active';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.register_fact:' || p_adapter.id::text || ':' || (p_obs ->> 'kind') || ':' || (p_obs ->> 'recordRef'), 0));
  SELECT * INTO v_current FROM trustwork.register_fact
   WHERE adapter_id = p_adapter.id AND kind = p_obs ->> 'kind' AND coalesce(identifier_norm, '') = coalesce(trustwork.registers_norm(p_obs #>> '{subject,identifierValue}'), '')
     AND record_ref = p_obs ->> 'recordRef' AND superseded_at IS NULL FOR UPDATE;
  IF FOUND AND v_current.value = p_obs -> 'value' AND v_current.holder_kind = p_obs #>> '{subject,holderKind}' AND v_current.link = p_obs ->> 'link'
     AND v_current.valid_until IS NOT DISTINCT FROM (p_obs ->> 'validUntil')::date AND v_current.licence_snapshot = v_source.allowed_uses
     AND v_current.mode = p_adapter.mode THEN
    RETURN v_current;
  END IF;
  -- The current row steps aside first (the unique index holds one current fact per record); the reference to its
  -- successor is checked at commit.
  IF v_current.id IS NOT NULL THEN
    UPDATE trustwork.register_fact SET superseded_at = now(), superseded_by = v_id WHERE id = v_current.id;
  END IF;
  INSERT INTO trustwork.register_fact (id, hub_id, adapter_id, source_id, mode, method, kind, identifier_kind, identifier_value, holder_kind, value, record_ref, link,
    licence_snapshot, observed_at, valid_until, recorded_by)
  VALUES (v_id, p_adapter.hub_id, p_adapter.id, p_adapter.source_id, p_adapter.mode, v_cat.method, p_obs ->> 'kind', p_obs #>> '{subject,identifierKind}',
    p_obs #>> '{subject,identifierValue}', p_obs #>> '{subject,holderKind}', p_obs -> 'value', p_obs ->> 'recordRef', p_obs ->> 'link',
    v_source.allowed_uses, (p_obs ->> 'observedAt')::timestamptz, (p_obs ->> 'validUntil')::date, p_recorded_by)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- 6. Commands ----------------------------------------------------------------------------------------------------------
-- Every command takes DATA-002's command context p_ctx ({elevationId, requestId, reasonCode, reasonText}).

-- Binds a catalogue adapter to an active official-register source of the hub, in fake mode.
CREATE FUNCTION trustwork.registers_bind_adapter(p_ctx jsonb, p_hub uuid, p_adapter text, p_source uuid, p_refresh_days integer) RETURNS trustwork.register_adapter
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.registers_staff(p_ctx, ARRAY['admin.sources.manage'], p_hub);
  v_cat record;
  v_row trustwork.register_adapter%ROWTYPE;
BEGIN
  SELECT * INTO v_cat FROM trustwork.registers_catalogue() c WHERE c.adapter = p_adapter;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such adapter in the engine catalogue' USING ERRCODE = 'check_violation', HINT = 'registers.unknown_adapter';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.source s WHERE s.id = p_source AND s.hub_id = p_hub AND s.status = 'active' AND s.reader_kind = 'official_register') THEN
    RAISE EXCEPTION 'an adapter reads an active official-register source of the hub' USING ERRCODE = 'check_violation', HINT = 'registers.source_not_register';
  END IF;
  IF p_refresh_days IS NULL OR p_refresh_days < 1 OR p_refresh_days > v_cat.refresh_days THEN
    RAISE EXCEPTION 'refresh at most every % days', v_cat.refresh_days USING ERRCODE = 'check_violation', HINT = 'registers.refresh_out_of_range';
  END IF;
  BEGIN
    INSERT INTO trustwork.register_adapter (hub_id, adapter, source_id, refresh_days, created_by)
    VALUES (p_hub, p_adapter, p_source, p_refresh_days, v_actor.person_id) RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'the adapter is already bound' USING ERRCODE = 'unique_violation', HINT = 'registers.already_bound';
  END;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'registers.adapter_bound', 'register_adapter', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Live mode: a credential reference of the hub and a consumed second-person approval of exactly this adapter version.
CREATE FUNCTION trustwork.registers_go_live(p_ctx jsonb, p_adapter uuid, p_expected_revision integer, p_credential uuid, p_approval uuid) RETURNS trustwork.register_adapter
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.register_adapter%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.register_adapter%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.register_adapter WHERE id = p_adapter FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such adapter' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.registers_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  PERFORM trustwork.registers_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status <> 'active' OR v_before.mode = 'live' THEN
    RAISE EXCEPTION 'the adapter is % in % mode', v_before.status, v_before.mode USING ERRCODE = 'check_violation', HINT = 'registers.invalid_transition';
  END IF;
  IF p_credential IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.provider_credential_ref c WHERE c.id = p_credential AND c.hub_id = v_before.hub_id) THEN
    RAISE EXCEPTION 'live mode needs a credential reference of this hub' USING ERRCODE = 'check_violation', HINT = 'registers.credential_required';
  END IF;
  IF p_approval IS NULL THEN
    RAISE EXCEPTION 'live mode needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  PERFORM trustwork.admin_consume_approval(p_approval, 'providers.enable_non_fake', 'hub', NULL, v_before.hub_id,
    trustwork.registers_adapter_digest(v_before.id, v_before.revision, p_credential), v_before.id);
  UPDATE trustwork.register_adapter SET mode = 'live', credential_ref_id = p_credential, approval_id = p_approval, revision = revision + 1, updated_at = now()
   WHERE id = p_adapter RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'registers.adapter_live', 'register_adapter', v_row.id, to_jsonb(v_before), to_jsonb(v_row), NULL, p_approval);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.registers_retire_adapter(p_ctx jsonb, p_adapter uuid, p_expected_revision integer) RETURNS trustwork.register_adapter
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.register_adapter%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.register_adapter%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.register_adapter WHERE id = p_adapter FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such adapter' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.registers_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  PERFORM trustwork.registers_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status <> 'active' THEN
    RAISE EXCEPTION 'the adapter is retired' USING ERRCODE = 'check_violation', HINT = 'registers.invalid_transition';
  END IF;
  UPDATE trustwork.register_adapter SET status = 'retired', revision = revision + 1, updated_at = now() WHERE id = p_adapter RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'registers.adapter_retired', 'register_adapter', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A staff run of a fake adapter: the API computes the deterministic observations and records them here. Live adapters
-- deliver through the worker only.
CREATE FUNCTION trustwork.registers_record_fake_run(p_ctx jsonb, p_adapter uuid, p_observations jsonb) RETURNS SETOF trustwork.register_fact
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_adapter trustwork.register_adapter%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_obs jsonb;
  v_row trustwork.register_fact%ROWTYPE;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_adapter FROM trustwork.register_adapter WHERE id = p_adapter FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such adapter' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.registers_staff(p_ctx, ARRAY['admin.sources.manage'], v_adapter.hub_id);
  IF v_adapter.status <> 'active' OR v_adapter.mode <> 'fake' THEN
    RAISE EXCEPTION 'a person runs only an active fake adapter' USING ERRCODE = 'check_violation', HINT = 'registers.live_results_from_adapter';
  END IF;
  IF jsonb_typeof(p_observations) <> 'array' OR jsonb_array_length(p_observations) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'one to 500 observations' USING ERRCODE = 'check_violation', HINT = 'registers.invalid_observation';
  END IF;
  FOR v_obs IN SELECT e FROM jsonb_array_elements(p_observations) e LOOP
    v_row := trustwork.registers_record(v_adapter, v_obs, v_actor.person_id);
    v_ids := v_ids || v_row.id;
  END LOOP;
  UPDATE trustwork.register_adapter SET last_run_at = now() WHERE id = p_adapter;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_adapter.hub_id, 'registers.fake_run_recorded', 'register_adapter', v_adapter.id, NULL,
    jsonb_build_object('observations', jsonb_array_length(p_observations), 'facts', cardinality(v_ids)));
  RETURN QUERY SELECT * FROM trustwork.register_fact WHERE id = ANY (v_ids) ORDER BY kind, record_ref;
END $$;

-- A reviewed link for a register without identifiers: a person decides that a record is about a company.
CREATE FUNCTION trustwork.registers_link_record(p_ctx jsonb, p_adapter uuid, p_record_ref text, p_company uuid, p_reason text) RETURNS trustwork.register_fact_link
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_adapter trustwork.register_adapter%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.register_fact_link%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_adapter FROM trustwork.register_adapter WHERE id = p_adapter;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such adapter' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.registers_staff(p_ctx, ARRAY['admin.sources.dedupe.decide'], v_adapter.hub_id);
  IF (SELECT identifier_kind FROM trustwork.registers_catalogue() WHERE adapter = v_adapter.adapter) IS NOT NULL THEN
    RAISE EXCEPTION 'records of this register link through their identifier' USING ERRCODE = 'check_violation', HINT = 'registers.link_by_identifier';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.register_fact WHERE adapter_id = p_adapter AND record_ref = p_record_ref AND superseded_at IS NULL) THEN
    RAISE EXCEPTION 'no such record' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.company WHERE id = p_company) THEN
    RAISE EXCEPTION 'no such company' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  BEGIN
    INSERT INTO trustwork.register_fact_link (hub_id, adapter_id, record_ref, company_id, reason, linked_by)
    VALUES (v_adapter.hub_id, p_adapter, p_record_ref, p_company, p_reason, v_actor.person_id) RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'the record is already linked' USING ERRCODE = 'unique_violation', HINT = 'registers.already_linked';
  END;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_adapter.hub_id, 'registers.record_linked', 'register_fact_link', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.registers_end_link(p_ctx jsonb, p_link uuid) RETURNS trustwork.register_fact_link
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.register_fact_link%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.register_fact_link%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.register_fact_link WHERE id = p_link FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such link' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.registers_staff(p_ctx, ARRAY['admin.sources.dedupe.decide'], v_before.hub_id);
  IF v_before.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'the link has ended' USING ERRCODE = 'check_violation', HINT = 'registers.invalid_transition';
  END IF;
  UPDATE trustwork.register_fact_link SET ended_at = now(), ended_by = v_actor.person_id WHERE id = p_link RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'registers.link_ended', 'register_fact_link', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 7. Reads -------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.registers_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL AND trustwork.admin_has_any_permission(trustwork.registers_reader_permissions(), NULL, p_hub)
$$;

-- Staff: every current fact of the hub about a company, with how it is linked (not filtered by display rules).
CREATE FUNCTION trustwork.registers_company_facts(p_hub uuid, p_company uuid) RETURNS SETOF trustwork.register_fact
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.registers_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT * FROM trustwork.registers_company_fact_rows(p_hub, p_company) ORDER BY kind, record_ref;
END $$;

-- Public projection (PublicSourcedFactSchema): anyone may read it, so it holds only what may be shown. A fact appears
-- when the holder is an organisation, the snapshot and the source's current licence both allow display, and the source
-- is neither taken down nor paused for its licence. No holder kind, identifier value, record internals or authors.
CREATE FUNCTION trustwork.registers_public_facts(p_hub uuid, p_company uuid)
RETURNS TABLE (kind text, identifier_kind text, value jsonb, source_id uuid, link text, observed_at timestamptz, valid_until date, stale boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT f.kind, f.identifier_kind, f.value, f.source_id, f.link, f.observed_at, f.valid_until, (f.valid_until IS NOT NULL AND f.valid_until < current_date)
    FROM trustwork.registers_company_fact_rows(p_hub, p_company) f
    JOIN trustwork.source s ON s.id = f.source_id
   WHERE f.holder_kind = 'organisation'
     AND trustwork.sources_use(trustwork.sources_uses_and(f.licence_snapshot, s.allowed_uses), 'displayHeadlineAndLink')
     AND s.status <> 'taken_down' AND NOT (s.status = 'paused' AND s.pause_reason IN ('licence_ended', 'takedown'))
   ORDER BY f.kind, f.observed_at DESC, f.id
$$;

-- The subject's own reminders: administrators of the company read them.
CREATE FUNCTION trustwork.registers_own_reminders(p_company uuid)
RETURNS TABLE (id uuid, kind text, record_ref text, valid_until date, days_before integer, link text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL OR NOT EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.person_id = trustwork.current_person_id() AND m.company_id = p_company AND m.status = 'active' AND m.role = 'administrator') THEN
    RAISE EXCEPTION 'no such company' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  RETURN QUERY SELECT r.id, r.kind, r.record_ref, r.valid_until, r.days_before, f.link, r.created_at
    FROM trustwork.register_reminder r JOIN trustwork.register_fact f ON f.id = r.fact_id
   WHERE r.company_id = p_company ORDER BY r.created_at DESC, r.id LIMIT 200;
END $$;

-- 8. Worker ------------------------------------------------------------------------------------------------------------
-- Active adapters due for a refresh at p_now (fake ones are re-run by the worker; live ones need their adapter code).
CREATE FUNCTION trustwork.registers_due_adapters(p_now timestamptz, p_limit integer) RETURNS SETOF trustwork.register_adapter
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.register_adapter
   WHERE status = 'active' AND (last_run_at IS NULL OR last_run_at + make_interval(days => refresh_days) <= p_now)
   ORDER BY last_run_at NULLS FIRST, id LIMIT greatest(least(p_limit, 500), 0)
$$;

-- An adapter run from the worker: no person is the author.
CREATE FUNCTION trustwork.registers_record_adapter_run(p_adapter uuid, p_observations jsonb, p_now timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_adapter trustwork.register_adapter%ROWTYPE;
  v_obs jsonb;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_adapter FROM trustwork.register_adapter WHERE id = p_adapter FOR UPDATE;
  IF NOT FOUND OR v_adapter.status <> 'active' THEN
    RAISE EXCEPTION 'no such active adapter' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF jsonb_typeof(p_observations) <> 'array' OR jsonb_array_length(p_observations) > 5000 THEN
    RAISE EXCEPTION 'at most 5000 observations' USING ERRCODE = 'check_violation', HINT = 'registers.invalid_observation';
  END IF;
  FOR v_obs IN SELECT e FROM jsonb_array_elements(p_observations) e LOOP
    PERFORM trustwork.registers_record(v_adapter, v_obs, NULL);
    v_count := v_count + 1;
  END LOOP;
  UPDATE trustwork.register_adapter SET last_run_at = p_now WHERE id = p_adapter;
  RETURN v_count;
END $$;

-- The expiry watch at p_now: for every current fact with valid_until ahead, linked to a claimed or verified company,
-- record the smallest reminder step already reached (60, 30, 7 days) once. Returns the reminders it recorded.
CREATE FUNCTION trustwork.registers_run_expiry_watch(p_now timestamptz) RETURNS SETOF trustwork.register_reminder
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  INSERT INTO trustwork.register_reminder (hub_id, company_id, fact_id, adapter_id, kind, record_ref, valid_until, days_before)
  SELECT f.hub_id, c.id, f.id, f.adapter_id, f.kind, f.record_ref, f.valid_until, step.d
    FROM trustwork.register_fact f
    JOIN trustwork.company c ON c.claim_status IN ('claimed', 'verified')
     AND (trustwork.registers_company_holds(c.id, f.identifier_kind, f.identifier_norm)
       OR EXISTS (SELECT 1 FROM trustwork.register_fact_link l WHERE l.adapter_id = f.adapter_id AND l.record_ref = f.record_ref AND l.company_id = c.id AND l.ended_at IS NULL))
    CROSS JOIN LATERAL (
      SELECT min(d) AS d FROM unnest(trustwork.registers_reminder_days()) d WHERE f.valid_until - (p_now AT TIME ZONE 'UTC')::date <= d) step
   WHERE f.superseded_at IS NULL AND f.valid_until IS NOT NULL AND f.valid_until >= (p_now AT TIME ZONE 'UTC')::date AND step.d IS NOT NULL
  ON CONFLICT (company_id, adapter_id, kind, record_ref, valid_until, days_before) DO NOTHING
  RETURNING *
$$;

-- 9. Access ------------------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.register_adapter ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_adapter FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_fact FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_fact_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_fact_link FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.register_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.register_adapter AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.register_fact AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.register_fact_link AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.register_reminder AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY register_adapter_read ON trustwork.register_adapter FOR SELECT TO trustwork_app USING (trustwork.registers_staff_reader(hub_id));
CREATE POLICY register_fact_read ON trustwork.register_fact FOR SELECT TO trustwork_app USING (trustwork.registers_staff_reader(hub_id));
CREATE POLICY register_fact_link_read ON trustwork.register_fact_link FOR SELECT TO trustwork_app USING (trustwork.registers_staff_reader(hub_id));
CREATE POLICY register_reminder_read ON trustwork.register_reminder FOR SELECT TO trustwork_app USING (trustwork.registers_staff_reader(hub_id));

GRANT SELECT ON trustwork.register_adapter, trustwork.register_fact, trustwork.register_fact_link, trustwork.register_reminder TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.registers_bind_adapter(jsonb, uuid, text, uuid, integer), trustwork.registers_go_live(jsonb, uuid, integer, uuid, uuid),
  trustwork.registers_retire_adapter(jsonb, uuid, integer), trustwork.registers_record_fake_run(jsonb, uuid, jsonb),
  trustwork.registers_link_record(jsonb, uuid, text, uuid, text), trustwork.registers_end_link(jsonb, uuid),
  trustwork.registers_staff_reader(uuid), trustwork.registers_company_facts(uuid, uuid), trustwork.registers_public_facts(uuid, uuid),
  trustwork.registers_own_reminders(uuid),
  trustwork.registers_fact_kinds(), trustwork.registers_catalogue(), trustwork.registers_reader_permissions(), trustwork.registers_reminder_days(),
  trustwork.registers_norm(text), trustwork.registers_value_ok(text, jsonb), trustwork.registers_adapter_digest(uuid, integer, uuid),
  trustwork.registers_text_ok(jsonb, text, text), trustwork.registers_enum_ok(jsonb, text, text[]), trustwork.registers_date_ok(jsonb, text, boolean),
  trustwork.registers_keys_are(jsonb, text[])
TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.registers_due_adapters(timestamptz, integer), trustwork.registers_record_adapter_run(uuid, jsonb, timestamptz),
  trustwork.registers_run_expiry_watch(timestamptz) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- DATA-002 administration persistence, part 1 (slice A2 of docs/data/migration-plan.md): the node anchor staff scopes
-- refer to, scoped staff role definitions and assignments (platform, node or hub, ADR 012 decision 1), conflict
-- declarations, incidents (break-glass names one), second-person approvals bound to one action, one scope and one
-- digest, and the append-only mutation audit with a gap-free sequence. Elevated sessions are BE-004's
-- trustwork.session_elevation (identity/20261101150000: bound to a live session and a verified second factor, short-lived);
-- every staff command here requires a live elevation of the caller from that table.
--
-- Contracts: packages/contracts/src/admin.ts (frozen ADM-000) and the console extension in packages/contracts/src/hub.ts
-- (HUBC-000, console contract 1.0.0): ScopedStaffRoleDefinitionSchema, ScopedStaffRoleAssignmentSchema,
-- StaffScopeSchema, ConsoleSecondPersonApprovalSchema, ConsoleAuditEventSchema / AdminAuditEventSchema.
--
-- Authority model (ADR 002, ADR 010, ADR 012):
-- * Staff are ordinary people with one identity; authority comes only from active staff_role_assignment rows whose
--   released role definition names the permission, at a scope that covers the target. Nobody grants a role to
--   themselves; sensitive and break-glass roles need a consumed second-person approval whose digest the database
--   recomputes from the assignment itself; break-glass lasts at most 12 hours and names an open incident.
-- * Second-person approvals: requester and approver differ, the approver restates the digest, an approval expires at
--   most 72 hours after approval, only the requester executes it, and it is consumed exactly once.
-- * Every staff mutation runs through a SECURITY DEFINER command that checks the caller's principal, an active
--   elevation of the caller, the permission at the scope, and writes an admin_audit_event in the same transaction.
-- * The runtime role reads under FORCE row-level security; it may only INSERT audit rows (never UPDATE or DELETE:
--   no grant, and a raising trigger for every role, including the owner). There is no impersonation path.
--
-- Stored without a foreign key: admin_audit_event.case_id (support or dispute case, not available yet) and
-- admin_audit_event.session_elevation_id (audit outlives swept sessions and their elevations; the insert guard checks
-- that the elevation exists and belongs to the actor).

-- 0. Engine vocabularies as immutable functions (tested against the contracts) -------------------------------------
CREATE FUNCTION trustwork.admin_staff_roles() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['platform-owner', 'staff-admin', 'editor-in-chief', 'editor', 'moderator', 'trust-reviewer', 'support-agent', 'support-lead',
    'commercial-admin', 'data-steward', 'ops-engineer', 'privacy-officer', 'auditor', 'hub-owner', 'compliance-officer', 'node-operator']::text[]
$$;
-- SENSITIVE_HUB_STAFF_ROLES: assigning one is the A+2 action staff.assign_sensitive_role.
CREATE FUNCTION trustwork.admin_sensitive_roles() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['platform-owner', 'staff-admin', 'commercial-admin', 'privacy-officer', 'hub-owner', 'compliance-officer', 'node-operator']::text[]
$$;
-- ROLE_SCOPES: roles not listed may be held at any scope.
CREATE FUNCTION trustwork.admin_role_allowed_in_scope(p_role text, p_scope text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_role
    WHEN 'platform-owner' THEN p_scope = 'platform'
    WHEN 'node-operator' THEN p_scope = 'node'
    WHEN 'hub-owner' THEN p_scope = 'hub'
    WHEN 'compliance-officer' THEN p_scope IN ('node', 'hub')
    ELSE p_scope IN ('platform', 'node', 'hub') END
$$;
-- NODE_ONLY_PERMISSIONS: never granted inside a single hub.
CREATE FUNCTION trustwork.admin_node_only_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.node.hubs.manage', 'admin.node.keys.rotate', 'admin.ops.restore.execute', 'admin.ops.restore.drill', 'admin.ops.updates.apply']::text[]
$$;
-- CONSOLE_SECOND_PERSON_ACTIONS: the frozen A+2 set of admin.ts plus the console actions of hub.ts.
CREATE FUNCTION trustwork.admin_second_person_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['staff.assign_sensitive_role', 'commerce.activate_price_version', 'privacy.execute_erasure', 'moderation.apply_sanction_l4', 'providers.enable_non_fake', 'staff.switch_sod_mode',
    'hub.transition_soft_launch', 'hub.transition_public', 'hub.change_residency', 'legal.activate_document_version', 'federation.raise_peering_level',
    'models.activate_private_route', 'egress.allow_private_class', 'pipelines.activate_personal_data_dataset', 'datasets.activate_court_or_debt',
    'automation.raise_to_supervised_autonomous', 'agents.enable_commitment_module', 'agents.activate_extension', 'jurisdiction.activate_settings',
    'billing.activate_fee_version', 'billing.release_payout_batch', 'payments.change_settings', 'sponsored.enable', 'staff.grant_breakglass',
    'support.reset_second_factor', 'support.rebind_recovery_email', 'ops.execute_restore', 'ops.apply_production_migration', 'ops.rotate_node_key',
    'kill_switch.release']::text[]
$$;
-- The permissions that may execute (and therefore request and approve) each second-person action. The requester and
-- the approver each hold one of them at a covering scope; they are never the same person.
CREATE FUNCTION trustwork.admin_action_permissions(p_action text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_action
    WHEN 'staff.assign_sensitive_role' THEN ARRAY['admin.staff.assign']
    WHEN 'commerce.activate_price_version' THEN ARRAY['admin.commerce.price.activate']
    WHEN 'privacy.execute_erasure' THEN ARRAY['admin.privacy.erasure.execute']
    WHEN 'moderation.apply_sanction_l4' THEN ARRAY['admin.moderation.decide']
    WHEN 'providers.enable_non_fake' THEN ARRAY['admin.providers.toggle']
    WHEN 'staff.switch_sod_mode' THEN ARRAY['admin.staff.assign']
    WHEN 'hub.transition_soft_launch' THEN ARRAY['admin.hub.lifecycle.request']
    WHEN 'hub.transition_public' THEN ARRAY['admin.hub.lifecycle.request']
    WHEN 'hub.change_residency' THEN ARRAY['admin.hub.residency.edit']
    WHEN 'legal.activate_document_version' THEN ARRAY['admin.hub.legal.activate']
    WHEN 'federation.raise_peering_level' THEN ARRAY['admin.federation.peer.edit']
    WHEN 'models.activate_private_route' THEN ARRAY['admin.models.route.activate']
    WHEN 'egress.allow_private_class' THEN ARRAY['admin.providers.egress.edit']
    WHEN 'pipelines.activate_personal_data_dataset' THEN ARRAY['admin.pipelines.activate', 'admin.datasets.activate']
    WHEN 'datasets.activate_court_or_debt' THEN ARRAY['admin.datasets.activate']
    WHEN 'automation.raise_to_supervised_autonomous' THEN ARRAY['admin.editorial.automation.edit', 'admin.config.edit']
    WHEN 'agents.enable_commitment_module' THEN ARRAY['admin.agents.modules.activate']
    WHEN 'agents.activate_extension' THEN ARRAY['admin.agents.extensions.activate']
    WHEN 'jurisdiction.activate_settings' THEN ARRAY['admin.hub.jurisdiction.activate']
    WHEN 'billing.activate_fee_version' THEN ARRAY['admin.billing.fees.activate']
    WHEN 'billing.release_payout_batch' THEN ARRAY['admin.billing.payouts.release']
    WHEN 'payments.change_settings' THEN ARRAY['admin.hub.payments.edit']
    WHEN 'sponsored.enable' THEN ARRAY['admin.sponsored.policy.edit']
    WHEN 'staff.grant_breakglass' THEN ARRAY['admin.staff.breakglass']
    WHEN 'support.reset_second_factor' THEN ARRAY['admin.support.second_factor.reset']
    WHEN 'support.rebind_recovery_email' THEN ARRAY['admin.support.recovery.rebind']
    WHEN 'ops.execute_restore' THEN ARRAY['admin.ops.restore.execute']
    WHEN 'ops.apply_production_migration' THEN ARRAY['admin.ops.updates.apply']
    WHEN 'ops.rotate_node_key' THEN ARRAY['admin.node.keys.rotate']
    WHEN 'kill_switch.release' THEN ARRAY['admin.providers.kill', 'admin.agents.kill', 'admin.pipelines.pause']
    END::text[]
$$;
CREATE FUNCTION trustwork.admin_all_match(p_values text[], p_pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_values IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest(p_values) v WHERE v IS NULL OR v !~ p_pattern)
$$;
CREATE FUNCTION trustwork.admin_distinct(p_values anyarray) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) v)
$$;

-- `trustwork-digest-1` in SQL (packages/contracts/src/common/canonical.ts, RFC 8785): keys sorted by code unit (all
-- digest keys are ASCII, so collation "C"), ECMAScript string escaping (identical to PostgreSQL's JSON escaping),
-- integers only (every money or quantity value in a digest input is a string). The tests compare it with
-- computeDigest() of @trustwork/contracts, so the application and the database bind the same bytes.
CREATE FUNCTION trustwork.admin_canonical_json(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_out text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_json(e.key)::text || ':' || trustwork.admin_canonical_json(e.value), ',' ORDER BY e.key COLLATE "C"), '') || '}'
        INTO v_out FROM jsonb_each(p_value) e;
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(trustwork.admin_canonical_json(e.value), ',' ORDER BY e.ordinality), '') || ']'
        INTO v_out FROM jsonb_array_elements(p_value) WITH ORDINALITY e;
    WHEN 'string' THEN
      v_out := to_json(p_value #>> '{}')::text;
    WHEN 'number' THEN
      IF (p_value::text)::numeric <> trunc((p_value::text)::numeric) OR abs((p_value::text)::numeric) > 9007199254740991 THEN
        RAISE EXCEPTION 'digest inputs carry integers only' USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.not_canonicalizable';
      END IF;
      v_out := trunc((p_value::text)::numeric)::text;
    ELSE
      v_out := p_value::text;
  END CASE;
  RETURN v_out;
END $$;
CREATE FUNCTION trustwork.admin_digest(p_input jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to(trustwork.admin_canonical_json(p_input), 'UTF8')), 'hex')
$$;
-- The JSON form of a staff scope (StaffScopeSchema).
CREATE FUNCTION trustwork.admin_scope_json(p_kind text, p_node uuid, p_hub uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_kind WHEN 'platform' THEN jsonb_build_object('kind', 'platform')
                     WHEN 'node' THEN jsonb_build_object('kind', 'node', 'nodeId', p_node::text)
                     ELSE jsonb_build_object('kind', 'hub', 'hubId', p_hub::text) END
$$;
CREATE FUNCTION trustwork.admin_scope_kind(p_node uuid, p_hub uuid) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_hub IS NOT NULL THEN 'hub' WHEN p_node IS NOT NULL THEN 'node' ELSE 'platform' END
$$;

-- 1. Node anchor ----------------------------------------------------------------------------------------------------
-- One database is one node. The node identity package (manifest, keys) extends this anchor; until then it only gives
-- node-scoped staff assignments something to reference. Created once by the setup wizard (maintenance).
CREATE TABLE trustwork.admin_node (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_node_single ON trustwork.admin_node ((true));
CREATE TRIGGER admin_node_permanent BEFORE UPDATE OR DELETE ON trustwork.admin_node FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Staff role definitions (V) ------------------------------------------------------------------------------------
-- Released by the maintenance command from the ADM-000 capability map (repository staffRoleDefinitions.release
-- validates ScopedStaffRoleDefinitionSchema first); released_by NULL = engine release. Immutable once released.
CREATE TABLE trustwork.staff_role_definition_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  role text NOT NULL CHECK (role = ANY (trustwork.admin_staff_roles())),
  version integer NOT NULL CHECK (version >= 1),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['platform', 'node', 'hub']::text[] AND trustwork.admin_distinct(scopes)),
  permissions text[] NOT NULL CHECK (cardinality(permissions) >= 1 AND trustwork.admin_all_match(permissions, '^admin\.[a-z_]+(\.[a-z_]+)+$') AND trustwork.admin_distinct(permissions)),
  credit_cap_minor bigint NULL CHECK (credit_cap_minor >= 0),
  grant_max_hours integer NOT NULL CHECK (grant_max_hours BETWEEN 1 AND 72),
  sod_conflicts text[] NOT NULL DEFAULT '{}' CHECK (sod_conflicts <@ trustwork.admin_staff_roles() AND trustwork.admin_distinct(sod_conflicts)),
  sod_mode text NOT NULL CHECK (sod_mode IN ('reduced', 'full')),
  released_by uuid NULL REFERENCES trustwork.person (id),
  released_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_role_definition_version_unique UNIQUE (role, version),
  CONSTRAINT staff_role_definition_not_self_conflict CHECK (NOT (role = ANY (sod_conflicts))),
  CONSTRAINT staff_role_definition_hub_permissions CHECK (NOT ('hub' = ANY (scopes)) OR NOT (permissions && trustwork.admin_node_only_permissions()))
);
CREATE FUNCTION trustwork.admin_definition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_scope text;
BEGIN
  FOREACH v_scope IN ARRAY NEW.scopes LOOP
    IF NOT trustwork.admin_role_allowed_in_scope(NEW.role, v_scope) THEN
      RAISE EXCEPTION 'role % cannot be held at scope %', NEW.role, v_scope USING ERRCODE = 'check_violation', HINT = 'admin.role_scope';
    END IF;
  END LOOP;
  NEW.released_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_role_definition_guard BEFORE INSERT ON trustwork.staff_role_definition_version FOR EACH ROW EXECUTE FUNCTION trustwork.admin_definition_guard();
CREATE TRIGGER staff_role_definition_immutable BEFORE UPDATE OR DELETE ON trustwork.staff_role_definition_version FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Incidents ------------------------------------------------------------------------------------------------------
-- Created before assignments because a break-glass role names one. Every emergency action links here and an incident
-- closes only with a post-incident review reference.
CREATE TABLE trustwork.incident (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  kind text NOT NULL CHECK (kind IN ('security', 'privacy_breach', 'provider', 'content', 'availability')),
  severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigated', 'resolved', 'closed')),
  linked_actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(linked_actions) = 'array'),
  breach_authority text NULL CHECK (length(breach_authority) BETWEEN 1 AND 200),
  notification_deadline timestamptz NULL,
  notified_at timestamptz NULL,
  post_review_ref text NULL CHECK (post_review_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  opened_by uuid NOT NULL REFERENCES trustwork.person (id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid NULL REFERENCES trustwork.person (id),
  closed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_scope_shape CHECK ((scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT incident_breach_deadline CHECK (kind <> 'privacy_breach' OR notification_deadline IS NOT NULL OR status = 'open'),
  CONSTRAINT incident_closed_reviewed CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND (status <> 'closed' OR (post_review_ref IS NOT NULL AND closed_by IS NOT NULL)))
);
CREATE FUNCTION trustwork.admin_incident_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.opened_at := now();
    IF NEW.status <> 'open' OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'incidents open as open' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.scope_kind <> OLD.scope_kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.hub_id IS DISTINCT FROM OLD.hub_id
     OR NEW.kind <> OLD.kind OR NEW.opened_by <> OLD.opened_by OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'incident identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'closed incidents are final' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NOT (NEW.linked_actions @> OLD.linked_actions) THEN
    RAISE EXCEPTION 'linked actions are only appended' USING ERRCODE = 'check_violation', HINT = 'audit.append_only';
  END IF;
  IF NEW.status = 'closed' THEN
    NEW.closed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER incident_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.incident FOR EACH ROW EXECUTE FUNCTION trustwork.admin_incident_guard();
CREATE TRIGGER incident_touch BEFORE UPDATE ON trustwork.incident FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 4. Second-person approvals ----------------------------------------------------------------------------------------
-- pending -> approved | declined | revoked; approved -> consumed | revoked. Expiry is time-based: a pending request
-- after request_expires_at (7 days) or an approval after expires_at (at most 72 hours after approval) cannot be used.
CREATE TABLE trustwork.second_person_approval (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  action text NOT NULL CHECK (action = ANY (trustwork.admin_second_person_actions())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  requested_by uuid NOT NULL REFERENCES trustwork.person (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  request_expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'revoked', 'consumed')),
  approved_by uuid NULL REFERENCES trustwork.person (id),
  approved_at timestamptz NULL,
  expires_at timestamptz NULL,
  declined_by uuid NULL REFERENCES trustwork.person (id),
  decline_reason text NULL CHECK (length(decline_reason) BETWEEN 1 AND 500),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  consumed_at timestamptz NULL,
  consumed_ref uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT second_person_approval_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT second_person_approval_distinct_people CHECK (approved_by IS DISTINCT FROM requested_by AND declined_by IS DISTINCT FROM requested_by),
  CONSTRAINT second_person_approval_approved_shape CHECK ((approved_by IS NOT NULL) = (approved_at IS NOT NULL) AND (approved_at IS NOT NULL) = (expires_at IS NOT NULL)
    AND (approved_at IS NULL OR (expires_at > approved_at AND expires_at <= approved_at + interval '72 hours'))),
  CONSTRAINT second_person_approval_status_shape CHECK (CASE status
    WHEN 'pending' THEN approved_by IS NULL AND declined_by IS NULL AND consumed_at IS NULL
    WHEN 'approved' THEN approved_by IS NOT NULL AND declined_by IS NULL AND consumed_at IS NULL AND revoked_at IS NULL
    WHEN 'declined' THEN declined_by IS NOT NULL AND approved_by IS NULL AND consumed_at IS NULL
    WHEN 'consumed' THEN approved_by IS NOT NULL AND consumed_at IS NOT NULL AND consumed_ref IS NOT NULL AND revoked_at IS NULL
    ELSE revoked_at IS NOT NULL AND consumed_at IS NULL END),
  CONSTRAINT second_person_approval_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX second_person_approval_open_idx ON trustwork.second_person_approval (status, scope_kind, hub_id) WHERE status IN ('pending', 'approved');
CREATE INDEX second_person_approval_requester_idx ON trustwork.second_person_approval (requested_by, status);
CREATE TRIGGER second_person_approval_touch BEFORE UPDATE ON trustwork.second_person_approval FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.admin_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.approved_by IS NOT NULL OR NEW.declined_by IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'an approval is born pending' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.requested_at := now();
    NEW.request_expires_at := now() + interval '7 days';
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.action <> OLD.action OR NEW.scope_kind <> OLD.scope_kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.hub_id IS DISTINCT FROM OLD.hub_id
     OR NEW.action_digest <> OLD.action_digest OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at
     OR NEW.request_expires_at <> OLD.request_expires_at THEN
    RAISE EXCEPTION 'the approved request is immutable; ask again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF ROW(NEW.approved_by, NEW.approved_at, NEW.expires_at, NEW.declined_by, NEW.decline_reason, NEW.revoked_at, NEW.revoked_by, NEW.consumed_at, NEW.consumed_ref)
       IS DISTINCT FROM ROW(OLD.approved_by, OLD.approved_at, OLD.expires_at, OLD.declined_by, OLD.decline_reason, OLD.revoked_at, OLD.revoked_by, OLD.consumed_at, OLD.consumed_ref) THEN
      RAISE EXCEPTION 'decision columns change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'declined', 'revoked')) OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'revoked'))) THEN
    RAISE EXCEPTION 'approval % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'declined') AND OLD.request_expires_at <= now() THEN
    RAISE EXCEPTION 'the request expired; ask again' USING ERRCODE = 'check_violation', HINT = 'admin.approval_expired';
  END IF;
  IF NEW.status = 'approved' THEN
    -- The database stamps the decision time; a requested validity is kept relative to it and capped at 72 hours.
    NEW.expires_at := now() + least(coalesce(NEW.expires_at - NEW.approved_at, interval '72 hours'), interval '72 hours');
    NEW.approved_at := now();
  ELSIF NEW.status = 'consumed' THEN
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'the approval expired' USING ERRCODE = 'check_violation', HINT = 'admin.approval_expired';
    END IF;
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'decision columns are immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    NEW.consumed_at := now();
  ELSIF NEW.status = 'revoked' THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER second_person_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.second_person_approval FOR EACH ROW EXECUTE FUNCTION trustwork.admin_approval_guard();

-- 5. Staff role assignments ------------------------------------------------------------------------------------------
CREATE TABLE trustwork.staff_role_assignment (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  role text NOT NULL CHECK (role = ANY (trustwork.admin_staff_roles())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  definition_version integer NOT NULL,
  granted_by uuid NULL REFERENCES trustwork.person (id),
  approved_by uuid NULL REFERENCES trustwork.person (id),
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  breakglass boolean NOT NULL DEFAULT false,
  incident_id uuid NULL REFERENCES trustwork.incident (id),
  setup_bootstrap boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  revoke_reason text NULL CHECK (length(revoke_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_role_assignment_definition FOREIGN KEY (role, definition_version) REFERENCES trustwork.staff_role_definition_version (role, version),
  CONSTRAINT staff_role_assignment_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT staff_role_assignment_role_scope CHECK (trustwork.admin_role_allowed_in_scope(role, scope_kind)),
  CONSTRAINT staff_role_assignment_not_self CHECK (granted_by IS DISTINCT FROM person_id),
  CONSTRAINT staff_role_assignment_bootstrap CHECK (setup_bootstrap = (granted_by IS NULL) AND NOT (setup_bootstrap AND breakglass)),
  CONSTRAINT staff_role_assignment_second_person CHECK (setup_bootstrap OR NOT (role = ANY (trustwork.admin_sensitive_roles()) OR breakglass)
    OR (approval_id IS NOT NULL AND approved_by IS NOT NULL AND approved_by <> granted_by AND approved_by <> person_id)),
  CONSTRAINT staff_role_assignment_validity CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT staff_role_assignment_breakglass CHECK (NOT breakglass OR (incident_id IS NOT NULL AND valid_until IS NOT NULL AND valid_until <= valid_from + interval '12 hours')),
  CONSTRAINT staff_role_assignment_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX staff_role_assignment_person_idx ON trustwork.staff_role_assignment (person_id) WHERE revoked_at IS NULL;
CREATE INDEX staff_role_assignment_hub_idx ON trustwork.staff_role_assignment (hub_id) WHERE hub_id IS NOT NULL;

-- Resolves which role (if any) gives p_person the permission at a target: {node, hub} or the platform (both NULL).
-- A platform assignment covers everything; a node assignment covers its node and every hub (one database is one
-- node); a hub assignment covers that hub only and never a node-only permission. Invoker helper (no grant): it reads
-- FORCE-RLS tables and is only called inside owner-run functions with the maintenance flag. A non-break-glass role
-- is preferred so audit marks break-glass only when nothing else authorizes the action.
CREATE FUNCTION trustwork.admin_resolve_permission(p_person uuid, p_permission text, p_node uuid, p_hub uuid, OUT role text, OUT breakglass boolean)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT a.role, a.breakglass
  FROM trustwork.staff_role_assignment a
  JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
  WHERE a.person_id = p_person AND p_person IS NOT NULL AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
    AND p_permission = ANY (d.permissions) AND a.scope_kind = ANY (d.scopes)
    AND CASE a.scope_kind
      WHEN 'platform' THEN true
      WHEN 'node' THEN p_hub IS NOT NULL OR p_node = a.node_id
      ELSE p_hub = a.hub_id AND NOT (p_permission = ANY (trustwork.admin_node_only_permissions())) END
  ORDER BY a.breakglass, a.valid_from
  LIMIT 1
$$;
-- The first of p_permissions (in order) that p_person holds at the target, with the role that gives it.
CREATE FUNCTION trustwork.admin_resolve_any(p_person uuid, p_permissions text[], p_node uuid, p_hub uuid, OUT permission text, OUT role text, OUT breakglass boolean)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p.permission, r.role, r.breakglass
  FROM unnest(p_permissions) WITH ORDINALITY p(permission, ord)
  CROSS JOIN LATERAL trustwork.admin_resolve_permission(p_person, p.permission, p_node, p_hub) r
  WHERE r.role IS NOT NULL
  ORDER BY r.breakglass, p.ord
  LIMIT 1
$$;
-- True when p_person holds any active role (or the named role) at a scope covering the target.
CREATE FUNCTION trustwork.admin_person_is_staff(p_person uuid, p_node uuid, p_hub uuid, p_role text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a
    WHERE a.person_id = p_person AND p_person IS NOT NULL AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
      AND (p_role IS NULL OR a.role = p_role)
      AND CASE a.scope_kind WHEN 'platform' THEN true WHEN 'node' THEN p_hub IS NOT NULL OR p_node = a.node_id ELSE p_hub = a.hub_id END
  )
$$;
-- Does a holder's scope cover a target scope (for grants: a hub admin cannot assign at the node or platform)?
CREATE FUNCTION trustwork.admin_target(p_kind text, p_node uuid, p_hub uuid, OUT node uuid, OUT hub uuid)
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_kind = 'node' THEN p_node END, CASE WHEN p_kind = 'hub' THEN p_hub END
$$;

-- The digest a staff assignment approval binds (staff.assign_sensitive_role or staff.grant_breakglass). Timestamps are
-- not part of it: the validity is a duration from the moment of execution.
CREATE FUNCTION trustwork.admin_assignment_digest(p_action text, p_person uuid, p_role text, p_scope_kind text, p_node uuid, p_hub uuid,
  p_definition_version integer, p_breakglass boolean, p_incident uuid, p_valid_for_seconds bigint) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object(
    'action', p_action, 'personId', p_person::text, 'role', p_role, 'scope', trustwork.admin_scope_json(p_scope_kind, p_node, p_hub),
    'definitionVersion', p_definition_version, 'breakglass', p_breakglass, 'incidentId', p_incident::text, 'validForSeconds', p_valid_for_seconds))
$$;

CREATE FUNCTION trustwork.admin_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_target record;
  v_def trustwork.staff_role_definition_version%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_action text;
  v_valid_for bigint;
  v_incident trustwork.incident%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff assignments are never deleted; revoke them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.definition_version, NEW.granted_by, NEW.approved_by, NEW.approval_id,
           NEW.reason, NEW.breakglass, NEW.incident_id, NEW.setup_bootstrap, NEW.valid_from, NEW.valid_until, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.person_id, OLD.role, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.definition_version, OLD.granted_by, OLD.approved_by, OLD.approval_id,
           OLD.reason, OLD.breakglass, OLD.incident_id, OLD.setup_bootstrap, OLD.valid_from, OLD.valid_until, OLD.created_at)
       OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'a staff assignment only changes by revocation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    SELECT * INTO v_target FROM trustwork.admin_target(OLD.scope_kind, OLD.node_id, OLD.hub_id);
    IF NEW.revoked_by <> OLD.person_id AND NOT trustwork.maintenance_session()
       AND (SELECT r.role FROM trustwork.admin_resolve_permission(NEW.revoked_by, 'admin.staff.revoke', v_target.node, v_target.hub) r) IS NULL THEN
      RAISE EXCEPTION 'revoking needs admin.staff.revoke at a covering scope' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
    END IF;
    NEW.revoked_at := now();
    RETURN NEW;
  END IF;

  NEW.created_at := now();
  IF NEW.valid_from < now() THEN
    NEW.valid_from := now();
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
    RAISE EXCEPTION 'an assignment is born unrevoked' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  SELECT * INTO v_def FROM trustwork.staff_role_definition_version WHERE role = NEW.role AND version = NEW.definition_version;
  IF FOUND AND NOT (NEW.scope_kind = ANY (v_def.scopes)) THEN
    RAISE EXCEPTION 'definition % v% is not held at scope %', NEW.role, NEW.definition_version, NEW.scope_kind USING ERRCODE = 'check_violation', HINT = 'admin.role_scope';
  END IF;

  IF NEW.setup_bootstrap THEN
    -- The setup wizard's founding administrators: maintenance only, at most two different people (the second person
    -- every later sensitive assignment needs), and only before any staff assignment was made through the console.
    IF NOT trustwork.maintenance_session() THEN
      RAISE EXCEPTION 'only the setup maintenance path bootstraps founding administrators' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('trustwork.admin_bootstrap'));
    IF EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE NOT a.setup_bootstrap)
       OR (SELECT count(*) FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap) >= 2
       OR EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.person_id = NEW.person_id) THEN
      RAISE EXCEPTION 'setup is over; assign through a staff administrator' USING ERRCODE = 'check_violation', HINT = 'admin.bootstrap_closed';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO v_target FROM trustwork.admin_target(NEW.scope_kind, NEW.node_id, NEW.hub_id);
  IF (SELECT r.role FROM trustwork.admin_resolve_permission(NEW.granted_by, CASE WHEN NEW.breakglass THEN 'admin.staff.breakglass' ELSE 'admin.staff.assign' END, v_target.node, v_target.hub) r) IS NULL THEN
    RAISE EXCEPTION 'the grantor holds no assigning permission at a covering scope' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;

  IF NEW.breakglass THEN
    IF NEW.valid_until IS NULL OR NEW.valid_until > NEW.valid_from + interval '12 hours' THEN
      RAISE EXCEPTION 'break-glass lasts at most 12 hours' USING ERRCODE = 'check_violation', HINT = 'admin.breakglass_too_long';
    END IF;
    SELECT * INTO v_incident FROM trustwork.incident WHERE id = NEW.incident_id;
    IF NOT FOUND OR v_incident.status IN ('resolved', 'closed') THEN
      RAISE EXCEPTION 'break-glass names an open incident' USING ERRCODE = 'check_violation', HINT = 'admin.incident_not_open';
    END IF;
  END IF;

  IF NEW.role = ANY (trustwork.admin_sensitive_roles()) OR NEW.breakglass THEN
    v_action := CASE WHEN NEW.breakglass THEN 'staff.grant_breakglass' ELSE 'staff.assign_sensitive_role' END;
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
    v_valid_for := CASE WHEN NEW.valid_until IS NULL THEN NULL ELSE round(extract(epoch FROM NEW.valid_until - NEW.valid_from))::bigint END;
    IF NOT FOUND OR v_approval.action <> v_action OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id
       OR v_approval.requested_by IS DISTINCT FROM NEW.granted_by OR v_approval.approved_by IS DISTINCT FROM NEW.approved_by
       OR v_approval.scope_kind <> NEW.scope_kind OR v_approval.node_id IS DISTINCT FROM NEW.node_id OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id
       OR v_approval.action_digest <> trustwork.admin_assignment_digest(v_action, NEW.person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id,
            NEW.definition_version, NEW.breakglass, NEW.incident_id, v_valid_for) THEN
      RAISE EXCEPTION 'sensitive and break-glass roles need the consumed second-person approval of exactly this assignment' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_mismatch';
    END IF;
  ELSIF NEW.approval_id IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'only sensitive and break-glass roles carry an approval' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;

  -- Separation of duties: in full mode a role never joins a conflicting role held by the same person.
  IF EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a
    JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
    WHERE a.person_id = NEW.person_id AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
      AND ((v_def.sod_mode = 'full' AND a.role = ANY (v_def.sod_conflicts)) OR (d.sod_mode = 'full' AND NEW.role = ANY (d.sod_conflicts)))
  ) THEN
    RAISE EXCEPTION 'role % conflicts with a role the person already holds', NEW.role USING ERRCODE = 'check_violation', HINT = 'admin.sod_conflict';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_role_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_role_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.admin_assignment_guard();

-- 6. Conflict declarations and leaving --------------------------------------------------------------------------------
CREATE TABLE trustwork.staff_conflict_declaration (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  staff_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  conflict_person_id uuid NULL REFERENCES trustwork.person (id),
  conflict_company_id uuid NULL REFERENCES trustwork.company (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  declared_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CONSTRAINT staff_conflict_declaration_party_xor CHECK ((conflict_person_id IS NULL) <> (conflict_company_id IS NULL)),
  CONSTRAINT staff_conflict_declaration_not_self CHECK (conflict_person_id IS DISTINCT FROM staff_person_id)
);
CREATE INDEX staff_conflict_declaration_staff_idx ON trustwork.staff_conflict_declaration (staff_person_id) WHERE ended_at IS NULL;
CREATE FUNCTION trustwork.admin_conflict_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'declarations are never deleted; end them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.declared_at := now();
    NEW.ended_at := NULL;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.staff_person_id, NEW.conflict_person_id, NEW.conflict_company_id, NEW.reason, NEW.declared_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.staff_person_id, OLD.conflict_person_id, OLD.conflict_company_id, OLD.reason, OLD.declared_at)
     OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'a declaration only ends, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_conflict_declaration_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_conflict_declaration FOR EACH ROW EXECUTE FUNCTION trustwork.admin_conflict_guard();

-- Conflict of interest of p_person towards a party: themselves, their active employer, or a live declaration.
CREATE FUNCTION trustwork.admin_conflicted(p_person uuid, p_party_person uuid, p_party_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT (p_party_person IS NOT NULL AND p_party_person = p_person)
    OR (p_party_company IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_person AND m.company_id = p_party_company AND m.status = 'active'))
    OR EXISTS (SELECT 1 FROM trustwork.staff_conflict_declaration c WHERE c.staff_person_id = p_person AND c.ended_at IS NULL
               AND (c.conflict_person_id = p_party_person OR c.conflict_company_id = p_party_company))
$$;


-- Leaving: revoking a person's last active role ends their elevations and their open approval requests at once.
CREATE FUNCTION trustwork.admin_assignment_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a WHERE a.person_id = NEW.person_id AND a.id <> NEW.id AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
  ) THEN
    UPDATE trustwork.session_elevation SET revoked_at = now(), revoked_reason = 'ended' WHERE person_id = NEW.person_id AND revoked_at IS NULL;
    UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = NEW.revoked_by
     WHERE requested_by = NEW.person_id AND status IN ('pending', 'approved');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staff_role_assignment_revoked AFTER UPDATE ON trustwork.staff_role_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.admin_assignment_revoked();

-- 7. Append-only mutation audit with a gap-free sequence --------------------------------------------------------------
-- The sequence comes from a counter row updated in the inserting transaction: concurrent writers serialize on it and a
-- rolled-back insert rolls the counter back too, so committed sequences have no gaps (auditSequenceContinuous).
CREATE TABLE trustwork.admin_sequence (
  name text PRIMARY KEY CHECK (name IN ('admin_audit_event', 'access_log_entry')),
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);
INSERT INTO trustwork.admin_sequence (name) VALUES ('admin_audit_event'), ('access_log_entry');

CREATE FUNCTION trustwork.admin_next_sequence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.admin_sequence SET last_value = last_value + 1 WHERE name = TG_TABLE_NAME RETURNING last_value INTO NEW.sequence;
  IF NEW.sequence IS NULL THEN
    RAISE EXCEPTION 'no sequence for %', TG_TABLE_NAME USING ERRCODE = 'internal_error';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE trustwork.admin_audit_event (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  sequence bigint NOT NULL UNIQUE CHECK (sequence >= 1),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  actor_role text NOT NULL CHECK (actor_role = ANY (trustwork.admin_staff_roles())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  permission text NOT NULL CHECK (permission ~ '^admin\.[a-z_]+(\.[a-z_]+)+$'),
  session_elevation_id uuid NOT NULL,
  breakglass boolean NOT NULL DEFAULT false,
  case_id uuid NULL,
  second_approver_person_id uuid NULL REFERENCES trustwork.person (id),
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  approval_digest text NULL CHECK (approval_digest ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (length(action) <= 100 AND action ~ '^[a-z][A-Za-z0-9_.]*$'),
  object_type text NOT NULL CHECK (length(object_type) BETWEEN 1 AND 64),
  object_id uuid NOT NULL,
  object_revision_before integer NULL CHECK (object_revision_before >= 1),
  object_revision_after integer NULL CHECK (object_revision_after >= 1),
  before_digest text NULL CHECK (before_digest ~ '^[a-f0-9]{64}$'),
  after_digest text NULL CHECK (after_digest ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL CHECK (length(reason_code) <= 64 AND reason_code ~ '^[a-z][a-z0-9_]*$'),
  reason_text text NOT NULL CHECK (length(reason_text) BETWEEN 1 AND 500),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'denied', 'failed')),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  client_fingerprint_hash text NULL CHECK (client_fingerprint_hash ~ '^[a-f0-9]{64}$'),
  retention_class text NOT NULL DEFAULT 'audit_long' CHECK (retention_class IN ('audit_long', 'audit_standard')),
  CONSTRAINT admin_audit_event_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT admin_audit_event_not_own_approver CHECK (second_approver_person_id IS DISTINCT FROM actor_person_id),
  CONSTRAINT admin_audit_event_second_person CHECK (NOT (action = ANY (trustwork.admin_second_person_actions())) OR outcome <> 'applied'
    OR (second_approver_person_id IS NOT NULL AND approval_digest IS NOT NULL AND approval_id IS NOT NULL)),
  CONSTRAINT admin_audit_event_node_only CHECK (scope_kind <> 'hub' OR NOT (permission = ANY (trustwork.admin_node_only_permissions())))
);
CREATE INDEX admin_audit_event_actor_idx ON trustwork.admin_audit_event (actor_person_id, occurred_at);
CREATE INDEX admin_audit_event_object_idx ON trustwork.admin_audit_event (object_type, object_id);
CREATE INDEX admin_audit_event_hub_idx ON trustwork.admin_audit_event (hub_id, occurred_at) WHERE hub_id IS NOT NULL;

-- Consistency for every writer: the elevation is the actor's own; a recorded approval names its approver and digest.
CREATE FUNCTION trustwork.admin_audit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  NEW.occurred_at := now();
  IF NOT EXISTS (SELECT 1 FROM trustwork.session_elevation e WHERE e.id = NEW.session_elevation_id AND e.person_id = NEW.actor_person_id) THEN
    RAISE EXCEPTION 'the elevation is not the actor''s' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.elevation_required';
  END IF;
  IF NEW.approval_id IS NOT NULL OR NEW.second_approver_person_id IS NOT NULL OR NEW.approval_digest IS NOT NULL THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
    IF NOT FOUND OR v_approval.approved_by IS DISTINCT FROM NEW.second_approver_person_id OR v_approval.action_digest IS DISTINCT FROM NEW.approval_digest
       OR v_approval.requested_by <> NEW.actor_person_id THEN
      RAISE EXCEPTION 'the recorded approval does not match' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_audit_event_guard BEFORE INSERT ON trustwork.admin_audit_event FOR EACH ROW EXECUTE FUNCTION trustwork.admin_audit_guard();
CREATE TRIGGER admin_audit_event_sequence BEFORE INSERT ON trustwork.admin_audit_event FOR EACH ROW EXECUTE FUNCTION trustwork.admin_next_sequence();
CREATE TRIGGER admin_audit_event_append_only BEFORE UPDATE OR DELETE ON trustwork.admin_audit_event FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER admin_audit_event_no_truncate BEFORE TRUNCATE ON trustwork.admin_audit_event FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER admin_sequence_no_delete BEFORE DELETE ON trustwork.admin_sequence FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER admin_sequence_no_truncate BEFORE TRUNCATE ON trustwork.admin_sequence FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 8. Command plumbing (invoker helpers, no grant; called inside the SECURITY DEFINER commands) -------------------------
-- p_ctx: {"elevationId": uuid, "requestId": id, "reasonCode": snake, "reasonText": text, "clientFingerprintHash"?: hex}.
CREATE TYPE trustwork.admin_actor AS (person_id uuid, role text, breakglass boolean, elevation_id uuid, permission text);

CREATE FUNCTION trustwork.admin_require_caller() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  RETURN v_person;
END $$;

-- The active elevation of the caller named by the context.
CREATE FUNCTION trustwork.admin_require_elevation(p_ctx jsonb) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_id uuid;
BEGIN
  IF p_ctx IS NULL OR jsonb_typeof(p_ctx) <> 'object' OR coalesce(p_ctx ->> 'requestId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR coalesce(p_ctx ->> 'reasonCode', '') !~ '^[a-z][a-z0-9_]{0,63}$' OR length(coalesce(p_ctx ->> 'reasonText', '')) NOT BETWEEN 1 AND 500
     OR coalesce(p_ctx ->> 'elevationId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_ctx ->> 'clientFingerprintHash', '0000000000000000000000000000000000000000000000000000000000000000') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'a staff command needs an elevation, a request id and a reason' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  SELECT e.id INTO v_id FROM trustwork.session_elevation e JOIN trustwork.session s ON s.id = e.session_id
   WHERE e.id = (p_ctx ->> 'elevationId')::uuid AND e.person_id = v_person AND e.revoked_at IS NULL AND e.expires_at > now()
     AND s.person_id = v_person AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'an active elevation of the caller is required' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.elevation_required';
  END IF;
  RETURN v_id;
END $$;

-- Caller + elevation + one of the permissions at the target, or a refusal. The result is what the audit records.
CREATE FUNCTION trustwork.admin_authorize(p_ctx jsonb, p_permissions text[], p_node uuid, p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_person uuid := trustwork.current_person_id();
  v_grant record;
BEGIN
  SELECT * INTO v_grant FROM trustwork.admin_resolve_any(v_person, p_permissions, p_node, p_hub);
  IF v_grant.role IS NULL THEN
    RAISE EXCEPTION 'none of % is held at this scope', p_permissions USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  RETURN ROW(v_person, v_grant.role, v_grant.breakglass, v_elevation, v_grant.permission)::trustwork.admin_actor;
END $$;

-- One audit row for an applied staff mutation; before/after are digests of the row images, never payloads.
CREATE FUNCTION trustwork.admin_record(p_actor trustwork.admin_actor, p_ctx jsonb, p_node uuid, p_hub uuid, p_action text,
  p_object_type text, p_object_id uuid, p_before jsonb, p_after jsonb, p_case uuid DEFAULT NULL, p_approval uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF p_approval IS NOT NULL THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = p_approval;
  END IF;
  INSERT INTO trustwork.admin_audit_event (actor_person_id, actor_role, scope_kind, node_id, hub_id, permission, session_elevation_id, breakglass, case_id,
    second_approver_person_id, approval_id, approval_digest, action, object_type, object_id, object_revision_before, object_revision_after, before_digest, after_digest,
    reason_code, reason_text, outcome, request_id, client_fingerprint_hash)
  VALUES (p_actor.person_id, p_actor.role, trustwork.admin_scope_kind(p_node, p_hub), CASE WHEN p_hub IS NULL THEN p_node END, p_hub, p_actor.permission, p_actor.elevation_id,
    p_actor.breakglass, p_case, v_approval.approved_by, v_approval.id, v_approval.action_digest, p_action, p_object_type, p_object_id,
    (p_before ->> 'revision')::integer, (p_after ->> 'revision')::integer,
    CASE WHEN p_before IS NULL THEN NULL ELSE trustwork.admin_digest(p_before) END, CASE WHEN p_after IS NULL THEN NULL ELSE trustwork.admin_digest(p_after) END,
    p_ctx ->> 'reasonCode', p_ctx ->> 'reasonText', 'applied', p_ctx ->> 'requestId', NULLIF(p_ctx ->> 'clientFingerprintHash', ''));
END $$;

-- 9. Commands (SECURITY DEFINER, allowlisted for the runtime role) ----------------------------------------------------
-- Used by policies: does the caller hold the permission (any of the permissions) at the target?
CREATE FUNCTION trustwork.admin_has_permission(p_permission text, p_node uuid, p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT (SELECT r.role FROM trustwork.admin_resolve_permission(trustwork.current_person_id(), p_permission, p_node, p_hub) r) IS NOT NULL
$$;
CREATE FUNCTION trustwork.admin_has_any_permission(p_permissions text[], p_node uuid, p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), p_permissions, p_node, p_hub) r) IS NOT NULL
$$;
-- Used by the audit insert policy: the caller holds the named role at a covering scope and owns the elevation.
CREATE FUNCTION trustwork.admin_may_audit(p_role text, p_node uuid, p_hub uuid, p_elevation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND trustwork.admin_person_is_staff(trustwork.current_person_id(), p_node, p_hub, p_role)
    AND EXISTS (SELECT 1 FROM trustwork.session_elevation e WHERE e.id = p_elevation AND e.person_id = trustwork.current_person_id())
$$;

-- Ask for a second person: the requester holds a permission that executes the action, at a covering scope.
CREATE FUNCTION trustwork.admin_request_approval(p_ctx jsonb, p_action text, p_scope_kind text, p_node uuid, p_hub uuid, p_action_digest text) RETURNS trustwork.second_person_approval
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_target record;
  v_actor trustwork.admin_actor;
  v_row trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF NOT (p_action = ANY (trustwork.admin_second_person_actions())) THEN
    RAISE EXCEPTION 'unknown second-person action %', p_action USING ERRCODE = 'check_violation', HINT = 'admin.unknown_action';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_action_permissions(p_action), v_target.node, v_target.hub);
  INSERT INTO trustwork.second_person_approval (action, scope_kind, node_id, hub_id, action_digest, reason, requested_by)
  VALUES (p_action, p_scope_kind, v_target.node, v_target.hub, p_action_digest, p_ctx ->> 'reasonText', v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'approval.requested', 'second_person_approval', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Decide as the second person: never the requester, holding a permission that executes the action at a covering
-- scope, restating the digest they reviewed. The row lock makes concurrent approvers race safely: exactly one
-- decision wins, the other sees a decided request (admin.approval_not_pending).
CREATE FUNCTION trustwork.admin_decide_approval(p_ctx jsonb, p_approval_id uuid, p_decision text, p_action_digest text, p_valid_for interval DEFAULT interval '72 hours')
RETURNS trustwork.second_person_approval
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_person uuid := trustwork.current_person_id();
  v_before trustwork.second_person_approval%ROWTYPE;
  v_row trustwork.second_person_approval%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.second_person_approval WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such approval request' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_before.requested_by = v_person THEN
    RAISE EXCEPTION 'nobody approves their own request' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_action_permissions(v_before.action), v_before.node_id, v_before.hub_id);
  IF v_before.status <> 'pending' THEN
    RAISE EXCEPTION 'the request is already %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.approval_not_pending';
  END IF;
  IF v_before.request_expires_at <= now() THEN
    RAISE EXCEPTION 'the request expired; ask again' USING ERRCODE = 'check_violation', HINT = 'admin.approval_expired';
  END IF;
  IF p_decision = 'approve' THEN
    IF p_action_digest IS DISTINCT FROM v_before.action_digest THEN
      RAISE EXCEPTION 'the reviewed digest differs from the request' USING ERRCODE = 'check_violation', HINT = 'access.approval_digest_mismatch';
    END IF;
    IF p_valid_for IS NULL OR p_valid_for <= interval '0' OR p_valid_for > interval '72 hours' THEN
      RAISE EXCEPTION 'an approval lasts at most 72 hours' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.approval_too_long';
    END IF;
    UPDATE trustwork.second_person_approval SET status = 'approved', approved_by = v_person, approved_at = now(), expires_at = now() + p_valid_for
     WHERE id = p_approval_id RETURNING * INTO v_row;
  ELSIF p_decision = 'decline' THEN
    UPDATE trustwork.second_person_approval SET status = 'declined', declined_by = v_person, decline_reason = p_ctx ->> 'reasonText'
     WHERE id = p_approval_id RETURNING * INTO v_row;
  ELSE
    RAISE EXCEPTION 'decision is approve or decline' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'approval.' || p_decision || 'd', 'second_person_approval', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- The requester withdraws a request or approval that has not been used.
CREATE FUNCTION trustwork.admin_withdraw_approval(p_approval_id uuid) RETURNS trustwork.second_person_approval
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_row trustwork.second_person_approval%ROWTYPE;
BEGIN
  UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_person
   WHERE id = p_approval_id AND requested_by = v_person AND status IN ('pending', 'approved') RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open request of the caller' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN v_row;
END $$;

-- Execute under an approval: only the requester, the exact action, scope and digest, unexpired, exactly once.
-- Other modules call it from their own commands (for example a price activation) and pass what they executed.
CREATE FUNCTION trustwork.admin_consume_approval(p_approval_id uuid, p_action text, p_scope_kind text, p_node uuid, p_hub uuid, p_action_digest text, p_ref uuid)
RETURNS trustwork.second_person_approval
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_target record;
  v_before trustwork.second_person_approval%ROWTYPE;
  v_row trustwork.second_person_approval%ROWTYPE;
BEGIN
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  SELECT * INTO v_before FROM trustwork.second_person_approval WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND OR v_before.requested_by <> v_person THEN
    RAISE EXCEPTION 'only the requester executes an approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.not_requester';
  END IF;
  IF v_before.status <> 'approved' THEN
    RAISE EXCEPTION 'the approval is %', v_before.status USING ERRCODE = 'check_violation',
      HINT = CASE WHEN v_before.status = 'consumed' THEN 'admin.approval_consumed' ELSE 'admin.approval_not_approved' END;
  END IF;
  IF v_before.expires_at <= now() THEN
    RAISE EXCEPTION 'the approval expired' USING ERRCODE = 'check_violation', HINT = 'admin.approval_expired';
  END IF;
  IF v_before.action <> p_action OR v_before.scope_kind <> p_scope_kind OR v_before.node_id IS DISTINCT FROM v_target.node OR v_before.hub_id IS DISTINCT FROM v_target.hub
     OR v_before.action_digest IS DISTINCT FROM p_action_digest THEN
    RAISE EXCEPTION 'the approval binds another action, scope or digest' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;
  IF p_ref IS NULL THEN
    RAISE EXCEPTION 'consumption records what was executed' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  UPDATE trustwork.second_person_approval SET status = 'consumed', consumed_ref = p_ref, consumed_at = now() WHERE id = p_approval_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Staff assignment by a staff administrator; sensitive and break-glass roles consume an approval of this exact
-- assignment (admin_assignment_digest). p_valid_for NULL = open-ended (never for break-glass).
CREATE FUNCTION trustwork.admin_assign_role(p_ctx jsonb, p_person uuid, p_role text, p_scope_kind text, p_node uuid, p_hub uuid, p_definition_version integer,
  p_valid_for interval DEFAULT NULL, p_breakglass boolean DEFAULT false, p_incident uuid DEFAULT NULL, p_approval_id uuid DEFAULT NULL)
RETURNS trustwork.staff_role_assignment
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_target record;
  v_actor trustwork.admin_actor;
  v_id uuid := trustwork.new_uuid();
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_action text;
  v_seconds bigint;
  v_row trustwork.staff_role_assignment%ROWTYPE;
BEGIN
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY[CASE WHEN p_breakglass THEN 'admin.staff.breakglass' ELSE 'admin.staff.assign' END], v_target.node, v_target.hub);
  IF p_person = v_actor.person_id THEN
    RAISE EXCEPTION 'nobody grants a staff role to themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_grant';
  END IF;
  IF NOT trustwork.admin_role_allowed_in_scope(p_role, p_scope_kind) THEN
    RAISE EXCEPTION 'role % cannot be held at scope %', p_role, p_scope_kind USING ERRCODE = 'check_violation', HINT = 'admin.role_scope';
  END IF;
  IF p_breakglass AND (p_valid_for IS NULL OR p_valid_for > interval '12 hours') THEN
    RAISE EXCEPTION 'break-glass lasts at most 12 hours' USING ERRCODE = 'check_violation', HINT = 'admin.breakglass_too_long';
  END IF;
  IF p_valid_for IS NOT NULL AND p_valid_for <= interval '0' THEN
    RAISE EXCEPTION 'validity must be positive' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  v_seconds := CASE WHEN p_valid_for IS NULL THEN NULL ELSE round(extract(epoch FROM p_valid_for))::bigint END;
  IF p_role = ANY (trustwork.admin_sensitive_roles()) OR p_breakglass THEN
    v_action := CASE WHEN p_breakglass THEN 'staff.grant_breakglass' ELSE 'staff.assign_sensitive_role' END;
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'sensitive and break-glass roles need a second-person approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval_id, v_action, p_scope_kind, p_node, p_hub,
      trustwork.admin_assignment_digest(v_action, p_person, p_role, p_scope_kind, v_target.node, v_target.hub, p_definition_version, p_breakglass, p_incident, v_seconds), v_id);
    IF v_approval.approved_by = p_person THEN
      RAISE EXCEPTION 'the holder cannot be the second approver' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
    END IF;
  END IF;
  INSERT INTO trustwork.staff_role_assignment (id, person_id, role, scope_kind, node_id, hub_id, definition_version, granted_by, approved_by, approval_id, reason,
    breakglass, incident_id, valid_from, valid_until)
  VALUES (v_id, p_person, p_role, p_scope_kind, v_target.node, v_target.hub, p_definition_version, v_actor.person_id, v_approval.approved_by, v_approval.id,
    p_ctx ->> 'reasonText', p_breakglass, p_incident, now(), CASE WHEN p_valid_for IS NULL THEN NULL ELSE now() + make_interval(secs => v_seconds) END)
  RETURNING * INTO v_row;
  IF p_breakglass THEN
    UPDATE trustwork.incident SET linked_actions = linked_actions || jsonb_build_array(jsonb_build_object('kind', 'breakglass', 'assignmentId', v_id::text))
     WHERE id = p_incident;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, coalesce(v_action, 'staff.assign_role'), 'staff_role_assignment', v_id, NULL, to_jsonb(v_row),
    NULL, v_approval.id);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.admin_revoke_role(p_ctx jsonb, p_assignment_id uuid) RETURNS trustwork.staff_role_assignment
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_role_assignment%ROWTYPE;
  v_row trustwork.staff_role_assignment%ROWTYPE;
  v_target record;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_role_assignment WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such assignment' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(v_before.scope_kind, v_before.node_id, v_before.hub_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF v_before.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'already revoked' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.staff_role_assignment SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText'
   WHERE id = p_assignment_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.revoke_role', 'staff_role_assignment', p_assignment_id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Staff declare their own conflicts (no elevation needed: declaring narrows what they may do).
CREATE FUNCTION trustwork.admin_declare_conflict(p_conflict_person uuid, p_conflict_company uuid, p_reason text) RETURNS trustwork.staff_conflict_declaration
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.staff_conflict_declaration%ROWTYPE;
BEGIN
  INSERT INTO trustwork.staff_conflict_declaration (staff_person_id, conflict_person_id, conflict_company_id, reason)
  VALUES (trustwork.admin_require_caller(), p_conflict_person, p_conflict_company, p_reason) RETURNING * INTO v_row;
  RETURN v_row;
END $$;
-- Ending a declaration widens what someone may do, so it is a recorded staff action under admin.staff.conflict.declare
-- (held at any scope; the audit row carries that scope).
CREATE FUNCTION trustwork.admin_end_conflict(p_ctx jsonb, p_declaration_id uuid) RETURNS trustwork.staff_conflict_declaration
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_person uuid := trustwork.current_person_id();
  v_held record;
  v_before trustwork.staff_conflict_declaration%ROWTYPE;
  v_row trustwork.staff_conflict_declaration%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_conflict_declaration WHERE id = p_declaration_id AND staff_person_id = v_person AND ended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live declaration of the caller' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT a.role, a.breakglass, a.node_id, a.hub_id INTO v_held FROM trustwork.staff_role_assignment a
    JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
   WHERE a.person_id = v_person AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
     AND 'admin.staff.conflict.declare' = ANY (d.permissions) AND a.scope_kind = ANY (d.scopes)
   ORDER BY a.breakglass LIMIT 1;
  IF v_held.role IS NULL THEN
    RAISE EXCEPTION 'admin.staff.conflict.declare is not held' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  UPDATE trustwork.staff_conflict_declaration SET ended_at = now() WHERE id = p_declaration_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(ROW(v_person, v_held.role, v_held.breakglass, v_elevation, 'admin.staff.conflict.declare')::trustwork.admin_actor, p_ctx,
    v_held.node_id, v_held.hub_id, 'staff.end_conflict', 'staff_conflict_declaration', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Incidents: opened with admin.incident.open at the hub or the node.
CREATE FUNCTION trustwork.admin_open_incident(p_ctx jsonb, p_node uuid, p_hub uuid, p_kind text, p_severity text, p_title text, p_notification_deadline timestamptz DEFAULT NULL)
RETURNS trustwork.incident
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.incident.open'], v_node, p_hub);
  v_row trustwork.incident%ROWTYPE;
BEGIN
  INSERT INTO trustwork.incident (scope_kind, node_id, hub_id, kind, severity, title, notification_deadline, opened_by)
  VALUES (CASE WHEN p_hub IS NULL THEN 'node' ELSE 'hub' END, v_node, p_hub, p_kind, p_severity, p_title, p_notification_deadline, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'incident.open', 'incident', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;
-- Status changes and links: mitigated/resolved with admin.incident.open; closing needs admin.incident.review and a
-- post-incident review reference.
CREATE FUNCTION trustwork.admin_update_incident(p_ctx jsonb, p_incident_id uuid, p_status text, p_post_review_ref text DEFAULT NULL, p_link jsonb DEFAULT NULL)
RETURNS trustwork.incident
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.incident%ROWTYPE;
  v_row trustwork.incident%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.incident WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such incident' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY[CASE WHEN p_status = 'closed' THEN 'admin.incident.review' ELSE 'admin.incident.open' END], v_before.node_id, v_before.hub_id);
  IF p_status IS NULL OR p_status NOT IN ('open', 'mitigated', 'resolved', 'closed') OR (p_status = 'open' AND v_before.status <> 'open') THEN
    RAISE EXCEPTION 'incident % -> % is not allowed', v_before.status, p_status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.incident SET status = p_status, post_review_ref = coalesce(p_post_review_ref, post_review_ref),
         closed_by = CASE WHEN p_status = 'closed' THEN v_actor.person_id END,
         linked_actions = CASE WHEN p_link IS NULL THEN linked_actions ELSE linked_actions || jsonb_build_array(p_link) END
   WHERE id = p_incident_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'incident.' || p_status, 'incident', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 10. Row-level security and grants ------------------------------------------------------------------------------------
ALTER TABLE trustwork.admin_node ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admin_node FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_role_definition_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_role_definition_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.incident FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_person_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_person_approval FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_role_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_conflict_declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_conflict_declaration FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admin_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admin_sequence FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admin_audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admin_audit_event FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.admin_node AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_role_definition_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.incident AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.second_person_approval AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_role_assignment AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_conflict_declaration AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.admin_sequence AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.admin_audit_event AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Runtime reads. Staff see what their permissions cover; people see their own staff rows. No policy reads private
-- customer data: these tables hold staff configuration, decisions and digests.
CREATE POLICY admin_node_read ON trustwork.admin_node FOR SELECT TO trustwork_app USING (true);
CREATE POLICY staff_role_definition_read ON trustwork.staff_role_definition_version FOR SELECT TO trustwork_app USING (trustwork.current_person_id() IS NOT NULL);
CREATE POLICY staff_role_assignment_read ON trustwork.staff_role_assignment FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
CREATE POLICY staff_conflict_declaration_read ON trustwork.staff_conflict_declaration FOR SELECT TO trustwork_app
  USING (staff_person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.staff.read', NULL, NULL));
CREATE POLICY second_person_approval_read ON trustwork.second_person_approval FOR SELECT TO trustwork_app
  USING (requested_by = trustwork.current_person_id() OR approved_by = trustwork.current_person_id()
         OR trustwork.admin_has_any_permission(ARRAY['admin.staff.read', 'admin.audit.read'], node_id, hub_id)
         OR (status = 'pending' AND trustwork.admin_has_any_permission(trustwork.admin_action_permissions(action), node_id, hub_id)));
CREATE POLICY incident_read ON trustwork.incident FOR SELECT TO trustwork_app
  USING (trustwork.admin_has_any_permission(ARRAY['admin.incident.open', 'admin.incident.preserve', 'admin.incident.review', 'admin.observability.read'], node_id, hub_id));
CREATE POLICY admin_audit_event_read ON trustwork.admin_audit_event FOR SELECT TO trustwork_app
  USING (actor_person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.audit.read', node_id, hub_id));
-- Insert-only for the runtime role: the actor is the caller, holds the recorded role at a covering scope and owns the
-- elevation (denied and failed attempts are recorded this way by the application, in their own transaction).
CREATE POLICY admin_audit_event_insert ON trustwork.admin_audit_event FOR INSERT TO trustwork_app
  WITH CHECK (actor_person_id = trustwork.current_person_id() AND trustwork.admin_may_audit(actor_role, node_id, hub_id, session_elevation_id));

GRANT SELECT ON trustwork.admin_node, trustwork.staff_role_definition_version, trustwork.staff_role_assignment, trustwork.staff_conflict_declaration,
  trustwork.second_person_approval, trustwork.incident, trustwork.admin_audit_event TO trustwork_app;
GRANT INSERT (actor_person_id, actor_role, scope_kind, node_id, hub_id, permission, session_elevation_id, breakglass, case_id, second_approver_person_id, approval_id,
  approval_digest, action, object_type, object_id, object_revision_before, object_revision_after, before_digest, after_digest, reason_code, reason_text, outcome, request_id,
  client_fingerprint_hash, retention_class) ON trustwork.admin_audit_event TO trustwork_app;

GRANT EXECUTE ON FUNCTION trustwork.admin_staff_roles(), trustwork.admin_sensitive_roles(), trustwork.admin_role_allowed_in_scope(text, text),
  trustwork.admin_node_only_permissions(), trustwork.admin_second_person_actions(), trustwork.admin_action_permissions(text), trustwork.admin_all_match(text[], text), trustwork.admin_distinct(anyarray),
  trustwork.admin_canonical_json(jsonb), trustwork.admin_digest(jsonb), trustwork.admin_scope_json(text, uuid, uuid), trustwork.admin_scope_kind(uuid, uuid),
  trustwork.admin_assignment_digest(text, uuid, text, text, uuid, uuid, integer, boolean, uuid, bigint),
  trustwork.admin_has_permission(text, uuid, uuid), trustwork.admin_has_any_permission(text[], uuid, uuid), trustwork.admin_may_audit(text, uuid, uuid, uuid),
  trustwork.admin_request_approval(jsonb, text, text, uuid, uuid, text), trustwork.admin_decide_approval(jsonb, uuid, text, text, interval),
  trustwork.admin_withdraw_approval(uuid), trustwork.admin_consume_approval(uuid, text, text, uuid, uuid, text, uuid),
  trustwork.admin_assign_role(jsonb, uuid, text, text, uuid, uuid, integer, interval, boolean, uuid, uuid), trustwork.admin_revoke_role(jsonb, uuid),
  trustwork.admin_declare_conflict(uuid, uuid, text), trustwork.admin_end_conflict(jsonb, uuid),
  trustwork.admin_open_incident(jsonb, uuid, uuid, text, text, text, timestamptz), trustwork.admin_update_incident(jsonb, uuid, text, text, jsonb)
  TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

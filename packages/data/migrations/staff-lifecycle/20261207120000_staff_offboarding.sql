-- ADM-004 part 5: function accountability, guided offboarding, and the function position an invitation may name
-- (docs/engine/hub-console/console-design.md, section 4.2 "Separation of duties, conflicts and offboarding";
-- docs/engine/hub-operating-company.md, section 3.3 "Accountability rules"). Contract: packages/contracts/src/staff-lifecycle.ts.
--
-- Accountability: who answers for a function of the hub (its owner) or for one agent role within it. TEAM-001 and
-- AGT-030 bring the function catalogue, positions and the agent roles themselves; this slice holds the ledger they
-- write to, because offboarding must read it: nobody leaves while a function or an agent role has no accountable
-- person. Rules the schema holds (hub-operating-company.md, 3.3): exactly one open owner per function and one open
-- row per agent role; the holder is staff of the hub holding the role the function needs; when the holder loses that
-- role abruptly (revocation) the row is suspended at once and the hub owners are offered the accountability; an offer
-- is accepted by the person it names, never by anyone else; a role lost by the clock is read as suspended at every
-- request. Agents are never accountable: only people hold rows.
--
-- Offboarding: a staff administrator with admin.staff.revoke at a scope starts it for a person (never themselves), reads
-- the checklist (roles, eligible roles, activations, open approval requests, admin clients, accountabilities with the
-- fallback offers, open support cases and incidents to reassign, with suggested people chosen by role), and completes
-- it in one transaction: every role, eligible role and activation covered by the scope is revoked, every open approval
-- request of the person revoked, and nothing completes while an accountability is still open. Past actions stay
-- attributed. There is no admin-client table yet (console design 4.3 is not built); the checklist lists none.

-- 0. The function catalogue keys (TEAM-001 publishes the catalogue; the keys are fixed here so rows validate) --------
CREATE FUNCTION trustwork.staff_function_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['leadership', 'strategy', 'editorial', 'marketing', 'outreach_partnerships', 'community', 'sales', 'support', 'trust_safety', 'compliance', 'finance', 'legal',
    'people', 'quality', 'culture_ethics', 'research', 'events_learning', 'localisation', 'data_stewardship', 'it_operations', 'procurement', 'analytics', 'federation']::text[]
$$;

-- 1. Invitations may name a function position ------------------------------------------------------------------------
ALTER TABLE trustwork.staff_invitation
  ADD COLUMN function_key text NULL CHECK (function_key = ANY (trustwork.staff_function_keys())),
  ADD COLUMN function_title text NULL CHECK (length(function_title) BETWEEN 1 AND 100),
  ADD CONSTRAINT staff_invitation_function_shape CHECK (function_title IS NULL OR function_key IS NOT NULL);

CREATE OR REPLACE FUNCTION trustwork.staff_invitation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invitations are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'an invitation is born pending' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.role, NEW.definition_version, NEW.email_normalized, NEW.valid_for_seconds, NEW.sensitive,
         NEW.invited_by, NEW.reason, NEW.expires_at, NEW.created_at, NEW.function_key, NEW.function_title)
     IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.role, OLD.definition_version, OLD.email_normalized, OLD.valid_for_seconds, OLD.sensitive,
         OLD.invited_by, OLD.reason, OLD.expires_at, OLD.created_at, OLD.function_key, OLD.function_title) THEN
    RAISE EXCEPTION 'an invitation''s terms are immutable; invite again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.person_id IS NOT NULL AND NEW.person_id IS DISTINCT FROM OLD.person_id THEN
    RAISE EXCEPTION 'the invitee never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('accepted', 'declined', 'withdrawn'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('applied', 'withdrawn'))) THEN
    RAISE EXCEPTION 'invitation % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trustwork.staff_invitation_image(p staff_invitation) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'role', p.role, 'scope', trustwork.admin_scope_json(p.scope_kind, p.node_id, p.hub_id), 'definitionVersion', p.definition_version,
    'validForSeconds', p.valid_for_seconds, 'sensitive', p.sensitive, 'status', p.status, 'personId', p.person_id, 'approvalId', p.approval_id,
    'assignmentId', p.assignment_id, 'functionKey', p.function_key, 'revision', p.revision)
$$;

-- The invite command grows two optional parameters; the eight-parameter form is replaced.
DROP FUNCTION trustwork.staff_invite(jsonb, text, text, text, uuid, uuid, integer, bigint);
CREATE FUNCTION trustwork.staff_invite(p_ctx jsonb, p_email text, p_role text, p_scope_kind text, p_node uuid, p_hub uuid, p_definition_version integer,
  p_valid_for_seconds bigint, p_function_key text DEFAULT NULL, p_function_title text DEFAULT NULL) RETURNS trustwork.staff_invitation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_target record;
  v_actor trustwork.admin_actor;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_def trustwork.staff_role_definition_version%ROWTYPE;
  v_row trustwork.staff_invitation%ROWTYPE;
BEGIN
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], v_target.node, v_target.hub);
  IF v_email !~ '^[^@\s]+@[^@\s]+$' OR length(v_email) > 254 THEN
    RAISE EXCEPTION 'an e-mail address is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = v_actor.person_id AND b.email_normalized = v_email) THEN
    RAISE EXCEPTION 'nobody invites themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_grant';
  END IF;
  SELECT * INTO v_def FROM trustwork.staff_role_definition_version WHERE role = p_role AND version = p_definition_version;
  IF NOT FOUND OR NOT (p_scope_kind = ANY (v_def.scopes)) OR NOT trustwork.admin_role_allowed_in_scope(p_role, p_scope_kind) THEN
    RAISE EXCEPTION 'the role is not held at this scope' USING ERRCODE = 'check_violation', HINT = 'admin.role_scope';
  END IF;
  IF p_function_key IS NOT NULL AND (p_scope_kind <> 'hub' OR NOT (p_function_key = ANY (trustwork.staff_function_keys()))) THEN
    RAISE EXCEPTION 'a function position belongs to a hub and names a function of the catalogue' USING ERRCODE = 'check_violation', HINT = 'admin.function_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_invitation i WHERE i.email_normalized = v_email AND i.role = p_role AND i.scope_kind = p_scope_kind
              AND coalesce(i.node_id, i.hub_id) IS NOT DISTINCT FROM coalesce(v_target.node, v_target.hub) AND i.status IN ('pending', 'accepted') AND i.expires_at > now()) THEN
    RAISE EXCEPTION 'an open invitation to this role exists' USING ERRCODE = 'unique_violation', HINT = 'admin.invitation_open';
  END IF;
  UPDATE trustwork.staff_invitation i SET status = 'withdrawn', withdrawn_by = v_actor.person_id
   WHERE i.email_normalized = v_email AND i.role = p_role AND i.scope_kind = p_scope_kind
     AND coalesce(i.node_id, i.hub_id) IS NOT DISTINCT FROM coalesce(v_target.node, v_target.hub) AND i.status IN ('pending', 'accepted') AND i.expires_at <= now();
  INSERT INTO trustwork.staff_invitation (scope_kind, node_id, hub_id, role, definition_version, email_normalized, valid_for_seconds, sensitive, invited_by, reason, expires_at, function_key, function_title)
  VALUES (p_scope_kind, v_target.node, v_target.hub, p_role, p_definition_version, v_email, p_valid_for_seconds, p_role = ANY (trustwork.admin_sensitive_roles()),
    v_actor.person_id, p_ctx ->> 'reasonText', now() + interval '7 days', p_function_key, p_function_title)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.invited', 'staff_invitation', v_row.id, NULL, trustwork.staff_invitation_image(v_row));
  RETURN v_row;
END $$;

-- The invitee's read grows the function position; a return type does not change in place.
DROP FUNCTION trustwork.staff_my_invitations();
CREATE FUNCTION trustwork.staff_my_invitations()
RETURNS TABLE (id uuid, role text, scope_kind text, node_id uuid, hub_id uuid, valid_for_seconds bigint, reason text, inviter_name text, expires_at timestamptz, status text,
  function_key text, function_title text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT i.id, i.role, i.scope_kind, i.node_id, i.hub_id, i.valid_for_seconds, i.reason, p.display_name, i.expires_at, i.status, i.function_key, i.function_title
    FROM trustwork.staff_invitation i
    JOIN trustwork.email_binding b ON b.email_normalized = i.email_normalized AND b.verified_at IS NOT NULL AND b.person_id = trustwork.current_person_id()
    JOIN trustwork.person p ON p.id = i.invited_by
   WHERE i.status = 'pending' AND i.expires_at > now()
   ORDER BY i.created_at DESC
$$;

-- 2. Accountability ----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.staff_accountability (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  function_key text NOT NULL CHECK (function_key = ANY (trustwork.staff_function_keys())),
  kind text NOT NULL CHECK (kind IN ('function_owner', 'agent_role')),
  agent_role_key text NULL CHECK (agent_role_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  required_role text NULL CHECK (required_role = ANY (trustwork.admin_staff_roles())),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  suspended_reason text NULL CHECK (suspended_reason IN ('holder_lost_role', 'offboarding')),
  assigned_by uuid NOT NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  predecessor_id uuid NULL REFERENCES trustwork.staff_accountability (id),
  ended_at timestamptz NULL,
  ended_by uuid NULL REFERENCES trustwork.person (id),
  end_reason text NULL CHECK (end_reason IN ('ended', 'handed_over')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_accountability_kind_shape CHECK ((kind = 'agent_role') = (agent_role_key IS NOT NULL)),
  CONSTRAINT staff_accountability_status_shape CHECK ((status = 'suspended') = (suspended_reason IS NOT NULL)
    AND (status = 'ended') = (ended_at IS NOT NULL) AND (ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX staff_accountability_owner_once ON trustwork.staff_accountability (hub_id, function_key) WHERE kind = 'function_owner' AND status <> 'ended';
CREATE UNIQUE INDEX staff_accountability_agent_role_once ON trustwork.staff_accountability (hub_id, function_key, agent_role_key) WHERE kind = 'agent_role' AND status <> 'ended';
CREATE INDEX staff_accountability_person_idx ON trustwork.staff_accountability (person_id) WHERE status <> 'ended';

CREATE TABLE trustwork.staff_accountability_offer (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  accountability_id uuid NOT NULL REFERENCES trustwork.staff_accountability (id),
  to_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  offered_by uuid NOT NULL REFERENCES trustwork.person (id),
  offboarding_id uuid NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  decided_at timestamptz NULL,
  successor_id uuid NULL REFERENCES trustwork.staff_accountability (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_accountability_offer_shape CHECK ((status = 'pending') = (decided_at IS NULL) AND (status = 'accepted') = (successor_id IS NOT NULL))
);
CREATE UNIQUE INDEX staff_accountability_offer_open_once ON trustwork.staff_accountability_offer (accountability_id, to_person_id) WHERE status = 'pending';
CREATE INDEX staff_accountability_offer_to_idx ON trustwork.staff_accountability_offer (to_person_id) WHERE status = 'pending';

CREATE FUNCTION trustwork.staff_accountability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accountability is never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'accountability is born active' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hub_id, NEW.function_key, NEW.kind, NEW.agent_role_key, NEW.person_id, NEW.required_role, NEW.assigned_by, NEW.reason, NEW.predecessor_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.function_key, OLD.kind, OLD.agent_role_key, OLD.person_id, OLD.required_role, OLD.assigned_by, OLD.reason, OLD.predecessor_id, OLD.created_at)
     OR OLD.status = 'ended' THEN
    RAISE EXCEPTION 'accountability only changes state; a hand-over is a new row' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status = 'ended' THEN
    NEW.ended_at := now();
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_accountability_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_accountability FOR EACH ROW EXECUTE FUNCTION trustwork.staff_accountability_guard();

CREATE FUNCTION trustwork.staff_accountability_offer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offers are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'an offer is born pending' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.accountability_id, NEW.to_person_id, NEW.offered_by, NEW.offboarding_id, NEW.reason, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.accountability_id, OLD.to_person_id, OLD.offered_by, OLD.offboarding_id, OLD.reason, OLD.created_at) OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'an offer is decided once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  NEW.decided_at := now();
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_accountability_offer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_accountability_offer FOR EACH ROW EXECUTE FUNCTION trustwork.staff_accountability_offer_guard();

CREATE FUNCTION trustwork.staff_accountability_image(p staff_accountability) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'hubId', p.hub_id, 'functionKey', p.function_key, 'kind', p.kind, 'agentRoleKey', p.agent_role_key, 'personId', p.person_id,
    'requiredRole', p.required_role, 'status', p.status, 'suspendedReason', p.suspended_reason, 'predecessorId', p.predecessor_id, 'endReason', p.end_reason, 'revision', p.revision)
$$;

-- Does the person hold what the accountability needs: the required role at the hub, or any staff role covering it?
CREATE FUNCTION trustwork.staff_accountability_holder_ok(p_person uuid, p_hub uuid, p_required_role text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_person_is_staff(p_person, NULL, p_hub, p_required_role)
$$;

-- The hub's fallback: people holding the hub's owner role (hub-owner), else the platform owners; never the holder.
CREATE FUNCTION trustwork.staff_hub_fallback_people(p_hub uuid, p_except uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  WITH owners AS (
    SELECT DISTINCT a.person_id FROM trustwork.staff_role_assignment a
     WHERE a.role = 'hub-owner' AND a.hub_id = p_hub AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now()) AND a.person_id <> p_except
  ), platform AS (
    SELECT DISTINCT a.person_id FROM trustwork.staff_role_assignment a
     WHERE a.role = 'platform-owner' AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now()) AND a.person_id <> p_except
  )
  SELECT person_id FROM owners
  UNION ALL
  SELECT person_id FROM platform WHERE NOT EXISTS (SELECT 1 FROM owners)
$$;

-- Offers one accountability to the hub's fallback people (where no offer is pending for them yet).
CREATE FUNCTION trustwork.staff_accountability_offer_fallback(p_row staff_accountability, p_offered_by uuid, p_offboarding uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO trustwork.staff_accountability_offer (accountability_id, to_person_id, offered_by, offboarding_id, reason)
  SELECT p_row.id, f, p_offered_by, p_offboarding, p_reason FROM trustwork.staff_hub_fallback_people(p_row.hub_id, p_row.person_id) f
   WHERE NOT EXISTS (SELECT 1 FROM trustwork.staff_accountability_offer o WHERE o.accountability_id = p_row.id AND o.to_person_id = f AND o.status = 'pending');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- 2a. Assign (admin.staff.assign at the hub). The holder may be the actor: the operator answers for every function at first.
CREATE FUNCTION trustwork.staff_accountability_assign(p_ctx jsonb, p_hub uuid, p_function_key text, p_kind text, p_agent_role_key text, p_person uuid, p_required_role text)
RETURNS trustwork.staff_accountability
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_accountability%ROWTYPE;
BEGIN
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], NULL, p_hub);
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_kind NOT IN ('function_owner', 'agent_role') OR (p_kind = 'agent_role') <> (p_agent_role_key IS NOT NULL) OR NOT (p_function_key = ANY (trustwork.staff_function_keys())) THEN
    RAISE EXCEPTION 'accountability names a function and either its owner or one agent role' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.function_invalid';
  END IF;
  IF NOT trustwork.staff_accountability_holder_ok(p_person, p_hub, p_required_role) THEN
    RAISE EXCEPTION 'the accountable person is staff of the hub holding the role the function needs' USING ERRCODE = 'check_violation', HINT = 'admin.accountable_without_role';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_accountability a WHERE a.hub_id = p_hub AND a.function_key = p_function_key AND a.kind = p_kind
              AND a.agent_role_key IS NOT DISTINCT FROM p_agent_role_key AND a.status <> 'ended') THEN
    RAISE EXCEPTION 'someone is accountable already; hand it over instead' USING ERRCODE = 'unique_violation', HINT = 'admin.accountability_open';
  END IF;
  INSERT INTO trustwork.staff_accountability (hub_id, function_key, kind, agent_role_key, person_id, required_role, assigned_by, reason)
  VALUES (p_hub, p_function_key, p_kind, p_agent_role_key, p_person, p_required_role, v_actor.person_id, p_ctx ->> 'reasonText') RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'staff.accountability_assigned', 'staff_accountability', v_row.id, NULL, trustwork.staff_accountability_image(v_row));
  RETURN v_row;
END $$;

-- 2b. End (admin.staff.assign at the hub): the function has no accountable person afterwards; its agents stay suspended.
CREATE FUNCTION trustwork.staff_accountability_end(p_ctx jsonb, p_id uuid) RETURNS trustwork.staff_accountability
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.staff_accountability%ROWTYPE;
  v_row trustwork.staff_accountability%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_accountability WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such accountability' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], NULL, v_before.hub_id);
  IF v_before.status = 'ended' THEN
    RAISE EXCEPTION 'already ended' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.staff_accountability_offer SET status = 'withdrawn' WHERE accountability_id = v_before.id AND status = 'pending';
  UPDATE trustwork.staff_accountability SET status = 'ended', suspended_reason = NULL, ended_at = now(), ended_by = v_actor.person_id, end_reason = 'ended' WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'staff.accountability_ended', 'staff_accountability', v_row.id,
    trustwork.staff_accountability_image(v_before), trustwork.staff_accountability_image(v_row));
  RETURN v_row;
END $$;

-- 2c. Resume a suspended accountability once the holder holds the role again (admin.staff.assign at the hub).
CREATE FUNCTION trustwork.staff_accountability_resume(p_ctx jsonb, p_id uuid) RETURNS trustwork.staff_accountability
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.staff_accountability%ROWTYPE;
  v_row trustwork.staff_accountability%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_accountability WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such accountability' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], NULL, v_before.hub_id);
  IF v_before.status <> 'suspended' THEN
    RAISE EXCEPTION 'the accountability is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NOT trustwork.staff_accountability_holder_ok(v_before.person_id, v_before.hub_id, v_before.required_role) THEN
    RAISE EXCEPTION 'the accountable person is staff of the hub holding the role the function needs' USING ERRCODE = 'check_violation', HINT = 'admin.accountable_without_role';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_offboarding o WHERE o.person_id = v_before.person_id AND o.status = 'open') THEN
    RAISE EXCEPTION 'the person is being offboarded' USING ERRCODE = 'check_violation', HINT = 'admin.offboarding_open';
  END IF;
  UPDATE trustwork.staff_accountability_offer SET status = 'withdrawn' WHERE accountability_id = v_before.id AND status = 'pending';
  UPDATE trustwork.staff_accountability SET status = 'active', suspended_reason = NULL WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'staff.accountability_resumed', 'staff_accountability', v_row.id,
    trustwork.staff_accountability_image(v_before), trustwork.staff_accountability_image(v_row));
  RETURN v_row;
END $$;

-- 2d. Offer a hand-over to a named person (admin.staff.assign at the hub, or the current holder in an elevated session).
CREATE FUNCTION trustwork.staff_accountability_offer(p_ctx jsonb, p_id uuid, p_to_person uuid) RETURNS trustwork.staff_accountability_offer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_accountability%ROWTYPE;
  v_offer trustwork.staff_accountability_offer%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.staff_accountability WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such accountability' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_row.person_id = v_person THEN
    v_actor := trustwork.staff_own_actor(v_person, v_elevation, NULL, v_row.hub_id, coalesce(v_row.required_role, 'hub-owner'));
  ELSE
    v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], NULL, v_row.hub_id);
  END IF;
  IF v_row.status = 'ended' THEN
    RAISE EXCEPTION 'the accountability has ended' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_to_person = v_row.person_id THEN
    RAISE EXCEPTION 'the holder cannot be offered their own accountability' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  -- A hand-over goes to staff of the hub; until they hold the role the function needs the row reads as suspended.
  IF NOT trustwork.admin_person_is_staff(p_to_person, NULL, v_row.hub_id) THEN
    RAISE EXCEPTION 'the accountable person is staff of the hub' USING ERRCODE = 'check_violation', HINT = 'admin.accountable_without_role';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_accountability_offer o WHERE o.accountability_id = v_row.id AND o.to_person_id = p_to_person AND o.status = 'pending') THEN
    RAISE EXCEPTION 'an offer to this person is pending' USING ERRCODE = 'unique_violation', HINT = 'admin.offer_open';
  END IF;
  INSERT INTO trustwork.staff_accountability_offer (accountability_id, to_person_id, offered_by, reason) VALUES (v_row.id, p_to_person, v_person, p_ctx ->> 'reasonText') RETURNING * INTO v_offer;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'staff.accountability_offered', 'staff_accountability_offer', v_offer.id, NULL, to_jsonb(v_offer));
  RETURN v_offer;
END $$;

-- 2e. The person named accepts or declines. Acceptance is their own act, recorded on the offer and the new row (like
-- accepting an invitation); it ends the predecessor's row as handed over and withdraws every other pending offer.
CREATE FUNCTION trustwork.staff_accountability_respond(p_ctx jsonb, p_offer uuid, p_accept boolean, OUT offer trustwork.staff_accountability_offer, OUT accountability trustwork.staff_accountability)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_offer trustwork.staff_accountability_offer%ROWTYPE;
  v_before trustwork.staff_accountability%ROWTYPE;
  v_new trustwork.staff_accountability%ROWTYPE;
BEGIN
  SELECT * INTO v_offer FROM trustwork.staff_accountability_offer WHERE id = p_offer AND to_person_id = v_person FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such offer' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'the offer is %', v_offer.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  SELECT * INTO v_before FROM trustwork.staff_accountability WHERE id = v_offer.accountability_id FOR UPDATE;
  IF NOT p_accept THEN
    UPDATE trustwork.staff_accountability_offer SET status = 'declined' WHERE id = v_offer.id RETURNING * INTO v_offer;
    offer := v_offer;
    accountability := v_before;
    RETURN;
  END IF;
  IF v_before.status = 'ended' THEN
    RAISE EXCEPTION 'the accountability has ended' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  -- The fallback must be able to accept in an emergency: staff of the hub suffices; without the role the function needs
  -- the new row reads as suspended until the role is held (the reads evaluate staff_accountability_holder_ok).
  IF NOT trustwork.admin_person_is_staff(v_person, NULL, v_before.hub_id) THEN
    RAISE EXCEPTION 'the accountable person is staff of the hub' USING ERRCODE = 'check_violation', HINT = 'admin.accountable_without_role';
  END IF;
  UPDATE trustwork.staff_accountability SET status = 'ended', suspended_reason = NULL, ended_at = now(), ended_by = v_person, end_reason = 'handed_over' WHERE id = v_before.id;
  INSERT INTO trustwork.staff_accountability (hub_id, function_key, kind, agent_role_key, person_id, required_role, assigned_by, reason, predecessor_id)
  VALUES (v_before.hub_id, v_before.function_key, v_before.kind, v_before.agent_role_key, v_person, v_before.required_role, v_offer.offered_by, v_offer.reason, v_before.id)
  RETURNING * INTO v_new;
  UPDATE trustwork.staff_accountability_offer SET status = 'accepted', successor_id = v_new.id WHERE id = v_offer.id RETURNING * INTO v_offer;
  UPDATE trustwork.staff_accountability_offer SET status = 'withdrawn' WHERE accountability_id = v_before.id AND status = 'pending';
  offer := v_offer;
  accountability := v_new;
END $$;

-- 2f. Abrupt role loss: when a revocation leaves the holder without the role a function needs, its accountability is
-- suspended at once and the hub's fallback people are offered it. (A role that ends by the clock is read as suspended
-- at every request: staff_accountability_holder_ok is evaluated in the reads.)
CREATE FUNCTION trustwork.staff_accountability_assignment_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.staff_accountability%ROWTYPE;
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RETURN NULL;
  END IF;
  FOR v_row IN SELECT * FROM trustwork.staff_accountability a WHERE a.person_id = NEW.person_id AND a.status = 'active' FOR UPDATE LOOP
    IF NOT trustwork.staff_accountability_holder_ok(v_row.person_id, v_row.hub_id, v_row.required_role) THEN
      UPDATE trustwork.staff_accountability SET status = 'suspended', suspended_reason = 'holder_lost_role' WHERE id = v_row.id;
      PERFORM trustwork.staff_accountability_offer_fallback(v_row, NEW.revoked_by, NULL, coalesce(NEW.revoke_reason, 'Role revoked'));
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER staff_accountability_assignment_revoked AFTER UPDATE ON trustwork.staff_role_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.staff_accountability_assignment_revoked();

-- 3. Offboarding --------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.staff_offboarding (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  started_by uuid NOT NULL REFERENCES trustwork.person (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  completed_at timestamptz NULL,
  completed_by uuid NULL REFERENCES trustwork.person (id),
  cancelled_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_offboarding_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT staff_offboarding_not_self CHECK (started_by <> person_id),
  CONSTRAINT staff_offboarding_status_shape CHECK ((status = 'completed') = (completed_at IS NOT NULL) AND (completed_at IS NULL) = (completed_by IS NULL) AND (status = 'cancelled') = (cancelled_by IS NOT NULL))
);
CREATE UNIQUE INDEX staff_offboarding_open_once ON trustwork.staff_offboarding (person_id) WHERE status = 'open';
ALTER TABLE trustwork.staff_accountability_offer ADD CONSTRAINT staff_accountability_offer_offboarding FOREIGN KEY (offboarding_id) REFERENCES trustwork.staff_offboarding (id);

CREATE FUNCTION trustwork.staff_offboarding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offboardings are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'an offboarding is born open' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.person_id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.reason, NEW.started_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.person_id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.reason, OLD.started_by, OLD.created_at) OR OLD.status <> 'open' THEN
    RAISE EXCEPTION 'an offboarding is completed or cancelled once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status = 'completed' THEN
    NEW.completed_at := now();
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_offboarding_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_offboarding FOR EACH ROW EXECUTE FUNCTION trustwork.staff_offboarding_guard();

CREATE FUNCTION trustwork.staff_offboarding_image(p staff_offboarding) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'personId', p.person_id, 'scope', trustwork.admin_scope_json(p.scope_kind, p.node_id, p.hub_id), 'startedBy', p.started_by,
    'status', p.status, 'completedBy', p.completed_by, 'cancelledBy', p.cancelled_by, 'revision', p.revision)
$$;

-- Does the offboarding's scope cover an assignment or hub row? platform: all; node: the node and every hub; hub: that hub.
CREATE FUNCTION trustwork.staff_offboarding_covers(p_scope_kind text, p_node uuid, p_hub uuid, p_row_kind text, p_row_node uuid, p_row_hub uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_scope_kind WHEN 'platform' THEN true WHEN 'node' THEN p_row_kind = 'hub' OR (p_row_kind = 'node' AND p_row_node = p_node)
    ELSE p_row_kind = 'hub' AND p_row_hub = p_hub END
$$;

-- 3a. Start (admin.staff.revoke at the scope, never for oneself); offers every open accountability of the person to the fallback.
CREATE FUNCTION trustwork.staff_offboarding_start(p_ctx jsonb, p_person uuid, p_scope_kind text, p_node uuid, p_hub uuid) RETURNS trustwork.staff_offboarding
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_target record;
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_offboarding%ROWTYPE;
  v_acc trustwork.staff_accountability%ROWTYPE;
BEGIN
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF p_person = v_actor.person_id THEN
    RAISE EXCEPTION 'nobody offboards themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_offboarding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.staff_role_assignment a WHERE a.person_id = p_person AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
                   AND trustwork.staff_offboarding_covers(p_scope_kind, v_target.node, v_target.hub, a.scope_kind, a.node_id, a.hub_id))
     AND NOT EXISTS (SELECT 1 FROM trustwork.staff_accountability a WHERE a.person_id = p_person AND a.status <> 'ended'
                   AND trustwork.staff_offboarding_covers(p_scope_kind, v_target.node, v_target.hub, 'hub', NULL, a.hub_id)) THEN
    RAISE EXCEPTION 'no such staff member at this scope' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_offboarding o WHERE o.person_id = p_person AND o.status = 'open') THEN
    RAISE EXCEPTION 'an offboarding of this person is open' USING ERRCODE = 'unique_violation', HINT = 'admin.offboarding_open';
  END IF;
  INSERT INTO trustwork.staff_offboarding (person_id, scope_kind, node_id, hub_id, reason, started_by)
  VALUES (p_person, p_scope_kind, v_target.node, v_target.hub, p_ctx ->> 'reasonText', v_actor.person_id) RETURNING * INTO v_row;
  FOR v_acc IN SELECT * FROM trustwork.staff_accountability a WHERE a.person_id = p_person AND a.status <> 'ended'
                 AND trustwork.staff_offboarding_covers(p_scope_kind, v_target.node, v_target.hub, 'hub', NULL, a.hub_id) FOR UPDATE LOOP
    PERFORM trustwork.staff_accountability_offer_fallback(v_acc, v_actor.person_id, v_row.id, p_ctx ->> 'reasonText');
  END LOOP;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.offboarding_started', 'staff_offboarding', v_row.id, NULL, trustwork.staff_offboarding_image(v_row));
  RETURN v_row;
END $$;

-- 3b. The checklist (admin.staff.read at the scope): what completion will revoke, what blocks it, and the open work to
-- reassign with people suggested by role. Names only where the console needs a person to pick; never activity.
CREATE FUNCTION trustwork.staff_offboarding_checklist(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.staff_offboarding%ROWTYPE;
  v_target record;
  v_caller uuid := trustwork.admin_require_caller();
BEGIN
  SELECT * INTO v_row FROM trustwork.staff_offboarding WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such offboarding' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(v_row.scope_kind, v_row.node_id, v_row.hub_id);
  IF (SELECT r.role FROM trustwork.admin_resolve_permission(v_caller, 'admin.staff.read', v_target.node, v_target.hub) r) IS NULL THEN
    RAISE EXCEPTION 'no such offboarding' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN jsonb_build_object(
    'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('assignmentId', a.id, 'role', a.role, 'scope', trustwork.admin_scope_json(a.scope_kind, a.node_id, a.hub_id), 'breakglass', a.breakglass) ORDER BY a.role, a.id)
      FROM trustwork.staff_role_assignment a WHERE a.person_id = v_row.person_id AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, a.scope_kind, a.node_id, a.hub_id)), '[]'::jsonb),
    'eligibleRoles', coalesce((SELECT jsonb_agg(jsonb_build_object('eligibleRoleId', e.id, 'role', e.role, 'scope', trustwork.admin_scope_json(e.scope_kind, e.node_id, e.hub_id)) ORDER BY e.role, e.id)
      FROM trustwork.staff_eligible_role e WHERE e.person_id = v_row.person_id AND e.revoked_at IS NULL
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, e.scope_kind, e.node_id, e.hub_id)), '[]'::jsonb),
    'activations', coalesce((SELECT jsonb_agg(jsonb_build_object('activationId', x.id, 'role', x.role, 'status', x.status) ORDER BY x.created_at)
      FROM trustwork.staff_activation x LEFT JOIN trustwork.staff_role_assignment s ON s.id = x.assignment_id
      WHERE x.person_id = v_row.person_id AND (x.status = 'pending' OR (x.status = 'active' AND s.revoked_at IS NULL AND s.valid_until > now()))
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, x.scope_kind, x.node_id, x.hub_id)), '[]'::jsonb),
    'approvalRequests', coalesce((SELECT jsonb_agg(jsonb_build_object('approvalId', p.id, 'action', p.action, 'status', p.status) ORDER BY p.requested_at)
      FROM trustwork.second_person_approval p WHERE p.requested_by = v_row.person_id AND p.status IN ('pending', 'approved')
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, p.scope_kind, p.node_id, p.hub_id)), '[]'::jsonb),
    'adminClients', '[]'::jsonb,
    'accountabilities', coalesce((SELECT jsonb_agg(jsonb_build_object('accountabilityId', a.id, 'hubId', a.hub_id, 'functionKey', a.function_key, 'kind', a.kind, 'agentRoleKey', a.agent_role_key,
        'status', a.status, 'requiredRole', a.required_role,
        'offers', coalesce((SELECT jsonb_agg(jsonb_build_object('offerId', o.id, 'toPersonId', o.to_person_id, 'toPersonName', pp.display_name, 'status', o.status) ORDER BY pp.display_name)
          FROM trustwork.staff_accountability_offer o JOIN trustwork.person pp ON pp.id = o.to_person_id WHERE o.accountability_id = a.id AND o.status = 'pending'), '[]'::jsonb),
        'suggested', coalesce((SELECT jsonb_agg(jsonb_build_object('personId', f, 'displayName', pp.display_name) ORDER BY pp.display_name)
          FROM trustwork.staff_hub_fallback_people(a.hub_id, a.person_id) f JOIN trustwork.person pp ON pp.id = f), '[]'::jsonb)) ORDER BY a.function_key, a.kind, a.agent_role_key)
      FROM trustwork.staff_accountability a WHERE a.person_id = v_row.person_id AND a.status <> 'ended'
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, 'hub', NULL, a.hub_id)), '[]'::jsonb),
    'supportCases', coalesce((SELECT jsonb_agg(jsonb_build_object('caseId', c.id, 'hubId', c.hub_id, 'number', c.number::text, 'status', c.status,
        'suggested', coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('personId', s.person_id, 'displayName', pp.display_name))
          FROM trustwork.staff_role_assignment s JOIN trustwork.person pp ON pp.id = s.person_id
          WHERE s.role = 'support-lead' AND s.hub_id = c.hub_id AND s.person_id <> v_row.person_id AND s.revoked_at IS NULL AND (s.valid_until IS NULL OR s.valid_until > now())), '[]'::jsonb)) ORDER BY c.opened_at)
      FROM trustwork.support_case c WHERE c.assigned_to = v_row.person_id AND c.status NOT IN ('resolved', 'closed')
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, 'hub', NULL, c.hub_id)), '[]'::jsonb),
    'incidents', coalesce((SELECT jsonb_agg(jsonb_build_object('incidentId', i.id, 'scope', trustwork.admin_scope_json(i.scope_kind, i.node_id, i.hub_id), 'title', i.title, 'status', i.status,
        'suggested', coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('personId', s.person_id, 'displayName', pp.display_name))
          FROM trustwork.staff_role_assignment s JOIN trustwork.person pp ON pp.id = s.person_id
          WHERE s.role = 'ops-engineer' AND s.person_id <> v_row.person_id AND s.revoked_at IS NULL AND (s.valid_until IS NULL OR s.valid_until > now())
            AND CASE s.scope_kind WHEN 'platform' THEN true WHEN 'node' THEN true ELSE s.hub_id = i.hub_id END), '[]'::jsonb)) ORDER BY i.opened_at)
      FROM trustwork.incident i WHERE i.opened_by = v_row.person_id AND i.status IN ('open', 'mitigated')
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, i.scope_kind, i.node_id, i.hub_id)), '[]'::jsonb),
    'reviewItems', coalesce((SELECT jsonb_agg(jsonb_build_object('itemId', r.id, 'campaignId', r.campaign_id, 'role', r.role) ORDER BY r.created_at)
      FROM trustwork.staff_access_review_item r JOIN trustwork.staff_access_review_campaign cc ON cc.id = r.campaign_id
      WHERE r.holder_person_id = v_row.person_id AND r.verdict IS NULL AND cc.status = 'open'
        AND trustwork.staff_offboarding_covers(v_row.scope_kind, v_target.node, v_target.hub, r.scope_kind, r.node_id, r.hub_id)), '[]'::jsonb));
END $$;

-- 3c. Complete in one transaction, or refuse while an accountability of the person is still open at a covered hub.
CREATE FUNCTION trustwork.staff_offboarding_complete(p_ctx jsonb, p_id uuid) RETURNS trustwork.staff_offboarding
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_offboarding%ROWTYPE;
  v_row trustwork.staff_offboarding%ROWTYPE;
  v_target record;
  v_actor trustwork.admin_actor;
  v_blockers integer;
  v_act trustwork.staff_activation%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_offboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such offboarding' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(v_before.scope_kind, v_before.node_id, v_before.hub_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF v_before.status <> 'open' THEN
    RAISE EXCEPTION 'the offboarding is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  SELECT count(*) INTO v_blockers FROM trustwork.staff_accountability a WHERE a.person_id = v_before.person_id AND a.status <> 'ended'
    AND trustwork.staff_offboarding_covers(v_before.scope_kind, v_target.node, v_target.hub, 'hub', NULL, a.hub_id);
  IF v_blockers > 0 THEN
    RAISE EXCEPTION 'the person is still accountable for % function(s) or agent role(s); hand them over first', v_blockers USING ERRCODE = 'check_violation', HINT = 'admin.offboarding_blocked';
  END IF;
  -- Pending activations and open approval requests, then eligible roles, then every covered assignment (the ADM-001 and
  -- part 3 triggers end elevations, remaining eligible roles and activations when the last standing role goes).
  FOR v_act IN SELECT * FROM trustwork.staff_activation a WHERE a.person_id = v_before.person_id AND a.status = 'pending'
                 AND trustwork.staff_offboarding_covers(v_before.scope_kind, v_target.node, v_target.hub, a.scope_kind, a.node_id, a.hub_id) FOR UPDATE LOOP
    UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_actor.person_id WHERE id = v_act.approval_id AND status IN ('pending', 'approved');
    UPDATE trustwork.staff_activation SET status = 'withdrawn', withdrawn_by = v_actor.person_id WHERE id = v_act.id;
  END LOOP;
  UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_actor.person_id
   WHERE requested_by = v_before.person_id AND status IN ('pending', 'approved')
     AND trustwork.staff_offboarding_covers(v_before.scope_kind, v_target.node, v_target.hub, scope_kind, node_id, hub_id);
  UPDATE trustwork.staff_eligible_role SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText'
   WHERE person_id = v_before.person_id AND revoked_at IS NULL
     AND trustwork.staff_offboarding_covers(v_before.scope_kind, v_target.node, v_target.hub, scope_kind, node_id, hub_id);
  UPDATE trustwork.staff_role_assignment SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText'
   WHERE person_id = v_before.person_id AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now())
     AND trustwork.staff_offboarding_covers(v_before.scope_kind, v_target.node, v_target.hub, scope_kind, node_id, hub_id);
  UPDATE trustwork.staff_offboarding SET status = 'completed', completed_at = now(), completed_by = v_actor.person_id WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.offboarding_completed', 'staff_offboarding', v_row.id,
    trustwork.staff_offboarding_image(v_before), trustwork.staff_offboarding_image(v_row));
  RETURN v_row;
END $$;

-- 3d. Cancel: the offers it created are withdrawn; nothing else changed.
CREATE FUNCTION trustwork.staff_offboarding_cancel(p_ctx jsonb, p_id uuid) RETURNS trustwork.staff_offboarding
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_offboarding%ROWTYPE;
  v_row trustwork.staff_offboarding%ROWTYPE;
  v_target record;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_offboarding WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such offboarding' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(v_before.scope_kind, v_before.node_id, v_before.hub_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF v_before.status <> 'open' THEN
    RAISE EXCEPTION 'the offboarding is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.staff_accountability_offer SET status = 'withdrawn' WHERE offboarding_id = v_before.id AND status = 'pending';
  UPDATE trustwork.staff_offboarding SET status = 'cancelled', cancelled_by = v_actor.person_id WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.offboarding_cancelled', 'staff_offboarding', v_row.id,
    trustwork.staff_offboarding_image(v_before), trustwork.staff_offboarding_image(v_row));
  RETURN v_row;
END $$;

-- 4. Reads ---------------------------------------------------------------------------------------------------------------
-- Accountability rows with whether the holder holds the role now (a role lost by the clock reads as suspended).
CREATE FUNCTION trustwork.staff_accountabilities(p_hub uuid)
RETURNS TABLE (accountability trustwork.staff_accountability, holder_ok boolean, holder_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT a, trustwork.staff_accountability_holder_ok(a.person_id, a.hub_id, a.required_role), p.display_name
    FROM trustwork.staff_accountability a JOIN trustwork.person p ON p.id = a.person_id
   WHERE a.hub_id = p_hub AND (a.person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.staff.read', NULL, p_hub))
     AND trustwork.admin_person_is_staff(trustwork.current_person_id(), NULL, p_hub)
   ORDER BY a.function_key, a.kind, a.agent_role_key, a.created_at
$$;

ALTER TABLE trustwork.staff_accountability ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_accountability FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_accountability_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_accountability_offer FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_offboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_offboarding FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.staff_accountability AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_accountability_offer AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_offboarding AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY staff_accountability_read ON trustwork.staff_accountability FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.staff.read', NULL, hub_id));
-- An offer is read by the person it names and by staff who read the hub's staff.
CREATE POLICY staff_accountability_offer_read ON trustwork.staff_accountability_offer FOR SELECT TO trustwork_app
  USING (to_person_id = trustwork.current_person_id() OR EXISTS (SELECT 1 FROM trustwork.staff_accountability a WHERE a.id = accountability_id AND trustwork.admin_has_permission('admin.staff.read', NULL, a.hub_id)));
CREATE POLICY staff_offboarding_read ON trustwork.staff_offboarding FOR SELECT TO trustwork_app USING (trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
GRANT SELECT ON trustwork.staff_accountability, trustwork.staff_accountability_offer, trustwork.staff_offboarding TO trustwork_app;

REVOKE EXECUTE ON FUNCTION trustwork.staff_accountability_holder_ok(uuid, uuid, text), trustwork.staff_hub_fallback_people(uuid, uuid),
  trustwork.staff_accountability_offer_fallback(staff_accountability, uuid, uuid, text), trustwork.staff_offboarding_covers(text, uuid, uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.staff_invite(jsonb, text, text, text, uuid, uuid, integer, bigint, text, text), trustwork.staff_my_invitations(),
  trustwork.staff_accountability_assign(jsonb, uuid, text, text, text, uuid, text), trustwork.staff_accountability_end(jsonb, uuid), trustwork.staff_accountability_resume(jsonb, uuid),
  trustwork.staff_accountability_offer(jsonb, uuid, uuid), trustwork.staff_accountability_respond(jsonb, uuid, boolean), trustwork.staff_accountabilities(uuid),
  trustwork.staff_offboarding_start(jsonb, uuid, text, uuid, uuid), trustwork.staff_offboarding_checklist(uuid), trustwork.staff_offboarding_complete(jsonb, uuid),
  trustwork.staff_offboarding_cancel(jsonb, uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

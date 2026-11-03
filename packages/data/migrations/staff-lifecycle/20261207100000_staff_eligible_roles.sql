-- ADM-004 part 3: eligible roles activated just in time (docs/engine/hub-console/console-design.md, section 4.2
-- "Time-boxed roles and just-in-time elevation"). Contract: packages/contracts/src/staff-lifecycle.ts.
--
-- A role may be held as *eligible* instead of active. A staff administrator grants the eligibility (a standing
-- pre-authorization with a per-eligibility activation ceiling); the eligible person activates it for a bounded window
-- with a reason and a fresh second factor; a sensitive role additionally needs a second person; the role is then an
-- ordinary ADM-001 assignment from now until the window ends. Nothing has to run at the end of the window: the
-- assignment's valid_until is checked at every request, like every other assignment.
--
-- How the activation fits ADM-001's assignment guard without weakening it:
--   * the assignment names the eligibility's grantor as granted_by (the person who pre-authorized it; they must still
--     hold admin.staff.assign at the scope when the activation happens, or the eligibility is stale), so nobody ever
--     grants a role to themselves;
--   * a sensitive role consumes a second-person approval of exactly this assignment (role, scope, definition, window),
--     requested in the grantor's name by the activation and approved by a third person who is neither the holder nor
--     the grantor, holding admin.staff.assign at the scope; the guard recomputes the digest;
--   * the window is bounded three times: the eligibility's ceiling, the released definition's grant_max_hours, and the
--     break-glass limit of 12 hours (BREAKGLASS_MAX_HOURS);
--   * full separation-of-duties mode refuses a conflicting role at the grant of eligibility and again at activation.
--
-- The holder's own acts (request, early end) are audited with the actor's role covering the scope (or the eligible role
-- itself) under admin.session.elevate: an activation is the elevation of the session into a role. Revoking a person's
-- last standing role revokes their eligible roles, withdraws pending activations and ends active ones at once.

-- 1. Eligible roles -------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.staff_eligible_role (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  role text NOT NULL CHECK (role = ANY (trustwork.admin_staff_roles())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  definition_version integer NOT NULL,
  max_activation_seconds bigint NOT NULL CHECK (max_activation_seconds BETWEEN 60 AND 43200),
  granted_by uuid NOT NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  revoke_reason text NULL CHECK (length(revoke_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_eligible_role_definition FOREIGN KEY (role, definition_version) REFERENCES trustwork.staff_role_definition_version (role, version),
  CONSTRAINT staff_eligible_role_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT staff_eligible_role_role_scope CHECK (trustwork.admin_role_allowed_in_scope(role, scope_kind)),
  CONSTRAINT staff_eligible_role_not_self CHECK (granted_by <> person_id),
  CONSTRAINT staff_eligible_role_validity CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT staff_eligible_role_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX staff_eligible_role_open_once ON trustwork.staff_eligible_role
  (person_id, role, scope_kind, coalesce(node_id, hub_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;
CREATE INDEX staff_eligible_role_hub_idx ON trustwork.staff_eligible_role (hub_id) WHERE hub_id IS NOT NULL;

CREATE FUNCTION trustwork.staff_eligible_role_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'eligible roles are never deleted; revoke them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'an eligible role is born unrevoked' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    IF NEW.valid_from < now() THEN
      NEW.valid_from := now();
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.definition_version, NEW.max_activation_seconds, NEW.granted_by, NEW.reason,
         NEW.valid_from, NEW.valid_until, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.person_id, OLD.role, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.definition_version, OLD.max_activation_seconds, OLD.granted_by, OLD.reason,
         OLD.valid_from, OLD.valid_until, OLD.created_at)
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'an eligible role only changes by revocation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  NEW.revoked_at := now();
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_eligible_role_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_eligible_role FOR EACH ROW EXECUTE FUNCTION trustwork.staff_eligible_role_guard();

-- 2. Activations ----------------------------------------------------------------------------------------------------
-- pending -> active | declined | withdrawn. "active" is stored once; whether the window is still running, ended or was
-- revoked early is read from the assignment (never from a job).
CREATE TABLE trustwork.staff_activation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  eligible_role_id uuid NOT NULL REFERENCES trustwork.staff_eligible_role (id),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  role text NOT NULL CHECK (role = ANY (trustwork.admin_staff_roles())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  window_seconds bigint NOT NULL CHECK (window_seconds BETWEEN 60 AND 43200),
  sensitive boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  requested_elevation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'declined', 'withdrawn')),
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  assignment_id uuid NULL UNIQUE REFERENCES trustwork.staff_role_assignment (id),
  active_from timestamptz NULL,
  active_until timestamptz NULL,
  withdrawn_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_activation_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT staff_activation_second_person CHECK (NOT sensitive OR status <> 'active' OR approval_id IS NOT NULL),
  CONSTRAINT staff_activation_state_shape CHECK (
    (status = 'pending' AND assignment_id IS NULL AND active_from IS NULL AND decided_by IS NULL AND withdrawn_by IS NULL)
    OR (status = 'active' AND assignment_id IS NOT NULL AND active_from IS NOT NULL AND active_until IS NOT NULL AND withdrawn_by IS NULL
        AND active_until > active_from AND active_until <= active_from + interval '12 hours')
    OR (status = 'declined' AND assignment_id IS NULL AND decided_by IS NOT NULL AND withdrawn_by IS NULL)
    OR (status = 'withdrawn' AND assignment_id IS NULL AND withdrawn_by IS NOT NULL))
);
CREATE UNIQUE INDEX staff_activation_open_once ON trustwork.staff_activation (eligible_role_id) WHERE status = 'pending';
CREATE INDEX staff_activation_person_idx ON trustwork.staff_activation (person_id, created_at DESC);
CREATE INDEX staff_activation_hub_idx ON trustwork.staff_activation (hub_id, created_at DESC) WHERE hub_id IS NOT NULL;

CREATE FUNCTION trustwork.staff_activation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'activations are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'an activation is born pending' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.eligible_role_id, NEW.person_id, NEW.role, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.window_seconds, NEW.sensitive, NEW.reason,
         NEW.requested_elevation_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.eligible_role_id, OLD.person_id, OLD.role, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.window_seconds, OLD.sensitive, OLD.reason,
         OLD.requested_elevation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'an activation''s terms are immutable; request again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN
    RAISE EXCEPTION 'the approval of an activation never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('active', 'declined', 'withdrawn')) THEN
    RAISE EXCEPTION 'activation % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.status = OLD.status AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided activation is final' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER staff_activation_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_activation FOR EACH ROW EXECUTE FUNCTION trustwork.staff_activation_guard();

-- Audit images (digests only reach the audit row).
CREATE FUNCTION trustwork.staff_eligible_role_image(p staff_eligible_role) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'personId', p.person_id, 'role', p.role, 'scope', trustwork.admin_scope_json(p.scope_kind, p.node_id, p.hub_id),
    'definitionVersion', p.definition_version, 'maxActivationSeconds', p.max_activation_seconds, 'grantedBy', p.granted_by, 'validUntil', p.valid_until,
    'revokedAt', p.revoked_at, 'revokedBy', p.revoked_by, 'revision', p.revision)
$$;
CREATE FUNCTION trustwork.staff_activation_image(p staff_activation) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'eligibleRoleId', p.eligible_role_id, 'personId', p.person_id, 'role', p.role,
    'scope', trustwork.admin_scope_json(p.scope_kind, p.node_id, p.hub_id), 'windowSeconds', p.window_seconds, 'sensitive', p.sensitive, 'status', p.status,
    'approvalId', p.approval_id, 'decidedBy', p.decided_by, 'assignmentId', p.assignment_id, 'activeFrom', p.active_from, 'activeUntil', p.active_until,
    'withdrawnBy', p.withdrawn_by, 'revision', p.revision)
$$;

-- 3. Helpers (invoker, no grant) ------------------------------------------------------------------------------------
-- The role under which a person's own act at a scope is audited: a role they hold covering the scope, else the role
-- they are eligible for (an eligible-only person acts under the role they are about to hold).
CREATE FUNCTION trustwork.staff_own_actor(p_person uuid, p_elevation uuid, p_node uuid, p_hub uuid, p_fallback_role text) RETURNS trustwork.admin_actor
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ROW(p_person, coalesce((
    SELECT a.role FROM trustwork.staff_role_assignment a
     WHERE a.person_id = p_person AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
       AND CASE a.scope_kind WHEN 'platform' THEN true WHEN 'node' THEN p_hub IS NOT NULL OR p_node = a.node_id ELSE p_hub = a.hub_id END
     ORDER BY a.breakglass, a.valid_from LIMIT 1), p_fallback_role), false, p_elevation, 'admin.session.elevate')::trustwork.admin_actor
$$;

-- Full separation-of-duties mode: a role never joins a conflicting role the person holds (mirrors the assignment guard,
-- so an eligibility or a pending activation is refused before a second person is asked).
CREATE FUNCTION trustwork.staff_role_conflicts(p_person uuid, p_role text, p_definition_version integer) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a
    JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
    CROSS JOIN trustwork.staff_role_definition_version n
    WHERE n.role = p_role AND n.version = p_definition_version
      AND a.person_id = p_person AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
      AND ((n.sod_mode = 'full' AND a.role = ANY (n.sod_conflicts)) OR (d.sod_mode = 'full' AND p_role = ANY (d.sod_conflicts))))
$$;

-- The activation ceiling of an eligibility: its own ceiling, the released definition's grant_max_hours, 12 hours.
CREATE FUNCTION trustwork.staff_activation_ceiling(p_role text, p_definition_version integer, p_max bigint) RETURNS bigint
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT least(coalesce(p_max, 43200), 43200, (SELECT d.grant_max_hours::bigint * 3600 FROM trustwork.staff_role_definition_version d WHERE d.role = p_role AND d.version = p_definition_version))
$$;

-- 4. Grant and revoke eligibility (admin.staff.assign / admin.staff.revoke) -------------------------------------------
CREATE FUNCTION trustwork.staff_grant_eligible_role(p_ctx jsonb, p_person uuid, p_role text, p_scope_kind text, p_node uuid, p_hub uuid, p_definition_version integer,
  p_max_activation_seconds bigint, p_valid_for_seconds bigint) RETURNS trustwork.staff_eligible_role
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_target record;
  v_actor trustwork.admin_actor;
  v_def trustwork.staff_role_definition_version%ROWTYPE;
  v_ceiling bigint;
  v_row trustwork.staff_eligible_role%ROWTYPE;
BEGIN
  SELECT * INTO v_target FROM trustwork.admin_target(p_scope_kind, p_node, p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], v_target.node, v_target.hub);
  IF p_person = v_actor.person_id THEN
    RAISE EXCEPTION 'nobody makes themselves eligible for a role' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_grant';
  END IF;
  SELECT * INTO v_def FROM trustwork.staff_role_definition_version WHERE role = p_role AND version = p_definition_version;
  IF NOT FOUND OR NOT (p_scope_kind = ANY (v_def.scopes)) OR NOT trustwork.admin_role_allowed_in_scope(p_role, p_scope_kind) THEN
    RAISE EXCEPTION 'the role is not held at this scope' USING ERRCODE = 'check_violation', HINT = 'admin.role_scope';
  END IF;
  v_ceiling := trustwork.staff_activation_ceiling(p_role, p_definition_version, NULL);
  IF p_max_activation_seconds IS NULL OR p_max_activation_seconds < 60 OR p_max_activation_seconds > v_ceiling THEN
    RAISE EXCEPTION 'an activation lasts at most % seconds for this role', v_ceiling USING ERRCODE = 'check_violation', HINT = 'admin.activation_too_long';
  END IF;
  IF p_valid_for_seconds IS NOT NULL AND p_valid_for_seconds < 3600 THEN
    RAISE EXCEPTION 'an eligibility lasts at least one hour' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  IF trustwork.staff_role_conflicts(p_person, p_role, p_definition_version) THEN
    RAISE EXCEPTION 'role % conflicts with a role the person already holds', p_role USING ERRCODE = 'check_violation', HINT = 'admin.sod_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_eligible_role e WHERE e.person_id = p_person AND e.role = p_role AND e.scope_kind = p_scope_kind
              AND coalesce(e.node_id, e.hub_id) IS NOT DISTINCT FROM coalesce(v_target.node, v_target.hub) AND e.revoked_at IS NULL AND (e.valid_until IS NULL OR e.valid_until > now())) THEN
    RAISE EXCEPTION 'the person is already eligible for this role here' USING ERRCODE = 'unique_violation', HINT = 'admin.eligibility_open';
  END IF;
  -- An expired eligibility no longer blocks a new one; it is closed as revoked by the new grantor.
  UPDATE trustwork.staff_eligible_role e SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = 'Expired; replaced by a new eligibility'
   WHERE e.person_id = p_person AND e.role = p_role AND e.scope_kind = p_scope_kind AND coalesce(e.node_id, e.hub_id) IS NOT DISTINCT FROM coalesce(v_target.node, v_target.hub)
     AND e.revoked_at IS NULL AND e.valid_until IS NOT NULL AND e.valid_until <= now();
  INSERT INTO trustwork.staff_eligible_role (person_id, role, scope_kind, node_id, hub_id, definition_version, max_activation_seconds, granted_by, reason, valid_from, valid_until)
  VALUES (p_person, p_role, p_scope_kind, v_target.node, v_target.hub, p_definition_version, p_max_activation_seconds, v_actor.person_id, p_ctx ->> 'reasonText', now(),
    CASE WHEN p_valid_for_seconds IS NULL THEN NULL ELSE now() + make_interval(secs => p_valid_for_seconds) END)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.grant_eligible_role', 'staff_eligible_role', v_row.id, NULL, trustwork.staff_eligible_role_image(v_row));
  RETURN v_row;
END $$;

-- Ends the eligibility, withdraws its pending activation and ends its running one at once.
CREATE FUNCTION trustwork.staff_revoke_eligible_role(p_ctx jsonb, p_eligible_role uuid) RETURNS trustwork.staff_eligible_role
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_eligible_role%ROWTYPE;
  v_row trustwork.staff_eligible_role%ROWTYPE;
  v_target record;
  v_actor trustwork.admin_actor;
  v_act trustwork.staff_activation%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_eligible_role WHERE id = p_eligible_role FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such eligible role' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_target FROM trustwork.admin_target(v_before.scope_kind, v_before.node_id, v_before.hub_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_target.node, v_target.hub);
  IF v_before.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'already revoked' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  FOR v_act IN SELECT * FROM trustwork.staff_activation a WHERE a.eligible_role_id = v_before.id AND a.status IN ('pending', 'active') FOR UPDATE LOOP
    IF v_act.status = 'pending' THEN
      UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_actor.person_id WHERE id = v_act.approval_id AND status IN ('pending', 'approved');
      UPDATE trustwork.staff_activation SET status = 'withdrawn', withdrawn_by = v_actor.person_id WHERE id = v_act.id;
    ELSE
      UPDATE trustwork.staff_role_assignment SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText'
       WHERE id = v_act.assignment_id AND revoked_at IS NULL AND valid_until > now();
    END IF;
  END LOOP;
  UPDATE trustwork.staff_eligible_role SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText' WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.revoke_eligible_role', 'staff_eligible_role', v_row.id,
    trustwork.staff_eligible_role_image(v_before), trustwork.staff_eligible_role_image(v_row));
  RETURN v_row;
END $$;

-- 5. Request an activation (the eligible person, with a fresh second factor) ----------------------------------------
-- A non-sensitive role is active at once; a sensitive role asks a second person first ('pending_second_person').
CREATE FUNCTION trustwork.staff_activation_request(p_ctx jsonb, p_eligible_role uuid, p_window_seconds bigint, OUT activation trustwork.staff_activation, OUT outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_elevated_at timestamptz;
  v_eligible trustwork.staff_eligible_role%ROWTYPE;
  v_ceiling bigint;
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_activation%ROWTYPE;
  v_before jsonb;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_assignment uuid := trustwork.new_uuid();
BEGIN
  SELECT e.created_at INTO v_elevated_at FROM trustwork.session_elevation e WHERE e.id = v_elevation;
  IF v_elevated_at IS NULL OR v_elevated_at <= now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'activating a role needs a second factor used within the last five minutes' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.second_factor_stale';
  END IF;
  SELECT * INTO v_eligible FROM trustwork.staff_eligible_role WHERE id = p_eligible_role AND person_id = v_person FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such eligible role' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_eligible.revoked_at IS NOT NULL OR v_eligible.valid_from > now() OR (v_eligible.valid_until IS NOT NULL AND v_eligible.valid_until <= now()) THEN
    RAISE EXCEPTION 'the eligibility has ended' USING ERRCODE = 'check_violation', HINT = 'admin.eligibility_ended';
  END IF;
  v_ceiling := trustwork.staff_activation_ceiling(v_eligible.role, v_eligible.definition_version, v_eligible.max_activation_seconds);
  IF p_window_seconds IS NULL OR p_window_seconds < 60 OR p_window_seconds > v_ceiling THEN
    RAISE EXCEPTION 'an activation lasts at most % seconds for this role', v_ceiling USING ERRCODE = 'check_violation', HINT = 'admin.activation_too_long';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_activation a LEFT JOIN trustwork.staff_role_assignment s ON s.id = a.assignment_id
              WHERE a.eligible_role_id = v_eligible.id AND (a.status = 'pending' OR (a.status = 'active' AND s.revoked_at IS NULL AND s.valid_until > now()))) THEN
    RAISE EXCEPTION 'an activation of this role is already open' USING ERRCODE = 'unique_violation', HINT = 'admin.activation_open';
  END IF;
  -- The grantor's pre-authorization stands only while they may still assign at this scope.
  IF (SELECT r.role FROM trustwork.admin_resolve_permission(v_eligible.granted_by, 'admin.staff.assign', v_eligible.node_id, v_eligible.hub_id) r) IS NULL THEN
    RAISE EXCEPTION 'the person who granted the eligibility no longer assigns roles here; ask for a new eligibility' USING ERRCODE = 'check_violation', HINT = 'admin.eligibility_stale';
  END IF;
  IF trustwork.staff_role_conflicts(v_person, v_eligible.role, v_eligible.definition_version) THEN
    RAISE EXCEPTION 'role % conflicts with a role the person already holds', v_eligible.role USING ERRCODE = 'check_violation', HINT = 'admin.sod_conflict';
  END IF;
  v_actor := trustwork.staff_own_actor(v_person, v_elevation, v_eligible.node_id, v_eligible.hub_id, v_eligible.role);
  INSERT INTO trustwork.staff_activation (eligible_role_id, person_id, role, scope_kind, node_id, hub_id, window_seconds, sensitive, reason, requested_elevation_id)
  VALUES (v_eligible.id, v_person, v_eligible.role, v_eligible.scope_kind, v_eligible.node_id, v_eligible.hub_id, p_window_seconds,
    v_eligible.role = ANY (trustwork.admin_sensitive_roles()), p_ctx ->> 'reasonText', v_elevation)
  RETURNING * INTO v_row;
  v_before := trustwork.staff_activation_image(v_row);
  IF v_row.sensitive THEN
    INSERT INTO trustwork.second_person_approval (action, scope_kind, node_id, hub_id, action_digest, reason, requested_by)
    VALUES ('staff.assign_sensitive_role', v_eligible.scope_kind, v_eligible.node_id, v_eligible.hub_id,
      trustwork.admin_assignment_digest('staff.assign_sensitive_role', v_person, v_eligible.role, v_eligible.scope_kind, v_eligible.node_id, v_eligible.hub_id,
        v_eligible.definition_version, false, NULL, p_window_seconds), v_row.reason, v_eligible.granted_by)
    RETURNING * INTO v_approval;
    UPDATE trustwork.staff_activation SET approval_id = v_approval.id WHERE id = v_row.id RETURNING * INTO v_row;
    PERFORM trustwork.admin_record(v_actor, p_ctx, v_eligible.node_id, v_eligible.hub_id, 'staff.activation_requested', 'staff_activation', v_row.id, NULL, trustwork.staff_activation_image(v_row));
    activation := v_row;
    outcome := 'pending_second_person';
    RETURN;
  END IF;
  INSERT INTO trustwork.staff_role_assignment (id, person_id, role, scope_kind, node_id, hub_id, definition_version, granted_by, reason, valid_from, valid_until)
  VALUES (v_assignment, v_person, v_eligible.role, v_eligible.scope_kind, v_eligible.node_id, v_eligible.hub_id, v_eligible.definition_version, v_eligible.granted_by,
    v_row.reason, now(), now() + make_interval(secs => p_window_seconds));
  UPDATE trustwork.staff_activation SET status = 'active', assignment_id = v_assignment, active_from = now(), active_until = now() + make_interval(secs => p_window_seconds)
   WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_eligible.node_id, v_eligible.hub_id, 'staff.activation_started', 'staff_activation', v_row.id, NULL, trustwork.staff_activation_image(v_row));
  activation := v_row;
  outcome := 'active';
END $$;

-- 6. Decide as the second person (admin.staff.assign at the scope; neither the holder nor the grantor) --------------
-- Approving consumes the approval and makes the role active from now until the window ends. An approval already given
-- through the approvals inbox is honoured (the decision stays the approver's); a declined or expired one is refused.
CREATE FUNCTION trustwork.staff_activation_decide(p_ctx jsonb, p_activation uuid, p_decision text) RETURNS trustwork.staff_activation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.staff_activation%ROWTYPE;
  v_row trustwork.staff_activation%ROWTYPE;
  v_eligible trustwork.staff_eligible_role%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_assignment uuid := trustwork.new_uuid();
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_activation WHERE id = p_activation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such activation' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], v_before.node_id, v_before.hub_id);
  SELECT * INTO v_eligible FROM trustwork.staff_eligible_role WHERE id = v_before.eligible_role_id;
  IF v_actor.person_id = v_before.person_id THEN
    RAISE EXCEPTION 'nobody approves their own activation' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
  END IF;
  IF v_actor.person_id = v_eligible.granted_by THEN
    RAISE EXCEPTION 'the person who granted the eligibility is not its second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.same_decider';
  END IF;
  IF v_before.status <> 'pending' THEN
    RAISE EXCEPTION 'the activation is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_decision NOT IN ('approve', 'decline') THEN
    RAISE EXCEPTION 'decision is approve or decline' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = v_before.approval_id FOR UPDATE;
  IF p_decision = 'decline' THEN
    IF v_approval.status = 'pending' THEN
      UPDATE trustwork.second_person_approval SET status = 'declined', declined_by = v_actor.person_id, decline_reason = p_ctx ->> 'reasonText' WHERE id = v_approval.id;
    ELSIF v_approval.status = 'approved' THEN
      UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_actor.person_id WHERE id = v_approval.id;
    END IF;
    UPDATE trustwork.staff_activation SET status = 'declined', decided_by = v_actor.person_id WHERE id = v_before.id RETURNING * INTO v_row;
    PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.activation_declined', 'staff_activation', v_row.id,
      trustwork.staff_activation_image(v_before), trustwork.staff_activation_image(v_row));
    RETURN v_row;
  END IF;
  IF v_eligible.revoked_at IS NOT NULL OR (v_eligible.valid_until IS NOT NULL AND v_eligible.valid_until <= now()) THEN
    RAISE EXCEPTION 'the eligibility has ended' USING ERRCODE = 'check_violation', HINT = 'admin.eligibility_ended';
  END IF;
  IF (SELECT r.role FROM trustwork.admin_resolve_permission(v_eligible.granted_by, 'admin.staff.assign', v_eligible.node_id, v_eligible.hub_id) r) IS NULL THEN
    RAISE EXCEPTION 'the person who granted the eligibility no longer assigns roles here; ask for a new eligibility' USING ERRCODE = 'check_violation', HINT = 'admin.eligibility_stale';
  END IF;
  IF v_approval.status = 'pending' THEN
    IF v_approval.request_expires_at <= now() THEN
      RAISE EXCEPTION 'the request expired; ask again' USING ERRCODE = 'check_violation', HINT = 'admin.approval_expired';
    END IF;
    UPDATE trustwork.second_person_approval SET status = 'approved', approved_by = v_actor.person_id, approved_at = now(), expires_at = now() + interval '72 hours'
     WHERE id = v_approval.id RETURNING * INTO v_approval;
  ELSIF v_approval.status = 'approved' THEN
    IF v_approval.expires_at <= now() THEN
      RAISE EXCEPTION 'the approval expired' USING ERRCODE = 'check_violation', HINT = 'admin.approval_expired';
    END IF;
    IF v_approval.approved_by = v_before.person_id THEN
      RAISE EXCEPTION 'the holder cannot be the second approver' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
    END IF;
  ELSE
    RAISE EXCEPTION 'the approval is %', v_approval.status USING ERRCODE = 'check_violation', HINT = 'admin.approval_not_approved';
  END IF;
  UPDATE trustwork.second_person_approval SET status = 'consumed', consumed_ref = v_assignment, consumed_at = now() WHERE id = v_approval.id RETURNING * INTO v_approval;
  INSERT INTO trustwork.staff_role_assignment (id, person_id, role, scope_kind, node_id, hub_id, definition_version, granted_by, approved_by, approval_id, reason, valid_from, valid_until)
  VALUES (v_assignment, v_before.person_id, v_before.role, v_before.scope_kind, v_before.node_id, v_before.hub_id, v_eligible.definition_version, v_eligible.granted_by,
    v_approval.approved_by, v_approval.id, v_before.reason, now(), now() + make_interval(secs => v_before.window_seconds));
  UPDATE trustwork.staff_activation SET status = 'active', decided_by = v_actor.person_id, assignment_id = v_assignment, active_from = now(),
    active_until = now() + make_interval(secs => v_before.window_seconds) WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.activation_approved', 'staff_activation', v_row.id,
    trustwork.staff_activation_image(v_before), trustwork.staff_activation_image(v_row));
  RETURN v_row;
END $$;

-- 7. End early: the holder withdraws or ends their own activation; staff with admin.staff.revoke end anyone's ---------
CREATE FUNCTION trustwork.staff_activation_end(p_ctx jsonb, p_activation uuid) RETURNS trustwork.staff_activation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_before trustwork.staff_activation%ROWTYPE;
  v_row trustwork.staff_activation%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_assignment trustwork.staff_role_assignment%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.staff_activation WHERE id = p_activation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such activation' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_before.person_id = v_person THEN
    v_actor := trustwork.staff_own_actor(v_person, v_elevation, v_before.node_id, v_before.hub_id, v_before.role);
  ELSE
    v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.revoke'], v_before.node_id, v_before.hub_id);
  END IF;
  IF v_before.status = 'pending' THEN
    UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_actor.person_id WHERE id = v_before.approval_id AND status IN ('pending', 'approved');
    UPDATE trustwork.staff_activation SET status = 'withdrawn', withdrawn_by = v_actor.person_id WHERE id = v_before.id RETURNING * INTO v_row;
    PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.activation_withdrawn', 'staff_activation', v_row.id,
      trustwork.staff_activation_image(v_before), trustwork.staff_activation_image(v_row));
    RETURN v_row;
  END IF;
  IF v_before.status <> 'active' THEN
    RAISE EXCEPTION 'the activation is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  SELECT * INTO v_assignment FROM trustwork.staff_role_assignment WHERE id = v_before.assignment_id FOR UPDATE;
  IF v_assignment.revoked_at IS NOT NULL OR v_assignment.valid_until <= now() THEN
    RAISE EXCEPTION 'the activation has ended' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.staff_role_assignment SET revoked_at = now(), revoked_by = v_actor.person_id, revoke_reason = p_ctx ->> 'reasonText' WHERE id = v_assignment.id;
  SELECT * INTO v_row FROM trustwork.staff_activation WHERE id = v_before.id;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.activation_ended', 'staff_activation', v_row.id,
    trustwork.staff_activation_image(v_before), trustwork.staff_activation_image(v_row));
  RETURN v_row;
END $$;

-- 8. Leaving: revoking a person's last standing role ends their eligible roles and activations too ------------------
-- Runs before ADM-001's staff_role_assignment_revoked (alphabetical order), so once the activation assignments are
-- revoked here that trigger finds no other active assignment and ends elevations and open approval requests.
CREATE FUNCTION trustwork.staff_lifecycle_assignment_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_act trustwork.staff_activation%ROWTYPE;
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.staff_activation x WHERE x.assignment_id = NEW.id) THEN
    RETURN NULL; -- an activation ending early; the standing roles stay
  END IF;
  IF EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a
     WHERE a.person_id = NEW.person_id AND a.id <> NEW.id AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
       AND NOT EXISTS (SELECT 1 FROM trustwork.staff_activation x WHERE x.assignment_id = a.id)
  ) THEN
    RETURN NULL;
  END IF;
  FOR v_act IN SELECT * FROM trustwork.staff_activation a WHERE a.person_id = NEW.person_id AND a.status IN ('pending', 'active') FOR UPDATE LOOP
    IF v_act.status = 'pending' THEN
      UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = NEW.revoked_by WHERE id = v_act.approval_id AND status IN ('pending', 'approved');
      UPDATE trustwork.staff_activation SET status = 'withdrawn', withdrawn_by = NEW.revoked_by WHERE id = v_act.id;
    ELSIF (SELECT r.role FROM trustwork.admin_resolve_permission(NEW.revoked_by, 'admin.staff.revoke', v_act.node_id, v_act.hub_id) r) IS NOT NULL THEN
      UPDATE trustwork.staff_role_assignment SET revoked_at = now(), revoked_by = NEW.revoked_by, revoke_reason = 'Last standing role revoked'
       WHERE id = v_act.assignment_id AND revoked_at IS NULL AND valid_until > now();
    END IF;
  END LOOP;
  UPDATE trustwork.staff_eligible_role SET revoked_at = now(), revoked_by = NEW.revoked_by, revoke_reason = 'Last standing role revoked'
   WHERE person_id = NEW.person_id AND revoked_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER staff_lifecycle_assignment_revoked AFTER UPDATE ON trustwork.staff_role_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.staff_lifecycle_assignment_revoked();

-- 9. Reads ----------------------------------------------------------------------------------------------------------
-- Row-level security: a person reads their own eligible roles and activations; staff with admin.staff.read at the scope
-- read everyone's there (the pending activations are the second person's queue).
ALTER TABLE trustwork.staff_eligible_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_eligible_role FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.staff_eligible_role AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.staff_activation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY staff_eligible_role_read ON trustwork.staff_eligible_role FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
CREATE POLICY staff_activation_read ON trustwork.staff_activation FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
GRANT SELECT ON trustwork.staff_eligible_role, trustwork.staff_activation TO trustwork_app;

REVOKE EXECUTE ON FUNCTION trustwork.staff_own_actor(uuid, uuid, uuid, uuid, text), trustwork.staff_role_conflicts(uuid, text, integer),
  trustwork.staff_activation_ceiling(text, integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.staff_grant_eligible_role(jsonb, uuid, text, text, uuid, uuid, integer, bigint, bigint), trustwork.staff_revoke_eligible_role(jsonb, uuid),
  trustwork.staff_activation_request(jsonb, uuid, bigint), trustwork.staff_activation_decide(jsonb, uuid, text), trustwork.staff_activation_end(jsonb, uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

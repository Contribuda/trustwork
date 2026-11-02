-- ADM-004 part 2: staff invitations with expiry, a second person for sensitive roles and roles with an end date
-- (docs/engine/hub-console/console-design.md, section 4.2 "Invitation with approval"). Contract:
-- packages/contracts/src/staff-lifecycle.ts.
--
-- The path of an invitation:
--   1. invite: a staff member with admin.staff.assign at the scope invites an e-mail address to one role at that scope,
--      optionally for a limited time, with a reason; the invitation expires unused after seven days;
--   2. respond: the person whose verified e-mail it names accepts (with an active second factor) or declines; nothing
--      else learns whether an account with that address exists;
--   3. apply: the inviter, in an elevated session, turns an accepted invitation into the staff assignment. A sensitive
--      role first asks a second person (staff.assign_sensitive_role, bound to the exact assignment digest, now that the
--      person is known); once approved, the same step consumes the approval and assigns;
--   4. withdraw: the inviter or a staff member with admin.staff.assign at the scope ends an open invitation, and any
--      approval it asked for is revoked.
--
-- Rules the schema holds: nobody invites themselves or accepts their own invitation; a sensitive role never takes
-- effect without a second person different from the inviter and the invitee (the assignment guard of ADM-001 checks
-- the consumed approval); every staff mutation is audited with the actor's elevation; an expired invitation is refused
-- at every step without a job having to run; at most one open invitation per address, role and scope.

CREATE TABLE trustwork.staff_invitation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  role text NOT NULL CHECK (role = ANY (trustwork.admin_staff_roles())),
  definition_version integer NOT NULL,
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized) AND length(email_normalized) BETWEEN 3 AND 254 AND email_normalized ~ '^[^@\s]+@[^@\s]+$'),
  person_id uuid NULL REFERENCES trustwork.person (id),
  valid_for_seconds bigint NULL CHECK (valid_for_seconds IS NULL OR valid_for_seconds BETWEEN 3600 AND 31622400),
  sensitive boolean NOT NULL,
  invited_by uuid NOT NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'applied', 'withdrawn')),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz NULL,
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  assignment_id uuid NULL UNIQUE REFERENCES trustwork.staff_role_assignment (id),
  withdrawn_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_invitation_definition FOREIGN KEY (role, definition_version) REFERENCES trustwork.staff_role_definition_version (role, version),
  CONSTRAINT staff_invitation_scope_shape CHECK ((scope_kind = 'platform' AND node_id IS NULL AND hub_id IS NULL)
    OR (scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT staff_invitation_state_shape CHECK (
    (status = 'pending' AND person_id IS NULL AND responded_at IS NULL AND assignment_id IS NULL AND withdrawn_by IS NULL)
    OR (status = 'accepted' AND person_id IS NOT NULL AND responded_at IS NOT NULL AND assignment_id IS NULL AND withdrawn_by IS NULL)
    OR (status = 'declined' AND person_id IS NOT NULL AND responded_at IS NOT NULL AND assignment_id IS NULL AND withdrawn_by IS NULL)
    OR (status = 'applied' AND person_id IS NOT NULL AND assignment_id IS NOT NULL AND withdrawn_by IS NULL)
    OR (status = 'withdrawn' AND withdrawn_by IS NOT NULL AND assignment_id IS NULL)),
  CONSTRAINT staff_invitation_not_self CHECK (person_id IS NULL OR person_id <> invited_by)
);
CREATE UNIQUE INDEX staff_invitation_open_once ON trustwork.staff_invitation (email_normalized, role, scope_kind, coalesce(node_id, hub_id)) WHERE status IN ('pending', 'accepted');
CREATE INDEX staff_invitation_hub_idx ON trustwork.staff_invitation (hub_id, created_at DESC);

-- Rows change only through the commands below: identity, scope, role, address, inviter and reason never change.
CREATE FUNCTION trustwork.staff_invitation_guard() RETURNS trigger
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
         NEW.invited_by, NEW.reason, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.role, OLD.definition_version, OLD.email_normalized, OLD.valid_for_seconds, OLD.sensitive,
         OLD.invited_by, OLD.reason, OLD.expires_at, OLD.created_at) THEN
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
CREATE TRIGGER staff_invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.staff_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.staff_invitation_guard();

-- The audit image of an invitation: never the address.
CREATE FUNCTION trustwork.staff_invitation_image(p staff_invitation) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'role', p.role, 'scope', trustwork.admin_scope_json(p.scope_kind, p.node_id, p.hub_id), 'definitionVersion', p.definition_version,
    'validForSeconds', p.valid_for_seconds, 'sensitive', p.sensitive, 'status', p.status, 'personId', p.person_id, 'approvalId', p.approval_id,
    'assignmentId', p.assignment_id, 'revision', p.revision)
$$;

-- 1. Invite ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.staff_invite(p_ctx jsonb, p_email text, p_role text, p_scope_kind text, p_node uuid, p_hub uuid, p_definition_version integer,
  p_valid_for_seconds bigint) RETURNS trustwork.staff_invitation
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
  IF EXISTS (SELECT 1 FROM trustwork.staff_invitation i WHERE i.email_normalized = v_email AND i.role = p_role AND i.scope_kind = p_scope_kind
              AND coalesce(i.node_id, i.hub_id) IS NOT DISTINCT FROM coalesce(v_target.node, v_target.hub) AND i.status IN ('pending', 'accepted') AND i.expires_at > now()) THEN
    RAISE EXCEPTION 'an open invitation to this role exists' USING ERRCODE = 'unique_violation', HINT = 'admin.invitation_open';
  END IF;
  -- An expired open invitation no longer blocks a new one; it is closed as withdrawn by the new inviter.
  UPDATE trustwork.staff_invitation i SET status = 'withdrawn', withdrawn_by = v_actor.person_id
   WHERE i.email_normalized = v_email AND i.role = p_role AND i.scope_kind = p_scope_kind
     AND coalesce(i.node_id, i.hub_id) IS NOT DISTINCT FROM coalesce(v_target.node, v_target.hub) AND i.status IN ('pending', 'accepted') AND i.expires_at <= now();
  INSERT INTO trustwork.staff_invitation (scope_kind, node_id, hub_id, role, definition_version, email_normalized, valid_for_seconds, sensitive, invited_by, reason, expires_at)
  VALUES (p_scope_kind, v_target.node, v_target.hub, p_role, p_definition_version, v_email, p_valid_for_seconds, p_role = ANY (trustwork.admin_sensitive_roles()),
    v_actor.person_id, p_ctx ->> 'reasonText', now() + interval '7 days')
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_target.node, v_target.hub, 'staff.invited', 'staff_invitation', v_row.id, NULL, trustwork.staff_invitation_image(v_row));
  RETURN v_row;
END $$;

-- 2. Respond (the invitee) ------------------------------------------------------------------------------------------
-- Only a person whose verified e-mail the invitation names sees it; to anyone else it does not exist.
CREATE FUNCTION trustwork.staff_invitation_respond(p_invitation uuid, p_accept boolean) RETURNS trustwork.staff_invitation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_row trustwork.staff_invitation%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.staff_invitation WHERE id = p_invitation FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = v_person AND b.email_normalized = v_row.email_normalized AND b.verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'no such invitation' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'the invitation is %', v_row.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'the invitation expired' USING ERRCODE = 'check_violation', HINT = 'admin.invitation_expired';
  END IF;
  IF v_person = v_row.invited_by THEN
    RAISE EXCEPTION 'nobody accepts their own invitation' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_grant';
  END IF;
  IF p_accept AND NOT EXISTS (SELECT 1 FROM trustwork.second_factor f WHERE f.person_id = v_person AND f.state = 'active') THEN
    RAISE EXCEPTION 'staff need a second factor before accepting' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.second_factor_required';
  END IF;
  UPDATE trustwork.staff_invitation SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, person_id = v_person, responded_at = now()
   WHERE id = p_invitation RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- 3. Apply (the inviter, elevated) ----------------------------------------------------------------------------------
-- Answers the invitation and whether a second person is still needed ('pending_second_person') or the role is now held.
CREATE FUNCTION trustwork.staff_invitation_apply(p_ctx jsonb, p_invitation uuid, OUT invitation trustwork.staff_invitation, OUT outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_invitation%ROWTYPE;
  v_before jsonb;
  v_digest text;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_assignment uuid := trustwork.new_uuid();
BEGIN
  SELECT * INTO v_row FROM trustwork.staff_invitation WHERE id = p_invitation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such invitation' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], v_row.node_id, v_row.hub_id);
  IF v_actor.person_id <> v_row.invited_by THEN
    RAISE EXCEPTION 'the inviter applies the invitation' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.not_requester';
  END IF;
  IF v_row.status <> 'accepted' THEN
    RAISE EXCEPTION 'the invitation is %', v_row.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  v_before := trustwork.staff_invitation_image(v_row);
  IF v_row.sensitive THEN
    v_digest := trustwork.admin_assignment_digest('staff.assign_sensitive_role', v_row.person_id, v_row.role, v_row.scope_kind, v_row.node_id, v_row.hub_id,
      v_row.definition_version, false, NULL, v_row.valid_for_seconds);
    IF v_row.approval_id IS NOT NULL THEN
      SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = v_row.approval_id;
    END IF;
    IF v_row.approval_id IS NULL OR v_approval.status IN ('declined', 'revoked') OR (v_approval.status = 'approved' AND v_approval.expires_at <= now())
       OR (v_approval.status = 'pending' AND v_approval.request_expires_at <= now()) THEN
      -- Ask a second person for exactly this assignment, now that the invitee is known.
      INSERT INTO trustwork.second_person_approval (action, scope_kind, node_id, hub_id, action_digest, reason, requested_by)
      VALUES ('staff.assign_sensitive_role', v_row.scope_kind, v_row.node_id, v_row.hub_id, v_digest, v_row.reason, v_actor.person_id)
      RETURNING * INTO v_approval;
      UPDATE trustwork.staff_invitation SET approval_id = v_approval.id WHERE id = v_row.id RETURNING * INTO v_row;
      PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.invitation_approval_requested', 'staff_invitation', v_row.id, v_before,
        trustwork.staff_invitation_image(v_row));
      invitation := v_row;
      outcome := 'pending_second_person';
      RETURN;
    END IF;
    IF v_approval.status = 'pending' THEN
      RAISE EXCEPTION 'a second person has not decided yet' USING ERRCODE = 'check_violation', HINT = 'admin.approval_not_approved';
    END IF;
    IF v_approval.approved_by = v_row.person_id THEN
      RAISE EXCEPTION 'the invitee cannot approve their own role' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
    END IF;
    PERFORM trustwork.admin_consume_approval(v_approval.id, 'staff.assign_sensitive_role', v_row.scope_kind, v_row.node_id, v_row.hub_id, v_digest, v_assignment);
  END IF;
  INSERT INTO trustwork.staff_role_assignment (id, person_id, role, scope_kind, node_id, hub_id, definition_version, granted_by, approved_by, approval_id, reason, valid_from, valid_until)
  VALUES (v_assignment, v_row.person_id, v_row.role, v_row.scope_kind, v_row.node_id, v_row.hub_id, v_row.definition_version, v_actor.person_id,
    CASE WHEN v_row.sensitive THEN v_approval.approved_by END, CASE WHEN v_row.sensitive THEN v_approval.id END, v_row.reason, now(),
    CASE WHEN v_row.valid_for_seconds IS NULL THEN NULL ELSE now() + make_interval(secs => v_row.valid_for_seconds) END);
  UPDATE trustwork.staff_invitation SET status = 'applied', assignment_id = v_assignment WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.assign_role', 'staff_role_assignment', v_assignment, NULL,
    jsonb_build_object('invitationId', v_row.id, 'role', v_row.role, 'personId', v_row.person_id), NULL, CASE WHEN v_row.sensitive THEN v_approval.id END);
  invitation := v_row;
  outcome := 'applied';
END $$;

-- 4. Withdraw -------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.staff_invitation_withdraw(p_ctx jsonb, p_invitation uuid) RETURNS trustwork.staff_invitation
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.staff_invitation%ROWTYPE;
  v_before jsonb;
BEGIN
  SELECT * INTO v_row FROM trustwork.staff_invitation WHERE id = p_invitation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such invitation' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.staff.assign'], v_row.node_id, v_row.hub_id);
  IF v_row.status NOT IN ('pending', 'accepted') THEN
    RAISE EXCEPTION 'the invitation is %', v_row.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  v_before := trustwork.staff_invitation_image(v_row);
  IF v_row.approval_id IS NOT NULL THEN
    UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_actor.person_id WHERE id = v_row.approval_id AND status IN ('pending', 'approved');
  END IF;
  UPDATE trustwork.staff_invitation SET status = 'withdrawn', withdrawn_by = v_actor.person_id WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.invitation_withdrawn', 'staff_invitation', v_row.id, v_before, trustwork.staff_invitation_image(v_row));
  RETURN v_row;
END $$;

-- 5. Reads ----------------------------------------------------------------------------------------------------------
-- The invitee's own open invitations (by their verified addresses), with what the console needs to decide and no
-- other person's data than the inviter's name.
CREATE FUNCTION trustwork.staff_my_invitations()
RETURNS TABLE (id uuid, role text, scope_kind text, node_id uuid, hub_id uuid, valid_for_seconds bigint, reason text, inviter_name text, expires_at timestamptz, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT i.id, i.role, i.scope_kind, i.node_id, i.hub_id, i.valid_for_seconds, i.reason, p.display_name, i.expires_at, i.status
    FROM trustwork.staff_invitation i
    JOIN trustwork.email_binding b ON b.email_normalized = i.email_normalized AND b.verified_at IS NOT NULL AND b.person_id = trustwork.current_person_id()
    JOIN trustwork.person p ON p.id = i.invited_by
   WHERE i.status = 'pending' AND i.expires_at > now()
   ORDER BY i.created_at DESC
$$;

ALTER TABLE trustwork.staff_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.staff_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.staff_invitation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- Staff who may read the staff of the scope read its invitations (the address included: they manage it).
CREATE POLICY staff_invitation_read ON trustwork.staff_invitation FOR SELECT TO trustwork_app USING (trustwork.admin_has_permission('admin.staff.read', node_id, hub_id));
GRANT SELECT ON trustwork.staff_invitation TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.staff_invite(jsonb, text, text, text, uuid, uuid, integer, bigint), trustwork.staff_invitation_respond(uuid, boolean),
  trustwork.staff_invitation_apply(jsonb, uuid), trustwork.staff_invitation_withdraw(jsonb, uuid), trustwork.staff_my_invitations() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

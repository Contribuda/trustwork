-- ADM-004 audit fixes. The full-mode "different role" rule for staff roles (the second person acts through a role the
-- requester does not hold for that action) was decided by the database only for activations
-- (20261207100000_staff_eligible_roles.sql). The approvals inbox decided it in the API, on the rows the approver could
-- read under row-level security and only when the approver held admin.staff.read at the scope, and an invitation of a
-- sensitive role did not decide it at all. A hub with three hub staff and two node staff is in full mode for the
-- database and looked reduced to a hub reader, who cannot read node assignments.
--
-- From here on the database decides, for the actions that give someone a staff role (staff.assign_sensitive_role and
-- staff.grant_breakglass), when an approval is given and when it is used:
--   * admin_decide_approval refuses the approver (admin.same_role);
--   * admin_consume_approval refuses again, because the scope can reach five people, or the roles can change, between
--     the approval and its use. Both commands that execute these approvals go through it (staff_invitation_apply and
--     admin_assign_role), so neither can use an approval the other has refused. An approver who no longer holds a role
--     for the action fails this check too: nobody can then show the second person acted through a different role, and
--     the requester asks again. staff_activation_decide consumes without this function and keeps its own check, against
--     the eligibility's grantor;
--   * staff_sod_state gives the API the database's own answer, so the mode a screen shows is the mode that is enforced.
-- Every other second-person action keeps what it had: a different person in the database, and the API's check.
--
-- The same change audits a sensitive role assigned through an invitation as staff.assign_sensitive_role, the action
-- admin_audit_event_second_person binds to a second approver, exactly as admin_assign_role does; it was recorded as
-- staff.assign_role. staff_invitation_scope lets a refused apply or withdraw be audited at the invitation's own scope
-- by staff who cannot read the invitation itself.

-- 1. The count behind the mode, for the mode check and for the answer given to the API ------------------------------
CREATE FUNCTION trustwork.staff_sod_count(p_node uuid, p_hub uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT count(DISTINCT a.person_id)::integer FROM trustwork.staff_role_assignment a
    JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
   WHERE a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now()) AND a.scope_kind = ANY (d.scopes)
     AND CASE a.scope_kind WHEN 'platform' THEN true WHEN 'node' THEN p_hub IS NOT NULL OR p_node = a.node_id ELSE p_hub = a.hub_id END
$$;

CREATE OR REPLACE FUNCTION trustwork.staff_sod_full(p_node uuid, p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.staff_sod_count(p_node, p_hub) >= 5
$$;

-- The scope's mode as the database enforces it, for staff covering the scope; anyone else gets "not found".
CREATE FUNCTION trustwork.staff_sod_state(p_node uuid, p_hub uuid, OUT mode text, OUT staff_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.admin_person_is_staff(trustwork.current_person_id(), p_node, p_hub) THEN
    RAISE EXCEPTION 'no such scope' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  staff_count := trustwork.staff_sod_count(p_node, p_hub);
  mode := CASE WHEN trustwork.staff_sod_full(p_node, p_hub) THEN 'full' ELSE 'reduced' END;
END $$;

-- 2. The rule -------------------------------------------------------------------------------------------------------
-- Every role through which a person holds any permission that executes the action, at the target.
CREATE FUNCTION trustwork.staff_roles_for_action(p_person uuid, p_action text, p_node uuid, p_hub uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT r.role ORDER BY r.role), '{}'::text[])
    FROM unnest(trustwork.admin_action_permissions(p_action)) AS permission
    CROSS JOIN LATERAL unnest(trustwork.staff_roles_granting(p_person, permission, p_node, p_hub)) AS r(role)
$$;

CREATE FUNCTION trustwork.staff_require_different_role(p_action text, p_requester uuid, p_approver uuid, p_node uuid, p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_action NOT IN ('staff.assign_sensitive_role', 'staff.grant_breakglass') THEN
    RETURN;
  END IF;
  IF trustwork.staff_sod_full(p_node, p_hub)
     AND trustwork.staff_roles_for_action(p_approver, p_action, p_node, p_hub) <@ trustwork.staff_roles_for_action(p_requester, p_action, p_node, p_hub) THEN
    RAISE EXCEPTION 'in full separation-of-duties mode the second person acts through a different role' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.same_role';
  END IF;
END $$;

-- 3. Deciding an approval -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.admin_decide_approval(p_ctx jsonb, p_approval_id uuid, p_decision text, p_action_digest text, p_valid_for interval DEFAULT interval '72 hours')
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
    PERFORM trustwork.staff_require_different_role(v_before.action, v_before.requested_by, v_person, v_before.node_id, v_before.hub_id);
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

-- 4. Using an approval ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.admin_consume_approval(p_approval_id uuid, p_action text, p_scope_kind text, p_node uuid, p_hub uuid, p_action_digest text, p_ref uuid)
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
  PERFORM trustwork.staff_require_different_role(v_before.action, v_before.requested_by, v_before.approved_by, v_before.node_id, v_before.hub_id);
  UPDATE trustwork.second_person_approval SET status = 'consumed', consumed_ref = p_ref, consumed_at = now() WHERE id = p_approval_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- 5. Applying an invitation -----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.staff_invitation_apply(p_ctx jsonb, p_invitation uuid, OUT invitation trustwork.staff_invitation, OUT outcome text)
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
  IF v_row.expires_at <= now() THEN
    -- The seven days bound the whole path, the wait for a second person included: a late approval is never consumed here.
    RAISE EXCEPTION 'the invitation expired; invite again' USING ERRCODE = 'check_violation', HINT = 'admin.invitation_expired';
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
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, CASE WHEN v_row.sensitive THEN 'staff.assign_sensitive_role' ELSE 'staff.assign_role' END,
    'staff_role_assignment', v_assignment, NULL, jsonb_build_object('invitationId', v_row.id, 'role', v_row.role, 'personId', v_row.person_id), NULL,
    CASE WHEN v_row.sensitive THEN v_approval.id END);
  invitation := v_row;
  outcome := 'applied';
END $$;

-- 6. The scope of an invitation, for the audit row of a refused command -----------------------------------------------
-- The invitation's rows are readable with admin.staff.read; staff refused for lacking it are audited all the same. Only
-- staff covering the scope learn it; to anyone else the answer is empty, as if the invitation did not exist.
CREATE FUNCTION trustwork.staff_invitation_scope(p_invitation uuid) RETURNS TABLE (scope_kind text, node_id uuid, hub_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT i.scope_kind, i.node_id, i.hub_id FROM trustwork.staff_invitation i
   WHERE i.id = p_invitation AND trustwork.admin_person_is_staff(trustwork.current_person_id(), i.node_id, i.hub_id)
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.staff_sod_state(uuid, uuid), trustwork.staff_invitation_scope(uuid) TO trustwork_app;

-- ADM-004 fix to part 2 (packages/data/migrations/staff-lifecycle/20261130130000_staff_invitations.sql): the apply step
-- did not check the invitation's expiry, so an accepted invitation older than seven days could still become a role.
-- The migration header promised that expiry is refused at every step; this makes the apply step keep that promise.
--
-- What expiry means for an accepted invitation waiting for a second person: the invitation's seven days bound the whole
-- path, the wait for the approval included. Once expired, the invitation is refused with admin.invitation_expired at
-- the apply step whether or not an approval was asked, so the invitation path never consumes a late approval. A refusal
-- writes nothing, so the approval it asked for stays as it is until the inviter withdraws the invitation
-- (staff_invitation_withdraw revokes it) or invites again (which closes the expired invitation and starts afresh with a
-- new approval for the new digest). An approval that was given stays what ADM-001 made it: an approval of exactly that
-- assignment by a second person, which its requester may still execute through admin_assign_role within its 72 hours.

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
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'staff.assign_role', 'staff_role_assignment', v_assignment, NULL,
    jsonb_build_object('invitationId', v_row.id, 'role', v_row.role, 'personId', v_row.person_id), NULL, CASE WHEN v_row.sensitive THEN v_approval.id END);
  invitation := v_row;
  outcome := 'applied';
END $$;

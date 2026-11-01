-- Approval requires both people to retain usable authority now, not just unchanged historical role rows.
CREATE OR REPLACE FUNCTION trustwork.privacy_plan_approve(p_ctx jsonb, p_plan uuid, p_grant uuid, p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_plan trustwork.privacy_subject_plan%ROWTYPE; v_actor trustwork.admin_actor; v_snapshot jsonb;
BEGIN
  SELECT * INTO v_plan FROM trustwork.privacy_subject_plan WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND OR v_plan.state <> 'proposed' THEN RAISE EXCEPTION 'plan unavailable' USING ERRCODE = '42501', HINT = 'privacy.not_found'; END IF;
  PERFORM trustwork.privacy_plan_case(trustwork.current_person_id(), p_grant, v_plan.request_id);
  PERFORM trustwork.privacy_plan_case(v_plan.proposed_by, v_plan.proposer_grant_id, v_plan.request_id);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.erasure.execute'], NULL, NULL);
  v_snapshot := trustwork.privacy_plan_snapshot(v_plan.request_id);
  IF p_digest IS DISTINCT FROM v_plan.digest OR trustwork.admin_digest(v_snapshot) <> v_plan.digest
    OR trustwork.privacy_plan_authority_digest(v_plan.proposed_by, v_plan.proposer_grant_id) IS DISTINCT FROM v_plan.proposer_authority_digest THEN
    RAISE EXCEPTION 'subject plan changed' USING ERRCODE = '40001', HINT = 'privacy.plan_changed';
  END IF;
  PERFORM trustwork.admin_decide_approval(p_ctx, v_plan.approval_id, 'approve', p_digest);
  UPDATE trustwork.privacy_subject_plan SET state = 'approved', reviewer_grant_id = p_grant,
    reviewer_authority_digest = trustwork.privacy_plan_authority_digest(v_actor.person_id, p_grant) WHERE id = p_plan;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, NULL, 'privacy.plan_approved', 'privacy_subject_plan', p_plan, NULL, jsonb_build_object('digest', p_digest));
  RETURN jsonb_build_object('id', p_plan, 'digest', p_digest, 'state', 'approved', 'executable', false);
END $$;

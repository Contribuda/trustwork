-- Extend the accepted LLM foundation at its shared fresh-authority boundary. Original receipt/recovery commands
-- do not call this boundary and remain available after dispatch policy, mandate or serving provenance is withdrawn.
CREATE FUNCTION trustwork.agent_modules_check_model_scope(p_call jsonb,p_binding jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE p trustwork.agent_run_provenance%ROWTYPE; m trustwork.mandate%ROWTYPE; c jsonb; v_reason text;
BEGIN
  IF trustwork.current_person_id() IS NULL OR trustwork.current_person_id() IS DISTINCT FROM (p_call ->> 'principalId')::uuid THEN
    RAISE EXCEPTION 'model principal unavailable' USING ERRCODE='42501',HINT='access.not_found';
  END IF;
  SELECT * INTO p FROM trustwork.agent_run_provenance WHERE run_id=(p_call ->> 'runId')::uuid AND principal_person_id=trustwork.current_person_id();
  IF p.run_id IS NULL OR p.hub_id IS DISTINCT FROM (p_call ->> 'hubId')::uuid THEN
    RAISE EXCEPTION 'model hub provenance unavailable' USING ERRCODE='42501',HINT='agents.hub_provenance_unavailable';
  END IF;
  SELECT * INTO m FROM trustwork.mandate WHERE id=(p_call ->> 'mandateId')::uuid AND principal_person_id=p.principal_person_id;
  IF m.id IS NULL OR m.on_behalf_company_id IS NOT NULL OR m.grantee_kind<>'own_agent'
    OR p_call ->> 'extensionId' IS NOT NULL OR p_call ->> 'pipelineId' IS NOT NULL THEN
    RAISE EXCEPTION 'model owning authority unavailable' USING ERRCODE='42501',HINT='models.governance_unavailable';
  END IF;
  PERFORM trustwork.agent_modules_lock_epochs(p.hub_id,NULL,p.principal_person_id,NULL);
  IF NOT EXISTS(SELECT 1 FROM trustwork.agent_serving_hub WHERE id=p.serving_binding_id AND hub_id=p.hub_id AND active) THEN
    RAISE EXCEPTION 'model serving authority withdrawn' USING ERRCODE='42501',HINT='agents.hub_provenance_unavailable';
  END IF;
  c := trustwork.agent_modules_capability_binding(p.hub_id,p_call ->> 'capabilityId');
  IF c IS NULL OR c #>> '{source,moduleKey}' IS DISTINCT FROM p_call ->> 'moduleKey'
    OR c ->> 'mandateAction' IS DISTINCT FROM p_binding ->> 'action'
    OR NOT (c -> 'contextKinds') ? (p_binding #>> '{context,kind}')
    OR c ->> 'kind' = 'govern' OR c ->> 'confirmation' IN ('first_party_form','first_party_step_up','person_each','person_each_step_up') THEN
    RAISE EXCEPTION 'model capability binding unavailable' USING ERRCODE='42501',HINT='models.capability_binding';
  END IF;
  v_reason := trustwork.agent_modules_policy_refusal(p.hub_id,p_call ->> 'capabilityId','person',false,'free');
  IF v_reason IS NOT NULL OR trustwork.agent_modules_dispatch_refusal_internal(p.hub_id,p_call ->> 'moduleKey',p_call ->> 'capabilityId',p_binding ->> 'action',p.principal_person_id,NULL,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'model capability unavailable' USING ERRCODE='42501',HINT='models.capability_unavailable';
  END IF;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_check_model_scope(jsonb,jsonb) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_check_model_scope(jsonb,jsonb) TO trustwork_app;

ALTER FUNCTION trustwork.assistant_model_check(jsonb,jsonb) RENAME TO agent_modules_model_foundation_check;
REVOKE ALL ON FUNCTION trustwork.agent_modules_model_foundation_check(jsonb,jsonb) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.assistant_model_check(p_call jsonb,p_binding jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.agent_modules_check_model_scope(p_call,p_binding);
  RETURN trustwork.agent_modules_model_foundation_check(p_call,p_binding);
END $$;
REVOKE ALL ON FUNCTION trustwork.assistant_model_check(jsonb,jsonb) FROM PUBLIC,trustwork_app,trustwork_worker;

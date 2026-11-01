-- Shared non-purchasable admission limits. Existing owning money and mandate accounting remains authoritative.
CREATE OR REPLACE FUNCTION trustwork.agent_modules_reserve_quota(p_hub uuid,p_person uuid,p_module text,p_run uuid,p_operation uuid,p_measure text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE v_doc jsonb; v_limits jsonb; v_zone text; v_from timestamptz; v_limit integer; v_used bigint; v_recorded boolean;
BEGIN
  IF p_measure NOT IN ('run','action') OR p_hub IS NULL OR p_person IS NULL OR p_run IS NULL OR p_operation IS NULL THEN RETURN 'quota_authority_missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agt-quota:' || p_hub::text || ':' || p_person::text || ':' || p_module,0));
  SELECT document INTO v_doc FROM trustwork.agent_policy_current WHERE hub_id=p_hub;
  IF v_doc IS NULL THEN
    IF (SELECT count(*) FROM trustwork.agent_engine_manifest WHERE module_key=p_module)<>1 THEN RETURN 'quota_authority_missing'; END IF;
    SELECT default_control -> 'limits' INTO v_limits FROM trustwork.agent_engine_manifest WHERE module_key=p_module;
    v_zone := 'UTC'; -- Same explicit engine default calendar as engineDefaultPolicy; not a model policy.
  ELSE
    SELECT m -> 'limits' INTO v_limits FROM jsonb_array_elements(v_doc -> 'modules') m WHERE m ->> 'moduleKey'=p_module;
    v_zone := v_doc #>> '{calendar,timeZone}';
  END IF;
  IF v_limits IS NULL OR v_zone IS NULL THEN RETURN 'quota_authority_missing'; END IF;
  SELECT EXISTS(SELECT 1 FROM trustwork.agent_runtime_usage WHERE hub_id=p_hub AND principal_person_id=p_person
    AND module_key=p_module AND measure=p_measure AND operation_id=p_operation AND run_id=p_run) INTO v_recorded;
  -- A cancelled/completed outer run cannot free unresolved effects. A settled model/intent does free occupied
  -- capacity, even if an outer conversation has not yet written its terminal projection. Never count money as actions.
  IF p_measure='run' THEN
    SELECT count(DISTINCT u.run_id) INTO v_used FROM trustwork.agent_runtime_usage u JOIN trustwork.run r ON r.id=u.run_id
    WHERE u.hub_id=p_hub AND u.principal_person_id=p_person AND u.module_key=p_module AND u.measure='run' AND u.run_id<>p_run
      AND (EXISTS(SELECT 1 FROM trustwork.model_call m WHERE m.run_id=u.run_id AND m.invoked AND m.state='outcome_unknown')
        OR EXISTS(SELECT 1 FROM trustwork.action_intent i WHERE i.run_id=u.run_id AND i.state IN ('executing','pending','outcome_unknown','reconciling'))
        OR (r.state NOT IN ('completed','failed','cancelled')
          AND NOT EXISTS(SELECT 1 FROM trustwork.model_call m WHERE m.run_id=u.run_id)
          AND NOT EXISTS(SELECT 1 FROM trustwork.action_intent i WHERE i.run_id=u.run_id)));
    IF (v_limits ->> 'concurrentRuns') IS NULL OR v_used >= (v_limits ->> 'concurrentRuns')::integer THEN RETURN 'quota_concurrent'; END IF;
  END IF;
  IF v_recorded THEN RETURN NULL; END IF;
  v_from := date_trunc('day',clock_timestamp() AT TIME ZONE v_zone) AT TIME ZONE v_zone;
  v_limit := (v_limits ->> CASE WHEN p_measure='run' THEN 'runsPerDay' ELSE 'actionsPerDay' END)::integer;
  SELECT count(*) INTO v_used FROM trustwork.agent_runtime_usage WHERE hub_id=p_hub AND principal_person_id=p_person
    AND module_key=p_module AND measure=p_measure AND recorded_at>=v_from;
  IF v_limit IS NULL OR v_used>=v_limit THEN RETURN 'quota_' || p_measure || '_daily'; END IF;
  INSERT INTO trustwork.agent_runtime_usage(hub_id,principal_person_id,module_key,measure,operation_id,run_id)
    VALUES(p_hub,p_person,p_module,p_measure,p_operation,p_run);
  RETURN NULL;
END $$;

ALTER FUNCTION trustwork.models_admit(text,uuid) RENAME TO agent_modules_model_admit_foundation;
REVOKE ALL ON FUNCTION trustwork.agent_modules_model_admit_foundation(text,uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.models_admit(p_operation text,p_token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE r trustwork.model_call%ROWTYPE; v_reason text;
BEGIN
  -- Savepoint rolls back one-use admission AND either quota measure on denial or crash. Recovery still uses the
  -- original operation and knows this was never invoked; existing reservation closure stays with its owning service.
  BEGIN
    IF NOT trustwork.agent_modules_model_admit_foundation(p_operation,p_token) THEN RETURN false; END IF;
    SELECT * INTO r FROM trustwork.model_call WHERE operation_id=p_operation AND principal_id=trustwork.current_person_id();
    v_reason := trustwork.agent_modules_reserve_quota((r.request ->> 'hubId')::uuid,r.principal_id,r.request ->> 'moduleKey',r.run_id,r.run_id,'run');
    IF v_reason IS NULL THEN v_reason := trustwork.agent_modules_reserve_quota((r.request ->> 'hubId')::uuid,r.principal_id,r.request ->> 'moduleKey',r.run_id,r.mandate_use_id,'action'); END IF;
    IF v_reason IS NOT NULL THEN RAISE EXCEPTION 'runtime protection limit' USING ERRCODE='PAG01',HINT=v_reason; END IF;
    RETURN true;
  EXCEPTION WHEN SQLSTATE 'PAG01' THEN RETURN false;
  END;
END $$;
REVOKE ALL ON FUNCTION trustwork.models_admit(text,uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.models_admit(text,uuid) TO trustwork_app;

ALTER FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) RENAME TO agent_modules_begin_bound_attempt;
REVOKE ALL ON FUNCTION trustwork.agent_modules_begin_bound_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.assistant_begin_attempt(p_intent uuid,p_job uuid,p_hub uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_result jsonb; i trustwork.action_intent%ROWTYPE; p trustwork.agent_intent_provenance%ROWTYPE; v_reason text;
BEGIN
  BEGIN
    v_result := trustwork.agent_modules_begin_bound_attempt(p_intent,p_job,p_hub,p_fence);
    IF v_result ->> 'status'<>'dispatch' THEN RETURN v_result; END IF;
    SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
    SELECT * INTO p FROM trustwork.agent_intent_provenance WHERE action_intent_id=p_intent;
    v_reason := trustwork.agent_modules_reserve_quota(p.hub_id,p.principal_person_id,i.module_key,i.run_id,i.run_id,'run');
    IF v_reason IS NULL THEN v_reason := trustwork.agent_modules_reserve_quota(p.hub_id,p.principal_person_id,i.module_key,i.run_id,i.id,'action'); END IF;
    IF v_reason IS NOT NULL THEN RAISE EXCEPTION 'runtime protection limit' USING ERRCODE='PAG01',HINT=v_reason; END IF;
    RETURN v_result;
  EXCEPTION WHEN SQLSTATE 'PAG01' THEN
    -- No attempt escaped this savepoint. Unknown/pending intents never enter this path; their holds survive.
    PERFORM trustwork.assistant_finish_intent(p_intent,'revoked','recheck: ' || v_reason,'recheck:' || v_reason);
    RETURN jsonb_build_object('status','refused','reason',v_reason);
  END;
END $$;
REVOKE ALL ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) TO trustwork_worker;

-- LLM-001: serialize AST cancellation/recovery with model creation and one-use admission.
-- Keep the existing accounting commands intact behind internal, non-runtime wrappers.
ALTER FUNCTION trustwork.models_begin(jsonb,jsonb,text,jsonb,jsonb,integer) RENAME TO models_begin_reserved;
REVOKE EXECUTE ON FUNCTION trustwork.models_begin_reserved(jsonb,jsonb,text,jsonb,jsonb,integer) FROM trustwork_app;
CREATE FUNCTION trustwork.models_begin(p_request jsonb, p_binding jsonb, p_digest text, p_route jsonb, p_candidate jsonb, p_ttl integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.assistant_model_dispatch_open(p_request ->> 'operationId', (p_request ->> 'runId')::uuid) THEN
    RAISE EXCEPTION 'conversation dispatch fenced' USING ERRCODE = '42501', HINT = 'models.dispatch_closed';
  END IF;
  RETURN trustwork.models_begin_reserved(p_request,p_binding,p_digest,p_route,p_candidate,p_ttl);
END $$;

ALTER FUNCTION trustwork.models_admit(text,uuid) RENAME TO models_admit_reserved;
REVOKE EXECUTE ON FUNCTION trustwork.models_admit_reserved(text,uuid) FROM trustwork_app;
CREATE FUNCTION trustwork.models_admit(p_operation text, p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.model_call%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.model.final:' || p_operation, 0));
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation AND principal_id = trustwork.current_person_id();
  IF NOT FOUND OR NOT trustwork.assistant_model_dispatch_open(p_operation, r.run_id) THEN RETURN false; END IF;
  RETURN trustwork.models_admit_reserved(p_operation,p_token);
END $$;

ALTER FUNCTION trustwork.models_fallback(text,uuid,jsonb) RENAME TO models_fallback_reserved;
REVOKE EXECUTE ON FUNCTION trustwork.models_fallback_reserved(text,uuid,jsonb) FROM trustwork_app;
CREATE FUNCTION trustwork.models_fallback(p_operation text, p_token uuid, p_candidate jsonb) RETURNS trustwork.model_call
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.model_call%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.model.final:' || p_operation, 0));
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation AND principal_id = trustwork.current_person_id();
  IF NOT FOUND OR NOT trustwork.assistant_model_dispatch_open(p_operation, r.run_id) THEN
    RAISE EXCEPTION 'conversation dispatch fenced' USING ERRCODE = '42501', HINT = 'models.dispatch_closed';
  END IF;
  RETURN trustwork.models_fallback_reserved(p_operation,p_token,p_candidate);
END $$;

-- Receipt-only authority: authenticated owner, immutable original pins, no new context selection or dispatch.
-- Absence proves no dispatch ONLY while holding the creation lock and committing the AST fence.
CREATE FUNCTION trustwork.models_recover(p_operation text, p_binding jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.model_call%ROWTYPE; t trustwork.assistant_model_turn%ROWTYPE; receipt jsonb;
BEGIN
  PERFORM trustwork.assistant_model_check_session(p_binding);
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.model.final:' || p_operation, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('models.operation:' || p_operation, 0));
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation;
  IF FOUND AND r.principal_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'unknown operation' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  SELECT * INTO t FROM trustwork.assistant_model_turn WHERE id::text = p_operation AND person_id = trustwork.current_person_id();
  IF r.operation_id IS NULL AND t.id IS NULL THEN
    RAISE EXCEPTION 'unknown operation' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  IF t.id IS NOT NULL THEN PERFORM trustwork.assistant_fence_model_turn(t.id); END IF;
  IF r.operation_id IS NULL THEN RETURN jsonb_build_object('kind','undispatched'); END IF;
  IF r.state = 'outcome_unknown' AND NOT r.invoked THEN
    -- Admission uses this same lock: the original process cannot cross the fence after closure.
    receipt := jsonb_build_object('operationId',r.operation_id,'routeId',r.route -> 'routeId','routeVersion',r.route -> 'routeVersion',
      'model',r.candidate,'stage',r.route -> 'stage','fallbackUsed',r.candidate IS DISTINCT FROM r.route #> '{candidates,0}',
      'latencyMs',0,'inputTokens',0,'outputTokens',0,'cost',jsonb_build_object('minorUnits','0','currency',r.request #>> '{estimatedCost,currency}'),'outcome','refused');
    PERFORM trustwork.models_finish(p_operation,r.dispatch_token,receipt);
    SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation;
  END IF;
  RETURN jsonb_build_object('kind','operation','row',to_jsonb(r));
END $$;
GRANT EXECUTE ON FUNCTION trustwork.models_begin(jsonb,jsonb,text,jsonb,jsonb,integer), trustwork.models_admit(text,uuid),
  trustwork.models_fallback(text,uuid,jsonb), trustwork.models_recover(text,jsonb) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

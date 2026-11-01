-- LLM-001: one durable model operation per run, body-free pins and receipts.
-- BILL-001 and AST-001 own all budget and mandate writes, including authoritative closure.
CREATE TABLE trustwork.model_call (
  operation_id text PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  principal_id uuid NOT NULL REFERENCES trustwork.person(id),
  run_id uuid NOT NULL UNIQUE REFERENCES trustwork.run(id),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL CHECK(NOT request ? 'prompt'),
  binding jsonb NOT NULL,
  route jsonb NOT NULL,
  candidate jsonb NOT NULL,
  dispatch_token uuid NOT NULL DEFAULT trustwork.new_uuid(),
  invoked boolean NOT NULL DEFAULT false,
  reservation_id uuid,
  mandate_use_id uuid NOT NULL REFERENCES trustwork.mandate_use(id),
  provider_decision_id uuid NOT NULL REFERENCES trustwork.provider_usage(id),
  state text NOT NULL DEFAULT 'outcome_unknown' CHECK(state IN ('outcome_unknown','succeeded','failed','refused')),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz
);
ALTER TABLE trustwork.model_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.model_call FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.model_call TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY own_read ON trustwork.model_call FOR SELECT TO trustwork_app USING(principal_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.model_call TO trustwork_app;
CREATE TABLE trustwork.model_attempt_receipt (
  operation_id text NOT NULL REFERENCES trustwork.model_call(operation_id),
  dispatch_token uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES trustwork.person(id),
  candidate jsonb NOT NULL,
  receipt jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(operation_id,dispatch_token)
);
ALTER TABLE trustwork.model_attempt_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.model_attempt_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.model_attempt_receipt TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY own_read ON trustwork.model_attempt_receipt FOR SELECT TO trustwork_app USING(principal_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.model_attempt_receipt TO trustwork_app;
CREATE FUNCTION trustwork.models_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN RAISE EXCEPTION 'model receipts are immutable' USING ERRCODE = '23514', HINT = 'models.closed'; END $$;
CREATE TRIGGER model_receipt_guard BEFORE UPDATE OR DELETE ON trustwork.model_attempt_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.models_receipt_guard();

CREATE FUNCTION trustwork.models_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'model intents are immutable' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW.operation_id, NEW.principal_id, NEW.run_id, NEW.request_digest, NEW.request, NEW.binding, NEW.route, NEW.reservation_id, NEW.mandate_use_id, NEW.provider_decision_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.operation_id, OLD.principal_id, OLD.run_id, OLD.request_digest, OLD.request, OLD.binding, OLD.route, OLD.reservation_id, OLD.mandate_use_id, OLD.provider_decision_id, OLD.created_at)
    OR OLD.state <> 'outcome_unknown' THEN
    RAISE EXCEPTION 'model intent or receipt is immutable' USING ERRCODE = '23514', HINT = 'models.closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_call_guard BEFORE UPDATE OR DELETE ON trustwork.model_call FOR EACH ROW EXECUTE FUNCTION trustwork.models_guard();

-- Owns no foreign tables: atomic KEYS authorization + BILL hold + AST mandate use + local intent.
CREATE FUNCTION trustwork.models_begin(p_request jsonb, p_binding jsonb, p_digest text, p_route jsonb, p_candidate jsonb, p_ttl integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.model_call%ROWTYPE; b uuid; v_reservation_id uuid; decision jsonb; u uuid;
BEGIN
  IF trustwork.current_person_id() IS DISTINCT FROM (p_request ->> 'principalId')::uuid OR trustwork.current_person_id() IS NULL
    OR p_request ? 'prompt' OR p_candidate ->> 'mode' IS DISTINCT FROM 'fake' THEN
    RAISE EXCEPTION 'model context refused' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('models.operation:' || (p_request ->> 'operationId'), 0));
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_request ->> 'operationId';
  IF FOUND THEN
    IF r.principal_id IS DISTINCT FROM trustwork.current_person_id() OR r.request_digest <> p_digest THEN
      RAISE EXCEPTION 'model operation conflict' USING ERRCODE = '23505', HINT = 'validation.idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('fresh', false, 'row', to_jsonb(r));
  END IF;
  b := trustwork.assistant_model_check(p_request, p_binding);
  u := trustwork.assistant_model_reserve_use(p_request, p_binding);
  -- One call per run makes the existing mandate per-action ceiling also the run ceiling.
  IF (p_request #>> '{estimatedCost,minorUnits}')::bigint > 0 THEN
    SELECT id INTO v_reservation_id FROM trustwork.billing_reserve(b, 'platform', (p_request #>> '{estimatedCost,minorUnits}')::bigint,
      p_request #>> '{estimatedCost,currency}', (p_request ->> 'runId')::uuid, 'model:' || (p_request ->> 'operationId'),
      CASE WHEN p_binding #>> '{context,kind}' = 'project' THEN (p_binding #>> '{context,id}')::uuid ELSE NULL END, make_interval(secs => p_ttl));
    PERFORM trustwork.billing_hold_for_effect(v_reservation_id);
  END IF;
  decision := trustwork.providers_authorize_call(jsonb_build_object(
    'hubId',p_request -> 'hubId','job',p_request -> 'job','moduleKey',p_request -> 'moduleKey','extensionId',p_request -> 'extensionId',
    'pipelineId',p_request -> 'pipelineId','dataClasses',p_request -> 'dataClasses','estimatedCost',p_request -> 'estimatedCost','requestRef',p_request -> 'operationId'), false);
  IF decision ->> 'allowed' IS DISTINCT FROM 'true' OR decision ->> 'routeId' IS DISTINCT FROM p_route ->> 'routeId'
    OR decision -> 'routeVersion' IS DISTINCT FROM p_route -> 'routeVersion' OR decision -> 'limits' IS DISTINCT FROM p_route -> 'limits'
    OR p_route ->> 'stage' <> 'current' OR decision #> '{candidates,0}' IS DISTINCT FROM p_candidate THEN
    RAISE EXCEPTION 'pinned route no longer allowed' USING ERRCODE = '42501', HINT = 'models.route_changed';
  END IF;
  INSERT INTO trustwork.model_call(operation_id,principal_id,run_id,request_digest,request,binding,route,candidate,reservation_id,mandate_use_id,provider_decision_id)
    VALUES(p_request ->> 'operationId',trustwork.current_person_id(),(p_request ->> 'runId')::uuid,p_digest,p_request,p_binding,p_route,p_candidate,v_reservation_id,u,(decision ->> 'decisionId')::uuid)
    RETURNING * INTO r;
  RETURN jsonb_build_object('fresh',true,'row',to_jsonb(r));
END $$;

-- Revalidate authenticated AST authority without consuming another mandate use. API also checks mandatory AGT policy.
CREATE FUNCTION trustwork.models_check_authority(p_request jsonb, p_binding jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.assistant_model_check(p_request, p_binding);
END $$;

-- Reconciliation reads a receipt, never executes an action. A revoked mandate/run does not erase an existing hold.
CREATE FUNCTION trustwork.models_check_receipt_authority(p_operation text, p_binding jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.assistant_model_check_session(p_binding);
  IF NOT EXISTS (SELECT 1 FROM trustwork.model_call WHERE operation_id = p_operation AND principal_id = trustwork.current_person_id()) THEN
    RAISE EXCEPTION 'unknown operation' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
END $$;

-- Fallback is allowed only after a definitive not-sent receipt. This initial fake-only integration has zero operator
-- cost by the existing KEYS contract. Paid fallback hold transfer remains disabled, never silently under-reserved.
CREATE FUNCTION trustwork.models_fallback(p_operation text, p_token uuid, p_candidate jsonb) RETURNS trustwork.model_call
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.model_call%ROWTYPE; d jsonb;
BEGIN
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation AND principal_id = trustwork.current_person_id();
  IF FOUND THEN
    PERFORM trustwork.assistant_model_lock_use(r.mandate_use_id);
    SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation FOR UPDATE;
  END IF;
  IF NOT FOUND OR r.state <> 'outcome_unknown' OR r.dispatch_token <> p_token OR p_candidate ->> 'mode' IS DISTINCT FROM 'fake'
    OR NOT r.route -> 'candidates' @> jsonb_build_array(p_candidate) THEN
    RAISE EXCEPTION 'model operation unavailable' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  PERFORM trustwork.assistant_model_check(r.request,r.binding);
  d := trustwork.providers_authorize_call(jsonb_build_object('hubId',r.request -> 'hubId','job',r.request -> 'job','moduleKey',r.request -> 'moduleKey',
    'extensionId',r.request -> 'extensionId','pipelineId',r.request -> 'pipelineId','dataClasses',r.request -> 'dataClasses',
    'estimatedCost',r.request -> 'estimatedCost','requestRef',r.operation_id), true);
  IF d ->> 'allowed' IS DISTINCT FROM 'true' OR d ->> 'routeId' IS DISTINCT FROM r.route ->> 'routeId'
    OR d -> 'routeVersion' IS DISTINCT FROM r.route -> 'routeVersion' OR NOT d -> 'candidates' @> jsonb_build_array(p_candidate) THEN
    RAISE EXCEPTION 'fallback denied' USING ERRCODE = '42501', HINT = 'models.route_changed';
  END IF;
  IF NOT r.invoked OR r.candidate = p_candidate OR EXISTS (
    SELECT 1 FROM trustwork.model_attempt_receipt WHERE operation_id = p_operation AND candidate = p_candidate
  ) THEN RAISE EXCEPTION 'fallback requires a new candidate after no-effect evidence' USING ERRCODE = '23514', HINT = 'models.receipt'; END IF;
  INSERT INTO trustwork.model_attempt_receipt(operation_id,dispatch_token,principal_id,candidate,receipt)
    VALUES(r.operation_id,r.dispatch_token,r.principal_id,r.candidate,jsonb_build_object('kind','not_sent'));
  UPDATE trustwork.model_call SET candidate = p_candidate, invoked = false, dispatch_token = trustwork.new_uuid() WHERE operation_id = p_operation RETURNING * INTO r;
  RETURN r;
END $$;

-- A one-use fence between the durable intent and adapter invocation. A reconciler closing a prepared intent wins;
-- the original process can never send after that closure. Once admitted, absence alone is not no-effect evidence.
CREATE FUNCTION trustwork.models_admit(p_operation text, p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.model_call%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation AND principal_id = trustwork.current_person_id();
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM trustwork.assistant_model_check(r.request,r.binding);
  UPDATE trustwork.model_call SET invoked = true WHERE operation_id = p_operation AND dispatch_token = p_token AND state = 'outcome_unknown' AND NOT invoked;
  RETURN FOUND;
END $$;

CREATE FUNCTION trustwork.models_finish(p_operation text, p_token uuid, p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.model_call%ROWTYPE; actual bigint := (p_metadata #>> '{cost,minorUnits}')::bigint; result text := p_metadata ->> 'outcome';
BEGIN
  -- Same order as begin: mandate, then model row, then budget. No model -> mandate lock inversion.
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation AND principal_id = trustwork.current_person_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown operation' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
  PERFORM trustwork.assistant_model_lock_use(r.mandate_use_id);
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id = p_operation FOR UPDATE;
  IF r.dispatch_token <> p_token OR p_metadata ->> 'operationId' IS DISTINCT FROM r.operation_id
    OR p_metadata -> 'model' IS DISTINCT FROM r.candidate OR p_metadata ->> 'routeId' IS DISTINCT FROM r.route ->> 'routeId'
    OR p_metadata -> 'routeVersion' IS DISTINCT FROM r.route -> 'routeVersion' OR p_metadata -> 'stage' IS DISTINCT FROM r.route -> 'stage'
    OR p_metadata #>> '{cost,currency}' IS DISTINCT FROM r.request #>> '{estimatedCost,currency}'
    OR actual IS NULL OR actual < 0 OR actual > (r.request #>> '{estimatedCost,minorUnits}')::bigint
    OR result IS NULL OR result NOT IN ('succeeded','failed','refused','outcome_unknown')
    OR (result IN ('failed','refused') AND actual <> 0)
    OR (p_metadata -> 'cost') - ARRAY['minorUnits','currency'] <> '{}'::jsonb
    OR jsonb_typeof(p_metadata -> 'latencyMs') IS DISTINCT FROM 'number'
    OR (p_metadata ->> 'latencyMs')::bigint < 0
    OR jsonb_typeof(p_metadata -> 'inputTokens') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_metadata -> 'outputTokens') IS DISTINCT FROM 'number'
    OR p_metadata -> 'fallbackUsed' IS DISTINCT FROM to_jsonb(r.candidate IS DISTINCT FROM r.route #> '{candidates,0}')
    OR NOT p_metadata ?& ARRAY['operationId','routeId','routeVersion','model','stage','fallbackUsed','latencyMs','inputTokens','outputTokens','cost','outcome']
    OR (p_metadata ->> 'inputTokens')::bigint NOT BETWEEN 0 AND (r.request ->> 'maxInputTokens')::bigint
    OR (p_metadata ->> 'outputTokens')::bigint NOT BETWEEN 0 AND (r.request ->> 'maxOutputTokens')::bigint
    OR p_metadata - ARRAY['operationId','routeId','routeVersion','model','stage','fallbackUsed','latencyMs','inputTokens','outputTokens','cost','outcome'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid receipt' USING ERRCODE = '23514', HINT = 'models.receipt';
  END IF;
  IF r.state <> 'outcome_unknown' THEN
    IF r.metadata IS DISTINCT FROM p_metadata THEN RAISE EXCEPTION 'conflicting receipt' USING ERRCODE = '23514', HINT = 'models.closed'; END IF;
    RETURN r.metadata;
  END IF;
  IF result <> 'outcome_unknown' THEN
    INSERT INTO trustwork.model_attempt_receipt(operation_id,dispatch_token,principal_id,candidate,receipt)
      VALUES(r.operation_id,r.dispatch_token,r.principal_id,r.candidate,p_metadata);
    IF r.reservation_id IS NOT NULL THEN
      PERFORM trustwork.billing_close_from_outcome(r.reservation_id,result = 'succeeded',actual,'model:' || r.operation_id);
    END IF;
    PERFORM trustwork.assistant_model_close_use(r.mandate_use_id,actual,result <> 'succeeded');
    IF result = 'succeeded' THEN
      PERFORM trustwork.providers_settle_call(r.provider_decision_id,(r.candidate ->> 'connectionId')::uuid,r.candidate ->> 'modelId','succeeded',actual,
        (p_metadata ->> 'inputTokens')::integer,(p_metadata ->> 'outputTokens')::integer,NULL,NULL);
    ELSE
      PERFORM trustwork.providers_release_call(r.provider_decision_id);
    END IF;
  END IF;
  UPDATE trustwork.model_call SET state = result,metadata = p_metadata,settled_at = CASE WHEN result = 'outcome_unknown' THEN NULL ELSE clock_timestamp() END WHERE operation_id = p_operation;
  RETURN p_metadata;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.models_begin(jsonb,jsonb,text,jsonb,jsonb,integer), trustwork.models_check_authority(jsonb,jsonb), trustwork.models_check_receipt_authority(text,jsonb),
  trustwork.models_fallback(text,uuid,jsonb), trustwork.models_admit(text,uuid), trustwork.models_finish(text,uuid,jsonb) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

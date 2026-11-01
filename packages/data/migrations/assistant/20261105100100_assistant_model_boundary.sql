-- AST-001 / LLM-001: authoritative model context and conversation commit boundary.
-- Internal helpers are not executable by runtime roles; model commands call them inside their owning transaction.
CREATE FUNCTION trustwork.assistant_model_check_session(p_binding jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL OR NOT EXISTS (
    SELECT 1 FROM trustwork.session s JOIN trustwork.person p ON p.id = s.person_id
    WHERE s.id = (p_binding ->> 'sessionId')::uuid AND s.person_id = trustwork.current_person_id() AND s.revoked_at IS NULL
      AND s.idle_expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()
      AND p.authz_epoch = (p_binding ->> 'authzEpoch')::integer
  ) THEN RAISE EXCEPTION 'authenticated receipt context required' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
END $$;

CREATE FUNCTION trustwork.assistant_model_check(p_call jsonb, p_binding jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  m trustwork.mandate%ROWTYPE; r trustwork.run%ROWTYPE; b uuid;
  person uuid := trustwork.current_person_id();
  action text := p_binding ->> 'action';
  v_context_kind text := p_binding #>> '{context,kind}';
  v_context_id uuid := (p_binding #>> '{context,id}')::uuid;
BEGIN
  IF person IS NULL OR person IS DISTINCT FROM (p_call ->> 'principalId')::uuid OR NOT EXISTS (
    SELECT 1 FROM trustwork.session s JOIN trustwork.person p ON p.id = s.person_id
    WHERE s.id = (p_binding ->> 'sessionId')::uuid AND s.person_id = person AND s.revoked_at IS NULL
      AND s.idle_expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()
      AND p.authz_epoch = (p_binding ->> 'authzEpoch')::integer
  ) THEN
    RAISE EXCEPTION 'authenticated model context required' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  m := trustwork.assistant_lock_live_mandate((p_call ->> 'mandateId')::uuid, (p_call ->> 'mandateRevision')::integer, action);
  SELECT * INTO r FROM trustwork.run WHERE id = (p_call ->> 'runId')::uuid FOR UPDATE;
  IF NOT FOUND OR r.principal_person_id <> person OR r.state IN ('completed', 'failed', 'cancelled')
     OR (r.mandate_id IS NOT NULL AND r.mandate_id <> m.id) THEN
    RAISE EXCEPTION 'unknown active run' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  -- Supported initial context: own profile or a currently owned/participated project, exact confirmed context.
  -- Selectors, company representation, conditional or human-approved model work need their owning resolver.
  IF action IS NULL OR action NOT IN ('research', 'prepare') OR m.grantee_kind <> 'own_agent'
     OR NOT ((p_call ->> 'moduleKey') = ANY(m.module_keys))
     OR split_part(p_call ->> 'capabilityId', '.', 1) IS DISTINCT FROM p_call ->> 'moduleKey'
     OR m.snapshot #>> '{approvalPolicy,mode}' IS DISTINCT FROM 'pre_authorized'
     OR jsonb_array_length(m.snapshot -> 'conditions') <> 0
     OR NOT EXISTS (SELECT 1 FROM trustwork.mandate_context c WHERE c.mandate_id = m.id AND c.context_kind = v_context_kind AND c.context_id = v_context_id::text)
     OR NOT ((v_context_kind = 'profile' AND v_context_id = person) OR (v_context_kind = 'project'
       AND (trustwork.owns_resource('project', v_context_id) OR trustwork.participates_in_resource('project', v_context_id)))) THEN
    RAISE EXCEPTION 'model context not authorized' USING ERRCODE = '42501', HINT = 'mandate.limit';
  END IF;
  IF trustwork.assistant_dispatch_blocked((p_call ->> 'hubId')::uuid, p_call ->> 'moduleKey', action, person, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'dispatch stopped' USING ERRCODE = '42501', HINT = 'mandate.not_active';
  END IF;
  b := (m.snapshot #>> '{limits,platformBudgetId}')::uuid;
  IF b IS NULL OR NOT trustwork.billing_budget_spendable(b, 'platform') THEN
    RAISE EXCEPTION 'platform budget required' USING ERRCODE = '42501', HINT = 'mandate.budget_authority';
  END IF;
  RETURN b;
END $$;

CREATE FUNCTION trustwork.assistant_model_reserve_use(p_call jsonb, p_binding jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE m trustwork.mandate%ROWTYPE; u uuid;
BEGIN
  PERFORM trustwork.assistant_model_check(p_call, p_binding);
  SELECT * INTO m FROM trustwork.mandate WHERE id = (p_call ->> 'mandateId')::uuid FOR UPDATE;
  PERFORM trustwork.assistant_check_limits(m, (p_call #>> '{estimatedCost,minorUnits}')::bigint, p_call #>> '{estimatedCost,currency}');
  INSERT INTO trustwork.mandate_use(mandate_id, mandate_revision, action, amount_minor, currency)
    VALUES(m.id, m.revision, p_binding ->> 'action', (p_call #>> '{estimatedCost,minorUnits}')::bigint, p_call #>> '{estimatedCost,currency}') RETURNING id INTO u;
  RETURN u;
END $$;

CREATE FUNCTION trustwork.assistant_model_lock_use(p_use uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM 1 FROM trustwork.mandate m JOIN trustwork.mandate_use u ON u.mandate_id = m.id
    WHERE u.id = p_use AND m.principal_person_id = trustwork.current_person_id() FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown mandate use' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
END $$;

CREATE FUNCTION trustwork.assistant_model_close_use(p_use uuid, p_actual bigint, p_no_effect boolean) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE u trustwork.mandate_use%ROWTYPE;
BEGIN
  SELECT * INTO u FROM trustwork.mandate_use WHERE id = p_use;
  PERFORM 1 FROM trustwork.mandate WHERE id = u.mandate_id FOR UPDATE;
  IF p_actual IS NULL OR p_actual < 0 OR p_actual > u.amount_minor THEN
    RAISE EXCEPTION 'invalid model receipt' USING ERRCODE = '23514', HINT = 'mandate.limit';
  END IF;
  UPDATE trustwork.mandate_use SET amount_minor = p_actual, voided_at = CASE WHEN p_no_effect THEN clock_timestamp() ELSE NULL END WHERE id = p_use;
END $$;

CREATE TABLE trustwork.assistant_model_turn (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person(id),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  run_id uuid NOT NULL UNIQUE REFERENCES trustwork.run(id),
  asked_id uuid NOT NULL REFERENCES trustwork.conversation_turn(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(person_id, request_key),
  CHECK ((state = 'completed') = (result IS NOT NULL))
);
CREATE UNIQUE INDEX assistant_model_turn_one_pending ON trustwork.assistant_model_turn(person_id) WHERE state = 'pending';
ALTER TABLE trustwork.assistant_model_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.assistant_model_turn FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.assistant_model_turn TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY own_read ON trustwork.assistant_model_turn FOR SELECT TO trustwork_app USING(person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.assistant_model_turn TO trustwork_app;

CREATE FUNCTION trustwork.assistant_begin_model_turn(p_key text, p_digest text, p_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE person uuid := trustwork.current_person_id(); t trustwork.assistant_model_turn%ROWTYPE; r uuid; asked uuid;
BEGIN
  IF person IS NULL THEN RAISE EXCEPTION 'principal required' USING ERRCODE = '28000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.conversation:' || person::text, 0));
  SELECT * INTO t FROM trustwork.assistant_model_turn WHERE person_id = person AND request_key = p_key;
  IF FOUND THEN
    IF t.input_digest <> p_digest THEN RAISE EXCEPTION 'different conversation command' USING ERRCODE = '23505', HINT = 'validation.idempotency_conflict'; END IF;
    RETURN jsonb_build_object('fresh', false, 'turn', to_jsonb(t));
  END IF;
  IF EXISTS(SELECT 1 FROM trustwork.assistant_model_turn WHERE person_id = person AND state = 'pending') THEN
    RAISE EXCEPTION 'conversation already running' USING ERRCODE = '23514', HINT = 'validation.idempotency_in_progress';
  END IF;
  INSERT INTO trustwork.run(principal_person_id, kind) VALUES(person, 'conversation') RETURNING id INTO r;
  INSERT INTO trustwork.conversation_turn(person_id, role, content, run_id) VALUES(person, 'person', p_text, r) RETURNING id INTO asked;
  INSERT INTO trustwork.assistant_model_turn(person_id, request_key, input_digest, run_id, asked_id) VALUES(person, p_key, p_digest, r, asked) RETURNING * INTO t;
  RETURN jsonb_build_object('fresh', true, 'turn', to_jsonb(t));
END $$;

CREATE FUNCTION trustwork.assistant_finish_model_turn(p_id uuid, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.assistant_model_turn SET state = 'completed', result = p_result
    WHERE id = p_id AND person_id = trustwork.current_person_id() AND state = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation finalized or unknown' USING ERRCODE = '23514', HINT = 'validation.idempotency_in_progress'; END IF;
END $$;
CREATE FUNCTION trustwork.assistant_model_turn_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'conversation intents are immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.state <> 'pending' OR NEW.state <> 'completed' OR NEW.result IS NULL OR
    ROW(NEW.id,NEW.person_id,NEW.request_key,NEW.input_digest,NEW.run_id,NEW.asked_id,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.person_id,OLD.request_key,OLD.input_digest,OLD.run_id,OLD.asked_id,OLD.created_at) THEN
    RAISE EXCEPTION 'conversation intent or result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_model_turn_guard BEFORE UPDATE OR DELETE ON trustwork.assistant_model_turn FOR EACH ROW EXECUTE FUNCTION trustwork.assistant_model_turn_guard();
GRANT EXECUTE ON FUNCTION trustwork.assistant_begin_model_turn(text,text,text), trustwork.assistant_finish_model_turn(uuid,jsonb) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

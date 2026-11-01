-- AST-001: a local conversation may end while its external effect remains unresolved.
-- This monotonic fence shares the finalization lock with model creation/admission/recovery.
ALTER TABLE trustwork.assistant_model_turn ADD COLUMN dispatch_closed boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION trustwork.assistant_model_turn_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'conversation intents are immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.state <> 'pending' OR (OLD.dispatch_closed AND NOT NEW.dispatch_closed) OR
    ROW(NEW.id,NEW.person_id,NEW.request_key,NEW.input_digest,NEW.run_id,NEW.asked_id,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.person_id,OLD.request_key,OLD.input_digest,OLD.run_id,OLD.asked_id,OLD.created_at) OR
    NOT ((NEW.state = 'completed' AND NEW.result IS NOT NULL) OR
         (NEW.state = 'pending' AND NEW.result IS NULL AND NEW.dispatch_closed)) THEN
    RAISE EXCEPTION 'conversation intent or result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION trustwork.assistant_fence_model_turn(p_id uuid) RETURNS trustwork.assistant_model_turn
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE t trustwork.assistant_model_turn%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.model.final:' || p_id::text, 0));
  SELECT * INTO t FROM trustwork.assistant_model_turn WHERE id = p_id AND person_id = trustwork.current_person_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown conversation' USING ERRCODE = '42501', HINT = 'access.not_found'; END IF;
  IF t.state = 'pending' AND NOT t.dispatch_closed THEN
    UPDATE trustwork.assistant_model_turn SET dispatch_closed = true WHERE id = p_id RETURNING * INTO t;
  END IF;
  RETURN t;
END $$;

-- Internal, no runtime grant. A gateway-only run has no AST turn; a conversation must match its exact operation.
CREATE FUNCTION trustwork.assistant_model_dispatch_open(p_operation text, p_run uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE t trustwork.assistant_model_turn%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.model.final:' || p_operation, 0));
  SELECT * INTO t FROM trustwork.assistant_model_turn WHERE run_id = p_run OR id::text = p_operation;
  IF NOT FOUND THEN RETURN true; END IF;
  RETURN t.id::text = p_operation AND t.run_id = p_run AND t.person_id = trustwork.current_person_id()
    AND t.state = 'pending' AND NOT t.dispatch_closed;
END $$;

CREATE OR REPLACE FUNCTION trustwork.assistant_finish_model_turn(p_id uuid, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant.model.final:' || p_id::text, 0));
  UPDATE trustwork.assistant_model_turn SET state = 'completed', result = p_result, dispatch_closed = true
    WHERE id = p_id AND person_id = trustwork.current_person_id() AND state = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation finalized or unknown' USING ERRCODE = '23514', HINT = 'validation.idempotency_in_progress'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.assistant_fence_model_turn(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

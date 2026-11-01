-- PAY-001: initial durable dispatch and callback use the same settlement lock order.

CREATE OR REPLACE FUNCTION trustwork.payments_begin(p_operation uuid,p_job uuid,p_fence bigint,p_attempt text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; b jsonb;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  IF o.invoked_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id;
  b:=trustwork.payments_authority(p.agreement_id,p.requested_by,o.session_id);
  IF b<>p.binding OR NOT trustwork.payments_route_available(b,o.kind) THEN RAISE EXCEPTION 'payment route unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND leased_until>clock_timestamp()
    AND fencing_token=p_fence AND p_attempt=id::text||':'||attempt::text AND kind='payments.dispatch'
    AND payload=jsonb_build_object('operationId',p_operation) FOR UPDATE) THEN RAISE EXCEPTION 'stale payment attempt'; END IF;
  -- Same order as receipt: intent, operation, budget/reservation.
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p.id FOR UPDATE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation FOR UPDATE;
  IF o.job_id IS DISTINCT FROM p_job OR o.invoked_at IS NOT NULL OR o.state<>'queued' THEN RETURN NULL; END IF;
  PERFORM trustwork.payments_funds_guard(p.id,o.kind);
  IF o.kind='payout' AND NOT EXISTS(SELECT 1 FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid AND 'payouts'=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'payout capability unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_rail WHERE connection_id=(b->>'connectionId')::uuid AND o.kind=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'capability unavailable'; END IF;
  UPDATE trustwork.payment_operation SET state='outcome_unknown',invoked_at=clock_timestamp(),attempt_id=p_attempt,fencing_token=p_fence WHERE id=o.id;
  IF o.kind IN ('create','confirm') THEN UPDATE trustwork.payment_intent SET state='outcome_unknown' WHERE id=p.id; END IF;
  RETURN jsonb_build_object('operationId',o.id,'kind',o.kind,'binding',b,'originalProviderRef',o.original_provider_ref);
END $$;

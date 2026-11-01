-- PAY-001: a customer-action deadline changes local certainty, never financial outcome.
-- Receipt bytes remain immutable; only authoritative terminal evidence may close a hold.
CREATE FUNCTION trustwork.payments_expire_customer_action(p_operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE;
BEGIN
 SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
 IF NOT FOUND THEN RETURN; END IF;
 -- Preserve settlement order and evaluate wall time only after both locks have been acquired.
 SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id FOR UPDATE;
 SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation FOR UPDATE;
 IF o.invoked_at IS NOT NULL AND o.state='pending_customer_action'
  AND (o.customer_action_deadline IS NULL OR o.customer_action_deadline<=clock_timestamp()) THEN
  UPDATE trustwork.payment_operation SET state='outcome_unknown' WHERE id=o.id;
  IF o.kind IN ('create','confirm') AND p.state='pending_customer_action' THEN
   UPDATE trustwork.payment_intent SET state='outcome_unknown' WHERE id=p.id;
  END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_expire_customer_action(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_expire_customer_action(uuid) TO trustwork_worker;

CREATE OR REPLACE FUNCTION trustwork.payments_receipt(e jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; prior jsonb; disposition text:='applied'; st text:=e->>'state';
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=(e->>'operationId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  -- Intent first: create and confirm share a single settlement boundary.
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id FOR UPDATE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=o.id FOR UPDATE;
  IF o.invoked_at IS NULL OR st NOT IN ('succeeded','failed','pending_customer_action','requires_confirmation','outcome_unknown')
    OR e->>'kind' IS DISTINCT FROM o.kind OR e->>'connectionId' IS DISTINCT FROM p.binding->>'connectionId'
    OR e->>'connectedAccountRef' IS DISTINCT FROM p.binding->>'connectedAccountRef'
    OR e->>'amountMinor' IS DISTINCT FROM p.binding->>'amountMinor' OR e->>'currency' IS DISTINCT FROM p.binding->>'currency'
    OR e->>'evidenceMode' IS DISTINCT FROM p.binding->>'evidenceMode'
    OR e->>'originalProviderRef' IS DISTINCT FROM o.original_provider_ref
    OR coalesce(length(e->>'providerRef'),0) NOT BETWEEN 1 AND 180 OR coalesce(length(e->>'eventId'),0) NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'payment evidence binding mismatch';
  END IF;
  SELECT evidence INTO prior FROM trustwork.payment_receipt WHERE connection_id=(e->>'connectionId')::uuid AND event_id=e->>'eventId';
  IF FOUND THEN
    IF prior<>e THEN RAISE EXCEPTION 'payment delivery conflict'; END IF;
    RETURN 'duplicate';
  END IF;
  IF o.provider_ref IS NOT NULL AND o.provider_ref IS DISTINCT FROM e->>'providerRef' THEN disposition:='conflict';
  ELSIF o.state IN ('succeeded','failed') THEN
    disposition:=CASE WHEN st IN ('succeeded','failed') AND st<>o.state THEN 'conflict' ELSE 'ignored' END;
  ELSIF o.kind IN ('create','confirm') AND p.state IN ('succeeded','failed') THEN
    disposition:=CASE WHEN st IN ('succeeded','failed') AND st<>p.state THEN 'conflict' ELSE 'ignored' END;
  ELSIF o.state='pending_customer_action' AND st='requires_confirmation' THEN disposition:='ignored';
  END IF;
  INSERT INTO trustwork.inbox_receipt(provider,account,event_id) VALUES('payments',e->>'connectionId',e->>'eventId') ON CONFLICT DO NOTHING;
  INSERT INTO trustwork.payment_receipt(connection_id,event_id,operation_id,evidence,disposition) VALUES((e->>'connectionId')::uuid,e->>'eventId',o.id,e,disposition);
  IF disposition<>'applied' THEN RETURN disposition; END IF;
  -- Preserve authenticated bytes above; an expired customer action is uncertainty, never failure.
  IF st='pending_customer_action' AND ((e->>'customerActionDeadline') IS NULL
    OR (e->>'customerActionDeadline')::timestamptz<=clock_timestamp()) THEN st:='outcome_unknown'; END IF;
  UPDATE trustwork.payment_operation SET state=st,provider_ref=e->>'providerRef',customer_action_deadline=(e->>'customerActionDeadline')::timestamptz WHERE id=o.id;
  IF o.kind IN ('create','confirm') THEN
    UPDATE trustwork.payment_intent SET state=st WHERE id=p.id;
    IF st IN ('succeeded','failed') THEN
      PERFORM trustwork.billing_close_from_outcome(p.reservation_id,st='succeeded',(p.binding->>'amountMinor')::bigint,'payment:'||o.id::text);
    END IF;
  ELSIF o.kind='refund' AND st='succeeded' THEN
    PERFORM trustwork.billing_refund(p.reservation_id,(p.binding->>'amountMinor')::bigint,'payment:'||o.id::text);
  END IF;
  RETURN disposition;
END $$;

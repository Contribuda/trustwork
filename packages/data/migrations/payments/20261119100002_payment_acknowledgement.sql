-- PAY-001: a verified provider acknowledgement completes dispatch, not the payment itself.
-- Pending customer action retains its hold and recurring lookup even when the REL job is reconciled.
CREATE OR REPLACE FUNCTION trustwork.payments_reconcile_recorded(p_operation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; j trustwork.job%ROWTYPE;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO j FROM trustwork.job WHERE id=o.job_id FOR UPDATE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_receipt WHERE operation_id=o.id AND disposition='applied'
    AND evidence->>'state'<>'outcome_unknown') THEN RETURN NULL; END IF;
  IF j.state='outcome_unknown' THEN
    PERFORM trustwork.reconcile_job(j.id,CASE WHEN o.state='failed' THEN 'failed' ELSE 'succeeded' END,'payment-receipt:'||o.id::text);
  END IF;
  -- Returning NULL keeps the payment lookup active. It does not undo the dispatch acknowledgement.
  RETURN CASE WHEN o.state IN ('succeeded','failed') THEN o.state ELSE NULL END;
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_reconcile_due() RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  RETURN QUERY WITH due AS (
    SELECT o.id FROM trustwork.payment_operation o WHERE o.invoked_at IS NOT NULL
      AND ((o.state NOT IN ('succeeded','failed') AND NOT (o.kind IN ('create','confirm') AND EXISTS(
        SELECT 1 FROM trustwork.payment_intent p WHERE p.id=o.payment_id AND p.state IN ('succeeded','failed'))))
        OR EXISTS(SELECT 1 FROM trustwork.job original WHERE original.id=o.job_id AND original.state='outcome_unknown'))
      AND o.next_reconcile_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM trustwork.job j WHERE j.kind='payments.reconcile'
        AND j.payload=jsonb_build_object('operationId',o.id) AND j.state IN ('queued','leased'))
      ORDER BY o.next_reconcile_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED
  ) UPDATE trustwork.payment_operation o SET next_reconcile_at=clock_timestamp()+interval '5 minutes'
    FROM due WHERE o.id=due.id RETURNING o.id;
END $$;

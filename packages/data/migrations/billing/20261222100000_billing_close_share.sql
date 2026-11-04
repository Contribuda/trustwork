-- BILL-001 / AGT-003: closing a reservation takes its budget FOR SHARE, so two callbacks on one budget cannot deadlock.
--
-- billing_lock_effect_authority (20261121100935) holds the budget FOR SHARE through the provider callback, so a budget
-- change waits for the admitted effect. The same transaction then records the outcome, and this function took the
-- budget FOR UPDATE. Two effects of different runs on one budget each held the shared lock and each waited for the
-- other to upgrade: PostgreSQL broke the cycle with 40P01 after both provider calls, and the outcome of a real effect
-- was lost. The header of 20261130110000_agent_effect_run_lock.sql says dispatches of different runs are unaffected by
-- that deadlock. That is wrong: it fixed the run row only, and the budget row had the same upgrade. An applied migration
-- is never edited, so this correction stands here.
--
-- Serializing the dispatches instead, as that migration did for one run, would queue every effect on a budget behind
-- the slowest provider call. Nothing here needs the exclusive lock: a close changes only its own reservation, which it
-- locks FOR UPDATE, and appends ledger rows, and it reads no total. FOR SHARE still conflicts with everything that does
-- read totals or change the budget (billing_reserve, limit changes, closing the budget), so they stay serialized with
-- a close. Closes of one budget now run side by side. Only the budget lock changes; the function is otherwise identical.
CREATE OR REPLACE FUNCTION trustwork.billing_close_from_outcome(p_reservation_id uuid, p_settle boolean, p_actual_minor bigint, p_evidence text) RETURNS text
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
  v_amount bigint;
BEGIN
  IF p_reservation_id IS NULL OR coalesce(length(p_evidence), 0) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR SHARE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF v_reservation.state <> 'reserved' THEN
    RETURN v_reservation.state;
  END IF;
  IF p_settle THEN
    v_amount := least(coalesce(p_actual_minor, v_reservation.amount_minor), v_reservation.amount_minor);
    UPDATE trustwork.reservation SET state = 'settled', settled_minor = v_amount, closed_at = clock_timestamp(), evidence_ref = left(p_evidence, 200) WHERE id = p_reservation_id;
    PERFORM trustwork.billing_post_budget_movement(v_budget, p_reservation_id, 'settlement', -v_amount, left(p_evidence, 500));
    RETURN 'settled';
  END IF;
  UPDATE trustwork.reservation SET state = 'released', closed_at = clock_timestamp(), evidence_ref = left(p_evidence, 200) WHERE id = p_reservation_id;
  RETURN 'released';
END $$;

-- BILL-001 entry points requested by AST-001 (agent action workflow, packages/data/migrations/assistant). The worker
-- that observes an agent action's definitive outcome holds no principal, so `billing_settle` and `billing_release`
-- (which check the reserving person) cannot be called there. These owner-run helpers apply exactly the same rules
-- (settle only from final evidence and never above the reservation, release with evidence, a closed reservation is
-- left alone so a repeat is a no-op) and keep every read and write of the billing tables inside the billing slice
-- (payment neutrality, tests/billing/policy.test.ts). They are not granted to any runtime role: only owner-run
-- commands call them, after their own authority checks.

-- Settles (final success, actual amount capped at the reservation) or releases (no effect, revocation, cancellation)
-- one open reservation. Returns the resulting state, or NULL when there is no such reservation.
CREATE FUNCTION trustwork.billing_close_from_outcome(p_reservation_id uuid, p_settle boolean, p_actual_minor bigint, p_evidence text) RETURNS text
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
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
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

-- Whether a reservation still holds its amount (reserved and not past its expiry).
CREATE FUNCTION trustwork.billing_reservation_open(p_reservation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.reservation WHERE id = p_reservation_id AND state = 'reserved' AND expires_at > clock_timestamp())
$$;

-- Whether the current principal may spend from an active budget of this kind (the rule `billing_reserve` applies).
CREATE FUNCTION trustwork.billing_budget_spendable(p_budget_id uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce((SELECT b.status = 'active' AND b.kind = p_kind AND trustwork.billing_may_spend(b) FROM trustwork.budget b WHERE b.id = p_budget_id), false)
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- BILL-001 / LLM-001: unresolved external effects never age out of a locked budget.
-- Forward-only; ordinary finite reservations keep their existing behavior.
ALTER TABLE trustwork.reservation ADD COLUMN effect_pending boolean NOT NULL DEFAULT false;

-- Internal owning API: callers commit this hold together with a durable effect intent BEFORE dispatch.
-- Not granted directly to runtime roles; the model/assistant command supplies its authority checks.
CREATE FUNCTION trustwork.billing_hold_for_effect(p_reservation_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE r trustwork.reservation%ROWTYPE; b trustwork.budget%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND OR r.reserved_by IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  SELECT * INTO b FROM trustwork.budget WHERE id = r.budget_id FOR UPDATE;
  SELECT * INTO r FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF NOT trustwork.billing_may_spend(b) OR r.state <> 'reserved' OR (NOT r.effect_pending AND r.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'reservation cannot be held' USING ERRCODE = '23514', HINT = 'billing.reservation_closed';
  END IF;
  UPDATE trustwork.reservation SET effect_pending = true WHERE id = r.id;
END $$;

CREATE OR REPLACE FUNCTION trustwork.billing_budget_committed(p_budget_id uuid, OUT consumed bigint, OUT held bigint)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce((SELECT -sum(amount_minor) FROM trustwork.ledger_entry WHERE account_kind = 'budget' AND account_id = p_budget_id), 0)::bigint,
         coalesce((SELECT sum(amount_minor) FROM trustwork.reservation WHERE budget_id = p_budget_id AND state = 'reserved'
           AND (effect_pending OR expires_at > clock_timestamp())), 0)::bigint
$$;

CREATE OR REPLACE FUNCTION trustwork.billing_reservation_open(p_reservation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.reservation WHERE id = p_reservation_id AND state = 'reserved' AND (effect_pending OR expires_at > clock_timestamp()))
$$;


CREATE OR REPLACE FUNCTION trustwork.billing_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_frozen';
  END IF;
  IF NEW.budget_id <> OLD.budget_id OR NEW.action_intent_id <> OLD.action_intent_id OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.reserved_by <> OLD.reserved_by OR NEW.reserved_at <> OLD.reserved_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.effect_correlation_key <> OLD.effect_correlation_key OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'reservation terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_frozen';
  END IF;
  IF OLD.effect_pending AND NOT NEW.effect_pending OR (OLD.state <> 'reserved' AND NEW.effect_pending <> OLD.effect_pending) OR (OLD.effect_pending AND NEW.state = 'expired') THEN
    RAISE EXCEPTION 'effect holds require authoritative closure' USING ERRCODE = '23514', HINT = 'billing.effect_unresolved';
  END IF;
  IF OLD.state <> 'reserved' THEN
    IF NEW.state <> OLD.state OR NEW.settled_minor IS DISTINCT FROM OLD.settled_minor OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.refunded_minor < OLD.refunded_minor
       OR (NEW.refunded_minor <> OLD.refunded_minor AND OLD.state <> 'settled') THEN
      RAISE EXCEPTION 'reservation is closed' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_closed';
    END IF;
  ELSIF NEW.refunded_minor <> 0 THEN
    RAISE EXCEPTION 'only settled reservations are refunded' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_not_settled';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trustwork.billing_expire_reservations() RETURNS integer
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE trustwork.reservation SET state = 'expired', closed_at = clock_timestamp() WHERE state = 'reserved' AND NOT effect_pending AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION trustwork.billing_settle(p_reservation_id uuid, p_actual_minor bigint, p_evidence_ref text)
RETURNS trustwork.reservation LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_actual_minor IS NULL OR p_actual_minor < 0 OR coalesce(length(p_evidence_ref), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'settlement needs an amount and evidence' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_amount';
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF NOT (v_reservation.reserved_by = trustwork.current_person_id() OR trustwork.billing_may_manage_budget(v_budget)) THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_reservation.effect_pending THEN
    RAISE EXCEPTION 'effect holds require authoritative closure' USING ERRCODE = '42501', HINT = 'billing.effect_unresolved';
  END IF;
  IF v_reservation.state = 'settled' AND v_reservation.settled_minor = p_actual_minor AND v_reservation.evidence_ref = p_evidence_ref THEN
    RETURN v_reservation;
  END IF;
  IF v_reservation.state <> 'reserved' THEN
    RAISE EXCEPTION 'reservation is %', v_reservation.state USING ERRCODE = 'check_violation', HINT = 'billing.reservation_closed';
  END IF;
  IF v_reservation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'reservation expired' USING ERRCODE = 'check_violation', HINT = 'billing.reservation_expired';
  END IF;
  IF p_actual_minor > v_reservation.amount_minor THEN
    RAISE EXCEPTION 'actual exceeds the reservation; a new approval is needed' USING ERRCODE = 'check_violation', HINT = 'billing.settlement_exceeds_reservation';
  END IF;
  UPDATE trustwork.reservation SET state = 'settled', settled_minor = p_actual_minor, closed_at = clock_timestamp(), evidence_ref = p_evidence_ref
  WHERE id = p_reservation_id RETURNING * INTO v_reservation;
  PERFORM trustwork.billing_post_budget_movement(v_budget, p_reservation_id, 'settlement', -p_actual_minor, p_evidence_ref);
  RETURN v_reservation;
END $$;

CREATE OR REPLACE FUNCTION trustwork.billing_release(p_reservation_id uuid, p_evidence_ref text)
RETURNS trustwork.reservation LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF coalesce(length(p_evidence_ref), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'release needs evidence' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_amount';
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF NOT (v_reservation.reserved_by = trustwork.current_person_id() OR trustwork.billing_may_manage_budget(v_budget)) THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_reservation.effect_pending THEN
    RAISE EXCEPTION 'effect holds require authoritative closure' USING ERRCODE = '42501', HINT = 'billing.effect_unresolved';
  END IF;
  IF v_reservation.state = 'released' THEN
    RETURN v_reservation;
  END IF;
  IF v_reservation.state <> 'reserved' THEN
    RAISE EXCEPTION 'reservation is %', v_reservation.state USING ERRCODE = 'check_violation', HINT = 'billing.reservation_closed';
  END IF;
  UPDATE trustwork.reservation SET state = 'released', closed_at = clock_timestamp(), evidence_ref = p_evidence_ref WHERE id = p_reservation_id RETURNING * INTO v_reservation;
  RETURN v_reservation;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

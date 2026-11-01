-- BILL-001 internal callback fence, allocated to AGT-003 by the conductor.
-- No financial mutation, returned private data or direct runtime grant.
CREATE FUNCTION trustwork.billing_lock_effect_authority(p_reservation uuid,p_budget uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE r trustwork.reservation%ROWTYPE; b trustwork.budget%ROWTYPE;
BEGIN
  IF p_reservation IS NOT NULL THEN
    SELECT * INTO r FROM trustwork.reservation WHERE id=p_reservation;
    IF r.id IS NULL OR (p_budget IS NOT NULL AND r.budget_id<>p_budget) THEN RETURN false; END IF;
    p_budget := r.budget_id;
  END IF;
  IF p_budget IS NULL THEN RETURN false; END IF;
  SELECT * INTO b FROM trustwork.budget WHERE id=p_budget FOR SHARE;
  IF b.id IS NULL THEN RETURN false; END IF;
  IF p_reservation IS NOT NULL THEN
    SELECT * INTO r FROM trustwork.reservation WHERE id=p_reservation FOR SHARE;
    IF r.id IS NULL OR r.budget_id<>p_budget OR r.state<>'reserved' THEN RETURN false; END IF;
  END IF;
  -- Recheck the clock after BOTH locks: a reservation waiter may cross either expiry.
  IF b.status<>'active' OR b.period_from>clock_timestamp() OR b.period_to<=clock_timestamp() THEN RETURN false; END IF;
  IF p_reservation IS NOT NULL AND NOT r.effect_pending AND r.expires_at<=clock_timestamp() THEN RETURN false; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION trustwork.billing_lock_effect_authority(uuid,uuid) FROM PUBLIC,trustwork_app,trustwork_worker;

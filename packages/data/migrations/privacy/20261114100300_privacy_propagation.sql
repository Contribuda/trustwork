-- Durable delivery intent, not a claim that an external replica or retrieval index applied it.
CREATE TABLE trustwork.privacy_propagation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), request_id uuid NOT NULL, target text NOT NULL CHECK(target IN ('retrieval','federation')),
  decision_digest text NOT NULL CHECK(decision_digest ~ '^[a-f0-9]{64}$'), payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','outcome_unknown','acknowledged')),
  receipt text, created_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz,
  UNIQUE(request_id,target), CHECK ((state = 'acknowledged') = (receipt IS NOT NULL AND acknowledged_at IS NOT NULL))
);
ALTER TABLE trustwork.privacy_propagation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.privacy_propagation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON trustwork.privacy_propagation TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

CREATE FUNCTION trustwork.privacy_propagation_get(p_id uuid) RETURNS trustwork.privacy_propagation
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_row trustwork.privacy_propagation%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.privacy_propagation WHERE id=p_id;
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.privacy_propagation_record(p_id uuid, p_digest text, p_receipt text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_row trustwork.privacy_propagation%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.privacy_propagation WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_row.decision_digest IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'propagation identity mismatch' USING ERRCODE='42501';
  END IF;
  IF v_row.state='acknowledged' THEN
    IF v_row.receipt IS DISTINCT FROM p_receipt THEN RAISE EXCEPTION 'conflicting receipt' USING ERRCODE='23514'; END IF;
    RETURN;
  END IF;
  IF p_receipt IS NOT NULL AND (length(p_receipt) NOT BETWEEN 1 AND 200 OR v_row.state <> 'outcome_unknown') THEN
    RAISE EXCEPTION 'invalid receipt transition' USING ERRCODE='23514';
  END IF;
  UPDATE trustwork.privacy_propagation SET state=CASE WHEN p_receipt IS NULL THEN 'outcome_unknown' ELSE 'acknowledged' END,
    receipt=p_receipt, acknowledged_at=CASE WHEN p_receipt IS NULL THEN NULL ELSE clock_timestamp() END WHERE id=p_id;
END $$;
REVOKE EXECUTE ON FUNCTION trustwork.privacy_propagation_get(uuid),trustwork.privacy_propagation_record(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.privacy_propagation_get(uuid),trustwork.privacy_propagation_record(uuid,text,text) TO trustwork_worker;

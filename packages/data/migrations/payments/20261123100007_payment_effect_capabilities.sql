-- PAY-001: action-specific rail admission and final post-outbox wall-clock recheck.
CREATE OR REPLACE FUNCTION trustwork.payments_route_available(b jsonb,p_kind text DEFAULT 'create') RETURNS boolean LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE c trustwork.provider_connection%ROWTYPE; cfg jsonb;
BEGIN
  LOCK TABLE trustwork.kill_switch IN SHARE MODE;
  SELECT * INTO c FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid FOR SHARE;
  IF NOT FOUND OR c.status <> 'enabled' OR c.hub_id::text IS DISTINCT FROM b->>'collectingHubId'
    OR NOT ('payments' = ANY(c.capabilities)) OR (p_kind='payout' AND NOT ('payouts'=ANY(c.capabilities))) OR c.mode <> 'fake' OR b->>'evidenceMode' <> 'synthetic' THEN RETURN false; END IF;
  IF trustwork.kernel_place_restricted(c.processing_country) OR c.storage_country IS NOT NULL AND trustwork.kernel_place_restricted(c.storage_country) THEN RETURN false; END IF;
  SELECT v.payload INTO cfg FROM trustwork.hub_config_current h JOIN trustwork.hub_config_version v ON v.id=h.version_id
    WHERE h.hub_id=c.hub_id AND h.domain='payments' FOR SHARE OF h;
  IF NOT FOUND OR cfg->>'fundsHeldBy' IS DISTINCT FROM 'licensed_payment_provider'
    OR cfg->'operatorAccountInFundsFlow' IS DISTINCT FROM 'false'::jsonb OR cfg->'demoNoMoneyMoves' IS DISTINCT FROM 'true'::jsonb
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'providers') x WHERE x->>'connectionId'=c.id::text AND x->'capabilities' ? (CASE WHEN p_kind='payout' THEN 'payouts' ELSE 'payments' END)) THEN RETURN false;
  IF b->>'rail'='provider_escrow' AND cfg->>'escrowAndRetainage'<>'provider_managed' THEN RETURN false; END IF; END IF;
  IF EXISTS(SELECT 1 FROM trustwork.kill_switch WHERE state='engaged' AND (scope_kind='node' OR connection_id=c.id)) THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM trustwork.payment_rail r WHERE r.connection_id=c.id AND r.revoked_at IS NULL
    AND r.evidence_mode=b->>'evidenceMode' AND b->>'currency'=ANY(r.currencies)
    AND b->>'payerCountry'=ANY(r.countries) AND b->>'payeeCountry'=ANY(r.countries)
    AND b->>'connectedAccountCountry'=ANY(r.countries)
    AND b->>'rail'=ANY(r.rails) AND 'create'=ANY(r.capabilities) AND p_kind=ANY(r.capabilities) FOR SHARE);
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_action(p_id uuid,p_kind text,p_session uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE p trustwork.payment_intent%ROWTYPE; original trustwork.payment_operation%ROWTYPE; op uuid; b jsonb;
BEGIN
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p_id;
  IF NOT FOUND OR p.requested_by IS DISTINCT FROM trustwork.current_person_id() THEN RAISE EXCEPTION 'payment unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  b:=trustwork.payments_authority(p.agreement_id,trustwork.current_person_id(),p_session);
  IF b<>p.binding OR NOT trustwork.payments_route_available(b,p_kind) THEN RAISE EXCEPTION 'payment route unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p_id FOR UPDATE;
  IF p_kind NOT IN ('confirm','refund','payout','connected_account') THEN RAISE EXCEPTION 'invalid payment action'; END IF;
  SELECT id INTO op FROM trustwork.payment_operation WHERE payment_id=p_id AND kind=p_kind;
  IF FOUND THEN PERFORM trustwork.payments_authority(p.agreement_id,p.requested_by,p_session); RETURN op; END IF;
  SELECT * INTO original FROM trustwork.payment_operation WHERE payment_id=p_id AND kind IN ('create','confirm')
    AND (p_kind='connected_account' AND provider_ref IS NOT NULL OR state=CASE WHEN p_kind='confirm' THEN 'requires_confirmation' ELSE 'succeeded' END) ORDER BY kind LIMIT 1;
  IF NOT FOUND OR original.provider_ref IS NULL THEN RAISE EXCEPTION 'original payment outcome required' USING ERRCODE='23514', HINT='validation.schema'; END IF;
  IF p_kind IN ('refund','payout') AND EXISTS(SELECT 1 FROM trustwork.payment_operation WHERE payment_id=p_id AND kind IN ('refund','payout')) THEN
    RAISE EXCEPTION 'refund or payout already reserved' USING ERRCODE='23514', HINT='validation.schema';
  END IF;
  IF p_kind='payout' AND NOT EXISTS(SELECT 1 FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid AND 'payouts'=ANY(capabilities)) THEN RAISE EXCEPTION 'payout capability unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_rail WHERE connection_id=(b->>'connectionId')::uuid AND p_kind=ANY(capabilities)) THEN RAISE EXCEPTION 'capability unavailable'; END IF;
  PERFORM trustwork.payments_authority(p.agreement_id,p.requested_by,p_session);
  PERFORM trustwork.payments_funds_guard(p.id,p_kind);
  INSERT INTO trustwork.payment_operation(payment_id,kind,original_provider_ref,session_id) VALUES(p_id,p_kind,original.provider_ref,p_session) RETURNING id INTO op;
  INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload) VALUES('payment',p.id,1,'payments.requested',jsonb_build_object('operationId',op));
  PERFORM trustwork.payments_current_attempt(op);
  RETURN op;
END $$;

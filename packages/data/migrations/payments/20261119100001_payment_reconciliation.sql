-- PAY-001: final elapsed-time admission and recorded-outcome job reconciliation.

CREATE OR REPLACE FUNCTION trustwork.payments_dispatch_guard(p_operation uuid,p_job uuid,p_fence bigint,p_attempt text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; b jsonb;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment unavailable'; END IF;
  b:=trustwork.payments_authority(p.agreement_id,p.requested_by,o.session_id);
  IF b<>p.binding OR NOT trustwork.payments_route_available(b,o.kind) THEN RAISE EXCEPTION 'payment route unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND leased_until>clock_timestamp()
    AND fencing_token=p_fence AND p_attempt=id::text||':'||attempt::text AND kind='payments.dispatch'
    AND payload=jsonb_build_object('operationId',p_operation) FOR SHARE) THEN RAISE EXCEPTION 'stale payment attempt'; END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=p.id FOR SHARE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation FOR SHARE;
  PERFORM trustwork.payments_funds_guard(p.id,o.kind);
  IF o.job_id IS DISTINCT FROM p_job OR o.fencing_token IS DISTINCT FROM p_fence OR o.attempt_id IS DISTINCT FROM p_attempt
    OR o.invoked_at IS NULL OR o.state<>'outcome_unknown' THEN RAISE EXCEPTION 'stale payment dispatch'; END IF;
  IF o.kind='payout' AND NOT EXISTS(SELECT 1 FROM trustwork.provider_connection WHERE id=(b->>'connectionId')::uuid AND 'payouts'=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'payout capability unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM trustwork.payment_rail WHERE connection_id=(b->>'connectionId')::uuid AND o.kind=ANY(capabilities) FOR SHARE) THEN RAISE EXCEPTION 'capability unavailable'; END IF;
  -- Earlier locks can wait beyond a session, budget or lease deadline. Check time again at the final boundary.
  IF NOT EXISTS(SELECT 1 FROM trustwork.session WHERE id=o.session_id AND person_id=p.requested_by AND revoked_at IS NULL
    AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND state='leased' AND leased_until>clock_timestamp() AND fencing_token=p_fence) THEN
    RAISE EXCEPTION 'expired payment dispatch authority' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_reconcile_due() RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  RETURN QUERY WITH due AS (
    SELECT o.id FROM trustwork.payment_operation o WHERE o.invoked_at IS NOT NULL
      AND (o.state NOT IN ('succeeded','failed') OR EXISTS(SELECT 1 FROM trustwork.job original WHERE original.id=o.job_id AND original.state='outcome_unknown'))
      AND o.next_reconcile_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM trustwork.job j WHERE j.kind='payments.reconcile'
        AND j.payload=jsonb_build_object('operationId',o.id) AND j.state IN ('queued','leased'))
      ORDER BY o.next_reconcile_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED
  ) UPDATE trustwork.payment_operation o SET next_reconcile_at=clock_timestamp()+interval '5 minutes'
    FROM due WHERE o.id=due.id RETURNING o.id;
END $$;

-- An authenticated terminal receipt also resolves a REL job parked after the receipt committed but before ACK.
-- Job first, then read immutable terminal evidence; never invert the dispatch/receipt row lock order.
CREATE FUNCTION trustwork.payments_reconcile_recorded(p_operation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; j trustwork.job%ROWTYPE;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO j FROM trustwork.job WHERE id=o.job_id FOR UPDATE;
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  IF o.state NOT IN ('succeeded','failed') OR NOT EXISTS(SELECT 1 FROM trustwork.payment_receipt
    WHERE operation_id=o.id AND disposition='applied' AND evidence->>'state'=o.state) THEN RETURN NULL; END IF;
  IF j.state='outcome_unknown' THEN
    PERFORM trustwork.reconcile_job(j.id,o.state,'payment-receipt:'||o.id::text);
  END IF;
  RETURN o.state;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_reconcile_recorded(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_reconcile_recorded(uuid) TO trustwork_worker;



CREATE OR REPLACE FUNCTION trustwork.payments_authority(p_agreement uuid, p_actor uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.payment_source%ROWTYPE; m trustwork.membership%ROWTYPE; b jsonb;
BEGIN
  PERFORM 1 FROM trustwork.person WHERE id = p_actor FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM trustwork.session WHERE id = p_session AND person_id = p_actor AND revoked_at IS NULL
    AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp() FOR SHARE) THEN
    RAISE EXCEPTION 'payment authority unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  SELECT * INTO a FROM trustwork.agreement WHERE id = p_agreement FOR SHARE;
  IF NOT FOUND OR a.status <> 'accepted_by_both' THEN RAISE EXCEPTION 'payment agreement unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  IF a.buyer_person_id IS DISTINCT FROM p_actor THEN
    SELECT * INTO m FROM trustwork.membership WHERE person_id=p_actor AND company_id=a.buyer_company_id AND status='active' AND valid_from <= clock_timestamp() FOR SHARE;
    IF NOT FOUND OR NOT ('company.billing.manage' = ANY(m.permissions)) THEN RAISE EXCEPTION 'payment authority unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  END IF;
  SELECT * INTO s FROM trustwork.payment_source WHERE agreement_id=p_agreement FOR SHARE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'owning payment projection unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  b := s.binding;
  IF b->>'agreementId' IS DISTINCT FROM a.id::text OR b->>'agreementDigest' IS DISTINCT FROM a.accepted_terms_digest
    OR (b->>'offerVersion')::integer IS DISTINCT FROM a.offer_version OR (b->>'requestVersion')::integer IS DISTINCT FROM a.request_version
    OR b->'payer'->>'id' IS DISTINCT FROM coalesce(a.buyer_person_id,a.buyer_company_id)::text
    OR b->'payee'->>'id' IS DISTINCT FROM coalesce(a.seller_person_id,a.seller_company_id)::text
    OR b->'payer'->>'kind' IS DISTINCT FROM (CASE WHEN a.buyer_person_id IS NOT NULL THEN 'person' ELSE 'company' END)
    OR b->'payee'->>'kind' IS DISTINCT FROM (CASE WHEN a.seller_person_id IS NOT NULL THEN 'person' ELSE 'company' END) THEN
    RAISE EXCEPTION 'payment source mismatch' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF a.terms_kind <> 'rfq_quote' OR NOT EXISTS(SELECT 1 FROM trustwork.quote_version q
    WHERE q.id=a.quote_version_id AND q.quote_id=a.quote_id AND q.version=a.offer_version AND q.digest=a.offer_digest
    AND q.payload->'totals'->'gross'->>'minorUnits'=b->>'amountMinor'
    AND q.payload->'totals'->'gross'->>'currency'=b->>'currency') THEN
    RAISE EXCEPTION 'owning payment amount unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF trustwork.kernel_place_restricted(b->>'payerCountry') OR trustwork.kernel_place_restricted(b->>'payeeCountry') OR trustwork.kernel_place_restricted(b->>'connectedAccountCountry') THEN
    RAISE EXCEPTION 'restricted payment place' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF b->>'payerHubId' IS DISTINCT FROM b->>'payeeHubId' THEN RAISE EXCEPTION 'remote screening authority unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  IF EXISTS (SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person', b->'payer'->>'kind', b->'payee'->>'kind'],
    ARRAY[p_actor,(b->'payer'->>'id')::uuid,(b->'payee'->>'id')::uuid]) WHERE money_held OR suspended OR place_hold OR cardinality(reasons)>0) THEN
    RAISE EXCEPTION 'payment screening unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  RETURN b;
END $$;


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
    AND b->>'rail'=ANY(r.rails) AND 'create'=ANY(r.capabilities) FOR SHARE);
END $$;

-- PAY-001: capture admitted authority, then recheck it after every domain wait.
-- Existing queued operations have no captured authority and cannot acquire it retroactively.
ALTER TABLE trustwork.payment_operation ADD COLUMN admitted_authority jsonb;

CREATE OR REPLACE FUNCTION trustwork.payments_authority(p_agreement uuid, p_actor uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.payment_source%ROWTYPE; m trustwork.membership%ROWTYPE; b jsonb; actor_epoch integer;
BEGIN
  -- Membership writers lock membership, then bump person and company epochs. Use that same order.
  SELECT * INTO a FROM trustwork.agreement WHERE id=p_agreement;
  IF a.buyer_person_id IS DISTINCT FROM p_actor THEN
    SELECT * INTO m FROM trustwork.membership WHERE person_id=p_actor AND company_id=a.buyer_company_id AND status='active' FOR SHARE;
    IF NOT FOUND OR m.valid_from>clock_timestamp() OR NOT ('company.billing.manage'=ANY(m.permissions)) THEN
      RAISE EXCEPTION 'payment authority unavailable' USING ERRCODE='42501', HINT='access.forbidden';
    END IF;
  END IF;
  SELECT authz_epoch INTO actor_epoch FROM trustwork.person WHERE id=p_actor FOR SHARE;
  IF NOT FOUND OR (trustwork.current_person_id() IS NOT NULL AND
    (trustwork.current_person_id() IS DISTINCT FROM p_actor OR trustwork.current_authz_epoch() IS DISTINCT FROM actor_epoch)) THEN
    RAISE EXCEPTION 'stale payment person authority' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  IF a.buyer_company_id IS NOT NULL THEN
    PERFORM 1 FROM trustwork.company WHERE id=a.buyer_company_id FOR SHARE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.session WHERE id=p_session AND person_id=p_actor AND revoked_at IS NULL
    AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp() FOR SHARE) THEN
    RAISE EXCEPTION 'payment authority unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  SELECT * INTO a FROM trustwork.agreement WHERE id=p_agreement FOR SHARE;
  IF NOT FOUND OR a.status<>'accepted_by_both' THEN
    RAISE EXCEPTION 'payment agreement unavailable' USING ERRCODE='42501', HINT='access.forbidden';
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
  IF b->>'payerHubId' IS DISTINCT FROM b->>'payeeHubId' OR b->>'collectingHubId' IS DISTINCT FROM b->>'payerHubId' THEN RAISE EXCEPTION 'remote screening authority unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
  IF EXISTS (SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person', b->'payer'->>'kind', b->'payee'->>'kind'],
    ARRAY[p_actor,(b->'payer'->>'id')::uuid,(b->'payee'->>'id')::uuid]) WHERE money_held OR suspended OR place_hold OR cardinality(reasons)>0) THEN
    RAISE EXCEPTION 'payment screening unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  -- Age has no writer: use wall time, including time spent waiting for domain locks.
  IF NOT trustwork.screening_available(clock_timestamp()) THEN
    RAISE EXCEPTION 'payment screening expired' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  RETURN b;
END $$;

CREATE FUNCTION trustwork.payments_capture_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE p trustwork.payment_intent%ROWTYPE; snapshot jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.admitted_authority IS DISTINCT FROM OLD.admitted_authority THEN RAISE EXCEPTION 'payment admission is immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=NEW.payment_id;
  PERFORM trustwork.payments_authority(p.agreement_id,p.requested_by,NEW.session_id);
  SELECT jsonb_build_object('personEpoch',pe.authz_epoch,'companyEpoch',c.authz_epoch,'membershipId',m.id)
    INTO snapshot FROM trustwork.person pe
    LEFT JOIN trustwork.company c ON p.binding->'payer'->>'kind'='company' AND c.id=(p.binding->'payer'->>'id')::uuid
    LEFT JOIN trustwork.membership m ON m.person_id=pe.id AND m.company_id=c.id AND m.status='active'
    WHERE pe.id=p.requested_by;
  NEW.admitted_authority:=snapshot;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_operation_authority BEFORE INSERT OR UPDATE ON trustwork.payment_operation
  FOR EACH ROW EXECUTE FUNCTION trustwork.payments_capture_authority();
REVOKE ALL ON FUNCTION trustwork.payments_capture_authority() FROM PUBLIC;

CREATE FUNCTION trustwork.payments_current_attempt(p_operation uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE o trustwork.payment_operation%ROWTYPE; p trustwork.payment_intent%ROWTYPE; current_authority jsonb;
BEGIN
  SELECT * INTO o FROM trustwork.payment_operation WHERE id=p_operation;
  SELECT * INTO p FROM trustwork.payment_intent WHERE id=o.payment_id;
  IF trustwork.payments_authority(p.agreement_id,p.requested_by,o.session_id) IS DISTINCT FROM p.binding
    OR NOT trustwork.payments_route_available(p.binding,o.kind) THEN
    RAISE EXCEPTION 'payment route unavailable' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  SELECT jsonb_build_object('personEpoch',pe.authz_epoch,'companyEpoch',c.authz_epoch,'membershipId',m.id)
    INTO current_authority FROM trustwork.person pe
    LEFT JOIN trustwork.company c ON p.binding->'payer'->>'kind'='company' AND c.id=(p.binding->'payer'->>'id')::uuid
    LEFT JOIN trustwork.membership m ON m.person_id=pe.id AND m.company_id=c.id AND m.status='active'
    WHERE pe.id=p.requested_by;
  IF o.admitted_authority IS NULL OR o.admitted_authority IS DISTINCT FROM current_authority THEN
    RAISE EXCEPTION 'stale payment admitted authority' USING ERRCODE='42501', HINT='access.forbidden';
  END IF;
  PERFORM trustwork.payments_funds_guard(p.id,o.kind);
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_current_attempt(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION trustwork.payments_request(p_agreement uuid,p_budget uuid,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE b jsonb; p trustwork.payment_intent%ROWTYPE; r trustwork.reservation%ROWTYPE; op uuid:=trustwork.new_uuid();
BEGIN
  b:=trustwork.payments_authority(p_agreement,trustwork.current_person_id(),p_session);
  PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(p_agreement::text));
  SELECT * INTO p FROM trustwork.payment_intent WHERE agreement_id=p_agreement;
  IF FOUND THEN PERFORM trustwork.payments_authority(p.agreement_id,p.requested_by,p_session); RETURN jsonb_build_object('id',p.id,'agreementId',p.agreement_id,'state',p.state,'amountMinor',p.binding->>'amountMinor','currency',p.binding->>'currency','funds',CASE p.binding->>'evidenceMode' WHEN 'synthetic' THEN 'synthetic_no_money_moves' ELSE 'provider_evidence_only' END); END IF;
  IF NOT trustwork.payments_route_available(b) THEN
    INSERT INTO trustwork.payment_intent(agreement_id,binding,requested_by,session_id,state)
      VALUES(p_agreement,b,trustwork.current_person_id(),p_session,'outside_platform') RETURNING * INTO p;
  ELSE
    IF b->>'amountMinor' !~ '^[1-9][0-9]{0,17}$' THEN RAISE EXCEPTION 'invalid payment amount'; END IF;
    SELECT r0.* INTO r FROM trustwork.commercial_order co JOIN trustwork.reservation r0 ON r0.id=co.reservation_id
      JOIN trustwork.budget bu ON bu.id=r0.budget_id
      WHERE co.agreement_id=p_agreement AND co.status IN ('accepted','changed','fulfilled')
      AND co.accepted_terms_digest=b->>'agreementDigest' AND co.amount_minor=(b->>'amountMinor')::bigint AND co.currency=b->>'currency'
      AND r0.budget_id=p_budget AND bu.kind='transaction' AND r0.amount_minor=co.amount_minor AND r0.currency=co.currency FOR SHARE OF co;
    IF NOT FOUND THEN RAISE EXCEPTION 'owning order reservation required' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
    PERFORM trustwork.billing_hold_for_effect(r.id);
    INSERT INTO trustwork.payment_intent(agreement_id,binding,requested_by,session_id,reservation_id,state)
      VALUES(p_agreement,b,trustwork.current_person_id(),p_session,r.id,'queued') RETURNING * INTO p;
    INSERT INTO trustwork.payment_operation(id,payment_id,kind,session_id) VALUES(op,p.id,'create',p_session);
    INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload) VALUES('payment',p.id,1,'payments.requested',jsonb_build_object('operationId',op));
  END IF;
  PERFORM trustwork.payments_authority(p.agreement_id,p.requested_by,p_session);
  IF p.reservation_id IS NOT NULL THEN PERFORM trustwork.payments_current_attempt(op); END IF;
  INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis)
    VALUES(trustwork.current_person_id(),'payment.request','payment',p.id,'{}');
  RETURN jsonb_build_object('id',p.id,'agreementId',p.agreement_id,'state',p.state,'amountMinor',b->>'amountMinor','currency',b->>'currency','funds',CASE b->>'evidenceMode' WHEN 'synthetic' THEN 'synthetic_no_money_moves' ELSE 'provider_evidence_only' END);
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
  RETURN op;
END $$;
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
  PERFORM trustwork.payments_current_attempt(o.id);
  IF NOT EXISTS(SELECT 1 FROM trustwork.job WHERE id=p_job AND leased_until>clock_timestamp()) THEN RAISE EXCEPTION 'expired payment attempt'; END IF;
  UPDATE trustwork.payment_operation SET state='outcome_unknown',invoked_at=clock_timestamp(),attempt_id=p_attempt,fencing_token=p_fence WHERE id=o.id;
  IF o.kind IN ('create','confirm') THEN UPDATE trustwork.payment_intent SET state='outcome_unknown' WHERE id=p.id; END IF;
  RETURN jsonb_build_object('operationId',o.id,'kind',o.kind,'binding',b,'originalProviderRef',o.original_provider_ref);
END $$;

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
  PERFORM trustwork.payments_current_attempt(o.id);
END $$;


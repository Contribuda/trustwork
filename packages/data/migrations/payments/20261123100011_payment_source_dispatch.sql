-- PAY-001: consume registered source versions at every actual API/worker authority boundary.
CREATE OR REPLACE FUNCTION trustwork.payments_authority(p_agreement uuid, p_actor uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.payment_source%ROWTYPE; m trustwork.membership%ROWTYPE; b jsonb; actor_epoch integer; source_id uuid;
BEGIN
  -- Per-agreement publication and dispatch share the same gate before domain locks.
  PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(p_agreement::text));
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
  SELECT source_version_id INTO source_id FROM trustwork.payment_source_current WHERE agreement_id=p_agreement FOR SHARE;
  IF FOUND THEN
    b:=trustwork.payments_source_version_current(source_id);
  ELSE
    -- Historical owner-created synthetic fixtures remain synthetic only. No operational legacy authority.
    SELECT * INTO s FROM trustwork.payment_source WHERE agreement_id=p_agreement FOR SHARE;
    IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.binding->>'evidenceMode' IS DISTINCT FROM 'synthetic' THEN
      RAISE EXCEPTION 'owning payment projection unavailable' USING ERRCODE='42501', HINT='access.forbidden';
    END IF;
    b:=s.binding;
  END IF;
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
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;

CREATE FUNCTION trustwork.payments_source_pointer_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source pointer history cannot be erased' USING ERRCODE='23000'; END IF;
 IF TG_OP='UPDATE' AND NEW.agreement_id<>OLD.agreement_id OR EXISTS(SELECT 1 FROM trustwork.payment_intent WHERE agreement_id=NEW.agreement_id)
  OR NOT EXISTS(SELECT 1 FROM trustwork.payment_source_version WHERE id=NEW.source_version_id AND agreement_id=NEW.agreement_id) THEN
  RAISE EXCEPTION 'payment source replacement unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.payment_source_current FOR EACH ROW EXECUTE FUNCTION trustwork.payments_source_pointer_guard();
CREATE FUNCTION trustwork.payments_revoke_source(p_session uuid,p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor uuid:=trustwork.current_person_id(); epoch integer:=trustwork.current_authz_epoch(); owner_id uuid; table_name text; other_id uuid;
BEGIN
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 table_name:=CASE p_kind WHEN 'identity' THEN 'payment_identity_link_version' WHEN 'participant' THEN 'payment_participant_binding_version'
  WHEN 'account' THEN 'payment_account_binding_version' WHEN 'authorization' THEN 'payment_authorization_version' END;
 IF table_name IS NULL THEN RAISE EXCEPTION 'unknown payment source kind' USING ERRCODE='42501'; END IF;
 IF p_kind='authorization' THEN SELECT payer_id,payee_id INTO owner_id,other_id FROM trustwork.payment_authorization_version WHERE id=p_id;
 ELSE EXECUTE format('SELECT person_id FROM trustwork.%I WHERE id=$1',table_name) INTO owner_id USING p_id; END IF;
 IF owner_id IS NULL OR actor IS DISTINCT FROM owner_id AND actor IS DISTINCT FROM other_id THEN RAISE EXCEPTION 'own payment source required' USING ERRCODE='42501'; END IF;
 EXECUTE format('UPDATE trustwork.%I SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',table_name) USING p_id;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(actor,'payment.source_revoke','payment_source',p_id,'{}');
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_source_pointer_guard(),trustwork.payments_revoke_source(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_revoke_source(uuid,text,uuid) TO trustwork_app;

-- Withdrawal narrows authority immediately and never changes the financial operation or its hold.
CREATE FUNCTION trustwork.payments_staff_revoke_source(p_ctx jsonb,p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE hub uuid; actor trustwork.admin_actor; table_name text;
BEGIN
 IF p_kind='registration' THEN SELECT hub_id INTO hub FROM trustwork.payment_source_registration WHERE id=p_id; table_name:='payment_source_registration';
 ELSIF p_kind='review' THEN SELECT p.hub_id INTO hub FROM trustwork.payment_binding_review r JOIN trustwork.payment_participant_binding_version p ON p.id=r.participant_binding_id WHERE r.id=p_id; table_name:='payment_binding_review';
 ELSIF p_kind='source' THEN SELECT (binding->>'collectingHubId')::uuid INTO hub FROM trustwork.payment_source_version WHERE id=p_id; table_name:='payment_source_version';
 END IF;
 IF hub IS NULL THEN RAISE EXCEPTION 'payment source unavailable' USING ERRCODE='42501'; END IF;
 actor:=trustwork.payments_source_staff(p_ctx,'admin.payments.sources.revoke',hub);
 EXECUTE format('UPDATE trustwork.%I SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',table_name) USING p_id;
 PERFORM trustwork.admin_record(actor,p_ctx,NULL,hub,'payments.source_revoked',table_name,p_id,NULL,'{}');
 PERFORM trustwork.payments_source_staff(p_ctx,'admin.payments.sources.revoke',hub);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_staff_revoke_source(jsonb,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_staff_revoke_source(jsonb,text,uuid) TO trustwork_app;

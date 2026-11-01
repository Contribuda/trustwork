CREATE FUNCTION trustwork.payments_authorization_sources(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; payer jsonb; payee jsonb; account_facts jsonb;
 r trustwork.payment_source_registration%ROWTYPE; review_row trustwork.payment_binding_review%ROWTYPE; b uuid;
BEGIN
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE payment_authorization_version.id=p_id FOR SHARE NOWAIT;
 IF NOT FOUND OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'payment authorization unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM trustwork.agreement WHERE agreement.id=a.agreement_id AND status='accepted_by_both' AND accepted_terms_digest=a.binding->>'agreementDigest' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'accepted agreement authority unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM trustwork.commercial_order WHERE commercial_order.id=(a.snapshot->>'orderId')::uuid AND agreement_id=a.agreement_id
  AND reservation_id::text=a.snapshot->>'reservationId' AND status IN ('accepted','changed','fulfilled') AND accepted_terms_digest=a.binding->>'agreementDigest' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'owning order authority unavailable' USING ERRCODE='42501'; END IF;
 payer:=trustwork.payments_source_identity(a.payer_binding_id); payee:=trustwork.payments_source_identity(a.payee_binding_id);
 account_facts:=trustwork.payments_source_account(a.account_binding_id);
 r:=trustwork.payments_source_registration_current(a.publisher_registration_id,'publisher');
 IF payer->>'personId' IS DISTINCT FROM a.payer_id::text OR payee->>'personId' IS DISTINCT FROM a.payee_id::text
  OR payer->>'hubId' IS DISTINCT FROM payee->>'hubId' OR account_facts->>'personId' IS DISTINCT FROM payee->>'personId'
  OR account_facts->>'participantBindingId' IS DISTINCT FROM a.payee_binding_id::text
  OR r.hub_id::text IS DISTINCT FROM payer->>'hubId' OR r.connection_id::text IS DISTINCT FROM account_facts->>'connectionId' THEN
  RAISE EXCEPTION 'exact bilateral source binding unavailable' USING ERRCODE='42501';
 END IF;
 FOREACH b IN ARRAY ARRAY[a.payer_binding_id,a.payee_binding_id] LOOP
  SELECT * INTO review_row FROM trustwork.payment_binding_review WHERE participant_binding_id=b FOR SHARE NOWAIT;
  IF NOT FOUND OR review_row.revoked_at IS NOT NULL OR review_row.expires_at<=clock_timestamp()
   OR review_row.proposer_id IN (a.payer_id,a.payee_id) OR review_row.reviewer_id IN (a.payer_id,a.payee_id)
   OR b=a.payee_binding_id AND review_row.account_binding_id IS DISTINCT FROM a.account_binding_id THEN
   RAISE EXCEPTION 'independent bilateral source review unavailable' USING ERRCODE='42501';
  END IF;
 END LOOP;
 PERFORM trustwork.payments_source_places(r.hub_id,ARRAY[a.snapshot->>'deliveryPlace']);
 IF a.binding->>'payerCountry' IS DISTINCT FROM payer->>'country' OR a.binding->>'payeeCountry' IS DISTINCT FROM payee->>'country'
  OR a.binding->>'connectedAccountCountry' IS DISTINCT FROM account_facts->>'country' OR a.binding->>'connectedAccountRef' IS DISTINCT FROM account_facts->>'accountRef'
  OR a.binding->>'collectingHubId' IS DISTINCT FROM payer->>'hubId' OR a.binding->>'connectionId' IS DISTINCT FROM account_facts->>'connectionId'
  OR a.digest IS DISTINCT FROM trustwork.admin_digest(a.snapshot) THEN RAISE EXCEPTION 'source snapshot mismatch' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person','person'],ARRAY[a.payer_id,a.payee_id])
   WHERE money_held OR suspended OR place_hold OR cardinality(reasons)>0) OR NOT trustwork.screening_available(clock_timestamp()) THEN
  RAISE EXCEPTION 'bilateral screening unavailable' USING ERRCODE='42501';
 END IF;
END $$;
CREATE FUNCTION trustwork.payments_authorization_view(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE;
BEGIN
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE payment_authorization_version.id=p_id;
 IF NOT FOUND OR trustwork.current_person_id() IS NULL OR trustwork.current_person_id() NOT IN (a.payer_id,a.payee_id) THEN RAISE EXCEPTION 'payment authorization unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('id',a.id,'digest',a.digest,'agreementId',a.agreement_id,'payerId',a.payer_id,'payeeId',a.payee_id,
  'amountMinor',a.binding->>'amountMinor','currency',a.binding->>'currency','hubId',a.binding->>'collectingHubId','rail',a.binding->>'rail',
  'accountBindingId',a.account_binding_id,'expiresAt',to_char(a.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'payerAccepted',EXISTS(SELECT 1 FROM trustwork.payment_authorization_acceptance WHERE authorization_id=a.id AND person_id=a.payer_id),
  'payeeAccepted',EXISTS(SELECT 1 FROM trustwork.payment_authorization_acceptance WHERE authorization_id=a.id AND person_id=a.payee_id),
  'published',EXISTS(SELECT 1 FROM trustwork.payment_source_version WHERE authorization_id=a.id));
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_draft_authorization(p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.agreement%ROWTYPE; co trustwork.commercial_order%ROWTYPE; q trustwork.quote_version%ROWTYPE; rfq trustwork.rfq_version%ROWTYPE;
 payer jsonb; payee jsonb; account_facts jsonb; r trustwork.payment_source_registration%ROWTYPE;
 b jsonb; snapshot jsonb; id uuid:=trustwork.new_uuid(); expiration timestamptz;
BEGIN
 PERFORM trustwork.payments_source_person(trustwork.current_person_id(),p_session,trustwork.current_authz_epoch());
 SELECT * INTO a FROM trustwork.agreement WHERE agreement.id=(p_input->>'agreementId')::uuid FOR SHARE;
 IF NOT FOUND OR a.buyer_person_id IS DISTINCT FROM trustwork.current_person_id() OR a.seller_person_id IS NULL
  OR a.buyer_company_id IS NOT NULL OR a.seller_company_id IS NOT NULL OR a.status<>'accepted_by_both' OR a.terms_kind<>'rfq_quote' THEN
  RAISE EXCEPTION 'first-party immutable commercial agreement required' USING ERRCODE='42501';
 END IF;
 SELECT * INTO co FROM trustwork.commercial_order WHERE agreement_id=a.id AND status IN ('accepted','changed','fulfilled') FOR SHARE;
 SELECT * INTO q FROM trustwork.quote_version WHERE quote_version.id=a.quote_version_id;
 SELECT * INTO rfq FROM trustwork.rfq_version WHERE rfq_version.id=a.rfq_version_id;
 IF co.id IS NULL OR co.accepted_terms_digest IS DISTINCT FROM a.accepted_terms_digest OR q.digest IS DISTINCT FROM a.offer_digest
  OR q.version IS DISTINCT FROM a.offer_version OR rfq.version IS DISTINCT FROM a.request_version OR rfq.digest IS DISTINCT FROM a.request_digest
  OR q.payload->'totals'->'gross'->>'minorUnits' IS DISTINCT FROM co.amount_minor::text
  OR q.payload->'totals'->'gross'->>'currency' IS DISTINCT FROM co.currency THEN RAISE EXCEPTION 'immutable order evidence mismatch' USING ERRCODE='42501'; END IF;
 payer:=trustwork.payments_source_identity((p_input->>'payerBindingId')::uuid);
 payee:=trustwork.payments_source_identity((p_input->>'payeeBindingId')::uuid);
 account_facts:=trustwork.payments_source_account((p_input->>'accountBindingId')::uuid);
 r:=trustwork.payments_source_registration_current((p_input->>'publisherRegistrationId')::uuid,'publisher');
 expiration:=least(clock_timestamp()+interval '24 hours',(payer->>'expiresAt')::timestamptz,(payee->>'expiresAt')::timestamptz,(account_facts->>'expiresAt')::timestamptz,r.expires_at);
 b:=jsonb_build_object('agreementId',a.id,'agreementDigest',a.accepted_terms_digest,'offerVersion',a.offer_version,'requestVersion',a.request_version,
  'payer',jsonb_build_object('kind','person','id',a.buyer_person_id),'payee',jsonb_build_object('kind','person','id',a.seller_person_id),
  'collectingHubId',r.hub_id,'payerHubId',payer->>'hubId','payeeHubId',payee->>'hubId','payerCountry',payer->>'country','payeeCountry',payee->>'country',
  'currency',co.currency,'amountMinor',co.amount_minor::text,'connectionId',r.connection_id,'connectedAccountCountry',account_facts->>'country',
  'connectedAccountRef',account_facts->>'accountRef','rail',p_input->>'rail','evidenceMode','synthetic');
 snapshot:=jsonb_build_object('schemaVersion',1,'kind','payment_authorization','binding',b,'orderId',co.id,'reservationId',co.reservation_id,
  'payerBindingId',p_input->>'payerBindingId','payeeBindingId',p_input->>'payeeBindingId','accountBindingId',p_input->>'accountBindingId',
  'payerIdentityDigest',payer->>'proofDigest','payeeIdentityDigest',payee->>'proofDigest','accountEvidenceDigest',account_facts->>'proofDigest',
  'publisherRegistrationId',r.id,'publisherDigest',r.digest,'deliveryPlace',rfq.payload->'deliveryTerms'->'location'->>'region',
  'expiresAt',to_char(expiration AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 INSERT INTO trustwork.payment_authorization_version(id,agreement_id,payer_id,payee_id,payer_binding_id,payee_binding_id,account_binding_id,publisher_registration_id,snapshot,binding,digest,expires_at)
 VALUES(id,a.id,a.buyer_person_id,a.seller_person_id,(p_input->>'payerBindingId')::uuid,(p_input->>'payeeBindingId')::uuid,(p_input->>'accountBindingId')::uuid,r.id,snapshot,b,trustwork.admin_digest(snapshot),expiration);
 PERFORM trustwork.payments_authorization_sources(id);
 IF NOT trustwork.payments_route_available(b) THEN RAISE EXCEPTION 'payment source route unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(trustwork.current_person_id(),'payment.authorization_draft','payment_authorization',id,'{}');
 PERFORM trustwork.payments_source_person(trustwork.current_person_id(),p_session,trustwork.current_authz_epoch());
 PERFORM trustwork.payments_authorization_sources(id);
 RETURN trustwork.payments_authorization_view(id);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_source_version_current(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE s trustwork.payment_source_version%ROWTYPE; a trustwork.payment_authorization_version%ROWTYPE; receipt trustwork.payment_authorization_acceptance%ROWTYPE;
BEGIN
 SELECT * INTO s FROM trustwork.payment_source_version WHERE payment_source_version.id=p_id FOR SHARE NOWAIT;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'current payment source unavailable' USING ERRCODE='42501'; END IF;
 PERFORM trustwork.payments_authorization_sources(s.authorization_id);
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE payment_authorization_version.id=s.authorization_id;
 IF s.binding<>a.binding OR s.digest<>trustwork.admin_digest(jsonb_build_object('kind','payment_source','authorizationId',a.id,'authorizationDigest',a.digest,'binding',a.binding))
  OR (SELECT count(*) FROM trustwork.payment_authorization_acceptance WHERE authorization_id=a.id AND digest=a.digest AND person_id IN(a.payer_id,a.payee_id))<>2 THEN
  RAISE EXCEPTION 'bilateral payment receipts missing' USING ERRCODE='42501';
 END IF;
 FOR receipt IN SELECT * FROM trustwork.payment_authorization_acceptance WHERE authorization_id=a.id ORDER BY person_id LOOP
  PERFORM trustwork.payments_source_person(receipt.person_id,receipt.session_id,receipt.person_epoch);
 END LOOP;
 IF s.expires_at<=clock_timestamp() OR NOT trustwork.screening_available(clock_timestamp()) THEN RAISE EXCEPTION 'payment source expired after wait' USING ERRCODE='42501'; END IF;
 RETURN s.binding;
END $$;
CREATE FUNCTION trustwork.payments_publish_source(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; id uuid;
BEGIN
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE payment_authorization_version.id=p_id;
 PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(a.agreement_id::text));
 PERFORM trustwork.payments_authorization_sources(a.id);
 SELECT source_version.id INTO id FROM trustwork.payment_source_version source_version WHERE authorization_id=a.id;
 IF FOUND THEN PERFORM trustwork.payments_source_version_current(id); RETURN id; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.payment_intent WHERE agreement_id=a.agreement_id) THEN
  RAISE EXCEPTION 'original payment intent is reconciliation-only; no source replacement' USING ERRCODE='42501';
 END IF;
 INSERT INTO trustwork.payment_source_version(authorization_id,agreement_id,binding,digest,expires_at)
 VALUES(a.id,a.agreement_id,a.binding,trustwork.admin_digest(jsonb_build_object('kind','payment_source','authorizationId',a.id,'authorizationDigest',a.digest,'binding',a.binding)),a.expires_at) RETURNING payment_source_version.id INTO id;
 PERFORM trustwork.payments_source_version_current(id);
 INSERT INTO trustwork.payment_source_current(agreement_id,source_version_id) VALUES(a.agreement_id,id)
  ON CONFLICT(agreement_id) DO UPDATE SET source_version_id=excluded.source_version_id;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(trustwork.current_person_id(),'payment.source_published','payment_source',id,'{}');
 RETURN id;
END $$;
CREATE FUNCTION trustwork.payments_accept_authorization(p_session uuid,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; actor uuid:=trustwork.current_person_id(); epoch integer:=trustwork.current_authz_epoch();
BEGIN
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE payment_authorization_version.id=p_id;
 -- Same agreement gate precedes source/party/domain locks in both publication and payment dispatch.
 PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(a.agreement_id::text));
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 IF a.id IS NULL OR actor NOT IN (a.payer_id,a.payee_id) OR a.digest IS DISTINCT FROM p_digest
  OR NOT EXISTS(SELECT 1 FROM trustwork.session WHERE session.id=p_session AND authenticated_at>clock_timestamp()-interval '10 minutes') THEN
  RAISE EXCEPTION 'exact first-party authorization consent required' USING ERRCODE='42501';
 END IF;
 PERFORM trustwork.payments_authorization_sources(a.id);
 INSERT INTO trustwork.payment_authorization_acceptance(authorization_id,person_id,session_id,person_epoch,digest)
 VALUES(a.id,actor,p_session,epoch,p_digest) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM trustwork.payment_authorization_acceptance WHERE authorization_id=a.id AND person_id=actor
  AND (session_id<>p_session OR person_epoch<>epoch OR digest<>p_digest)) THEN RAISE EXCEPTION 'authorization receipt is immutable' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM trustwork.payment_authorization_acceptance WHERE authorization_id=a.id)=2 THEN PERFORM trustwork.payments_publish_source(a.id); END IF;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(actor,'payment.authorization_accept','payment_authorization',a.id,'{}');
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 PERFORM trustwork.payments_authorization_sources(a.id);
 PERFORM trustwork.payments_source_version_current(id) FROM trustwork.payment_source_version WHERE authorization_id=a.id;
 RETURN trustwork.payments_authorization_view(a.id);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_authorization_sources(uuid),trustwork.payments_authorization_view(uuid),trustwork.payments_draft_authorization(uuid,jsonb),
 trustwork.payments_source_version_current(uuid),trustwork.payments_publish_source(uuid),trustwork.payments_accept_authorization(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_authorization_view(uuid),trustwork.payments_draft_authorization(uuid,jsonb),trustwork.payments_accept_authorization(uuid,uuid,text) TO trustwork_app;

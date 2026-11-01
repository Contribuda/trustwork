-- PAY-001: explicitly activated v2 publisher, same-node payee-hub collection only.
-- Catalog gate precedes all payment admission/source/domain locks. Version1 snapshots stay version1.
CREATE FUNCTION trustwork.payments_screen_hub_current(p_hub uuid,p_parties uuid[]) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE f record; required uuid[]:='{}'; subject uuid; result jsonb:='[]';
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id=p_hub AND node_id=trustwork.jurisdiction_node() FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'local responsible hub required' USING ERRCODE='42501'; END IF;
 IF cardinality(p_parties)<>2 OR EXISTS(SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person','person'],p_parties)
  WHERE money_held OR suspended OR place_hold OR cardinality(reasons)>0) OR NOT trustwork.screening_available(clock_timestamp()) THEN
  RAISE EXCEPTION 'both original parties require current screening' USING ERRCODE='42501';
 END IF;
 -- Paused configured lists remain required: no authoritative removed-list status exists.
 FOR f IN SELECT * FROM trustwork.screening_list_freshness(clock_timestamp()) WHERE baseline OR hub_id=p_hub ORDER BY list_id LOOP
  IF f.status<>'active' OR f.state NOT IN ('fresh','warning') OR f.active_version_id IS NULL
   OR NOT trustwork.screening_list_source_current(f.list_id) THEN RAISE EXCEPTION 'responsible hub list authority unavailable' USING ERRCODE='42501'; END IF;
  required:=array_append(required,f.active_version_id);
  result:=result||jsonb_build_array(jsonb_build_object('listId',f.list_id,'versionId',f.active_version_id));
 END LOOP;
 FOREACH subject IN ARRAY p_parties LOOP
  IF NOT EXISTS(SELECT 1 FROM trustwork.screening_subject_state WHERE subject_person_id=subject AND required<@screened_versions
    AND last_outcome='clear') THEN RAISE EXCEPTION 'responsible hub list coverage unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION trustwork.payments_hub_restrictions(p_hub uuid,p_places text[]) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE place text;
BEGIN
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id=p_hub AND node_id=trustwork.jurisdiction_node() FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'same-node responsible hub required' USING ERRCODE='42501'; END IF;
 -- Reuse the existing narrowing reader to lock explicit jurisdiction and territory authority.
 PERFORM trustwork.payments_source_places(p_hub,'{}'::text[]);
 FOREACH place IN ARRAY p_places LOOP
  IF place IS NULL OR place !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' OR trustwork.hubs_place_restricted(p_hub,place) THEN
   RAISE EXCEPTION 'responsible hub restriction refuses payment' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_propose_source_adapter(p_ctx jsonb,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor trustwork.admin_actor; r trustwork.payment_source_registration%ROWTYPE; id uuid:=trustwork.new_uuid(); hub uuid:=(p_input->>'hubId')::uuid;
BEGIN
 actor:=trustwork.payments_source_staff(p_ctx,'admin.payments.adapters.propose',hub);
 IF p_input IS NULL OR p_input-ARRAY['schemaVersion','hubId','connectionId','fact','implementationDigest','algorithm','keyId','publicKey','evidenceMode','expiresAt']<>'{}'::jsonb
  OR octet_length(p_input::text)>8192 OR p_input->>'schemaVersion' IS DISTINCT FROM '1'
  OR p_input->>'algorithm' IS DISTINCT FROM 'ed25519' OR p_input->>'evidenceMode' IS DISTINCT FROM 'synthetic'
  OR coalesce(p_input->>'implementationDigest','') !~ '^[a-f0-9]{64}$'
  OR p_input->>'fact'='publisher' AND p_input->>'implementationDigest' NOT IN (encode(sha256(convert_to('synthetic-publisher-v1','UTF8')),'hex'),encode(sha256(convert_to('synthetic-publisher-v2','UTF8')),'hex'))
  OR coalesce(length(p_input->>'publicKey'),0) NOT BETWEEN 32 AND 1024 OR coalesce(length(p_input->>'keyId'),0) NOT BETWEEN 1 AND 180
  OR (p_input->>'expiresAt')::timestamptz<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM trustwork.provider_connection pc WHERE pc.id=(p_input->>'connectionId')::uuid AND pc.hub_id=hub AND pc.mode='fake' FOR SHARE NOWAIT) THEN
  RAISE EXCEPTION 'source registration contract unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO trustwork.payment_source_registration(id,hub_id,connection_id,fact,payload,digest,proposed_by,proposed_epoch,proposed_elevation_id,expires_at)
  VALUES(id,hub,(p_input->>'connectionId')::uuid,p_input->>'fact',p_input,
   trustwork.admin_digest(jsonb_build_object('kind','payment_source_registration','id',id,'payload',p_input)),
   actor.person_id,trustwork.current_authz_epoch(),actor.elevation_id,(p_input->>'expiresAt')::timestamptz) RETURNING * INTO r;
 PERFORM trustwork.admin_record(actor,p_ctx,NULL,hub,'payments.source_adapter_proposed','payment_source_registration',id,NULL,jsonb_build_object('digest',r.digest));
 PERFORM trustwork.payments_source_staff(p_ctx,'admin.payments.adapters.propose',hub);
 RETURN jsonb_build_object('id',r.id,'digest',r.digest);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_authorization_sources_v1(p_id uuid) RETURNS void
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
 IF r.payload->>'implementationDigest'<>encode(sha256(convert_to('synthetic-publisher-v1','UTF8')),'hex') OR payer->>'personId' IS DISTINCT FROM a.payer_id::text OR payee->>'personId' IS DISTINCT FROM a.payee_id::text
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

CREATE OR REPLACE FUNCTION trustwork.payments_authorization_sources(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; payer jsonb; payee jsonb; account_facts jsonb;
 r trustwork.payment_source_registration%ROWTYPE; review_row trustwork.payment_binding_review%ROWTYPE; b uuid;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE id=p_id;
 IF a.snapshot->>'schemaVersion'='1' THEN PERFORM trustwork.payments_authorization_sources_v1(p_id); RETURN; END IF;
 IF a.snapshot->>'schemaVersion' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'payment source version unavailable' USING ERRCODE='42501'; END IF;
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
 IF r.proposed_by IN(a.payer_id,a.payee_id)
  OR EXISTS(SELECT 1 FROM trustwork.payment_adapter_activation WHERE registration_id=r.id AND reviewer_id IN(a.payer_id,a.payee_id))
  OR r.payload->>'implementationDigest'<>encode(sha256(convert_to('synthetic-publisher-v2','UTF8')),'hex') OR payer->>'personId' IS DISTINCT FROM a.payer_id::text OR payee->>'personId' IS DISTINCT FROM a.payee_id::text
  OR account_facts->>'personId' IS DISTINCT FROM payee->>'personId'
  OR account_facts->>'participantBindingId' IS DISTINCT FROM a.payee_binding_id::text
  OR r.hub_id::text IS DISTINCT FROM payee->>'hubId' OR r.connection_id::text IS DISTINCT FROM account_facts->>'connectionId' THEN
  RAISE EXCEPTION 'exact bilateral source binding unavailable' USING ERRCODE='42501';
 END IF;
 FOREACH b IN ARRAY ARRAY[a.payer_binding_id,a.payee_binding_id] LOOP
  SELECT * INTO review_row FROM trustwork.payment_binding_review WHERE participant_binding_id=b FOR SHARE NOWAIT;
  IF NOT FOUND OR review_row.revoked_at IS NOT NULL OR review_row.expires_at<=clock_timestamp()
   OR review_row.proposer_id IN (a.payer_id,a.payee_id) OR review_row.reviewer_id IN (a.payer_id,a.payee_id)
   OR b=a.payee_binding_id AND review_row.account_binding_id IS DISTINCT FROM a.account_binding_id
   OR a.snapshot->'reviews'->b::text IS DISTINCT FROM jsonb_build_object('id',review_row.id,'digest',review_row.digest) THEN
   RAISE EXCEPTION 'independent bilateral source review unavailable' USING ERRCODE='42501';
  END IF;
 END LOOP;
 PERFORM trustwork.payments_hub_restrictions((payer->>'hubId')::uuid,ARRAY[payer->>'place',payee->>'place',account_facts->>'place',a.snapshot->>'deliveryPlace']);
 PERFORM trustwork.payments_hub_restrictions((payee->>'hubId')::uuid,ARRAY[payer->>'place',payee->>'place',account_facts->>'place',a.snapshot->>'deliveryPlace']);
 PERFORM trustwork.payments_screen_hub_current((payer->>'hubId')::uuid,ARRAY[a.payer_id,a.payee_id]);
 PERFORM trustwork.payments_screen_hub_current((payee->>'hubId')::uuid,ARRAY[a.payer_id,a.payee_id]);
 IF a.binding->>'payerCountry' IS DISTINCT FROM payer->>'country' OR a.binding->>'payeeCountry' IS DISTINCT FROM payee->>'country'
  OR a.binding->>'connectedAccountCountry' IS DISTINCT FROM account_facts->>'country' OR a.binding->>'connectedAccountRef' IS DISTINCT FROM account_facts->>'accountRef'
  OR a.binding->>'collectingHubId' IS DISTINCT FROM payee->>'hubId'
  OR a.binding->>'payerHubId' IS DISTINCT FROM payer->>'hubId' OR a.binding->>'payeeHubId' IS DISTINCT FROM payee->>'hubId' OR a.binding->>'connectionId' IS DISTINCT FROM account_facts->>'connectionId'
  OR a.digest IS DISTINCT FROM trustwork.admin_digest(a.snapshot) THEN RAISE EXCEPTION 'source snapshot mismatch' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person','person'],ARRAY[a.payer_id,a.payee_id])
   WHERE money_held OR suspended OR place_hold OR cardinality(reasons)>0) OR NOT trustwork.screening_available(clock_timestamp()) THEN
  RAISE EXCEPTION 'bilateral screening unavailable' USING ERRCODE='42501';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_draft_authorization(p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.agreement%ROWTYPE; co trustwork.commercial_order%ROWTYPE; q trustwork.quote_version%ROWTYPE; rfq trustwork.rfq_version%ROWTYPE;
 payer jsonb; payee jsonb; account_facts jsonb; r trustwork.payment_source_registration%ROWTYPE;
 b jsonb; snapshot jsonb; id uuid:=trustwork.new_uuid(); expiration timestamptz;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
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
 snapshot:=jsonb_build_object('schemaVersion',CASE WHEN r.payload->>'implementationDigest'=encode(sha256(convert_to('synthetic-publisher-v2','UTF8')),'hex') THEN 2 ELSE 1 END,'kind','payment_authorization','binding',b,'orderId',co.id,'reservationId',co.reservation_id,
  'payerBindingId',p_input->>'payerBindingId','payeeBindingId',p_input->>'payeeBindingId','accountBindingId',p_input->>'accountBindingId',
  'payerIdentityDigest',payer->>'proofDigest','payeeIdentityDigest',payee->>'proofDigest','accountEvidenceDigest',account_facts->>'proofDigest',
  'publisherRegistrationId',r.id,'publisherDigest',r.digest,'deliveryPlace',rfq.payload->'deliveryTerms'->'location'->>'region',
  'expiresAt',to_char(expiration AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 IF snapshot->>'schemaVersion'='2' THEN
  snapshot:=snapshot||jsonb_build_object('reviews',(SELECT jsonb_object_agg(br.participant_binding_id::text,jsonb_build_object('id',br.id,'digest',br.digest))
   FROM trustwork.payment_binding_review br WHERE br.participant_binding_id IN ((p_input->>'payerBindingId')::uuid,(p_input->>'payeeBindingId')::uuid)));
 END IF;
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

CREATE OR REPLACE FUNCTION trustwork.payments_accept_authorization(p_session uuid,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; actor uuid:=trustwork.current_person_id(); epoch integer:=trustwork.current_authz_epoch();
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
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

CREATE OR REPLACE FUNCTION trustwork.payments_publish_source(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; id uuid;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
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

CREATE OR REPLACE FUNCTION trustwork.payments_source_version_current(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE s trustwork.payment_source_version%ROWTYPE; a trustwork.payment_authorization_version%ROWTYPE; receipt trustwork.payment_authorization_acceptance%ROWTYPE;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
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
 PERFORM trustwork.payments_authorization_sources(a.id);
 RETURN s.binding;
END $$;

CREATE OR REPLACE FUNCTION trustwork.payments_authority(p_agreement uuid, p_actor uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.payment_source%ROWTYPE; m trustwork.membership%ROWTYPE; b jsonb; actor_epoch integer; source_id uuid;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
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
  IF (b->>'payerHubId' IS DISTINCT FROM b->>'payeeHubId' OR b->>'collectingHubId' IS DISTINCT FROM b->>'payerHubId')
   AND NOT EXISTS(SELECT 1 FROM trustwork.payment_source_version sv JOIN trustwork.payment_authorization_version av ON av.id=sv.authorization_id WHERE sv.id=source_id AND av.snapshot->>'schemaVersion'='2') THEN RAISE EXCEPTION 'remote screening authority unavailable' USING ERRCODE='42501', HINT='access.forbidden'; END IF;
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

REVOKE ALL ON FUNCTION trustwork.payments_screen_hub_current(uuid,uuid[]),trustwork.payments_hub_restrictions(uuid,text[]),trustwork.payments_authorization_sources_v1(uuid) FROM PUBLIC;

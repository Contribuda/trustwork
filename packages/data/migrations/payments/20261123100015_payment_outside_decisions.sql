-- PAY-001: explicit bilateral no-route decisions, never fake provider/account facts or financial effects.
ALTER TABLE trustwork.payment_source_registration ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE trustwork.payment_source_registration DROP CONSTRAINT payment_source_registration_fact_check;
ALTER TABLE trustwork.payment_source_registration ADD CHECK(fact IN ('identity_link','account','publisher','outside_platform_publisher'));
ALTER TABLE trustwork.payment_source_registration ADD CHECK((fact='outside_platform_publisher')=(connection_id IS NULL));
CREATE OR REPLACE FUNCTION trustwork.payments_propose_source_adapter(p_ctx jsonb,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor trustwork.admin_actor; r trustwork.payment_source_registration%ROWTYPE; id uuid:=trustwork.new_uuid(); hub uuid:=(p_input->>'hubId')::uuid;
BEGIN
 actor:=trustwork.payments_source_staff(p_ctx,'admin.payments.adapters.propose',hub);
 IF p_input->>'fact'='outside_platform_publisher' THEN
  IF p_input-ARRAY['schemaVersion','hubId','fact','implementationDigest','evidenceMode','expiresAt']<>'{}'::jsonb
   OR p_input->>'schemaVersion' IS DISTINCT FROM '2' OR p_input->>'evidenceMode' IS DISTINCT FROM 'synthetic'
   OR p_input->>'implementationDigest' IS DISTINCT FROM encode(sha256(convert_to('synthetic-outside-platform-publisher-v1','UTF8')),'hex')
   OR (p_input->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'outside publisher contract unavailable' USING ERRCODE='42501'; END IF;
 ELSE
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

CREATE OR REPLACE FUNCTION trustwork.payments_source_registration_current(p_id uuid,p_fact text) RETURNS trustwork.payment_source_registration
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE r trustwork.payment_source_registration%ROWTYPE;
BEGIN
 SELECT * INTO r FROM trustwork.payment_source_registration WHERE id=p_id FOR SHARE NOWAIT;
 IF NOT FOUND OR r.fact IS DISTINCT FROM p_fact OR r.revoked_at IS NOT NULL OR r.expires_at<=clock_timestamp()
  OR r.payload->>'evidenceMode' IS DISTINCT FROM 'synthetic' OR (r.fact<>'outside_platform_publisher' AND r.payload->>'algorithm' IS DISTINCT FROM 'ed25519')
  OR (r.fact='outside_platform_publisher' AND (r.payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR r.payload->>'implementationDigest' IS DISTINCT FROM encode(sha256(convert_to('synthetic-outside-platform-publisher-v1','UTF8')),'hex')))
  OR NOT EXISTS(SELECT 1 FROM trustwork.payment_adapter_activation WHERE registration_id=r.id) THEN
  RAISE EXCEPTION 'payment source registration unavailable' USING ERRCODE='42501',HINT='access.forbidden';
 END IF;
 RETURN r;
END $$;
CREATE TABLE trustwork.payment_outside_platform_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), agreement_id uuid NOT NULL REFERENCES trustwork.agreement(id),
 payer_id uuid NOT NULL REFERENCES trustwork.person(id), payee_id uuid NOT NULL REFERENCES trustwork.person(id),
 publisher_registration_id uuid NOT NULL REFERENCES trustwork.payment_source_registration(id),
 input jsonb NOT NULL, snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=16384), digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES trustwork.person(id), created_session_id uuid NOT NULL REFERENCES trustwork.session(id), created_epoch integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(payer_id<>payee_id AND created_by=payer_id), CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE trustwork.payment_outside_platform_acceptance (
 decision_id uuid NOT NULL REFERENCES trustwork.payment_outside_platform_version(id), person_id uuid NOT NULL REFERENCES trustwork.person(id),
 session_id uuid NOT NULL REFERENCES trustwork.session(id), person_epoch integer NOT NULL, digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(decision_id,person_id)
);
CREATE TRIGGER source_version_immutable BEFORE UPDATE OR DELETE ON trustwork.payment_outside_platform_version FOR EACH ROW EXECUTE FUNCTION trustwork.payments_source_version_immutable();
CREATE TRIGGER source_history_immutable BEFORE UPDATE OR DELETE ON trustwork.payment_outside_platform_acceptance FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.payment_outside_platform_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_outside_platform_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_outside_platform_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.payment_outside_platform_acceptance FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.payment_outside_platform_version FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.payment_outside_platform_acceptance FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

CREATE FUNCTION trustwork.payments_outside_current(p_session uuid,p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE d trustwork.payment_outside_platform_version%ROWTYPE; c jsonb; r trustwork.payment_source_registration%ROWTYPE; consent record;
BEGIN
 PERFORM trustwork.payments_candidate_lock();
 SELECT * INTO d FROM trustwork.payment_outside_platform_version WHERE id=p_id;
 PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(d.agreement_id::text));
 SELECT * INTO d FROM trustwork.payment_outside_platform_version WHERE id=p_id FOR SHARE NOWAIT;
 IF d.id IS NULL OR d.revoked_at IS NOT NULL OR d.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'outside decision unavailable' USING ERRCODE='42501'; END IF;
 c:=trustwork.payments_local_context(p_session,d.input);
 r:=trustwork.payments_source_registration_current(d.publisher_registration_id,'outside_platform_publisher');
 IF r.hub_id::text IS DISTINCT FROM c->>'collectingHubId' OR r.proposed_by IN(d.payer_id,d.payee_id)
  OR EXISTS(SELECT 1 FROM trustwork.payment_adapter_activation WHERE registration_id=r.id AND reviewer_id IN(d.payer_id,d.payee_id))
  OR c->'eligibility'->'candidates'<>'[]'::jsonb OR d.snapshot->'context' IS DISTINCT FROM c
  OR d.snapshot->>'publisherDigest' IS DISTINCT FROM r.digest OR d.digest IS DISTINCT FROM trustwork.admin_digest(d.snapshot)
  OR EXISTS(SELECT 1 FROM trustwork.payment_intent WHERE agreement_id=d.agreement_id)
  OR EXISTS(SELECT 1 FROM trustwork.payment_source_current WHERE agreement_id=d.agreement_id) THEN
  RAISE EXCEPTION 'verified empty route authority changed' USING ERRCODE='42501'; END IF;
 PERFORM trustwork.payments_source_person(d.created_by,d.created_session_id,d.created_epoch);
 FOR consent IN SELECT * FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=d.id LOOP
  IF consent.person_id NOT IN(d.payer_id,d.payee_id) OR consent.digest<>d.digest THEN RAISE EXCEPTION 'outside consent mismatch' USING ERRCODE='42501'; END IF;
  PERFORM trustwork.payments_source_person(consent.person_id,consent.session_id,consent.person_epoch);
 END LOOP;
 IF d.expires_at<=clock_timestamp() OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'outside decision expired after wait' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION trustwork.payments_outside_view(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE d trustwork.payment_outside_platform_version%ROWTYPE;
BEGIN
 SELECT * INTO d FROM trustwork.payment_outside_platform_version WHERE id=p_id;
 IF d.id IS NULL OR trustwork.current_person_id() IS NULL OR trustwork.current_person_id() NOT IN(d.payer_id,d.payee_id) THEN RAISE EXCEPTION 'outside decision unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('id',d.id,'agreementId',d.agreement_id,'digest',d.digest,'outcome','outside_platform','reason','no_eligible_provider',
  'amountMinor',d.snapshot->'context'->>'amountMinor','currency',d.snapshot->'context'->>'currency','collectingHubId',d.snapshot->'context'->>'collectingHubId',
  'expiresAt',to_char(d.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revoked',d.revoked_at IS NOT NULL,
  'payerAccepted',EXISTS(SELECT 1 FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=d.id AND person_id=d.payer_id),
  'payeeAccepted',EXISTS(SELECT 1 FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=d.id AND person_id=d.payee_id));
END $$;
CREATE FUNCTION trustwork.payments_draft_outside(p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE c jsonb; r trustwork.payment_source_registration%ROWTYPE; new_id uuid:=trustwork.new_uuid(); expiry timestamptz; snapshot jsonb;
BEGIN
 PERFORM trustwork.payments_candidate_lock();
 c:=trustwork.payments_local_context(p_session,p_input-ARRAY['publisherRegistrationId']);
 r:=trustwork.payments_source_registration_current((p_input->>'publisherRegistrationId')::uuid,'outside_platform_publisher');
 IF c->>'payerId' IS DISTINCT FROM trustwork.current_person_id()::text OR c->'eligibility'->'candidates'<>'[]'::jsonb THEN
  RAISE EXCEPTION 'original payer and verified empty candidate set required' USING ERRCODE='42501'; END IF;
 expiry:=least(clock_timestamp()+interval '24 hours',(c->>'factsExpireAt')::timestamptz,r.expires_at);
 snapshot:=jsonb_build_object('schemaVersion',1,'kind','outside_platform_decision','reason','no_eligible_provider','context',c,
  'publisherRegistrationId',r.id,'publisherDigest',r.digest,'expiresAt',expiry);
 INSERT INTO trustwork.payment_outside_platform_version(id,agreement_id,payer_id,payee_id,publisher_registration_id,input,snapshot,digest,created_by,created_session_id,created_epoch,expires_at)
 VALUES(new_id,(c->>'agreementId')::uuid,(c->>'payerId')::uuid,(c->>'payeeId')::uuid,r.id,p_input-ARRAY['publisherRegistrationId'],snapshot,trustwork.admin_digest(snapshot),trustwork.current_person_id(),p_session,trustwork.current_authz_epoch(),expiry);
 PERFORM trustwork.payments_outside_current(p_session,new_id);
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(trustwork.current_person_id(),'payment.outside_draft','payment_outside',new_id,'{}');
 RETURN trustwork.payments_outside_view(new_id);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'outside authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_accept_outside(p_session uuid,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE d trustwork.payment_outside_platform_version%ROWTYPE; actor uuid:=trustwork.current_person_id(); epoch integer:=trustwork.current_authz_epoch();
BEGIN
 PERFORM trustwork.payments_candidate_lock();
 SELECT * INTO d FROM trustwork.payment_outside_platform_version WHERE id=p_id;
 PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(d.agreement_id::text));
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 IF d.id IS NULL OR actor NOT IN(d.payer_id,d.payee_id) OR d.digest IS DISTINCT FROM p_digest
  OR NOT EXISTS(SELECT 1 FROM trustwork.session WHERE id=p_session AND authenticated_at>clock_timestamp()-interval '10 minutes') THEN
  RAISE EXCEPTION 'exact outside consent required' USING ERRCODE='42501'; END IF;
 PERFORM trustwork.payments_outside_current(p_session,d.id);
 IF EXISTS(SELECT 1 FROM trustwork.payment_outside_platform_version other WHERE other.agreement_id=d.agreement_id AND other.id<>d.id
  AND (SELECT count(*) FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=other.id)=2) THEN
  RAISE EXCEPTION 'immutable outside decision already accepted' USING ERRCODE='42501'; END IF;
 INSERT INTO trustwork.payment_outside_platform_acceptance(decision_id,person_id,session_id,person_epoch,digest) VALUES(d.id,actor,p_session,epoch,p_digest) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=d.id AND person_id=actor
   AND (session_id<>p_session OR person_epoch<>epoch OR digest<>p_digest)) THEN RAISE EXCEPTION 'outside receipt is immutable' USING ERRCODE='42501'; END IF;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(actor,'payment.outside_accept','payment_outside',d.id,'{}');
 PERFORM trustwork.payments_outside_current(p_session,d.id);
 RETURN trustwork.payments_outside_view(d.id);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'outside authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_agreement_settlement(p_agreement uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE d uuid;
BEGIN
 IF trustwork.current_person_id() IS NULL OR NOT EXISTS(SELECT 1 FROM trustwork.agreement WHERE id=p_agreement AND trustwork.current_person_id() IN(buyer_person_id,seller_person_id)) THEN
  RAISE EXCEPTION 'agreement settlement unavailable' USING ERRCODE='42501'; END IF;
 SELECT id INTO d FROM trustwork.payment_outside_platform_version WHERE agreement_id=p_agreement ORDER BY
  (SELECT count(*)=2 FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=payment_outside_platform_version.id) DESC,created_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('agreementId',p_agreement,'outsidePlatform',CASE WHEN d IS NULL THEN NULL ELSE trustwork.payments_outside_view(d) END);
END $$;
CREATE FUNCTION trustwork.payments_no_outside_decision(p_agreement uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM trustwork.payment_outside_platform_version d WHERE agreement_id=p_agreement
  AND (SELECT count(*) FROM trustwork.payment_outside_platform_acceptance WHERE decision_id=d.id)=2) THEN
  RAISE EXCEPTION 'accepted outside decision cannot silently become a provider payment' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_outside_current(uuid,uuid),trustwork.payments_outside_view(uuid),trustwork.payments_draft_outside(uuid,jsonb),
 trustwork.payments_accept_outside(uuid,uuid,text),trustwork.payments_agreement_settlement(uuid),trustwork.payments_no_outside_decision(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_draft_outside(uuid,jsonb),trustwork.payments_accept_outside(uuid,uuid,text),trustwork.payments_agreement_settlement(uuid) TO trustwork_app;

CREATE OR REPLACE FUNCTION trustwork.payments_publish_source(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.payment_authorization_version%ROWTYPE; id uuid;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 SELECT * INTO a FROM trustwork.payment_authorization_version WHERE payment_authorization_version.id=p_id;
 PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(a.agreement_id::text));
 PERFORM trustwork.payments_no_outside_decision(a.agreement_id);
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

CREATE OR REPLACE FUNCTION trustwork.payments_authority(p_agreement uuid, p_actor uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.payment_source%ROWTYPE; m trustwork.membership%ROWTYPE; b jsonb; actor_epoch integer; source_id uuid;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  -- Per-agreement publication and dispatch share the same gate before domain locks.
  PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(p_agreement::text));
  PERFORM trustwork.payments_no_outside_decision(p_agreement);
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

CREATE OR REPLACE FUNCTION trustwork.payments_revoke_source(p_session uuid,p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor uuid:=trustwork.current_person_id(); epoch integer:=trustwork.current_authz_epoch(); owner_id uuid; table_name text; other_id uuid;
BEGIN
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 table_name:=CASE p_kind WHEN 'identity' THEN 'payment_identity_link_version' WHEN 'participant' THEN 'payment_participant_binding_version'
  WHEN 'account' THEN 'payment_account_binding_version' WHEN 'authorization' THEN 'payment_authorization_version' WHEN 'outside' THEN 'payment_outside_platform_version' END;
 IF table_name IS NULL THEN RAISE EXCEPTION 'unknown payment source kind' USING ERRCODE='42501'; END IF;
 IF p_kind='outside' THEN SELECT payer_id,payee_id INTO owner_id,other_id FROM trustwork.payment_outside_platform_version WHERE id=p_id;
 ELSIF p_kind='authorization' THEN SELECT payer_id,payee_id INTO owner_id,other_id FROM trustwork.payment_authorization_version WHERE id=p_id;
 ELSE EXECUTE format('SELECT person_id FROM trustwork.%I WHERE id=$1',table_name) INTO owner_id USING p_id; END IF;
 IF owner_id IS NULL OR actor IS DISTINCT FROM owner_id AND actor IS DISTINCT FROM other_id THEN RAISE EXCEPTION 'own payment source required' USING ERRCODE='42501'; END IF;
 EXECUTE format('UPDATE trustwork.%I SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',table_name) USING p_id;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(actor,'payment.source_revoke','payment_source',p_id,'{}');
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;

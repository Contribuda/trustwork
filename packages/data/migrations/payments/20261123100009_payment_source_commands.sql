-- PAY-001: first-party choices, independent hub acceptance and immutable bilateral authorization.
CREATE FUNCTION trustwork.payments_source_challenge(p_session uuid,p_input jsonb,p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE c trustwork.payment_source_challenge%ROWTYPE; r trustwork.payment_source_registration%ROWTYPE;
 actor uuid:=trustwork.current_person_id(); epoch integer:=trustwork.current_authz_epoch(); ts timestamptz:=clock_timestamp();
BEGIN
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 IF p_input-ARRAY['hubId','connectionId','identityRegistrationId','accountRegistrationId','purpose']<>'{}'::jsonb
  OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$'
  OR NOT EXISTS(SELECT 1 FROM trustwork.session WHERE id=p_session AND authenticated_at>clock_timestamp()-interval '10 minutes') THEN
  RAISE EXCEPTION 'first-party payment source step-up required' USING ERRCODE='42501';
 END IF;
 r:=trustwork.payments_source_registration_current((p_input->>'identityRegistrationId')::uuid,'identity_link');
 IF r.hub_id::text IS DISTINCT FROM p_input->>'hubId' OR r.connection_id::text IS DISTINCT FROM p_input->>'connectionId' THEN
  RAISE EXCEPTION 'source issuer scope mismatch' USING ERRCODE='42501';
 END IF;
 IF p_input->>'purpose'='payment_account' THEN
  r:=trustwork.payments_source_registration_current((p_input->>'accountRegistrationId')::uuid,'account');
  IF r.hub_id::text IS DISTINCT FROM p_input->>'hubId' OR r.connection_id::text IS DISTINCT FROM p_input->>'connectionId' THEN RAISE EXCEPTION 'account issuer scope mismatch' USING ERRCODE='42501'; END IF;
 END IF;
 INSERT INTO trustwork.payment_source_challenge(person_id,session_id,person_epoch,hub_id,connection_id,identity_registration_id,account_registration_id,purpose,nonce,nonce_digest,created_at,expires_at)
 VALUES(actor,p_session,epoch,(p_input->>'hubId')::uuid,(p_input->>'connectionId')::uuid,(p_input->>'identityRegistrationId')::uuid,
  (p_input->>'accountRegistrationId')::uuid,p_input->>'purpose',p_nonce,encode(sha256(convert_to(p_nonce,'UTF8')),'hex'),ts,ts+interval '10 minutes') RETURNING * INTO c;
 -- Account and identity registrations are distinct: the initial identity selection is never overwritten.
 IF c.identity_registration_id IS DISTINCT FROM (p_input->>'identityRegistrationId')::uuid THEN
  RAISE EXCEPTION 'identity registration mismatch' USING ERRCODE='42501';
 END IF;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis) VALUES(actor,'payment.source_challenge','payment_source',c.id,'{}');
 PERFORM trustwork.payments_source_person(actor,p_session,epoch);
 RETURN jsonb_build_object('id',c.id,'nonce',c.nonce,'purpose',c.purpose,'expiresAt',to_char(c.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_source_own_bindings() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
 PERFORM trustwork.admin_require_caller();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('participantBindingId',p.id,'accountBindingId',a.id,
  'accepted',EXISTS(SELECT 1 FROM trustwork.payment_binding_review r WHERE r.participant_binding_id=p.id AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()))),'[]'::jsonb)
  FROM trustwork.payment_participant_binding_version p LEFT JOIN trustwork.payment_account_binding_version a ON a.participant_binding_id=p.id
  WHERE p.person_id=trustwork.current_person_id());
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_source_places(p_hub uuid,p_places text[]) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE place text;
BEGIN
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id=p_hub FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'owning hub unavailable' USING ERRCODE='42501'; END IF;
 -- A missing current row cannot be locked against its first insertion. Require explicit owning configuration.
 PERFORM 1 FROM trustwork.hub_config_current WHERE hub_id=p_hub AND domain='jurisdiction' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'owning hub jurisdiction unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM trustwork.hub_territory WHERE hub_id=p_hub ORDER BY id FOR SHARE NOWAIT;
 FOREACH place IN ARRAY p_places LOOP
  IF place IS NULL OR place !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' OR trustwork.hubs_place_restricted(p_hub,place)
   OR NOT EXISTS(SELECT 1 FROM trustwork.hub_territory WHERE hub_id=p_hub AND (code=place OR code=left(place,2))) THEN
   RAISE EXCEPTION 'required payment geography unavailable' USING ERRCODE='42501';
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION trustwork.payments_source_identity(p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE p trustwork.payment_participant_binding_version%ROWTYPE; i trustwork.payment_identity_link_version%ROWTYPE; c trustwork.payment_source_challenge%ROWTYPE;
BEGIN
 SELECT * INTO p FROM trustwork.payment_participant_binding_version WHERE id=p_binding FOR SHARE NOWAIT;
 SELECT * INTO i FROM trustwork.payment_identity_link_version WHERE id=p.identity_link_id FOR SHARE NOWAIT;
 SELECT * INTO c FROM trustwork.payment_source_challenge WHERE id=i.challenge_id;
 PERFORM trustwork.payments_source_registration_current(i.registration_id,'identity_link');
 PERFORM trustwork.payments_source_person(p.person_id,c.session_id,c.person_epoch);
 PERFORM trustwork.payments_source_places(p.hub_id,ARRAY[i.assertion->>'residencePlace']);
 IF p.id IS NULL OR p.revoked_at IS NOT NULL OR i.revoked_at IS NOT NULL OR least(p.expires_at,i.expires_at)<=clock_timestamp()
  OR p.person_id IS DISTINCT FROM i.person_id OR p.person_id IS DISTINCT FROM c.person_id OR p.hub_id IS DISTINCT FROM c.hub_id THEN
  RAISE EXCEPTION 'payment identity source unavailable' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('personId',p.person_id,'hubId',p.hub_id,'identityId',i.id,'registrationId',i.registration_id,
  'proofDigest',i.digest,'country',i.assertion->>'residenceCountry','place',i.assertion->>'residencePlace','expiresAt',p.expires_at);
END $$;
CREATE FUNCTION trustwork.payments_source_account(p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.payment_account_binding_version%ROWTYPE; e trustwork.payment_account_evidence%ROWTYPE; identity_facts jsonb; c trustwork.provider_connection%ROWTYPE;
BEGIN
 SELECT * INTO a FROM trustwork.payment_account_binding_version WHERE id=p_binding FOR SHARE NOWAIT;
 SELECT * INTO e FROM trustwork.payment_account_evidence WHERE id=a.account_evidence_id FOR SHARE NOWAIT;
 identity_facts:=trustwork.payments_source_identity(a.participant_binding_id);
 PERFORM trustwork.payments_source_registration_current(e.registration_id,'account');
 SELECT * INTO c FROM trustwork.provider_connection WHERE id=(e.assertion->>'connectionId')::uuid FOR SHARE NOWAIT;
 PERFORM trustwork.payments_source_places((identity_facts->>'hubId')::uuid,ARRAY[e.assertion->>'accountPlace']);
 IF a.id IS NULL OR a.revoked_at IS NOT NULL OR e.revoked_at IS NOT NULL OR least(a.expires_at,e.expires_at)<=clock_timestamp()
  OR a.person_id::text IS DISTINCT FROM identity_facts->>'personId' OR e.identity_link_id::text IS DISTINCT FROM identity_facts->>'identityId'
  OR c.hub_id::text IS DISTINCT FROM identity_facts->>'hubId' OR c.status<>'enabled' OR c.mode<>'fake'
  OR e.assertion->>'connectionDigest' IS DISTINCT FROM trustwork.providers_config_digest(c.id) THEN
  RAISE EXCEPTION 'payment account source unavailable' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('personId',a.person_id,'participantBindingId',a.participant_binding_id,'accountEvidenceId',e.id,
  'identityRegistrationId',identity_facts->>'registrationId','accountRegistrationId',e.registration_id,
  'accountRef',e.assertion->>'accountRef','country',e.assertion->>'accountCountry','place',e.assertion->>'accountPlace',
  'connectionId',c.id,'hubId',c.hub_id,'proofDigest',e.digest,'expiresAt',a.expires_at);
END $$;
CREATE FUNCTION trustwork.payments_source_review_material(p_ctx jsonb,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE identity_facts jsonb; account_facts jsonb; account_id uuid; kind text; permission text; actor trustwork.admin_actor; material jsonb;
BEGIN
 identity_facts:=trustwork.payments_source_identity(p_binding);
 SELECT id INTO account_id FROM trustwork.payment_account_binding_version WHERE participant_binding_id=p_binding;
 kind:=CASE WHEN account_id IS NULL THEN 'payments.accept_participant_binding' ELSE 'payments.activate_account_binding' END;
 permission:=CASE WHEN account_id IS NULL THEN 'admin.payments.participant_binding.propose' ELSE 'admin.payments.account_binding.propose' END;
 actor:=trustwork.payments_source_staff(p_ctx,permission,(identity_facts->>'hubId')::uuid);
 IF trustwork.admin_conflicted(actor.person_id,(identity_facts->>'personId')::uuid,NULL) THEN RAISE EXCEPTION 'participant cannot propose own hub review' USING ERRCODE='42501'; END IF;
 IF account_id IS NOT NULL THEN account_facts:=trustwork.payments_source_account(account_id); END IF;
 material:=jsonb_build_object('kind',kind,'participantBindingId',p_binding,'identityDigest',identity_facts->>'proofDigest',
  'accountBindingId',account_id,'accountDigest',account_facts->>'proofDigest','hubId',identity_facts->>'hubId');
 PERFORM trustwork.admin_record(actor,p_ctx,NULL,(identity_facts->>'hubId')::uuid,'payments.source_review_material','payment_source',p_binding,NULL,jsonb_build_object('digest',trustwork.admin_digest(material)));
 RETURN jsonb_build_object('id',p_binding,'hubId',identity_facts->>'hubId','action',kind,'digest',trustwork.admin_digest(material),'evidenceMode','synthetic');
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_accept_source_binding(p_ctx jsonb,p_binding uuid,p_approval uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE material jsonb; p trustwork.payment_participant_binding_version%ROWTYPE; account_id uuid; a trustwork.second_person_approval%ROWTYPE;
 permission text; reviewer_permission text; actor trustwork.admin_actor; reviewer_elevation uuid; r_id uuid:=trustwork.new_uuid();
BEGIN
 SELECT * INTO p FROM trustwork.payment_participant_binding_version WHERE id=p_binding FOR UPDATE;
 material:=trustwork.payments_source_review_material(p_ctx,p_binding);
 SELECT id INTO account_id FROM trustwork.payment_account_binding_version WHERE participant_binding_id=p_binding;
 permission:=CASE WHEN account_id IS NULL THEN 'admin.payments.participant_binding.propose' ELSE 'admin.payments.account_binding.propose' END;
 reviewer_permission:=CASE WHEN account_id IS NULL THEN 'admin.payments.participant_binding.accept' ELSE 'admin.payments.account_binding.review' END;
 actor:=trustwork.payments_source_staff(p_ctx,permission,p.hub_id);
 reviewer_elevation:=trustwork.payments_source_review_elevation(p_approval,reviewer_permission,p.hub_id);
 SELECT * INTO a FROM trustwork.second_person_approval WHERE id=p_approval;
 IF a.approved_by=actor.person_id OR trustwork.admin_conflicted(a.approved_by,p.person_id,NULL) OR EXISTS(
  SELECT 1 FROM trustwork.payment_source_registration r WHERE r.proposed_by=a.approved_by AND r.id IN (
   SELECT registration_id FROM trustwork.payment_identity_link_version WHERE id=p.identity_link_id
   UNION ALL SELECT e.registration_id FROM trustwork.payment_account_evidence e JOIN trustwork.payment_account_binding_version b ON b.account_evidence_id=e.id WHERE b.id=account_id)) THEN
  RAISE EXCEPTION 'independent source reviewer required' USING ERRCODE='42501';
 END IF;
 a:=trustwork.admin_consume_approval(p_approval,material->>'action','hub',NULL,p.hub_id,material->>'digest',r_id);
 INSERT INTO trustwork.payment_binding_review(id,participant_binding_id,account_binding_id,approval_id,digest,proposer_id,reviewer_id,reviewer_elevation_id,expires_at)
  VALUES(r_id,p.id,account_id,a.id,material->>'digest',actor.person_id,a.approved_by,reviewer_elevation,
   least(p.expires_at,coalesce((SELECT expires_at FROM trustwork.payment_account_binding_version WHERE id=account_id),p.expires_at)));
 PERFORM trustwork.admin_record(actor,p_ctx,NULL,p.hub_id,material->>'action','payment_binding_review',r_id,NULL,jsonb_build_object('digest',material->>'digest'),NULL,a.id);
 PERFORM trustwork.payments_source_review_material(p_ctx,p_binding);
 PERFORM trustwork.payments_source_review_elevation(p_approval,reviewer_permission,p.hub_id);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_source_challenge(uuid,jsonb,text),trustwork.payments_source_own_bindings(),trustwork.payments_source_places(uuid,text[]),
 trustwork.payments_source_identity(uuid),trustwork.payments_source_account(uuid),trustwork.payments_source_review_material(jsonb,uuid),trustwork.payments_accept_source_binding(jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_source_challenge(uuid,jsonb,text),trustwork.payments_source_own_bindings(),
 trustwork.payments_source_review_material(jsonb,uuid),trustwork.payments_accept_source_binding(jsonb,uuid,uuid) TO trustwork_app;

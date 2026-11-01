-- PAY-001 / Proposed ADR024: bounded individual, same-hub commercial source authority.
-- No registration, key, account, source, login or grant to a live verifier is seeded.
CREATE TABLE trustwork.payment_source_registration (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 connection_id uuid NOT NULL REFERENCES trustwork.provider_connection(id),
 fact text NOT NULL CHECK(fact IN ('identity_link','account','publisher')),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=8192), digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 proposed_by uuid NOT NULL REFERENCES trustwork.person(id), proposed_epoch integer NOT NULL,
 proposed_elevation_id uuid NOT NULL REFERENCES trustwork.session_elevation(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, CHECK(expires_at>created_at)
);
CREATE TABLE trustwork.payment_adapter_activation (
 registration_id uuid PRIMARY KEY REFERENCES trustwork.payment_source_registration(id),
 approval_id uuid NOT NULL UNIQUE REFERENCES trustwork.second_person_approval(id),
 activated_by uuid NOT NULL REFERENCES trustwork.person(id), reviewer_id uuid NOT NULL REFERENCES trustwork.person(id),
 reviewer_elevation_id uuid NOT NULL REFERENCES trustwork.session_elevation(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(activated_by<>reviewer_id)
);
CREATE TABLE trustwork.payment_source_challenge (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), person_id uuid NOT NULL REFERENCES trustwork.person(id),
 session_id uuid NOT NULL REFERENCES trustwork.session(id), person_epoch integer NOT NULL,
 hub_id uuid NOT NULL REFERENCES trustwork.hub(id), connection_id uuid NOT NULL REFERENCES trustwork.provider_connection(id),
 identity_registration_id uuid NOT NULL REFERENCES trustwork.payment_source_registration(id),
 account_registration_id uuid REFERENCES trustwork.payment_source_registration(id),
 purpose text NOT NULL CHECK(purpose IN ('payment_participant','payment_account')),
 nonce text NOT NULL CHECK(nonce~'^[a-f0-9]{64}$'), nonce_digest text NOT NULL CHECK(nonce_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 CHECK((purpose='payment_account')=(account_registration_id IS NOT NULL))
);
CREATE TABLE trustwork.payment_identity_link_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), challenge_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_source_challenge(id),
 person_id uuid NOT NULL REFERENCES trustwork.person(id), registration_id uuid NOT NULL REFERENCES trustwork.payment_source_registration(id),
 assertion jsonb NOT NULL CHECK(octet_length(assertion::text)<=8192), digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE trustwork.payment_participant_binding_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), identity_link_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_identity_link_version(id),
 person_id uuid NOT NULL REFERENCES trustwork.person(id), hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE trustwork.payment_account_evidence (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), challenge_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_source_challenge(id),
 identity_link_id uuid NOT NULL REFERENCES trustwork.payment_identity_link_version(id),
 registration_id uuid NOT NULL REFERENCES trustwork.payment_source_registration(id),
 assertion jsonb NOT NULL CHECK(octet_length(assertion::text)<=8192), digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE trustwork.payment_account_binding_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), participant_binding_id uuid NOT NULL REFERENCES trustwork.payment_participant_binding_version(id),
 account_evidence_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_account_evidence(id),
 person_id uuid NOT NULL REFERENCES trustwork.person(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE trustwork.payment_binding_review (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), participant_binding_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_participant_binding_version(id),
 account_binding_id uuid UNIQUE REFERENCES trustwork.payment_account_binding_version(id),
 approval_id uuid NOT NULL UNIQUE REFERENCES trustwork.second_person_approval(id), digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 proposer_id uuid NOT NULL REFERENCES trustwork.person(id), reviewer_id uuid NOT NULL REFERENCES trustwork.person(id),
 reviewer_elevation_id uuid NOT NULL REFERENCES trustwork.session_elevation(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(proposer_id<>reviewer_id)
);
CREATE TABLE trustwork.payment_authorization_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), agreement_id uuid NOT NULL REFERENCES trustwork.agreement(id),
 payer_id uuid NOT NULL REFERENCES trustwork.person(id), payee_id uuid NOT NULL REFERENCES trustwork.person(id),
 payer_binding_id uuid NOT NULL REFERENCES trustwork.payment_participant_binding_version(id),
 payee_binding_id uuid NOT NULL REFERENCES trustwork.payment_participant_binding_version(id),
 account_binding_id uuid NOT NULL REFERENCES trustwork.payment_account_binding_version(id),
 publisher_registration_id uuid NOT NULL REFERENCES trustwork.payment_source_registration(id),
 snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=16384), binding jsonb NOT NULL,
 digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(payer_id<>payee_id), CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE trustwork.payment_authorization_acceptance (
 authorization_id uuid NOT NULL REFERENCES trustwork.payment_authorization_version(id),
 person_id uuid NOT NULL REFERENCES trustwork.person(id), session_id uuid NOT NULL REFERENCES trustwork.session(id),
 person_epoch integer NOT NULL, digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(authorization_id,person_id)
);
CREATE TABLE trustwork.payment_source_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(), authorization_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_authorization_version(id),
 agreement_id uuid NOT NULL REFERENCES trustwork.agreement(id), binding jsonb NOT NULL,
 digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE trustwork.payment_source_current (
 agreement_id uuid PRIMARY KEY REFERENCES trustwork.agreement(id), source_version_id uuid NOT NULL UNIQUE REFERENCES trustwork.payment_source_version(id)
);

-- Versions are immutable except a one-way revocation. No role can erase a prior version.
CREATE FUNCTION trustwork.payments_source_version_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at'
  OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
  RAISE EXCEPTION 'payment source history is immutable' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_source_registration','payment_identity_link_version','payment_participant_binding_version',
  'payment_account_evidence','payment_account_binding_version','payment_binding_review','payment_authorization_version','payment_source_version'] LOOP
  EXECUTE format('CREATE TRIGGER source_version_immutable BEFORE UPDATE OR DELETE ON trustwork.%I FOR EACH ROW EXECUTE FUNCTION trustwork.payments_source_version_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['payment_adapter_activation','payment_source_challenge','payment_authorization_acceptance'] LOOP
  EXECUTE format('CREATE TRIGGER source_history_immutable BEFORE UPDATE OR DELETE ON trustwork.%I FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['payment_source_registration','payment_adapter_activation','payment_source_challenge',
  'payment_identity_link_version','payment_participant_binding_version','payment_account_evidence','payment_account_binding_version',
  'payment_binding_review','payment_authorization_version','payment_authorization_acceptance','payment_source_version','payment_source_current'] LOOP
  EXECUTE format('ALTER TABLE trustwork.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE trustwork.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY maintenance_all ON trustwork.%I FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on())',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_source_version_immutable() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trustwork.admin_second_person_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['staff.assign_sensitive_role', 'commerce.activate_price_version', 'privacy.execute_erasure', 'moderation.apply_sanction_l4', 'providers.enable_non_fake', 'staff.switch_sod_mode',
    'hub.transition_soft_launch', 'hub.transition_public', 'hub.change_residency', 'legal.activate_document_version', 'federation.raise_peering_level',
    'models.activate_private_route', 'egress.allow_private_class', 'pipelines.activate_personal_data_dataset', 'datasets.activate_court_or_debt',
    'automation.raise_to_supervised_autonomous', 'agents.enable_commitment_module', 'agents.activate_extension', 'jurisdiction.activate_settings',
    'billing.activate_fee_version', 'billing.release_payout_batch', 'payments.change_settings', 'sponsored.enable', 'staff.grant_breakglass',
    'support.reset_second_factor', 'support.rebind_recovery_email', 'ops.execute_restore', 'ops.apply_production_migration', 'ops.rotate_node_key',
    'kill_switch.release', 'payments.register_source_adapter', 'payments.accept_participant_binding', 'payments.activate_account_binding', 'screening.clear_match', 'screening.reverse_confirmation']::text[]
$$;
-- The permissions that may execute (and therefore request and approve) each second-person action. The requester and
-- the approver each hold one of them at a covering scope; they are never the same person.
CREATE OR REPLACE FUNCTION trustwork.admin_action_permissions(p_action text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_action
    WHEN 'staff.assign_sensitive_role' THEN ARRAY['admin.staff.assign']
    WHEN 'commerce.activate_price_version' THEN ARRAY['admin.commerce.price.activate']
    WHEN 'privacy.execute_erasure' THEN ARRAY['admin.privacy.erasure.execute']
    WHEN 'moderation.apply_sanction_l4' THEN ARRAY['admin.moderation.decide']
    WHEN 'providers.enable_non_fake' THEN ARRAY['admin.providers.toggle']
    WHEN 'staff.switch_sod_mode' THEN ARRAY['admin.staff.assign']
    WHEN 'hub.transition_soft_launch' THEN ARRAY['admin.hub.lifecycle.request']
    WHEN 'hub.transition_public' THEN ARRAY['admin.hub.lifecycle.request']
    WHEN 'hub.change_residency' THEN ARRAY['admin.hub.residency.edit']
    WHEN 'legal.activate_document_version' THEN ARRAY['admin.hub.legal.activate']
    WHEN 'federation.raise_peering_level' THEN ARRAY['admin.federation.peer.edit']
    WHEN 'models.activate_private_route' THEN ARRAY['admin.models.route.activate']
    WHEN 'egress.allow_private_class' THEN ARRAY['admin.providers.egress.edit']
    WHEN 'pipelines.activate_personal_data_dataset' THEN ARRAY['admin.pipelines.activate', 'admin.datasets.activate']
    WHEN 'datasets.activate_court_or_debt' THEN ARRAY['admin.datasets.activate']
    WHEN 'automation.raise_to_supervised_autonomous' THEN ARRAY['admin.editorial.automation.edit', 'admin.config.edit']
    WHEN 'agents.enable_commitment_module' THEN ARRAY['admin.agents.modules.activate']
    WHEN 'agents.activate_extension' THEN ARRAY['admin.agents.extensions.activate']
    WHEN 'jurisdiction.activate_settings' THEN ARRAY['admin.hub.jurisdiction.activate']
    WHEN 'billing.activate_fee_version' THEN ARRAY['admin.billing.fees.activate']
    WHEN 'billing.release_payout_batch' THEN ARRAY['admin.billing.payouts.release']
    WHEN 'payments.change_settings' THEN ARRAY['admin.hub.payments.edit']
    WHEN 'sponsored.enable' THEN ARRAY['admin.sponsored.policy.edit']
    WHEN 'staff.grant_breakglass' THEN ARRAY['admin.staff.breakglass']
    WHEN 'support.reset_second_factor' THEN ARRAY['admin.support.second_factor.reset']
    WHEN 'support.rebind_recovery_email' THEN ARRAY['admin.support.recovery.rebind']
    WHEN 'ops.execute_restore' THEN ARRAY['admin.ops.restore.execute']
    WHEN 'ops.apply_production_migration' THEN ARRAY['admin.ops.updates.apply']
    WHEN 'ops.rotate_node_key' THEN ARRAY['admin.node.keys.rotate']
    WHEN 'kill_switch.release' THEN ARRAY['admin.providers.kill', 'admin.agents.kill', 'admin.pipelines.pause']
    WHEN 'payments.register_source_adapter' THEN ARRAY['admin.payments.adapters.propose','admin.payments.adapters.activate']
    WHEN 'payments.accept_participant_binding' THEN ARRAY['admin.payments.participant_binding.propose','admin.payments.participant_binding.accept']
    WHEN 'payments.activate_account_binding' THEN ARRAY['admin.payments.account_binding.propose','admin.payments.account_binding.review']
    END::text[]
$$;

-- Internal authority helpers. NOWAIT fails closed when an owning writer won; it cannot invert its lock order.
CREATE FUNCTION trustwork.payments_source_person(p_person uuid,p_session uuid,p_epoch integer) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE pe trustwork.person%ROWTYPE; se trustwork.session%ROWTYPE; ts timestamptz;
BEGIN
 SELECT * INTO pe FROM trustwork.person WHERE id=p_person FOR SHARE NOWAIT;
 SELECT * INTO se FROM trustwork.session WHERE id=p_session FOR SHARE NOWAIT;
 ts:=clock_timestamp();
 IF pe.id IS NULL OR pe.authz_epoch IS DISTINCT FROM p_epoch OR se.person_id IS DISTINCT FROM p_person
  OR se.revoked_at IS NOT NULL OR se.idle_expires_at<=ts OR se.absolute_expires_at<=ts THEN
  RAISE EXCEPTION 'current payment source person unavailable' USING ERRCODE='42501',HINT='access.forbidden';
 END IF;
END $$;
CREATE FUNCTION trustwork.payments_source_registration_current(p_id uuid,p_fact text) RETURNS trustwork.payment_source_registration
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE r trustwork.payment_source_registration%ROWTYPE;
BEGIN
 SELECT * INTO r FROM trustwork.payment_source_registration WHERE id=p_id FOR SHARE NOWAIT;
 IF NOT FOUND OR r.fact IS DISTINCT FROM p_fact OR r.revoked_at IS NOT NULL OR r.expires_at<=clock_timestamp()
  OR r.payload->>'evidenceMode' IS DISTINCT FROM 'synthetic' OR r.payload->>'algorithm' IS DISTINCT FROM 'ed25519'
  OR NOT EXISTS(SELECT 1 FROM trustwork.payment_adapter_activation WHERE registration_id=r.id) THEN
  RAISE EXCEPTION 'payment source registration unavailable' USING ERRCODE='42501',HINT='access.forbidden';
 END IF;
 RETURN r;
END $$;
CREATE FUNCTION trustwork.payments_source_verifier_registration(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE r trustwork.payment_source_registration%ROWTYPE; fact text;
BEGIN
 SELECT s.fact INTO fact FROM trustwork.payment_source_registration s WHERE s.id=p_id;
 IF fact NOT IN ('identity_link','account') OR fact IS NULL THEN RAISE EXCEPTION 'source issuer unavailable' USING ERRCODE='42501'; END IF;
 r:=trustwork.payments_source_registration_current(p_id,fact);
 RETURN r.payload;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
CREATE FUNCTION trustwork.payments_source_record_assertion(e jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE c trustwork.payment_source_challenge%ROWTYPE; r trustwork.payment_source_registration%ROWTYPE;
 identity_row trustwork.payment_identity_link_version%ROWTYPE; account_row trustwork.payment_account_evidence%ROWTYPE;
 participant uuid; withdrawal_table text; withdrawal_row record; current_digest text; expiration timestamptz; issued timestamptz;
BEGIN
 IF e->>'fact'='withdrawal' THEN
  r:=trustwork.payments_source_registration_current((e->>'registrationId')::uuid,e->>'issuerFact');
  withdrawal_table:=CASE e->>'issuerFact' WHEN 'identity_link' THEN 'payment_identity_link_version' WHEN 'account' THEN 'payment_account_evidence' END;
  IF withdrawal_table IS NULL OR e->>'audience' IS DISTINCT FROM r.id::text OR e->>'evidenceMode' IS DISTINCT FROM 'synthetic'
   OR (e->>'issuedAt')::timestamptz>clock_timestamp() OR (e->>'issuedAt')::timestamptz<clock_timestamp()-interval '10 minutes' THEN
   RAISE EXCEPTION 'source withdrawal mismatch' USING ERRCODE='42501';
  END IF;
  EXECUTE format('SELECT id,registration_id,digest,created_at FROM trustwork.%I WHERE id=$1 FOR UPDATE',withdrawal_table)
   INTO withdrawal_row USING (e->>'recordId')::uuid;
  IF withdrawal_row.id IS NULL OR withdrawal_row.registration_id IS DISTINCT FROM r.id OR withdrawal_row.digest IS DISTINCT FROM e->>'digest'
   OR (e->>'issuedAt')::timestamptz<withdrawal_row.created_at THEN RAISE EXCEPTION 'exact issuer withdrawal required' USING ERRCODE='42501'; END IF;
  EXECUTE format('UPDATE trustwork.%I SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',withdrawal_table) USING withdrawal_row.id;
  INSERT INTO trustwork.audit_event(action,object_kind,object_id,basis) VALUES('payment.issuer_withdrawal','payment_source',withdrawal_row.id,'{}');
  PERFORM trustwork.payments_source_registration_current(r.id,r.fact);
  RETURN;
 END IF;
 IF e IS NULL OR octet_length(e::text)>8192 OR e->>'schemaVersion'<>'1' OR e->>'fact' NOT IN ('identity_link','account') THEN
  RAISE EXCEPTION 'source envelope invalid' USING ERRCODE='23514';
 END IF;
 SELECT * INTO c FROM trustwork.payment_source_challenge WHERE id=(e->>'challengeId')::uuid FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'source challenge unavailable' USING ERRCODE='42501'; END IF;
 -- Intake serializes replay without changing immutable challenge content.
 PERFORM pg_advisory_xact_lock(hashtext('payments.source.intake'),hashtext(c.id::text));
 r:=trustwork.payments_source_registration_current((e->>'registrationId')::uuid,e->>'fact');
 PERFORM trustwork.payments_source_person(c.person_id,c.session_id,c.person_epoch);
 issued:=(e->>'issuedAt')::timestamptz; expiration:=(e->>'expiresAt')::timestamptz;
 IF e->>'personId' IS DISTINCT FROM c.person_id::text OR e->>'sessionId' IS DISTINCT FROM c.session_id::text
  OR (e->>'personEpoch')::integer IS DISTINCT FROM c.person_epoch OR e->>'purpose' IS DISTINCT FROM c.purpose
  OR e->>'nonceDigest' IS DISTINCT FROM c.nonce_digest OR e->>'audience' IS DISTINCT FROM r.id::text
  OR e->>'connectionId' IS DISTINCT FROM c.connection_id::text OR r.hub_id<>c.hub_id OR r.connection_id<>c.connection_id
  OR e->>'evidenceMode' IS DISTINCT FROM r.payload->>'evidenceMode' OR c.expires_at<=clock_timestamp()
  OR issued IS NULL OR expiration IS NULL OR issued<c.created_at OR issued<r.created_at OR issued>clock_timestamp()
  OR expiration<=clock_timestamp() OR expiration>issued+interval '24 hours' OR expiration>r.expires_at
  OR e->>'verifiedSubjectRef' IS NULL OR length(e->>'verifiedSubjectRef') NOT BETWEEN 1 AND 180 THEN
  RAISE EXCEPTION 'source challenge binding mismatch' USING ERRCODE='42501';
 END IF;
 current_digest:=trustwork.admin_digest(e);
 IF e->>'fact'='identity_link' THEN
  IF r.id<>c.identity_registration_id OR e->>'residencePlace' !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'
   OR left(e->>'residencePlace',2) IS DISTINCT FROM e->>'residenceCountry'
   OR ((c.purpose='payment_account') IS DISTINCT FROM (e->>'providerEntityRef' IS NOT NULL)) THEN
   RAISE EXCEPTION 'identity linkage unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO identity_row FROM trustwork.payment_identity_link_version WHERE challenge_id=c.id;
  IF FOUND THEN
   IF identity_row.digest<>current_digest THEN RAISE EXCEPTION 'source replay conflict' USING ERRCODE='23514'; END IF;
   RETURN;
  END IF;
  INSERT INTO trustwork.payment_identity_link_version(challenge_id,person_id,registration_id,assertion,digest,expires_at)
   VALUES(c.id,c.person_id,r.id,e,current_digest,expiration) RETURNING * INTO identity_row;
  INSERT INTO trustwork.payment_participant_binding_version(identity_link_id,person_id,hub_id,expires_at)
   VALUES(identity_row.id,c.person_id,c.hub_id,expiration);
 ELSE
  IF c.purpose<>'payment_account' OR r.id IS DISTINCT FROM c.account_registration_id THEN RAISE EXCEPTION 'account purpose mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO identity_row FROM trustwork.payment_identity_link_version WHERE challenge_id=c.id FOR SHARE NOWAIT;
  IF NOT FOUND OR identity_row.revoked_at IS NOT NULL OR identity_row.expires_at<=clock_timestamp()
   OR e->>'identityRegistrationId' IS DISTINCT FROM identity_row.registration_id::text
   OR e->>'verifiedSubjectRef' IS DISTINCT FROM identity_row.assertion->>'verifiedSubjectRef'
   OR e->>'providerEntityRef' IS DISTINCT FROM identity_row.assertion->>'providerEntityRef'
   OR e->>'accountPlace' !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' OR left(e->>'accountPlace',2) IS DISTINCT FROM e->>'accountCountry'
   OR e->>'status' IS DISTINCT FROM 'active' OR NOT (e->'capabilities' ?& ARRAY['payments','payouts'])
   OR coalesce(length(e->>'accountRef'),0) NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'independent account identity linkage unavailable' USING ERRCODE='42501'; END IF;
  PERFORM trustwork.payments_source_registration_current(identity_row.registration_id,'identity_link');
  PERFORM 1 FROM trustwork.provider_connection WHERE id=c.connection_id FOR SHARE NOWAIT;
  IF e->>'connectionDigest' IS DISTINCT FROM trustwork.providers_config_digest(c.connection_id) THEN RAISE EXCEPTION 'account connection changed' USING ERRCODE='42501'; END IF;
  SELECT * INTO account_row FROM trustwork.payment_account_evidence WHERE challenge_id=c.id;
  IF FOUND THEN
   IF account_row.digest<>current_digest THEN RAISE EXCEPTION 'source replay conflict' USING ERRCODE='23514'; END IF;
   RETURN;
  END IF;
  INSERT INTO trustwork.payment_account_evidence(challenge_id,identity_link_id,registration_id,assertion,digest,expires_at)
   VALUES(c.id,identity_row.id,r.id,e,current_digest,least(expiration,identity_row.expires_at)) RETURNING * INTO account_row;
  SELECT id INTO participant FROM trustwork.payment_participant_binding_version WHERE identity_link_id=identity_row.id;
  INSERT INTO trustwork.payment_account_binding_version(participant_binding_id,account_evidence_id,person_id,expires_at)
   VALUES(participant,account_row.id,c.person_id,account_row.expires_at);
 END IF;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_source_person(uuid,uuid,integer),trustwork.payments_source_registration_current(uuid,text),
 trustwork.payments_source_verifier_registration(uuid),trustwork.payments_source_record_assertion(jsonb) FROM PUBLIC;
-- No grants to raw app/worker: installation may provision only a separately reviewed verifier identity.

CREATE FUNCTION trustwork.payments_source_staff_current(p_person uuid,p_elevation uuid,p_permission text,p_hub uuid) RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE e trustwork.session_elevation%ROWTYPE; pe trustwork.person%ROWTYPE; ts timestamptz;
BEGIN
 SELECT * INTO pe FROM trustwork.person WHERE id=p_person FOR SHARE NOWAIT;
 SELECT * INTO e FROM trustwork.session_elevation WHERE id=p_elevation FOR SHARE NOWAIT;
 PERFORM trustwork.payments_source_person(p_person,e.session_id,pe.authz_epoch);
 PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id=p_person ORDER BY id FOR SHARE NOWAIT;
 ts:=clock_timestamp();
 IF pe.id IS NULL OR e.person_id IS DISTINCT FROM p_person OR e.revoked_at IS NOT NULL OR e.expires_at<=ts
  OR NOT EXISTS(SELECT 1 FROM trustwork.staff_role_assignment a JOIN trustwork.staff_role_definition_version d ON d.role=a.role AND d.version=a.definition_version
   WHERE a.person_id=p_person AND a.revoked_at IS NULL AND a.valid_from<=ts AND (a.valid_until IS NULL OR a.valid_until>ts)
   AND NOT a.breakglass AND a.scope_kind=ANY(d.scopes) AND p_permission=ANY(d.permissions) AND (a.scope_kind='platform' OR a.scope_kind='hub' AND a.hub_id=p_hub
    OR a.scope_kind='node' AND a.node_id=(SELECT node_id FROM trustwork.hub_profile WHERE hub_id=p_hub))) THEN
  RAISE EXCEPTION 'current payment source staff authority unavailable' USING ERRCODE='42501',HINT='access.forbidden';
 END IF;
END $$;
CREATE FUNCTION trustwork.payments_source_staff(p_ctx jsonb,p_permission text,p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE actor trustwork.admin_actor;
BEGIN
 actor:=trustwork.admin_authorize(p_ctx,ARRAY[p_permission],NULL,p_hub);
 PERFORM trustwork.payments_source_staff_current(actor.person_id,actor.elevation_id,p_permission,p_hub);
 IF (SELECT authz_epoch FROM trustwork.person WHERE id=actor.person_id) IS DISTINCT FROM trustwork.current_authz_epoch() THEN
  RAISE EXCEPTION 'payment source staff epoch changed' USING ERRCODE='42501';
 END IF;
 RETURN actor;
END $$;
CREATE FUNCTION trustwork.payments_source_review_elevation(p_approval uuid,p_permission text,p_hub uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.second_person_approval%ROWTYPE; e uuid;
BEGIN
 SELECT * INTO a FROM trustwork.second_person_approval WHERE id=p_approval FOR SHARE NOWAIT;
 SELECT session_elevation_id INTO e FROM trustwork.admin_audit_event WHERE object_id=a.id AND action='approval.approved'
  AND actor_person_id=a.approved_by ORDER BY occurred_at DESC LIMIT 1;
 IF a.approved_by IS NULL OR a.expires_at<=clock_timestamp() OR a.status NOT IN ('approved','consumed') THEN
  RAISE EXCEPTION 'independent source review unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM trustwork.payments_source_staff_current(a.approved_by,e,p_permission,p_hub);
 RETURN e;
END $$;

-- Installation-only commands: no app/worker execution grant and no runtime self-registration.
CREATE FUNCTION trustwork.payments_propose_source_adapter(p_ctx jsonb,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor trustwork.admin_actor; r trustwork.payment_source_registration%ROWTYPE; id uuid:=trustwork.new_uuid(); hub uuid:=(p_input->>'hubId')::uuid;
BEGIN
 actor:=trustwork.payments_source_staff(p_ctx,'admin.payments.adapters.propose',hub);
 IF p_input IS NULL OR p_input-ARRAY['schemaVersion','hubId','connectionId','fact','implementationDigest','algorithm','keyId','publicKey','evidenceMode','expiresAt']<>'{}'::jsonb
  OR octet_length(p_input::text)>8192 OR p_input->>'schemaVersion' IS DISTINCT FROM '1'
  OR p_input->>'algorithm' IS DISTINCT FROM 'ed25519' OR p_input->>'evidenceMode' IS DISTINCT FROM 'synthetic'
  OR coalesce(p_input->>'implementationDigest','') !~ '^[a-f0-9]{64}$'
  OR p_input->>'fact'='publisher' AND p_input->>'implementationDigest'<>encode(sha256(convert_to('synthetic-publisher-v1','UTF8')),'hex')
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
CREATE FUNCTION trustwork.payments_activate_source_adapter(p_ctx jsonb,p_id uuid,p_approval uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor trustwork.admin_actor; r trustwork.payment_source_registration%ROWTYPE; a trustwork.second_person_approval%ROWTYPE; e uuid;
BEGIN
 SELECT * INTO r FROM trustwork.payment_source_registration WHERE id=p_id FOR UPDATE;
 actor:=trustwork.payments_source_staff(p_ctx,'admin.payments.adapters.propose',r.hub_id);
 IF r.proposed_by IS DISTINCT FROM actor.person_id OR r.proposed_epoch IS DISTINCT FROM trustwork.current_authz_epoch()
  OR r.revoked_at IS NOT NULL OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'adapter proposal authority changed' USING ERRCODE='42501'; END IF;
 PERFORM trustwork.payments_source_staff_current(r.proposed_by,r.proposed_elevation_id,'admin.payments.adapters.propose',r.hub_id);
 e:=trustwork.payments_source_review_elevation(p_approval,'admin.payments.adapters.activate',r.hub_id);
 a:=trustwork.admin_consume_approval(p_approval,'payments.register_source_adapter','hub',NULL,r.hub_id,r.digest,r.id);
 INSERT INTO trustwork.payment_adapter_activation(registration_id,approval_id,activated_by,reviewer_id,reviewer_elevation_id)
  VALUES(r.id,a.id,actor.person_id,a.approved_by,e);
 PERFORM trustwork.admin_record(actor,p_ctx,NULL,r.hub_id,'payments.register_source_adapter','payment_source_registration',r.id,NULL,jsonb_build_object('digest',r.digest),NULL,a.id);
 PERFORM trustwork.payments_source_review_elevation(p_approval,'admin.payments.adapters.activate',r.hub_id);
 PERFORM trustwork.payments_source_staff(p_ctx,'admin.payments.adapters.propose',r.hub_id);
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'payment source authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_source_staff_current(uuid,uuid,text,uuid),trustwork.payments_source_staff(jsonb,text,uuid),
 trustwork.payments_source_review_elevation(uuid,text,uuid),trustwork.payments_propose_source_adapter(jsonb,jsonb),
 trustwork.payments_activate_source_adapter(jsonb,uuid,uuid) FROM PUBLIC;

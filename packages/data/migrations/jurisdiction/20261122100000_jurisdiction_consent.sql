-- HUB-005 continuation. No legal values, retention duration, provider or country rule is seeded.
-- The shared authority lock is transaction-local and bounded. All operations below are database-only.
CREATE OR REPLACE FUNCTION trustwork.jurisdiction_lock() RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'jurisdiction authority requires read committed' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('lock_timeout','3s',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.jurisdiction.authority',0));
END $$;

-- Row locks serialize against the actual identity/session revokers, without changing those owning modules.
-- Call AFTER domain waits. The exact authenticated session is provided by the server, never by an HTTP body.
CREATE FUNCTION trustwork.jurisdiction_require_actor(p_session uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE actor uuid := trustwork.current_person_id(); epoch integer; sess trustwork.session%ROWTYPE;
BEGIN
  SELECT authz_epoch INTO epoch FROM trustwork.person WHERE id=actor FOR SHARE;
  SELECT * INTO sess FROM trustwork.session WHERE id=p_session AND person_id=actor FOR SHARE;
  IF actor IS NULL OR epoch IS DISTINCT FROM trustwork.current_authz_epoch() OR sess.id IS NULL
    OR sess.revoked_at IS NOT NULL OR sess.idle_expires_at<=clock_timestamp() OR sess.absolute_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'current exact session required' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- Legacy key-only policies remain valid configuration but cannot authorize consent-bearing execution.
ALTER FUNCTION trustwork.jurisdiction_validate(uuid,jsonb,text[]) RENAME TO jurisdiction_validate_base;
CREATE FUNCTION trustwork.jurisdiction_validate(p_hub uuid,p jsonb,locales text[]) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE s jsonb; source jsonb; scope jsonb; l text;
BEGIN
  PERFORM trustwork.jurisdiction_validate_base(p_hub,p,locales);
  FOR s IN SELECT value FROM jsonb_array_elements(p->'agentSettings'->'jurisdictions') LOOP
    SELECT document INTO source FROM trustwork.jurisdiction_source WHERE id=(s->>'sourceId')::uuid;
    -- Scopes are reviewed source facts, not operator-selected defaults. Exact equality is conservative.
    IF s->'consentScopes' IS DISTINCT FROM source->'consentScopes' THEN
      RAISE EXCEPTION 'reviewed consent scopes required' USING ERRCODE='23514';
    END IF;
    IF s ? 'consentScopes' THEN
      IF jsonb_typeof(s->'consentScopes') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'consentScopes')>100 THEN
        RAISE EXCEPTION 'invalid consent scopes' USING ERRCODE='23514';
      END IF;
      FOR scope IN SELECT value FROM jsonb_array_elements(s->'consentScopes') LOOP
        IF NOT (scope ?& ARRAY['requirement','purpose','action','affectedParty','noticeKey'])
          OR (SELECT count(*) FROM jsonb_object_keys(scope))<>5
          OR coalesce(scope->>'purpose','') !~ '^[a-z][A-Za-z0-9_.-]{1,120}$'
          OR coalesce(scope->>'affectedParty','') NOT IN ('actor','buyer','seller')
          OR NOT ((s->'policy'->'consentRequirements') ? (scope->>'requirement'))
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'policy'->'actionLimits') a WHERE a->>'action'=scope->>'action') THEN
          RAISE EXCEPTION 'invalid consent scope' USING ERRCODE='23514';
        END IF;
        FOREACH l IN ARRAY locales LOOP
          IF NOT ((s->'policy'->'legalTextKeys'->l) ? (scope->>'noticeKey')) THEN
            RAISE EXCEPTION 'consent notice must be a bound legal text in every language' USING ERRCODE='23514';
          END IF;
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;
END $$;

CREATE TABLE trustwork.jurisdiction_consent_receipt (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person(id),
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  authz_epoch integer NOT NULL,
  notice_digest text NOT NULL CHECK(notice_digest ~ '^[a-f0-9]{64}$'),
  notice jsonb NOT NULL,
  locale text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(person_id,notice_digest)
);
CREATE TABLE trustwork.jurisdiction_consent_revocation (
  receipt_id uuid PRIMARY KEY REFERENCES trustwork.jurisdiction_consent_receipt(id),
  person_id uuid NOT NULL REFERENCES trustwork.person(id),
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A revoked notice is never revived by retry, generic approval, profile consent, or a new receipt.
CREATE TRIGGER jurisdiction_receipt_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_consent_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_revocation_immutable BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_consent_revocation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_receipt_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_consent_receipt FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_revocation_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_consent_revocation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT ON trustwork.jurisdiction_consent_receipt FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
CREATE TRIGGER jurisdiction_serialize BEFORE INSERT ON trustwork.jurisdiction_consent_revocation FOR EACH STATEMENT EXECUTE FUNCTION trustwork.jurisdiction_write_lock();
ALTER TABLE trustwork.jurisdiction_consent_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_consent_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_consent_receipt FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
ALTER TABLE trustwork.jurisdiction_consent_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_consent_revocation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.jurisdiction_consent_revocation FOR ALL TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

-- Internal bounded projection. Only personal-party quotes are supported until a separately scoped company-consent
-- mandate exists. Membership, company.deals.manage and an ordinary action mandate cannot consent for a company.
CREATE FUNCTION trustwork.jurisdiction_quote_notices(p_quote uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE q trustwork.quote%ROWTYPE; limits jsonb; v jsonb; cfg jsonb; s jsonb; scope jsonb; key text;
  subject uuid; docs jsonb; notice jsonb; notices jsonb:='[]';
  unavailable jsonb:='{"status":"unavailable","reasons":["jurisdiction_consent_scope_unavailable"],"notices":[]}';
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
  IF NOT FOUND OR p_actor IS DISTINCT FROM q.seller_person_id OR q.buyer_person_id IS NULL THEN RETURN unavailable; END IF;
  limits:=trustwork.jurisdiction_resolve_quote(p_quote,'send_quote',p_actor);
  IF limits->>'status'<>'resolved' THEN RETURN unavailable; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(limits->'versions') LOOP
    SELECT payload INTO cfg FROM trustwork.hub_config_version WHERE id=(v->>'id')::uuid;
    -- Display only documents authorized for the public legal surface, never staff-only drafts/prelaunch text.
    IF NOT EXISTS(SELECT 1 FROM trustwork.hub_config_version c JOIN trustwork.hub h ON h.id=c.hub_id
      WHERE c.id=(v->>'id')::uuid AND h.lifecycle NOT IN ('draft','preparing','closed')) THEN RETURN unavailable; END IF;
    FOR s IN SELECT value FROM jsonb_array_elements(cfg->'agentSettings'->'jurisdictions') LOOP
      FOR key IN SELECT jsonb_array_elements_text(s->'policy'->'consentRequirements') LOOP
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'consentScopes','[]')) c WHERE c->>'requirement'=key AND c->>'action'='send_quote') THEN RETURN unavailable; END IF;
      END LOOP;
      FOR scope IN SELECT value FROM jsonb_array_elements(coalesce(s->'consentScopes','[]')) WHERE value->>'action'='send_quote' LOOP
        subject:=CASE scope->>'affectedParty' WHEN 'actor' THEN p_actor WHEN 'seller' THEN q.seller_person_id WHEN 'buyer' THEN q.buyer_person_id END;
        IF subject IS NULL THEN RETURN unavailable; END IF;
        -- Include the complete immutable legal/disclosure set. Consent binds every language, but records which was shown.
        SELECT jsonb_agg(jsonb_build_object('key',b->>'key','locale',d.locale,'documentId',d.id,'bodyDigest',d.body_digest,'version',d.version,'body',d.body) ORDER BY b->>'key',d.locale)
          INTO docs FROM jsonb_array_elements(s->'legalBindings') b JOIN trustwork.legal_document_version d ON d.id=(b->>'documentId')::uuid
          JOIN trustwork.hub_profile hp ON hp.hub_id=d.hub_id
          WHERE d.status='active' AND d.locale=ANY(hp.locales)
            AND ((s->'policy'->'legalTextKeys'->d.locale) ? (b->>'key') OR s->'policy'->'disclosureTextKeys'->>d.locale=b->>'key'
              OR s->'policy'->>'liabilityAllocationKey'=b->>'key' OR (s->'policy'->'consentRequirements') ? (b->>'key'));
        IF docs IS NULL OR jsonb_array_length(docs)>500 THEN RETURN unavailable; END IF;
        notice:=jsonb_build_object('policyBindingDigest',limits->>'bindingDigest','quoteId',p_quote,'actorId',p_actor,'action','send_quote',
          'affectedPersonId',subject,'requirement',scope->>'requirement','purpose',scope->>'purpose','documents',docs);
        notices:=notices||jsonb_build_array(notice||jsonb_build_object('noticeDigest',trustwork.admin_digest(notice)));
        IF jsonb_array_length(notices)>100 THEN RETURN unavailable; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('status','available','reasons','[]'::jsonb,'notices',(SELECT coalesce(jsonb_agg(n ORDER BY n->>'noticeDigest'),'[]') FROM (SELECT DISTINCT value n FROM jsonb_array_elements(notices)) x));
END $$;

CREATE FUNCTION trustwork.jurisdiction_consent_preview(p_session uuid,p_quote uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor uuid; q trustwork.quote%ROWTYPE; result jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
  actor:=trustwork.jurisdiction_require_actor(p_session);
  IF q.id IS NULL OR (actor IS DISTINCT FROM q.seller_person_id AND actor IS DISTINCT FROM q.buyer_person_id) THEN
    RAISE EXCEPTION 'consent unavailable' USING ERRCODE='42501';
  END IF;
  result:=trustwork.jurisdiction_quote_notices(q.id,q.seller_person_id);
  -- Recheck after all domain waits; only the affected authenticated person sees their notice/receipt scope.
  PERFORM trustwork.jurisdiction_require_actor(p_session);
  RETURN jsonb_set(result,'{notices}',(SELECT coalesce(jsonb_agg(n ORDER BY n->>'noticeDigest'),'[]') FROM jsonb_array_elements(result->'notices') n WHERE n->>'affectedPersonId'=actor::text));
END $$;

CREATE FUNCTION trustwork.jurisdiction_consent_grant(p_session uuid,p_quote uuid,p_notice text,p_locale text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE preview jsonb; notice jsonb; r trustwork.jurisdiction_consent_receipt%ROWTYPE; actor uuid;
BEGIN
  preview:=trustwork.jurisdiction_consent_preview(p_session,p_quote);
  SELECT value INTO notice FROM jsonb_array_elements(preview->'notices') WHERE value->>'noticeDigest'=p_notice;
  actor:=trustwork.jurisdiction_require_actor(p_session);
  IF notice IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(notice->'documents') d WHERE d->>'locale'=p_locale) THEN
    RAISE EXCEPTION 'exact current notice required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM trustwork.jurisdiction_consent_receipt WHERE person_id=actor AND notice_digest=p_notice;
  IF FOUND THEN
    IF r.locale<>p_locale OR EXISTS(SELECT 1 FROM trustwork.jurisdiction_consent_revocation WHERE receipt_id=r.id) THEN
      RAISE EXCEPTION 'consent cannot be rebound or revived' USING ERRCODE='23514';
    END IF;
  ELSE
    INSERT INTO trustwork.jurisdiction_consent_receipt(person_id,session_id,authz_epoch,notice_digest,notice,locale)
      VALUES(actor,p_session,trustwork.current_authz_epoch(),p_notice,notice,p_locale) RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('receiptId',r.id,'noticeDigest',r.notice_digest,'locale',r.locale,'grantedAt',to_char(r.granted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revoked',false);
END $$;

CREATE FUNCTION trustwork.jurisdiction_consent_revoke(p_session uuid,p_receipt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE actor uuid; r trustwork.jurisdiction_consent_receipt%ROWTYPE;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  actor:=trustwork.jurisdiction_require_actor(p_session);
  SELECT * INTO r FROM trustwork.jurisdiction_consent_receipt WHERE id=p_receipt AND person_id=actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'consent unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO trustwork.jurisdiction_consent_revocation(receipt_id,person_id,session_id) VALUES(r.id,actor,p_session) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('receiptId',r.id,'noticeDigest',r.notice_digest,'locale',r.locale,'grantedAt',to_char(r.granted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revoked',true);
END $$;

-- Restriction-only check, no receipt history projection. Used in the same transaction as binding/rechecking an intent.
CREATE FUNCTION trustwork.jurisdiction_consent_current(p_quote uuid,p_actor uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE preview jsonb; n jsonb;
BEGIN
  preview:=trustwork.jurisdiction_quote_notices(p_quote,p_actor);
  IF preview->>'status'<>'available' THEN RETURN false; END IF;
  FOR n IN SELECT value FROM jsonb_array_elements(preview->'notices') LOOP
    IF NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_consent_receipt r WHERE r.person_id=(n->>'affectedPersonId')::uuid
      AND r.notice_digest=n->>'noticeDigest' AND r.notice=n AND NOT EXISTS(SELECT 1 FROM trustwork.jurisdiction_consent_revocation v WHERE v.receipt_id=r.id)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_consent_preview(uuid,uuid),trustwork.jurisdiction_consent_grant(uuid,uuid,text,text),trustwork.jurisdiction_consent_revoke(uuid,uuid) TO trustwork_app;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_limits(p_quote uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE q trustwork.quote%ROWTYPE; result jsonb; epoch integer;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  PERFORM trustwork.admin_require_caller();
  SELECT authz_epoch INTO epoch FROM trustwork.person WHERE id=trustwork.current_person_id() FOR SHARE;
  IF epoch IS DISTINCT FROM trustwork.current_authz_epoch() THEN RAISE EXCEPTION 'stale actor' USING ERRCODE='42501'; END IF;
  SELECT * INTO q FROM trustwork.quote WHERE id=p_quote FOR SHARE;
  -- Exact party permission, not public quote visibility, project membership or a staff case grant.
  IF NOT FOUND OR NOT (CASE p_action
    WHEN 'send_quote' THEN trustwork.commerce_party_acts(q.seller_person_id,q.seller_company_id,'company.deals.manage')
    ELSE false END) THEN RAISE EXCEPTION 'jurisdiction limits unavailable' USING ERRCODE='42501'; END IF;
  result:=trustwork.jurisdiction_resolve_quote(p_quote,p_action,trustwork.current_person_id());
  RETURN result||jsonb_build_object('consentSatisfied',CASE WHEN jsonb_array_length(result->'consentRequirements')=0 THEN true
    ELSE trustwork.jurisdiction_consent_current(p_quote,trustwork.current_person_id()) END);
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_bind_intent(p_intent uuid, p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; limits jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  IF NOT FOUND OR i.principal_person_id IS DISTINCT FROM trustwork.current_person_id() OR i.context_kind<>'quote' OR i.state NOT IN ('proposed','authorized') THEN RAISE EXCEPTION 'intent not bindable' USING ERRCODE='42501'; END IF;
  limits:=trustwork.jurisdiction_limits(i.context_id::uuid,i.action);
  IF limits->>'status'<>'resolved' OR limits->>'bindingDigest' IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'policy changed' USING ERRCODE='23514',HINT='jurisdiction.policy_changed'; END IF;
  IF (jsonb_array_length(limits->'consentRequirements')>0 AND NOT coalesce((limits->>'consentSatisfied')::boolean,false)) OR limits->>'approval'='human_only' THEN RAISE EXCEPTION 'consent or human execution required' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(limits->'approvalAbove')>0 AND (i.amount_minor IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(limits->'approvalAbove') m WHERE m->>'currency' IS DISTINCT FROM i.currency)) THEN RAISE EXCEPTION 'amount comparison unavailable' USING ERRCODE='23514'; END IF;
  IF i.state<>'proposed' AND (limits->>'approval'<>'pre_authorized' OR EXISTS(SELECT 1 FROM jsonb_array_elements(limits->'approvalAbove') m WHERE i.amount_minor>(m->>'minorUnits')::numeric)) THEN RAISE EXCEPTION 'jurisdiction approval required' USING ERRCODE='23514'; END IF;
  IF i.action_digest IS DISTINCT FROM trustwork.admin_digest(jsonb_build_object('kind','trustwork.assistant.jurisdiction-action.v2',
    'mandate',jsonb_build_object('id',i.mandate_id,'revision',i.mandate_revision),'capabilityId',i.capability_id,'action',i.action,
    'context',jsonb_build_object('kind',i.context_kind,'id',i.context_id),
    'amount',CASE WHEN i.amount_minor IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('minorUnits',i.amount_minor::text,'currency',i.currency) END,
    'effect',i.effect,'jurisdictionBinding',p_digest)) THEN RAISE EXCEPTION 'intent digest omits jurisdiction binding' USING ERRCODE='23514'; END IF;
  INSERT INTO trustwork.jurisdiction_intent_binding(intent_id,binding_digest,action_digest) VALUES(i.id,p_digest,i.action_digest);
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_recheck_intent(p_intent uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; b trustwork.jurisdiction_intent_binding%ROWTYPE; limits jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  IF NOT FOUND OR i.principal_person_id IS DISTINCT FROM trustwork.current_person_id() THEN RAISE EXCEPTION 'intent unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO b FROM trustwork.jurisdiction_intent_binding WHERE intent_id=i.id;
  IF NOT FOUND OR i.context_kind<>'quote' OR b.action_digest<>i.action_digest THEN RETURN false; END IF;
  limits:=trustwork.jurisdiction_limits(i.context_id::uuid,i.action);
  RETURN limits->>'status'='resolved' AND limits->>'bindingDigest'=b.binding_digest AND coalesce((limits->>'consentSatisfied')::boolean,false);
END $$;

CREATE OR REPLACE FUNCTION trustwork.jurisdiction_begin_attempt(p_intent uuid,p_job uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE i trustwork.action_intent%ROWTYPE; b trustwork.jurisdiction_intent_binding%ROWTYPE; limits jsonb;
  q trustwork.quote%ROWTYPE; party_person uuid; party_company uuid; authorized boolean; j trustwork.job%ROWTYPE;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT * INTO j FROM trustwork.job WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.state<>'leased' OR j.kind<>'assistant.dispatch' OR j.payload->>'intentId' IS DISTINCT FROM p_intent::text
    OR j.fencing_token<>p_fence OR j.leased_until<=clock_timestamp() THEN RAISE EXCEPTION 'dispatch lease mismatch' USING ERRCODE='55P03'; END IF;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent FOR UPDATE;
  IF NOT FOUND OR i.state<>'queued' THEN RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing')); END IF;
  SELECT * INTO b FROM trustwork.jurisdiction_intent_binding WHERE intent_id=p_intent;
  IF FOUND AND i.context_kind='quote' AND b.action_digest=i.action_digest THEN
    SELECT * INTO q FROM trustwork.quote WHERE id=i.context_id::uuid;
    IF i.action='send_quote' THEN party_person:=q.seller_person_id;party_company:=q.seller_company_id;
    END IF;
    authorized:=party_person=i.principal_person_id OR EXISTS(SELECT 1 FROM trustwork.membership WHERE person_id=i.principal_person_id AND company_id=party_company AND status='active' AND 'company.deals.manage'=ANY(permissions));
    IF authorized THEN limits:=trustwork.jurisdiction_resolve_quote(i.context_id::uuid,i.action,i.principal_person_id); END IF;
  END IF;
  IF limits->>'status' IS DISTINCT FROM 'resolved' OR limits->>'bindingDigest' IS DISTINCT FROM b.binding_digest
    OR (jsonb_array_length(limits->'consentRequirements')>0 AND NOT trustwork.jurisdiction_consent_current(i.context_id::uuid,i.principal_person_id)) OR limits->>'approval'='human_only' THEN
    PERFORM trustwork.assistant_finish_intent(i.id,'revoked','jurisdiction policy changed or unavailable','jurisdiction:policy_changed');
    RETURN jsonb_build_object('status','refused','reason','jurisdiction_policy_changed');
  END IF;
  RETURN trustwork.assistant_begin_attempt(p_intent,p_job,(limits->>'hubId')::uuid);
END $$;

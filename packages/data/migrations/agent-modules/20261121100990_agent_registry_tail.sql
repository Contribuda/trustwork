-- Existing AGT-001 capabilities, explicitly activated by hub policy; no new verbs or effect handlers.
INSERT INTO trustwork.agent_engine_manifest(module_key,module_version,document,default_control) VALUES
('negotiation','1.0.0',$manifest${"key":"negotiation","version":"1.0.0","family":"deal","status":"live","actions":["negotiate","communicate","schedule","introduce"],"capabilities":[{"id":"negotiation.list_envelopes","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"read","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agent-catalog","schema":"AgentEnvelopeSchema","version":1},"mandateAction":null,"contextKinds":["rfq","quote"],"confirmation":"none","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["none"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent","mcp"],"status":"live","labelKey":"agents.capability.negotiationListEnvelopes"},{"id":"negotiation.list_sessions","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"read","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agents","schema":"NegotiationSessionSchema","version":1},"mandateAction":null,"contextKinds":["rfq","quote"],"confirmation":"none","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["none"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent","mcp"],"status":"live","labelKey":"agents.capability.negotiationListSessions"},{"id":"negotiation.get_session","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"read","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agents","schema":"NegotiationSessionSchema","version":1},"mandateAction":null,"contextKinds":["rfq","quote"],"confirmation":"none","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["none"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent","mcp"],"status":"live","labelKey":"agents.capability.negotiationGetSession"},{"id":"negotiation.negotiate","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"commit","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agents","schema":"NegotiationSessionSchema","version":1},"mandateAction":"negotiate","contextKinds":["rfq","quote"],"confirmation":"mandate","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["state_change","outbound_message"],"acceptsUntrustedText":false,"meters":["agent_actions"],"surfaces":["ui","agent","mcp","a2a"],"status":"live","labelKey":"agents.capability.negotiationNegotiate"},{"id":"negotiation.message","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"commit","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agent-catalog","schema":"AgentEnvelopeSchema","version":1},"mandateAction":"communicate","contextKinds":["rfq","quote"],"confirmation":"mandate","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["state_change","outbound_message"],"acceptsUntrustedText":false,"meters":["agent_actions"],"surfaces":["ui","agent","mcp","a2a"],"status":"live","labelKey":"agents.capability.negotiationMessage"},{"id":"negotiation.schedule","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"commit","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agent-catalog","schema":"AgentEnvelopeSchema","version":1},"mandateAction":"schedule","contextKinds":["rfq","quote"],"confirmation":"mandate","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["state_change","outbound_message"],"acceptsUntrustedText":false,"meters":["agent_actions"],"surfaces":["ui","agent","mcp","a2a"],"status":"live","labelKey":"agents.capability.negotiationSchedule"},{"id":"negotiation.introduce","version":1,"source":{"kind":"module","moduleKey":"negotiation","moduleVersion":"1.0.0"},"kind":"commit","input":{"contract":"agents","schema":"SendEnvelopeCommandSchema","version":1},"output":{"contract":"agent-catalog","schema":"AgentEnvelopeSchema","version":1},"mandateAction":"introduce","contextKinds":["rfq","quote"],"confirmation":"mandate","budgetKind":null,"reads":["shared_party"],"privateDataClasses":[],"sideEffects":["state_change","outbound_message"],"acceptsUntrustedText":false,"meters":["agent_actions"],"surfaces":["ui","agent","mcp","a2a"],"status":"live","labelKey":"agents.capability.negotiationIntroduce"}],"meters":["agent_actions"],"suits":[],"freeFloor":[],"safetySuite":"tests/assistant-goals"}$manifest$::jsonb,$control${"moduleKey":"negotiation","status":"active","principalKinds":["person","company_member","company_representative"],"verifiedCompanyRequired":false,"actions":["negotiate","communicate","schedule","introduce"],"capabilityIds":["negotiation.list_envelopes","negotiation.list_sessions","negotiation.get_session","negotiation.negotiate","negotiation.message","negotiation.schedule","negotiation.introduce"],"dataClasses":[],"limits":{"runsPerDay":50,"actionsPerDay":100,"concurrentRuns":2,"outreachPerWeek":10}}$control$::jsonb),
('representative','1.0.0',$manifest${"key":"representative","version":"1.0.0","family":"core","status":"live","actions":[],"capabilities":[{"id":"representative.list_my_company_mandates","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"read","input":{"contract":"agents","schema":"GrantCompanyMandateCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyMandateSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"none","budgetKind":null,"reads":["owner_private"],"privateDataClasses":[],"sideEffects":["none"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent","mcp"],"status":"live","labelKey":"agents.capability.representativeListMyCompanyMandates"},{"id":"representative.get","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"read","input":{"contract":"agents","schema":"ConfigureRepresentativeCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyRepresentativeSchema","version":1},"mandateAction":null,"contextKinds":["company"],"confirmation":"none","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["none"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent","mcp"],"status":"live","labelKey":"agents.capability.representativeGet"},{"id":"representative.configure","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"ConfigureRepresentativeCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyRepresentativeSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_step_up","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeConfigure"},{"id":"representative.accept","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"ConfigureRepresentativeCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyRepresentativeSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_step_up","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeAccept"},{"id":"representative.suspend","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"RevisionCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyRepresentativeSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_form","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeSuspend"},{"id":"representative.resume","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"RevisionCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyRepresentativeSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_step_up","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeResume"},{"id":"representative.disable","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"RevisionCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyRepresentativeSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_step_up","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeDisable"},{"id":"representative.list_company_mandates","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"read","input":{"contract":"agents","schema":"GrantCompanyMandateCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyMandateSchema","version":1},"mandateAction":null,"contextKinds":["company"],"confirmation":"none","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["none"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent","mcp"],"status":"live","labelKey":"agents.capability.representativeListCompanyMandates"},{"id":"representative.grant_company_mandate","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"GrantCompanyMandateCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyMandateSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_step_up","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeGrantCompanyMandate"},{"id":"representative.reconfirm_company_mandate","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"ReconfirmCompanyMandateCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyMandateSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_step_up","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeReconfirmCompanyMandate"},{"id":"representative.revoke_company_mandate","version":1,"source":{"kind":"module","moduleKey":"representative","moduleVersion":"1.0.0"},"kind":"govern","input":{"contract":"agents","schema":"RevisionCommandSchema","version":1},"output":{"contract":"agents","schema":"CompanyMandateSchema","version":1},"mandateAction":null,"contextKinds":[],"confirmation":"first_party_form","budgetKind":null,"reads":["party_private"],"privateDataClasses":[],"sideEffects":["state_change"],"acceptsUntrustedText":false,"meters":[],"surfaces":["ui","agent"],"status":"live","labelKey":"agents.capability.representativeRevokeCompanyMandate"}],"meters":[],"suits":[],"freeFloor":[],"safetySuite":"tests/assistant-goals"}$manifest$::jsonb,$control${"moduleKey":"representative","status":"active","principalKinds":["person","company_member","company_representative"],"verifiedCompanyRequired":false,"actions":[],"capabilityIds":["representative.list_my_company_mandates","representative.get","representative.configure","representative.accept","representative.suspend","representative.resume","representative.disable","representative.list_company_mandates","representative.grant_company_mandate","representative.reconfirm_company_mandate","representative.revoke_company_mandate"],"dataClasses":[],"limits":{"runsPerDay":50,"actionsPerDay":100,"concurrentRuns":2,"outreachPerWeek":null}}$control$::jsonb);

CREATE OR REPLACE FUNCTION trustwork.agent_modules_policy_refusal(p_hub uuid,p_capability_id text,p_kind text,p_company_verified boolean,p_plan text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_doc jsonb; v_module text := split_part(p_capability_id,'.',1); v_version text; v_manifest trustwork.agent_engine_manifest%ROWTYPE; v_control jsonb; v_switch jsonb;
BEGIN
  IF p_hub IS NULL THEN RETURN 'capability.unknown'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document -> 'capabilities') c
    WHERE m.module_key = v_module AND c ->> 'id' = p_capability_id) THEN RETURN 'capability.unknown'; END IF;
  SELECT document INTO v_doc FROM trustwork.agent_policy_current WHERE hub_id = p_hub;
  IF v_doc IS NOT NULL THEN
    SELECT e ->> 'moduleVersion' INTO v_version FROM jsonb_array_elements(v_doc -> 'policy' -> 'enabledModules') e WHERE e ->> 'moduleKey' = v_module;
    SELECT m INTO v_control FROM jsonb_array_elements(v_doc -> 'modules') m WHERE m ->> 'moduleKey' = v_module;
    IF v_version IS NULL OR v_control IS NULL THEN RETURN 'module.not_enabled'; END IF;
    SELECT * INTO v_manifest FROM trustwork.agent_engine_manifest WHERE module_key = v_module AND module_version = v_version;
  ELSE
    IF v_module IN ('negotiation','representative') THEN RETURN 'module.not_enabled'; END IF;
    -- Exactly one shipped default version. A later multi-version rollout must name its default explicitly.
    IF (SELECT count(*) FROM trustwork.agent_engine_manifest WHERE module_key = v_module) <> 1 THEN RETURN 'capability.unknown'; END IF;
    SELECT * INTO v_manifest FROM trustwork.agent_engine_manifest WHERE module_key = v_module;
    v_control := v_manifest.default_control;
  END IF;
  IF v_manifest.module_key IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest.document -> 'capabilities') c
    WHERE c ->> 'id' = p_capability_id) THEN RETURN 'capability.unknown'; END IF;
  IF (v_control ->> 'status') NOT IN ('beta','active') THEN RETURN 'module.not_serving'; END IF;
  IF NOT (v_control -> 'principalKinds') ? p_kind THEN RETURN 'module.not_eligible'; END IF;
  IF (v_control ->> 'verifiedCompanyRequired')::boolean AND p_kind <> 'person' AND NOT coalesce(p_company_verified,false) THEN RETURN 'module.verified_company_required'; END IF;
  IF NOT (v_control -> 'capabilityIds') ? p_capability_id THEN RETURN 'capability.off_for_hub'; END IF;
  SELECT x INTO v_switch FROM jsonb_array_elements(v_doc -> 'capabilities') x WHERE x ->> 'capabilityId' = p_capability_id;
  IF (v_switch ->> 'offForHub')::boolean THEN RETURN 'capability.off_for_hub'; END IF;
  IF (v_switch -> 'offForPrincipalKinds') ? p_kind THEN RETURN 'capability.off_for_principal_kind'; END IF;
  IF p_plan IS NULL OR p_plan <> 'free' THEN RETURN 'capability.off_for_plan'; END IF;
  IF (v_switch -> 'offForPlans') ? p_plan THEN RETURN 'capability.off_for_plan'; END IF;
  RETURN NULL;
END $$;

-- A narrow ordering fence for local envelopes and authority-changing AGT-001 commands. It grants no authority.
CREATE FUNCTION trustwork.agent_modules_lock_envelope_boundary() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE='28000',HINT='access.no_principal';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.agent-envelope-authority.v1',0));
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_lock_envelope_boundary() FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_lock_envelope_boundary() TO trustwork_app;

ALTER FUNCTION trustwork.agents_deliver_envelope(jsonb,jsonb,jsonb) RENAME TO agent_modules_deliver_envelope_owned;
REVOKE ALL ON FUNCTION trustwork.agent_modules_deliver_envelope_owned(jsonb,jsonb,jsonb) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_deliver_envelope(p_actor jsonb,p_envelope jsonb,p_settings jsonb)
RETURNS TABLE(envelope_id uuid,session_id uuid,outcome text,reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE m trustwork.mandate%ROWTYPE; cm trustwork.company_mandate%ROWTYPE;
  v_hub uuid; v_company uuid; v_rep uuid; v_cap text; v_action text; v_refusal text;
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  IF p_actor->>'kind'='own_agent' THEN
    SELECT * INTO m FROM trustwork.mandate WHERE id=(p_actor->>'mandateId')::uuid AND principal_person_id=trustwork.current_person_id() AND grantee_kind='own_agent';
  ELSIF p_actor->>'kind' IN ('colleague_agent','company_representative') THEN
    SELECT * INTO cm FROM trustwork.company_mandate WHERE id=(p_actor->>'companyMandateId')::uuid AND company_id=trustwork.current_company_id();
    IF cm.executor_kind='person_agent' AND p_actor->>'kind'='colleague_agent' AND cm.executor_person_id=trustwork.current_person_id()
      OR cm.executor_kind='company_representative' AND p_actor->>'kind'='company_representative' AND EXISTS (
        SELECT 1 FROM trustwork.company_representative r WHERE r.id=cm.representative_id AND r.company_id=cm.company_id AND r.accountable_person_id=trustwork.current_person_id()) THEN
      SELECT * INTO m FROM trustwork.mandate WHERE id=cm.mandate_id;
      IF cm.executor_kind='company_representative' THEN v_rep:=cm.company_id; END IF;
    END IF;
  END IF;
  v_hub:=nullif(p_settings->>'hubId','')::uuid;
  v_company:=m.on_behalf_company_id;
  IF m.id IS NULL OR v_hub IS NULL OR (v_company IS NOT NULL AND v_company IS DISTINCT FROM trustwork.current_company_id()) THEN
    RAISE EXCEPTION 'speaker authority unavailable' USING ERRCODE='42501',HINT='access.not_found';
  END IF;
  PERFORM trustwork.agent_modules_lock_current_authority(v_hub,v_company,NULL);
  IF NOT EXISTS (SELECT 1 FROM trustwork.agent_mandate_provenance p JOIN trustwork.agent_serving_hub b ON b.id=p.serving_binding_id
    WHERE p.mandate_id=m.id AND p.mandate_revision=m.revision AND p.mandate_digest=m.digest AND p.hub_id=v_hub AND b.hub_id=v_hub AND b.active) THEN
    RAISE EXCEPTION 'immutable hub provenance unavailable' USING ERRCODE='42501',HINT='agents.hub_provenance_unavailable';
  END IF;
  v_action:=trustwork.agents_intent_action(p_envelope->>'intent');
  v_cap:=CASE v_action WHEN 'negotiate' THEN 'negotiation.negotiate' WHEN 'communicate' THEN 'negotiation.message'
    WHEN 'schedule' THEN 'negotiation.schedule' WHEN 'introduce' THEN 'negotiation.introduce' END;
  v_refusal:=trustwork.agent_modules_policy_refusal(v_hub,v_cap,
    CASE WHEN v_rep IS NOT NULL THEN 'company_representative' WHEN v_company IS NOT NULL THEN 'company_member' ELSE 'person' END,
    v_company IS NOT NULL AND EXISTS(SELECT 1 FROM trustwork.company WHERE id=v_company AND claim_status='verified'),'free');
  IF v_cap IS NULL OR v_refusal IS NOT NULL OR trustwork.agent_modules_dispatch_refusal(v_hub,'negotiation',v_cap,v_action,trustwork.current_person_id(),NULL,v_rep) IS NOT NULL THEN
    RAISE EXCEPTION 'current envelope capability unavailable' USING ERRCODE='42501',HINT='access.mandate_revoked';
  END IF;
  -- Owning command evaluates the clock after every authority wait, locks the original mandate and preserves receipt/idempotency rules.
  RETURN QUERY SELECT * FROM trustwork.agent_modules_deliver_envelope_owned(p_actor,p_envelope,p_settings);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_deliver_envelope(jsonb,jsonb,jsonb) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_deliver_envelope(jsonb,jsonb,jsonb) TO trustwork_app;

ALTER FUNCTION trustwork.agents_configure_representative(uuid,uuid,integer) RENAME TO agent_modules_owned_configure_representative;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_configure_representative(uuid,uuid,integer) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_configure_representative(p_company_id uuid, p_accountable_person_id uuid, p_expected_revision integer) RETURNS trustwork.company_representative
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_configure_representative(p_company_id,p_accountable_person_id,p_expected_revision);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_configure_representative(uuid,uuid,integer) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_configure_representative(uuid,uuid,integer) TO trustwork_app;

ALTER FUNCTION trustwork.agents_accept_representative(uuid) RENAME TO agent_modules_owned_accept_representative;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_accept_representative(uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_accept_representative(p_company_id uuid) RETURNS trustwork.company_representative
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_accept_representative(p_company_id);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_accept_representative(uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_accept_representative(uuid) TO trustwork_app;

ALTER FUNCTION trustwork.agents_suspend_representative(uuid) RENAME TO agent_modules_owned_suspend_representative;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_suspend_representative(uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_suspend_representative(p_company_id uuid) RETURNS trustwork.company_representative
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_suspend_representative(p_company_id);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_suspend_representative(uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_suspend_representative(uuid) TO trustwork_app;

ALTER FUNCTION trustwork.agents_resume_representative(uuid,integer) RENAME TO agent_modules_owned_resume_representative;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_resume_representative(uuid,integer) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_resume_representative(p_company_id uuid, p_expected_revision integer) RETURNS trustwork.company_representative
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_resume_representative(p_company_id,p_expected_revision);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_resume_representative(uuid,integer) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_resume_representative(uuid,integer) TO trustwork_app;

ALTER FUNCTION trustwork.agents_disable_representative(uuid) RENAME TO agent_modules_owned_disable_representative;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_disable_representative(uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_disable_representative(p_company_id uuid) RETURNS trustwork.company_representative
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_disable_representative(p_company_id);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_disable_representative(uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_disable_representative(uuid) TO trustwork_app;

ALTER FUNCTION trustwork.agents_grant_company_mandate(uuid,jsonb,text) RENAME TO agent_modules_owned_grant_company_mandate;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_grant_company_mandate(uuid,jsonb,text) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_grant_company_mandate(p_mandate_id uuid, p_terms jsonb, p_terms_digest text) RETURNS trustwork.company_mandate
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_grant_company_mandate(p_mandate_id,p_terms,p_terms_digest);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_grant_company_mandate(uuid,jsonb,text) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_grant_company_mandate(uuid,jsonb,text) TO trustwork_app;

ALTER FUNCTION trustwork.agents_reconfirm_company_mandate(uuid,uuid,text) RENAME TO agent_modules_owned_reconfirm_company_mandate;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_reconfirm_company_mandate(uuid,uuid,text) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_reconfirm_company_mandate(p_company_mandate_id uuid, p_new_mandate_id uuid, p_terms_digest text) RETURNS trustwork.company_mandate
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_reconfirm_company_mandate(p_company_mandate_id,p_new_mandate_id,p_terms_digest);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_reconfirm_company_mandate(uuid,uuid,text) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_reconfirm_company_mandate(uuid,uuid,text) TO trustwork_app;

ALTER FUNCTION trustwork.agents_revoke_company_mandate(uuid,integer) RENAME TO agent_modules_owned_revoke_company_mandate;
REVOKE ALL ON FUNCTION trustwork.agent_modules_owned_revoke_company_mandate(uuid,integer) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agents_revoke_company_mandate(p_company_mandate_id uuid, p_expected_revision integer) RETURNS trustwork.company_mandate
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_lock_envelope_boundary();
  RETURN trustwork.agent_modules_owned_revoke_company_mandate(p_company_mandate_id,p_expected_revision);
END $$;
REVOKE ALL ON FUNCTION trustwork.agents_revoke_company_mandate(uuid,integer) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_revoke_company_mandate(uuid,integer) TO trustwork_app;

-- Additive HUB disclosure port only; OUTR-002 owns its future activation and immutable template source.
CREATE FUNCTION trustwork.jurisdiction_disclosure_bundle(p_session uuid,p_ctx jsonb,p_version uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v trustwork.hub_config_version%ROWTYPE; locales text[]; a jsonb; bindings jsonb;
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  SELECT c.* INTO v FROM trustwork.hub_config_version c JOIN trustwork.hub_config_current head ON head.version_id=c.id
    WHERE c.id=p_version AND c.domain='jurisdiction' AND c.status='active' AND c.effective_from<=clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'current policy unavailable' USING ERRCODE='42501'; END IF;
  a:=trustwork.jurisdiction_staff_snapshot(p_session,p_ctx,v.hub_id,'admin.hub.jurisdiction.edit');
  IF NOT EXISTS(SELECT 1 FROM trustwork.hub WHERE id=v.hub_id AND lifecycle NOT IN ('draft','preparing','closed')) THEN
    RAISE EXCEPTION 'public counsel text unavailable' USING ERRCODE='23514';
  END IF;
  SELECT hp.locales INTO locales FROM trustwork.hub_profile hp WHERE hp.hub_id=v.hub_id;
  PERFORM trustwork.jurisdiction_validate(v.hub_id,v.payload,locales);
  SELECT jsonb_agg(jsonb_build_object('jurisdiction',s->>'jurisdiction','key',b->>'key','locale',d.locale,'documentId',d.id,
    'bodyDigest',d.body_digest,'version',d.version,'body',d.body) ORDER BY s->>'jurisdiction',d.locale)
    INTO bindings FROM jsonb_array_elements(v.payload->'agentSettings'->'jurisdictions') s,
      jsonb_array_elements(s->'legalBindings') b JOIN trustwork.legal_document_version d ON d.id=(b->>'documentId')::uuid
    WHERE d.locale=ANY(locales) AND s->'policy'->'disclosureTextKeys'->>d.locale=b->>'key';
  IF bindings IS NULL OR jsonb_array_length(bindings)>500 OR NOT trustwork.jurisdiction_review_authority(a) THEN
    RAISE EXCEPTION 'disclosure unavailable' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('policyVersionId',v.id,'policyDigest',v.payload_digest,'locales',locales,'bindings',bindings);
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_disclosure_bundle(uuid,jsonb,uuid) TO trustwork_app;

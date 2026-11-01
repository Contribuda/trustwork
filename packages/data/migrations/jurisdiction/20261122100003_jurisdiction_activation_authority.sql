-- Preserve HUB-001 activation behavior, but executable jurisdiction policy requires the exact API session and
-- current role/elevation/epoch after domain and approval waits. Other configuration domains are unchanged.
ALTER FUNCTION trustwork.hubs_activate_config(jsonb,uuid,integer,uuid) RENAME TO hubs_activate_config_base;
CREATE FUNCTION trustwork.hubs_activate_config(p_ctx jsonb,p_version uuid,p_expected_revision integer,p_approval_id uuid) RETURNS trustwork.hub_config_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v trustwork.hub_config_version%ROWTYPE; result trustwork.hub_config_version%ROWTYPE; authority jsonb;
BEGIN
  SELECT * INTO v FROM trustwork.hub_config_version WHERE id=p_version;
  IF v.domain='jurisdiction' AND v.payload->'agentSettings'->>'schemaVersion'='2' THEN
    PERFORM trustwork.jurisdiction_lock();
    PERFORM trustwork.hubs_lock_domain(v.hub_id,v.domain);
    PERFORM 1 FROM trustwork.hub_config_version WHERE id=p_version FOR UPDATE;
    PERFORM 1 FROM trustwork.second_person_approval WHERE id=p_approval_id FOR UPDATE;
    authority:=trustwork.jurisdiction_staff_snapshot((p_ctx->>'sessionId')::uuid,p_ctx,v.hub_id,'admin.hub.jurisdiction.activate');
    result:=trustwork.hubs_activate_config_base(p_ctx,p_version,p_expected_revision,p_approval_id);
    IF NOT trustwork.jurisdiction_review_authority(authority) THEN
      RAISE EXCEPTION 'activation authority changed after domain wait' USING ERRCODE='42501';
    END IF;
    RETURN result;
  END IF;
  RETURN trustwork.hubs_activate_config_base(p_ctx,p_version,p_expected_revision,p_approval_id);
END $$;
REVOKE EXECUTE ON FUNCTION trustwork.hubs_activate_config_base(jsonb,uuid,integer,uuid) FROM trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.hubs_activate_config(jsonb,uuid,integer,uuid) TO trustwork_app;

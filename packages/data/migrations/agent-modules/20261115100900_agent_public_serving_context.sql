-- AGT-003: anonymous public projections use explicit installation authority, never a fabricated person.
-- Only a boolean is returned. No party data, caller identity, supplied hub or configurable executor is accepted.
CREATE FUNCTION trustwork.agent_modules_public_serving_context(p_origin text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE b trustwork.agent_serving_hub%ROWTYPE;
BEGIN
  SELECT * INTO b FROM trustwork.agent_serving_hub WHERE origin = p_origin AND active;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM trustwork.agent_modules_lock_epochs(b.hub_id,NULL,NULL,NULL);
  RETURN EXISTS (SELECT 1 FROM trustwork.agent_serving_hub WHERE id = b.id AND active);
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_public_serving_context(text) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_public_serving_context(text) TO trustwork_app;

-- The adapter accepts proof of a presented token, not a caller's connection snapshot or scopes.
-- Return only the intersection of the original authorization and the current consent, for the current owner.
CREATE FUNCTION trustwork.agent_modules_mcp_token_scopes(p_connection uuid,p_hash bytea,p_audience text,p_dpop text) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE t trustwork.connection_token%ROWTYPE; f trustwork.connection_token_family%ROWTYPE; v_scopes text[];
BEGIN
  IF trustwork.current_person_id() IS NULL OR p_hash IS NULL OR octet_length(p_hash)<>32 THEN RETURN NULL; END IF;
  SELECT x.* INTO t FROM trustwork.connection_token x JOIN trustwork.connection c ON c.id=x.connection_id
    WHERE x.token_hash=p_hash AND x.kind='access' AND c.id=p_connection AND c.person_id=trustwork.current_person_id();
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO f FROM trustwork.connection_token_family WHERE id=t.family_id FOR SHARE;
  SELECT * INTO t FROM trustwork.connection_token WHERE id=t.id FOR SHARE;
  IF t.revoked_at IS NOT NULL OR t.expires_at<=clock_timestamp() OR t.audience IS DISTINCT FROM p_audience
    OR f.revoked_at IS NOT NULL OR f.absolute_expires_at<=clock_timestamp() OR f.audience IS DISTINCT FROM p_audience
    OR f.connection_id<>p_connection OR f.dpop_jkt IS DISTINCT FROM p_dpop THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s ORDER BY s) INTO v_scopes
    FROM trustwork.connection_token_introspect(p_hash,p_audience) live
    JOIN trustwork.oauth_authorization_code code ON code.id=f.code_id AND code.connection_id=p_connection AND code.resource=p_audience
    CROSS JOIN LATERAL unnest(live.scopes) s WHERE s=ANY(code.scopes);
  RETURN v_scopes;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_mcp_token_scopes(uuid,bytea,text,text) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_mcp_token_scopes(uuid,bytea,text,text) TO trustwork_app;

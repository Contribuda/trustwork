-- Hold only the authenticated caller's existing identity basis through the owning service invocation.
-- This grants no company/resource authority and never changes the transaction principal.
CREATE FUNCTION trustwork.agent_modules_lock_authenticated_invocation(p_session uuid,p_company uuid,p_company_epoch integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_person uuid := trustwork.current_person_id(); v_epoch integer; v_company uuid; s trustwork.session%ROWTYPE;
BEGIN
  -- Serialize owning profile writes and epoch revocation while allowing nested mandate FK references.
  -- No other person is locked; KEY SHARE cannot update identity authority.
  SELECT authz_epoch INTO v_epoch FROM trustwork.person WHERE id=v_person FOR NO KEY UPDATE;
  IF v_epoch IS NULL OR v_epoch IS DISTINCT FROM nullif(current_setting('trustwork.authz_epoch',true),'')::integer THEN
    RAISE EXCEPTION 'current identity basis changed' USING ERRCODE='28000',HINT='access.stale_epoch';
  END IF;
  SELECT company_id INTO v_company FROM trustwork.membership WHERE person_id=v_person AND status='active' AND valid_from<=clock_timestamp();
  IF v_company IS DISTINCT FROM p_company THEN
    RAISE EXCEPTION 'current membership basis changed' USING ERRCODE='28000',HINT='access.stale_epoch';
  END IF;
  IF v_company IS NOT NULL THEN
    SELECT authz_epoch INTO v_epoch FROM trustwork.company WHERE id=v_company FOR SHARE;
    IF v_epoch IS DISTINCT FROM p_company_epoch THEN
      RAISE EXCEPTION 'current company basis changed' USING ERRCODE='28000',HINT='access.stale_epoch';
    END IF;
  END IF;
  SELECT * INTO s FROM trustwork.session WHERE id=p_session AND person_id=v_person FOR SHARE;
  IF s.id IS NULL OR s.revoked_at IS NOT NULL OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'current authenticated session unavailable' USING ERRCODE='28000',HINT='auth.session_invalid';
  END IF;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_lock_authenticated_invocation(uuid,uuid,integer) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_lock_authenticated_invocation(uuid,uuid,integer) TO trustwork_app;

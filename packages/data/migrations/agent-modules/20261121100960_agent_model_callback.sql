-- Narrow AGT/AST/BILL callback fence on the original admitted fake-only model operation.
-- No source/retention/residency/model policy is invented; owning governance remains mandatory before this port.
CREATE FUNCTION trustwork.agent_modules_enter_model_effect(p_operation text,p_token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE r trustwork.model_call%ROWTYPE; v_epoch integer; v_budget uuid; s trustwork.session%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id=p_operation AND principal_id=trustwork.current_person_id();
  IF r.operation_id IS NULL OR r.dispatch_token<>p_token OR NOT r.invoked OR r.state<>'outcome_unknown' OR r.candidate ->> 'mode'<>'fake' THEN RETURN false; END IF;
  PERFORM trustwork.agent_modules_check_model_scope(r.request,r.binding);
  SELECT authz_epoch INTO v_epoch FROM trustwork.person WHERE id=r.principal_id FOR SHARE;
  IF v_epoch IS DISTINCT FROM (r.binding ->> 'authzEpoch')::integer THEN RETURN false; END IF;
  -- A personal model context may use an existing company participation. Lock that current owning epoch too.
  PERFORM co.id FROM trustwork.company co JOIN trustwork.membership m ON m.company_id=co.id
    WHERE m.person_id=r.principal_id AND m.status='active' AND m.valid_from<=clock_timestamp() FOR SHARE OF co;
  SELECT * INTO s FROM trustwork.session WHERE id=(r.binding ->> 'sessionId')::uuid AND person_id=r.principal_id FOR SHARE;
  IF s.id IS NULL OR s.revoked_at IS NOT NULL OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  -- Existing owning helper locks the exact mandate and run and checks current context and budget ownership.
  v_budget := trustwork.assistant_model_check(r.request,r.binding);
  IF NOT trustwork.billing_lock_effect_authority(r.reservation_id,v_budget) THEN RETURN false; END IF;
  PERFORM 1 FROM trustwork.model_call WHERE operation_id=p_operation AND dispatch_token=p_token AND invoked AND state='outcome_unknown' FOR UPDATE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_enter_model_effect(text,uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_enter_model_effect(text,uuid) TO trustwork_app;

-- KEYS-001 / LLM-001 / AGT-003: bounded fake-only callback authority.
-- Conservative absent-row fence; no provider I/O, secrets, financial reads or policy defaults.
CREATE FUNCTION trustwork.providers_callback_lock() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
BEGIN
  PERFORM trustwork.jurisdiction_lock();
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.providers.callback_authority',0));
END $$;
CREATE FUNCTION trustwork.providers_callback_writer() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
BEGIN PERFORM trustwork.providers_callback_lock(); RETURN NULL; END $$;

-- Statement fencing protects first insertions and replacement rows, before their row locks.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['provider_connection','model_route','egress_rule','provider_route_kill_switch',
    'kill_switch','hub_profile','hub_config_version','hub_config_current','provider_budget','provider_usage','secret_ref'] LOOP
    EXECUTE format('CREATE TRIGGER providers_callback_fence BEFORE INSERT OR UPDATE OR DELETE ON trustwork.%I FOR EACH STATEMENT EXECUTE FUNCTION trustwork.providers_callback_writer()',name);
  END LOOP;
END $$;

-- Actual owning entrypoints can lock in DECLARE initializers or before their first write.
-- Wrap before those initializers, preserving the complete old body, signature, defaults and authority checks.
-- Internal renamed implementations have no direct runtime grant.
DO $wrap$
DECLARE p record; definition text; arguments text; renamed text; body text; app_allowed boolean; worker_allowed boolean;
BEGIN
  FOR p IN SELECT f.oid,f.proname,f.proretset,f.prorettype,f.proargnames,f.proargmodes,f.proallargtypes,f.proargtypes
    FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='trustwork' AND f.proname=ANY(ARRAY[
      'providers_create_connection','providers_update_connection','providers_store_secret','providers_revoke_secret',
      'providers_record_test','providers_enable_connection','providers_disable_connection','providers_set_egress_rule',
      'providers_draft_route','providers_activate_route','providers_disable_route','providers_create_budget',
      'providers_update_budget','providers_retire_budget','providers_record_pricing','providers_engage_kill','providers_release_kill',
      'providers_authorize_call','providers_settle_call','providers_release_call','providers_destroy_expired_secrets',
      'hubs_create','hubs_update_profile','hubs_draft_config','hubs_cancel_config','hubs_activate_config',
      'admin_engage_kill_switch','admin_release_kill_switch','models_begin','models_admit','models_fallback','models_finish','models_recover'
    ]) ORDER BY f.proname LOOP
    definition:=pg_get_functiondef(p.oid);
    app_allowed:=has_function_privilege('trustwork_app',p.oid,'EXECUTE');
    worker_allowed:=has_function_privilege('trustwork_worker',p.oid,'EXECUTE');
    SELECT string_agg(format('%I',p.proargnames[x]),',' ORDER BY x) INTO arguments
      FROM generate_subscripts(p.proargnames,1) x WHERE p.proargmodes IS NULL OR p.proargmodes[x] IN ('i','b','v');
    renamed:='callback_unfenced_'||p.proname;
    EXECUTE format('ALTER FUNCTION %s RENAME TO %I',p.oid::regprocedure,renamed);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,trustwork_app,trustwork_worker',p.oid::regprocedure);
    body:=CASE WHEN p.proretset THEN format('RETURN QUERY SELECT * FROM trustwork.%I(%s); RETURN;',renamed,arguments)
      WHEN p.prorettype='void'::regtype THEN format('PERFORM trustwork.%I(%s); RETURN;',renamed,arguments)
      ELSE format('RETURN trustwork.%I(%s);',renamed,arguments) END;
    EXECUTE split_part(definition,'AS $function$',1)||'AS $function$ BEGIN PERFORM trustwork.providers_callback_lock(); '||body||' END $function$';
    EXECUTE format('REVOKE ALL ON FUNCTION trustwork.%I(%s) FROM PUBLIC,trustwork_app,trustwork_worker',p.proname,pg_get_function_identity_arguments(p.oid));
    IF app_allowed THEN EXECUTE format('GRANT EXECUTE ON FUNCTION trustwork.%I(%s) TO trustwork_app',p.proname,pg_get_function_identity_arguments(p.oid)); END IF;
    IF worker_allowed THEN EXECUTE format('GRANT EXECUTE ON FUNCTION trustwork.%I(%s) TO trustwork_worker',p.proname,pg_get_function_identity_arguments(p.oid)); END IF;
  END LOOP;
END $wrap$;

CREATE FUNCTION trustwork.providers_model_callback_allowed(p_operation text,p_token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=trustwork,pg_temp AS $$
DECLARE r trustwork.model_call%ROWTYPE; current_route jsonb;
BEGIN
  PERFORM trustwork.providers_callback_lock();
  SELECT * INTO r FROM trustwork.model_call WHERE operation_id=p_operation AND principal_id=trustwork.current_person_id();
  IF r.operation_id IS NULL OR r.dispatch_token<>p_token OR NOT r.invoked OR r.state<>'outcome_unknown'
    OR r.candidate->>'mode'<>'fake' OR r.route->>'stage'<>'current'
    OR jsonb_typeof(r.request->'sourceBindings') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(r.request->'sourceBindings')=0 THEN RETURN false; END IF;
  current_route:=trustwork.providers_authorize_call(r.request||jsonb_build_object('requestRef',r.operation_id),true);
  RETURN current_route->>'allowed'='true' AND current_route->>'routeId'=r.route->>'routeId'
    AND current_route->'routeVersion'=r.route->'routeVersion' AND current_route->'limits'=r.route->'limits'
    AND (current_route->'candidates') @> jsonb_build_array(r.candidate);
END $$;

ALTER FUNCTION trustwork.agent_modules_enter_model_effect(text,uuid) RENAME TO agent_modules_enter_model_owning_effect;
REVOKE ALL ON FUNCTION trustwork.agent_modules_enter_model_owning_effect(text,uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agent_modules_enter_model_effect(p_operation text,p_token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
  -- This wait precedes every AGT/person/mandate/BILL/operation lock in the preserved command.
  IF NOT trustwork.providers_model_callback_allowed(p_operation,p_token) THEN RETURN false; END IF;
  RETURN trustwork.agent_modules_enter_model_owning_effect(p_operation,p_token);
END $$;
REVOKE ALL ON FUNCTION trustwork.providers_callback_lock(),trustwork.providers_callback_writer(),
  trustwork.providers_model_callback_allowed(text,uuid),trustwork.agent_modules_enter_model_effect(text,uuid)
  FROM PUBLIC,trustwork_app,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_enter_model_effect(text,uuid) TO trustwork_app;

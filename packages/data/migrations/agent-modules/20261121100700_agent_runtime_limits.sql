-- Free protection limits are serialized independently of billable capacity and never relaxed by payment.
CREATE TABLE trustwork.agent_runtime_usage (
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  module_key text NOT NULL,
  measure text NOT NULL CHECK(measure IN ('run','action')),
  operation_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES trustwork.run(id) DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(hub_id,principal_person_id,module_key,measure,operation_id)
);
ALTER TABLE trustwork.agent_runtime_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_runtime_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_usage_owner_read ON trustwork.agent_runtime_usage FOR SELECT TO trustwork_app USING(principal_person_id = trustwork.current_person_id());
CREATE POLICY runtime_usage_maintenance ON trustwork.agent_runtime_usage TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
GRANT SELECT ON trustwork.agent_runtime_usage TO trustwork_app;
CREATE TRIGGER runtime_usage_immutable BEFORE UPDATE OR DELETE ON trustwork.agent_runtime_usage FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Internal only. Admission already holds current authority epochs. One quota lock covers both measures and all
-- subscriptions of the same principal/module/hub. Unknown external outcomes keep their charge to the protection quota.
CREATE FUNCTION trustwork.agent_modules_reserve_quota(p_hub uuid,p_person uuid,p_module text,p_run uuid,p_operation uuid,p_measure text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE v_doc jsonb; v_limits jsonb; v_zone text; v_from timestamptz; v_limit integer; v_used bigint;
BEGIN
  IF p_measure NOT IN ('run','action') OR p_run IS NULL OR p_operation IS NULL THEN RETURN 'quota_authority_missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agt-quota:' || p_hub::text || ':' || p_person::text || ':' || p_module,0));
  IF EXISTS(SELECT 1 FROM trustwork.agent_runtime_usage WHERE hub_id=p_hub AND principal_person_id=p_person
    AND module_key=p_module AND measure=p_measure AND operation_id=p_operation AND run_id=p_run) THEN RETURN NULL; END IF;
  SELECT document INTO v_doc FROM trustwork.agent_policy_current WHERE hub_id=p_hub;
  SELECT m -> 'limits' INTO v_limits FROM jsonb_array_elements(v_doc -> 'modules') m WHERE m ->> 'moduleKey'=p_module;
  v_zone := v_doc #>> '{calendar,timeZone}';
  IF v_limits IS NULL OR v_zone IS NULL THEN RETURN 'quota_authority_missing'; END IF;
  v_from := date_trunc('day',clock_timestamp() AT TIME ZONE v_zone) AT TIME ZONE v_zone;
  v_limit := (v_limits ->> CASE WHEN p_measure='run' THEN 'runsPerDay' ELSE 'actionsPerDay' END)::integer;
  SELECT count(*) INTO v_used FROM trustwork.agent_runtime_usage WHERE hub_id=p_hub AND principal_person_id=p_person
    AND module_key=p_module AND measure=p_measure AND recorded_at>=v_from;
  IF v_limit IS NULL OR v_used>=v_limit THEN RETURN 'quota_' || p_measure || '_daily'; END IF;
  IF p_measure='run' THEN
    SELECT count(*) INTO v_used FROM trustwork.agent_runtime_usage u JOIN trustwork.run r ON r.id=u.run_id
      WHERE u.hub_id=p_hub AND u.principal_person_id=p_person AND u.module_key=p_module AND u.measure='run'
      AND r.state NOT IN ('completed','failed','cancelled');
    IF v_used >= (v_limits ->> 'concurrentRuns')::integer THEN RETURN 'quota_concurrent'; END IF;
  END IF;
  INSERT INTO trustwork.agent_runtime_usage(hub_id,principal_person_id,module_key,measure,operation_id,run_id)
    VALUES(p_hub,p_person,p_module,p_measure,p_operation,p_run);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_reserve_quota(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC,trustwork_app,trustwork_worker;

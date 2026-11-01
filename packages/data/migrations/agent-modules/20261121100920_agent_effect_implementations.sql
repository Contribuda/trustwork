-- Versioned code declarations, not a model-selected provider name. No production effect implementation is enabled.
ALTER TABLE trustwork.agent_effect_handler ADD COLUMN implementation jsonb
  CHECK(implementation IS NULL OR (jsonb_typeof(implementation)='object' AND implementation ?& ARRAY['id','moduleKey','moduleVersion','capabilityId','provider','operation','mandateAction','contextKinds','privateDataClasses','egress','payloadContract']));
CREATE TABLE trustwork.agent_effect_attempt_binding (
  attempt_id uuid PRIMARY KEY REFERENCES trustwork.action_attempt(id),
  implementation jsonb NOT NULL
);
ALTER TABLE trustwork.agent_effect_attempt_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_effect_attempt_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_attempt_binding_maintenance ON trustwork.agent_effect_attempt_binding TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER effect_attempt_binding_immutable BEFORE UPDATE OR DELETE ON trustwork.agent_effect_attempt_binding
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE OR REPLACE FUNCTION trustwork.agent_modules_effect_binding(p_hub uuid,p_capability text,p_provider text,p_operation text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=trustwork,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM trustwork.agent_effect_handler h
    CROSS JOIN LATERAL (SELECT trustwork.agent_modules_capability_binding(p_hub,p_capability) AS cap) c
    WHERE h.capability_id=p_capability AND h.provider=p_provider AND h.operation=p_operation
      AND h.module_key=c.cap #>> '{source,moduleKey}' AND h.module_version=c.cap #>> '{source,moduleVersion}'
      AND h.implementation ->> 'id'<>'' AND h.implementation ->> 'payloadContract'<>''
      AND h.implementation ->> 'moduleKey'=h.module_key AND h.implementation ->> 'moduleVersion'=h.module_version
      AND h.implementation ->> 'capabilityId'=h.capability_id AND h.implementation ->> 'provider'=h.provider
      AND h.implementation ->> 'operation'=h.operation AND h.implementation ->> 'mandateAction'=c.cap ->> 'mandateAction'
      AND h.implementation -> 'contextKinds'=c.cap -> 'contextKinds'
      AND h.implementation -> 'privateDataClasses'=c.cap -> 'privateDataClasses'
      -- A network effect needs its owning activated egress/source/residency port. None ships in this slice.
      AND h.implementation ->> 'egress'='none')
$$;

ALTER FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) RENAME TO agent_modules_begin_limited_attempt;
REVOKE ALL ON FUNCTION trustwork.agent_modules_begin_limited_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.assistant_begin_attempt(p_intent uuid,p_job uuid,p_hub uuid,p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_result jsonb; i trustwork.action_intent%ROWTYPE; p trustwork.agent_intent_provenance%ROWTYPE; d jsonb;
BEGIN
  v_result := trustwork.agent_modules_begin_limited_attempt(p_intent,p_job,p_hub,p_fence);
  IF v_result ->> 'status'<>'dispatch' THEN RETURN v_result; END IF;
  SELECT * INTO i FROM trustwork.action_intent WHERE id=p_intent;
  SELECT * INTO p FROM trustwork.agent_intent_provenance WHERE action_intent_id=p_intent;
  SELECT h.implementation INTO d FROM trustwork.agent_effect_handler h
    WHERE h.capability_id=i.capability_id AND h.provider=i.effect ->> 'provider' AND h.operation=i.effect ->> 'operation'
      AND h.module_version=trustwork.agent_modules_capability_binding(p.hub_id,i.capability_id) #>> '{source,moduleVersion}';
  IF d IS NULL OR NOT (d -> 'contextKinds') ? i.context_kind THEN
    -- Roll back admission and its quotas; never return an executable target without the exact declaration.
    RAISE EXCEPTION 'effect implementation unavailable' USING ERRCODE='42501',HINT='agents.effect_implementation_unavailable';
  END IF;
  INSERT INTO trustwork.agent_effect_attempt_binding(attempt_id,implementation) VALUES((v_result ->> 'attemptId')::uuid,d);
  RETURN v_result || jsonb_build_object('implementation',d);
END $$;
REVOKE ALL ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) TO trustwork_worker;

ALTER FUNCTION trustwork.assistant_begin_reconciliation(uuid) RENAME TO agent_modules_reconcile_original_attempt;
REVOKE ALL ON FUNCTION trustwork.agent_modules_reconcile_original_attempt(uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.assistant_begin_reconciliation(p_intent uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_result jsonb; d jsonb;
BEGIN
  v_result := trustwork.agent_modules_reconcile_original_attempt(p_intent);
  IF v_result ->> 'status'<>'reconcile' THEN RETURN v_result; END IF;
  SELECT implementation INTO d FROM trustwork.agent_effect_attempt_binding WHERE attempt_id=(v_result ->> 'attemptId')::uuid;
  -- A missing legacy pin remains unknown. Never reselect today's handler to prove an old operation absent.
  RETURN v_result || jsonb_build_object('implementation',d);
END $$;
REVOKE ALL ON FUNCTION trustwork.assistant_begin_reconciliation(uuid) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_begin_reconciliation(uuid) TO trustwork_worker;

-- AGT-003: proven mandate uses and exact hub-scoped, privacy-suppressed policy previews.
CREATE TABLE trustwork.agent_mandate_provenance (
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate(id),
  mandate_revision integer NOT NULL CHECK (mandate_revision > 0),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  mandate_digest text NOT NULL CHECK (mandate_digest ~ '^[a-f0-9]{64}$'),
  serving_binding_id uuid NOT NULL REFERENCES trustwork.agent_serving_hub(id),
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(mandate_id,mandate_revision,hub_id)
);
ALTER TABLE trustwork.agent_mandate_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_mandate_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_mandate_provenance TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY mandate_provenance_owner ON trustwork.agent_mandate_provenance FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.agent_mandate_provenance TO trustwork_app;
CREATE TRIGGER mandate_provenance_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_mandate_provenance
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE FUNCTION trustwork.agent_modules_bind_mandate(p_mandate uuid,p_binding uuid,p_session uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE m trustwork.mandate%ROWTYPE; b trustwork.agent_serving_hub%ROWTYPE;
BEGIN
  SELECT * INTO m FROM trustwork.mandate WHERE id = p_mandate;
  SELECT * INTO b FROM trustwork.agent_serving_hub WHERE id = p_binding AND active;
  IF m.id IS NULL OR b.id IS NULL OR m.principal_person_id IS DISTINCT FROM trustwork.current_person_id()
    OR NOT EXISTS (SELECT 1 FROM trustwork.mandate_revision r WHERE r.mandate_id = m.id AND r.revision = m.revision
      AND r.change_kind = 'confirm' AND r.changed_at >= transaction_timestamp() AND r.digest = m.digest)
    OR NOT EXISTS (SELECT 1 FROM trustwork.session WHERE id = p_session AND person_id = m.principal_person_id
      AND revoked_at IS NULL AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'fresh confirmation provenance unavailable' USING ERRCODE = '42501', HINT = 'agents.hub_provenance_unavailable';
  END IF;
  INSERT INTO trustwork.agent_mandate_provenance(mandate_id,mandate_revision,principal_person_id,hub_id,mandate_digest,serving_binding_id,session_id)
    VALUES(m.id,m.revision,m.principal_person_id,b.hub_id,m.digest,b.id,p_session);
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_bind_mandate(uuid,uuid,uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_bind_mandate(uuid,uuid,uuid) TO trustwork_app;

-- Internal minimal proof relation. The signed snapshot and digest are never modified.
CREATE FUNCTION trustwork.agent_modules_mandate_hubs() RETURNS TABLE(mandate_id uuid,mandate_revision integer,hub_id uuid,mandate_digest text)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT mandate_id,mandate_revision,hub_id,mandate_digest FROM trustwork.agent_mandate_provenance
  UNION SELECT mandate_id,mandate_revision,hub_id,mandate_digest FROM trustwork.agent_mandate_usage
  UNION SELECT mandate_id,mandate_revision,hub_id,mandate_digest FROM trustwork.agent_intent_provenance
$$;

CREATE FUNCTION trustwork.agent_modules_preview_basis(p_hub uuid,p_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  -- A missing proof is UNKNOWN, never a suppressed small cohort or a guessed node-wide count.
  IF EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.status = 'active' AND m.module_keys && p_keys
      AND NOT EXISTS (SELECT 1 FROM trustwork.agent_modules_mandate_hubs() p WHERE p.mandate_id = m.id
        AND p.mandate_revision = m.revision AND p.mandate_digest = m.digest))
    OR EXISTS (SELECT 1 FROM trustwork.job_subscription s WHERE s.status = 'active' AND s.module_key = ANY(p_keys)
      AND NOT EXISTS (SELECT 1 FROM trustwork.agent_job_request r JOIN trustwork.agent_mandate_usage p ON p.job_request_id = r.id WHERE r.job_subscription_id = s.id))
    OR EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.run_id IS NOT NULL AND i.module_key = ANY(p_keys)
      AND i.state IN ('proposed','authorized','reserved','queued','executing','pending','outcome_unknown','reconciling')
      AND NOT EXISTS (SELECT 1 FROM trustwork.agent_intent_provenance p WHERE p.action_intent_id = i.id))
    OR EXISTS (SELECT 1 FROM trustwork.connection c JOIN trustwork.connection_consent cc ON cc.id = c.consent_id
      WHERE c.status = 'active' AND c.hub_id IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(cc.mandate_bindings) b
        JOIN trustwork.mandate m ON m.id::text = b ->> 'mandateId' WHERE m.module_keys && p_keys)) THEN
    RAISE EXCEPTION 'exact hub attribution is unavailable' USING ERRCODE = '42501', HINT = 'agents.attribution_unavailable';
  END IF;
  WITH objects AS (
    SELECT DISTINCT 'mandates'::text AS kind,m.id,m.principal_person_id AS person,m.revision,
      m.digest AS basis FROM trustwork.mandate m JOIN trustwork.agent_modules_mandate_hubs() p
        ON p.mandate_id = m.id AND p.mandate_revision = m.revision AND p.mandate_digest = m.digest
      WHERE p.hub_id = p_hub AND m.status = 'active' AND m.module_keys && p_keys
    UNION ALL
    SELECT 'jobSubscriptions',s.id,s.principal_person_id,s.revision,u.mandate_digest FROM trustwork.job_subscription s
      JOIN trustwork.agent_job_request r ON r.job_subscription_id = s.id JOIN trustwork.agent_mandate_usage u ON u.job_request_id = r.id
      WHERE u.hub_id = p_hub AND s.status = 'active' AND s.module_key = ANY(p_keys)
    UNION ALL
    SELECT DISTINCT 'connections',c.id,c.person_id,c.revision,cc.id::text FROM trustwork.connection c
      JOIN trustwork.connection_consent cc ON cc.id = c.consent_id WHERE c.hub_id = p_hub AND c.status = 'active'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(cc.mandate_bindings) b JOIN trustwork.mandate m ON m.id::text = b ->> 'mandateId'
        WHERE m.status = 'active' AND m.module_keys && p_keys)
    UNION ALL
    SELECT DISTINCT 'openRuns',r.id,r.principal_person_id,r.revision,p.hub_id::text FROM trustwork.run r
      JOIN trustwork.agent_run_provenance p ON p.run_id = r.id WHERE p.hub_id = p_hub
      AND r.state NOT IN ('completed','failed','cancelled') AND (
        EXISTS (SELECT 1 FROM trustwork.action_intent i WHERE i.run_id = r.id AND i.module_key = ANY(p_keys))
        OR EXISTS (SELECT 1 FROM trustwork.agent_job_occurrence o JOIN trustwork.job_subscription s ON s.id = o.job_subscription_id
          WHERE o.run_id = r.id AND s.module_key = ANY(p_keys)))
  ), counts AS (
    SELECT kind,CASE WHEN count(DISTINCT person) >= 10 THEN count(*)::integer END AS n FROM objects GROUP BY kind
  ) SELECT jsonb_build_object('affected',jsonb_build_object(
      'mandates',(SELECT n FROM counts WHERE kind = 'mandates'),
      'jobSubscriptions',(SELECT n FROM counts WHERE kind = 'jobSubscriptions'),
      'connections',(SELECT n FROM counts WHERE kind = 'connections'),
      'openRuns',(SELECT n FROM counts WHERE kind = 'openRuns')),
    'attributionDigest',trustwork.admin_digest(jsonb_build_object('hubId',p_hub,
      'moduleKeys',(SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) FROM (SELECT DISTINCT unnest(p_keys) AS k) keys),
      'objects',(SELECT coalesce(jsonb_agg(jsonb_build_array(kind,id,person,revision,basis) ORDER BY kind,id),'[]'::jsonb) FROM objects))))
    INTO v_result;
  RETURN v_result;
END $$;

CREATE FUNCTION trustwork.agent_modules_preview_snapshot(p_hub uuid,p_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.agent_modules_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'staff of this hub only' USING ERRCODE = '42501', HINT = 'admin.forbidden';
  END IF;
  RETURN trustwork.agent_modules_preview_basis(p_hub,coalesce(p_keys,ARRAY[]::text[]));
END $$;
CREATE OR REPLACE FUNCTION trustwork.agent_modules_preview_counts(p_hub uuid,p_module_keys text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.agent_modules_preview_snapshot(p_hub,p_module_keys) -> 'affected'
$$;
CREATE OR REPLACE FUNCTION trustwork.agent_modules_affected(p_module_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'an explicit proven hub is required' USING ERRCODE = '42501', HINT = 'agents.attribution_unavailable';
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_mandate_hubs(),trustwork.agent_modules_preview_basis(uuid,text[]),
  trustwork.agent_modules_preview_snapshot(uuid,text[]) FROM PUBLIC,trustwork_worker,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_preview_snapshot(uuid,text[]) TO trustwork_app;

CREATE OR REPLACE FUNCTION trustwork.agent_modules_record_draft(p_ctx jsonb, p_hub uuid, p_config_version_id uuid, p_document jsonb)
RETURNS trustwork.agent_policy_version LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.agents.policy.edit', 'admin.config.edit'], NULL, p_hub);
  v_items text[];
  v_preview jsonb := p_document -> 'preview';
  v_narrowed text[];
  v_base uuid;
  v_row trustwork.agent_policy_version%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_document) <> 'object' OR jsonb_typeof(v_preview) <> 'object' OR (p_document -> 'policy' ->> 'hubId') IS DISTINCT FROM p_hub::text THEN
    RAISE EXCEPTION 'an agent policy document names its hub and carries its preview' USING ERRCODE = 'invalid_parameter_value', HINT = 'agents.policy_invalid';
  END IF;
  -- Every key the administrator sets (the preview is computed by the server and is not a setting).
  v_items := trustwork.agent_modules_guard_rail_keys(p_document - 'preview');
  IF cardinality(v_items) > 0 THEN
    RAISE EXCEPTION 'no hub setting disables mandates, confirmations, sanctions gates, restricted places or payment neutrality' USING ERRCODE = 'check_violation',
      HINT = 'agents.guard_rail', DETAIL = array_to_string(v_items, ',');
  END IF;
  IF NOT ((p_document -> 'policy' -> 'forbiddenPreAuthorization') ? 'release_payment') THEN
    RAISE EXCEPTION 'releasing a payment is never pre-authorized' USING ERRCODE = 'check_violation', HINT = 'agents.guard_rail', DETAIL = 'forbiddenPreAuthorization';
  END IF;
  v_narrowed := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_preview -> 'narrowedModuleKeys', '[]'::jsonb)));
  v_base := nullif(v_preview ->> 'baseVersionId', '')::uuid;
  IF v_base IS DISTINCT FROM trustwork.agent_modules_current_version(p_hub) OR (v_preview -> 'affected') IS DISTINCT FROM (trustwork.agent_modules_preview_basis(p_hub,v_narrowed) -> 'affected')
    OR (v_preview ->> 'attributionDigest') IS DISTINCT FROM (trustwork.agent_modules_preview_basis(p_hub,v_narrowed) ->> 'attributionDigest') THEN
    RAISE EXCEPTION 'the preview no longer matches the hub; compute it again' USING ERRCODE = 'check_violation', HINT = 'agents.preview_stale';
  END IF;
  INSERT INTO trustwork.agent_policy_version (config_version_id, hub_id, document, payload_digest, base_version_id, narrowed_module_keys, drafted_by)
  VALUES (p_config_version_id, p_hub, p_document, trustwork.admin_digest(p_document), v_base, v_narrowed, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'agents.policy_drafted', 'agent_policy_version', p_config_version_id, NULL,
    jsonb_build_object('configVersionId', p_config_version_id, 'payloadDigest', v_row.payload_digest, 'narrowedModuleKeys', to_jsonb(v_narrowed)));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION trustwork.agent_modules_on_policy_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_version trustwork.agent_policy_version%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM trustwork.agent_policy_version WHERE config_version_id = NEW.id;
  IF NOT FOUND OR v_version.hub_id <> NEW.hub_id OR v_version.payload_digest <> NEW.payload_digest OR v_version.drafted_by <> NEW.drafted_by THEN
    RAISE EXCEPTION 'an agent policy activates only as drafted and validated by the agent module registry' USING ERRCODE = 'check_violation', HINT = 'agents.policy_unvalidated';
  END IF;
  PERFORM 1 FROM trustwork.agent_policy_current WHERE hub_id = NEW.hub_id FOR UPDATE;
  IF v_version.base_version_id IS DISTINCT FROM trustwork.agent_modules_current_version(NEW.hub_id)
     OR (v_version.document -> 'preview' -> 'affected') IS DISTINCT FROM (trustwork.agent_modules_preview_basis(NEW.hub_id,v_version.narrowed_module_keys) -> 'affected')
    OR (v_version.document #>> '{preview,attributionDigest}') IS DISTINCT FROM (trustwork.agent_modules_preview_basis(NEW.hub_id,v_version.narrowed_module_keys) ->> 'attributionDigest') THEN
    RAISE EXCEPTION 'the preview the approver saw is stale; draft the policy again' USING ERRCODE = 'check_violation', HINT = 'agents.preview_stale';
  END IF;
  INSERT INTO trustwork.agent_policy_current AS c (hub_id, config_version_id, document) VALUES (NEW.hub_id, NEW.id, v_version.document)
  ON CONFLICT (hub_id) DO UPDATE SET config_version_id = EXCLUDED.config_version_id, document = EXCLUDED.document, activated_at = now();
  PERFORM trustwork.agent_modules_bump('hub', NEW.hub_id);
  RETURN NULL;
END $$;

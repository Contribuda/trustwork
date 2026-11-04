-- AGT-023: extension actions at runtime. There is no second path: an extension joins the bindings the agent runtime already
-- asks (capability, policy, effect, dispatch refusal), so mandates, approvals, budget reservations, authorization epochs
-- and kill switches apply to it through the same code as to a built-in action.
--
--   * an extension capability exists only while its version is `active` AND the hub's active agent policy lists that
--     version and enables its module key: activating an extension offers nothing on its own;
--   * its key is its own module key, and a key alone is not enough: at each first-party confirmation the mandate records the
--     authority of the version active in that hub, so a wider version, or the same key in another hub, needs a new one;
--   * the call gate of KEYS-001 decides egress for every call, after every other check, in the dispatch transaction;
--   * every call that reaches the gate leaves one row of digests. No payload, no output, no person.

-- 1. The audit of calls ------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.agent_extension_call (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  extension_id uuid NOT NULL REFERENCES trustwork.agent_extension (id),
  version_id uuid NOT NULL REFERENCES trustwork.agent_extension_version (id),
  capability_id text NOT NULL CHECK (length(capability_id) BETWEEN 3 AND 100),
  attempt_id uuid NOT NULL UNIQUE REFERENCES trustwork.action_attempt (id),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  output_digest text NULL CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'succeeded', 'failed', 'refused', 'unknown')),
  refusal text NULL CHECK (refusal IS NULL OR length(refusal) BETWEEN 1 AND 100),
  provider_decision_id uuid NULL,
  connection_id uuid NULL,
  model_id text NULL,
  connection_mode text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  CONSTRAINT agent_extension_call_finished CHECK ((outcome = 'started') = (finished_at IS NULL))
);
CREATE INDEX agent_extension_call_hub_idx ON trustwork.agent_extension_call (hub_id, started_at DESC);

-- A call ends once; only an unknown outcome is resolved later, by reconciliation.
CREATE FUNCTION trustwork.agent_extensions_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extension calls are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.extension_id <> OLD.extension_id OR NEW.version_id <> OLD.version_id OR NEW.capability_id <> OLD.capability_id
     OR NEW.attempt_id <> OLD.attempt_id OR NEW.input_digest <> OLD.input_digest OR NEW.started_at <> OLD.started_at
     OR NOT (OLD.outcome = 'started' OR (OLD.outcome = 'unknown' AND NEW.outcome IN ('succeeded', 'failed'))) THEN
    RAISE EXCEPTION 'an extension call ends once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_extension_call_guard BEFORE UPDATE OR DELETE ON trustwork.agent_extension_call FOR EACH ROW EXECUTE FUNCTION trustwork.agent_extensions_call_guard();

ALTER TABLE trustwork.agent_extension_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_call FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_extension_call_maintenance ON trustwork.agent_extension_call TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_extension_call_read ON trustwork.agent_extension_call FOR SELECT TO trustwork_app USING (trustwork.agent_extensions_staff_reader(hub_id));
GRANT SELECT ON trustwork.agent_extension_call TO trustwork_app;

-- 2. What a person confirmed -----------------------------------------------------------------------------------------------------
-- What a version may do: its manifest without the titles. A new wording keeps a mandate; a new endpoint, data class, action,
-- cost, adapter or route does not.
CREATE FUNCTION trustwork.agent_extensions_authority_digest(p_manifest jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest((p_manifest - 'title') || jsonb_build_object('actions',
    (SELECT jsonb_agg(a - 'title' ORDER BY ord) FROM jsonb_array_elements(p_manifest -> 'actions') WITH ORDINALITY x(a, ord))))
$$;

-- One row per extension a confirmation covers, in the hub it was confirmed in. Written only at the person's first-party
-- confirmation (`agent_mandate_provenance` records exactly those), never by a later revision or a system narrowing, so
-- nothing can move a mandate onto a wider version without the person.
CREATE TABLE trustwork.agent_extension_mandate_scope (
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate (id),
  mandate_revision integer NOT NULL CHECK (mandate_revision > 0),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  extension_id uuid NOT NULL REFERENCES trustwork.agent_extension (id),
  version_id uuid NOT NULL REFERENCES trustwork.agent_extension_version (id),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mandate_id, mandate_revision, hub_id, extension_id)
);
CREATE TRIGGER agent_extension_mandate_scope_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_extension_mandate_scope FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.agent_extension_mandate_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_mandate_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_extension_mandate_scope_maintenance ON trustwork.agent_extension_mandate_scope TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE FUNCTION trustwork.agent_extensions_on_mandate_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  INSERT INTO trustwork.agent_extension_mandate_scope (mandate_id, mandate_revision, hub_id, extension_id, version_id, authority_digest)
  SELECT NEW.mandate_id, NEW.mandate_revision, NEW.hub_id, v.extension_id, v.id, trustwork.agent_extensions_authority_digest(v.manifest)
  FROM trustwork.agent_extension_version v JOIN trustwork.mandate m ON m.id = NEW.mandate_id
  WHERE v.hub_id = NEW.hub_id AND v.status = 'active' AND v.manifest ->> 'key' = ANY (m.module_keys);
  RETURN NULL;
END $$;
CREATE TRIGGER agent_extension_mandate_binding AFTER INSERT ON trustwork.agent_mandate_provenance FOR EACH ROW EXECUTE FUNCTION trustwork.agent_extensions_on_mandate_provenance();

-- 3. What a capability id means in this hub ---------------------------------------------------------------------------------
-- The action of an extension version the hub both activated and enabled in its agent policy. NULL means it does not exist
-- here: no fallback, no default policy. Runs as the caller; an active manifest is readable by everyone in the hub.
CREATE FUNCTION trustwork.agent_extensions_action(p_hub uuid, p_capability text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('extensionId', v.extension_id, 'versionId', v.id, 'version', v.version, 'manifestDigest', v.manifest_digest, 'key', v.manifest ->> 'key', 'adapter', v.manifest -> 'adapter',
    'route', v.manifest -> 'route', 'endpoints', v.manifest -> 'endpoints', 'action', a)
  FROM trustwork.agent_extension_version v
  CROSS JOIN LATERAL jsonb_array_elements(v.manifest -> 'actions') a
  JOIN trustwork.agent_policy_current p ON p.hub_id = v.hub_id
  WHERE p_hub IS NOT NULL AND v.hub_id = p_hub AND v.status = 'active'
    AND v.manifest ->> 'key' = split_part(p_capability, '.', 1) AND a ->> 'operation' = split_part(p_capability, '.', 2)
    AND (p.document -> 'policy' -> 'activeExtensionVersionIds') ? v.id::text
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.document -> 'policy' -> 'enabledModules') e WHERE e ->> 'moduleKey' = v.manifest ->> 'key' AND e ->> 'moduleVersion' = v.version || '.0.0')
  LIMIT 1
$$;

-- extensionActionCapability of agent-extensions.ts, in the fields the database gates read.
CREATE FUNCTION trustwork.agent_extensions_capability(p_hub uuid, p_capability text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p_capability, 'kind', e #>> '{action,kind}', 'mandateAction', e #>> '{action,mandateKind}', 'confirmation', e #>> '{action,confirmation}', 'contextKinds', e #> '{action,contextKinds}',
    'privateDataClasses', e #> '{action,privateDataClasses}', 'source', jsonb_build_object('kind', 'extension', 'extensionId', e ->> 'extensionId', 'extensionVersion', (e ->> 'version')::integer))
  FROM (SELECT trustwork.agent_extensions_action(p_hub, p_capability) AS e) x WHERE e IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION trustwork.agent_modules_capability_binding(p_hub uuid,p_capability text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce((SELECT c FROM trustwork.agent_engine_manifest m CROSS JOIN LATERAL jsonb_array_elements(m.document -> 'capabilities') c
    LEFT JOIN trustwork.agent_policy_current p ON p.hub_id = p_hub
    WHERE c ->> 'id' = p_capability AND p_hub IS NOT NULL
      AND (p.hub_id IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.document -> 'policy' -> 'enabledModules') e
        WHERE e ->> 'moduleKey' = m.module_key AND e ->> 'moduleVersion' = m.module_version))
    ORDER BY m.module_version LIMIT 1), trustwork.agent_extensions_capability(p_hub, p_capability))
$$;

-- An extension has no engine default: without an active policy naming it, it is simply not enabled.
CREATE OR REPLACE FUNCTION trustwork.agent_modules_policy_refusal(p_hub uuid,p_capability_id text,p_kind text,p_company_verified boolean,p_plan text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE v_doc jsonb; v_module text := split_part(p_capability_id,'.',1); v_version text; v_manifest trustwork.agent_engine_manifest%ROWTYPE; v_control jsonb; v_switch jsonb; v_extension boolean;
BEGIN
  IF p_hub IS NULL THEN RETURN 'capability.unknown'; END IF;
  v_extension := NOT EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m WHERE m.module_key = v_module) AND trustwork.agent_extensions_action(p_hub,p_capability_id) IS NOT NULL;
  IF NOT v_extension AND NOT EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document -> 'capabilities') c
    WHERE m.module_key = v_module AND c ->> 'id' = p_capability_id) THEN RETURN 'capability.unknown'; END IF;
  SELECT document INTO v_doc FROM trustwork.agent_policy_current WHERE hub_id = p_hub;
  IF v_doc IS NOT NULL THEN
    SELECT e ->> 'moduleVersion' INTO v_version FROM jsonb_array_elements(v_doc -> 'policy' -> 'enabledModules') e WHERE e ->> 'moduleKey' = v_module;
    SELECT m INTO v_control FROM jsonb_array_elements(v_doc -> 'modules') m WHERE m ->> 'moduleKey' = v_module;
    IF v_version IS NULL OR v_control IS NULL THEN RETURN 'module.not_enabled'; END IF;
    IF NOT v_extension THEN
      SELECT * INTO v_manifest FROM trustwork.agent_engine_manifest WHERE module_key = v_module AND module_version = v_version;
    END IF;
  ELSE
    IF v_module IN ('negotiation','representative') THEN RETURN 'module.not_enabled'; END IF;
    -- Exactly one shipped default version. A later multi-version rollout must name its default explicitly.
    IF (SELECT count(*) FROM trustwork.agent_engine_manifest WHERE module_key = v_module) <> 1 THEN RETURN 'capability.unknown'; END IF;
    SELECT * INTO v_manifest FROM trustwork.agent_engine_manifest WHERE module_key = v_module;
    v_control := v_manifest.default_control;
  END IF;
  IF NOT v_extension AND (v_manifest.module_key IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest.document -> 'capabilities') c
    WHERE c ->> 'id' = p_capability_id)) THEN RETURN 'capability.unknown'; END IF;
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

-- An extension's effect is its adapter and operation, and never what a model chose to name.
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
      -- A network effect needs its owning activated egress/source/residency port; for an extension that is the call gate below.
      AND h.implementation ->> 'egress'='none')
  OR coalesce((SELECT e #>> '{adapter,adapterId}' = p_provider AND e #>> '{action,operation}' = p_operation
    FROM (SELECT trustwork.agent_extensions_action(p_hub,p_capability) AS e) x), false)
$$;

-- The declaration the dispatcher receives for an extension action. `egress` says the call gate decides.
CREATE FUNCTION trustwork.agent_extensions_implementation(p_hub uuid, p_capability text, p_provider text, p_operation text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', 'extension:' || (e ->> 'versionId') || ':' || p_operation, 'moduleKey', e ->> 'key', 'moduleVersion', (e ->> 'version') || '.0.0', 'capabilityId', p_capability, 'provider', p_provider,
    'operation', p_operation, 'mandateAction', e #>> '{action,mandateKind}', 'contextKinds', e #> '{action,contextKinds}', 'privateDataClasses', e #> '{action,privateDataClasses}', 'egress', 'extension_gate',
    'payloadContract', 'agent-extensions/ExtensionCallInputSchema@1',
    'extension', jsonb_build_object('versionId', e ->> 'versionId', 'manifestDigest', e ->> 'manifestDigest', 'adapter', e -> 'adapter', 'action', e -> 'action'))
  FROM (SELECT trustwork.agent_extensions_action(p_hub, p_capability) AS e) x
  WHERE e #>> '{adapter,adapterId}' = p_provider AND e #>> '{action,operation}' = p_operation
$$;

CREATE OR REPLACE FUNCTION trustwork.agent_modules_begin_implementation_attempt(p_intent uuid,p_job uuid,p_hub uuid,p_fence bigint) RETURNS jsonb
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
  IF d IS NULL THEN
    d := trustwork.agent_extensions_implementation(p.hub_id,i.capability_id,i.effect ->> 'provider',i.effect ->> 'operation');
  END IF;
  IF d IS NULL OR NOT (d -> 'contextKinds') ? i.context_kind THEN
    -- Roll back admission and its quotas; never return an executable target without the exact declaration.
    RAISE EXCEPTION 'effect implementation unavailable' USING ERRCODE='42501',HINT='agents.effect_implementation_unavailable';
  END IF;
  INSERT INTO trustwork.agent_effect_attempt_binding(attempt_id,implementation) VALUES((v_result ->> 'attemptId')::uuid,d);
  RETURN v_result || jsonb_build_object('implementation',d);
END $$;

-- Whether this mandate, at its current revision, was confirmed in this hub for the authority of the active version.
CREATE FUNCTION trustwork.agent_extensions_mandate_covers(p_mandate uuid, p_hub uuid, p_capability text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  m trustwork.mandate%ROWTYPE;
  e jsonb := trustwork.agent_extensions_action(p_hub, p_capability);
BEGIN
  SELECT * INTO m FROM trustwork.mandate WHERE id = p_mandate;
  -- Not an oracle over another person's mandates.
  IF m.id IS NULL OR e IS NULL OR (pg_has_role(session_user, 'trustwork_app', 'member') AND m.principal_person_id IS DISTINCT FROM trustwork.current_person_id()) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM trustwork.agent_extension_mandate_scope s JOIN trustwork.agent_extension_version v ON v.id = (e ->> 'versionId')::uuid
    WHERE s.mandate_id = m.id AND s.mandate_revision = m.revision AND s.hub_id = p_hub AND s.extension_id = (e ->> 'extensionId')::uuid
      AND s.authority_digest = trustwork.agent_extensions_authority_digest(v.manifest));
END $$;

-- The route check of activation, with the endpoints: a private class stays inside the hub's residency, wherever the model
-- connection runs. Names the first host outside it, or NULL.
CREATE FUNCTION trustwork.agent_extensions_endpoint_outside_residency(p_hub uuid, p_action jsonb, p_endpoints jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT e ->> 'host' FROM jsonb_array_elements(p_endpoints) e
  WHERE (p_action -> 'endpointHosts') ? (e ->> 'host')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_action -> 'dataClassesSent') c WHERE c <> 'public')
    AND NOT trustwork.providers_in_residency(p_hub, e ->> 'country', NULL)
  ORDER BY e ->> 'host' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION trustwork.agent_extensions_check_route(p_hub uuid, p_extension uuid, p_manifest jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_job text := p_manifest #>> '{route,job}';
  v_classes jsonb;
  v_decision jsonb;
  v_action jsonb;
  v_host text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.model_route r WHERE r.hub_id = p_hub AND r.job = v_job AND r.scope_kind = 'extension' AND r.extension_id = p_extension AND r.status = 'active') THEN
    RAISE EXCEPTION 'the extension has no active route of its own' USING ERRCODE = 'check_violation', HINT = 'agents.route_missing', DETAIL = v_job;
  END IF;
  SELECT coalesce(jsonb_agg(DISTINCT c), '["public"]'::jsonb) INTO v_classes
    FROM jsonb_array_elements(p_manifest -> 'actions') a CROSS JOIN LATERAL jsonb_array_elements_text(a -> 'dataClassesSent') c;
  v_decision := trustwork.providers_authorize_call(jsonb_build_object('hubId', p_hub, 'job', v_job, 'moduleKey', p_manifest ->> 'key', 'extensionId', p_extension, 'pipelineId', NULL, 'dataClasses', v_classes,
    'estimatedCost', jsonb_build_object('minorUnits', '0', 'currency', (SELECT currency FROM trustwork.hub_profile WHERE hub_id = p_hub)), 'requestRef', 'extension-activation'), true);
  IF NOT (v_decision ->> 'allowed')::boolean THEN
    RAISE EXCEPTION 'the route refuses a data class this extension sends' USING ERRCODE = 'check_violation', HINT = 'agents.egress_denied',
      DETAIL = concat_ws(':', v_decision ->> 'reason', v_decision ->> 'detail');
  END IF;
  FOR v_action IN SELECT value FROM jsonb_array_elements(p_manifest -> 'actions') LOOP
    v_host := trustwork.agent_extensions_endpoint_outside_residency(p_hub, v_action, p_manifest -> 'endpoints');
    IF v_host IS NOT NULL THEN
      RAISE EXCEPTION 'a private class stays inside the hub residency' USING ERRCODE = 'check_violation', HINT = 'agents.egress_denied', DETAIL = 'residency:' || v_host;
    END IF;
  END LOOP;
END $$;

-- 4. Kill switches ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.agent_modules_dispatch_refusal_internal(p_hub uuid, p_module_key text, p_capability_id text, p_action text, p_person uuid, p_connection uuid, p_representative_of uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r FROM (
    SELECT jsonb_build_object('kind', k.scope_kind, 'id', k.id::text) AS r, 1 AS rank, k.id::text AS tie FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND (
      k.scope_kind = 'node'
      OR ((p_hub IS NULL OR k.hub_id = p_hub) AND (
           k.scope_kind = 'hub_agent_dispatch'
        OR (k.scope_kind = 'agent_module' AND k.module_key = p_module_key)
        OR (k.scope_kind = 'agent_capability' AND k.capability_id = p_capability_id)
        OR (k.scope_kind = 'agent_action' AND k.action = p_action)
        OR (k.scope_kind = 'agent_extension' AND EXISTS (SELECT 1 FROM trustwork.agent_extension x WHERE x.id = k.extension_id AND x.key = p_module_key))
        OR (k.scope_kind = 'external_agent_api' AND p_connection IS NOT NULL)
        OR (k.scope_kind = 'outbound_messages' AND p_action IN ('communicate', 'send_quote', 'negotiate', 'introduce', 'schedule')))))
    UNION ALL
    SELECT jsonb_build_object('kind', 'person_stop', 'id', s.id::text), 2, s.id::text FROM trustwork.participant_stop s
    WHERE s.state = 'engaged' AND s.scope_kind = 'person_stop' AND s.person_id = p_person
    UNION ALL
    SELECT jsonb_build_object('kind', 'company_representative', 'id', cr.id::text), 3, cr.id::text FROM trustwork.company_representative cr
    WHERE p_representative_of IS NOT NULL AND cr.company_id = p_representative_of AND cr.status <> 'active'
    UNION ALL
    SELECT jsonb_build_object('kind', 'company_representative', 'id', NULL), 3, '' WHERE p_representative_of IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM trustwork.company_representative cr WHERE cr.company_id = p_representative_of)
    UNION ALL
    SELECT jsonb_build_object('kind', 'connection', 'id', c.id::text), 4, c.id::text FROM trustwork.connection c
    WHERE p_connection IS NOT NULL AND c.id = p_connection AND c.status <> 'active'
    UNION ALL
    SELECT jsonb_build_object('kind', 'connection', 'id', NULL), 4, '' WHERE p_connection IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.connection c WHERE c.id = p_connection)
  ) blocking ORDER BY rank, tie LIMIT 1
$$;

CREATE OR REPLACE FUNCTION trustwork.agent_modules_on_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_intents uuid[];
BEGIN
  IF NEW.scope_kind NOT IN ('node','hub_agent_dispatch','agent_module','agent_capability','agent_action','agent_extension','external_agent_api','outbound_messages') THEN RETURN NULL; END IF;
  IF NEW.scope_kind = 'node' THEN PERFORM trustwork.agent_modules_bump('node',NEW.node_id);
  ELSE PERFORM trustwork.agent_modules_bump('hub',NEW.hub_id); END IF;
  IF TG_OP = 'INSERT' AND NEW.state = 'engaged' THEN
    SELECT coalesce(array_agg(i.id),ARRAY[]::uuid[]) INTO v_intents FROM trustwork.action_intent i
      LEFT JOIN trustwork.agent_intent_provenance p ON p.action_intent_id = i.id
      WHERE i.state IN ('executing','pending') AND (NEW.scope_kind = 'node' OR p.hub_id = NEW.hub_id OR p.hub_id IS NULL)
      AND CASE NEW.scope_kind
        WHEN 'node' THEN true WHEN 'hub_agent_dispatch' THEN true
        WHEN 'agent_module' THEN i.module_key = NEW.module_key WHEN 'agent_capability' THEN i.capability_id = NEW.capability_id
        WHEN 'agent_action' THEN i.action = NEW.action
        WHEN 'agent_extension' THEN i.module_key = (SELECT x.key FROM trustwork.agent_extension x WHERE x.id = NEW.extension_id)
        WHEN 'external_agent_api' THEN EXISTS (SELECT 1 FROM trustwork.connection_call c WHERE c.action_intent_id = i.id)
        ELSE i.action IN ('communicate','send_quote','negotiate','introduce','schedule') END;
    PERFORM trustwork.agent_modules_fence(v_intents);
  END IF;
  RETURN NULL;
END $$;

-- 5. The call gate, for the worker --------------------------------------------------------------------------------------------
-- The first endpoint of a manifest that is restricted today, or NULL: a place can be restricted after activation.
CREATE FUNCTION trustwork.agent_extensions_restricted_endpoint(p_hub uuid, p_endpoints jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT e ->> 'host' FROM jsonb_array_elements(p_endpoints) e
  WHERE trustwork.hubs_place_restricted(p_hub, e ->> 'country') OR (e ->> 'region' IS NOT NULL AND trustwork.hubs_place_restricted(p_hub, e ->> 'region'))
    OR (trustwork.agent_extensions_host_country(e ->> 'host') IS NOT NULL AND trustwork.hubs_place_restricted(p_hub, trustwork.agent_extensions_host_country(e ->> 'host')))
  ORDER BY e ->> 'host' LIMIT 1
$$;

-- Lock order. Every writer of a kill switch, a route, an egress rule or a hub configuration takes the provider callback lock
-- first and an authorization epoch after it. The call gate takes the same lock, so an extension dispatch must take it BEFORE
-- agent_modules_enter_effect locks the epochs: the other order deadlocks with a kill switch engaged during a dispatch.
CREATE FUNCTION trustwork.agent_extensions_lock_gate() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.providers_callback_lock();
END $$;

-- Runs after agent_modules_enter_effect, in its transaction and under the dispatch lease. The version must be the one the
-- action pinned (the digest the person approved covers it). Every refusal leaves a row and no adapter is called.
CREATE FUNCTION trustwork.agent_extensions_begin_call(p_attempt uuid, p_job uuid, p_fence bigint, p_input_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.action_attempt%ROWTYPE;
  i trustwork.action_intent%ROWTYPE;
  p trustwork.agent_intent_provenance%ROWTYPE;
  v trustwork.agent_extension_version%ROWTYPE;
  e jsonb;
  v_refusal text;
  v_decision jsonb;
  v_classes jsonb;
  v_cost jsonb;
  v_candidate jsonb;
  v_row trustwork.agent_extension_call%ROWTYPE;
BEGIN
  SELECT * INTO a FROM trustwork.action_attempt WHERE id = p_attempt;
  PERFORM 1 FROM trustwork.job WHERE id = p_job AND kind = 'assistant.dispatch' AND state = 'leased' AND leased_until > clock_timestamp() AND fencing_token = p_fence
    AND payload ->> 'intentId' = a.action_intent_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch lease unavailable' USING ERRCODE = '55P03', HINT = 'assistant.fenced_out';
  END IF;
  SELECT * INTO i FROM trustwork.action_intent WHERE id = a.action_intent_id;
  SELECT * INTO p FROM trustwork.agent_intent_provenance WHERE action_intent_id = i.id;
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = (i.effect #>> '{extensionVersion,id}')::uuid AND hub_id = p.hub_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an extension action pins its version' USING ERRCODE = '42501', HINT = 'agents.effect_implementation_unavailable';
  END IF;
  e := trustwork.agent_extensions_action(p.hub_id, i.capability_id);
  IF e IS NULL THEN
    v_refusal := 'extension_inactive';
  ELSIF e ->> 'versionId' <> v.id::text OR e ->> 'manifestDigest' IS DISTINCT FROM i.effect #>> '{extensionVersion,manifestDigest}' THEN
    v_refusal := 'version_changed';
  ELSIF EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.scope_kind = 'agent_extension' AND k.extension_id = v.extension_id) THEN
    v_refusal := 'extension_killed';
  ELSIF NOT trustwork.agent_extensions_mandate_covers(i.mandate_id, p.hub_id, i.capability_id) THEN
    v_refusal := 'extension_not_confirmed';
  ELSIF trustwork.agent_extensions_restricted_endpoint(p.hub_id, e -> 'endpoints') IS NOT NULL THEN
    v_refusal := 'restricted_endpoint';
  ELSIF trustwork.agent_extensions_endpoint_outside_residency(p.hub_id, e -> 'action', e -> 'endpoints') IS NOT NULL THEN
    v_refusal := 'egress_denied:residency';
  -- The gate would fall through to a module or job route: a disabled route of this extension stops it instead.
  ELSIF NOT EXISTS (SELECT 1 FROM trustwork.model_route r WHERE r.hub_id = p.hub_id AND r.job = e #>> '{route,job}' AND r.scope_kind = 'extension' AND r.extension_id = v.extension_id AND r.status = 'active') THEN
    v_refusal := 'route_missing';
  ELSE
    v_classes := CASE WHEN jsonb_array_length(e #> '{action,dataClassesSent}') > 0 THEN e #> '{action,dataClassesSent}' ELSE '["public"]'::jsonb END;
    v_cost := CASE WHEN e #>> '{action,cost,kind}' = 'per_call' THEN e #> '{action,cost,amount}'
      ELSE jsonb_build_object('minorUnits', '0', 'currency', (SELECT currency FROM trustwork.hub_profile WHERE hub_id = p.hub_id)) END;
    v_decision := trustwork.providers_authorize_call(jsonb_build_object('hubId', p.hub_id, 'job', e #>> '{route,job}', 'moduleKey', e ->> 'key', 'extensionId', v.extension_id, 'pipelineId', NULL, 'dataClasses', v_classes,
      'estimatedCost', v_cost, 'requestRef', p_attempt), false);
    IF NOT (v_decision ->> 'allowed')::boolean THEN
      v_refusal := left(concat_ws(':', 'egress_denied', v_decision ->> 'reason', v_decision ->> 'detail'), 100);
    END IF;
  END IF;
  v_candidate := v_decision -> 'candidates' -> 0;
  INSERT INTO trustwork.agent_extension_call (hub_id, extension_id, version_id, capability_id, attempt_id, input_digest, outcome, refusal, provider_decision_id, connection_id, model_id, connection_mode, finished_at)
  VALUES (p.hub_id, v.extension_id, v.id, i.capability_id, p_attempt, p_input_digest, CASE WHEN v_refusal IS NULL THEN 'started' ELSE 'refused' END, v_refusal,
    CASE WHEN v_refusal IS NULL THEN (v_decision ->> 'decisionId')::uuid END, (v_candidate ->> 'connectionId')::uuid, v_candidate ->> 'modelId', v_candidate ->> 'mode', CASE WHEN v_refusal IS NOT NULL THEN now() END)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('callId', v_row.id, 'refusal', v_refusal, 'connectionMode', v_row.connection_mode);
END $$;

-- Ends a call with the digest of what came back. A refused output still ended a real call: the provider cost settles.
CREATE FUNCTION trustwork.agent_extensions_finish_call(p_call uuid, p_outcome text, p_output_digest text, p_refusal text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  c trustwork.agent_extension_call%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'refused', 'unknown') THEN
    RAISE EXCEPTION 'a call ends with an outcome' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  SELECT * INTO c FROM trustwork.agent_extension_call WHERE id = p_call FOR UPDATE;
  IF NOT FOUND OR c.outcome <> 'started' THEN
    RAISE EXCEPTION 'no open call' USING ERRCODE = 'check_violation', HINT = 'audit.append_only';
  END IF;
  UPDATE trustwork.agent_extension_call SET outcome = p_outcome, output_digest = p_output_digest, refusal = p_refusal, finished_at = now() WHERE id = p_call;
  IF c.provider_decision_id IS NOT NULL THEN
    IF p_outcome = 'refused' AND p_refusal IS DISTINCT FROM 'output_refused' THEN
      -- Nothing was sent: the reservation goes back.
      PERFORM trustwork.providers_release_call(c.provider_decision_id);
    ELSE
      PERFORM trustwork.providers_settle_call(c.provider_decision_id, c.connection_id, c.model_id, CASE p_outcome WHEN 'refused' THEN 'succeeded' ELSE p_outcome END, 0, NULL, NULL, NULL, NULL);
    END IF;
  END IF;
END $$;

-- Reconciliation of an unknown outcome. A crash may have rolled the call row back with its transaction, so this also writes
-- the row: no call that may have reached an adapter stays out of the audit.
CREATE FUNCTION trustwork.agent_extensions_record_reconciled(p_attempt uuid, p_outcome text, p_output_digest text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  a trustwork.action_attempt%ROWTYPE;
  i trustwork.action_intent%ROWTYPE;
  v trustwork.agent_extension_version%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'reconciliation ends a call' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.agent_extension_call c WHERE c.attempt_id = p_attempt) THEN
    UPDATE trustwork.agent_extension_call SET outcome = p_outcome, output_digest = p_output_digest, finished_at = now() WHERE attempt_id = p_attempt AND outcome = 'unknown';
    RETURN;
  END IF;
  SELECT * INTO a FROM trustwork.action_attempt WHERE id = p_attempt;
  SELECT * INTO i FROM trustwork.action_intent WHERE id = a.action_intent_id;
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = (i.effect #>> '{extensionVersion,id}')::uuid;
  INSERT INTO trustwork.agent_extension_call (hub_id, extension_id, version_id, capability_id, attempt_id, input_digest, output_digest, outcome, finished_at)
  VALUES (v.hub_id, v.extension_id, v.id, i.capability_id, p_attempt, trustwork.admin_digest(i.effect -> 'payload'), p_output_digest, p_outcome, now());
END $$;

-- 6. Grants ---------------------------------------------------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.agent_extensions_action(uuid, text), trustwork.agent_extensions_capability(uuid, text), trustwork.agent_extensions_mandate_covers(uuid, uuid, text) TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.agent_extensions_lock_gate(),
  trustwork.agent_extensions_begin_call(uuid, uuid, bigint, text),
  trustwork.agent_extensions_finish_call(uuid, text, text, text),
  trustwork.agent_extensions_record_reconciled(uuid, text, text)
TO trustwork_worker;

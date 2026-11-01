-- AGT-003: agent module registry, hub agent policy, job subscriptions and kill switches (docs/engine/agent-catalog.md,
-- docs/engine/hub-console/user-agents-admin.md, ADR 010 decisions 22, 23 and 25). Mirrors
-- packages/contracts/src/agent-modules.ts (policy document, capability switches, job templates, preview) and the additive
-- `agent_capability` scope of KillSwitchScopeSchema (packages/contracts/src/hub.ts, integrator agreement).
--
-- Rules carried by this file, for every role including owner-run commands:
--   * the hub agent policy is the `agents` configuration domain of HUB-001 (second-person activation there); a version
--     activates only when AGT-003 validated its document (agent_policy_version, same payload digest, same drafter) and the
--     preview stored in the payload is still what the data says (same base version, same cohort counts), otherwise the
--     activation fails with agents.preview_stale. The approver approves the payload digest, which covers the preview;
--   * kill switches work through authorization epochs: engaging or releasing any agent switch (node, hub, module,
--     capability, verb, external agents, outbound messages), a person's stop, a representative suspension or a
--     connection ending bumps the epoch of its scope in the same transaction. The dispatch recheck locks those epoch rows
--     (shared) before it locks the action, so an engagement and a dispatch serialize: either the dispatch sees the switch
--     and refuses, or the engagement finds the action executing and sends it to reconciliation (unknown outcome, the
--     dispatcher fenced out). Nothing is ever retried blindly; releasing reactivates nothing;
--   * turning a job on inserts only an inert mandate proposal (origin module_template) and a pending job request; the job
--     subscription exists only after the principal confirmed the proposal on the first-party form (AST-001), and only
--     subscriptions with an active mandate ever fire;
--   * staff manage policy for everyone and never read one participant's agent: job requests, schedules and firings are
--     readable by their principal only; staff functions return cohort counts (at least 10, otherwise NULL);
--   * no function here branches on a country code; calendars and defaults are data;
--   * no function outside the HUB-001 module reads its configuration tables (tests/hubs): the activation hook reads only
--     the row it is fired for.

-- 0. Vocabularies and helpers ------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.agent_modules_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.agents.read', 'admin.agents.policy.edit', 'admin.agents.modules.edit', 'admin.agents.modules.activate', 'admin.agents.kill', 'admin.config.edit']::text[]
$$;

-- Staff who may read the agent product policy of a hub (never a participant's own agent).
CREATE FUNCTION trustwork.agent_modules_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL
    AND (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), trustwork.agent_modules_reader_permissions(), NULL, p_hub) r) IS NOT NULL
$$;

-- GUARD_RAIL_KEY_PATTERN: object keys (any depth) that would touch a guard rail no administrator can switch off.
CREATE FUNCTION trustwork.agent_modules_guard_rail_keys(p_payload jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH RECURSIVE walk(v, k) AS (
    SELECT p_payload, NULL::text
    UNION ALL
    SELECT c.v, c.k FROM walk w CROSS JOIN LATERAL (
      SELECT e.value AS v, e.key AS k FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value, NULL::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
    ) c
  )
  SELECT coalesce(array_agg(DISTINCT w.k ORDER BY w.k), ARRAY[]::text[]) FROM walk w
  WHERE w.k ~* '(mandate|confirm|sanction|screen|restrict|neutral|ranking|impersonat|egress|staff)'
$$;

-- cohortCount: participant counts below 10 are never shown.
CREATE FUNCTION trustwork.agent_modules_cohort(p_n bigint) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_n >= 10 THEN p_n::integer ELSE NULL END
$$;

-- 1. The agent_capability kill switch (additive extension of the ADM-001 table) -------------------------------------------
ALTER TABLE trustwork.kill_switch ADD COLUMN capability_id text NULL CHECK (capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(capability_id) <= 100);
ALTER TABLE trustwork.kill_switch DROP CONSTRAINT kill_switch_scope_kind_check;
ALTER TABLE trustwork.kill_switch ADD CONSTRAINT kill_switch_scope_kind_check CHECK (scope_kind IN ('node', 'hub_agent_dispatch', 'agent_module', 'agent_capability', 'agent_action',
  'agent_extension', 'external_agent_api', 'provider_connection', 'model_job', 'pipeline', 'outbound_messages'));
ALTER TABLE trustwork.kill_switch DROP CONSTRAINT kill_switch_scope_shape;
ALTER TABLE trustwork.kill_switch ADD CONSTRAINT kill_switch_scope_shape CHECK ((scope_kind = 'agent_capability') = (capability_id IS NOT NULL) AND CASE scope_kind
    WHEN 'node' THEN node_id IS NOT NULL AND hub_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_module' THEN hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NOT NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_capability' THEN hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_action' THEN hub_id IS NOT NULL AND node_id IS NULL AND action IS NOT NULL AND module_key IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_extension' THEN hub_id IS NOT NULL AND node_id IS NULL AND extension_id IS NOT NULL AND module_key IS NULL AND action IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'model_job' THEN hub_id IS NOT NULL AND node_id IS NULL AND job IS NOT NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND pipeline_id IS NULL
    WHEN 'provider_connection' THEN connection_id IS NOT NULL AND (node_id IS NULL) <> (hub_id IS NULL) AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'pipeline' THEN pipeline_id IS NOT NULL AND hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL
    ELSE hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL END);
DROP INDEX trustwork.kill_switch_one_engaged;
CREATE UNIQUE INDEX kill_switch_one_engaged ON trustwork.kill_switch (scope_kind, coalesce(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(hub_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(module_key, ''), coalesce(action, ''), coalesce(extension_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(job, ''), coalesce(pipeline_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(capability_id, '')) WHERE state = 'engaged';

CREATE OR REPLACE FUNCTION trustwork.admin_kill_switch_permissions(p_scope_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_scope_kind IN ('hub_agent_dispatch', 'agent_module', 'agent_capability', 'agent_action', 'agent_extension', 'external_agent_api') THEN ARRAY['admin.agents.kill']
    WHEN p_scope_kind = 'pipeline' THEN ARRAY['admin.pipelines.pause', 'admin.providers.kill']
    ELSE ARRAY['admin.providers.kill'] END::text[]
$$;

CREATE OR REPLACE FUNCTION trustwork.admin_kill_switch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kill switches are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'engaged' OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a kill switch is born engaged' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.engaged_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.module_key, NEW.action, NEW.extension_id, NEW.connection_id, NEW.job, NEW.pipeline_id, NEW.capability_id, NEW.engaged_by, NEW.engaged_at, NEW.reason)
     IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.module_key, OLD.action, OLD.extension_id, OLD.connection_id, OLD.job, OLD.pipeline_id, OLD.capability_id, OLD.engaged_by, OLD.engaged_at, OLD.reason)
     OR (OLD.incident_id IS NOT NULL AND NEW.incident_id IS DISTINCT FROM OLD.incident_id) THEN
    RAISE EXCEPTION 'a kill switch keeps its target' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.state = 'released' THEN
    RAISE EXCEPTION 'a released switch is final; engage a new one' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.state = 'released' THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.release_approval_id;
    IF NOT FOUND OR v_approval.action <> 'kill_switch.release' OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id
       OR v_approval.requested_by IS DISTINCT FROM NEW.released_by OR v_approval.action_digest <> trustwork.admin_kill_switch_release_digest(NEW.id, NEW.incident_note) THEN
      RAISE EXCEPTION 'releasing needs the consumed second-person approval of exactly this release' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_mismatch';
    END IF;
    NEW.released_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trustwork.admin_engage_kill_switch(p_ctx jsonb, p_scope_kind text, p_node uuid, p_hub uuid, p_target jsonb, p_incident uuid DEFAULT NULL)
RETURNS trustwork.kill_switch
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_kill_switch_permissions(p_scope_kind), v_node, p_hub);
  v_row trustwork.kill_switch%ROWTYPE;
BEGIN
  INSERT INTO trustwork.kill_switch (scope_kind, node_id, hub_id, module_key, action, extension_id, connection_id, job, pipeline_id, capability_id, engaged_by, reason, incident_id)
  VALUES (p_scope_kind, v_node, p_hub, p_target ->> 'moduleKey', p_target ->> 'action', (p_target ->> 'extensionId')::uuid, (p_target ->> 'connectionId')::uuid,
    p_target ->> 'job', (p_target ->> 'pipelineId')::uuid, p_target ->> 'capabilityId', v_actor.person_id, p_ctx ->> 'reasonText', p_incident) RETURNING * INTO v_row;
  IF p_incident IS NOT NULL THEN
    UPDATE trustwork.incident SET linked_actions = linked_actions || jsonb_build_array(jsonb_build_object('kind', 'kill_switch', 'killSwitchId', v_row.id::text)) WHERE id = p_incident;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, p_hub, 'kill_switch.engage', 'kill_switch', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 2. Policy versions and the current policy --------------------------------------------------------------------------
-- The AGT-003 validation of an `agents` configuration version: the document (AgentPolicyDocument, preview included), its
-- digest as the database computes it, the base version the preview was computed against, and the drafter. Append-only.
CREATE TABLE trustwork.agent_policy_version (
  config_version_id uuid PRIMARY KEY,
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND jsonb_typeof(document -> 'preview') = 'object' AND octet_length(document::text) <= 65536),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  base_version_id uuid NULL,
  narrowed_module_keys text[] NOT NULL,
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_policy_version_hub_idx ON trustwork.agent_policy_version (hub_id, created_at DESC);
CREATE TRIGGER agent_policy_version_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_policy_version FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- The effective policy of each hub: written only by the activation hook. No row: the engine default applies.
CREATE TABLE trustwork.agent_policy_current (
  hub_id uuid PRIMARY KEY REFERENCES trustwork.hub (id),
  config_version_id uuid NOT NULL REFERENCES trustwork.agent_policy_version (config_version_id),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  activated_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER agent_policy_current_touch BEFORE UPDATE ON trustwork.agent_policy_current FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 3. Authorization epochs ---------------------------------------------------------------------------------------------
-- One counter per scope that a kill switch or stop control can hit. Bumped (row lock) by the engaging transaction and
-- locked (shared) by the dispatch recheck before it locks the action: the two serialize.
CREATE TABLE trustwork.agent_authz_epoch (
  scope_kind text NOT NULL CHECK (scope_kind IN ('node', 'hub', 'company', 'person', 'connection')),
  scope_id uuid NOT NULL,
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_kind, scope_id)
);

CREATE FUNCTION trustwork.agent_modules_bump(p_kind text, p_id uuid) RETURNS bigint
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.agent_authz_epoch AS e (scope_kind, scope_id, epoch) VALUES (p_kind, p_id, 2)
  ON CONFLICT (scope_kind, scope_id) DO UPDATE SET epoch = e.epoch + 1, changed_at = clock_timestamp()
  RETURNING epoch
$$;

-- Shared locks on every epoch a dispatch of this target depends on, in a fixed order (node, hub, company, person,
-- connection). A NULL hub depends on every hub of the node (fail-closed, like assistant_dispatch_blocked).
CREATE FUNCTION trustwork.agent_modules_lock_epochs(p_hub uuid, p_company uuid, p_person uuid, p_connection uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_sum bigint;
BEGIN
  INSERT INTO trustwork.agent_authz_epoch (scope_kind, scope_id)
  SELECT k, i FROM (
    SELECT 'node'::text AS k, n.id AS i FROM trustwork.admin_node n
    UNION ALL SELECT 'hub', h.id FROM trustwork.hub h WHERE p_hub IS NULL OR h.id = p_hub
    UNION ALL SELECT 'company', p_company WHERE p_company IS NOT NULL
    UNION ALL SELECT 'person', p_person WHERE p_person IS NOT NULL
    UNION ALL SELECT 'connection', p_connection WHERE p_connection IS NOT NULL
  ) s ON CONFLICT DO NOTHING;
  SELECT sum(epoch) INTO v_sum FROM (
    SELECT e.epoch FROM trustwork.agent_authz_epoch e
    WHERE (e.scope_kind = 'node') OR (e.scope_kind = 'hub' AND (p_hub IS NULL OR e.scope_id = p_hub))
       OR (e.scope_kind = 'company' AND e.scope_id = p_company) OR (e.scope_kind = 'person' AND e.scope_id = p_person) OR (e.scope_kind = 'connection' AND e.scope_id = p_connection)
    ORDER BY CASE e.scope_kind WHEN 'node' THEN 1 WHEN 'hub' THEN 2 WHEN 'company' THEN 3 WHEN 'person' THEN 4 ELSE 5 END, e.scope_id
    FOR SHARE
  ) locked;
  RETURN coalesce(v_sum, 0);
END $$;

-- 4. The shared authority checks ------------------------------------------------------------------------------------------
-- First engaged switch or stop that blocks this dispatch, or NULL: {"kind": <scope>, "id": <switch or stop id>}. A superset
-- of assistant_dispatch_blocked: also the capability switch, the company representative and the connection.
CREATE FUNCTION trustwork.agent_modules_dispatch_refusal(p_hub uuid, p_module_key text, p_capability_id text, p_action text, p_person uuid, p_connection uuid, p_representative_of uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r FROM (
    SELECT jsonb_build_object('kind', k.scope_kind, 'id', k.id::text) AS r, 1 AS rank, k.id::text AS tie FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND (
      k.scope_kind = 'node'
      OR ((p_hub IS NULL OR k.hub_id = p_hub) AND (
           k.scope_kind = 'hub_agent_dispatch'
        OR (k.scope_kind = 'agent_module' AND k.module_key = p_module_key)
        OR (k.scope_kind = 'agent_capability' AND k.capability_id = p_capability_id)
        OR (k.scope_kind = 'agent_action' AND k.action = p_action)
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

-- capabilityRefusal (agent-modules.ts) over the hub's active policy; NULL when allowed or when the hub has no active
-- policy (the engine default switches nothing off). A NULL plan skips the plan switches (the entitlement port lives in the
-- API; AGT-004 stores plans).
CREATE FUNCTION trustwork.agent_modules_policy_refusal(p_hub uuid, p_capability_id text, p_kind text, p_company_verified boolean, p_plan text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_doc jsonb;
  v_module text := split_part(p_capability_id, '.', 1);
  v_control jsonb;
  v_switch jsonb;
BEGIN
  IF p_hub IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT document INTO v_doc FROM trustwork.agent_policy_current WHERE hub_id = p_hub;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Modules without a manifest in the registry the version was drafted against are not governed yet (isRegisteredModule).
  IF NOT coalesce((v_doc -> 'preview' -> 'registeredModuleKeys') ? v_module, false) THEN
    RETURN NULL;
  END IF;
  SELECT m INTO v_control FROM jsonb_array_elements(v_doc -> 'modules') m WHERE m ->> 'moduleKey' = v_module;
  IF v_control IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_doc -> 'policy' -> 'enabledModules') e WHERE e ->> 'moduleKey' = v_module) THEN
    RETURN 'module.not_enabled';
  END IF;
  IF (v_control ->> 'status') NOT IN ('beta', 'active') THEN
    RETURN 'module.not_serving';
  END IF;
  IF NOT (v_control -> 'principalKinds') ? p_kind THEN
    RETURN 'module.not_eligible';
  END IF;
  IF (v_control ->> 'verifiedCompanyRequired')::boolean AND p_kind <> 'person' AND NOT coalesce(p_company_verified, false) THEN
    RETURN 'module.verified_company_required';
  END IF;
  IF NOT (v_control -> 'capabilityIds') ? p_capability_id THEN
    RETURN 'capability.off_for_hub';
  END IF;
  SELECT s INTO v_switch FROM jsonb_array_elements(v_doc -> 'capabilities') s WHERE s ->> 'capabilityId' = p_capability_id;
  IF v_switch IS NOT NULL THEN
    IF (v_switch ->> 'offForHub')::boolean THEN RETURN 'capability.off_for_hub'; END IF;
    IF (v_switch -> 'offForPrincipalKinds') ? p_kind THEN RETURN 'capability.off_for_principal_kind'; END IF;
    IF p_plan IS NOT NULL AND (v_switch -> 'offForPlans') ? p_plan THEN RETURN 'capability.off_for_plan'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- Participant type of a mandate's principal (AgentPrincipalKind): who the agent acts for.
CREATE FUNCTION trustwork.agent_modules_mandate_kind(p_grantee_kind text, p_company uuid) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_grantee_kind = 'company_representative' THEN 'company_representative' WHEN p_company IS NOT NULL THEN 'company_member' ELSE 'person' END
$$;

-- Executing and acknowledged actions in a switch's scope go to reconciliation: the attempt is fenced out (abandoned, the
-- dispatcher's outcome is refused) and the outcome is unknown until a provider lookup decides. Queued actions are refused
-- by the next dispatch recheck. Returns the number of actions sent to reconciliation.
CREATE FUNCTION trustwork.agent_modules_fence(p_intents uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_intent trustwork.action_intent%ROWTYPE;
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_intent IN SELECT * FROM trustwork.action_intent WHERE id = ANY (p_intents) AND state IN ('executing', 'pending') ORDER BY id FOR UPDATE LOOP
    SELECT * INTO v_attempt FROM trustwork.action_attempt WHERE action_intent_id = v_intent.id ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE;
    IF FOUND AND v_attempt.state = 'executing' THEN
      UPDATE trustwork.action_attempt SET state = 'abandoned', ended_at = clock_timestamp() WHERE id = v_attempt.id;
    END IF;
    PERFORM trustwork.assistant_apply_outcome(v_intent, v_attempt.id, 'unknown', NULL, 'lease_expired', NULL, NULL, NULL);
    UPDATE trustwork.action_intent SET state_reason = 'kill switch engaged; outcome unknown until reconciled' WHERE id = v_intent.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- 5. Epoch hooks: kill switches, stops, representatives, connections ------------------------------------------------------
CREATE FUNCTION trustwork.agent_modules_on_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_intents uuid[];
BEGIN
  IF NEW.scope_kind NOT IN ('node', 'hub_agent_dispatch', 'agent_module', 'agent_capability', 'agent_action', 'external_agent_api', 'outbound_messages') THEN
    RETURN NULL;
  END IF;
  IF NEW.scope_kind = 'node' THEN
    PERFORM trustwork.agent_modules_bump('node', NEW.node_id);
  ELSE
    PERFORM trustwork.agent_modules_bump('hub', NEW.hub_id);
  END IF;
  IF TG_OP = 'INSERT' AND NEW.state = 'engaged' THEN
    -- Actions carry no hub yet: a hub switch fences matching actions of the node (fail-closed).
    SELECT coalesce(array_agg(i.id), ARRAY[]::uuid[]) INTO v_intents FROM trustwork.action_intent i
    WHERE i.state IN ('executing', 'pending') AND CASE NEW.scope_kind
      WHEN 'node' THEN true
      WHEN 'hub_agent_dispatch' THEN true
      WHEN 'agent_module' THEN i.module_key = NEW.module_key
      WHEN 'agent_capability' THEN i.capability_id = NEW.capability_id
      WHEN 'agent_action' THEN i.action = NEW.action
      WHEN 'external_agent_api' THEN EXISTS (SELECT 1 FROM trustwork.connection_call c WHERE c.action_intent_id = i.id)
      ELSE i.action IN ('communicate', 'send_quote', 'negotiate', 'introduce', 'schedule') END;
    PERFORM trustwork.agent_modules_fence(v_intents);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER kill_switch_agent_epochs AFTER INSERT OR UPDATE OF state ON trustwork.kill_switch FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_on_kill_switch();

CREATE FUNCTION trustwork.agent_modules_on_participant_stop() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.agent_modules_bump('person', NEW.person_id);
  IF NEW.state = 'engaged' AND (TG_OP = 'INSERT' OR OLD.state <> 'engaged') THEN
    PERFORM trustwork.agent_modules_fence(ARRAY(SELECT i.id FROM trustwork.action_intent i WHERE i.principal_person_id = NEW.person_id AND i.state IN ('executing', 'pending')));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER participant_stop_agent_epochs AFTER INSERT OR UPDATE OF state ON trustwork.participant_stop FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_on_participant_stop();

CREATE FUNCTION trustwork.agent_modules_on_representative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM trustwork.agent_modules_bump('company', NEW.company_id);
    IF OLD.status = 'active' AND NEW.status <> 'active' THEN
      PERFORM trustwork.agent_modules_fence(ARRAY(SELECT i.id FROM trustwork.action_intent i JOIN trustwork.mandate m ON m.id = i.mandate_id
        WHERE m.grantee_kind = 'company_representative' AND m.grantee_company_id = NEW.company_id AND i.state IN ('executing', 'pending')));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER company_representative_agent_epochs AFTER UPDATE OF status ON trustwork.company_representative FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_on_representative();

CREATE FUNCTION trustwork.agent_modules_on_connection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM trustwork.agent_modules_bump('connection', NEW.id);
    IF OLD.status = 'active' AND NEW.status <> 'active' THEN
      PERFORM trustwork.agent_modules_fence(ARRAY(SELECT c.action_intent_id FROM trustwork.connection_call c WHERE c.connection_id = NEW.id AND c.action_intent_id IS NOT NULL));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER connection_agent_epochs AFTER UPDATE OF status ON trustwork.connection FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_on_connection();

-- 6. The dispatch recheck (AST-001 assistant_begin_attempt, extended) ---------------------------------------------------
-- Same contract and refusal reasons as AST-001, plus: the epochs of every scope are locked first (serializing with
-- engagements), the full dispatch refusal (capability switch, representative, connection) and the hub policy (module and
-- capability switched off for the hub or the participant type) are rechecked, the latter as `capability_off`.
CREATE OR REPLACE FUNCTION trustwork.assistant_begin_attempt(p_intent_id uuid, p_job_id uuid, p_hub_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_job trustwork.job%ROWTYPE;
  v_intent trustwork.action_intent%ROWTYPE;
  v_mandate trustwork.mandate%ROWTYPE;
  v_attempt trustwork.action_attempt%ROWTYPE;
  v_refusal text;
  v_person uuid;
  v_mandate_id uuid;
  v_representative uuid;
  v_connection uuid;
BEGIN
  SELECT * INTO v_job FROM trustwork.job WHERE id = p_job_id;
  IF NOT FOUND OR v_job.state <> 'leased' OR v_job.kind <> 'assistant.dispatch' OR (v_job.payload ->> 'intentId') IS DISTINCT FROM p_intent_id::text THEN
    RAISE EXCEPTION 'the dispatch job does not hold a lease for this intent' USING ERRCODE = 'lock_not_available', HINT = 'assistant.fenced_out';
  END IF;
  -- Epochs before the action (the engaging side bumps the epoch, then fences actions): principal, representative and
  -- connection never change for an intent, so they are read before any lock.
  SELECT i.principal_person_id, i.mandate_id INTO v_person, v_mandate_id FROM trustwork.action_intent i WHERE i.id = p_intent_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skip', 'state', 'missing');
  END IF;
  SELECT CASE WHEN m.grantee_kind = 'company_representative' THEN m.grantee_company_id END INTO v_representative FROM trustwork.mandate m WHERE m.id = v_mandate_id;
  SELECT c.connection_id INTO v_connection FROM trustwork.connection_call c WHERE c.action_intent_id = p_intent_id ORDER BY c.at LIMIT 1;
  PERFORM trustwork.agent_modules_lock_epochs(p_hub_id, v_representative, v_person, v_connection);
  SELECT * INTO v_intent FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
  IF v_intent.state <> 'queued' THEN
    RETURN jsonb_build_object('status', 'skip', 'state', v_intent.state);
  END IF;
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = v_intent.mandate_id FOR SHARE;
  IF v_mandate.status <> 'active' THEN
    v_refusal := 'mandate_not_active';
  ELSIF v_mandate.revision <> v_intent.mandate_revision THEN
    v_refusal := 'mandate_revised';
  ELSIF v_mandate.valid_until <= clock_timestamp() THEN
    v_refusal := 'mandate_expired';
  ELSIF v_mandate.on_behalf_company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.membership WHERE person_id = v_intent.principal_person_id AND company_id = v_mandate.on_behalf_company_id AND status = 'active') THEN
    v_refusal := 'authority_basis_lost';
  ELSIF trustwork.agent_modules_dispatch_refusal(p_hub_id, v_intent.module_key, v_intent.capability_id, v_intent.action, v_intent.principal_person_id, v_connection, v_representative) IS NOT NULL THEN
    v_refusal := 'kill_switch';
  ELSIF trustwork.agent_modules_policy_refusal(p_hub_id, v_intent.capability_id, trustwork.agent_modules_mandate_kind(v_mandate.grantee_kind, v_mandate.on_behalf_company_id),
      EXISTS (SELECT 1 FROM trustwork.company co WHERE co.id = v_mandate.on_behalf_company_id AND co.claim_status = 'verified'), NULL) IS NOT NULL THEN
    v_refusal := 'capability_off';
  ELSIF cardinality(v_intent.ask_reasons) > 0 AND NOT EXISTS (
      SELECT 1 FROM trustwork.approval WHERE action_intent_id = v_intent.id AND action_digest = v_intent.action_digest AND mandate_revision = v_intent.mandate_revision AND revoked_at IS NULL) THEN
    v_refusal := 'approval_missing';
  ELSIF v_intent.reservation_id IS NOT NULL AND NOT trustwork.billing_reservation_open(v_intent.reservation_id) THEN
    v_refusal := 'reservation_closed';
  END IF;
  IF v_refusal IS NOT NULL THEN
    PERFORM trustwork.assistant_finish_intent(v_intent.id, 'revoked', 'recheck: ' || v_refusal, 'recheck:' || v_refusal);
    RETURN jsonb_build_object('status', 'refused', 'reason', v_refusal);
  END IF;
  INSERT INTO trustwork.action_attempt (action_intent_id, attempt_no, operation_id, provider, job_id, fencing_token)
  VALUES (v_intent.id, v_intent.attempt_count + 1, trustwork.new_uuid(), v_intent.effect ->> 'provider', v_job.id, v_job.fencing_token)
  RETURNING * INTO v_attempt;
  UPDATE trustwork.action_intent SET state = 'executing', attempt_count = attempt_count + 1 WHERE id = v_intent.id;
  RETURN jsonb_build_object('status', 'dispatch', 'attemptId', v_attempt.id, 'attemptNo', v_attempt.attempt_no, 'operationId', v_attempt.operation_id,
    'correlationKey', v_intent.effect_correlation_key, 'provider', v_intent.effect ->> 'provider', 'operation', v_intent.effect ->> 'operation', 'payload', v_intent.effect -> 'payload',
    'amount', CASE WHEN v_intent.amount_minor IS NULL THEN NULL ELSE jsonb_build_object('minorUnits', v_intent.amount_minor::text, 'currency', v_intent.currency) END);
END $$;

-- 7. Drafting, previews and activation ------------------------------------------------------------------------------------
-- Cohort counts of what a policy change would stop: active mandates, job subscriptions, connections of their principals
-- and open runs in the narrowed modules. Never a list, never a count below 10.
CREATE FUNCTION trustwork.agent_modules_affected(p_module_keys text[]) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'mandates', trustwork.agent_modules_cohort((SELECT count(*) FROM trustwork.mandate m WHERE m.status = 'active' AND m.module_keys && p_module_keys)),
    'jobSubscriptions', trustwork.agent_modules_cohort((SELECT count(*) FROM trustwork.job_subscription j WHERE j.status = 'active' AND j.module_key = ANY (p_module_keys))),
    'connections', trustwork.agent_modules_cohort((SELECT count(DISTINCT c.id) FROM trustwork.connection c
      WHERE c.status = 'active' AND EXISTS (SELECT 1 FROM trustwork.mandate m WHERE m.principal_person_id = c.person_id AND m.status = 'active' AND m.module_keys && p_module_keys))),
    'openRuns', trustwork.agent_modules_cohort((SELECT count(DISTINCT i.run_id) FROM trustwork.action_intent i
      WHERE i.run_id IS NOT NULL AND i.module_key = ANY (p_module_keys) AND i.state IN ('proposed', 'authorized', 'reserved', 'queued', 'executing', 'pending', 'outcome_unknown', 'reconciling'))))
$$;

-- For the console preview: staff readers of the hub only.
CREATE FUNCTION trustwork.agent_modules_preview_counts(p_hub uuid, p_module_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.agent_modules_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'staff of this hub only' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  RETURN trustwork.agent_modules_affected(coalesce(p_module_keys, ARRAY[]::text[]));
END $$;

-- The version the hub's current policy came from, or NULL (engine default). Public product policy, no person in it.
CREATE FUNCTION trustwork.agent_modules_current_version(p_hub uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT config_version_id FROM trustwork.agent_policy_current WHERE hub_id = p_hub
$$;

-- Records AGT-003's validation of a drafted `agents` version (called right after the HUB-001 draft, same transaction).
-- The caller drafts with the domain permission; the database repeats the guard rails, recomputes the counts of the
-- preview and checks the base version, so the stored preview is what the data said when it was drafted.
CREATE FUNCTION trustwork.agent_modules_record_draft(p_ctx jsonb, p_hub uuid, p_config_version_id uuid, p_document jsonb)
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
  IF v_base IS DISTINCT FROM trustwork.agent_modules_current_version(p_hub) OR (v_preview -> 'affected') IS DISTINCT FROM trustwork.agent_modules_affected(v_narrowed) THEN
    RAISE EXCEPTION 'the preview no longer matches the hub; compute it again' USING ERRCODE = 'check_violation', HINT = 'agents.preview_stale';
  END IF;
  INSERT INTO trustwork.agent_policy_version (config_version_id, hub_id, document, payload_digest, base_version_id, narrowed_module_keys, drafted_by)
  VALUES (p_config_version_id, p_hub, p_document, trustwork.admin_digest(p_document), v_base, v_narrowed, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'agents.policy_drafted', 'agent_policy_version', p_config_version_id, NULL,
    jsonb_build_object('configVersionId', p_config_version_id, 'payloadDigest', v_row.payload_digest, 'narrowedModuleKeys', to_jsonb(v_narrowed)));
  RETURN v_row;
END $$;

-- Activation hook of the `agents` configuration domain (fired by HUB-001's activation, after its second-person checks):
-- the version must be one AGT-003 validated (same digest, same drafter), its preview must still hold (same base version,
-- same cohort counts), and then it becomes the hub's current policy and bumps the hub epoch. Reads only the fired row.
CREATE FUNCTION trustwork.agent_modules_on_policy_activation() RETURNS trigger
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
     OR (v_version.document -> 'preview' -> 'affected') IS DISTINCT FROM trustwork.agent_modules_affected(v_version.narrowed_module_keys) THEN
    RAISE EXCEPTION 'the preview the approver saw is stale; draft the policy again' USING ERRCODE = 'check_violation', HINT = 'agents.preview_stale';
  END IF;
  INSERT INTO trustwork.agent_policy_current AS c (hub_id, config_version_id, document) VALUES (NEW.hub_id, NEW.id, v_version.document)
  ON CONFLICT (hub_id) DO UPDATE SET config_version_id = EXCLUDED.config_version_id, document = EXCLUDED.document, activated_at = now();
  PERFORM trustwork.agent_modules_bump('hub', NEW.hub_id);
  RETURN NULL;
END $$;
CREATE TRIGGER agent_policy_activation AFTER UPDATE OF status ON trustwork.hub_config_version FOR EACH ROW
  WHEN (NEW.domain = 'agents' AND OLD.status = 'draft' AND NEW.status = 'active') EXECUTE FUNCTION trustwork.agent_modules_on_policy_activation();

-- 8. Turning jobs on: requests, schedules and firings -------------------------------------------------------------------
-- A job request is the inert side of "turn this job on": the mandate proposal (origin module_template) the principal
-- confirms on the first-party form, and the template, trigger and first due time. pending -> active | withdrawn | lapsed,
-- moved only by the proposal hook.
CREATE TABLE trustwork.agent_job_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  trigger jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object' AND trigger ->> 'kind' IN ('schedule', 'event', 'deadline', 'goal', 'request')),
  goal_id uuid NULL REFERENCES trustwork.goal (id),
  on_closed_day text NOT NULL CHECK (on_closed_day IN ('skip', 'next_open_day', 'run')),
  proposal_id uuid NOT NULL UNIQUE REFERENCES trustwork.mandate_proposal (id),
  first_due_at timestamptz NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'withdrawn', 'lapsed')),
  reason text NULL CHECK (reason IS NULL OR reason IN ('proposal_declined', 'proposal_expired', 'proposal_superseded', 'template_withdrawn', 'module_not_enabled')),
  job_subscription_id uuid NULL UNIQUE REFERENCES trustwork.job_subscription (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_job_request_goal CHECK ((trigger ->> 'kind' = 'goal') = (goal_id IS NOT NULL) AND (goal_id IS NULL OR trigger ->> 'goalId' = goal_id::text)),
  CONSTRAINT agent_job_request_shape CHECK ((status = 'active') = (job_subscription_id IS NOT NULL) AND (status = 'pending') = (decided_at IS NULL)
    AND (status IN ('pending', 'active')) = (reason IS NULL))
);
CREATE INDEX agent_job_request_principal_idx ON trustwork.agent_job_request (principal_person_id, status);
CREATE FUNCTION trustwork.agent_modules_job_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job requests are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.job_subscription_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a job request is born pending' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
    END IF;
    -- The proposal is the principal's own, pending, inert and for exactly this module template.
    IF NOT EXISTS (SELECT 1 FROM trustwork.mandate_proposal p WHERE p.id = NEW.proposal_id AND p.principal_person_id = NEW.principal_person_id AND p.status = 'pending'
        AND p.origin_kind = 'module_template' AND p.origin ->> 'moduleKey' = NEW.module_key AND p.origin ->> 'templateKey' = NEW.template_key AND p.mandate_id IS NULL) THEN
      RAISE EXCEPTION 'a job request names its own pending module-template proposal' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.principal_person_id, NEW.on_behalf_company_id, NEW.hub_id, NEW.module_key, NEW.template_key, NEW.trigger, NEW.goal_id, NEW.on_closed_day, NEW.proposal_id, NEW.first_due_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.principal_person_id, OLD.on_behalf_company_id, OLD.hub_id, OLD.module_key, OLD.template_key, OLD.trigger, OLD.goal_id, OLD.on_closed_day, OLD.proposal_id, OLD.first_due_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a job request keeps its terms' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.immutable';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status <> 'pending' OR NOT trustwork.in_maintenance()) THEN
    RAISE EXCEPTION 'a job request is decided once, by its proposal' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_job_request_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agent_job_request FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_job_request_guard();
CREATE TRIGGER agent_job_request_touch BEFORE UPDATE ON trustwork.agent_job_request FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- When a time-based subscription is next due (schedule and deadline triggers); event, goal and request triggers fire on
-- their cause. Written by the proposal hook and the worker.
CREATE TABLE trustwork.agent_job_schedule (
  job_subscription_id uuid PRIMARY KEY REFERENCES trustwork.job_subscription (id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  job_request_id uuid NOT NULL UNIQUE REFERENCES trustwork.agent_job_request (id),
  next_due_at timestamptz NULL,
  last_fired_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_job_schedule_due_idx ON trustwork.agent_job_schedule (next_due_at) WHERE next_due_at IS NOT NULL;
CREATE TRIGGER agent_job_schedule_touch BEFORE UPDATE ON trustwork.agent_job_schedule FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- One row per firing (idempotent per subscription and due time); `due` emits agents.job_due for the runtime.
CREATE TABLE trustwork.agent_job_fire (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  job_subscription_id uuid NOT NULL REFERENCES trustwork.job_subscription (id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  cause text NOT NULL CHECK (cause IN ('schedule', 'deadline', 'event', 'goal', 'request')),
  due_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('due', 'blocked', 'mandate_inactive', 'subscription_inactive', 'template_withdrawn')),
  fired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_subscription_id, due_at)
);
CREATE INDEX agent_job_fire_principal_idx ON trustwork.agent_job_fire (principal_person_id, fired_at DESC);
CREATE TRIGGER agent_job_fire_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_job_fire FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Whether the hub's policy offers this job template (the engine default offers none: templates are hub configuration).
CREATE FUNCTION trustwork.agent_modules_template_offered(p_hub uuid, p_module text, p_template text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.agent_policy_current c, jsonb_array_elements(c.document -> 'jobTemplates') t, jsonb_array_elements(c.document -> 'modules') m
    WHERE c.hub_id = p_hub AND t ->> 'moduleKey' = p_module AND t ->> 'templateKey' = p_template
      AND m ->> 'moduleKey' = p_module AND m ->> 'status' IN ('beta', 'active'))
$$;

-- Proposal hook: confirming the module-template proposal on the first-party form creates the job subscription with the
-- confirmed mandate; declining, expiry or supersession withdraws the request. Nothing exists to fire before that.
CREATE FUNCTION trustwork.agent_modules_on_proposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_request trustwork.agent_job_request%ROWTYPE;
  v_subscription uuid;
BEGIN
  SELECT * INTO v_request FROM trustwork.agent_job_request WHERE proposal_id = NEW.id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'confirmed' THEN
    IF NOT trustwork.agent_modules_template_offered(v_request.hub_id, v_request.module_key, v_request.template_key) THEN
      UPDATE trustwork.agent_job_request SET status = 'lapsed', reason = 'template_withdrawn', decided_at = now() WHERE id = v_request.id;
      RETURN NULL;
    END IF;
    INSERT INTO trustwork.job_subscription (principal_person_id, on_behalf_company_id, module_key, job_template_key, trigger, goal_id, mandate_id)
    VALUES (v_request.principal_person_id, v_request.on_behalf_company_id, v_request.module_key, v_request.template_key, v_request.trigger, v_request.goal_id, (NEW.proposed ->> 'id')::uuid)
    RETURNING id INTO v_subscription;
    UPDATE trustwork.agent_job_request SET status = 'active', job_subscription_id = v_subscription, decided_at = now() WHERE id = v_request.id;
    INSERT INTO trustwork.agent_job_schedule (job_subscription_id, principal_person_id, hub_id, job_request_id, next_due_at)
    VALUES (v_subscription, v_request.principal_person_id, v_request.hub_id, v_request.id, v_request.first_due_at);
  ELSE
    UPDATE trustwork.agent_job_request SET status = 'withdrawn', decided_at = now(),
      reason = CASE NEW.status WHEN 'declined' THEN 'proposal_declined' WHEN 'expired' THEN 'proposal_expired' ELSE 'proposal_superseded' END
    WHERE id = v_request.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER mandate_proposal_agent_jobs AFTER UPDATE OF status ON trustwork.mandate_proposal FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status <> 'pending' AND NEW.origin_kind = 'module_template') EXECUTE FUNCTION trustwork.agent_modules_on_proposal();

-- Records one firing of a subscription and moves its schedule. Rechecks everything at fire time: the subscription is
-- active, its mandate active and unexpired, the template still offered, no switch or stop blocks it. Idempotent per
-- (subscription, due time). Only `due` emits agents.job_due (the runtime starts a run under the mandate from there).
CREATE FUNCTION trustwork.agent_modules_fire(p_subscription uuid, p_cause text, p_due_at timestamptz, p_next_due_at timestamptz, p_hub uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_sub trustwork.job_subscription%ROWTYPE;
  v_mandate trustwork.mandate%ROWTYPE;
  v_schedule trustwork.agent_job_schedule%ROWTYPE;
  v_outcome text;
  v_existing text;
BEGIN
  IF p_cause NOT IN ('schedule', 'deadline', 'event', 'goal', 'request') OR p_due_at IS NULL OR (p_next_due_at IS NOT NULL AND p_next_due_at <= p_due_at) THEN
    RAISE EXCEPTION 'invalid firing' USING ERRCODE = 'invalid_parameter_value', HINT = 'agents.invalid_firing';
  END IF;
  SELECT * INTO v_schedule FROM trustwork.agent_job_schedule WHERE job_subscription_id = p_subscription FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown job' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  SELECT outcome INTO v_existing FROM trustwork.agent_job_fire WHERE job_subscription_id = p_subscription AND due_at = p_due_at;
  IF FOUND THEN
    RETURN v_existing;
  END IF;
  SELECT * INTO v_sub FROM trustwork.job_subscription WHERE id = p_subscription;
  SELECT * INTO v_mandate FROM trustwork.mandate WHERE id = v_sub.mandate_id;
  IF v_sub.status <> 'active' THEN
    v_outcome := 'subscription_inactive';
  ELSIF v_sub.mandate_id IS NULL OR v_mandate.status <> 'active' OR v_mandate.valid_until <= clock_timestamp() THEN
    v_outcome := 'mandate_inactive';
  ELSIF NOT trustwork.agent_modules_template_offered(coalesce(p_hub, v_schedule.hub_id), v_sub.module_key, v_sub.job_template_key) THEN
    v_outcome := 'template_withdrawn';
  ELSIF trustwork.agent_modules_dispatch_refusal(coalesce(p_hub, v_schedule.hub_id), v_sub.module_key, NULL, NULL, v_sub.principal_person_id, NULL,
      CASE WHEN v_mandate.grantee_kind = 'company_representative' THEN v_mandate.grantee_company_id END) IS NOT NULL THEN
    v_outcome := 'blocked';
  ELSE
    v_outcome := 'due';
  END IF;
  INSERT INTO trustwork.agent_job_fire (job_subscription_id, principal_person_id, cause, due_at, outcome) VALUES (p_subscription, v_sub.principal_person_id, p_cause, p_due_at, v_outcome);
  IF p_cause IN ('schedule', 'deadline') THEN
    UPDATE trustwork.agent_job_schedule SET next_due_at = CASE WHEN v_outcome IN ('subscription_inactive', 'mandate_inactive') AND v_sub.status = 'ended' THEN NULL ELSE p_next_due_at END,
      last_fired_at = clock_timestamp() WHERE job_subscription_id = p_subscription;
  END IF;
  IF v_outcome = 'due' THEN
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('job_subscription', p_subscription::text, v_sub.revision, 'agents.job_due', jsonb_build_object('jobSubscriptionId', p_subscription, 'mandateId', v_sub.mandate_id, 'cause', p_cause,
      'dueAt', to_char(p_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END IF;
  RETURN v_outcome;
END $$;

-- Worker: time-based subscriptions due now, oldest first, locked for this claim. The worker computes the next occurrence
-- in the principal's time zone and the hub calendar (nextScheduleOccurrence) and records each with agent_modules_record_fire.
CREATE FUNCTION trustwork.agent_modules_due_jobs(p_limit integer)
RETURNS TABLE (job_subscription_id uuid, hub_id uuid, due_at timestamptz, trigger jsonb, on_closed_day text, anchor timestamptz, calendar jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.job_subscription_id, s.hub_id, s.next_due_at, r.trigger, r.on_closed_day, r.created_at,
    coalesce((SELECT c.document -> 'calendar' FROM trustwork.agent_policy_current c WHERE c.hub_id = s.hub_id), jsonb_build_object('timeZone', 'UTC', 'closedDates', '[]'::jsonb))
  FROM trustwork.agent_job_schedule s JOIN trustwork.agent_job_request r ON r.id = s.job_request_id
  WHERE s.next_due_at IS NOT NULL AND s.next_due_at <= clock_timestamp()
  ORDER BY s.next_due_at LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  FOR UPDATE OF s SKIP LOCKED
$$;
CREATE FUNCTION trustwork.agent_modules_record_fire(p_subscription uuid, p_cause text, p_due_at timestamptz, p_next_due_at timestamptz, p_hub uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.agent_modules_fire(p_subscription, p_cause, p_due_at, p_next_due_at, p_hub)
$$;

-- The principal asks their agent to run a request-triggered (or any) job now: same rechecks as a scheduled firing.
CREATE FUNCTION trustwork.agent_modules_request_run(p_subscription uuid, p_hub uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.job_subscription WHERE id = p_subscription AND principal_person_id = trustwork.current_person_id()) THEN
    RAISE EXCEPTION 'unknown job' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  RETURN trustwork.agent_modules_fire(p_subscription, 'request', date_trunc('milliseconds', clock_timestamp()), NULL, p_hub);
END $$;

-- 9. Row-level security and grants -------------------------------------------------------------------------------------
ALTER TABLE trustwork.agent_policy_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_policy_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_policy_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_policy_current FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_authz_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_authz_epoch FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_request FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_schedule FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_fire ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_fire FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.agent_policy_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_policy_current AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_authz_epoch AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_job_request AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_job_schedule AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_job_fire AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Policy versions: staff readers of the hub. The current policy is the hub's agent product (modules, templates, defaults):
-- every signed-in session reads it; it names no participant.
CREATE POLICY agent_policy_version_read ON trustwork.agent_policy_version FOR SELECT TO trustwork_app USING (trustwork.agent_modules_staff_reader(hub_id));
CREATE POLICY agent_policy_current_read ON trustwork.agent_policy_current FOR SELECT TO trustwork_app USING (trustwork.current_person_id() IS NOT NULL);
-- A participant's job requests, schedules and firings: the principal only. No staff policy exists.
CREATE POLICY agent_job_request_read ON trustwork.agent_job_request FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY agent_job_request_insert ON trustwork.agent_job_request FOR INSERT TO trustwork_app
  WITH CHECK (principal_person_id = trustwork.current_person_id() AND (on_behalf_company_id IS NULL OR on_behalf_company_id = trustwork.current_company_id()));
CREATE POLICY agent_job_schedule_read ON trustwork.agent_job_schedule FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY agent_job_fire_read ON trustwork.agent_job_fire FOR SELECT TO trustwork_app USING (principal_person_id = trustwork.current_person_id());

GRANT SELECT ON trustwork.agent_policy_version, trustwork.agent_policy_current, trustwork.agent_job_request, trustwork.agent_job_schedule, trustwork.agent_job_fire TO trustwork_app;
GRANT INSERT ON trustwork.agent_job_request TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_staff_reader(uuid), trustwork.agent_modules_dispatch_refusal(uuid, text, text, text, uuid, uuid, uuid),
  trustwork.agent_modules_preview_counts(uuid, text[]), trustwork.agent_modules_record_draft(jsonb, uuid, uuid, jsonb), trustwork.agent_modules_request_run(uuid, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_due_jobs(integer), trustwork.agent_modules_record_fire(uuid, text, timestamptz, timestamptz, uuid) TO trustwork_worker;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

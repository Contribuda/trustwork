-- AGT-023: the governed extension registry (ADR 010 decisions 22 and 25). Contract: packages/contracts/src/agent-extensions.ts.
--
-- A hub administrator adds functions, tools and integrations to the participant's one agent. This migration is the
-- authority for the rules the contract explains:
--   * a manifest is a closed vocabulary (agent_extensions_manifest_keys): no key can disable mandates, the person's
--     confirmation, sanctions gates, restricted places or payment neutrality;
--   * every action names a mandate kind and never declares a confirmation weaker than the strongest built-in action of
--     that kind; no endpoint lies in a restricted place;
--   * `tested` comes only from a passing safety suite on the fake adapter, recorded by the worker role under a job lease;
--     staff can ask for a run and never state a result;
--   * `active` comes only from a hub configuration version of domain `agent_extensions`, which HUB-001 activates under the
--     `agents.activate_extension` second-person approval; this hook also refuses an approver who drafted the manifest, a
--     stale suite, a route the egress matrix denies and any charged action (see agent_extensions_check_prices);
--   * a suite that fails after an engine update suspends the version in the same transaction, and any suspension fences
--     executing actions to reconciliation through the hub's authorization epoch.
--
-- Staff manage extensions for everyone: nothing here reads or names one participant's agent, mandates or settings.

-- 0. Vocabularies ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.agent_extensions_manifest_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'acceptsUntrustedText', 'actions', 'adapter', 'adapterId', 'amount', 'confirmation', 'contextKinds', 'cost', 'country', 'currency', 'dataClassesRead', 'dataClassesSent', 'endpointHosts',
    'endpoints', 'fakeAdapterId', 'host', 'inputs', 'job', 'key', 'kind', 'mandateKind', 'maxLength', 'meter', 'minorUnits', 'name', 'operation', 'priceVersionId', 'privateDataClasses', 'region',
    'required', 'requiredMandateKinds', 'route', 'safetySuite', 'schemaVersion', 'sideEffects', 'suiteId', 'title', 'type'
  ]::text[]
$$;
-- MANDATE_ACTIONS_V2 of agent-catalog.ts.
CREATE FUNCTION trustwork.agent_extensions_mandate_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'place_order', 'accept_order', 'generate_deliverable', 'introduce', 'schedule', 'maintain_profile', 'publish',
    'register', 'record_evidence', 'confirm_execution', 'approve', 'release_payment', 'maintain_records']::text[]
$$;
CREATE FUNCTION trustwork.agent_extensions_confirmation_rank(p_confirmation text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_confirmation WHEN 'none' THEN 0 WHEN 'mandate' THEN 1 WHEN 'person_each' THEN 2 WHEN 'person_each_step_up' THEN 3 WHEN 'first_party_form' THEN 4 WHEN 'first_party_step_up' THEN 5 END
$$;
CREATE FUNCTION trustwork.agent_extensions_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.agents.read', 'admin.agents.extensions.edit', 'admin.agents.extensions.activate', 'admin.agents.extensions.suspend', 'admin.config.edit']::text[]
$$;
-- Staff who may read the extension registry of a hub.
CREATE FUNCTION trustwork.agent_extensions_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL
    AND (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), trustwork.agent_extensions_reader_permissions(), NULL, p_hub) r) IS NOT NULL
$$;

-- Every key of a manifest outside the vocabulary (any depth; the locale tags under `title` are not walked).
CREATE FUNCTION trustwork.agent_extensions_unknown_keys(p_manifest jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  WITH RECURSIVE walk(v) AS (
    SELECT p_manifest
    UNION ALL
    SELECT c.v FROM walk w CROSS JOIN LATERAL (
      SELECT e.value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e WHERE e.key <> 'title'
      UNION ALL
      SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
    ) c
  )
  SELECT coalesce(array_agg(DISTINCT k.key ORDER BY k.key), ARRAY[]::text[])
  FROM walk w CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) AS k(key)
  WHERE NOT (k.key = ANY (trustwork.agent_extensions_manifest_keys()))
$$;

-- confirmationFloor of agent-extensions.ts, as a rank: the strongest built-in action of the kind, at least `mandate` for a
-- commit, a person each time for human-only kinds.
CREATE FUNCTION trustwork.agent_extensions_confirmation_floor(p_kind text, p_mandate_kind text) RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT greatest(
    coalesce((SELECT max(trustwork.agent_extensions_confirmation_rank(c ->> 'confirmation')) FROM trustwork.agent_engine_manifest m
      CROSS JOIN LATERAL jsonb_array_elements(m.document -> 'capabilities') c WHERE c ->> 'mandateAction' = p_mandate_kind), 0),
    CASE WHEN p_kind = 'commit' THEN 1 ELSE 0 END,
    CASE WHEN p_mandate_kind IN ('confirm_execution', 'approve') THEN 2 ELSE 0 END)
$$;

-- hostCountry of agent-extensions.ts: the country-code top-level domain of a host, or NULL for a generic one.
CREATE FUNCTION trustwork.agent_extensions_host_country(p_host text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN length(t) = 2 THEN upper(t) END FROM (SELECT (regexp_split_to_array(p_host, '\.'))[cardinality(regexp_split_to_array(p_host, '\.'))] AS t) x
$$;

-- The rules of a manifest at draft time and again at activation. Raises the first refusal with a hint and the item in DETAIL.
CREATE FUNCTION trustwork.agent_extensions_check_manifest(p_hub uuid, p_manifest jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_items text[];
  v_key text := p_manifest ->> 'key';
  v_action jsonb;
  v_endpoint jsonb;
  v_hosts text[];
  v_kinds text[] := ARRAY[]::text[];
  v_required text[];
  v_operations text[] := ARRAY[]::text[];
  v_operation text;
  v_host text;
  v_tld text;
  v_floor integer;
  v_rank integer;
BEGIN
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object' THEN
    RAISE EXCEPTION 'a manifest is an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'agents.manifest_invalid';
  END IF;
  v_items := trustwork.agent_extensions_unknown_keys(p_manifest);
  IF cardinality(v_items) > 0 THEN
    RAISE EXCEPTION 'no extension disables mandates, confirmations, sanctions gates, restricted places or payment neutrality' USING ERRCODE = 'check_violation',
      HINT = 'agents.guard_rail', DETAIL = array_to_string(v_items, ',');
  END IF;
  IF octet_length(p_manifest::text) > 65536 OR (p_manifest ->> 'schemaVersion') IS DISTINCT FROM '1' OR coalesce(v_key, '') !~ '^[a-z][a-z0-9_]{1,40}$'
     OR jsonb_typeof(p_manifest -> 'actions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_manifest -> 'actions') NOT BETWEEN 1 AND 50
     OR jsonb_typeof(p_manifest -> 'endpoints') IS DISTINCT FROM 'array' OR jsonb_typeof(p_manifest -> 'requiredMandateKinds') IS DISTINCT FROM 'array'
     OR coalesce(p_manifest #>> '{adapter,adapterId}', '') !~ '^[a-z][a-z0-9_]{1,40}$' OR coalesce(p_manifest #>> '{adapter,fakeAdapterId}', '') !~ '^[a-z][a-z0-9_]{1,40}$'
     OR p_manifest #>> '{adapter,adapterId}' = p_manifest #>> '{adapter,fakeAdapterId}'
     OR (p_manifest #>> '{safetySuite,suiteId}') IS DISTINCT FROM 'extension.' || v_key OR NOT ((p_manifest #>> '{route,job}') = ANY (trustwork.providers_model_jobs())) THEN
    RAISE EXCEPTION 'the manifest names its key, actions, endpoints, adapter and fake, safety suite and route' USING ERRCODE = 'check_violation', HINT = 'agents.manifest_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m WHERE m.module_key = v_key) THEN
    RAISE EXCEPTION 'an extension never takes the key of a built-in module' USING ERRCODE = 'check_violation', HINT = 'agents.key_reserved', DETAIL = v_key;
  END IF;

  v_hosts := ARRAY[]::text[];
  FOR v_endpoint IN SELECT value FROM jsonb_array_elements(p_manifest -> 'endpoints') LOOP
    v_host := v_endpoint ->> 'host';
    v_tld := trustwork.agent_extensions_host_country(v_host);
    IF coalesce(v_endpoint ->> 'country', '') !~ '^[A-Z]{2}$' OR v_host IS NULL THEN
      RAISE EXCEPTION 'an endpoint names its host and country' USING ERRCODE = 'check_violation', HINT = 'agents.manifest_invalid';
    END IF;
    IF trustwork.hubs_place_restricted(p_hub, v_endpoint ->> 'country')
       OR (v_endpoint ->> 'region' IS NOT NULL AND trustwork.hubs_place_restricted(p_hub, v_endpoint ->> 'region'))
       OR (v_tld IS NOT NULL AND trustwork.hubs_place_restricted(p_hub, v_tld)) THEN
      RAISE EXCEPTION 'an extension endpoint is never in a restricted place' USING ERRCODE = 'check_violation', HINT = 'agents.restricted_endpoint', DETAIL = v_host;
    END IF;
    v_hosts := v_hosts || v_host;
  END LOOP;

  FOR v_action IN SELECT value FROM jsonb_array_elements(p_manifest -> 'actions') LOOP
    v_operation := v_action ->> 'operation';
    IF coalesce(v_operation, '') !~ '^[a-z][a-z0-9_]{1,40}$' OR v_operation = ANY (v_operations) THEN
      RAISE EXCEPTION 'each action names a distinct operation' USING ERRCODE = 'check_violation', HINT = 'agents.manifest_invalid', DETAIL = coalesce(v_operation, '?');
    END IF;
    v_operations := v_operations || v_operation;
    IF NOT coalesce((v_action ->> 'mandateKind') = ANY (trustwork.agent_extensions_mandate_kinds()), false) THEN
      RAISE EXCEPTION 'every extension action names a mandate kind' USING ERRCODE = 'check_violation', HINT = 'agents.action_without_mandate_kind', DETAIL = v_operation;
    END IF;
    IF (v_action ->> 'kind') IS NULL OR (v_action ->> 'kind') NOT IN ('draft', 'commit') THEN
      RAISE EXCEPTION 'an extension action is a draft or a commit' USING ERRCODE = 'check_violation', HINT = 'agents.action_kind_refused', DETAIL = v_operation;
    END IF;
    v_rank := trustwork.agent_extensions_confirmation_rank(v_action ->> 'confirmation');
    v_floor := trustwork.agent_extensions_confirmation_floor(v_action ->> 'kind', v_action ->> 'mandateKind');
    IF v_rank IS NULL OR v_rank < v_floor THEN
      RAISE EXCEPTION 'a confirmation is never weaker than the built-in action of the same mandate kind' USING ERRCODE = 'check_violation', HINT = 'agents.confirmation_below_built_in', DETAIL = v_operation;
    END IF;
    IF (v_action ->> 'kind') = 'commit' AND coalesce((v_action ->> 'acceptsUntrustedText')::boolean, true) THEN
      RAISE EXCEPTION 'a commit accepts only structured first-party input' USING ERRCODE = 'check_violation', HINT = 'agents.manifest_invalid', DETAIL = v_operation;
    END IF;
    IF jsonb_typeof(v_action -> 'endpointHosts') IS DISTINCT FROM 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_action -> 'endpointHosts') h WHERE NOT (h = ANY (v_hosts))) THEN
      RAISE EXCEPTION 'an action calls only declared endpoints' USING ERRCODE = 'check_violation', HINT = 'agents.endpoint_undeclared', DETAIL = v_operation;
    END IF;
    IF (v_action #>> '{cost,kind}') = 'per_call' AND (v_action #>> '{cost,amount,minorUnits}')::numeric > 0
       AND ((v_action ->> 'kind') <> 'commit' OR trustwork.assistant_budget_kind(v_action ->> 'mandateKind') IS NULL) THEN
      RAISE EXCEPTION 'a charged action spends a budget' USING ERRCODE = 'check_violation', HINT = 'agents.charge_without_budget', DETAIL = v_operation;
    END IF;
    v_kinds := v_kinds || (v_action ->> 'mandateKind');
  END LOOP;
  v_required := ARRAY(SELECT jsonb_array_elements_text(p_manifest -> 'requiredMandateKinds'));
  IF NOT (v_required <@ v_kinds AND v_kinds <@ v_required) THEN
    RAISE EXCEPTION 'the required mandate kinds are exactly those of the actions' USING ERRCODE = 'check_violation', HINT = 'agents.manifest_invalid', DETAIL = 'requiredMandateKinds';
  END IF;
END $$;

-- 1. Tables ----------------------------------------------------------------------------------------------------------------
-- One extension of one hub. Its id is what a route scope and a kill switch name; its key is its module key.
CREATE TABLE trustwork.agent_extension (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hub_id, key)
);
CREATE TRIGGER agent_extension_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_extension FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- The engine version the worker last reported; a suite passed on another engine is stale. One row.
CREATE TABLE trustwork.agent_extension_engine (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 40),
  observed_at timestamptz NOT NULL DEFAULT now()
);

-- One immutable version of a manifest. Only its lifecycle columns change, and only through the guard below.
CREATE TABLE trustwork.agent_extension_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  extension_id uuid NOT NULL REFERENCES trustwork.agent_extension (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  version integer NOT NULL CHECK (version >= 1),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'tested', 'active', 'suspended', 'retired')),
  status_reason text NULL CHECK (status_reason IS NULL OR length(status_reason) BETWEEN 1 AND 500),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  passing_run_id uuid NULL,
  config_version_id uuid NULL REFERENCES trustwork.hub_config_version (id),
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  approved_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extension_id, version),
  CONSTRAINT agent_extension_tested_passed CHECK (status NOT IN ('tested', 'active') OR passing_run_id IS NOT NULL),
  CONSTRAINT agent_extension_second_person CHECK (status <> 'active' OR (config_version_id IS NOT NULL AND approval_id IS NOT NULL AND approved_by IS NOT NULL AND approved_by <> drafted_by AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_extension_one_active ON trustwork.agent_extension_version (extension_id) WHERE status = 'active';
CREATE INDEX agent_extension_version_hub_idx ON trustwork.agent_extension_version (hub_id, status);

-- One safety suite run of one version: asked for by staff or by an engine update, completed only by the worker.
CREATE TABLE trustwork.agent_extension_safety_run (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  version_id uuid NOT NULL REFERENCES trustwork.agent_extension_version (id),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  trigger text NOT NULL CHECK (trigger IN ('staff', 'engine_update')),
  requested_by uuid NULL REFERENCES trustwork.person (id),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'passed', 'failed')),
  engine_version text NULL CHECK (engine_version IS NULL OR length(engine_version) BETWEEN 1 AND 40),
  report jsonb NULL,
  report_digest text NULL CHECK (report_digest IS NULL OR report_digest ~ '^[a-f0-9]{64}$'),
  scenario_count integer NOT NULL DEFAULT 0 CHECK (scenario_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT agent_extension_run_trigger CHECK ((trigger = 'staff') = (requested_by IS NOT NULL)),
  CONSTRAINT agent_extension_run_complete CHECK ((state = 'requested') = (completed_at IS NULL) AND (state = 'requested') = (report IS NULL) AND (state = 'requested') = (report_digest IS NULL) AND (state = 'requested') = (engine_version IS NULL)),
  CONSTRAINT agent_extension_run_passed CHECK (state <> 'passed' OR (failed_count = 0 AND scenario_count > 0))
);
CREATE UNIQUE INDEX agent_extension_one_open_run ON trustwork.agent_extension_safety_run (version_id) WHERE state = 'requested';
CREATE INDEX agent_extension_run_version_idx ON trustwork.agent_extension_safety_run (version_id, requested_at DESC);
ALTER TABLE trustwork.agent_extension_version ADD CONSTRAINT agent_extension_passing_run FOREIGN KEY (passing_run_id) REFERENCES trustwork.agent_extension_safety_run (id);

-- Every lifecycle change, by every writer, including the engine's own suspension (no person).
CREATE TABLE trustwork.agent_extension_transition (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  version_id uuid NOT NULL REFERENCES trustwork.agent_extension_version (id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NULL,
  actor_person_id uuid NULL REFERENCES trustwork.person (id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_extension_transition_version_idx ON trustwork.agent_extension_transition (version_id, at DESC);
CREATE TRIGGER agent_extension_transition_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_extension_transition FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Guards on every writer ------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.agent_extensions_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_allowed text[];
  v_run trustwork.agent_extension_safety_run%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extension versions are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.passing_run_id IS NOT NULL OR NEW.config_version_id IS NOT NULL OR NEW.approval_id IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'an extension version is born a draft' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
    END IF;
    -- The database computes the digest of what it stores; a caller cannot bind another manifest.
    NEW.manifest_digest := trustwork.admin_digest(NEW.manifest);
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.extension_id <> OLD.extension_id OR NEW.hub_id <> OLD.hub_id OR NEW.version <> OLD.version OR NEW.manifest <> OLD.manifest
     OR NEW.manifest_digest <> OLD.manifest_digest OR NEW.drafted_by <> OLD.drafted_by OR NEW.drafted_at <> OLD.drafted_at THEN
    RAISE EXCEPTION 'an extension version is immutable; draft a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.version_immutable';
  END IF;
  IF NEW.passing_run_id IS DISTINCT FROM OLD.passing_run_id AND NEW.passing_run_id IS NOT NULL THEN
    -- A passing run of this exact manifest, whatever the writer claims.
    SELECT * INTO v_run FROM trustwork.agent_extension_safety_run WHERE id = NEW.passing_run_id;
    IF NOT FOUND OR v_run.version_id <> NEW.id OR v_run.state <> 'passed' OR v_run.manifest_digest <> NEW.manifest_digest THEN
      RAISE EXCEPTION 'tested means a passing suite of this manifest' USING ERRCODE = 'check_violation', HINT = 'agents.suite_required';
    END IF;
  END IF;
  IF NEW.status <> OLD.status THEN
    -- extensionTransitionAllowed of agent-extensions.ts.
    v_allowed := CASE OLD.status
      WHEN 'draft' THEN ARRAY['tested', 'retired']
      WHEN 'tested' THEN ARRAY['active', 'suspended', 'retired']
      WHEN 'active' THEN ARRAY['suspended', 'retired']
      WHEN 'suspended' THEN ARRAY['tested', 'retired']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'extension version % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
    END IF;
    IF NEW.status = 'active' THEN
      NEW.activated_at := now();
    ELSIF OLD.status = 'suspended' AND NEW.status = 'tested' AND NEW.passing_run_id IS NOT DISTINCT FROM OLD.passing_run_id THEN
      RAISE EXCEPTION 'a suspended version returns only after a new passing suite' USING ERRCODE = 'check_violation', HINT = 'agents.suite_required';
    END IF;
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER agent_extension_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agent_extension_version FOR EACH ROW EXECUTE FUNCTION trustwork.agent_extensions_version_guard();

CREATE FUNCTION trustwork.agent_extensions_record_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  INSERT INTO trustwork.agent_extension_transition (hub_id, version_id, from_status, to_status, reason, actor_person_id)
  VALUES (NEW.hub_id, NEW.id, OLD.status, NEW.status, NEW.status_reason, trustwork.current_person_id());
  RETURN NULL;
END $$;
CREATE TRIGGER agent_extension_version_transition AFTER UPDATE OF status ON trustwork.agent_extension_version FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION trustwork.agent_extensions_record_transition();

CREATE FUNCTION trustwork.agent_extensions_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety runs are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'requested' THEN
      RAISE EXCEPTION 'a safety run is born requested' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'requested' OR NEW.state = 'requested' OR NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.version_id <> OLD.version_id OR NEW.manifest_digest <> OLD.manifest_digest
     OR NEW.trigger <> OLD.trigger OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'a safety run completes once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'agents.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_extension_safety_run_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agent_extension_safety_run FOR EACH ROW EXECUTE FUNCTION trustwork.agent_extensions_run_guard();

-- Stops what a withdrawn extension is doing: the hub's epoch moves and executing actions go to reconciliation.
CREATE FUNCTION trustwork.agent_extensions_fence(p_hub uuid, p_key text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_intents uuid[];
BEGIN
  PERFORM trustwork.agent_modules_bump('hub', p_hub);
  SELECT coalesce(array_agg(i.id), ARRAY[]::uuid[]) INTO v_intents FROM trustwork.action_intent i
    JOIN trustwork.agent_intent_provenance p ON p.action_intent_id = i.id
    WHERE i.state IN ('executing', 'pending') AND i.module_key = p_key AND p.hub_id = p_hub;
  PERFORM trustwork.agent_modules_fence(v_intents);
END $$;

-- 3. Activation --------------------------------------------------------------------------------------------------------------
-- The route check: an active route scoped to this extension exists, and the gate would let every data class the extension
-- sends through it. The dry run is the same decision every call passes; it reserves nothing.
CREATE FUNCTION trustwork.agent_extensions_check_route(p_hub uuid, p_extension uuid, p_manifest jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_job text := p_manifest #>> '{route,job}';
  v_classes jsonb;
  v_decision jsonb;
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
END $$;

-- Whether a price version is active is billing's to answer: payment neutrality keeps its tables to billing, and AGT-004 owns
-- metered prices. Until AGT-004 supplies that answer, a charged action does not activate. Refusing is the only reply that
-- cannot charge a participant under a price nobody checked; a free action is unaffected.
CREATE FUNCTION trustwork.agent_extensions_check_prices(p_manifest jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_action jsonb;
BEGIN
  FOR v_action IN SELECT value FROM jsonb_array_elements(p_manifest -> 'actions') LOOP
    IF (v_action #>> '{cost,kind}') = 'per_call' AND (v_action #>> '{cost,amount,minorUnits}')::numeric > 0 THEN
      RAISE EXCEPTION 'a charged action activates once billing can confirm its price version' USING ERRCODE = 'check_violation', HINT = 'agents.price_version_unavailable', DETAIL = v_action ->> 'operation';
    END IF;
  END LOOP;
END $$;

-- Every version a configuration payload lists, when it is drafted and again when it activates (p_approver is known then).
CREATE FUNCTION trustwork.agent_extensions_check_payload(p_hub uuid, p_payload jsonb, p_approver uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_entry jsonb;
  v trustwork.agent_extension_version%ROWTYPE;
  v_run trustwork.agent_extension_safety_run%ROWTYPE;
  v_engine text := (SELECT engine_version FROM trustwork.agent_extension_engine);
  v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF (p_payload ->> 'schemaVersion') IS DISTINCT FROM '1' OR jsonb_typeof(p_payload -> 'activeVersions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'an extension configuration lists its active versions' USING ERRCODE = 'check_violation', HINT = 'agents.manifest_invalid';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_payload -> 'activeVersions') ORDER BY value ->> 'versionId' LOOP
    SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = (v_entry ->> 'versionId')::uuid AND hub_id = p_hub FOR UPDATE;
    IF NOT FOUND OR v.extension_id::text IS DISTINCT FROM v_entry ->> 'extensionId' OR v.manifest_digest IS DISTINCT FROM v_entry ->> 'manifestDigest' THEN
      RAISE EXCEPTION 'the configuration names a version this hub does not have' USING ERRCODE = 'check_violation', HINT = 'agents.version_not_ready', DETAIL = coalesce(v_entry ->> 'versionId', '?');
    END IF;
    IF v.extension_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'one active version per extension' USING ERRCODE = 'check_violation', HINT = 'agents.one_version_per_extension', DETAIL = v.extension_id::text;
    END IF;
    v_seen := v_seen || v.extension_id;
    IF v.status NOT IN ('tested', 'active') THEN
      RAISE EXCEPTION 'only a tested version activates' USING ERRCODE = 'check_violation', HINT = 'agents.version_not_ready', DETAIL = v.id::text;
    END IF;
    SELECT * INTO v_run FROM trustwork.agent_extension_safety_run WHERE id = v.passing_run_id;
    IF NOT FOUND OR v_run.state <> 'passed' OR v_run.manifest_digest <> v.manifest_digest THEN
      RAISE EXCEPTION 'activation needs a passed safety suite' USING ERRCODE = 'check_violation', HINT = 'agents.suite_required', DETAIL = v.id::text;
    END IF;
    IF v_engine IS NULL OR v_run.engine_version IS DISTINCT FROM v_engine THEN
      RAISE EXCEPTION 'the suite passed on another engine version; run it again' USING ERRCODE = 'check_violation', HINT = 'agents.suite_stale', DETAIL = v.id::text;
    END IF;
    IF v.status = 'tested' THEN
      IF p_approver IS NOT NULL AND p_approver = v.drafted_by THEN
        RAISE EXCEPTION 'the second person is not the drafter of the manifest' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.drafter_cannot_approve', DETAIL = v.id::text;
      END IF;
      -- The world may have changed since the draft (restricted list, hub-added places, engine manifests).
      PERFORM trustwork.agent_extensions_check_manifest(p_hub, v.manifest);
      PERFORM trustwork.agent_extensions_check_route(p_hub, v.extension_id, v.manifest);
      PERFORM trustwork.agent_extensions_check_prices(v.manifest);
    END IF;
  END LOOP;
END $$;

-- The activation hook of the `agent_extensions` domain. HUB-001 has already consumed the second person's approval of this
-- exact configuration version; every listed version becomes active and every active version the list drops is retired.
CREATE FUNCTION trustwork.agent_extensions_on_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_listed uuid[];
  v trustwork.agent_extension_version%ROWTYPE;
BEGIN
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
  IF NOT FOUND OR v_approval.approved_by IS NULL THEN
    RAISE EXCEPTION 'activating extensions needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  PERFORM trustwork.agent_extensions_check_payload(NEW.hub_id, NEW.payload, v_approval.approved_by);
  v_listed := ARRAY(SELECT (e ->> 'versionId')::uuid FROM jsonb_array_elements(NEW.payload -> 'activeVersions') e);
  FOR v IN SELECT * FROM trustwork.agent_extension_version WHERE hub_id = NEW.hub_id AND status = 'active' AND NOT (id = ANY (v_listed)) ORDER BY id FOR UPDATE LOOP
    UPDATE trustwork.agent_extension_version SET status = 'retired', status_reason = 'replaced by configuration version ' || NEW.version WHERE id = v.id;
    PERFORM trustwork.agent_extensions_fence(NEW.hub_id, v.manifest ->> 'key');
  END LOOP;
  UPDATE trustwork.agent_extension_version SET status = 'active', status_reason = NULL, config_version_id = NEW.id, approval_id = NEW.approval_id, approved_by = v_approval.approved_by
   WHERE id = ANY (v_listed) AND status = 'tested';
  PERFORM trustwork.agent_modules_bump('hub', NEW.hub_id);
  RETURN NULL;
END $$;
CREATE TRIGGER agent_extension_activation AFTER UPDATE OF status ON trustwork.hub_config_version FOR EACH ROW
  WHEN (NEW.domain = 'agent_extensions' AND NEW.status = 'active' AND OLD.status = 'draft') EXECUTE FUNCTION trustwork.agent_extensions_on_activation();

-- 4. Staff commands (SECURITY DEFINER, allowlisted for the runtime role) ---------------------------------------------------
CREATE FUNCTION trustwork.agent_extensions_draft(p_ctx jsonb, p_hub uuid, p_manifest jsonb) RETURNS trustwork.agent_extension_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_hub trustwork.hub%ROWTYPE := trustwork.hubs_require_hub(p_hub);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions('agent_extensions'), NULL, p_hub);
  v_extension trustwork.agent_extension%ROWTYPE;
  v_row trustwork.agent_extension_version%ROWTYPE;
BEGIN
  IF v_hub.lifecycle = 'closed' THEN
    RAISE EXCEPTION 'a closed hub is not configured' USING ERRCODE = 'check_violation', HINT = 'hubs.hub_closed';
  END IF;
  PERFORM trustwork.agent_extensions_check_manifest(p_hub, p_manifest);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.agent_extensions:' || p_hub::text || ':' || (p_manifest ->> 'key'), 0));
  SELECT * INTO v_extension FROM trustwork.agent_extension WHERE hub_id = p_hub AND key = p_manifest ->> 'key';
  IF NOT FOUND THEN
    INSERT INTO trustwork.agent_extension (hub_id, key, created_by) VALUES (p_hub, p_manifest ->> 'key', v_actor.person_id) RETURNING * INTO v_extension;
  END IF;
  INSERT INTO trustwork.agent_extension_version (extension_id, hub_id, version, manifest, manifest_digest, drafted_by)
  VALUES (v_extension.id, p_hub, coalesce((SELECT max(version) FROM trustwork.agent_extension_version WHERE extension_id = v_extension.id), 0) + 1, p_manifest, repeat('0', 64), v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'agents.extension_drafted', 'agent_extension_version', v_row.id, NULL,
    jsonb_build_object('id', v_row.id, 'extensionId', v_row.extension_id, 'version', v_row.version, 'manifestDigest', v_row.manifest_digest, 'revision', v_row.revision));
  RETURN v_row;
END $$;

-- Staff may ask for a run; they can never state its result.
CREATE FUNCTION trustwork.agent_extensions_request_run(p_ctx jsonb, p_version uuid, p_expected_revision integer) RETURNS trustwork.agent_extension_safety_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v trustwork.agent_extension_version%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.agent_extension_safety_run%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such extension version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions('agent_extensions'), NULL, v.hub_id);
  IF v.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the version changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'agents.revision_conflict';
  END IF;
  IF v.status = 'retired' THEN
    RAISE EXCEPTION 'a retired version is not tested' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.agent_extension_safety_run r WHERE r.version_id = v.id AND r.state = 'requested') THEN
    RAISE EXCEPTION 'a run of this version is already waiting' USING ERRCODE = 'check_violation', HINT = 'agents.suite_pending';
  END IF;
  INSERT INTO trustwork.agent_extension_safety_run (hub_id, version_id, manifest_digest, trigger, requested_by)
  VALUES (v.hub_id, v.id, v.manifest_digest, 'staff', v_actor.person_id) RETURNING * INTO v_row;
  INSERT INTO trustwork.job (kind, payload, next_at, max_attempts) VALUES ('agents.extension_safety_run', jsonb_build_object('runId', v_row.id), now(), 5);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v.hub_id, 'agents.extension_suite_requested', 'agent_extension_safety_run', v_row.id, NULL,
    jsonb_build_object('id', v_row.id, 'versionId', v.id, 'manifestDigest', v.manifest_digest));
  RETURN v_row;
END $$;

-- The proposal a second person will approve: today's active versions with the named ones in their place.
CREATE FUNCTION trustwork.agent_extensions_draft_activation(p_ctx jsonb, p_hub uuid, p_versions uuid[]) RETURNS trustwork.hub_config_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions('agent_extensions'), NULL, p_hub);
  v_named trustwork.agent_extension_version[];
  v_payload jsonb;
BEGIN
  v_named := ARRAY(SELECT x FROM trustwork.agent_extension_version x WHERE x.id = ANY (p_versions) AND x.hub_id = p_hub);
  IF cardinality(v_named) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_versions))) OR cardinality(v_named) = 0 THEN
    RAISE EXCEPTION 'no such extension version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT jsonb_build_object('schemaVersion', 1, 'activeVersions', coalesce(jsonb_agg(jsonb_build_object('extensionId', x.extension_id, 'versionId', x.id, 'manifestDigest', x.manifest_digest) ORDER BY x.id), '[]'::jsonb))
    INTO v_payload FROM (
      SELECT a.extension_id, a.id, a.manifest_digest FROM trustwork.agent_extension_version a
       WHERE a.hub_id = p_hub AND a.status = 'active' AND NOT EXISTS (SELECT 1 FROM unnest(v_named) n WHERE n.extension_id = a.extension_id)
      UNION ALL
      SELECT n.extension_id, n.id, n.manifest_digest FROM unnest(v_named) n
    ) x;
  PERFORM trustwork.agent_extensions_check_payload(p_hub, v_payload, NULL);
  RETURN trustwork.hubs_draft_config(p_ctx, p_hub, 'agent_extensions', v_payload, 'console');
END $$;

-- Suspending is immediate and needs one person: withdrawing an ability is always safe. Returning needs a new passing suite
-- and a new configuration version under a second person.
CREATE FUNCTION trustwork.agent_extensions_suspend(p_ctx jsonb, p_version uuid, p_expected_revision integer) RETURNS trustwork.agent_extension_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v trustwork.agent_extension_version%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.agent_extension_version%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such extension version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.agents.extensions.suspend'], NULL, v.hub_id);
  IF v.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the version changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'agents.revision_conflict';
  END IF;
  IF v.status NOT IN ('tested', 'active') THEN
    RAISE EXCEPTION 'only a tested or active version is suspended' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  UPDATE trustwork.agent_extension_version SET status = 'suspended', status_reason = p_ctx ->> 'reasonText' WHERE id = p_version RETURNING * INTO v_row;
  PERFORM trustwork.agent_extensions_fence(v.hub_id, v.manifest ->> 'key');
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v.hub_id, 'agents.extension_suspended', 'agent_extension_version', v.id,
    jsonb_build_object('status', v.status, 'revision', v.revision), jsonb_build_object('status', v_row.status, 'revision', v_row.revision));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.agent_extensions_retire(p_ctx jsonb, p_version uuid, p_expected_revision integer) RETURNS trustwork.agent_extension_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v trustwork.agent_extension_version%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.agent_extension_version%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such extension version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.agents.extensions.suspend', 'admin.agents.extensions.edit'], NULL, v.hub_id);
  IF v.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the version changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'agents.revision_conflict';
  END IF;
  IF v.status = 'retired' THEN
    RAISE EXCEPTION 'the version is already retired' USING ERRCODE = 'check_violation', HINT = 'agents.invalid_transition';
  END IF;
  UPDATE trustwork.agent_extension_version SET status = 'retired', status_reason = p_ctx ->> 'reasonText' WHERE id = p_version RETURNING * INTO v_row;
  PERFORM trustwork.agent_extensions_fence(v.hub_id, v.manifest ->> 'key');
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v.hub_id, 'agents.extension_retired', 'agent_extension_version', v.id,
    jsonb_build_object('status', v.status, 'revision', v.revision), jsonb_build_object('status', v_row.status, 'revision', v_row.revision));
  RETURN v_row;
END $$;

-- 5. The worker: only it completes a run ---------------------------------------------------------------------------------------
-- The job's lease proves this call is the live attempt; the payload is not authority.
CREATE FUNCTION trustwork.agent_extensions_lock_run(p_run uuid, p_job uuid, p_fence bigint) RETURNS trustwork.agent_extension_safety_run
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.agent_extension_safety_run%ROWTYPE;
BEGIN
  PERFORM 1 FROM trustwork.job WHERE id = p_job AND kind = 'agents.extension_safety_run' AND state = 'leased' AND leased_until > clock_timestamp() AND fencing_token = p_fence
    AND payload ->> 'runId' = p_run::text FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'safety run lease unavailable' USING ERRCODE = '55P03', HINT = 'agents.fenced_out';
  END IF;
  SELECT * INTO v_row FROM trustwork.agent_extension_safety_run WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such safety run' USING ERRCODE = 'no_data_found', HINT = 'agents.fenced_out';
  END IF;
  RETURN v_row;
END $$;

-- What the worker runs the suite on: the stored manifest, never a payload it was handed.
CREATE FUNCTION trustwork.agent_extensions_load_run(p_run uuid, p_job uuid, p_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.agent_extension_safety_run%ROWTYPE := trustwork.agent_extensions_lock_run(p_run, p_job, p_fence);
  v trustwork.agent_extension_version%ROWTYPE;
BEGIN
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = r.version_id;
  RETURN jsonb_build_object('runId', r.id, 'state', r.state, 'versionId', v.id, 'extensionId', v.extension_id, 'hubId', v.hub_id, 'manifest', v.manifest, 'manifestDigest', v.manifest_digest);
END $$;

-- Records a finished run. A pass makes a draft or a suspended version `tested`; a failure of a tested or active version
-- suspends it in this transaction: the engine withdraws what it can no longer vouch for.
CREATE FUNCTION trustwork.agent_extensions_record_run(p_run uuid, p_job uuid, p_fence bigint, p_report jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.agent_extension_safety_run%ROWTYPE := trustwork.agent_extensions_lock_run(p_run, p_job, p_fence);
  v trustwork.agent_extension_version%ROWTYPE;
  v_total integer := coalesce(jsonb_array_length(p_report -> 'scenarios'), 0);
  v_failed integer := (SELECT count(*) FROM jsonb_array_elements(coalesce(p_report -> 'scenarios', '[]'::jsonb)) s WHERE s ->> 'status' IS DISTINCT FROM 'passed');
  v_passed boolean;
BEGIN
  IF r.state <> 'requested' THEN
    RETURN r.state;
  END IF;
  SELECT * INTO v FROM trustwork.agent_extension_version WHERE id = r.version_id FOR UPDATE;
  IF (p_report ->> 'schema') IS DISTINCT FROM 'trustwork.agent-safety-report/1' OR (p_report ->> 'onFakeAdapter') IS DISTINCT FROM 'true' OR (p_report ->> 'manifestDigest') IS DISTINCT FROM r.manifest_digest
     OR coalesce(length(p_report ->> 'engineVersion'), 0) NOT BETWEEN 1 AND 40 OR v_total < 1 OR (p_report ->> 'suiteId') IS DISTINCT FROM v.manifest #>> '{safetySuite,suiteId}' THEN
    RAISE EXCEPTION 'a safety report binds this manifest and ran on the fake adapter' USING ERRCODE = 'check_violation', HINT = 'agents.suite_required';
  END IF;
  v_passed := v_failed = 0 AND (p_report ->> 'passed') = 'true';
  UPDATE trustwork.agent_extension_safety_run SET state = CASE WHEN v_passed THEN 'passed' ELSE 'failed' END, engine_version = p_report ->> 'engineVersion', report = p_report, report_digest = trustwork.admin_digest(p_report),
    scenario_count = v_total, failed_count = v_failed, completed_at = now() WHERE id = r.id;
  INSERT INTO trustwork.agent_extension_engine AS e (id, engine_version) VALUES (true, p_report ->> 'engineVersion')
  ON CONFLICT (id) DO UPDATE SET engine_version = EXCLUDED.engine_version, observed_at = now();
  IF v_passed THEN
    IF v.status IN ('draft', 'suspended') THEN
      UPDATE trustwork.agent_extension_version SET status = 'tested', status_reason = NULL, passing_run_id = r.id WHERE id = v.id;
    ELSIF v.status IN ('tested', 'active') THEN
      UPDATE trustwork.agent_extension_version SET passing_run_id = r.id WHERE id = v.id;
    END IF;
  ELSIF v.status IN ('tested', 'active') THEN
    UPDATE trustwork.agent_extension_version SET status = 'suspended', status_reason = 'safety suite failed on engine ' || (p_report ->> 'engineVersion') WHERE id = v.id;
    PERFORM trustwork.agent_extensions_fence(v.hub_id, v.manifest ->> 'key');
  END IF;
  RETURN CASE WHEN v_passed THEN 'passed' ELSE 'failed' END;
END $$;

-- The worker's scheduled tick: records the engine version it runs and asks a run for every tested or active version whose
-- passing suite is from another engine. Returns how many it asked for.
CREATE FUNCTION trustwork.agent_extensions_engine_tick(p_engine text, p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v trustwork.agent_extension_version%ROWTYPE;
  v_run uuid;
  v_count integer := 0;
BEGIN
  IF coalesce(length(p_engine), 0) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'an engine version is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  INSERT INTO trustwork.agent_extension_engine AS e (id, engine_version) VALUES (true, p_engine)
  ON CONFLICT (id) DO UPDATE SET engine_version = EXCLUDED.engine_version, observed_at = CASE WHEN e.engine_version = EXCLUDED.engine_version THEN e.observed_at ELSE now() END;
  FOR v IN SELECT x.* FROM trustwork.agent_extension_version x JOIN trustwork.agent_extension_safety_run p ON p.id = x.passing_run_id
    WHERE x.status IN ('tested', 'active') AND p.engine_version IS DISTINCT FROM p_engine
      AND NOT EXISTS (SELECT 1 FROM trustwork.agent_extension_safety_run o WHERE o.version_id = x.id AND o.state = 'requested')
    ORDER BY x.id LIMIT greatest(coalesce(p_limit, 0), 0) FOR UPDATE OF x SKIP LOCKED LOOP
    INSERT INTO trustwork.agent_extension_safety_run (hub_id, version_id, manifest_digest, trigger) VALUES (v.hub_id, v.id, v.manifest_digest, 'engine_update') RETURNING id INTO v_run;
    INSERT INTO trustwork.job (kind, payload, next_at, max_attempts) VALUES ('agents.extension_safety_run', jsonb_build_object('runId', v_run), now(), 5);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- 6. Row-level security and grants ---------------------------------------------------------------------------------------------
ALTER TABLE trustwork.agent_extension ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_engine ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_engine FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_safety_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_safety_run FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_extension_transition FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_extension_maintenance ON trustwork.agent_extension TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_extension_engine_maintenance ON trustwork.agent_extension_engine TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_extension_version_maintenance ON trustwork.agent_extension_version TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_extension_safety_run_maintenance ON trustwork.agent_extension_safety_run TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_extension_transition_maintenance ON trustwork.agent_extension_transition TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY agent_extension_read ON trustwork.agent_extension FOR SELECT TO trustwork_app USING (trustwork.agent_extensions_staff_reader(hub_id));
CREATE POLICY agent_extension_engine_read ON trustwork.agent_extension_engine FOR SELECT TO trustwork_app USING (true);
-- An active manifest is what the hub offers everyone; drafts and history are staff business.
CREATE POLICY agent_extension_version_read ON trustwork.agent_extension_version FOR SELECT TO trustwork_app USING (status = 'active' OR trustwork.agent_extensions_staff_reader(hub_id));
CREATE POLICY agent_extension_safety_run_read ON trustwork.agent_extension_safety_run FOR SELECT TO trustwork_app USING (trustwork.agent_extensions_staff_reader(hub_id));
CREATE POLICY agent_extension_transition_read ON trustwork.agent_extension_transition FOR SELECT TO trustwork_app USING (trustwork.agent_extensions_staff_reader(hub_id));

GRANT SELECT ON trustwork.agent_extension, trustwork.agent_extension_engine, trustwork.agent_extension_version, trustwork.agent_extension_safety_run, trustwork.agent_extension_transition TO trustwork_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trustwork.agent_extensions_staff_reader(uuid),
  trustwork.agent_extensions_draft(jsonb, uuid, jsonb),
  trustwork.agent_extensions_request_run(jsonb, uuid, integer),
  trustwork.agent_extensions_draft_activation(jsonb, uuid, uuid[]),
  trustwork.agent_extensions_suspend(jsonb, uuid, integer),
  trustwork.agent_extensions_retire(jsonb, uuid, integer)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.agent_extensions_load_run(uuid, uuid, bigint),
  trustwork.agent_extensions_record_run(uuid, uuid, bigint, jsonb),
  trustwork.agent_extensions_engine_tick(text, integer)
TO trustwork_worker;

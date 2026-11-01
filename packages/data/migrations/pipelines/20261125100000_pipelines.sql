-- PIPE-001 pipeline engine and scheduler (docs/engine/hub-console/automation-and-scheduling.md; console contract hub.ts:
-- ScheduleSchema, PipelineVersionSchema, PipelineRunSchema, RUN_STATES and runTransitionAllowed).
--
-- A hub runs versioned pipelines on schedules with windows, quotas, retries, alerts, dry runs, pause and resume. Staff
-- commands are SECURITY DEFINER functions that resolve the caller's permission at the hub with a live elevation
-- (admin_authorize) and write an admin_audit_event in the same transaction; the runtime role only reads under row-level
-- security. The worker leases runs with a fencing token and reports every step boundary, effect and finish through the
-- worker functions below. Rules enforced for every writer:
-- * editing creates a new version; a run records the exact version it ran; at most one version of a pipeline is active;
--   the drafter never activates their own version, and an active version names a spending cap (budget);
-- * a run moves only along RUN_TRANSITIONS; a finished run never changes; a retry is a new run linked to the failed one;
-- * a dry run commits nothing: it never records an effect, never charges a cap and finishes with effects_committed false;
-- * an external effect (an outreach touch, a notification, a paid model call) is recorded under a stable effect key
--   before it runs; a recorded key is never run again by any run of the pipeline,
--   so a retried outreach run never sends a second message for a touch whose first outcome is unknown;
-- * an engaged kill switch on the pipeline (admin kill_switch, scope `pipeline`) stops queued runs and ends running ones
--   at the next step boundary; an exhausted per-role cap marks queued runs that need that role `skipped_budget` while
--   runs of other roles keep going;
-- * a robots, terms or licence change of a source pauses every schedule that reads it and raises an alert.

-- 1. Tables ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.pipelines_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['source_discovery', 'source_ingestion', 'editorial_drafting', 'translation', 'magazine_assembly', 'dataset_refresh', 'entity_resolution',
    'verification_recheck', 'sanctions_rescreen', 'index_build']::text[]
$$;
CREATE FUNCTION trustwork.pipelines_run_states() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch']::text[]
$$;
CREATE FUNCTION trustwork.pipelines_finished_states() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch']::text[]
$$;
-- The console contract's RUN_TRANSITIONS.
CREATE FUNCTION trustwork.pipelines_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_from
    WHEN 'queued' THEN p_to IN ('running', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch')
    WHEN 'running' THEN p_to IN ('succeeded', 'partially_succeeded', 'failed', 'cancelled', 'stopped_by_kill_switch', 'skipped_budget')
    ELSE false END
$$;
-- Steps: a JSON array of 1 to 30 objects whose kind is a console step; no step publishes, activates, merges or sanctions.
CREATE FUNCTION trustwork.pipelines_steps_ok(p_steps jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p_steps) = 'array' AND jsonb_array_length(p_steps) BETWEEN 1 AND 30
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_steps) s WHERE jsonb_typeof(s) <> 'object' OR NOT (s ->> 'kind' = ANY (ARRAY[
      'discover', 'check_legal', 'fetch', 'parse', 'normalise', 'deduplicate', 'classify', 'link_entities', 'summarise', 'rewrite', 'translate',
      'fact_check', 'similarity_check', 'generate_image', 'assemble', 'screen', 'index', 'propose_for_review', 'notify_staff']::text[])))
$$;

CREATE TABLE trustwork.pipeline (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  kind text NOT NULL CHECK (kind = ANY (trustwork.pipelines_kinds())),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_hub_idx ON trustwork.pipeline (hub_id);

CREATE TABLE trustwork.pipeline_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  pipeline_id uuid NOT NULL REFERENCES trustwork.pipeline (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  version integer NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  source_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_ids) <= 50),
  dataset_id uuid NULL,
  steps jsonb NOT NULL CHECK (trustwork.pipelines_steps_ok(steps)),
  automation_level text NOT NULL CHECK (automation_level IN ('manual', 'assisted', 'supervised_autonomous')),
  budget_id uuid NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'paused')),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, version),
  CONSTRAINT pipeline_version_active_cap CHECK (status NOT IN ('active', 'paused') OR (activated_by IS NOT NULL AND budget_id IS NOT NULL AND activated_at IS NOT NULL)),
  CONSTRAINT pipeline_version_four_eyes CHECK (activated_by IS NULL OR activated_by <> drafted_by)
);
CREATE UNIQUE INDEX pipeline_version_one_active ON trustwork.pipeline_version (pipeline_id) WHERE status IN ('active', 'paused');

CREATE TABLE trustwork.pipeline_schedule (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  pipeline_id uuid NOT NULL UNIQUE REFERENCES trustwork.pipeline (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  cron text NOT NULL CHECK (cron ~ '^(\S+\s+){4}\S+$' AND length(cron) <= 120),
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  windows jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) <= 14),
  jitter_seconds integer NOT NULL DEFAULT 0 CHECK (jitter_seconds BETWEEN 0 AND 3600),
  quotas jsonb NOT NULL CHECK (jsonb_typeof(quotas) = 'object'),
  retry jsonb NOT NULL CHECK (jsonb_typeof(retry) = 'object' AND (retry ->> 'maxAttempts')::int BETWEEN 1 AND 10),
  concurrency integer NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 4),
  alerts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(alerts) = 'array' AND jsonb_array_length(alerts) <= 10),
  paused boolean NOT NULL DEFAULT false,
  paused_by uuid NULL REFERENCES trustwork.person (id),
  paused_reason text NULL CHECK (paused_reason IS NULL OR length(paused_reason) BETWEEN 1 AND 500),
  paused_automatically boolean NOT NULL DEFAULT false,
  last_due_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES trustwork.person (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A person pauses with a reason; an automatic pause (source change) records the reason without a person.
  CONSTRAINT pipeline_schedule_pause CHECK (NOT paused OR (paused_reason IS NOT NULL AND (paused_by IS NOT NULL OR paused_automatically)))
);

-- Per-role caps of the editorial and outreach agent team (editorial office section 8.3), per hub and day.
CREATE TABLE trustwork.pipeline_role_cap (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  role text NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{1,40}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  daily_cap_minor bigint NOT NULL CHECK (daily_cap_minor >= 0),
  spent_minor bigint NOT NULL DEFAULT 0 CHECK (spent_minor >= 0),
  spent_day date NOT NULL DEFAULT current_date,
  updated_by uuid NOT NULL REFERENCES trustwork.person (id),
  UNIQUE (hub_id, role)
);

CREATE TABLE trustwork.pipeline_run (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  pipeline_id uuid NOT NULL REFERENCES trustwork.pipeline (id),
  pipeline_version_id uuid NOT NULL REFERENCES trustwork.pipeline_version (id),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'dry_run', 'retry', 'backfill', 'event')),
  dry_run boolean NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state = ANY (trustwork.pipelines_run_states())),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  retry_of uuid NULL REFERENCES trustwork.pipeline_run (id),
  triggered_by uuid NULL REFERENCES trustwork.person (id),
  schedule_id uuid NULL REFERENCES trustwork.pipeline_schedule (id),
  due_at timestamptz NULL,
  backfill_from timestamptz NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  counts jsonb NOT NULL DEFAULT '{"fetched":0,"new":0,"duplicates":0,"skippedByLicence":0,"skippedByRobots":0,"proposed":0,"failed":0}',
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  effects_committed boolean NOT NULL DEFAULT false,
  error_code text NULL CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.]{1,80}$'),
  lease_owner text NULL CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 120),
  lease_token bigint NOT NULL DEFAULT 0,
  leased_until timestamptz NULL,
  CONSTRAINT pipeline_run_dry CHECK ((trigger = 'dry_run') = dry_run AND (NOT dry_run OR NOT effects_committed)),
  CONSTRAINT pipeline_run_started CHECK (state <> 'running' OR started_at IS NOT NULL),
  CONSTRAINT pipeline_run_finished CHECK (NOT (state = ANY (trustwork.pipelines_finished_states())) OR finished_at IS NOT NULL),
  CONSTRAINT pipeline_run_actor CHECK (CASE WHEN trigger IN ('manual', 'dry_run', 'backfill') THEN triggered_by IS NOT NULL
    WHEN trigger = 'schedule' THEN schedule_id IS NOT NULL AND due_at IS NOT NULL WHEN trigger = 'retry' THEN retry_of IS NOT NULL ELSE true END),
  CONSTRAINT pipeline_run_backfill CHECK ((trigger = 'backfill') = (backfill_from IS NOT NULL))
);
-- One scheduled run per due time: the scheduler can tick twice without queueing twice.
CREATE UNIQUE INDEX pipeline_run_schedule_due ON trustwork.pipeline_run (schedule_id, due_at) WHERE trigger = 'schedule';
CREATE INDEX pipeline_run_queue_idx ON trustwork.pipeline_run (state, queued_at) WHERE state IN ('queued', 'running');
CREATE INDEX pipeline_run_pipeline_idx ON trustwork.pipeline_run (pipeline_id, queued_at);

-- External effects of runs, keyed by pipeline and effect key (for example `touch:<recipient>:<purpose>:<n>`).
CREATE TABLE trustwork.pipeline_effect (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  pipeline_id uuid NOT NULL REFERENCES trustwork.pipeline (id),
  run_id uuid NOT NULL REFERENCES trustwork.pipeline_run (id),
  effect_key text NOT NULL CHECK (effect_key ~ '^[a-z][a-z0-9_.:-]{2,200}$'),
  kind text NOT NULL CHECK (kind IN ('outreach_touch', 'notification', 'model_call', 'other')),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'succeeded', 'failed', 'unknown')),
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  UNIQUE (pipeline_id, effect_key)
);

CREATE TABLE trustwork.pipeline_alert (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  pipeline_id uuid NOT NULL REFERENCES trustwork.pipeline (id),
  rule text NOT NULL CHECK (rule IN ('failure_streak', 'zero_items_streak', 'cost_threshold', 'duration_exceeded', 'source_changed', 'budget_exhausted')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved')),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 500),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid NULL REFERENCES trustwork.person (id),
  resolved_by uuid NULL REFERENCES trustwork.person (id)
);
CREATE UNIQUE INDEX pipeline_alert_open ON trustwork.pipeline_alert (pipeline_id, rule) WHERE state <> 'resolved';

-- 2. Guards for every writer ------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.pipelines_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF OLD.state = ANY (trustwork.pipelines_finished_states()) THEN
    RAISE EXCEPTION 'a finished run never changes' USING ERRCODE = 'check_violation', HINT = 'pipelines.run_finished';
  END IF;
  IF NEW.state <> OLD.state AND NOT trustwork.pipelines_transition_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'run cannot move from % to %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'pipelines.bad_transition';
  END IF;
  IF (NEW.pipeline_id, NEW.pipeline_version_id, NEW.hub_id, NEW.trigger, NEW.dry_run, NEW.retry_of, NEW.attempt)
     IS DISTINCT FROM (OLD.pipeline_id, OLD.pipeline_version_id, OLD.hub_id, OLD.trigger, OLD.dry_run, OLD.retry_of, OLD.attempt) THEN
    RAISE EXCEPTION 'a run keeps the version and trigger it was queued with' USING ERRCODE = 'check_violation', HINT = 'pipelines.run_identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pipeline_run_guard BEFORE UPDATE ON trustwork.pipeline_run FOR EACH ROW EXECUTE FUNCTION trustwork.pipelines_run_guard();

CREATE FUNCTION trustwork.pipelines_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  -- A version's content is fixed when drafted: editing creates a new version.
  IF (NEW.pipeline_id, NEW.hub_id, NEW.version, NEW.name, NEW.source_ids, NEW.dataset_id, NEW.steps, NEW.automation_level, NEW.drafted_by)
     IS DISTINCT FROM (OLD.pipeline_id, OLD.hub_id, OLD.version, OLD.name, OLD.source_ids, OLD.dataset_id, OLD.steps, OLD.automation_level, OLD.drafted_by) THEN
    RAISE EXCEPTION 'a pipeline version is immutable; draft a new version' USING ERRCODE = 'check_violation', HINT = 'pipelines.version_immutable';
  END IF;
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'a superseded version never changes' USING ERRCODE = 'check_violation', HINT = 'pipelines.version_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pipeline_version_guard BEFORE UPDATE ON trustwork.pipeline_version FOR EACH ROW EXECUTE FUNCTION trustwork.pipelines_version_guard();

CREATE FUNCTION trustwork.pipelines_effect_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  -- An effect's identity is fixed; an outcome moves only out of `pending`, and `unknown` only to a confirmed outcome.
  IF (NEW.pipeline_id, NEW.run_id, NEW.effect_key, NEW.kind, NEW.hub_id) IS DISTINCT FROM (OLD.pipeline_id, OLD.run_id, OLD.effect_key, OLD.kind, OLD.hub_id)
     OR (OLD.outcome IN ('succeeded', 'failed') AND NEW.outcome <> OLD.outcome) THEN
    RAISE EXCEPTION 'an effect record is append-only' USING ERRCODE = 'check_violation', HINT = 'pipelines.effect_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pipeline_effect_guard BEFORE UPDATE ON trustwork.pipeline_effect FOR EACH ROW EXECUTE FUNCTION trustwork.pipelines_effect_guard();
CREATE TRIGGER pipeline_effect_no_delete BEFORE DELETE ON trustwork.pipeline_effect FOR EACH ROW EXECUTE FUNCTION trustwork.pipelines_effect_guard();

-- 3. Staff commands ---------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.pipelines_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;

CREATE FUNCTION trustwork.pipelines_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL
    AND trustwork.admin_has_any_permission(ARRAY['admin.pipelines.read', 'admin.pipelines.edit', 'admin.pipelines.activate', 'admin.pipelines.run', 'admin.pipelines.pause'], NULL, p_hub)
$$;

CREATE FUNCTION trustwork.pipelines_create(p_ctx jsonb, p_hub uuid, p_kind text, p_name text) RETURNS trustwork.pipeline
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.edit'], p_hub);
  v_row trustwork.pipeline%ROWTYPE;
BEGIN
  INSERT INTO trustwork.pipeline (hub_id, kind, name, created_by) VALUES (p_hub, p_kind, p_name, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'pipeline.created', 'pipeline', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Drafts the next version. The contract rules (review queue, model routes, ingestion sources) are checked by the API
-- before this call; the database keeps the step vocabulary, the immutability and the activation rules.
CREATE FUNCTION trustwork.pipelines_draft_version(p_ctx jsonb, p_pipeline uuid, p_input jsonb) RETURNS trustwork.pipeline_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_pipeline trustwork.pipeline%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.pipeline_version%ROWTYPE;
BEGIN
  SELECT * INTO v_pipeline FROM trustwork.pipeline WHERE id = p_pipeline FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such pipeline' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.edit'], v_pipeline.hub_id);
  INSERT INTO trustwork.pipeline_version (pipeline_id, hub_id, version, name, source_ids, dataset_id, steps, automation_level, budget_id, drafted_by)
  VALUES (p_pipeline, v_pipeline.hub_id, coalesce((SELECT max(version) FROM trustwork.pipeline_version WHERE pipeline_id = p_pipeline), 0) + 1,
    p_input ->> 'name', ARRAY(SELECT jsonb_array_elements_text(coalesce(p_input -> 'sourceIds', '[]'::jsonb))::uuid),
    NULLIF(p_input ->> 'datasetId', '')::uuid, p_input -> 'steps', p_input ->> 'automationLevel', NULLIF(p_input ->> 'budgetId', '')::uuid, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'pipeline.version_drafted', 'pipeline_version', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A person other than the drafter activates a draft; the previously active version is superseded atomically.
CREATE FUNCTION trustwork.pipelines_activate_version(p_ctx jsonb, p_version uuid) RETURNS trustwork.pipeline_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_version trustwork.pipeline_version%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.pipeline_version%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM trustwork.pipeline_version WHERE id = p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  -- Serialize activations of one pipeline before reading its current state.
  PERFORM 1 FROM trustwork.pipeline WHERE id = v_version.pipeline_id FOR UPDATE;
  SELECT * INTO v_version FROM trustwork.pipeline_version WHERE id = p_version FOR UPDATE;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.activate'], v_version.hub_id);
  IF v_version.status <> 'draft' THEN RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = 'check_violation', HINT = 'pipelines.not_draft'; END IF;
  IF v_version.drafted_by = v_actor.person_id THEN
    RAISE EXCEPTION 'the drafter never activates their own version' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
  END IF;
  IF v_version.budget_id IS NULL THEN RAISE EXCEPTION 'an active pipeline names a spending cap' USING ERRCODE = 'check_violation', HINT = 'pipelines.cap_required'; END IF;
  UPDATE trustwork.pipeline_version SET status = 'superseded' WHERE pipeline_id = v_version.pipeline_id AND status IN ('active', 'paused');
  UPDATE trustwork.pipeline_version SET status = 'active', activated_by = v_actor.person_id, activated_at = clock_timestamp() WHERE id = p_version RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'pipeline.version_activated', 'pipeline_version', v_row.id, to_jsonb(v_version), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Creates or replaces the schedule; every edit is a new revision (expected revision 0 creates it).
CREATE FUNCTION trustwork.pipelines_set_schedule(p_ctx jsonb, p_pipeline uuid, p_expected_revision integer, p_input jsonb) RETURNS trustwork.pipeline_schedule
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_pipeline trustwork.pipeline%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_before trustwork.pipeline_schedule%ROWTYPE;
  v_row trustwork.pipeline_schedule%ROWTYPE;
BEGIN
  SELECT * INTO v_pipeline FROM trustwork.pipeline WHERE id = p_pipeline FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such pipeline' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.edit'], v_pipeline.hub_id);
  SELECT * INTO v_before FROM trustwork.pipeline_schedule WHERE pipeline_id = p_pipeline FOR UPDATE;
  IF coalesce(v_before.revision, 0) <> p_expected_revision THEN
    RAISE EXCEPTION 'the schedule changed' USING ERRCODE = 'serialization_failure', HINT = 'validation.revision_conflict';
  END IF;
  INSERT INTO trustwork.pipeline_schedule (pipeline_id, hub_id, cron, time_zone, windows, jitter_seconds, quotas, retry, concurrency, alerts, updated_by)
  VALUES (p_pipeline, v_pipeline.hub_id, p_input ->> 'cron', p_input ->> 'timeZone', coalesce(p_input -> 'windows', '[]'), coalesce((p_input ->> 'jitterSeconds')::int, 0),
    p_input -> 'quotas', p_input -> 'retry', coalesce((p_input ->> 'concurrency')::int, 1), coalesce(p_input -> 'alerts', '[]'), v_actor.person_id)
  ON CONFLICT (pipeline_id) DO UPDATE SET cron = EXCLUDED.cron, time_zone = EXCLUDED.time_zone, windows = EXCLUDED.windows, jitter_seconds = EXCLUDED.jitter_seconds,
    quotas = EXCLUDED.quotas, retry = EXCLUDED.retry, concurrency = EXCLUDED.concurrency, alerts = EXCLUDED.alerts, updated_by = EXCLUDED.updated_by,
    updated_at = clock_timestamp(), revision = trustwork.pipeline_schedule.revision + 1
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'pipeline.schedule_set', 'pipeline_schedule', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Pause records who and why; resume needs a person and restarts at the next due time (no burst of missed runs).
CREATE FUNCTION trustwork.pipelines_pause_schedule(p_ctx jsonb, p_schedule uuid, p_expected_revision integer, p_pause boolean, p_reason text) RETURNS trustwork.pipeline_schedule
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.pipeline_schedule%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.pipeline_schedule%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.pipeline_schedule WHERE id = p_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such schedule' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.pause'], v_before.hub_id);
  IF v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the schedule changed' USING ERRCODE = 'serialization_failure', HINT = 'validation.revision_conflict';
  END IF;
  UPDATE trustwork.pipeline_schedule SET paused = p_pause, paused_by = CASE WHEN p_pause THEN v_actor.person_id END,
    paused_reason = CASE WHEN p_pause THEN p_reason END, paused_automatically = false,
    last_due_at = CASE WHEN p_pause THEN last_due_at ELSE clock_timestamp() END,
    revision = revision + 1, updated_by = v_actor.person_id, updated_at = clock_timestamp()
  WHERE id = p_schedule RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN p_pause THEN 'pipeline.schedule_paused' ELSE 'pipeline.schedule_resumed' END,
    'pipeline_schedule', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.pipelines_set_role_cap(p_ctx jsonb, p_hub uuid, p_role text, p_currency text, p_daily_cap_minor bigint) RETURNS trustwork.pipeline_role_cap
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.activate'], p_hub);
  v_row trustwork.pipeline_role_cap%ROWTYPE;
BEGIN
  INSERT INTO trustwork.pipeline_role_cap (hub_id, role, currency, daily_cap_minor, updated_by) VALUES (p_hub, p_role, p_currency, p_daily_cap_minor, v_actor.person_id)
  ON CONFLICT (hub_id, role) DO UPDATE SET currency = EXCLUDED.currency, daily_cap_minor = EXCLUDED.daily_cap_minor, updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'pipeline.role_cap_set', 'pipeline_role_cap', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A person starts a manual, dry or backfill run of the active version.
CREATE FUNCTION trustwork.pipelines_start_run(p_ctx jsonb, p_version uuid, p_trigger text, p_backfill_from timestamptz) RETURNS trustwork.pipeline_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_version trustwork.pipeline_version%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.pipeline_run%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM trustwork.pipeline_version WHERE id = p_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.run'], v_version.hub_id);
  IF p_trigger NOT IN ('manual', 'dry_run', 'backfill') THEN
    RAISE EXCEPTION 'a person starts a manual, dry or backfill run' USING ERRCODE = 'check_violation', HINT = 'pipelines.bad_trigger';
  END IF;
  -- A dry run may test a draft; real runs use the active version.
  IF p_trigger <> 'dry_run' AND v_version.status <> 'active' THEN
    RAISE EXCEPTION 'only the active version runs' USING ERRCODE = 'check_violation', HINT = 'pipelines.not_active';
  END IF;
  IF p_trigger = 'dry_run' AND v_version.status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'a dry run tests a draft or the active version' USING ERRCODE = 'check_violation', HINT = 'pipelines.not_active';
  END IF;
  INSERT INTO trustwork.pipeline_run (hub_id, pipeline_id, pipeline_version_id, trigger, dry_run, triggered_by, backfill_from)
  VALUES (v_version.hub_id, v_version.pipeline_id, p_version, p_trigger, p_trigger = 'dry_run', v_actor.person_id, CASE WHEN p_trigger = 'backfill' THEN p_backfill_from END)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'pipeline.run_started', 'pipeline_run', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A person cancels a queued run, or a running one (the worker stops at the next step boundary).
CREATE FUNCTION trustwork.pipelines_cancel_run(p_ctx jsonb, p_run uuid) RETURNS trustwork.pipeline_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.pipeline_run%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.pipeline_run%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.pipeline_run WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such run' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.run'], v_before.hub_id);
  IF v_before.state NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'the run has finished' USING ERRCODE = 'check_violation', HINT = 'pipelines.run_finished';
  END IF;
  UPDATE trustwork.pipeline_run SET state = 'cancelled', finished_at = clock_timestamp(), lease_owner = NULL, leased_until = NULL, lease_token = lease_token + 1,
    effects_committed = (NOT dry_run AND EXISTS (SELECT 1 FROM trustwork.pipeline_effect e WHERE e.run_id = p_run))
  WHERE id = p_run RETURNING * INTO v_row;
  -- Effects this run reserved but did not settle stay unknown: they are never run again.
  UPDATE trustwork.pipeline_effect SET outcome = 'unknown' WHERE run_id = p_run AND outcome = 'pending';
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'pipeline.run_cancelled', 'pipeline_run', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.pipelines_decide_alert(p_ctx jsonb, p_alert uuid, p_state text) RETURNS trustwork.pipeline_alert
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.pipeline_alert%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.pipeline_alert%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.pipeline_alert WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such alert' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found'; END IF;
  v_actor := trustwork.pipelines_staff(p_ctx, ARRAY['admin.pipelines.edit', 'admin.pipelines.pause'], v_before.hub_id);
  IF p_state NOT IN ('acknowledged', 'resolved') OR v_before.state = 'resolved' THEN
    RAISE EXCEPTION 'an open alert is acknowledged or resolved' USING ERRCODE = 'check_violation', HINT = 'pipelines.alert_closed';
  END IF;
  UPDATE trustwork.pipeline_alert SET state = p_state,
    acknowledged_by = coalesce(acknowledged_by, v_actor.person_id), resolved_by = CASE WHEN p_state = 'resolved' THEN v_actor.person_id END
  WHERE id = p_alert RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'pipeline.alert_' || p_state, 'pipeline_alert', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- 4. Worker functions -------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.pipelines_kill_engaged(p_hub uuid, p_pipeline uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged'
    AND ((k.scope_kind = 'pipeline' AND k.pipeline_id = p_pipeline) OR (k.scope_kind = 'node')))
$$;

CREATE FUNCTION trustwork.pipelines_raise_alert(p_hub uuid, p_pipeline uuid, p_rule text, p_detail text) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  INSERT INTO trustwork.pipeline_alert (hub_id, pipeline_id, rule, detail) VALUES (p_hub, p_pipeline, p_rule, p_detail)
  ON CONFLICT (pipeline_id, rule) WHERE state <> 'resolved' DO UPDATE SET occurrences = trustwork.pipeline_alert.occurrences + 1, last_at = clock_timestamp(), detail = EXCLUDED.detail;
END $$;

-- The roles a version's steps are bound to (`settings.role`), in order.
CREATE FUNCTION trustwork.pipelines_version_roles(p_version uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT s #>> '{settings,role}') FILTER (WHERE s #>> '{settings,role}' IS NOT NULL), '{}')
  FROM trustwork.pipeline_version v, jsonb_array_elements(v.steps) s WHERE v.id = p_version
$$;

CREATE FUNCTION trustwork.pipelines_role_exhausted(p_hub uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.pipeline_role_cap c WHERE c.hub_id = p_hub AND c.role = ANY (p_roles)
    AND c.spent_day = current_date AND c.spent_minor >= c.daily_cap_minor)
$$;

-- Queues the run of a schedule for one due time, or records it `skipped_window` when the due time is outside every
-- window (the worker evaluates cron and windows in the schedule's time zone). Idempotent per (schedule, due time).
CREATE FUNCTION trustwork.pipelines_enqueue_scheduled(p_schedule uuid, p_due_at timestamptz, p_in_window boolean) RETURNS trustwork.pipeline_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_schedule trustwork.pipeline_schedule%ROWTYPE;
  v_version trustwork.pipeline_version%ROWTYPE;
  v_row trustwork.pipeline_run%ROWTYPE;
BEGIN
  SELECT * INTO v_schedule FROM trustwork.pipeline_schedule WHERE id = p_schedule FOR UPDATE;
  IF NOT FOUND OR v_schedule.paused THEN RETURN NULL; END IF;
  SELECT * INTO v_version FROM trustwork.pipeline_version WHERE pipeline_id = v_schedule.pipeline_id AND status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_row FROM trustwork.pipeline_run WHERE schedule_id = p_schedule AND due_at = p_due_at AND trigger = 'schedule';
  IF FOUND THEN RETURN v_row; END IF;
  INSERT INTO trustwork.pipeline_run (hub_id, pipeline_id, pipeline_version_id, trigger, dry_run, schedule_id, due_at)
  VALUES (v_schedule.hub_id, v_schedule.pipeline_id, v_version.id, 'schedule', false, p_schedule, p_due_at) RETURNING * INTO v_row;
  IF NOT p_in_window THEN
    UPDATE trustwork.pipeline_run SET state = 'skipped_window', finished_at = clock_timestamp() WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  UPDATE trustwork.pipeline_schedule SET last_due_at = greatest(coalesce(last_due_at, p_due_at), p_due_at) WHERE id = p_schedule;
  RETURN v_row;
END $$;

-- Leases the oldest runnable queued run. Kill switches and exhausted role caps finish queued runs here, before any
-- step: `stopped_by_kill_switch` or `skipped_budget`. Concurrency per pipeline follows its schedule (1 without one).
CREATE FUNCTION trustwork.pipelines_lease_run(p_owner text, p_lease_seconds integer) RETURNS SETOF trustwork.pipeline_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE;
  v_limit integer;
BEGIN
  FOR v_run IN SELECT * FROM trustwork.pipeline_run WHERE state = 'queued' ORDER BY queued_at, id FOR UPDATE SKIP LOCKED LOOP
    IF trustwork.pipelines_kill_engaged(v_run.hub_id, v_run.pipeline_id) THEN
      UPDATE trustwork.pipeline_run SET state = 'stopped_by_kill_switch', finished_at = clock_timestamp(), error_code = 'pipelines.kill_switch' WHERE id = v_run.id;
      CONTINUE;
    END IF;
    IF NOT v_run.dry_run AND trustwork.pipelines_role_exhausted(v_run.hub_id, trustwork.pipelines_version_roles(v_run.pipeline_version_id)) THEN
      UPDATE trustwork.pipeline_run SET state = 'skipped_budget', finished_at = clock_timestamp(), error_code = 'pipelines.role_cap_exhausted' WHERE id = v_run.id;
      PERFORM trustwork.pipelines_raise_alert(v_run.hub_id, v_run.pipeline_id, 'budget_exhausted', 'a role cap of this pipeline is exhausted for today');
      CONTINUE;
    END IF;
    SELECT coalesce((SELECT concurrency FROM trustwork.pipeline_schedule WHERE pipeline_id = v_run.pipeline_id), 1) INTO v_limit;
    IF (SELECT count(*) FROM trustwork.pipeline_run WHERE pipeline_id = v_run.pipeline_id AND state = 'running') >= v_limit THEN CONTINUE; END IF;
    UPDATE trustwork.pipeline_run SET state = 'running', started_at = clock_timestamp(), lease_owner = p_owner, lease_token = lease_token + 1,
      leased_until = clock_timestamp() + make_interval(secs => greatest(p_lease_seconds, 5))
    WHERE id = v_run.id RETURNING * INTO v_run;
    RETURN NEXT v_run;
    RETURN;
  END LOOP;
END $$;

-- The current run under its fencing token, locked; a stale token or a finished run refuses.
CREATE FUNCTION trustwork.pipelines_fenced(p_run uuid, p_token bigint) RETURNS trustwork.pipeline_run
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM trustwork.pipeline_run WHERE id = p_run FOR UPDATE;
  IF NOT FOUND OR v_run.state <> 'running' OR v_run.lease_token <> p_token THEN
    RAISE EXCEPTION 'stale run lease' USING ERRCODE = 'serialization_failure', HINT = 'pipelines.stale_lease';
  END IF;
  RETURN v_run;
END $$;

-- At every step boundary: extend the lease and say whether to continue. A kill switch ends the run
-- `stopped_by_kill_switch`; a cancellation was already recorded by the person and refuses through the fence.
CREATE FUNCTION trustwork.pipelines_step_boundary(p_run uuid, p_token bigint, p_lease_seconds integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE := trustwork.pipelines_fenced(p_run, p_token);
BEGIN
  IF trustwork.pipelines_kill_engaged(v_run.hub_id, v_run.pipeline_id) THEN
    UPDATE trustwork.pipeline_run SET state = 'stopped_by_kill_switch', finished_at = clock_timestamp(), error_code = 'pipelines.kill_switch',
      effects_committed = (NOT dry_run AND EXISTS (SELECT 1 FROM trustwork.pipeline_effect e WHERE e.run_id = p_run)), lease_owner = NULL, leased_until = NULL
    WHERE id = p_run;
    UPDATE trustwork.pipeline_effect SET outcome = 'unknown' WHERE run_id = p_run AND outcome = 'pending';
    RETURN 'stop';
  END IF;
  UPDATE trustwork.pipeline_run SET leased_until = clock_timestamp() + make_interval(secs => greatest(p_lease_seconds, 5)) WHERE id = p_run;
  RETURN 'continue';
END $$;

-- Reserves an external effect before it runs. `dry` for a dry run (nothing is recorded or sent); `stop` under a kill
-- switch; `skip` when the key already exists, whatever its outcome (never repeated, not even by a retry run); `proceed`
-- otherwise, with the effect recorded as pending; the caller commits that before the effect runs.
CREATE FUNCTION trustwork.pipelines_reserve_effect(p_run uuid, p_token bigint, p_effect_key text, p_kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE := trustwork.pipelines_fenced(p_run, p_token);
  v_existing trustwork.pipeline_effect%ROWTYPE;
BEGIN
  IF v_run.dry_run THEN RETURN 'dry'; END IF;
  IF trustwork.pipelines_kill_engaged(v_run.hub_id, v_run.pipeline_id) THEN RETURN 'stop'; END IF;
  SELECT * INTO v_existing FROM trustwork.pipeline_effect WHERE pipeline_id = v_run.pipeline_id AND effect_key = p_effect_key FOR UPDATE;
  -- Any recorded attempt under the key stops a repeat; a confirmed failure is not resent automatically either: a person
  -- decides a new attempt, under a new key.
  IF FOUND THEN RETURN 'skip'; END IF;
  INSERT INTO trustwork.pipeline_effect (hub_id, pipeline_id, run_id, effect_key, kind) VALUES (v_run.hub_id, v_run.pipeline_id, p_run, p_effect_key, p_kind);
  RETURN 'proceed';
END $$;

CREATE FUNCTION trustwork.pipelines_settle_effect(p_run uuid, p_token bigint, p_effect_key text, p_outcome text, p_cost_minor bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE := trustwork.pipelines_fenced(p_run, p_token);
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'an effect settles as succeeded, failed or unknown' USING ERRCODE = 'check_violation', HINT = 'pipelines.bad_outcome';
  END IF;
  UPDATE trustwork.pipeline_effect SET outcome = p_outcome, cost_minor = greatest(p_cost_minor, 0), settled_at = clock_timestamp()
  WHERE run_id = p_run AND pipeline_id = v_run.pipeline_id AND effect_key = p_effect_key AND outcome = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'no pending effect under this key for this run' USING ERRCODE = 'no_data_found', HINT = 'pipelines.no_effect'; END IF;
  UPDATE trustwork.pipeline_run SET cost_minor = cost_minor + greatest(p_cost_minor, 0), effects_committed = true WHERE id = p_run;
END $$;

-- Charges a role before a paid step. A dry run is never charged. `exhausted` when the charge would pass the role's
-- daily cap: the caller stops paid steps and finishes the run `skipped_budget`.
CREATE FUNCTION trustwork.pipelines_charge_role(p_run uuid, p_token bigint, p_role text, p_amount_minor bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE := trustwork.pipelines_fenced(p_run, p_token);
  v_cap trustwork.pipeline_role_cap%ROWTYPE;
BEGIN
  IF v_run.dry_run THEN RETURN 'dry'; END IF;
  SELECT * INTO v_cap FROM trustwork.pipeline_role_cap WHERE hub_id = v_run.hub_id AND role = p_role FOR UPDATE;
  IF NOT FOUND THEN RETURN 'exhausted'; END IF; -- an uncapped role has no paid steps
  IF v_cap.spent_day <> current_date THEN
    UPDATE trustwork.pipeline_role_cap SET spent_minor = 0, spent_day = current_date WHERE id = v_cap.id RETURNING * INTO v_cap;
  END IF;
  IF v_cap.spent_minor + greatest(p_amount_minor, 0) > v_cap.daily_cap_minor THEN
    PERFORM trustwork.pipelines_raise_alert(v_run.hub_id, v_run.pipeline_id, 'budget_exhausted', 'the ' || p_role || ' role cap is exhausted for today');
    RETURN 'exhausted';
  END IF;
  UPDATE trustwork.pipeline_role_cap SET spent_minor = spent_minor + greatest(p_amount_minor, 0) WHERE id = v_cap.id;
  RETURN 'charged';
END $$;

-- Finishes a running run under its fence: counts, error and the alert rules (failure and zero-item streaks).
CREATE FUNCTION trustwork.pipelines_finish_run(p_run uuid, p_token bigint, p_state text, p_counts jsonb, p_error text) RETURNS trustwork.pipeline_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE := trustwork.pipelines_fenced(p_run, p_token);
  v_alerts jsonb;
  v_rule jsonb;
  v_streak integer;
BEGIN
  IF p_state NOT IN ('succeeded', 'partially_succeeded', 'failed', 'skipped_budget') THEN
    RAISE EXCEPTION 'the worker finishes a run as succeeded, partially succeeded, failed or skipped for budget' USING ERRCODE = 'check_violation', HINT = 'pipelines.bad_transition';
  END IF;
  UPDATE trustwork.pipeline_effect SET outcome = 'unknown' WHERE run_id = p_run AND outcome = 'pending';
  UPDATE trustwork.pipeline_run SET state = p_state, finished_at = clock_timestamp(), counts = coalesce(p_counts, counts), error_code = p_error,
    effects_committed = (NOT dry_run AND EXISTS (SELECT 1 FROM trustwork.pipeline_effect e WHERE e.run_id = p_run)),
    lease_owner = NULL, leased_until = NULL
  WHERE id = p_run RETURNING * INTO v_run;
  SELECT alerts INTO v_alerts FROM trustwork.pipeline_schedule WHERE pipeline_id = v_run.pipeline_id;
  FOR v_rule IN SELECT * FROM jsonb_array_elements(coalesce(v_alerts, '[]')) LOOP
    IF v_rule ->> 'kind' = 'failure_streak' THEN
      SELECT count(*) INTO v_streak FROM (SELECT state FROM trustwork.pipeline_run WHERE pipeline_id = v_run.pipeline_id AND NOT dry_run
        AND state = ANY (trustwork.pipelines_finished_states()) AND state NOT IN ('skipped_window') ORDER BY finished_at DESC LIMIT (v_rule ->> 'threshold')::int) r WHERE r.state = 'failed';
      IF v_streak >= (v_rule ->> 'threshold')::int THEN PERFORM trustwork.pipelines_raise_alert(v_run.hub_id, v_run.pipeline_id, 'failure_streak', v_streak || ' failed runs in a row'); END IF;
    ELSIF v_rule ->> 'kind' = 'zero_items_streak' THEN
      SELECT count(*) INTO v_streak FROM (SELECT counts FROM trustwork.pipeline_run WHERE pipeline_id = v_run.pipeline_id AND NOT dry_run
        AND state IN ('succeeded', 'partially_succeeded') ORDER BY finished_at DESC LIMIT (v_rule ->> 'threshold')::int) r WHERE (r.counts ->> 'fetched')::int = 0;
      IF v_streak >= (v_rule ->> 'threshold')::int THEN PERFORM trustwork.pipelines_raise_alert(v_run.hub_id, v_run.pipeline_id, 'zero_items_streak', 'the source returned no items for ' || v_streak || ' runs'); END IF;
    END IF;
  END LOOP;
  RETURN v_run;
END $$;

-- A running run whose lease expired (worker death): it fails with `pipelines.lease_expired`; its pending effects
-- become unknown and are never run again. A retry is a new run linked to it.
CREATE FUNCTION trustwork.pipelines_expire_leases() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE;
  v_n integer := 0;
BEGIN
  FOR v_run IN SELECT * FROM trustwork.pipeline_run WHERE state = 'running' AND leased_until < clock_timestamp() FOR UPDATE SKIP LOCKED LOOP
    UPDATE trustwork.pipeline_effect SET outcome = 'unknown' WHERE run_id = v_run.id AND outcome = 'pending';
    UPDATE trustwork.pipeline_run SET state = 'failed', finished_at = clock_timestamp(), error_code = 'pipelines.lease_expired', lease_owner = NULL, leased_until = NULL,
      lease_token = lease_token + 1, effects_committed = (NOT dry_run AND EXISTS (SELECT 1 FROM trustwork.pipeline_effect e WHERE e.run_id = v_run.id))
    WHERE id = v_run.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Queues the retry of a failed run as a new run, within the schedule's retry policy (attempts).
CREATE FUNCTION trustwork.pipelines_queue_retry(p_run uuid) RETURNS trustwork.pipeline_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_failed trustwork.pipeline_run%ROWTYPE;
  v_max integer;
  v_row trustwork.pipeline_run%ROWTYPE;
BEGIN
  SELECT * INTO v_failed FROM trustwork.pipeline_run WHERE id = p_run FOR UPDATE;
  IF NOT FOUND OR v_failed.state <> 'failed' OR v_failed.dry_run THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM trustwork.pipeline_run WHERE retry_of = p_run) THEN RETURN NULL; END IF;
  SELECT coalesce((retry ->> 'maxAttempts')::int, 1) INTO v_max FROM trustwork.pipeline_schedule WHERE pipeline_id = v_failed.pipeline_id;
  IF v_failed.attempt >= coalesce(v_max, 1) THEN RETURN NULL; END IF;
  INSERT INTO trustwork.pipeline_run (hub_id, pipeline_id, pipeline_version_id, trigger, dry_run, attempt, retry_of, triggered_by, schedule_id, due_at, backfill_from)
  VALUES (v_failed.hub_id, v_failed.pipeline_id, v_failed.pipeline_version_id, 'retry', false, v_failed.attempt + 1, p_run, v_failed.triggered_by, NULL, NULL, NULL)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Failed real runs that have no retry yet (the worker asks pipelines_queue_retry, which applies the retry policy and
-- the backoff from the schedule).
CREATE FUNCTION trustwork.pipelines_retry_candidates(p_limit integer) RETURNS TABLE (run_id uuid, finished_at timestamptz, attempt integer, retry jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, r.finished_at, r.attempt, s.retry FROM trustwork.pipeline_run r LEFT JOIN trustwork.pipeline_schedule s ON s.pipeline_id = r.pipeline_id
  WHERE r.state = 'failed' AND NOT r.dry_run AND NOT EXISTS (SELECT 1 FROM trustwork.pipeline_run n WHERE n.retry_of = r.id)
    AND r.attempt < coalesce((s.retry ->> 'maxAttempts')::int, 1)
  ORDER BY r.finished_at, r.id LIMIT least(greatest(p_limit, 1), 200)
$$;

-- A robots, terms or licence change of a source pauses every schedule that reads it and raises an alert; resuming
-- needs a person (pipelines_pause_schedule with p_pause false).
CREATE FUNCTION trustwork.pipelines_source_changed(p_source uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_schedule trustwork.pipeline_schedule%ROWTYPE;
  v_n integer := 0;
BEGIN
  IF p_reason NOT IN ('robots', 'terms', 'licence', 'error_streak', 'takedown') THEN
    RAISE EXCEPTION 'a source changes its robots, terms or licence, or fails or is taken down' USING ERRCODE = 'check_violation', HINT = 'pipelines.bad_reason';
  END IF;
  FOR v_schedule IN SELECT s.* FROM trustwork.pipeline_schedule s JOIN trustwork.pipeline_version v ON v.pipeline_id = s.pipeline_id AND v.status = 'active'
    WHERE p_source = ANY (v.source_ids) AND NOT s.paused ORDER BY s.id FOR UPDATE OF s LOOP
    UPDATE trustwork.pipeline_schedule SET paused = true, paused_automatically = true, paused_by = NULL, paused_reason = 'source changed: ' || p_reason,
      revision = revision + 1, updated_at = clock_timestamp() WHERE id = v_schedule.id;
    PERFORM trustwork.pipelines_raise_alert(v_schedule.hub_id, v_schedule.pipeline_id, 'source_changed', 'a source of this pipeline changed (' || p_reason || '); a person resumes it after a fresh check');
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Active, unpaused schedules for the scheduler (worker): the cron is evaluated in the worker.
CREATE FUNCTION trustwork.pipelines_due_schedules() RETURNS SETOF trustwork.pipeline_schedule
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.* FROM trustwork.pipeline_schedule s
  WHERE NOT s.paused AND EXISTS (SELECT 1 FROM trustwork.pipeline_version v WHERE v.pipeline_id = s.pipeline_id AND v.status = 'active')
  ORDER BY s.id
$$;

-- The version a leased run executes (worker).
CREATE FUNCTION trustwork.pipelines_run_version(p_run uuid, p_token bigint) RETURNS trustwork.pipeline_version
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_run trustwork.pipeline_run%ROWTYPE;
  v_row trustwork.pipeline_version%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM trustwork.pipeline_run WHERE id = p_run;
  IF NOT FOUND OR v_run.state <> 'running' OR v_run.lease_token <> p_token THEN
    RAISE EXCEPTION 'stale run lease' USING ERRCODE = 'serialization_failure', HINT = 'pipelines.stale_lease';
  END IF;
  SELECT * INTO v_row FROM trustwork.pipeline_version WHERE id = v_run.pipeline_version_id;
  RETURN v_row;
END $$;

-- 5. Row-level security -----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.pipeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_schedule FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_role_cap ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_role_cap FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_run FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_effect FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.pipeline_alert FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.pipeline AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.pipeline_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.pipeline_schedule AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.pipeline_role_cap AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.pipeline_run AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.pipeline_effect AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.pipeline_alert AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Staff of the hub read everything of its pipelines; nobody else reads anything.
CREATE POLICY pipeline_read ON trustwork.pipeline FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));
CREATE POLICY pipeline_version_read ON trustwork.pipeline_version FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));
CREATE POLICY pipeline_schedule_read ON trustwork.pipeline_schedule FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));
CREATE POLICY pipeline_role_cap_read ON trustwork.pipeline_role_cap FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));
CREATE POLICY pipeline_run_read ON trustwork.pipeline_run FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));
CREATE POLICY pipeline_effect_read ON trustwork.pipeline_effect FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));
CREATE POLICY pipeline_alert_read ON trustwork.pipeline_alert FOR SELECT TO trustwork_app USING (trustwork.pipelines_reader(hub_id));

GRANT SELECT ON trustwork.pipeline, trustwork.pipeline_version, trustwork.pipeline_schedule, trustwork.pipeline_role_cap, trustwork.pipeline_run,
  trustwork.pipeline_effect, trustwork.pipeline_alert TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.pipelines_create(jsonb, uuid, text, text), trustwork.pipelines_draft_version(jsonb, uuid, jsonb), trustwork.pipelines_activate_version(jsonb, uuid),
  trustwork.pipelines_set_schedule(jsonb, uuid, integer, jsonb), trustwork.pipelines_pause_schedule(jsonb, uuid, integer, boolean, text),
  trustwork.pipelines_set_role_cap(jsonb, uuid, text, text, bigint), trustwork.pipelines_start_run(jsonb, uuid, text, timestamptz),
  trustwork.pipelines_cancel_run(jsonb, uuid), trustwork.pipelines_decide_alert(jsonb, uuid, text), trustwork.pipelines_reader(uuid),
  trustwork.pipelines_kinds(), trustwork.pipelines_run_states(), trustwork.pipelines_finished_states(), trustwork.pipelines_transition_allowed(text, text),
  trustwork.pipelines_steps_ok(jsonb)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.pipelines_enqueue_scheduled(uuid, timestamptz, boolean), trustwork.pipelines_lease_run(text, integer), trustwork.pipelines_step_boundary(uuid, bigint, integer),
  trustwork.pipelines_reserve_effect(uuid, bigint, text, text), trustwork.pipelines_settle_effect(uuid, bigint, text, text, bigint),
  trustwork.pipelines_charge_role(uuid, bigint, text, bigint), trustwork.pipelines_finish_run(uuid, bigint, text, jsonb, text), trustwork.pipelines_expire_leases(),
  trustwork.pipelines_queue_retry(uuid), trustwork.pipelines_retry_candidates(integer), trustwork.pipelines_source_changed(uuid, text), trustwork.pipelines_due_schedules(), trustwork.pipelines_run_version(uuid, bigint)
TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- SANC-005: re-screening of every person and company on every newly activated list version (a delta run), weekly (a
-- full safety-net run) and on a compliance officer's request, idempotent per subject and list version and resumable
-- after a crash (ADR 014 decision 12; data model section 24a).
--
-- * A run (screening_rescreen_run) walks every subject (companies, then persons, in id order) in batches; the worker's
--   batch job (apps/worker/src/rescreen) records results and moves the run's cursor in one transaction, so a crash
--   rolls the batch back and the run resumes from the last committed cursor without screening finished subjects
--   again. At most one run is running at a time (a unique index); runs queue behind it.
-- * A delta run first screens the subjects whose names could meet an added or changed entry of the new version (the
--   candidates), then every other subject. A subject already screened against every active version with unchanged
--   names is skipped: that is the idempotency per (subject, list version).
-- * Results go through screening_record_result (SANC-003), except one case recorded here in bulk: a subject whose last
--   result was a `clear` with no match at all, for the same names, matcher version and fuzzy setting, and whose name
--   tokens share nothing with the entries added or changed between the versions it was screened against and the
--   active versions. The worker has matched the subject against those entries (the only ones that can change the
--   outcome); screening_rescreen_record_delta rechecks every other condition after locking the subject's state,
--   records the `clear` against exactly the active versions (the SANC-003 guard still refuses a clear without every
--   active baseline version or while the baseline is stale) and keeps an item naming the versions the proof started
--   from. Nothing is ever recorded as clear because something failed or was not compared.
-- * Items (screening_rescreen_item) are sanctions records: append-only, one per subject and run, never a name.
--   Runs carry counts only (hub cohorts, no per-person view) and are operational records.
--
-- Entry points (SECURITY DEFINER, pinned search_path):
--   worker (trustwork_worker): screening_rescreen_request, screening_rescreen_promote, screening_rescreen_lock,
--     screening_rescreen_subjects, screening_rescreen_versions, screening_rescreen_entries,
--     screening_rescreen_record_delta, screening_rescreen_record_items, screening_rescreen_advance,
--     screening_rescreen_fail, screening_rescreen_watch, screening_rescreen_progress
--   runtime (trustwork_app): screening_rescreen_request_manual (compliance officer of the node under an elevation,
--     audited)
-- The runtime role reads both tables only as a compliance officer or auditor of the node; the worker has no table
-- grant.

-- 1. Runs ---------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_rescreen_run (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('list_version', 'scheduled', 'manual')),
  mode text NOT NULL CHECK (mode IN ('delta', 'full')),
  -- The activated version (delta runs) and the version of the same list it superseded (null for a first version).
  list_version_id uuid NULL REFERENCES trustwork.screening_list_version (id),
  previous_version_id uuid NULL REFERENCES trustwork.screening_list_version (id),
  requested_by uuid NULL REFERENCES trustwork.person (id),
  request_reason text NULL CHECK (length(btrim(request_reason)) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  phase text NOT NULL CHECK (phase IN ('candidates', 'all')),
  cursor_kind text NULL CHECK (cursor_kind IN ('company', 'person')),
  cursor_id uuid NULL,
  blocked_reason text NULL CHECK (blocked_reason IN ('lists_unavailable')),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 600 AND 604800),
  subjects_total integer NOT NULL DEFAULT 0 CHECK (subjects_total >= 0),
  subjects_done integer NOT NULL DEFAULT 0 CHECK (subjects_done >= 0),
  candidates_screened integer NOT NULL DEFAULT 0 CHECK (candidates_screened >= 0),
  screened_full integer NOT NULL DEFAULT 0 CHECK (screened_full >= 0),
  screened_delta integer NOT NULL DEFAULT 0 CHECK (screened_delta >= 0),
  already_current integer NOT NULL DEFAULT 0 CHECK (already_current >= 0),
  verified integer NOT NULL DEFAULT 0 CHECK (verified >= 0),
  outcome_clear integer NOT NULL DEFAULT 0 CHECK (outcome_clear >= 0),
  outcome_possible_match integer NOT NULL DEFAULT 0 CHECK (outcome_possible_match >= 0),
  outcome_insufficient_name integer NOT NULL DEFAULT 0 CHECK (outcome_insufficient_name >= 0),
  outcome_not_screened integer NOT NULL DEFAULT 0 CHECK (outcome_not_screened >= 0),
  matches_opened integer NOT NULL DEFAULT 0 CHECK (matches_opened >= 0),
  batches integer NOT NULL DEFAULT 0 CHECK (batches >= 0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  resumed integer NOT NULL DEFAULT 0 CHECK (resumed >= 0),
  last_error text NULL CHECK (last_error ~ '^[a-z0-9_.:-]{1,120}$'),
  overdue_alerted_at timestamptz NULL,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NULL,
  last_progress_at timestamptz NULL,
  finished_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_rescreen_run_mode CHECK ((trigger = 'list_version') = (mode = 'delta') AND (mode = 'delta') = (list_version_id IS NOT NULL)),
  CONSTRAINT screening_rescreen_run_previous CHECK (mode = 'delta' OR previous_version_id IS NULL),
  CONSTRAINT screening_rescreen_run_full_phase CHECK (mode = 'delta' OR phase = 'all'),
  CONSTRAINT screening_rescreen_run_manual CHECK ((trigger = 'manual') = (requested_by IS NOT NULL) AND (requested_by IS NULL) = (request_reason IS NULL)),
  CONSTRAINT screening_rescreen_run_cursor CHECK ((cursor_kind IS NULL) = (cursor_id IS NULL)),
  CONSTRAINT screening_rescreen_run_started CHECK ((state = 'queued') = (started_at IS NULL)),
  CONSTRAINT screening_rescreen_run_finished CHECK ((state = 'done') = (finished_at IS NOT NULL)),
  CONSTRAINT screening_rescreen_run_progress CHECK (subjects_done <= greatest(subjects_total, subjects_done) AND (state <> 'done' OR blocked_reason IS NULL))
);
-- One delta run per activated version; one unfinished full run; one running run.
CREATE UNIQUE INDEX screening_rescreen_run_version ON trustwork.screening_rescreen_run (list_version_id) WHERE trigger = 'list_version';
CREATE UNIQUE INDEX screening_rescreen_run_one_full ON trustwork.screening_rescreen_run ((true)) WHERE mode = 'full' AND state IN ('queued', 'running', 'failed');
CREATE UNIQUE INDEX screening_rescreen_run_one_running ON trustwork.screening_rescreen_run ((true)) WHERE state = 'running';
CREATE INDEX screening_rescreen_run_queue_idx ON trustwork.screening_rescreen_run (queued_at, id) WHERE state IN ('queued', 'failed');

-- The identity of a run never changes; its state moves queued -> running -> done | failed, failed -> running (resume).
CREATE FUNCTION trustwork.screening_rescreen_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 're-screening runs are never deleted' USING ERRCODE = '23514', HINT = 'screening.record_permanent';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.cursor_kind IS NOT NULL OR NEW.subjects_done <> 0 OR NEW.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'a run starts queued at the beginning' USING ERRCODE = '23514', HINT = 'screening.rescreen_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.trigger <> OLD.trigger OR NEW.mode <> OLD.mode OR NEW.list_version_id IS DISTINCT FROM OLD.list_version_id
     OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_reason IS DISTINCT FROM OLD.request_reason OR NEW.queued_at <> OLD.queued_at OR NEW.window_seconds <> OLD.window_seconds THEN
    RAISE EXCEPTION 'a run keeps its trigger and request' USING ERRCODE = '23514', HINT = 'screening.record_immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state = 'queued' AND NEW.state = 'running') OR (OLD.state = 'running' AND NEW.state IN ('done', 'failed'))
      OR (OLD.state = 'failed' AND NEW.state = 'running')) THEN
    RAISE EXCEPTION 'a run cannot move from % to %', OLD.state, NEW.state USING ERRCODE = '23514', HINT = 'screening.rescreen_transition';
  END IF;
  IF OLD.state = 'done' THEN
    RAISE EXCEPTION 'a finished run is final' USING ERRCODE = '23514', HINT = 'screening.rescreen_transition';
  END IF;
  IF OLD.phase = 'all' AND NEW.phase = 'candidates' THEN
    RAISE EXCEPTION 'a run never goes back to the candidates' USING ERRCODE = '23514', HINT = 'screening.rescreen_transition';
  END IF;
  -- Counters only grow.
  IF NEW.subjects_done < OLD.subjects_done OR NEW.candidates_screened < OLD.candidates_screened OR NEW.screened_full < OLD.screened_full OR NEW.screened_delta < OLD.screened_delta
     OR NEW.already_current < OLD.already_current OR NEW.verified < OLD.verified OR NEW.matches_opened < OLD.matches_opened OR NEW.outcome_clear < OLD.outcome_clear
     OR NEW.outcome_possible_match < OLD.outcome_possible_match OR NEW.outcome_insufficient_name < OLD.outcome_insufficient_name OR NEW.outcome_not_screened < OLD.outcome_not_screened
     OR NEW.batches < OLD.batches OR NEW.failures < OLD.failures OR NEW.resumed < OLD.resumed THEN
    RAISE EXCEPTION 'run counters only grow' USING ERRCODE = '23514', HINT = 'screening.rescreen_counts';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER screening_rescreen_run_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_rescreen_run FOR EACH ROW EXECUTE FUNCTION trustwork.screening_rescreen_run_guard();
CREATE TRIGGER screening_rescreen_run_no_truncate BEFORE TRUNCATE ON trustwork.screening_rescreen_run FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Items (append-only) ------------------------------------------------------------------------------------------------
-- One row per subject a run recorded a result for. `delta` items name the versions the earlier clear was against.
CREATE TABLE trustwork.screening_rescreen_item (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  run_id uuid NOT NULL REFERENCES trustwork.screening_rescreen_run (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  phase text NOT NULL CHECK (phase IN ('candidates', 'all')),
  method text NOT NULL CHECK (method IN ('full', 'delta')),
  result_id uuid NOT NULL UNIQUE REFERENCES trustwork.screening_result (id),
  outcome text NOT NULL CHECK (outcome IN ('clear', 'possible_match', 'insufficient_name', 'not_screened')),
  base_versions uuid[] NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_rescreen_item_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT screening_rescreen_item_delta CHECK ((method = 'delta') = (base_versions IS NOT NULL) AND (method <> 'delta' OR (outcome = 'clear' AND phase = 'all' AND cardinality(base_versions) >= 1)))
);
CREATE UNIQUE INDEX screening_rescreen_item_person ON trustwork.screening_rescreen_item (run_id, subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE UNIQUE INDEX screening_rescreen_item_company ON trustwork.screening_rescreen_item (run_id, subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE TRIGGER screening_rescreen_item_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_rescreen_item FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_rescreen_item_no_truncate BEFORE TRUNCATE ON trustwork.screening_rescreen_item FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Internal helpers (not executable by any login role) -----------------------------------------------------------------
CREATE FUNCTION trustwork.screening_rescreen_serialize() RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtext('trustwork.screening_rescreen'))
$$;
-- A batch job of the run is queued or running (the chain that carries the run forward).
CREATE FUNCTION trustwork.screening_rescreen_in_flight(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.job j WHERE j.kind = 'screening.rescreen_batch' AND j.state IN ('queued', 'leased', 'outcome_unknown') AND j.payload ->> 'runId' = p_run::text)
$$;
CREATE FUNCTION trustwork.screening_rescreen_alert(r trustwork.screening_rescreen_run, p_kind text) RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('screening_rescreen_run', r.id::text, r.revision, 'screening.rescreen_run_alert', jsonb_build_object('runId', r.id, 'trigger', r.trigger, 'alert', p_kind, 'mutable', false))
$$;
CREATE FUNCTION trustwork.screening_rescreen_running(p_run uuid) RETURNS trustwork.screening_rescreen_run
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.screening_rescreen_run WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such re-screening run' USING ERRCODE = 'no_data_found', HINT = 'screening.rescreen_not_found';
  END IF;
  IF r.state <> 'running' THEN
    RAISE EXCEPTION 'the re-screening run is not running' USING ERRCODE = '23514', HINT = 'screening.rescreen_not_running';
  END IF;
  RETURN r;
END $$;
CREATE FUNCTION trustwork.screening_rescreen_subject_count() RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ((SELECT count(*) FROM trustwork.company) + (SELECT count(*) FROM trustwork.person))::integer
$$;

-- 4. Worker entry points ------------------------------------------------------------------------------------------------
-- Asks for a run: `list_version` (one per activated version, from screening.list_version_activated) or `scheduled`
-- (the weekly safety net; answers the unfinished full run when one exists). Idempotent.
CREATE FUNCTION trustwork.screening_rescreen_request(p_trigger text, p_list_version uuid, p_window_seconds integer)
RETURNS TABLE (run_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v trustwork.screening_list_version%ROWTYPE;
  v_prev uuid;
  v_id uuid;
BEGIN
  PERFORM trustwork.screening_rescreen_serialize();
  IF p_trigger = 'list_version' THEN
    SELECT * INTO v FROM trustwork.screening_list_version WHERE id = p_list_version;
    IF NOT FOUND OR v.state NOT IN ('active', 'superseded') THEN
      RAISE EXCEPTION 'no activated list version' USING ERRCODE = 'no_data_found', HINT = 'screening.version_not_found';
    END IF;
    SELECT x.id INTO v_id FROM trustwork.screening_rescreen_run x WHERE x.trigger = 'list_version' AND x.list_version_id = p_list_version;
    IF FOUND THEN
      RETURN QUERY SELECT v_id, false;
      RETURN;
    END IF;
    SELECT p.id INTO v_prev FROM trustwork.screening_list_version p
     WHERE p.list_id = v.list_id AND p.version < v.version AND p.activated_at IS NOT NULL ORDER BY p.version DESC LIMIT 1;
    INSERT INTO trustwork.screening_rescreen_run (trigger, mode, list_version_id, previous_version_id, phase, window_seconds)
    VALUES ('list_version', 'delta', v.id, v_prev, 'candidates', p_window_seconds) RETURNING id INTO v_id;
    RETURN QUERY SELECT v_id, true;
  ELSIF p_trigger = 'scheduled' THEN
    SELECT x.id INTO v_id FROM trustwork.screening_rescreen_run x WHERE x.mode = 'full' AND x.state IN ('queued', 'running', 'failed');
    IF FOUND THEN
      RETURN QUERY SELECT v_id, false;
      RETURN;
    END IF;
    INSERT INTO trustwork.screening_rescreen_run (trigger, mode, phase, window_seconds) VALUES ('scheduled', 'full', 'all', p_window_seconds) RETURNING id INTO v_id;
    RETURN QUERY SELECT v_id, true;
  ELSE
    RAISE EXCEPTION 'the worker asks for list_version or scheduled runs' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
END $$;

-- Starts the next run when none is running: the oldest queued run, or a failed run whose last failure is older than
-- p_retry_after_seconds (resumed from its cursor). Answers the running run and whether its batch chain must be started.
CREATE FUNCTION trustwork.screening_rescreen_promote(p_retry_after_seconds integer)
RETURNS TABLE (run_id uuid, needs_batch boolean, promoted boolean)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE;
  v_promoted boolean := false;
BEGIN
  PERFORM trustwork.screening_rescreen_serialize();
  SELECT * INTO r FROM trustwork.screening_rescreen_run WHERE state = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO r FROM trustwork.screening_rescreen_run
     WHERE state = 'queued' OR (state = 'failed' AND updated_at <= now() - make_interval(secs => greatest(coalesce(p_retry_after_seconds, 3600), 0)))
     ORDER BY queued_at, id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    UPDATE trustwork.screening_rescreen_run SET state = 'running', started_at = coalesce(started_at, now()), blocked_reason = NULL,
      subjects_total = CASE WHEN r.state = 'queued' THEN trustwork.screening_rescreen_subject_count() ELSE subjects_total END,
      resumed = resumed + CASE WHEN r.state = 'failed' THEN 1 ELSE 0 END
     WHERE id = r.id RETURNING * INTO r;
    v_promoted := true;
  END IF;
  RETURN QUERY SELECT r.id, NOT trustwork.screening_rescreen_in_flight(r.id), v_promoted;
END $$;

-- The run, locked for the batch transaction (a second batch of the same run waits, then sees the moved cursor).
CREATE FUNCTION trustwork.screening_rescreen_lock(p_run uuid) RETURNS SETOF trustwork.screening_rescreen_run
LANGUAGE sql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.screening_rescreen_run WHERE id = p_run FOR UPDATE
$$;

-- The next subjects after the cursor (companies, then persons, by id), with their names and what their screening state
-- says. Names go to the matcher only; nothing logs them.
CREATE FUNCTION trustwork.screening_rescreen_subjects(p_after_kind text, p_after_id uuid, p_limit integer)
RETURNS TABLE (kind text, id uuid, names text[], names_digest text, has_state boolean, state_names_digest text, last_outcome text, screened_versions uuid[],
  has_matches boolean, last_matcher_version text, last_fuzzy_threshold numeric, last_screened_names_digest text)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 5000);
  v_n integer := 0;
BEGIN
  IF p_after_kind IS NOT NULL AND (p_after_kind NOT IN ('company', 'person') OR p_after_id IS NULL) THEN
    RAISE EXCEPTION 'a cursor names a kind and an id' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  IF p_after_kind IS NULL OR p_after_kind = 'company' THEN
    RETURN QUERY
      SELECT 'company'::text, c.id, x.names, trustwork.screening_names_digest(x.names), s.id IS NOT NULL, s.names_digest, s.last_outcome, coalesce(s.screened_versions, '{}'::uuid[]),
        EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE m.subject_company_id = c.id), r.matcher_version, r.fuzzy_threshold, r.screened_names_digest
      FROM trustwork.company c
      CROSS JOIN LATERAL (SELECT trustwork.screening_names_of(NULL, c.id) AS names) x
      LEFT JOIN trustwork.screening_subject_state s ON s.subject_company_id = c.id
      LEFT JOIN trustwork.screening_result r ON r.id = s.last_result_id
      WHERE p_after_kind IS NULL OR c.id > p_after_id
      ORDER BY c.id LIMIT v_limit;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  IF v_n < v_limit THEN
    RETURN QUERY
      SELECT 'person'::text, p.id, x.names, trustwork.screening_names_digest(x.names), s.id IS NOT NULL, s.names_digest, s.last_outcome, coalesce(s.screened_versions, '{}'::uuid[]),
        EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE m.subject_person_id = p.id), r.matcher_version, r.fuzzy_threshold, r.screened_names_digest
      FROM trustwork.person p
      CROSS JOIN LATERAL (SELECT trustwork.screening_names_of(p.id, NULL) AS names) x
      LEFT JOIN trustwork.screening_subject_state s ON s.subject_person_id = p.id
      LEFT JOIN trustwork.screening_result r ON r.id = s.last_result_id
      WHERE p_after_kind IS DISTINCT FROM 'person' OR p.id > p_after_id
      ORDER BY p.id LIMIT v_limit - v_n;
  END IF;
END $$;

-- List facts of activated versions (the worker maps a subject's screened versions to lists).
CREATE FUNCTION trustwork.screening_rescreen_versions(p_ids uuid[])
RETURNS TABLE (version_id uuid, list_id uuid, list_code text, state text, entry_count integer)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.id, l.id, l.code, v.state, v.entry_count FROM trustwork.screening_list_version v JOIN trustwork.screening_list l ON l.id = v.list_id
  WHERE v.id = ANY (coalesce(p_ids, '{}')) AND v.state IN ('active', 'superseded') ORDER BY v.id
$$;

-- The entries of one activated version, for the worker's in-memory index (versions are immutable, so it caches them).
CREATE FUNCTION trustwork.screening_rescreen_entries(p_version uuid)
RETURNS TABLE (entry_uid text, entry_type text, primary_name text, programs text[], name_keys text[], entry_digest text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT e.entry_uid, e.entry_type, e.primary_name, e.programs, e.name_keys, e.entry_digest
  FROM trustwork.screening_list_entry e JOIN trustwork.screening_list_version v ON v.id = e.list_version_id AND v.state IN ('active', 'superseded')
  WHERE e.list_version_id = p_version ORDER BY e.entry_uid COLLATE "C"
$$;

-- Records delta clears in bulk (see the header). p_items: [{kind, id, namesDigest, screenedNamesDigest, baseVersions}].
-- Locks the subjects' states in id order, rechecks every condition after the lock, records a `clear` result against
-- exactly the active versions and an item for each subject that still qualifies, and answers
-- {recorded, refused: [{kind, id}]}; the worker screens the refused subjects in full.
CREATE FUNCTION trustwork.screening_rescreen_record_delta(p_run uuid, p_list_version_ids uuid[], p_matcher_version text, p_fuzzy_threshold numeric, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE := trustwork.screening_rescreen_running(p_run);
  v_active uuid[] := trustwork.screening_active_versions();
  v_recorded integer;
  v_moved integer;
  v_items integer;
  v_refused jsonb;
  v_persons uuid[];
  v_companies uuid[];
  v_total bigint;
  v_distinct bigint;
  v_malformed boolean;
BEGIN
  IF r.mode <> 'delta' THEN
    RAISE EXCEPTION 'delta clears belong to delta runs' USING ERRCODE = '23514', HINT = 'screening.rescreen_invalid';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 5000 THEN
    RAISE EXCEPTION 'items come as an array of at most 5000' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  IF p_list_version_ids IS NULL OR cardinality(v_active) = 0 OR NOT (p_list_version_ids <@ v_active AND v_active <@ p_list_version_ids) THEN
    RAISE EXCEPTION 'a delta clear names exactly the active versions' USING ERRCODE = '23514', HINT = 'screening.stale_versions';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('recorded', 0, 'refused', '[]'::jsonb);
  END IF;
  SELECT array_agg(x.id) FILTER (WHERE x.kind = 'person'), array_agg(x.id) FILTER (WHERE x.kind = 'company'), count(*), count(DISTINCT (x.kind, x.id)),
         bool_or(x.kind IS NULL OR x.kind NOT IN ('person', 'company') OR x.id IS NULL OR x."baseVersions" IS NULL)
    INTO v_persons, v_companies, v_total, v_distinct, v_malformed
    FROM jsonb_to_recordset(p_items) AS x(kind text, id uuid, "baseVersions" uuid[]);
  IF v_malformed OR v_total <> v_distinct THEN
    RAISE EXCEPTION 'every item names one distinct subject and its base versions' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  -- The order every bulk writer uses; a single-subject screening (one state row) never waits in a cycle with it.
  PERFORM 1 FROM trustwork.screening_subject_state s
   WHERE s.subject_person_id = ANY (coalesce(v_persons, '{}')) OR s.subject_company_id = ANY (coalesce(v_companies, '{}'))
   ORDER BY s.id FOR UPDATE;
  -- Rechecked after the lock (this statement sees what concurrent screenings committed). No temporary table: a caller
  -- could plant one in its own session.
  WITH input AS (
    SELECT x.kind, x.id, x."namesDigest" AS names_digest, x."screenedNamesDigest" AS screened_names_digest, x."baseVersions" AS base_versions
    FROM jsonb_to_recordset(p_items) AS x(kind text, id uuid, "namesDigest" text, "screenedNamesDigest" text, "baseVersions" uuid[])
  ), subject AS (
    SELECT i.kind, i.id, i.names_digest, i.screened_names_digest, i.base_versions, s.id AS state_id, s.subject_person_id, s.subject_company_id
    FROM input i JOIN trustwork.screening_subject_state s ON i.kind = 'person' AND s.subject_person_id = i.id
    UNION ALL
    SELECT i.kind, i.id, i.names_digest, i.screened_names_digest, i.base_versions, s.id, s.subject_person_id, s.subject_company_id
    FROM input i JOIN trustwork.screening_subject_state s ON i.kind = 'company' AND s.subject_company_id = i.id
  ), ok AS MATERIALIZED (
    SELECT j.*, trustwork.new_uuid() AS result_id
    FROM subject j
    JOIN trustwork.screening_subject_state s ON s.id = j.state_id
    JOIN trustwork.screening_result lr ON lr.id = s.last_result_id
    WHERE s.last_outcome = 'clear' AND lr.outcome = 'clear' AND lr.match_count = 0
      AND s.names_digest = j.names_digest AND lr.names_digest = j.names_digest
      AND trustwork.screening_names_digest(trustwork.screening_names_of(s.subject_person_id, s.subject_company_id)) = j.names_digest
      AND lr.matcher_version = p_matcher_version AND lr.fuzzy_threshold IS NOT DISTINCT FROM p_fuzzy_threshold AND lr.screened_names_digest = j.screened_names_digest
      AND cardinality(j.base_versions) >= 1 AND s.screened_versions <@ j.base_versions AND j.base_versions <@ s.screened_versions
      AND NOT (v_active <@ s.screened_versions)
      AND NOT EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE m.subject_person_id = s.subject_person_id)
      AND NOT EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE m.subject_company_id = s.subject_company_id)
  ), recorded AS (
    INSERT INTO trustwork.screening_result (id, subject_person_id, subject_company_id, trigger, list_version_ids, outcome, matcher_version, fuzzy_threshold, screened_names_digest, names_digest, match_count)
    SELECT ok.result_id, ok.subject_person_id, ok.subject_company_id, 'list_update', v_active, 'clear', p_matcher_version, p_fuzzy_threshold, ok.screened_names_digest, ok.names_digest, 0 FROM ok
    RETURNING id
  ), moved AS (
    UPDATE trustwork.screening_subject_state s SET last_result_id = ok.result_id, last_outcome = 'clear', last_screened_at = now(), screened_versions = v_active
    FROM ok WHERE s.id = ok.state_id
    RETURNING s.id
  ), items AS (
    INSERT INTO trustwork.screening_rescreen_item (run_id, subject_person_id, subject_company_id, phase, method, result_id, outcome, base_versions)
    SELECT p_run, ok.subject_person_id, ok.subject_company_id, 'all', 'delta', ok.result_id, 'clear', ok.base_versions FROM ok
    RETURNING id
  )
  SELECT (SELECT count(*) FROM recorded)::integer,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'id', i.id) ORDER BY i.kind, i.id), '[]'::jsonb) FROM input i
           WHERE NOT EXISTS (SELECT 1 FROM ok WHERE ok.kind = i.kind AND ok.id = i.id)),
         (SELECT count(*) FROM moved)::integer, (SELECT count(*) FROM items)::integer
    INTO v_recorded, v_refused, v_moved, v_items;
  IF v_moved <> v_recorded OR v_items <> v_recorded THEN
    RAISE EXCEPTION 'a delta clear moves its state and keeps its item' USING ERRCODE = '23514', HINT = 'screening.rescreen_invalid';
  END IF;
  RETURN jsonb_build_object('recorded', v_recorded, 'refused', v_refused);
END $$;

-- Items for subjects the batch screened in full (results recorded through screening_record_result in the same
-- transaction). p_items: [{kind, id, resultId, phase}]; every item must name a result of its subject.
CREATE FUNCTION trustwork.screening_rescreen_record_items(p_run uuid, p_items jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE := trustwork.screening_rescreen_running(p_run);
  v_count integer;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 5000 THEN
    RAISE EXCEPTION 'items come as an array of at most 5000' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  INSERT INTO trustwork.screening_rescreen_item (run_id, subject_person_id, subject_company_id, phase, method, result_id, outcome)
  SELECT r.id, res.subject_person_id, res.subject_company_id, x.phase, 'full', res.id, res.outcome
  FROM jsonb_to_recordset(p_items) AS x(kind text, id uuid, "resultId" uuid, phase text)
  JOIN trustwork.screening_result res ON res.id = x."resultId"
   AND ((x.kind = 'person' AND res.subject_person_id = x.id) OR (x.kind = 'company' AND res.subject_company_id = x.id))
  WHERE x.phase IN ('candidates', 'all') AND (r.mode = 'delta' OR x.phase = 'all');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'an item does not name a result of its subject' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  RETURN v_count;
END $$;

-- Moves the run forward in the batch transaction: phase and cursor, counters (deltas of a fixed set of keys), the
-- blocked reason, and the end of the run (an outbox event with counts only).
CREATE FUNCTION trustwork.screening_rescreen_advance(p_run uuid, p_phase text, p_cursor_kind text, p_cursor_id uuid, p_counts jsonb, p_finished boolean, p_blocked text)
RETURNS SETOF trustwork.screening_rescreen_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE := trustwork.screening_rescreen_running(p_run);
  k text;
  c jsonb := coalesce(p_counts, '{}'::jsonb);
  n integer;
BEGIN
  IF jsonb_typeof(c) <> 'object' THEN
    RAISE EXCEPTION 'counts come as an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  FOR k IN SELECT jsonb_object_keys(c) LOOP
    IF k NOT IN ('subjectsDone', 'candidatesScreened', 'screenedFull', 'screenedDelta', 'alreadyCurrent', 'verified', 'clear', 'possibleMatch', 'insufficientName', 'notScreened', 'matchesOpened', 'batches')
       OR jsonb_typeof(c -> k) <> 'number' THEN
      RAISE EXCEPTION 'unknown count %', k USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
    END IF;
    n := (c ->> k)::integer;
    IF n < 0 OR n > 100000 THEN
      RAISE EXCEPTION 'a count delta is between 0 and 100000' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
    END IF;
  END LOOP;
  IF p_finished AND (coalesce(p_phase, r.phase) <> 'all' OR p_blocked IS NOT NULL) THEN
    RAISE EXCEPTION 'a run finishes after the pass over every subject' USING ERRCODE = '23514', HINT = 'screening.rescreen_transition';
  END IF;
  UPDATE trustwork.screening_rescreen_run SET
    phase = coalesce(p_phase, phase), cursor_kind = p_cursor_kind, cursor_id = p_cursor_id, blocked_reason = p_blocked,
    subjects_done = subjects_done + coalesce((c ->> 'subjectsDone')::integer, 0),
    candidates_screened = candidates_screened + coalesce((c ->> 'candidatesScreened')::integer, 0),
    screened_full = screened_full + coalesce((c ->> 'screenedFull')::integer, 0),
    screened_delta = screened_delta + coalesce((c ->> 'screenedDelta')::integer, 0),
    already_current = already_current + coalesce((c ->> 'alreadyCurrent')::integer, 0),
    verified = verified + coalesce((c ->> 'verified')::integer, 0),
    outcome_clear = outcome_clear + coalesce((c ->> 'clear')::integer, 0),
    outcome_possible_match = outcome_possible_match + coalesce((c ->> 'possibleMatch')::integer, 0),
    outcome_insufficient_name = outcome_insufficient_name + coalesce((c ->> 'insufficientName')::integer, 0),
    outcome_not_screened = outcome_not_screened + coalesce((c ->> 'notScreened')::integer, 0),
    matches_opened = matches_opened + coalesce((c ->> 'matchesOpened')::integer, 0),
    batches = batches + coalesce((c ->> 'batches')::integer, 0),
    subjects_total = greatest(subjects_total, subjects_done + coalesce((c ->> 'subjectsDone')::integer, 0)),
    last_progress_at = CASE WHEN c = '{}'::jsonb THEN last_progress_at ELSE now() END,
    state = CASE WHEN p_finished THEN 'done' ELSE state END,
    finished_at = CASE WHEN p_finished THEN now() ELSE finished_at END,
    last_error = CASE WHEN p_finished THEN NULL ELSE last_error END
  WHERE id = r.id RETURNING * INTO r;
  IF p_finished THEN
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('screening_rescreen_run', r.id::text, r.revision, 'screening.rescreen_run_finished', jsonb_build_object(
      'runId', r.id, 'trigger', r.trigger, 'mode', r.mode, 'subjectsTotal', r.subjects_total, 'subjectsDone', r.subjects_done, 'matchesOpened', r.matches_opened,
      'durationSeconds', greatest(0, floor(extract(epoch FROM (r.finished_at - r.started_at))))::bigint));
  END IF;
  RETURN NEXT r;
END $$;

-- A run whose batch failed for good stops (failed, alert); screening_rescreen_promote resumes it later from its cursor.
CREATE FUNCTION trustwork.screening_rescreen_fail(p_run uuid, p_error text) RETURNS SETOF trustwork.screening_rescreen_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE := trustwork.screening_rescreen_running(p_run);
BEGIN
  UPDATE trustwork.screening_rescreen_run SET state = 'failed', failures = failures + 1,
    last_error = CASE WHEN p_error ~ '^[a-z0-9_.:-]{1,120}$' THEN p_error ELSE 'batch_failed' END
   WHERE id = r.id RETURNING * INTO r;
  PERFORM trustwork.screening_rescreen_alert(r, 'failed');
  RETURN NEXT r;
END $$;

-- The watchdog (worker tick): a running run without a batch job in flight lost its chain (a dead-lettered batch):
-- failed with an alert; a run past its window raises one overdue alert. Answers the alerts raised.
CREATE FUNCTION trustwork.screening_rescreen_watch() RETURNS TABLE (run_id uuid, alert text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.screening_rescreen_run%ROWTYPE;
BEGIN
  PERFORM trustwork.screening_rescreen_serialize();
  FOR r IN SELECT * FROM trustwork.screening_rescreen_run x WHERE x.state = 'running' AND NOT trustwork.screening_rescreen_in_flight(x.id) ORDER BY x.id FOR UPDATE LOOP
    UPDATE trustwork.screening_rescreen_run SET state = 'failed', failures = failures + 1, last_error = 'batch_lost' WHERE id = r.id RETURNING * INTO r;
    PERFORM trustwork.screening_rescreen_alert(r, 'failed');
    run_id := r.id;
    alert := 'failed';
    RETURN NEXT;
  END LOOP;
  FOR r IN SELECT * FROM trustwork.screening_rescreen_run x WHERE x.state IN ('running', 'failed') AND x.overdue_alerted_at IS NULL
             AND x.started_at + make_interval(secs => x.window_seconds) < now() ORDER BY x.id FOR UPDATE LOOP
    UPDATE trustwork.screening_rescreen_run SET overdue_alerted_at = now() WHERE id = r.id RETURNING * INTO r;
    PERFORM trustwork.screening_rescreen_alert(r, 'overdue');
    run_id := r.id;
    alert := 'overdue';
    RETURN NEXT;
  END LOOP;
END $$;

-- Hub-cohort progress for the metrics: the latest run of each trigger (counts and times, nobody named).
CREATE FUNCTION trustwork.screening_rescreen_progress()
RETURNS TABLE (run_id uuid, trigger text, mode text, state text, phase text, subjects_total integer, subjects_done integer, matches_opened integer, screened_full integer,
  screened_delta integer, already_current integer, verified integer, failures integer, started_at timestamptz, finished_at timestamptz, elapsed_seconds bigint, overdue boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT DISTINCT ON (r.trigger) r.id, r.trigger, r.mode, r.state, r.phase, r.subjects_total, r.subjects_done, r.matches_opened, r.screened_full, r.screened_delta, r.already_current,
    r.verified, r.failures, r.started_at, r.finished_at,
    CASE WHEN r.started_at IS NULL THEN NULL ELSE greatest(0, floor(extract(epoch FROM (coalesce(r.finished_at, now()) - r.started_at))))::bigint END,
    r.overdue_alerted_at IS NOT NULL
  FROM trustwork.screening_rescreen_run r ORDER BY r.trigger, r.queued_at DESC, r.id DESC
$$;

-- 5. Runtime entry point ------------------------------------------------------------------------------------------------
-- A compliance officer of the node (under an elevation) asks for a full run now; answers the unfinished full run when
-- one exists. Audited either way.
CREATE FUNCTION trustwork.screening_rescreen_request_manual(p_ctx jsonb, p_reason text, p_window_seconds integer) RETURNS SETOF trustwork.screening_rescreen_run
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.rescreen.request');
  r trustwork.screening_rescreen_run%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 600 AND 604800 THEN
    RAISE EXCEPTION 'a window between ten minutes and seven days' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.rescreen_invalid';
  END IF;
  PERFORM trustwork.screening_rescreen_serialize();
  SELECT * INTO r FROM trustwork.screening_rescreen_run x WHERE x.mode = 'full' AND x.state IN ('queued', 'running', 'failed');
  IF NOT FOUND THEN
    INSERT INTO trustwork.screening_rescreen_run (trigger, mode, phase, window_seconds, requested_by, request_reason)
    VALUES ('manual', 'full', 'all', p_window_seconds, v_actor.person_id, btrim(p_reason)) RETURNING * INTO r;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.rescreen_requested', 'screening_rescreen_run', r.id, NULL, to_jsonb(r));
  RETURN NEXT r;
END $$;

-- 6. Row-level security and grants ---------------------------------------------------------------------------------------
ALTER TABLE trustwork.screening_rescreen_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_rescreen_run FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_rescreen_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_rescreen_item FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.screening_rescreen_run AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_rescreen_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- Compliance officers and auditors of the node read runs and items; nobody else (no subject, counterparty or other staff).
CREATE POLICY screening_rescreen_run_staff_read ON trustwork.screening_rescreen_run FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_rescreen_item_staff_read ON trustwork.screening_rescreen_item FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());

GRANT SELECT ON trustwork.screening_rescreen_run, trustwork.screening_rescreen_item TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_rescreen_request_manual(jsonb, text, integer) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_rescreen_request(text, uuid, integer), trustwork.screening_rescreen_promote(integer), trustwork.screening_rescreen_lock(uuid),
  trustwork.screening_rescreen_subjects(text, uuid, integer), trustwork.screening_rescreen_versions(uuid[]), trustwork.screening_rescreen_entries(uuid),
  trustwork.screening_rescreen_record_delta(uuid, uuid[], text, numeric, jsonb), trustwork.screening_rescreen_record_items(uuid, jsonb),
  trustwork.screening_rescreen_advance(uuid, text, text, uuid, jsonb, boolean, text), trustwork.screening_rescreen_fail(uuid, text), trustwork.screening_rescreen_watch(),
  trustwork.screening_rescreen_progress() TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

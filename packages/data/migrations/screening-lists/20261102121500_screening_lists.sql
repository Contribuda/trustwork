-- trustwork:expect-rows 2
-- SANC-002: sanctions screening lists, immutable list versions and their entries, ingestion entry points for the worker
-- and freshness (ADR 014 decisions 10, 11 and 16; data model section 24a).
--
-- * Every hub screens against the baseline: the OFAC Sanctions List Service exports, the SDN list (ofac-sdn) and the
--   consolidated non-SDN lists (ofac-cons), seeded below. A baseline list cannot be paused, deleted or renamed by
--   anyone (a trigger refuses it for every role, the owner included); its stale age is at most 14 days. A hub adds
--   lists (hub_id set) whose adapter a country-pack sanctions fact names; only those can be paused.
-- * A list version is immutable once staged: only its state moves (staged -> active | rejected, active ->
--   superseded), once. Entries are written only while their version is staged and never change. At most one version
--   per list is active and at most one waits staged. Versions and entries are sanctions records: never deleted.
-- * Activation recomputes the entry count and the digest of the entry digests in the database, so a partly written
--   version never activates; a version whose sanity check failed is rejected, and one whose entry count dropped by
--   more than the list's share waits for a compliance officer's confirmation. Activation supersedes the previous
--   version and appends `screening.list_version_activated` to the outbox in the same transaction.
-- * Freshness counts from when the active content was last confirmed from its source (last_checked_at), never from
--   the export's publication date. A baseline list that is missing or stale makes screening unavailable
--   (screening_available() is false), and the money and commitment gates refuse (SANC-004).
--
-- Entry points (SECURITY DEFINER, pinned search_path):
--   worker (trustwork_worker): screening_list_due, screening_list_lock, screening_list_record_attempt,
--     screening_list_stage, screening_list_add_entries, screening_list_activate, screening_list_reject
--   runtime (trustwork_app): screening_list_set_status, screening_list_confirm_version (compliance officer of the node
--     under an elevation, audited)
--   both: screening_list_freshness, screening_available (list metadata only, never entries)
-- The runtime role reads the tables only as a compliance officer or auditor of the node; the worker has no table grant.
-- Changing a list's mode to `live` is a console action of KEYS-001 (provider activation by a second person); until it
-- exists, the worker's live source refuses to download anything.

-- 1. Lists --------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_list (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  authority text NOT NULL CHECK (length(btrim(authority)) BETWEEN 1 AND 200),
  source_url text NOT NULL CHECK (source_url ~ '^https://[^\s]+$' AND length(source_url) <= 500),
  adapter text NOT NULL CHECK (adapter ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  mode text NOT NULL CHECK (mode IN ('fake', 'file', 'live')),
  cadence interval NOT NULL,
  warn_after interval NOT NULL,
  stale_after interval NOT NULL,
  max_drop_share numeric(4,3) NOT NULL DEFAULT 0.100 CHECK (max_drop_share > 0 AND max_drop_share < 1),
  min_entries integer NOT NULL DEFAULT 1 CHECK (min_entries >= 1),
  baseline boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_checked_at timestamptz NULL,
  last_attempt_at timestamptz NULL,
  last_outcome text NULL CHECK (last_outcome IN ('activated', 'unchanged', 'needs_confirmation', 'rejected', 'malformed', 'source_missing', 'refused', 'failed')),
  last_error text NULL CHECK (length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_list_ages CHECK (cadence >= interval '1 minute' AND cadence <= warn_after AND warn_after < stale_after),
  CONSTRAINT screening_list_baseline_scope CHECK (baseline = (hub_id IS NULL)),
  CONSTRAINT screening_list_baseline_rules CHECK (NOT baseline OR (status = 'active' AND stale_after <= interval '14 days'))
);
CREATE UNIQUE INDEX screening_list_baseline_code ON trustwork.screening_list (code) WHERE hub_id IS NULL;
CREATE UNIQUE INDEX screening_list_hub_code ON trustwork.screening_list (hub_id, code) WHERE hub_id IS NOT NULL;

CREATE FUNCTION trustwork.screening_list_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.baseline THEN
      RAISE EXCEPTION 'a baseline screening list is never deleted' USING ERRCODE = '23514', HINT = 'screening.baseline_list';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id IS DISTINCT FROM OLD.hub_id OR NEW.code <> OLD.code OR NEW.baseline <> OLD.baseline OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a screening list keeps its identity, scope and code' USING ERRCODE = '23514', HINT = 'screening.list_immutable';
  END IF;
  IF OLD.baseline AND (NEW.status <> 'active' OR NEW.adapter <> OLD.adapter) THEN
    RAISE EXCEPTION 'a baseline screening list cannot be paused or given another adapter' USING ERRCODE = '23514', HINT = 'screening.baseline_list';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screening_list_guard BEFORE UPDATE OR DELETE ON trustwork.screening_list FOR EACH ROW EXECUTE FUNCTION trustwork.screening_list_guard();
CREATE TRIGGER screening_list_no_truncate BEFORE TRUNCATE ON trustwork.screening_list FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Versions -----------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_list_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  list_id uuid NOT NULL REFERENCES trustwork.screening_list (id),
  version integer NOT NULL CHECK (version >= 1),
  published_on date NULL,
  fetched_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('fake', 'file', 'live')),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'active', 'superseded', 'rejected')),
  sanity jsonb NOT NULL CHECK (jsonb_typeof(sanity) = 'object' AND sanity ->> 'outcome' IN ('pass', 'needs_confirmation', 'rejected')),
  staged_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NULL,
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activation_reason text NULL CHECK (length(btrim(activation_reason)) BETWEEN 1 AND 500),
  decided_at timestamptz NULL,
  rejected_reason text NULL CHECK (rejected_reason ~ '^[a-z_]{1,60}$'),
  UNIQUE (list_id, version),
  CONSTRAINT screening_list_version_activation CHECK ((state IN ('active', 'superseded')) = (activated_at IS NOT NULL)),
  CONSTRAINT screening_list_version_confirmation CHECK ((activated_by IS NULL) = (activation_reason IS NULL)),
  CONSTRAINT screening_list_version_rejection CHECK ((state = 'rejected') = (rejected_reason IS NOT NULL)),
  CONSTRAINT screening_list_version_decided CHECK ((state IN ('superseded', 'rejected')) = (decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX screening_list_version_one_active ON trustwork.screening_list_version (list_id) WHERE state = 'active';
CREATE UNIQUE INDEX screening_list_version_one_staged ON trustwork.screening_list_version (list_id) WHERE state = 'staged';

CREATE FUNCTION trustwork.screening_list_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'staged' OR NEW.activated_at IS NOT NULL OR NEW.activated_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a list version starts staged' USING ERRCODE = '23514', HINT = 'screening.version_starts_staged';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'list versions are sanctions records and are never deleted' USING ERRCODE = '23514', HINT = 'screening.version_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.list_id <> OLD.list_id OR NEW.version <> OLD.version OR NEW.published_on IS DISTINCT FROM OLD.published_on OR NEW.fetched_at <> OLD.fetched_at
     OR NEW.mode <> OLD.mode OR NEW.source_digest <> OLD.source_digest OR NEW.entry_count <> OLD.entry_count OR NEW.digest <> OLD.digest OR NEW.sanity <> OLD.sanity
     OR NEW.staged_at <> OLD.staged_at THEN
    RAISE EXCEPTION 'a staged list version is immutable' USING ERRCODE = '23514', HINT = 'screening.version_immutable';
  END IF;
  IF NOT ((OLD.state = 'staged' AND NEW.state IN ('active', 'rejected')) OR (OLD.state = 'active' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'list version % cannot move from % to %', OLD.id, OLD.state, NEW.state USING ERRCODE = '23514', HINT = 'screening.version_transition';
  END IF;
  IF OLD.state = 'active' AND (NEW.activated_at <> OLD.activated_at OR NEW.activated_by IS DISTINCT FROM OLD.activated_by OR NEW.activation_reason IS DISTINCT FROM OLD.activation_reason) THEN
    RAISE EXCEPTION 'an activation is recorded once' USING ERRCODE = '23514', HINT = 'screening.version_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screening_list_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list_version FOR EACH ROW EXECUTE FUNCTION trustwork.screening_list_version_guard();
CREATE TRIGGER screening_list_version_no_truncate BEFORE TRUNCATE ON trustwork.screening_list_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Entries ------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_list_entry (
  list_version_id uuid NOT NULL REFERENCES trustwork.screening_list_version (id),
  entry_uid text NOT NULL CHECK (entry_uid ~ '^[A-Za-z0-9._:-]{1,64}$'),
  entry_type text NOT NULL CHECK (entry_type IN ('individual', 'entity', 'vessel', 'aircraft')),
  primary_name text NOT NULL CHECK (length(btrim(primary_name)) BETWEEN 1 AND 1000),
  programs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(programs) <= 100),
  name_keys text[] NOT NULL CHECK (cardinality(name_keys) BETWEEN 1 AND 1000),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  entry_digest text NOT NULL CHECK (entry_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (list_version_id, entry_uid)
);
-- The matcher (SANC-003) looks entries up by name key.
CREATE INDEX screening_list_entry_keys ON trustwork.screening_list_entry USING gin (name_keys);

CREATE FUNCTION trustwork.screening_list_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.screening_list_version v WHERE v.id = NEW.list_version_id AND v.state = 'staged') THEN
      RAISE EXCEPTION 'entries are written only with their staged version' USING ERRCODE = '23514', HINT = 'screening.version_not_staged';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'list entries are sanctions records and never change' USING ERRCODE = '23514', HINT = 'screening.entry_permanent';
END $$;
CREATE TRIGGER screening_list_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list_entry FOR EACH ROW EXECUTE FUNCTION trustwork.screening_list_entry_guard();
CREATE TRIGGER screening_list_entry_no_truncate BEFORE TRUNCATE ON trustwork.screening_list_entry FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Baseline lists -----------------------------------------------------------------------------------------------------
-- `file` mode by default: the operator drops the official export into the data directory (no network). Until the first
-- version is active, the baseline is missing and screening is unavailable: the money gates refuse (fail closed).
INSERT INTO trustwork.screening_list (code, name, authority, source_url, adapter, mode, cadence, warn_after, stale_after, max_drop_share, min_entries, baseline)
VALUES
  ('ofac-sdn', 'Specially Designated Nationals and Blocked Persons List (SDN)', 'Office of Foreign Assets Control, U.S. Department of the Treasury',
   'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML', 'ofac-sls-xml', 'file', interval '1 day', interval '3 days', interval '7 days', 0.100, 1000, true),
  ('ofac-cons', 'Consolidated Sanctions List (non-SDN lists)', 'Office of Foreign Assets Control, U.S. Department of the Treasury',
   'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML', 'ofac-sls-xml', 'file', interval '1 day', interval '3 days', interval '7 days', 0.250, 10, true);

-- 5. Internal helpers (not executable by any login role) ---------------------------------------------------------------
-- The digest of a version's entry digests in entry-uid order; equals @trustwork/compliance listDigest.
CREATE FUNCTION trustwork.screening_list_entries_digest(p_version uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(e.entry_digest, E'\n' ORDER BY e.entry_uid COLLATE "C"), ''), 'UTF8')), 'hex')
  FROM trustwork.screening_list_entry e WHERE e.list_version_id = p_version
$$;

-- Activates a staged version after rechecking it. Answers 'activated', 'needs_confirmation' (count dropped beyond the
-- share and nobody confirmed) or 'rejected' (sanity failed, or the written entries disagree with the staged count or
-- digest). p_person and p_reason name the compliance officer who confirmed a drop.
CREATE FUNCTION trustwork.screening_list_activate_version(p_version uuid, p_person uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v trustwork.screening_list_version%ROWTYPE;
  l trustwork.screening_list%ROWTYPE;
  v_count integer;
  v_previous uuid;
  v_outcome text;
BEGIN
  SELECT * INTO v FROM trustwork.screening_list_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such list version' USING ERRCODE = 'no_data_found', HINT = 'screening.version_not_found';
  END IF;
  SELECT * INTO l FROM trustwork.screening_list WHERE id = v.list_id FOR UPDATE;
  IF v.state <> 'staged' THEN
    RAISE EXCEPTION 'the list version is not staged' USING ERRCODE = '23514', HINT = 'screening.version_not_staged';
  END IF;
  SELECT count(*)::integer INTO v_count FROM trustwork.screening_list_entry WHERE list_version_id = v.id;
  IF v_count <> v.entry_count OR trustwork.screening_list_entries_digest(v.id) <> v.digest THEN
    UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = 'entries_mismatch', decided_at = now() WHERE id = v.id;
    RETURN 'rejected';
  END IF;
  v_outcome := v.sanity ->> 'outcome';
  IF v_outcome = 'rejected' THEN
    UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = coalesce(v.sanity -> 'reasons' ->> 0, 'sanity'), decided_at = now() WHERE id = v.id;
    RETURN 'rejected';
  END IF;
  IF v_outcome = 'needs_confirmation' AND p_person IS NULL THEN
    RETURN 'needs_confirmation';
  END IF;
  UPDATE trustwork.screening_list_version SET state = 'superseded', decided_at = now() WHERE list_id = v.list_id AND state = 'active' RETURNING id INTO v_previous;
  UPDATE trustwork.screening_list_version SET state = 'active', activated_at = now(), activated_by = p_person, activation_reason = CASE WHEN p_person IS NULL THEN NULL ELSE btrim(p_reason) END
   WHERE id = v.id;
  UPDATE trustwork.screening_list SET last_checked_at = least(v.fetched_at, now()) WHERE id = l.id;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('screening_list', l.id::text, v.version, 'screening.list_version_activated', jsonb_build_object(
    'listId', l.id, 'listCode', l.code, 'hubId', l.hub_id, 'baseline', l.baseline, 'versionId', v.id, 'version', v.version, 'previousVersionId', v_previous,
    'entryCount', v.entry_count, 'digest', v.digest, 'publishedOn', v.published_on, 'confirmedBy', p_person));
  RETURN 'activated';
END $$;

-- Freshness at a time no earlier than now (a caller can only make a list look older, never younger).
CREATE FUNCTION trustwork.screening_list_freshness(p_at timestamptz DEFAULT NULL)
RETURNS TABLE (list_id uuid, hub_id uuid, code text, baseline boolean, status text, state text, active_version_id uuid, published_on date,
  last_checked_at timestamptz, age_seconds bigint, warn_after_seconds bigint, stale_after_seconds bigint)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  WITH t AS (SELECT greatest(coalesce(p_at, now()), now()) AS at),
  l AS (
    SELECT l.*, a.id AS active_id, a.published_on AS active_published_on,
      CASE WHEN a.id IS NULL OR l.last_checked_at IS NULL THEN NULL ELSE greatest(0, floor(extract(epoch FROM (t.at - l.last_checked_at))))::bigint END AS age,
      floor(extract(epoch FROM l.warn_after))::bigint AS warn_s,
      floor(extract(epoch FROM CASE WHEN l.baseline THEN least(l.stale_after, interval '14 days') ELSE l.stale_after END))::bigint AS stale_s
    FROM trustwork.screening_list l CROSS JOIN t
    LEFT JOIN trustwork.screening_list_version a ON a.list_id = l.id AND a.state = 'active'
  )
  SELECT l.id, l.hub_id, l.code, l.baseline, l.status,
    CASE WHEN l.status = 'paused' AND NOT l.baseline THEN 'paused'
         WHEN l.age IS NULL THEN 'missing'
         WHEN l.age > l.stale_s THEN 'stale'
         WHEN l.age > l.warn_s THEN 'warning'
         ELSE 'fresh' END,
    l.active_id, l.active_published_on, l.last_checked_at, l.age, l.warn_s, l.stale_s
  FROM l ORDER BY l.baseline DESC, l.hub_id NULLS FIRST, l.code
$$;

-- Screening is available when a baseline list exists and every baseline list is fresh or in its warning period.
CREATE FUNCTION trustwork.screening_available(p_at timestamptz DEFAULT NULL) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.screening_list_freshness(p_at) f WHERE f.baseline)
     AND NOT EXISTS (SELECT 1 FROM trustwork.screening_list_freshness(p_at) f WHERE f.baseline AND f.state NOT IN ('fresh', 'warning'))
$$;

-- 6. Worker entry points ------------------------------------------------------------------------------------------------
-- Lists due for an ingestion attempt that have no ingestion job queued or running.
CREATE FUNCTION trustwork.screening_list_due(p_limit integer) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT l.id FROM trustwork.screening_list l
  WHERE l.status = 'active' AND (l.last_attempt_at IS NULL OR l.last_attempt_at + l.cadence <= now())
    AND NOT EXISTS (SELECT 1 FROM trustwork.job j WHERE j.kind = 'screening.list_ingest' AND j.state IN ('queued', 'leased') AND j.payload ->> 'listId' = l.id::text)
  ORDER BY l.baseline DESC, l.last_attempt_at NULLS FIRST, l.code
  LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
$$;

-- The list to ingest, locked for this transaction (concurrent ingestions of one list serialise here), with its active
-- and staged versions.
CREATE FUNCTION trustwork.screening_list_lock(p_list uuid)
RETURNS TABLE (id uuid, hub_id uuid, code text, adapter text, mode text, source_url text, status text, baseline boolean, max_drop_share numeric, min_entries integer,
  active_version_id uuid, active_digest text, active_entry_count integer, staged_version_id uuid, staged_digest text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM 1 FROM trustwork.screening_list l WHERE l.id = p_list FOR UPDATE;
  RETURN QUERY
  SELECT l.id, l.hub_id, l.code, l.adapter, l.mode, l.source_url, l.status, l.baseline, l.max_drop_share, l.min_entries,
    a.id, a.digest, a.entry_count, s.id, s.digest
  FROM trustwork.screening_list l
  LEFT JOIN trustwork.screening_list_version a ON a.list_id = l.id AND a.state = 'active'
  LEFT JOIN trustwork.screening_list_version s ON s.list_id = l.id AND s.state = 'staged'
  WHERE l.id = p_list;
END $$;

-- The outcome of one attempt. p_confirmed_at (when the source still served the active content) moves last_checked_at
-- forward, never past now and never backwards.
CREATE FUNCTION trustwork.screening_list_record_attempt(p_list uuid, p_outcome text, p_error text, p_confirmed_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.screening_list l
     SET last_attempt_at = now(), last_outcome = p_outcome, last_error = left(p_error, 300),
         last_checked_at = CASE
           WHEN p_confirmed_at IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.screening_list_version a WHERE a.list_id = l.id AND a.state = 'active') THEN l.last_checked_at
           ELSE greatest(l.last_checked_at, least(p_confirmed_at, now())) END
   WHERE l.id = p_list;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such screening list' USING ERRCODE = 'no_data_found', HINT = 'screening.list_not_found';
  END IF;
END $$;

-- Stages a new version (a version still waiting staged is rejected as replaced). Entries follow with add_entries.
CREATE FUNCTION trustwork.screening_list_stage(p_list uuid, p_published_on date, p_fetched_at timestamptz, p_mode text, p_source_digest text, p_entry_count integer,
  p_digest text, p_sanity jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  l trustwork.screening_list%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO l FROM trustwork.screening_list WHERE id = p_list FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such screening list' USING ERRCODE = 'no_data_found', HINT = 'screening.list_not_found';
  END IF;
  IF p_mode IS DISTINCT FROM l.mode THEN
    RAISE EXCEPTION 'the version was not obtained in the list''s mode' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.mode_mismatch';
  END IF;
  UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = 'replaced', decided_at = now() WHERE list_id = l.id AND state = 'staged';
  INSERT INTO trustwork.screening_list_version (list_id, version, published_on, fetched_at, mode, source_digest, entry_count, digest, sanity)
  VALUES (l.id, coalesce((SELECT max(version) FROM trustwork.screening_list_version WHERE list_id = l.id), 0) + 1, p_published_on, least(p_fetched_at, now()), p_mode,
    p_source_digest, p_entry_count, p_digest, p_sanity)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Writes a batch of entries (at most 2000) of a staged version.
CREATE FUNCTION trustwork.screening_list_add_entries(p_version uuid, p_entries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
BEGIN
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 2000 THEN
    RAISE EXCEPTION 'entries come as an array of at most 2000' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.entries_batch';
  END IF;
  INSERT INTO trustwork.screening_list_entry (list_version_id, entry_uid, entry_type, primary_name, programs, name_keys, attributes, entry_digest)
  SELECT p_version, e.entry_uid, e.entry_type, e.primary_name, coalesce(e.programs, '{}'), e.name_keys, coalesce(e.attributes, '{}'::jsonb), e.entry_digest
  FROM jsonb_to_recordset(p_entries) AS e(entry_uid text, entry_type text, primary_name text, programs text[], name_keys text[], attributes jsonb, entry_digest text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE FUNCTION trustwork.screening_list_activate(p_version uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.screening_list_activate_version(p_version, NULL, NULL)
$$;

CREATE FUNCTION trustwork.screening_list_reject(p_version uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = p_reason, decided_at = now() WHERE id = p_version AND state = 'staged';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the list version is not staged' USING ERRCODE = '23514', HINT = 'screening.version_not_staged';
  END IF;
END $$;

-- 7. Console entry points (compliance officer of the node, under an elevation, audited) --------------------------------
-- The actor of a screening staff command, or a refusal. Role-based until SANC-006 adds the admin.screening.*
-- permissions to the console vocabulary (as SANC-001 does for clearing holds).
CREATE FUNCTION trustwork.screening_staff_actor(p_ctx jsonb, p_permission text) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_node uuid := trustwork.jurisdiction_node();
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_person uuid := trustwork.current_person_id();
  v_breakglass boolean;
BEGIN
  SELECT a.breakglass INTO v_breakglass FROM trustwork.staff_role_assignment a
   WHERE a.person_id = v_person AND a.role = 'compliance-officer' AND a.scope_kind = 'node' AND a.node_id = v_node
     AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
   ORDER BY a.breakglass LIMIT 1;
  IF v_node IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'only a compliance officer of this node manages screening lists' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  RETURN ROW(v_person, 'compliance-officer', v_breakglass, v_elevation, p_permission)::trustwork.admin_actor;
END $$;

-- Pause or resume an additional list. The baseline lists refuse it.
CREATE FUNCTION trustwork.screening_list_set_status(p_ctx jsonb, p_list uuid, p_status text, p_reason text) RETURNS trustwork.screening_list
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.lists.manage');
  v_before trustwork.screening_list%ROWTYPE;
  v_after trustwork.screening_list%ROWTYPE;
BEGIN
  IF p_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'status is active or paused' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_status';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  SELECT * INTO v_before FROM trustwork.screening_list WHERE id = p_list FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such screening list' USING ERRCODE = 'no_data_found', HINT = 'screening.list_not_found';
  END IF;
  IF v_before.baseline THEN
    RAISE EXCEPTION 'the baseline lists cannot be paused' USING ERRCODE = 'insufficient_privilege', HINT = 'screening.baseline_list';
  END IF;
  UPDATE trustwork.screening_list SET status = p_status WHERE id = p_list RETURNING * INTO v_after;
  -- Digest inputs carry integers only: the share is recorded as text.
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.list_status_set', 'screening_list', v_after.id,
    to_jsonb(v_before) || jsonb_build_object('max_drop_share', v_before.max_drop_share::text), to_jsonb(v_after) || jsonb_build_object('max_drop_share', v_after.max_drop_share::text));
  RETURN v_after;
END $$;

-- Activate a staged version whose entry count dropped beyond the list's share, after a person checked it.
CREATE FUNCTION trustwork.screening_list_confirm_version(p_ctx jsonb, p_version uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.lists.confirm');
  v_before trustwork.screening_list_version%ROWTYPE;
  v_after trustwork.screening_list_version%ROWTYPE;
  v_outcome text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  SELECT * INTO v_before FROM trustwork.screening_list_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such list version' USING ERRCODE = 'no_data_found', HINT = 'screening.version_not_found';
  END IF;
  IF v_before.state <> 'staged' OR v_before.sanity ->> 'outcome' <> 'needs_confirmation' THEN
    RAISE EXCEPTION 'only a staged version waiting for confirmation can be confirmed' USING ERRCODE = '23514', HINT = 'screening.confirmation_not_needed';
  END IF;
  v_outcome := trustwork.screening_list_activate_version(p_version, v_actor.person_id, p_reason);
  SELECT * INTO v_after FROM trustwork.screening_list_version WHERE id = p_version;
  -- Digest inputs carry integers only: the sanity record (with its shares) is recorded as text.
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.list_version_confirmed', 'screening_list_version', p_version,
    to_jsonb(v_before) || jsonb_build_object('sanity', v_before.sanity::text), to_jsonb(v_after) || jsonb_build_object('sanity', v_after.sanity::text));
  RETURN v_outcome;
END $$;

-- 8. Row-level security and grants --------------------------------------------------------------------------------------
ALTER TABLE trustwork.screening_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.screening_list AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_list_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_list_entry AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- Compliance officers and auditors of the node read lists, versions and entries (the same reader as SANC-001's holds).
CREATE POLICY screening_list_staff_read ON trustwork.screening_list FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_list_version_staff_read ON trustwork.screening_list_version FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_list_entry_staff_read ON trustwork.screening_list_entry FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());

GRANT SELECT ON trustwork.screening_list, trustwork.screening_list_version, trustwork.screening_list_entry TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_list_set_status(jsonb, uuid, text, text), trustwork.screening_list_confirm_version(jsonb, uuid, text),
  trustwork.screening_list_freshness(timestamptz), trustwork.screening_available(timestamptz) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_list_due(integer), trustwork.screening_list_lock(uuid), trustwork.screening_list_record_attempt(uuid, text, text, timestamptz),
  trustwork.screening_list_stage(uuid, date, timestamptz, text, text, integer, text, jsonb), trustwork.screening_list_add_entries(uuid, jsonb),
  trustwork.screening_list_activate(uuid), trustwork.screening_list_reject(uuid, text),
  trustwork.screening_list_freshness(timestamptz), trustwork.screening_available(timestamptz) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

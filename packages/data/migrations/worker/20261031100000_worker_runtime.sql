-- REL-001: worker runtime. A restricted worker role, monthly partitions for the two append-only streams, scheduler
-- state and owner-run maintenance entry points with intervals fixed inside the definer functions.
--
-- Roles: the runner bootstrap creates the NOLOGIN group trustwork_worker (cluster-wide, like trustwork_app). The
-- worker logs in with a member role. It is not a member of trustwork_app and receives no grant on any party table:
-- only outbox_event (read, mark published), job, inbox_receipt, an INSERT on audit_event for its own decisions,
-- worker_schedule and the definer functions below. The API role (trustwork_app) loses SELECT on audit_event and
-- outbox_event (architecture audit C2): it appends only.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. audit_event and outbox_event become range-partitioned by month (architecture audit C4). Same columns, same
--    constraints and indexes; the primary key gains the partition key. A DEFAULT partition catches rows outside the
--    created months, so an insert never fails when the worker has not run; the worker keeps the current month and the
--    next three months created ahead (trustwork.ensure_monthly_partitions). Retention (detach and archive) is an open
--    owner decision (Q6) and is not automated here.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE trustwork.audit_event RENAME TO audit_event_legacy;
ALTER TABLE trustwork.audit_event_legacy RENAME CONSTRAINT audit_event_pkey TO audit_event_legacy_pkey;
ALTER INDEX trustwork.audit_event_object_idx RENAME TO audit_event_legacy_object_idx;
ALTER INDEX trustwork.audit_event_actor_idx RENAME TO audit_event_legacy_actor_idx;
ALTER SEQUENCE trustwork.audit_event_id_seq RENAME TO audit_event_legacy_id_seq;

CREATE TABLE trustwork.audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_of_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_of_company_id uuid NULL REFERENCES trustwork.company (id),
  mandate_id uuid NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  object_kind text NOT NULL CHECK (length(object_kind) BETWEEN 1 AND 60),
  object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 128),
  before_digest text NULL CHECK (before_digest IS NULL OR before_digest ~ '^[a-f0-9]{64}$'),
  after_digest text NULL CHECK (after_digest IS NULL OR after_digest ~ '^[a-f0-9]{64}$'),
  basis jsonb NULL,
  reason text NULL CHECK (reason IS NULL OR length(reason) <= 500),
  request_id text NULL CHECK (request_id IS NULL OR length(request_id) <= 128),
  authz_epoch integer NULL,
  CONSTRAINT audit_on_behalf_xor CHECK (on_behalf_of_person_id IS NULL OR on_behalf_of_company_id IS NULL),
  CONSTRAINT audit_event_pkey PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX audit_event_object_idx ON trustwork.audit_event (object_kind, object_id, id);
CREATE INDEX audit_event_actor_idx ON trustwork.audit_event (actor_person_id, id) WHERE actor_person_id IS NOT NULL;
-- Append-only for every role, including the owner: UPDATE and DELETE raise (cloned to every partition).
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON trustwork.audit_event FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TABLE trustwork.audit_event_default PARTITION OF trustwork.audit_event DEFAULT;

ALTER TABLE trustwork.outbox_event RENAME TO outbox_event_legacy;
ALTER TABLE trustwork.outbox_event_legacy RENAME CONSTRAINT outbox_event_pkey TO outbox_event_legacy_pkey;
ALTER INDEX trustwork.outbox_event_unpublished_idx RENAME TO outbox_event_legacy_unpublished_idx;
ALTER SEQUENCE trustwork.outbox_event_id_seq RENAME TO outbox_event_legacy_id_seq;

CREATE TABLE trustwork.outbox_event (
  id bigint GENERATED ALWAYS AS IDENTITY,
  aggregate_kind text NOT NULL CHECK (length(aggregate_kind) BETWEEN 1 AND 60),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 128),
  revision integer NOT NULL CHECK (revision >= 1),
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  CONSTRAINT outbox_event_pkey PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX outbox_event_unpublished_idx ON trustwork.outbox_event (id) WHERE published_at IS NULL;
CREATE TABLE trustwork.outbox_event_default PARTITION OF trustwork.outbox_event DEFAULT;

-- Owner-run partition maintenance. The horizon (current month plus three) is fixed here, not chosen by the caller.
-- An advisory lock serialises concurrent workers; existing partitions are skipped, so a run without work takes no
-- DDL lock. Creating a month whose rows already sit in the DEFAULT partition fails loudly (the worker was down for
-- more than three months): an operator moves those rows in a reviewed maintenance step.
CREATE FUNCTION trustwork.ensure_monthly_partitions() RETURNS SETOF text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  v_parent text;
  v_month timestamptz;
  v_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.monthly_partitions'));
  FOREACH v_parent IN ARRAY ARRAY['audit_event', 'outbox_event'] LOOP
    FOR v_offset IN 0..3 LOOP
      v_month := date_trunc('month', now()) + make_interval(months => v_offset);
      v_name := v_parent || '_y' || to_char(v_month, 'YYYY') || 'm' || to_char(v_month, 'MM');
      IF to_regclass('trustwork.' || v_name) IS NULL THEN
        EXECUTE format('CREATE TABLE trustwork.%I PARTITION OF trustwork.%I FOR VALUES FROM (%L) TO (%L)',
          v_name, v_parent, v_month, v_month + interval '1 month');
        RETURN NEXT v_name;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Months are created before the rows move, so rows of the current month land in their partition and older rows in
-- DEFAULT (a month that already passed is never created afterwards).
SELECT trustwork.ensure_monthly_partitions();

INSERT INTO trustwork.audit_event OVERRIDING SYSTEM VALUE SELECT * FROM trustwork.audit_event_legacy;
SELECT setval(pg_get_serial_sequence('trustwork.audit_event', 'id'), coalesce((SELECT max(id) FROM trustwork.audit_event_legacy), 0) + 1, false);
DROP TABLE trustwork.audit_event_legacy;

INSERT INTO trustwork.outbox_event OVERRIDING SYSTEM VALUE SELECT * FROM trustwork.outbox_event_legacy;
SELECT setval(pg_get_serial_sequence('trustwork.outbox_event', 'id'), coalesce((SELECT max(id) FROM trustwork.outbox_event_legacy), 0) + 1, false);
DROP TABLE trustwork.outbox_event_legacy;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Scheduler state: one row per maintenance task. A worker claims a due task by moving next_at forward in one
--    UPDATE (at most one worker per due slot, no lock held while the task runs); a crash leaves the next slot due.
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE trustwork.worker_schedule (
  task text PRIMARY KEY CHECK (task ~ '^[a-z][a-z0-9_.]{0,59}$'),
  next_at timestamptz NOT NULL DEFAULT now(),
  last_started_at timestamptz NULL,
  last_finished_at timestamptz NULL,
  last_outcome text NULL CHECK (last_outcome IN ('succeeded', 'failed')),
  last_error text NULL CHECK (last_error IS NULL OR length(last_error) <= 2000),
  last_worker text NULL CHECK (last_worker IS NULL OR length(last_worker) <= 128),
  run_count bigint NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  failure_count bigint NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Owner-run entry points for the worker.
-- ---------------------------------------------------------------------------------------------------------------

-- Scheduled sweep with the intervals fixed here (architecture audit C2): sessions kept 90 days after revocation or
-- expiry, settled admission leases one day, never-verified signups seven days. Also removes expired idempotency
-- records, consumed or expired auth tokens and expired login failures (see trustwork.sweep_expired).
CREATE FUNCTION trustwork.worker_sweep_expired()
RETURNS TABLE (auth_tokens integer, login_failures integer, idempotency_records integer, admission_leases integer, sessions integer, unverified_persons integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
  SELECT * FROM trustwork.sweep_expired(interval '90 days', interval '1 day', interval '7 days')
$$;

-- Graceful release of a leased job whose work did not start or was rolled back: back to queued without consuming an
-- attempt. Fencing-checked: only the current lease holder can release, and the token it held stays invalid.
CREATE FUNCTION trustwork.release_job(p_job_id uuid, p_fencing_token bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp AS $$
BEGIN
  UPDATE trustwork.job
  SET state = 'queued', attempt = greatest(attempt - 1, 0), leased_until = NULL, leased_by = NULL, next_at = now(), updated_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'leased' AND fencing_token = p_fencing_token;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Grants.
-- ---------------------------------------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA trustwork TO trustwork_worker;

-- API role: append-only on both streams (no SELECT, no UPDATE); job, idempotency and inbox grants are unchanged.
GRANT INSERT ON trustwork.audit_event TO trustwork_app;
GRANT INSERT ON trustwork.outbox_event TO trustwork_app;

-- Worker role.
GRANT INSERT ON trustwork.audit_event TO trustwork_worker;
GRANT SELECT, UPDATE (published_at) ON trustwork.outbox_event TO trustwork_worker;
GRANT SELECT, INSERT, UPDATE (state, next_at, leased_until, leased_by, last_error, updated_at) ON trustwork.job TO trustwork_worker;
GRANT SELECT, INSERT ON trustwork.inbox_receipt TO trustwork_worker;
GRANT SELECT, INSERT, UPDATE (next_at, last_started_at, last_finished_at, last_outcome, last_error, last_worker, run_count, failure_count, updated_at) ON trustwork.worker_schedule TO trustwork_worker;
-- Plain helpers used by column defaults (job.id) and the job_state_guard trigger.
GRANT EXECUTE ON FUNCTION trustwork.new_uuid(), trustwork.in_maintenance() TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.lease_jobs(text[], text, interval, integer) TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.reconcile_job(uuid, text, text) TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.release_job(uuid, bigint) TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.worker_sweep_expired() TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.ensure_monthly_partitions() TO trustwork_worker;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

-- DATA-001 reliability and governance: append-only audit, transactional outbox, leased jobs with fencing,
-- idempotency records and inbound receipts. None of these tables carries party-private fields in this slice.

CREATE TABLE trustwork.audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  CONSTRAINT audit_on_behalf_xor CHECK (on_behalf_of_person_id IS NULL OR on_behalf_of_company_id IS NULL)
);
CREATE INDEX audit_event_object_idx ON trustwork.audit_event (object_kind, object_id, id);
CREATE INDEX audit_event_actor_idx ON trustwork.audit_event (actor_person_id, id) WHERE actor_person_id IS NOT NULL;
-- Append-only for every role, including the owner: UPDATE and DELETE raise.
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON trustwork.audit_event FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.outbox_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_kind text NOT NULL CHECK (length(aggregate_kind) BETWEEN 1 AND 60),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 128),
  revision integer NOT NULL CHECK (revision >= 1),
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL
);
CREATE INDEX outbox_event_unpublished_idx ON trustwork.outbox_event (id) WHERE published_at IS NULL;

CREATE TABLE trustwork.job (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'dead', 'outcome_unknown')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz NULL,
  leased_by text NULL,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_lease_shape CHECK ((state = 'leased') = (leased_until IS NOT NULL AND leased_by IS NOT NULL))
);
CREATE INDEX job_queue_idx ON trustwork.job (kind, next_at) WHERE state = 'queued';
CREATE INDEX job_leased_idx ON trustwork.job (leased_until) WHERE state = 'leased';

-- Lease helper: FOR UPDATE SKIP LOCKED, bounded lease, monotonically increasing fencing token per job.
-- Expired leases are NOT reclaimed here: an expired executing lease enters reconciliation (lifecycles doc),
-- which is a separate explicit command.
CREATE FUNCTION trustwork.lease_jobs(p_kinds text[], p_worker text, p_lease interval, p_limit integer)
RETURNS SETOF trustwork.job
LANGUAGE sql VOLATILE AS $$
  WITH candidate AS (
    SELECT id FROM trustwork.job
    WHERE state = 'queued' AND next_at <= now() AND kind = ANY (p_kinds)
    ORDER BY next_at, id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE trustwork.job j
  SET state = 'leased', leased_until = now() + p_lease, leased_by = p_worker,
      fencing_token = j.fencing_token + 1, attempt = j.attempt + 1, updated_at = clock_timestamp()
  FROM candidate c
  WHERE j.id = c.id
  RETURNING j.*
$$;

CREATE TABLE trustwork.idempotency_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  context_id text NOT NULL CHECK (length(context_id) BETWEEN 1 AND 128),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed')),
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Invariant 4: unique (principal, action, context, key).
  CONSTRAINT idempotency_scope_unique UNIQUE (principal_id, action, context_id, key),
  CONSTRAINT idempotency_result_shape CHECK ((state = 'completed') = (result IS NOT NULL))
);
CREATE INDEX idempotency_expiry_idx ON trustwork.idempotency_record (expires_at);

CREATE TABLE trustwork.inbox_receipt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 60),
  account text NOT NULL CHECK (length(account) BETWEEN 1 AND 128),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Invariant 4: duplicate delivery is expected and ignored by key.
  CONSTRAINT inbox_receipt_unique UNIQUE (provider, account, event_id)
);

GRANT SELECT, INSERT ON trustwork.audit_event TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (published_at) ON trustwork.outbox_event TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (state, attempt, next_at, leased_until, leased_by, fencing_token, last_error, payload, updated_at) ON trustwork.job TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (state, result) ON trustwork.idempotency_record TO trustwork_app;
GRANT SELECT, INSERT ON trustwork.inbox_receipt TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.lease_jobs(text[], text, interval, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;

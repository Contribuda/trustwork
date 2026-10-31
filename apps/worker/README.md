# @trustwork/worker: outbox relay, durable jobs and scheduled maintenance

Status: **Live** (REL-001), not deployed anywhere. Coordination happens only in PostgreSQL, so any number of worker processes can run against one database. Registered domain handlers: transactional mail (MAIL-001, [`src/mail`](src/mail/README.md)); search projections and other provider calls come with the packages that own them.

## Run

```sh
WORKER_DATABASE_URL=postgresql://<worker login>@127.0.0.1:54329/trustwork_dev npm run worker
# equivalent: npm run start -w @trustwork/worker
```

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_DATABASE_URL` | required | A login role that is a member of `trustwork_worker` only. The worker refuses to start as a superuser, with `BYPASSRLS`, or as a member of `trustwork_app` or `trustwork_owner` |
| `WORKER_ID` | `<hostname>:<pid>` | Written to `job.leased_by` and `worker_schedule.last_worker` |
| `WORKER_CONCURRENCY` | 4 | Jobs executing at once (1-64) |
| `WORKER_POLL_MS` | 1000 | Sleep after an iteration that found no work |
| `WORKER_LEASE_SECONDS` | 60 | Job lease; renewed by a heartbeat every third of it |
| `WORKER_EXTERNAL_TIMEOUT_MS` | 30000 | Time limit of an external job; a timeout parks the job as `outcome_unknown` |
| `WORKER_SHUTDOWN_GRACE_MS` | 25000 | Time in-flight work gets after SIGTERM/SIGINT |
| `WORKER_METRICS_PORT` / `WORKER_METRICS_HOST` | off / `127.0.0.1` | `GET /metrics` (Prometheus text) and `GET /health/live` |

Create the login once (operations, not a migration; roles are cluster-wide):

```sql
CREATE ROLE trustwork_worker_login LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS INHERIT IN ROLE trustwork_worker;
```

## Database role

The migration runner bootstraps the NOLOGIN group `trustwork_worker` next to `trustwork_app`. The worker module migration (`packages/data/migrations/worker/`) grants it exactly:

| Object | Grant |
|---|---|
| `outbox_event` | `SELECT`, `UPDATE (published_at)` |
| `job` | `SELECT`, `INSERT`, `UPDATE` of state, schedule and lease columns (never `fencing_token` or `attempt`) |
| `inbox_receipt` | `SELECT`, `INSERT` |
| `audit_event` | `INSERT` only (reconciliation decisions) |
| `worker_schedule` | `SELECT`, `INSERT`, `UPDATE` |
| `mail_delivery` (MAIL-001, `migrations/mail/`) | `SELECT`, `UPDATE` of state, outcome and the two personal columns it clears (`recipient`, `sealed_secret`); never the template, parameters or address hash; no `INSERT` or `DELETE` |
| `suppression_entry` (MAIL-001) | `SELECT`, `INSERT` (no `DELETE`: lifting a suppression is an operator decision) |
| functions | `lease_jobs`, `reconcile_job`, `release_job`, `worker_sweep_expired()`, `ensure_monthly_partitions()`, plus the helpers `new_uuid()` and `in_maintenance()` |

It has no grant on any party table (person, company, membership, project, sessions, credentials, idempotency records, admission). The only personal data it reads is the recipient address of a pending mail delivery, which it clears when the delivery is final. The same migration revokes the API role's `SELECT` on `audit_event` and `outbox_event`: the API appends only. `tests/worker/roles.test.ts` checks both directions.

## Outbox relay

`OutboxRelay.relayOnce` claims up to `relayBatchSize` unpublished rows with `FOR UPDATE SKIP LOCKED`, dispatches each to the handlers registered for its `type`, and marks the batch published in the same transaction.

- Handlers (`HandlerRegistry.onOutbox({ name, type, parse?, handle })`) run inside the relay transaction and touch only the database. Provider effects are jobs they enqueue (`context.enqueue`). `parse` takes a contract schema's `parse` to type the payload.
- A crash before COMMIT leaves the rows unpublished and the handler's effects rolled back: the next relay delivers them again, once.
- A failing handler rolls back to a savepoint and becomes an `outbox.redeliver` job (first attempt after one backoff step, then the retry policy, then a dead letter). Other handlers and events in the batch are unaffected.
- An event type without handlers is published and counted as `unhandled`. The rows stay in the partitioned table for consumers added later.
- Handlers must be idempotent per logical event when the same intent may be appended twice: record a receipt (`inbox.record`) keyed by aggregate, revision and type.

## Jobs

`HandlerRegistry.onJob` registers one handler per kind. The runner leases only registered kinds through `trustwork.lease_jobs` (SKIP LOCKED, fencing token incremented by the owner-run function), keeps the lease alive with a heartbeat, and records every outcome with a fencing-checked update. A stale worker therefore can never settle a newer lease.

| Mode | Contract | On crash or lost lease |
|---|---|---|
| `transactional` | `run` and the completion share one transaction: exactly once on the database | Effect rolled back; the expired lease is reconciled automatically to `queued` (reference `auto:transactional-rollback:<token>`, audited) |
| `external` | Return = success; `RetryableJobError` = no effect, retry with backoff; `PermanentJobError` = dead letter now; any other error or timeout = `outcome_unknown` | Expired lease is parked as `outcome_unknown`; nothing runs again until an explicit reconciliation |

Every job context carries a stable `effectKey` (`job:<id>`, the provider idempotency key across retries and reconciliation) and a per-attempt `attemptId`. Local fencing cannot cancel an in-flight provider call ([ADR 004](../../docs/adr/004-delivery-and-providers.md)): an adapter must pass the effect key to a provider that deduplicates by it, or the job stays external-only with manual reconciliation.

Backoff follows the contract `RetryPolicySchema` (fixed or exponential, capped, optional jitter); retry times, lease expiry, schedule slots and outbox age all use the database clock, so worker clock skew changes nothing (tested with a clock three hours ahead and behind).

## Reconciliation command

```sh
npm run reconcile -w @trustwork/worker -- parked [limit]
npm run reconcile -w @trustwork/worker -- reconcile <job-id> <succeeded|failed|queued> <reference> [--operator <label>]
npm run reconcile -w @trustwork/worker -- schedule
```

`succeeded`: the provider lookup confirms the effect. `failed`: confirmed no effect and the work must not run again (dead). `queued`: confirmed no effect and safe to run again with the same effect key. Each decision goes through the owner-run `trustwork.reconcile_job` and writes a `job.reconciled` audit row. Exit codes: 0 ok, 1 failure (for example the job is not parked), 2 usage.

## Scheduled maintenance

Each task has a row in `worker_schedule`; a worker claims a due slot by moving `next_at` forward in one UPDATE, so several workers never run the same slot twice. A failure brings the next attempt forward to at most one minute.

| Task | Interval | Work |
|---|---|---|
| `jobs.expire_leases` | 15 s | Park expired leases as `outcome_unknown`; auto-reconcile transactional kinds |
| `maintenance.sweep_expired` | 1 h | `trustwork.worker_sweep_expired()`: intervals fixed in the function (sessions 90 days, settled admission leases 1 day, never-verified signups 7 days); also removes expired idempotency records, used auth tokens and expired login failures |
| `maintenance.monthly_partitions` | 6 h | `trustwork.ensure_monthly_partitions()`: current month plus three for `audit_event` and `outbox_event` |
| `mail.settle` | 5 min | Mail deliveries take their job's final verdict (reconciled as succeeded: `sent`; dead: `failed`), expired tokens become `expired`; final rows keep no address or token |

`audit_event` and `outbox_event` are range-partitioned by month with a `DEFAULT` partition, so inserts never fail when the worker is down. Creating a month whose rows already landed in `DEFAULT` (worker down for more than three months) fails loudly and needs an operator. Retention (detach and archive) is an open owner decision (architecture audit Q6) and is not automated.

## Shutdown

SIGTERM or SIGINT stops leasing and relaying, then gives in-flight jobs `WORKER_SHUTDOWN_GRACE_MS`. After that, transactional jobs are cancelled (`pg_cancel_backend`), rolled back and released without consuming an attempt (`trustwork.release_job`), and external jobs still running are parked as `outcome_unknown`.

## Metrics

| Metric | Type | Source |
|---|---|---|
| `trustwork_outbox_unpublished_events`, `trustwork_outbox_oldest_unpublished_age_seconds` | gauge | database, read at scrape |
| `trustwork_job_queue_depth{kind,state}`, `trustwork_job_ready{kind}` | gauge | database |
| `trustwork_job_outcome_unknown{kind}` (`kind="_all"` is the total), `trustwork_job_lease_expired_parked{kind}` | gauge | database |
| `trustwork_worker_lease_expirations_total`, `trustwork_worker_unknown_outcomes_total{kind,reason}` | counter | this process |
| `trustwork_worker_jobs_total{kind,result}`, `trustwork_worker_outbox_events_total{result}`, `trustwork_worker_schedule_runs_total{task,outcome}`, `trustwork_worker_reconciliations_total{mode,outcome}`, `trustwork_worker_swept_rows_total{table}`, `trustwork_worker_partitions_created_total`, `trustwork_worker_loop_errors_total{component}` | counter | this process |

Logs are JSON lines with ids, kinds, counts and bounded error summaries; never payloads, secrets or personal data.

## Tests

`tests/worker/*.test.ts` run in `npm test` against real PostgreSQL (same backends as `tests/data`): a real outbox row appended by the API role consumed end to end (this replaced `npm run worker:demo`), two concurrent workers, role isolation in both directions, the scheduler and metrics over HTTP, and fault injection with a child worker killed by SIGKILL after and before a provider effect and inside a transactional job, a relay killed before COMMIT, duplicate events, stale fencing tokens, clock skew and graceful shutdown.

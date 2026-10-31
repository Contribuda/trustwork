# Operations, release and recovery runbook

**No production environment exists yet.** A hosted preview runs the web app on demo data; hosting, domain, payment, model and e-mail providers for production and the legal geography of each hub are unresolved. The following is an actionable release checklist for future implementation, not proof of configured infrastructure.

## Local operation

Use README setup and optional `npm run infra:up` for the isolated PostgreSQL service at loopback port 54329. Credentials are local demo values only. No business migration is applied. `npm run infra:down` stops the service while preserving its volume. Never point examples at an existing production database or run `down -v` as routine cleanup. Web/API startup is loopback-only. The API answers `GET /health/live` (process liveness, never touches the database) and `GET /health/ready` (200 only when the database answers and the migration ledger matches the migrations the build ships; 503 with states and file names only, never error text). A ledger ahead of the build (rolling deploy) stays ready. Job/outbox readiness is future work (worker).

Container images (web, API, worker, migrate job, proxy), the full local stack on one origin (`docker compose -f infra/compose.yaml --profile stack up --build -d`), image policy, SBOMs and a documentation-only Railway deployment plan: [container images](images.md).

## Release gate

1. Maintainers accept the work packages in the release; clean candidate commit, lockfile and migration checksums.
2. Run `npm run check`, dependency/security checks and feature-specific DB/browser/authority tests; the pull request checks must pass on the exact SHA, and a reviewer re-runs what the change needs.
3. Resolve provider/jurisdiction/data-retention and pricing gates relevant to this release. Owner controls infrastructure credentials, backups and domain.
4. Prepare immutable build/image digest, SBOM/dependency record, environment inventory and secret references. Keep secrets outside Git/logs. Nonroot runtime, bounded resources, HTTPS, safe proxy trust and explicit egress.
5. Rehearse migration on disposable restored data and test old/new application compatibility. Expand/migrate/contract. Back up before irreversible changes; rollback app only when schema compatible, otherwise forward fix.
6. Obtain explicit production action authorization, deploy to approved target, verify actual service SHA/schema version, readiness and authorized journeys. Record deployment separately from code merge and acceptance.
7. Watch measured errors/latency/jobs/authorization/ledger discrepancies; abort/rollback via tested plan when thresholds fail. Targets remain UNKNOWN until chosen.

## Observability

Implemented in the API (OPS-001): one JSON line per request on stdout (request id, W3C trace id, keyed principal pseudonym, route pattern, status, latency, error type/scrubbed message/stack for 5xx) with key- and pattern-based redaction; `config.invalid` on a refused boot (exit 78); OTLP/HTTP JSON traces and metrics (`http.server.request.duration`, runtime pool connections) only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; security headers on API responses and a nonce-based CSP on web pages. HSTS is opt-in for both processes: `TRUSTWORK_HSTS` holds the exact header value (for example `max-age=31536000`) and is unset by default; set it only when the app owns the whole host, because HSTS (and especially `includeSubDomains` or `preload`) binds the entire domain to HTTPS, which is the domain operator's decision. Never set it for a deployment served under a path of another site, such as the hosted preview. Target: structured logs carry request/trace ID, actor/principal pseudonymous ID, aggregate/action/run/attempt ID, revision and provider correlation; omit secrets, private terms and full prompts. Metrics: API latency/error rates, DB saturation, outbox oldest age, lease expirations, retry/dead-letter counts, unknown external outcomes, denial spikes, reservation reconciliation and queue depth. Separate audit from debugging logs; immutable audit access is restricted. Trace web->API->job->provider with bounded retention. Alert on actionable stuck unknown outcomes/budget mismatches, not every normal retry. SLO/RPO/RTO and paging owner must be agreed before production.

Worker (REL-001, [apps/worker](../../apps/worker/README.md)): the worker exports `trustwork_outbox_oldest_unpublished_age_seconds`, `trustwork_job_queue_depth`, `trustwork_job_outcome_unknown`, `trustwork_job_lease_expired_parked`, `trustwork_worker_lease_expirations_total` and related counters on `GET /metrics` when `WORKER_METRICS_PORT` is set (loopback by default). Parked `outcome_unknown` jobs are listed with `npm run reconcile -w @trustwork/worker -- parked` and resolved only with evidence: `reconcile <job-id> <succeeded|failed|queued> <reference>` writes an audit row. Stop workers with SIGTERM: they stop leasing, finish or release in-flight work within `WORKER_SHUTDOWN_GRACE_MS`, and park external calls still running.

## Backup and restore drill

Implemented as tooling and an automated drill on synthetic data (OPS-003): [backup, restore and retention](backup-and-restore.md). Targets for the demo reference hub: RPO 24 hours, RTO 8 hours (ADR 012 decision 26); production targets and the paging owner are still agreed before production. Encrypted physical base backups with WAL archiving (point-in-time recovery), logical dumps and content-addressed copies of stored files go to an off-host target through an adapter (S3-compatible, or a filesystem fake for drills); the tombstone ledger stays outside every snapshot. A database dump alone does not include object files, credentials, management decisions or successful restore proof.

Rehearsal: select timestamp and backup manifest; restore into a new isolated project whose runtime logins are fenced before the first start and whose providers are disabled; verify schema/checksums (migration ledger, `pg_verifybackup`) and file digests; replay the deletion/erasure ledger recorded after the backup; restore permitted objects; reconcile queued jobs and pending outbox events against provider receipts without re-sending effects; authorize, which lifts the fence; record measured recovery duration and data-loss window. Never reconnect restored workers to live providers before reconciliation and explicit authorization. Keep drill evidence and destroy only drill-owned resources. Audit and outbox partitions leave the database only through retention within the hub policy (detach, archive, verify, drop; legal holds and unpublished events keep a month).

## Incident and credential compromise

Stop affected workers/adapters and revoke grants; preserve evidence and record scope. Do not erase unknown external actions. Rotate only affected credentials through owner-controlled store, invalidate sessions/mandates as appropriate, reconcile orders/payments and communicate via authorized channels. Apply fix with regression tests, restore/replay safely, record root cause and follow-up. Staff support access is time-limited and audited.

[Retrieval runbook](retrieval.md) defines generation activation/rollback, tombstones, restore reconciliation, policy fencing, quarantine, cost caps and safe incident fallback. No vector runtime is installed by the preparation.

# @trustwork/data — persistence boundary

Reviewed plain-SQL migrations, a restricted runtime role, row-level security and thin typed repository ports (Kysely over `pg`) for the identity/company/access/project slice defined in [docs/data/model.md](../../docs/data/model.md) and ADR 002/008. No ORM schema synchronisation, no production connection, no copied legacy schema. Everything lives in the PostgreSQL schema `trustwork`.

Status: DATA-001 delivered the first migrations (not applied to any shared environment). The data integrator owns `packages/data/migrations` and numbering; see "Ownership" below.

## Layout

| Path | Contents |
|---|---|
| `migrations/*.sql` | Foundation: the twelve applied, immutable, timestamp-prefixed migrations (`YYYYMMDDHHMMSS_snake_name.sql`); `…120500_access_hardening.sql` and `…120600_membership_hardening.sql` carry the PR #13 review rounds. They never move (their names and checksums are in every ledger) |
| `migrations/<module>/*.sql` | Later slices, one directory per owning module (see "Parallel slices") |
| `bin/migrate.mjs` | Runner CLI (`status`, `up`, `verify`) loading the TypeScript sources through `tsx` |
| `src/migrate/` | Runner (`loadMigrations`, `migrateUp`, `verifyMigrations`, `migrationStatus`), directive parser, statement splitter |
| `src/config.ts` | Connection options from `DATABASE_URL` or `TRUSTWORK_DATABASE_*`; `.env` is never read implicitly |
| `src/pool.ts` | `createPool`, `withPrincipal`, `withMaintenance`, `PrincipalError` |
| `src/schema/index.ts` | Kysely `Database` (extends the foundation tables; module files merge theirs in by augmentation), `columnsOf`, `TableColumns`, `FOUNDATION_COLUMNS` |
| `src/schema/foundation.ts` | Hand-written model of the foundation tables and its `TABLE_COLUMNS` runtime mirror |
| `src/schema/<module>.ts` | One file per module slice: its tables and `TABLE_COLUMNS`; a test discovers the files by listing the directory and diffs their union against the live catalogue |
| `src/schema.ts` | Compatibility re-export of `src/schema/index.ts` |
| `src/repositories/` | `auth` (pre-identity definer calls incl. provider-first signup), `persons`/`emailBindings`/`credentials`/`sessions`/`authTokens`, `companies` (incl. `getPrivate`/`upsertPrivate`)/`memberships`, `participations`/`permissionGrants`, `projects` (incl. `applyOwnershipTransfer`)/`ownershipTransfers`/`leadershipAssignments`, `auditEvents`/`outbox`/`jobs` (incl. `expireLeases`, `reconcile`)/`idempotency`/`inbox` |

Package entries: `@trustwork/data` (ports and model) and `@trustwork/data/migrate` (runner API). Sources are consumed directly like `@trustwork/contracts`; `npm run build -w @trustwork/data` emits `dist/` for packaging checks.

## Migration runner

```sh
DATABASE_URL=postgresql://trustwork_dev:local_only_change_me@localhost:54329/trustwork_dev node packages/data/bin/migrate.mjs status
DATABASE_URL=... node packages/data/bin/migrate.mjs up
DATABASE_URL=... node packages/data/bin/migrate.mjs verify      # exit 1 when an applied file was edited or removed
```

`TRUSTWORK_DATABASE_HOST/PORT/NAME/USER/PASSWORD` is accepted instead of the URL; `--dir <path>` or `TRUSTWORK_MIGRATIONS_DIR` points at another directory (tests only). Exit codes: 0 ok, 1 failure or inconsistent ledger, 2 usage/configuration. The root scripts `npm run db:migrate`, `db:status` and `db:verify` wrap the three commands.

## Parallel slices: one directory per module

Several work packages add migrations at the same time without sharing a directory or a file (DATA-004, [ADR 012](../../docs/adr/012-integrator-decisions-2026-10-31.md) decision 15):

```text
packages/data/migrations/
  20261027120000_core_functions.sql …     foundation: the twelve applied files, never moved or edited
  admin/20261101090000_admin_roles.sql   DATA-002
  plans/20261102090000_plan.sql          PLAN-…
```

- **Loading.** `loadMigrations` reads the SQL files of the root plus exactly one level of module directories (lower-case `[a-z][a-z0-9_-]*`) and orders all of them globally by file name, that is by the 14-digit timestamp; a module file can therefore run between two root files or between files of another module.
- **Ledger identity.** The ledger keeps the bare file name (no directory) and the SHA-256 of the content, exactly as before: the foundation files load and verify unchanged on every existing database, and moving an unchanged file between module directories is not a re-application. File names must therefore be unique across the whole tree.
- **Fail loudly.** A nested directory (`<module>/<sub>/`), a non-SQL file, a malformed file or module name, a symlink or other special entry, or the same file name in two directories (two modules, or a module and the root) aborts `status`, `verify` and `up` before anything is applied. Only `.gitkeep` and `.DS_Store` are ignored. Forward-only and out-of-order detection are unchanged and span all directories: a pending module file that sorts before the last applied migration is refused, so a slice whose timestamp was overtaken by a merged slice gets a new timestamp from the integrator before it merges.
- **Ownership rule.** A package owns `packages/data/migrations/<module>/`, `packages/data/src/schema/<module>.ts` and `packages/data/src/repositories/<module>.ts`. It never edits another module's files, the foundation files or a shared file (`src/schema/index.ts`, `src/index.ts`); exporting a repository from the package entry is integrator bookkeeping. The data integrator still assigns timestamps at merge and owns the root.
- **Schema mirror per module.** `src/schema/<module>.ts` exports its table interfaces, a `<Module>Database` interface, `TABLE_COLUMNS` built with `columnsOf<<Module>Database>()` (compile-time exhaustive) and merges its tables into the shared Kysely model by augmentation, so `Transaction` sees them without editing `index.ts`:

  ```ts
  import { columnsOf, type TableColumns } from './index.js';
  export interface PlansDatabase { plan: PlanTable }
  declare module './index.js' {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
    interface Database extends PlansDatabase {}
  }
  const columns = columnsOf<PlansDatabase>();
  export const TABLE_COLUMNS: TableColumns<PlansDatabase> = { plan: columns('plan', ['id', 'title', 'created_at']) };
  ```

  The module's repository imports `../schema/<module>.js`, which brings the augmentation into every program that uses it. `tests/data/migrations.test.ts` lists `src/schema/`, imports every file except `index.ts`, requires `TABLE_COLUMNS`, refuses a table mirrored by two files and compares the union with `information_schema` for every live table.

Semantics:

- **Bootstrap** (idempotent, runs as the connecting *migrator* role): creates the NOLOGIN roles `trustwork_owner` and `trustwork_app` when missing (tolerating a concurrent creation), grants `SET ON PARAMETER trustwork.maintenance` to the owner only when `has_parameter_privilege` says it is missing (roles and parameter ACLs are cluster-wide while the advisory lock is per database, so two runners on different databases may race; the loser of a GRANT race (23505 on `pg_parameter_acl`, or XX000) re-checks the privilege and only retries when it is still missing), creates schema `trustwork` owned by `trustwork_owner` and the ledger `trustwork.migration_ledger(filename, checksum, applied_at, applied_by, duration_ms, transactional)`. The migrator must be a superuser or a member of `trustwork_owner` with the `SET` option (local compose: `trustwork_dev`, a superuser; production: a dedicated `trustwork_migrator LOGIN IN ROLE trustwork_owner` with `CREATEROLE` and the parameter grant pre-created by operations).
- **Lock**: `pg_advisory_lock(hashtext('trustwork.migrations'))` for the whole run.
- **Verify before apply**: SHA-256 of every applied file is compared with the ledger; a mismatch, a missing applied file or a pending file that sorts before an applied one aborts the run. Applied migrations are never edited: add a new file.
- **One transaction per migration**: `BEGIN; SET LOCAL ROLE trustwork_owner; SET LOCAL search_path = trustwork, pg_temp; set_config('trustwork.maintenance','on',true); <file>; INSERT ledger; COMMIT`. A failure rolls the whole file back and leaves no ledger row.
- `-- trustwork:no-transaction` (first comment block): statements are split and sent one by one without a transaction block (`CREATE INDEX CONCURRENTLY`). Such files must be idempotent (`IF NOT EXISTS`) because a partial failure leaves earlier statements applied and no ledger row.
- `-- trustwork:expect-rows N | min:N | max:N`: the sum of INSERT/UPDATE/DELETE row counts must match, otherwise the migration is rolled back. Required for data migrations because `FORCE ROW LEVEL SECURITY` makes an owner session without the maintenance flag silently touch 0 rows. Not combinable with `no-transaction`.
- Each migration ends with `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC`; the allowlist below is the only `GRANT EXECUTE` to `trustwork_app`. A test enumerates `pg_proc` and fails on any drift.

## Roles

| Role | Attributes | Use |
|---|---|---|
| `trustwork_owner` | `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` | Owns every object; migrations run under `SET ROLE`; SECURITY DEFINER functions execute as it |
| `trustwork_app` | `NOLOGIN NOSUPERUSER NOBYPASSRLS`; `GRANT USAGE` on the schema, per-table `SELECT/INSERT` and column-restricted `UPDATE` (never `authz_epoch`, `revision`, party/resource columns, `job.fencing_token`/`attempt`); no `DELETE`, `TRUNCATE`, `REFERENCES`; `EXECUTE` only on the allowlist | Runtime group. The API/worker log in with a member role: `CREATE ROLE trustwork_api_login LOGIN PASSWORD '…' INHERIT IN ROLE trustwork_app` (policies declared `TO trustwork_app` apply to members). Tests create a throw-away member per file |
| `trustwork_worker` | `NOLOGIN NOSUPERUSER NOBYPASSRLS`; created by the runner bootstrap; not a member of `trustwork_app`; grants only on `outbox_event` (read, publish), `job`, `inbox_receipt`, `worker_schedule`, `INSERT` on `audit_event` and the worker entry points (`migrations/worker/`, REL-001) | `apps/worker` logs in with a member role; no grant on any party table (tested in `tests/worker/roles.test.ts`) |
| migrator (`trustwork_dev` locally) | superuser or member of `trustwork_owner` | Runner and `withMaintenance` only; never configured for the API |

The runtime role cannot read `credential.password_hash` (column privilege), cannot update `person.authz_epoch`, `membership.person_id/company_id`, `object_participation.resource_*/party_*` and so on, cannot `SET ROLE trustwork_owner`, disable RLS or create policies (tested).

## Identity, RLS and the maintenance flag

- Tables with `ENABLE` + `FORCE ROW LEVEL SECURITY`: `person`, `email_binding`, `credential`, `session`, `auth_token`, `login_failure`, `membership`, `permission_grant`, `object_participation`, `company`, `company_private`, `project`, `ownership_transfer`. The owner is filtered too; the only owner policy is `maintenance_all … TO trustwork_owner USING (trustwork.maintenance_on())`.
- **Trusted setter** `trustwork.set_principal(person_id uuid, authz_epoch int)` (SECURITY DEFINER): verifies the person exists and that `authz_epoch` equals `person.authz_epoch` (otherwise SQLSTATE 28000 with hint `access.stale_epoch`/`access.no_principal`), derives the company context from the single active membership, and writes `trustwork.person_id`, `trustwork.authz_epoch`, `trustwork.company_id` with `set_config(…, true)`: transaction-local, gone at COMMIT/ROLLBACK and at `ROLLBACK TO SAVEPOINT`. Policies read `trustwork.current_person_id()` / `trustwork.current_company_id()`; a missing, empty or malformed value denies (malformed text aborts with 22P02).
- `withPrincipal(pool, { personId, authzEpoch }, fn)` is the only application path: `BEGIN → set_principal → fn(trx) → COMMIT`; on any error `ROLLBACK` and the connection is **destroyed** (not returned to the pool). A principal resolved before a membership change carries an older epoch and is refused by the database (invariant 8: membership activation/end/role change and participation grant/revoke bump the person and company epochs through SECURITY DEFINER triggers in the same transaction).
- `withMaintenance(pool, fn)`: `SET LOCAL ROLE trustwork_owner` plus the transaction-local flag; for the migrator/owner connection only (seeding, sweepers, data repair). `trustwork_app` cannot use it (the policy is `TO trustwork_owner`; a self-set flag changes nothing, tested).
- The flag is also attached as a function-scoped `SET trustwork.maintenance = 'on'` to the allowlisted SECURITY DEFINER functions, so they can read FORCE-RLS tables and the value is restored when they return (verified: after `set_principal` the runtime transaction sees `trustwork.maintenance = ''`).
- Pre-identity allowlist (`SECURITY DEFINER`, `SET search_path = trustwork, pg_temp`, EXECUTE to `trustwork_app` only, inputs are hashes): `auth_lookup_session(token_hash)`, `auth_lookup_password_credential(email)` (always one row, a real credential ordered first; unknown e-mails get `person_id NULL` and a dummy Argon2 string so the caller verifies uniformly), `auth_lookup_provider_credential(provider, subject)`, `auth_consume_token(token_hash, kind)` (single use, expiry checked), `auth_register_person(…)` and `auth_register_provider_person(…)` (NULL for an already bound e-mail or provider subject, also when a concurrent signup wins the unique index), `auth_issue_token(email, kind, hash, expires_at, require_verified)`, `auth_record_login_failure(subject_hash, window, retention)` (returns the count; thresholds are the H03 human decision), plus `set_principal`, `can_manage_resource(kind, id)`, `owns_resource(kind, id)`, `current_membership_has(permission)` used by the policies and guards, `apply_ownership_transfer(transfer_id)`, `reconcile_job(id, outcome, reference)` and `lease_jobs` (owner-run so the runtime role never moves fencing tokens). The epoch-bump trigger functions are SECURITY DEFINER but not executable by `trustwork_app`.
- Participation visibility: a party sees its own rows (person directly, company through the setter-derived active membership) and managers of a resource (a live row with `manage_participants` for the person or the employer) see every row on it. Inserting requires being the grantor and either managing the resource or materialising one's own `side = 'owner'` row **for a resource the principal actually owns** (`owns_resource`; one live owner row per resource). A party may revoke itself but any change to `capabilities`, `audience`, `valid_until` or `side` by a non-manager raises `access.self_amplification`. Former members have no company context and see nothing. Capability and audience vocabularies, `read.public` never stored, `staff.case_read ⇒ case_ref + side staff`, party XOR and one live row per `(resource, party)` are CHECK/unique constraints.
- Membership writes: a person may only *request* (`invited`, `member`, no permissions, no inviter) to join; invitations come from a member of the active employer holding `company.members.manage`, never for oneself. Activation: an invitation is accepted by the invitee only; a self-request is approved by a colleague with `company.members.manage` (`membership.activation_not_authorised` otherwise). Role/permission changes require such a colleague acting on someone else's row (`membership.self_promotion`); `invited_by` is immutable. Permission grants are never granted to oneself. `claim_status`/`verified_domains` are not runtime writes (maintenance/administration, DATA-002).
- `company`: existence and public fields are readable with any identity (`company_read USING (true)`); updates only by members of the active employer; `internal_notes`/`billing_account_id` live in `company_private` and are readable/writable only through the active employer. `project`: readable when public, owned by the principal's party or managed through participation; inserts require `creator_person_id` = current person and an owner equal to the person or the active employer; updates only by the owner party or a manager, and the owner columns are not updatable by the runtime role at all: ownership moves through `trustwork.apply_ownership_transfer(transfer_id)` (caller must own the project, transfer `accepted_by_recipient`, not expired). `ownership_transfer` is under FORCE RLS: both parties and managers read it, only the owner proposes, only the recipient consents or rejects, only the proposer withdraws, `effective`/`expired` only inside the definer or maintenance. `audit_event`, `outbox_event`, `job`, `idempotency_record`, `inbox_receipt` carry no party-private data and are not filtered.
- Epoch-only updates (the bump triggers) do not change `revision`/`updated_at` (`touch_row` compares the row without `authz_epoch`), so a concurrent profile or company edit does not hit `validation.revision_conflict` because of a membership change.

**Known limit, to be closed by BE-001 (ADR 002: RLS is defence in depth, not the authorization boundary).** The identity is plain GUC state: a caller executing arbitrary SQL as `trustwork_app` can run `set_config('trustwork.person_id', …, true)` itself, and no policy consults the authorization epoch unless `trustwork.set_principal` is the setter. The repository layer (`withPrincipal`) is the only SQL path; the current protection targets missing identity, pooled-connection reuse and stale principals. Proposed hardening (BE-001 handoff item): an owner-only table `trustwork.principal_key(secret bytea)`; `set_principal` additionally stores `trustwork.principal_mac = sha256(secret || person_id || company_id || authz_epoch || backend pid || transaction start time)`; `trustwork.current_person_id()` becomes a `SECURITY DEFINER STABLE` verifier that recomputes the MAC and returns NULL on mismatch, so a forged `trustwork.person_id` without a valid MAC denies. Cost: one definer call per policy evaluation; measure before adopting.

## Other invariants in SQL

- One active ordinary employer: `UNIQUE (person_id) WHERE status = 'active'`; membership parties are immutable and status follows the contract transition table (`membership_guard`); ended rows record actor and reason (CHECK).
- Project owner is exactly one person XOR company (CHECK); transfers follow the contract transitions and `effective` requires recipient consent; one open leadership assignment per project; an unrelated principal cannot see, update or transfer a private project (RLS).
- `audit_event`: INSERT only for the runtime role; `UPDATE`/`DELETE` raise for every role (`trustwork.forbid_mutation`), monotonic identity id.
- `trustwork.reject_update_when_frozen('status', 'draft', col…)`: reusable trigger; once the status leaves the mutable value the listed columns cannot change and the status cannot return. COM-001 attaches it to `rfq_version`/`quote_version` with the ADR 008 column lists (tested here on a probe table).
- Since REL-001 (`migrations/worker/`): `audit_event` and `outbox_event` are range-partitioned by month (DEFAULT partition plus current month and three ahead, created by `trustwork.ensure_monthly_partitions()`), and the API role may only `INSERT` into them (no `SELECT`): `auditEvents.append` and `outbox.append` return nothing. The worker role claims and publishes the outbox; `worker_sweep_expired()` runs the sweep with fixed intervals, `release_job(id, token)` gives a lease back without consuming an attempt.
- Reliability: `outbox_event`, `job` with `trustwork.lease_jobs(kinds, worker, lease, limit)` (`FOR UPDATE SKIP LOCKED`, per-job `fencing_token` that only the owner-run helper increments, bounded lease; expired leases are **not** reclaimed by the helper: `jobs.expireLeases(trx, now)` parks them as `outcome_unknown`, and `outcome_unknown`/`succeeded`/`dead` rows leave their state only through `jobs.reconcile(trx, id, outcome, reconciliationRef)` with a Reconciliation reference, never a direct re-queue), `idempotency_record` unique `(principal_id, action, context_id, key)` with payload digest, `inbox_receipt` unique `(provider, account, event_id)`.
- UUIDs are generated by `trustwork.new_uuid()`: `uuidv7()` on PostgreSQL 18+, `gen_random_uuid()` otherwise (checked at call time).

## Tests

`tests/data/*.test.ts` run through `npm test` against a real PostgreSQL with the real runtime role (no mocks). Backend selection in `tests/data/helpers/postgres.ts`:

1. `TRUSTWORK_TEST_DATABASE_URL` (a superuser/migrator URL of any reachable server);
2. Docker: when `docker version` answers within 15 s, `docker compose -f infra/compose.yaml up -d --wait` (PostgreSQL 18.3 on `127.0.0.1:54329`);
3. `embedded-postgres` (dev dependency; npm installs the PostgreSQL 18.3 binaries for the platform; each test file starts its own cluster in a temp directory);
4. none: the suites skip with `SKIPPED: no PostgreSQL …` and the gate still passes.

`TRUSTWORK_TEST_PG_BACKEND=docker|embedded|none` forces a backend. Test files run in parallel processes, so `compose up` is retried when two files start the stack at the same time (the backend is the same for every file of a run). Each file creates and drops its own database (`trustwork_test_<name>_<hex>`) and a login role that is a member of `trustwork_app`; the cluster-level roles `trustwork_owner`/`trustwork_app` remain in the local compose cluster and the compose stack is deliberately left running afterwards (it is the developer's database); stop it with `npm run infra:down` (volume retained).

Coverage: migrate from empty, idempotent re-run, upgrade from the previous schema, module layout (root plus module directories in global timestamp order; nested directory, non-SQL file, malformed names and duplicate names rejected; the twelve applied foundation files keep their names and checksums; an existing ledger is unchanged after upgrading the runner and a module migration is applied by `npm run db:migrate`; forward-only ordering across modules), checksum tamper (runner, `verify` CLI exit 1, `up` refusal), missing/out-of-order files, `expect-rows` rollback, owner without maintenance flag sees 0 rows, `no-transaction` concurrent index, failing migration leaves no ledger row, live schema vs the `TABLE_COLUMNS` of every `src/schema/` module file; RL-01, RL-03, RL-04, RL-05/05b/05c, RL-06, RL-07, RL-08, RL-12, RL-16, RL-17, RL-18 from the RLS plan; pooled connection after commit/rollback/error; concurrent `withPrincipal` isolation; single active employer (second active fails, ended → new allowed, reassignment and revival refused); stale epoch after membership end and after participation changes; cross-company denial, personal-project participant allowed, former member denied; capability vocabulary from the frozen contracts; XOR owner and transfer transitions; private company data and private projects closed without identity and to outsiders; every self-escalation path (self-join as administrator or with permissions, self-activation of a request, self-invitation through the employer branch, inviting without `company.members.manage`, self-promotion, widening/extending one's own participation, forged or duplicate owner rows, self-granted permissions, direct owner-column writes, manager self-transfer, consent by a non-recipient, expired transfers, verification columns); revision stability under epoch bumps; future `valid_from` gives no company context; append-only audit; definer lookups (minimal columns, dummy row, single-use tokens, duplicate registration, unverified recovery refused); outbox claim/publish with SKIP LOCKED; job lease, fencing (runtime role cannot move the token), retry, dead-letter, outcome_unknown, lease expiry parking and reconciliation (direct re-queue refused); provider-first signup; idempotency uniqueness; inbox deduplication; frozen-row trigger.

## Migration policy

Forward-only expand/migrate/contract. Never edit or delete an applied file (the ledger refuses). Destructive changes are separate reviewed migrations with backup/restore evidence. Data migrations declare `expect-rows`. Concurrent-index migrations use `no-transaction` and `IF NOT EXISTS`. Every migration ends with the PUBLIC EXECUTE revoke. New tables with party data get `ENABLE` + `FORCE` RLS, the `maintenance_all` policy and explicit runtime policies in the same migration; new SECURITY DEFINER functions pin `search_path` and extend the allowlist test.

## Ownership

Application-policy items the database does not enforce (BE-001, in-process policy per ADR 002): R3 a member manager may grant company-scoped permissions to colleagues of the same company (the database only forbids self-grants); R5 a manager may widen their *own* participation row (the guard only stops non-managers); R6 a manager may revoke the owner row of a resource (the database keeps one live owner row but does not protect it from managers). Each needs the no-amplification check (`canGrant`) and an owner-only rule in the command layer, with audit rows.

Ownership of `packages/data` passed from DATA-001 to **BE-001** for the common admission/revocation primitive (`packages/data/admission`, its ordered migrations, owner-row materialisation, the HMAC-verified identity hardening above and the remaining RL-09…RL-15 tests), then to **RAG-201** for retrieval migrations; no concurrent writers. DATA-002 adds admin-prefixed migrations reusing this runner and role convention. Requests to the integrator: root scripts `db:migrate` / `db:status` wrapping `bin/migrate.mjs`, `@trustwork/data` in the root `build` script.

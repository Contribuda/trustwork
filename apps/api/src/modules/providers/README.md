# Providers module (KEYS-001)

Keys, providers and models of one hub ([Keys, providers and models](../../../../../docs/engine/hub-console/providers-and-models.md), [ADR 010](../../../../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decision 25): provider connections with write-only secrets, synthetic connection tests, second-person enabling, the data-class egress matrix, model routes scoped by job, agent module or extension, operator spending caps with a hard stop, versioned cost records, kill switches per connection and per route, and the call gate every model or provider call passes. Storage, row-level security and every rule are in [`packages/data/migrations/providers`](../../../../../packages/data/migrations/providers) and [`repositories/providers.ts`](../../../../../packages/data/src/repositories/providers.ts); contracts are the frozen console contract `hub.ts` (HUBC-000, 1.0.0) and the additive [`providers.ts`](../../../../../packages/contracts/src/providers.ts). The console screens are HUBC-002 and HUBC-008; model gateway calls are LLM-001; the catalogue, pins, evaluation and canaries are MODEL-001.

Status: **Live** as an API and a call gate (no console wiring yet, not deployed). The engine ships no live network adapter: `fake` connections use the deterministic fake, `manual` connections record a person's work, and a `live` connection whose adapter is not registered tests as `error` (`adapter_unavailable`) and can never be enabled. Tests: `tests/providers/*`, `tests/contracts/providers.test.ts`, `tests/backend/idempotency/cases/providers.ts` and `tests/data/access/modules/providers.ts`, on real PostgreSQL under the runtime role.

## Guard rails

- **Secrets are write-only.** The secret route accepts a value once, seals it with a fresh data key (AES-256-GCM) wrapped by the node's key-encryption key (`TRUSTWORK_KEK` or `TRUSTWORK_KEK_FILE`; a KMS or Vault through `KmsClient`, `FakeKms` in tests), and stores only ciphertext in `secret_version`, which no runtime role can read. The additional authenticated data of both the ciphertext and the wrapped data key (the KMS encryption context) names the connection and the secret version, so a sealed row moved to another connection or version fails to open (`secret_unreadable`) and no adapter is called; the database refuses ciphertext bound to any version but the next one. Read models, audit rows, the change log and outbox payloads carry the reference and a keyed fingerprint (HMAC under a key derived from the KEK, 12 hex characters). The route keeps no idempotency record, a `SecretValue` renders as `[secret]` in logs, JSON and inspection, and a test seeds canary secrets and scans every response, log line and table of the database for them. Without a usable KEK, secret writes refuse with `secret_store_unconfigured`. Secrets that live outside the database are named by a HUB-001 credential reference (`env`, `file` under `TRUSTWORK_SECRET_DIR`, or a `VaultClient`).
- **Connection tests send synthetic input only** (`syntheticProbesFor`): an authentication check, a model list and a fixed canned request; the adapter interface has no parameter for customer data. The result records outcome, latency, models listed, the probe digest and the configuration digest it tested.
- **Enabling** needs a passing test of exactly the current configuration (adapter, mode, endpoint, hosting, storage, credential, secret version), a secret for live vendor connections, and for any non-fake connection a second person's approval of `providers.enable_non_fake` bound to the digest the connection view shows. Changing where data goes returns an enabled connection to `draft`.
- **Restricted places.** A connection that processes or stores data in a restricted place (the synced kernel list or a place the hub added) is never saved; vendor endpoints are HTTPS on public hosts and never carry credentials.
- **Egress is default deny.** A missing cell is deny. Allowing a non-public data class needs `egress.allow_private_class` (a second person), in-residency processing and storage, and zero retention, and is refused for vendors that train on inputs and for brokers. Fakes obey the matrix too.
- **Routes** serve a job, optionally narrowed to one agent module or one extension; the gate resolves extension, then module, then job and refuses a call without an active route. Active routes name pinned revisions (never `latest` or another moving alias) on enabled connections of the hub; embeddings and rerank have no fallbacks; image prompts are public only. A route that may carry non-public data stays in the hub's residency and is activated by someone other than its drafter under `models.activate_private_route`.
- **The call gate** (`ProviderCallGate`, `providers_authorize_call`) applies the node, route, job, module, extension and pipeline kill switches and the egress decision for every data class; a primary refused by egress refuses the call (a fallback never escapes an egress denial), and fallbacks are candidates only where every class is allowed. A paid call reserves its upper-bound estimate (`estimateCallCostMinor`) against every applicable cap under a per-hub lock, so an exhausted cap blocks the next paid call even under concurrency (tested with parallel calls). Settling records the cost on the connection that served it; an unknown outcome keeps the full reservation and goes to reconciliation. The sealed secret of a call opens only for an open decision of the last 15 minutes and one of its candidates.
- **Caps** are per hub, job, pipeline, agent module or connection, per day or month in the hub's time zone and currency; alerts at the chosen percentages and the exhaustion are outbox intents, once per cap and period.
- **Cost records** are versioned per connection and model and write nothing but `model_pricing` and the log: no sale price, plan, meter rate or offer changes with them (tested).
- **Kill switches.** Engaging is one person with `admin.providers.kill`; releasing needs a second person's approval of `kill_switch.release` with the incident note. Connection switches are DATA-002's `kill_switch` rows (scope `provider_connection`); route switches are this module's.
- **Audit.** Every change writes an `admin_audit_event` (digests) and a `provider_config_change` row with actor, reason and before and after values; the table refuses secret-shaped keys and values. Refusals of authority leave a `denied` audit row.

## Routes

All under `/v1/admin/hubs/:hubId/providers`. Mutations: CSRF header, `Idempotency-Key` (except the secret route), and a console command body (`contractVersion: "1.0.0"`, `idempotencyKey`, `reason`). Errors use the contract envelope with the reason in `details.reason`, explained by the locale keys `providers.reasons.<code>`.

| Route | Who | Result |
|---|---|---|
| `GET connections`, `GET connections/:id` | staff with a providers permission at the hub | `ConnectionViewSchema` with secret versions (references only), the last test, the kill state and the enabling digest |
| `POST connections`, `POST connections/:id/update` | `admin.providers.connection.edit` | A draft connection; changing where data goes returns it to draft |
| `POST connections/:id/secret` | `admin.providers.secret.write` | The new `SecretRef` (rotation keeps the previous version for `graceHours`, then the worker destroys it); never idempotency-recorded |
| `POST connections/:id/secret/revoke` | `admin.providers.secret.write` | Every version destroyed; the connection is disabled |
| `POST connections/:id/test` | `admin.providers.test` | A synthetic test result |
| `POST connections/:id/enable`, `.../disable` | `admin.providers.toggle` | Applied, or `pending_second_person` for non-fake connections |
| `GET egress`, `POST egress` | `admin.providers.egress.edit` | Current cells and history; a non-public allow asks a second person |
| `GET routes`, `POST routes`, `POST routes/:id/activate`, `.../disable` | `admin.models.route.edit`, `admin.models.route.activate` | Versions per job and scope; non-public activation asks a second person, never the drafter alone |
| `POST explain` | staff with a providers permission | The call gate's decision for a described call, nothing reserved |
| `GET caps`, `POST caps`, `POST caps/:id/update`, `.../retire` | `admin.providers.budget.edit` | Caps with spend, reservations and state |
| `GET pricing`, `POST pricing` | `admin.providers.connection.edit` or `admin.providers.budget.edit` | Versioned cost records |
| `GET usage?from&to` | staff with a providers permission | `UsageAggregateSchema` rows by day, job, connection, model, pipeline and module (the ledger holds no person) |
| `GET changes` | staff with a providers permission | The change log with before and after values |
| `GET kill-switches`, `POST kill-switches`, `POST kill-switches/:id/release` | `admin.providers.kill` | Engage at once; release with a second person and an incident note |

## For other packages

- `ProviderCallGate` (exported by `ProvidersModule`): `authorize(ProviderCallRequest)`, `withSecret(decisionId, connectionId, fn)`, `settle(...)`, `release(...)`. The worker uses `providerCalls` of the repository directly (the gate functions are granted to `trustwork_worker`).
- `ProviderAdapterRegistry` (exported): live adapters register by adapter id; each is engine code with a fake.
- Notices (outbox intents, identifiers only): `providers.connection_enabled`, `providers.secret_written`, `providers.secret_revoked`, `providers.route_activated`, `providers.kill_engaged`, `providers.kill_released`, `providers.cap_alert`, `providers.cap_exhausted`. Their mail templates are a MAIL follow-up.

## Known limits

- Connections are hub-scoped; node-scoped connections (object storage for the whole node) need the node console (follow-up).
- Live network adapters, the SSRF-safe egress fetcher for sanctions lists (SANC-002's `live` mode) and model calls are LLM-001 and the integration packages; this module provides the gate, the secrets and the registry they use.
- A new egress cell does not yet re-open the `ai_egress_policy_reviewed` launch gate automatically (HUB-001 owns the gates; follow-up).
- Fakes are not exempt from default-deny egress (integrator decision 2026-11-01): the demo and development seed must create an explicit public allow cell for fake connections (seed follow-up).
- Connection tests call the adapter inside the request transaction (15 s timeout); they move to a background job once real adapters exist (LLM-001 follow-up).
- Cost estimates are the caller's upper bound in the hub's currency; there is no currency conversion of cost records.

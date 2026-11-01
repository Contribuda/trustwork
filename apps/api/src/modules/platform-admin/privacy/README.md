# Privacy operations (PRV-001)

Status: **partial implementation, blocked for acceptance**. This is not a full subject export or a released erasure executor. Nothing is deployed. [Coverage and remaining seams](../../../../../../docs/data/privacy-operations.md) are part of the hand-back.

The composition root registers the module independently of the administration workspace. It injects an export port that calls the existing owning-module services and projection serializers in the requester's principal transaction. Privacy does not import their services or obtain maintenance authority. Export delivery has no billing/entitlement dependency.

| Route | Authority and effect |
|---|---|
| `GET /v1/privacy/requests` | Own authorized subject requests; company rights are checked again |
| `POST /v1/privacy/requests` | Self or current company administrator; access, erasure, correction or objection intake |
| `GET /v1/privacy/preferences` | Own preference data |
| `POST /v1/privacy/preferences` | Own sale/share/sensitive/GPC/marketing preferences; GPC and marketing objections cannot be accidentally cleared by concurrent updates |
| `POST /v1/privacy/exports` | Creates a request with an explicit incomplete coverage manifest |
| `GET /v1/privacy/exports/:id` | Authenticated delivery, recomposed under current authority; local FILE/blob fake only; JSON with SHA-256; no provider URL |
| `POST /v1/privacy/public/marketing-objections` | Unregistered constant acknowledgement; minimal durable MAIL suppression |
| `POST /v1/privacy/public/sourced-requests` | Opaque proof bound to action/record/current authority; constant acknowledgement |
| `POST /v1/admin/privacy/source-proofs` | Human verification note and exact current case grant; client retains proof capability |
| `POST /v1/admin/privacy/plans` | Human proposal with exact inventory, subject/policy/hold/version digest |
| `POST /v1/admin/privacy/plans/:id/approve` | Distinct current reviewer, exact case grant and unchanged digest |
| `POST /v1/admin/privacy/plans/:id/execute` | Current two-person authority and same-transaction gates; refuses missing owning capabilities |
| `POST /v1/admin/privacy/holds` | Elevated platform privacy officer; subject lock and audit |
| `POST /v1/admin/privacy/holds/:id/release` | Elevated platform privacy officer; subject lock and audit |
| `POST /v1/admin/privacy/requests/:id/erasure-readiness` | Elevated privacy erasure permission; always fails closed on a hold, UNKNOWN country policy or missing adapters |

The five mutations are registered as `in_transaction`: persistence, audit where applicable and the idempotency response commit together. Per-module crash cases cover all five. Requests and preferences do not emit payloads into notifications or logs. Staff reasons are fixed category codes on the API; correction text stays in the protected request row.

No country policy is seeded. Missing or unreviewed values remain `UNKNOWN`, with null deadlines and retention. Only a sourced, reviewed policy row can supply a request deadline and retention bound. The positive tests use `ZZ`, an `example.invalid` source and an explicitly synthetic policy, not a statement of country law. This slice does not turn a requester-supplied country into a jurisdiction determination.

The journal is a local fixture foundation, with independently provisioned retained identity/checkpoint and a hash-chained sequence. `authorizeLocalPrivacyRestore` requires a separately pinned retained-authority binding; a ledger object or fresh path is insufficient. An exclusive retained-directory lock covers writers, snapshot, replay, DB commit and fence lift. Restore permanently seals the journal against later unfenced appends. Process death or an uncertain failure leaves the lock and runtime fence closed; no automatic lock recovery or bypass exists.

Only privacy-owned correction redaction, restrictive reads and suppression replay are implemented. Legal holds, corrupt/missing/wrong/rolled-back journals and unsupported module records prevent local authorization. Real filesystem child-process and PostgreSQL tests cover both race orders and post-commit/pre-lift process death.

The existing OPS-003 CLI remains the path for installations that have never enabled PRV-001 subject erasure; this release cannot enable it in production. Local replay is isolated, with no environment fallback or production provisioning. An installation with prior erasure decisions cannot use the legacy CLI as a fallback. Production enablement requires a retained installation registry enforced by every startup, writer and restore, plus a real erasure executor and durable authority storage. The [protocol, trust assumptions and compatibility boundary](../../../../../../docs/data/privacy-operations.md#retained-journal-foundation-local-proof-only) are explicit; local fixture durability is not a production recovery claim.

The continuation exports additional owning identity, plans, communications, execution, trust, reputation, support, tasks and billing projections, while keeping `complete: false`. The explicitly local CLI wrapper requires a pre-provisioned independent journal binding. Replay enqueues durable propagation intents; absent retrieval/federation adapters leave them pending. No external transport is enabled.

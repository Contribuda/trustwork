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
| `POST /v1/admin/privacy/holds` | Elevated platform privacy officer; subject lock and audit |
| `POST /v1/admin/privacy/holds/:id/release` | Elevated platform privacy officer; subject lock and audit |
| `POST /v1/admin/privacy/requests/:id/erasure-readiness` | Elevated privacy erasure permission; always fails closed on a hold, UNKNOWN country policy or missing adapters |

The five mutations are registered as `in_transaction`: persistence, audit where applicable and the idempotency response commit together. Per-module crash cases cover all five. Requests and preferences do not emit payloads into notifications or logs. Staff reasons are fixed category codes on the API; correction text stays in the protected request row.

No country policy is seeded. Missing or unreviewed values remain `UNKNOWN`, with null deadlines and retention. Only a sourced, reviewed policy row can supply a request deadline and retention bound. The positive tests use `ZZ`, an `example.invalid` source and an explicitly synthetic policy, not a statement of country law. This slice does not turn a requester-supplied country into a jurisdiction determination.

The authoritative erasure journal is outside the restorable database, in a separate local fake bucket. Database replay receipts are not authoritative. Records are content-addressed, verified on read and reject conflicting decisions. The primitive has no delete API. It is not a production WORM storage guarantee, a subject-verification service, or an authorization to execute erasure. No runtime route appends an erasure decision in this slice.

Restore authorization now requires the independent journal and an applied runtime fence. It replays within the restore owner transaction before the fence lifts. Missing, corrupt, unsupported or held decisions abort authorization. Only the `privacy` replay adapter exists: it redacts correction payloads, denies restored request/export/preference reads, and restores suppression/do-not-collect digests. Other module decisions keep the restore fenced. The fixture drill restores privacy rows; it does not prove whole-account erasure or a full physical-backup recovery.

The local bucket is `trustwork-privacy-ledger` under the operator's existing `FILES_FS_ROOT` (or the FILE fake's default root). Keep that bucket outside database/object snapshots and retain it across restores. Production/provider configuration is refused. Operators must not point restore at a new empty journal; there is no production provisioning or cross-process writer-freeze protocol in this slice.

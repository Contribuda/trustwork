# API and read-model contracts

**Implemented (checked 2026-10-31):** `GET /health` and `GET /health/live` (process liveness; `externalProviders` reports the configured sign-in provider mode `disabled`, `fake` or `live`, `HealthSchema`), `GET /health/ready` (database reachable and migration ledger verified, 200/503, `ReadinessSchema`; OPS-001); `/v1/auth/*` (signup, verify-email, login, logout, recovery, recovery/complete, step-up, provider start/callback, link/unlink, fake identity in fake mode); `/v1/me` (profile, sessions, revoke, revoke-others, password, e-mail); `/v1/people/:id`, `/v1/companies/:id` and company memberships (list, invite, accept, change, end); the directory module (BE-003): `POST /v1/companies`, `GET /v1/people`, `/v1/companies`, `/v1/projects`, `/v1/me/projects` (cursor pagination), lookups by handle (`/v1/{people,companies,projects}/by-handle/:handle`, `/v1/handles/:kind/:handle`) and handle changes (`POST /v1/me/handle`, `/v1/companies/:id/handle`, `/v1/projects/:id/handle`), see [the module README](../../apps/api/src/modules/directory/README.md); `/v1/projects` (create, read, leader, publish, transfers with consent, participants); commerce slice 1 (COM-001): `/v1/catalogue` (offerings, versions, private knowledge, public catalogue), `/v1/needs` (intake, clarification, conversion), `/v1/rfqs` (drafts, publication, amendments, private constraints, invitations, projection, close) and `/v1/rfq-invitations` (the supplier side), see [the procurement module README](../../apps/api/src/modules/procurement/README.md); files (FILE-001, mounted only with configured storage): `/v1/files` (uploads with signed PUT URLs, completion, metadata, listing by parent, signed downloads, copy, move, deletion), see [the files module README](../../apps/api/src/modules/files/README.md). Every other route in the table below is **contract only**: its schemas exist, the API does not serve it. The generated OpenAPI 3.1 document for the implemented routes is `apps/api/openapi/openapi.json` (`npm run openapi -w @trustwork/api`; its route list is still written by hand, DOC-002 generates it from the registered routes and publishes a reference page). The conventions below are the **frozen v1 contract** (FND-002, accepted by integrator 2026-10-27; see [ADR 008](../adr/008-contracts-and-validation.md)); the schemas in [`packages/contracts/src`](../../packages/contracts/src/index.ts) are the single source of truth and every example here is validated by `tests/contracts/*.test.ts`.

## Transport rules

- **Single public origin.** The web app and the API share one origin; `/v1/*` is proxied to the Nest process. No CORS for first-party traffic. Session cookie `__Host-sr_session` (opaque token, hashed server side), pre-login flow cookie `__Host-sr_flow`. Mutations require the custom header `X-Trustwork-Request: 1` plus `Sec-Fetch-Site`/`Origin` verification (ADR 002 amendment). GET never mutates; logout is POST.
- **Identifiers** are opaque tokens (`IdSchema`: `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`); persistence generates UUIDs. Identifiers never grant access.
- **Time.** RFC 3339 UTC (`Z` only) for events; `{ date, timeZone }` for business dates with local meaning.
- **Money** `{ "minorUnits": "12345", "currency": "UZS" }` with `minorUnits` matching `^-?(0|[1-9]\d*)$` and ISO 4217 currency; never a JSON number. **Quantities** `{ "value": "10.5", "unit": "m2" }` with exact decimal strings (max six fractional digits) and unit codes from the catalogue. Arithmetic is same-currency / same-unit only (`addMoney`, `sumMoney`, `addQuantity` throw `commercial.currency_mismatch` / `validation.unit_mismatch`); mixed-currency comparison needs an explicit `ExchangeRateSnapshot`.
- **Text** is NFC-normalized at validation (Zod `overwrite`) so stored bytes equal digested bytes. E-mails are lower-cased.
- **Validation.** Every command, query and read model is a Zod 4 `strictObject`: unknown fields are rejected (`validation.unknown_field` / `validation.schema`), so mass assignment is impossible by construction. JSON Schema (draft 2020-12) is generated from the same schemas (`contractJsonSchemas()`), never hand-maintained. `z.toJSONSchema` drops `refine` invariants (digest equality, actor != approver, expiry windows, totals recomputation): generated schemas describe shapes only and OpenAPI consumers must not treat them as the full invariant set.
- **Entries.** `@trustwork/contracts` is the server barrel (adds `computeDigest`/`verifyDigest` and `server/commercial.ts`: `checkAcceptance`, digest computation, `AgreementSchema`/`AcceptanceEventSchema` with digest refinements). `@trustwork/contracts/client` carries schemas, types and pure guards only (no `node:` imports); browsers compare digests, never compute them.
- **Pagination.** `PageRequest { limit <= 100, cursor? }`; cursors are opaque base64url of `{ sortKey, id }` and are audience-checked on use. Pages return `{ items, nextCursor }` only; no unrestricted totals.

## Error envelope

```json
{ "code": "commercial.stale_version", "message": "quote answers a superseded RFQ version", "details": { "quoteVersionId": "quote-amend-v1", "currentRfqVersionId": "rfq-amend-v2" }, "requestId": "req-fixture" }
```

`code` is a stable English machine code from `ERROR_CODES` with the namespaces `auth.*`, `access.*`, `commercial.*`, `membership.*`, `validation.*`; the web maps it to the locale key `error.<code>` in the reader's language, falling back to `error.generic` (contracts carry no human-language text). `httpStatusFor(code)` fixes the HTTP status (for example `access.not_found` 404, `validation.revision_conflict` 409, `auth.step_up_required` 403, `commercial.stale_version` 409, `auth.recovery.on_hold` 409: a recovery held by the corporate-mailbox policy is a conflict with that policy, never a success). `details` never carries private values or hints about foreign objects.

**Disclosure rule.** `disclosureCode(existenceKnownToPrincipal)`: `access.not_found` whenever existence is not already known to the principal; `access.forbidden` only when it is (for example own membership ended). Counts, autocomplete, search and attachment URLs follow the same rule.

## Idempotency and revisions

Every mutation carries `Idempotency-Key` (`IdempotencyKeySchema`). The server scopes it as `(principalId, action, contextId, key)` (`buildIdempotencyScope`) and stores the canonical payload digest. Same key + same payload returns the recorded result; same key + different payload -> `validation.idempotency_conflict`; unfinished -> `validation.idempotency_in_progress`. The key is never authorization. Versioned edits send `expectedRevision`; a mismatch -> `validation.revision_conflict`, never a lost update. Durable commands answer `CommandAccepted { actionId, state: proposed|authorized|reserved|queued, revision }`; an acknowledgement never implies that the external effect happened.

## Projection layers

Five layers, each an explicit allowlist serializer in `packages/contracts` used identically by API reads, search hits, exports and notifications: `public`, `shared_party`, `party_private`, `owner_private`, `staff_case`. Grants carry `audience ∈ { shared_party, party_private, owner_private }`; `public` is implicit, `staff_case` comes only from a case grant. Serializers: `toPublicPerson`, `toPublicCompany`, `toPublicProject` / `toParticipantProject` (shared milestones without budgets), `toPublicOfferingVersion`, `toPublicRfq` / `toSharedRfqVersion`, `toSharedQuoteVersion` (quotes are never public), `toSharedAgreement` / `toBuyerAgreement` / `toSellerAgreement` (agreements are never public; buyer budget/approval references and seller fulfilment plan live in separate `AgreementBuyerPrivate` / `AgreementSellerPrivate` records), `toSessionView`. Forbidden-field tests prove the absence of `budgetCeiling`, `floorPrices`, `marginTargets`, `costBasis`, `transactionBudgetId`, `tokenHash`, `emailBindings`, `privateFiles` and similar fields.

## Immutable commercial versions

`VersionRef = { id, version, digest }` pins by `id` and verifies by `digest` (`trustwork-digest-1`, [ADR 003](../adr/003-snapshots-evidence-and-authority.md)). Published RFQ versions and sent quote versions are immutable (`rfqVersionMutable`/`quoteVersionMutable` are true only for drafts; the database adds `reject_update_when_frozen`). Invitations and quote versions pin the exact `rfq_version_id`. Staleness is decided by identity: `isQuoteStale(rfqVersionId, currentRfqVersionId)`; an amendment sets `staleReason: "rfq_amended"` on the envelope and on every pinned response; status is unchanged (there is no `stale` status). `checkAcceptance` requires identity and `sent` status, re-verifies the stored quote and RFQ payloads against their recorded digests, reads expiry from the frozen `payload.validity.until` (the `validUntil` column must mirror it), and then compares the supplied `VersionRef` id, version and digest; a v1 quote after a v2 amendment answers `commercial.stale_version`, a tampered row or substituted digest `commercial.digest_mismatch`. `reject_update_when_frozen` also covers `valid_until`, `sent_at`, `sent_by`, `published_at`, `published_by`. The agreement digest is computed once over `{ quoteVersion, rfqVersion }` and acceptance events must reference it. Fixture: [`rfq-amendment.json`](../../packages/contracts/fixtures/rfq-amendment.json).

| Planned resource | Commands / reads | Critical condition |
|---|---|---|
| `/v1/auth/*`, `/v1/me`, `/v1/me/sessions` | signup/login/verify/recovery/link/change-email/session revoke (`SignupCommand`, `LoginCommand`, `RecoveryRequestCommand`, …) | Password primary; no session before e-mail verification; provider identity `(provider, subject)`; no auto-link by e-mail; `SessionView` has no `tokenHash` |
| `/v1/companies/:id/memberships` | invite/accept/change/end | One active employer (`membership.already_employed`), last administrator kept, revocation sequence on end |
| `/v1/projects/:id` | create/read/edit/transfer/assign-leader/publish | Owner person XOR company; transfer needs recipient consent (`commercial.transfer_consent_pending`); public serializer |
| `/v1/rfqs/:id/versions`, `/v1/rfqs/:id/invitations` | draft/publish/invite/amend/close | Immutable published versions; invitation and quote pin `rfq_version_id`; amendment flags `staleReason` |
| `/v1/catalogue/:id/versions` | draft/revise/publish selected fields | Published version immutable; `publicFields` allowlist; `privateKnowledge` excluded |
| `/v1/quotes/:id/versions` | draft against current RFQ version/send/withdraw/compare | `commercial.rfq_version_not_current` for drafts; immutable sent snapshot; comparison `current` vs `historical` mode |
| `/v1/agreements`, `/v1/orders` | accept terms/place/accept/change/cancel | Exact digest binding; transaction budget reservation; buyer placement and seller acceptance distinct |
| `/v1/execution/:id` | deliver/record-work/accept/dispute | Claim vs confirmation (`DeliveryClaim`, `AcceptanceRecord`, `Assertion`) |
| `/v1/publications`, `/v1/issues` | draft/review/schedule/publish/correct/retract; curate/release | Authorship vs edit rights; released issues frozen; corrections are new editions |
| `/v1/assistant/mandates`, `/v1/assistant/runs` | grant/revise/suspend/revoke; approve; reconcile | `Mandate` capped by current rights; `Approval` bound to `actionDigest`; `ExternalOutcome` unknown/acknowledged/final with `Reconciliation` |
| `/v1/billing/*`, `/v1/admin/commerce/*` | price acceptance/subscribe/reserve/settle/refund; price versions | `Budget.kind` transaction vs platform; `PriceVersion` activated by a second person, no back-dating; `PriceAcceptance` immutable |
| `/v1/admin/*` | staff roles, case grants, audit browse | `admin.<domain>.<action>` permissions, A+2 approvals bound to an action digest, `CaseAccessGrant` <= 72 h with requester != approver |
| `/v1/search`, `/v1/assistant/answers`, `/v1/citations/:id` | see [retrieval API](retrieval-api.md) | Typed filters, structured facts, serialized egress/delivery admission |

## Example command

```json
{
  "action": "place_order",
  "context": { "kind": "project", "id": "project-fixture" },
  "agreementId": "agreement-fixture",
  "quoteVersion": { "id": "quote-v3-fixture", "version": 3, "digest": { "algorithm": "trustwork-digest-1", "value": "<64 hex>" } },
  "rfqVersion": { "id": "rfq-v2-fixture", "version": 2, "digest": { "algorithm": "trustwork-digest-1", "value": "<64 hex>" } },
  "expectedRevision": 4,
  "mandateId": "mandate-fixture",
  "mandateRevision": 2,
  "transactionBudgetId": "budget-fixture",
  "platformBudgetId": null,
  "idempotencyKey": "fixture-unique-request"
}
```

`PlaceOrderCommandSchema` rejects any `principalId`, `total` or other client-supplied field: the server derives the principal from the session or delegation and obtains money and terms from the immutable quote version. A nullable `platformBudgetId` is allowed only when no platform charge occurs. Response on success: `CommandAccepted`.

## Read models

- **Public directory/search:** published allowed fields, sourced/claimed/verified labels, evidence date and permissions; no private owner keys or company economics. Public people require `profileVisibility: public`.
- **Daily overview:** permission-scoped decisions, buying/selling work, projects and events. No employer employee-surveillance aggregate.
- **Quote comparison:** `comparableQuoteVersions` splits versions pinned to the current RFQ version from historical ones; historical mode shows no ranking and no totals. Raw heterogeneous quotes remain available to permitted participants.
- **Company/personal walls:** references to the same publication versions with audience checks.
- **Assistant activity:** structured runs/actions/approvals/receipts; negotiation floors redacted from counterparty/shared views.
- **Magazine:** issue metadata, ordered items pinned to publication versions, separate render artifacts.

Projection handlers use outbox events, access epoch and rebuild checkpoints. Revocation invalidates cached/indexed private data promptly; async lag must not extend authorization (`PolicyCacheKey` includes person and company epochs and the resource revision).

[Retrieval ports and proposed routes](retrieval-api.md) cover typed filters, structured facts, citations, freshness and final admission.

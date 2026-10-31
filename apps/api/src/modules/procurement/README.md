# Procurement module: needs, RFQs and invitations (COM-001)

Commerce slice 1 on the buyer side, up to invitations ([Buying and selling](../../../../../docs/engine/commerce.md), [Procurement and supply](../../../../../docs/engine/modules/procurement-and-supply.md), PRC-F01 and PRC-F02). Contracts: the frozen [`procurement.ts`](../../../../../packages/contracts/src/procurement.ts) plus the slice layer [`commerce.ts`](../../../../../packages/contracts/src/commerce.ts). Storage: [`packages/data/migrations/commerce`](../../../../../packages/data/migrations/commerce), [`packages/data/src/repositories/commerce.ts`](../../../../../packages/data/src/repositories/commerce.ts). The catalogue lives next door in [`../catalogue`](../catalogue/README.md). Quotes, agreements and orders are COM-002.

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key`. Every action completes its idempotency record inside its own request transaction (BE-005, `in_transaction` in `apps/api/src/common/idempotency/routes.ts`) and is crash-tested in `tests/backend/idempotency/crash.test.ts`. Errors use the contract envelope; specific reasons are in `details.reason`.

## Who may do what

| Object | Owner side | Others |
|---|---|---|
| Need | The owner person; members of the owner company holding `company.deals.manage` | `404` |
| RFQ | The access policy for resource kind `rfq`: the owner person, owner company members with `company.deals.manage` (publishing and closing included, integrator decision applied in COM-002; `company.publish` only for the public projection), or a live participation with a party-private or owner-private audience carrying the capability | Invited parties get the supplier view; everyone else `404` |
| Invitation | The buyer side invites, revalidates and withdraws | The invitee (a person, or members of the invited company holding `company.deals.manage`) records `viewed` or `declined` |

The database repeats every rule under FORCE RLS (`trustwork.rfq_can`, `trustwork.rfq_invitee`, `trustwork.commerce_party_acts`) and in guards, so a bug in this layer cannot widen access.

## Routes

| Route | Result |
|---|---|
| `GET /v1/needs`, `POST /v1/needs`, `GET /v1/needs/:id`, `POST /v1/needs/:id` | Owner-private intake. Each save stores a new line set tagged with the need revision (append-only) and recomputes `missingFields` (lines, kind, quantity, region, window, acceptance) and the status `draft`, `clarifying` or `ready` |
| `POST /v1/needs/:id/convert` | A ready need converts once into an RFQ draft whose lines keep the need line ids; the need is then `converted` and frozen |
| `GET /v1/rfqs`, `POST /v1/rfqs` | The buyer's RFQs; a new RFQ with draft version 1 and its buyer-private record. `source: { kind: 'plan_item', projectId, itemKey }` turns a homeowner's plan item of kind `purchase` or `material` into the RFQ and records the path `rfq` on the item (ADR 012 decision 37: works become tasks; a company buys through requisitions, `details.reason = requisition_required`) |
| `GET /v1/rfqs/:id` | Buyer side: `OwnerRfqView` (envelope, every version, private constraint, every invitation, origin). Invitee: `SupplierRfqView` (buyer party, status, the versions its own invitations pin, its own invitations without the sender or mandate). Otherwise `404` |
| `POST /v1/rfqs/:id/versions/:versionId` | Saves the open draft with the envelope `expectedRevision`; a published version is `409 commercial.version_immutable` |
| `POST /v1/rfqs/:id/versions` | Opens an amendment: the next version, a copy of the current one, with its reason |
| `POST /v1/rfqs/:id/publish` | `PublishRfqVersionCommand`: supersedes the current version, records the `trustwork-digest-1` of the stored payload and moves the pointer; in the same transaction every invitation pinned to an earlier version is flagged `stale_reason: rfq_amended` |
| `POST /v1/rfqs/:id/private` | Buyer-private budget ceiling, evaluation weights, notes and shortlist; audit rows name the change, never the values |
| `POST /v1/rfqs/:id/invitations` | `InviteSupplierCommand` pinned to the current published version (`409 commercial.rfq_version_not_current` otherwise); one invitation per party and version; never the buyer itself |
| `POST /v1/rfqs/:id/invitations/:invitationId/revalidate` | A new invitation for the same party pinned to the current version; the stale one stays as history |
| `POST /v1/rfqs/:id/invitations/:invitationId/withdraw`, `POST /v1/rfq-invitations/:invitationId/respond` | Transitions `sent -> viewed -> declined`, `responded` (COM-002), `withdrawn`; a stale invitation is answered only after revalidation |
| `GET /v1/rfq-invitations` | Invitations addressed to the principal or its employer, newest first |
| `POST /v1/rfqs/:id/projection`, `GET /v1/rfqs/:id/public` | The public projection (allowlisted fields of the current published version) only when the buyer enables it |
| `POST /v1/rfqs/:id/close` | Closed or cancelled; every invitation not yet stale is flagged `rfq_closed` |

## Privacy and payment

- Supplier views, the invitation list, the public projection and outbox payloads never carry the private constraint, other invitations, the origin, the creator or the sender (`SUPPLIER_FORBIDDEN_KEYS`, tested field by field and value by value).
- Outbox events carry identifiers only (`COMMERCE_EVENT_PAYLOAD_KEYS`); the notification consumer (MAIL-001 outbox) reads the supplier view under the invitee's own authority.
- No ordering reads billing, entitlement, subscription or sponsorship data: `orderInvitations` is newest first, then by id (equality tests compare results with and without entitlements).

## Agents

Commands accept `actor: { via: 'agent', mandateId }`: drafts need a `prepare` mandate, publishing and closing `publish`, invitations `communicate`. The `CommerceMandatePort` decides; the default `NoCommerceMandates` refuses every agent request (`403 access.mandate_scope`) until the mandate store exists. Registry entries: `COMMERCE_CAPABILITIES` in `commerce.ts` (ADR 010 decision 23); `sourcing_desk.draft_rfq` and `sourcing_desk.publish_rfq` are declared by PRC-000 and served here.

## Tests

`tests/commerce/procurement/contracts.test.ts`, `database.test.ts` (RLS, guards and concurrency under the runtime role), `api.test.ts` (the journey through HTTP with negative authorization, forbidden fields, payment equality, agents and plan items).

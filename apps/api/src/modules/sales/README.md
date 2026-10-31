# Sales module: quotes, negotiation and comparison (COM-002)

Commerce slice 2, the seller's side and the buyer's comparison ([Buying and selling](../../../../../docs/engine/commerce.md), [Sales](../../../../../docs/engine/modules/sales.md)). Contracts: the frozen [`sales.ts`](../../../../../packages/contracts/src/sales.ts) plus the slice layer [`deals.ts`](../../../../../packages/contracts/src/deals.ts). Storage: [`packages/data/migrations/transactions`](../../../../../packages/data/migrations/transactions), [`packages/data/src/repositories/transactions.ts`](../../../../../packages/data/src/repositories/transactions.ts). Agreements and orders are next door in [`../transactions`](../transactions/README.md); RFQs and invitations in [`../procurement`](../procurement/README.md).

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key`. Every action completes its idempotency record inside its own request transaction (BE-005, `in_transaction` in `apps/api/src/common/idempotency/routes.ts`) and is crash-tested in `tests/backend/idempotency/crash.test.ts`. Errors use the contract envelope; specific reasons are in `details.reason`.

## Who may do what

| Object | Seller side | Buyer side | Others |
|---|---|---|---|
| Quote | The invited party: the seller person, or members of the seller company holding `company.deals.manage` | The RFQ owner side (the access policy for resource kind `rfq`): reads sent versions as shared projections, compares, requests amendments (`negotiate`) | `404` |
| Seller private constraint (floors, margins, cost basis, notes) | Read and write | Never | Never |

The database repeats every rule under FORCE RLS (`trustwork.quote_side`, `trustwork.rfq_can`) and in guards.

## Routes

| Route | Result |
|---|---|
| `GET /v1/quotes`, `POST /v1/quotes` | The seller's quotes; a new quote with draft version 1 pinned to the current published RFQ version and its private constraint. The seller needs a live invitation pinned to that version (`403 not_invited` without one, `409 commercial.rfq_version_not_current` with `invitation_stale` after an amendment) |
| `GET /v1/quotes/:id` | Seller: `SellerQuoteView` (every version, drafts included, the private constraint, rounds, requests). Buyer side: `BuyerQuoteView` (sent versions through `toSharedQuoteVersion`, without catalogue provenance or who sent them). Otherwise `404` |
| `POST /v1/quotes/:id/versions` | A new draft (a negotiation round, an answer to an amendment request, or a revalidation) pinned to the current RFQ version; `revalidatedFrom` names the earlier version it replaces |
| `POST /v1/quotes/:id/versions/:versionId` | Saves the open draft with the envelope `expectedRevision`; a sent version is `409 commercial.version_immutable` |
| `POST /v1/quotes/:id/private` | The seller's floors, margins, cost basis and notes; audit rows name the change, never the values |
| `POST /v1/quotes/:id/send` | Recomputes the totals, checks that the pin is still the current published RFQ version and the invitation current, writes the frozen line projection and the tax determinations, supersedes the previous sent version, records `trustwork-digest-1` over `{ rfqVersion, payload }`, marks the invitation `responded`, answers the request and records a negotiation round, in one transaction |
| `POST /v1/quotes/:id/withdraw` | Withdraws the current sent version (not while an agreement on the quote is live) |
| `POST /v1/quotes/:id/amendment-requests`, `.../:requestId/withdraw` | Buyer side: structured changes on exact lines of the current sent version (quantity, target unit price, reason) and an optional target total; the answer is a new quote version |
| `GET /v1/rfqs/:id/comparison?mode=current\|historical` | Buyer side: `current` compares sent versions pinned to the current RFQ version line by line (`matched`, `quantity_differs`, `unit_differs`, `substitution`, `missing`); a total appears only when every line matched in the RFQ currency and the quote is valid, otherwise `notTotalledBecause` says why. Unsolicited lines and the seller's exclusions are listed. Everything else is `historical`, without totals or ranking |

## Staleness

An RFQ amendment flags, in the same transaction (database trigger), every quote version pinned to an earlier RFQ version `stale_reason: rfq_amended` (a flag, never a status) and every quote whose current sent version is; closing flags them `rfq_closed`. Version flags are never cleared; the quote's flag clears when a revalidated version pinned to the current RFQ version is sent. A quote for quantity 10 in v1 is therefore never compared or accepted as quantity 100 in v2 (tested in the API and the database).

## Tax

Each sent line names how its tax was determined (`tax_determination`, never a hard-coded rate). This slice records the seller's stated term as `provider: seller_stated` with the RFQ delivery region as the jurisdiction; a country-pack or adapter determination (US state and local sales tax, INTL-US) plugs in through `TaxDeterminationPort`.

## Agents and private constraints

Commands accept `actor: { via: 'agent', mandateId }`: drafts need `prepare`, sending and withdrawing `send_quote`, amendment requests `negotiate`. The `DealMandatePort` decides (money actions pass the amount); the default `NoDealMandates` refuses every agent request (`403 access.mandate_scope`) until the mandate store exists (AST-001). In addition the seller's agent never sends a price below the seller's own floor and the buyer's agent never proposes a total above the buyer's private ceiling (`access.mandate_scope`, `details.reason = outside_private_constraints`; the error never names the value). Chat text never authorizes anything. Registry entries: `DEAL_CAPABILITIES` in `deals.ts` (ADR 010 decision 23).

## Privacy and payment

Buyer views, comparisons and outbox payloads never carry the seller's private constraint, catalogue provenance or sender (`BUYER_FORBIDDEN_KEYS`); seller views never carry the buyer's ceiling, weights, notes, shortlist or budget identifiers (`SELLER_FORBIDDEN_KEYS`), tested field by field and value by value. Outbox events carry identifiers only (`DEAL_EVENT_PAYLOAD_KEYS`); notifications (MAIL-001) read projections under the recipient's authority. Comparison order is newest send first; no payment, entitlement or sponsorship input exists (equality test).

## Tests

`tests/commerce/transactions/contracts.test.ts`, `database.test.ts` (RLS, guards, staleness and concurrency under the runtime role), `api.test.ts` (the journey through HTTP with negative authorization, forbidden fields, agents and concurrency).

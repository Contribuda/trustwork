# Transactions module: agreements, acceptance, orders and changes (COM-002)

Commerce slice 2, after the quote ([Buying and selling](../../../../../docs/engine/commerce.md#7-agreements-and-orders)). Contracts: the frozen [`transactions.ts`](../../../../../packages/contracts/src/transactions.ts) (extended by ADR 012 decision 19: `termsKind`), [`server/commercial.ts`](../../../../../packages/contracts/src/server/commercial.ts) and the slice layer [`deals.ts`](../../../../../packages/contracts/src/deals.ts). Storage: [`packages/data/migrations/transactions`](../../../../../packages/data/migrations/transactions). Quotes are in [`../sales`](../sales/README.md).

## The flow

```text
sent quote version (current RFQ version) → buyer accepts terms (accepted_by_buyer)
  → buyer places the order (commit_order + transaction-budget reservation) → seller accepts the order (accepted_by_both)
  → order changes: a newer sent version agreed by both supersedes the agreement
  (before the seller accepts: the seller declines, or the buyer withdraws / cancels the order)
```

| Route | Who | Result |
|---|---|---|
| `GET /v1/agreements`, `GET /v1/agreements/:id` | Either party | `BuyerAgreementView` or `SellerAgreementView`: the shared agreement (`toSharedAgreement` allowlist) with the caller's own private half, acceptance events without mandates, budgets or reservations, orders (the seller never sees the reservation) and order changes. Others `404` |
| `POST /v1/agreements` | Buyer side (`accept` on the RFQ) | `AcceptTermsCommand` with `electronicRecords` consent: `checkAcceptance` recomputes both stored digests and refuses a quote pinned to an earlier RFQ version (`409 commercial.stale_version`), an unsent, expired or tampered one; the agreement digest is `trustwork-digest-1` over `{ termsKind, quoteVersion, rfqVersion }`; one live agreement per RFQ (the RFQ row is locked and a unique index backs it), so duplicate and concurrent acceptances get `409` |
| `POST /v1/agreements/:id/orders` | Buyer side (`commit_order`) | `PlaceOrderCommand`: the gross total comes from the immutable quote, never from the client; the transaction budget is reserved atomically in the same transaction (`409 commercial.budget_insufficient`, `403 commercial.authority_missing`); no platform charge in this slice (`platformBudgetId` must be `null`) |
| `POST /v1/agreements/:id/accept` | Seller | The seller states the digest it accepts; it must equal the digest recomputed from the stored versions (`409 commercial.digest_mismatch`). The agreement becomes `accepted_by_both`, the order `accepted`, the quote `accepted`; obligations are derived (deliver or perform by each milestone, pay and accept by the buyer) |
| `POST /v1/agreements/:id/decline` | Seller | Declined; the placed order is cancelled. The seller has no authority over the buyer's budget: the buyer releases the reservation (`POST /v1/orders/:id/cancel`) or it expires |
| `POST /v1/agreements/:id/withdraw`, `POST /v1/orders/:id/cancel` | Buyer side | Before the seller accepts: withdrawn, the order cancelled and its reservation released. After acceptance cancellation depends on what happened externally (execution and disputes, EXE-001) |
| `POST /v1/agreements/:id/private` | Each side, its own half | Buyer: approval references and notes; seller: fulfilment plan and notes. `expectedRevision` is the view's `privateRevision` |
| `POST /v1/orders/:id/changes`, `POST /v1/orders/:id/changes/:changeId` | Either party proposes; the counterparty accepts or rejects; the proposer withdraws | A change names a newer sent version of the same quote. Acceptance supersedes the agreement with a new one (`supersedes_id`), moves the order to it (`changed`), waives the old obligations and derives new ones; a higher total accepted (or proposed) by the buyer reserves the difference |

## Electronic records

Acceptance by either party is an electronic record. When the hub requires it (`ElectronicRecordsPolicySource`, default: required with the generic disclosure `trustwork.electronic-records.v1`), the request carries `{ consented: true, disclosureKey }` for the current disclosure and the acceptance event records the disclosure and its basis. `electronicRecordsFromPack('US')` cites the US country pack's ESIGN (15 U.S.C. 7001) and UETA facts (`US:eSignature/esign-act`, `US:eSignature/ueta`). The disclosure wording itself is a hub legal text for counsel (HUB-005).

## Money

Trustwork never holds participants' money (ADR 010 decision 20). An order is an instruction plus a reservation on the buyer's transaction budget (authority, not funds); payments go through licensed providers (PAY-001). Payment never reaches ranking, matching or reputation.

## Agents

`accept terms`, `place order`, `withdraw`, `cancel` and accepting a change by the buyer need a `place_order` mandate; the seller's acceptance or decline `accept_order`; proposing or rejecting changes `negotiate`. The default port refuses every agent request.

## Kinds of terms

`terms_kind` (`rfq_quote`, `task`, `consultation`, ADR 012 decision 19) is a column of the agreement and part of its digest. This slice creates `rfq_quote` agreements; task and consultation agreements are created by TASK-001 and CONS-001, which add their foreign keys and checks (the database refuses them until then, `details.reason = terms_kind_unavailable`).

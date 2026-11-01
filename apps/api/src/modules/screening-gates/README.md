# Screening gates (SANC-004)

The money and commitment gates of the sanctions compliance engine ([ADR 014](../../../../../docs/adr/014-sanctions-compliance-engine.md) decisions 9, 12, 13, 15 and 16; handbook [Sanctions compliance](../../../../../docs/engine/modules/sanctions-compliance.md), SNC-F07, SNC-F12, SNC-F14 and SNC-F19). Contracts: [`screening-gates.ts`](../../../../../packages/contracts/src/screening-gates.ts). Storage: [`packages/data/migrations/screening-gates`](../../../../../packages/data/migrations/screening-gates) (functions only, no table), [`packages/data/src/repositories/screening-gates.ts`](../../../../../packages/data/src/repositories/screening-gates.ts). It reads the effective state of SANC-003 (`screening_effective`, the same answer as the `screeningState(subject)` port) and the open holds of SANC-001; re-screening (SANC-005) keeps those states current.

Status: **Live** for quotes, acceptance, orders and order changes (sales and transactions modules) and for agent commits on their mandate path; the payee and payout-country helpers are **Live as a port** with a provider fake in the tests, waiting for their callers (PAY-001, BILL-002).

## What passes

Only a subject whose effective screening state holds no money and who has no open jurisdiction hold. A gate refuses when a subject is unscreened, has an `insufficient_name` result, an open or confirmed match, a result older than the active baseline versions, when the baseline is missing or stale, and when the state cannot be read at all. There is no setting, mandate, extension or staff role that turns a gate off.

| Act | Where | Subjects |
|---|---|---|
| Sending a quote version | `SalesService.send` | the seller party and the person sending (own), the buyer (counterparty) |
| Accepting terms | `TransactionsService.acceptTerms` | the buyer party and the person accepting (own), the seller (counterparty) |
| Placing an order | `TransactionsService.placeOrder` (before the budget reservation) | the buyer and the person ordering (own), the seller (counterparty) |
| The seller accepting an order | `TransactionsService.sellerAccept` | the seller and the person accepting (own), the buyer (counterparty) |
| Proposing or accepting an order change | `TransactionsService.proposeChange`, `decideChange` (accept) | the deciding side and its person (own), the other side (counterparty) |
| An agent commit (`send_quote`, `place_order`, `accept_order`, `register`, `release_payment`) | `ScreenedMandates`, wrapping the mandate port of the sales and transactions modules | the agent's principal, before the mandate is evaluated or a use recorded |
| A payout account or a payout | `PayoutGate` (for PAY-001 and BILL-002) | the payout country first, then the payee and the declaring person, then the provider |

Withdrawing, declining, cancelling and rejecting are never gated: stepping back from a commitment stays possible. Needs, RFQs and invitations (procurement) bind nobody and are not gated.

## No stale answer binds

`ScreeningGate.requireTransactable(trx, subjects, purpose)` runs inside the request transaction that writes the commitment, after the caller's own authority and mandate were checked and before anything is written. `trustwork.screening_gate_check` first takes, until that transaction ends, a share lock on the baseline list rows (a list activation updates them), on each subject's state row (every result and decision updates it) and a shared per-person advisory lock (every new hold takes the exclusive one through a trigger on `jurisdiction_hold`), and then reads with a fresh snapshot. A decision racing the commitment is therefore either seen, or waits until the commitment has committed (tested on PostgreSQL in both orders, and through the API).

## What each side is told

| Refusal | Code (HTTP) | Who | Details |
|---|---|---|---|
| The store cannot answer, or the baseline is missing or stale | `screening.unavailable` (409) | everyone (it is not about anyone) | `{ purpose }` |
| The caller's own person is held | `jurisdiction.restricted` (451) | the caller | `{ purpose }` |
| The caller's own person or company cannot transact | `screening.review_pending` (403) | the caller | `{ purpose, subject, messageKeys }`: a person's own status words of SANC-003 (`ownComplianceStatus`); for a company `screening.gate.companyPaused` and `screening.contact` (its administrators see the status on the company's compliance page) |
| The counterparty cannot transact | `commercial.counterparty_unavailable` (409) | the caller | none: one code and one message for a hold, a match, an unscreened or a stale subject alike |

The codes are local API codes (`LocalApiError`, `SCREENING_GATE_ERROR_STATUS`) until the frozen contract codes gain them. None is a 5xx, so a client never treats a refusal as an unknown outcome. The web shows `error.<code>` from `apps/web/locales/<lang>/core.json` inline on the affected form; an agent reports the same code in the person's decisions and never retries around it. Nothing of a refusal is stored, sent to the counterparty, or used by ranking, matching, recommendations or reputation.

## Payouts

`PayoutGate.requirePayoutCountry(declarer, country)` calls `trustwork.screening_gate_declare_place` in a transaction of its own: a payout country in a restricted place (the synced kernel list; an unsynced list counts every place as restricted) holds the declaring person (`jurisdiction_hold`, source `payout_country`, dataset `declaration`), commits, and refuses with `jurisdiction.restricted` before any provider is called. Only the caller can be held this way. `requirePayee` then gates the payee and the declaring person inside the money transaction; `guardPayout` runs the steps in order and calls the provider last. The same function with source `self_declared` serves residence and other own-place declarations (wiring into the profile and ownership forms is a follow-up).

## Tests

`tests/screening-gates/units.test.ts` (the verdict for every reason and side, the counterparty refusal shape, fail-closed ports), `database.test.ts` (runtime role: every reason, grants, declarations, races of results, decisions, holds and list activations with the gate), `api.test.ts` (each commitment refused for each party side and state, nothing written, unavailable store and stale baseline, agent commits on the mandate path, a racing decision through HTTP, payouts with a provider fake, the counterparty projection).

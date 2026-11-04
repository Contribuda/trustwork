# Sourcing events: levelling and eligibility (PRC-004)

A sourcing event is an RFQ with its invitations, quotes, levelling and award; no new top-level object exists ([Procurement and supply, "Sourcing events and bid levelling"](../../../../../docs/engine/procurement-and-supply.md#sourcing-events-and-bid-levelling), [data model section 18a](../../../../../docs/data/model.md#18a-procurement-and-supply)). Contracts: the frozen supply contracts [`sourcing.ts`](../../../../../packages/contracts/src/supply/sourcing.ts) and [`commands.ts`](../../../../../packages/contracts/src/supply/commands.ts) (PRC-000). Storage: [`packages/data/migrations/sourcing`](../../../../../packages/data/migrations/sourcing), [`packages/data/src/repositories/sourcing.ts`](../../../../../packages/data/src/repositories/sourcing.ts).

Status: Live in the API with no interface yet (WEB-011). Nothing here contacts a supplier or moves money.

## Rules the module enforces

| Rule | Where |
|---|---|
| Sheets and eligibility rules are `party_private` of the buyer. The owner person, or members of the owner company holding `company.deals.manage` or `procurement.sourcing.run`, read them; a seller, another company, a co-buyer participation and an anonymous caller get nothing (`404` for existence) | Row-level security through `sourcing_rfq_reader`, `FORCE ROW LEVEL SECURITY`, `SourcingService.buyerRfq` |
| Writes need the owner person, or a member holding both `procurement.sourcing.run` and `company.deals.manage` (administrators hold every procurement permission). The runtime role has no `INSERT`, `UPDATE` or `DELETE` on the tables | `sourcing_require_runner` in every command |
| A column pins a sent version of a quote on this RFQ by id, version and digest | `checkedPayload`, repeated in SQL by `sourcing_check_pins` |
| `comparable` and `staleReason` come from the stored version, never from the client. A version is comparable only while it answers the sheet's RFQ version, carries no stale flag, is sent or accepted, is still valid and its currency converts with the sheet's dated snapshot | `columnState`, `sourcing_check_pins` |
| A cell repeats the quote exactly (unit price, line total, exclusion, alternate); a quantity differs only by citing a conversion rule; a comparable column carries every line its quote prices | `checkedPayload` |
| Buyer adjustments are separate, labelled `buyer_estimate` with a source, and never alter a quote; totals are recomputed exactly per column with no weighting | `BuyerAdjustmentSchema`, `levelSheetTotals` |
| A sealed RFQ is not levelled: no sheet is opened, saved or frozen while the seal holds, and a seal that has lifted never comes back | `sourcing_open_draft`, `sourcing_lock_version`, `SourcingService.requireOpen`, [ADR 027](../../../../../docs/adr/027-sealed-rfqs.md) |
| One draft per sheet; a frozen version never changes for any role; a newer frozen version supersedes it; freezing restates the reviewed digest and checks the pins again | `bid_level_sheet_version_frozen`, `sourcing_freeze_sheet` |
| No sourcing levelling command appends an outbox event; audit rows carry identifiers only, never a price or an estimate | `SourcingService` |
| Eligibility answers pass, fail or unknown; unknown is not failure and is never guessed. Region reads the buyer's own record, screening the one fact a counterparty may know. Licence, insurance and passport rules stay `unknown` until PREQ-001 exists | `eligibility.ts`, `PrequalificationEvidencePort` |
| Invitation candidates are ordered by a failed rule last, the buyer's own status, the oldest record, the id. No plan, entitlement, subscription or sponsorship is an input | `orderCandidates`, comparison test in `tests/sourcing/levelling.test.ts` |

## Routes

All routes need a session; mutations carry CSRF metadata and an `Idempotency-Key` and complete in their request transaction (`in_transaction`, crash-tested in `tests/backend/idempotency/cases/sourcing.ts`).

| Route | Result |
|---|---|
| `GET /v1/sourcing/rfqs/:id` | The event for the buyer side: the seal, the eligibility rules and every sheet version with totals |
| `POST /v1/sourcing/rfqs/:id/eligibility` | Saves the rules; `expectedRevision` is `null` for the first save |
| `GET /v1/sourcing/rfqs/:id/candidates` | Suppliers of the buyer's base with pass, fail or unknown per rule, blocked and archived ones left out. Company buyers only |
| `GET /v1/sourcing/rfqs/:id/level-sheet/template` | A payload to start from: every sent version and the cells its quote states, with no estimates. Nothing is stored |
| `POST /v1/sourcing/rfqs/:id/level-sheet/versions` | `DraftBidLevelSheetCommand` (+ `actor`): opens the next draft |
| `GET /v1/sourcing/level-sheet-versions/:id` | A version with its totals and `columnsChangedSince`: columns whose quote changed after this version stored them |
| `POST /v1/sourcing/level-sheet-versions/:id` | Saves a draft with `expectedRevision`; the server derives `comparable` again |
| `POST /v1/sourcing/level-sheet-versions/:id/freeze` | Freezes the draft whose digest the caller restates |

Refusals use the contract codes: `access.not_found`, `access.forbidden` (`details.reason`: `not_authorised`, `sealed_until_deadline`), `access.mandate_scope`, `commercial.digest_mismatch` (`pin_mismatch`), `commercial.stale_version` (`stale_comparable`), `commercial.rfq_version_not_current`, `commercial.version_immutable` (`frozen`), `validation.revision_conflict` (`revision_conflict`, `draft_exists`, `digest_mismatch`) and `validation.schema` (`cell_differs_from_quote`, `cell_missing`, `unknown_line`, `captured_quote_unavailable`, `company_buyer_required`, `not_published`, `no_quotes`, `rfq_mismatch`) (`errors.ts`).

## Agents

`mandates.ts` (`SourcingMandatePort`, wired to the AST-001 store with module key `sourcing_desk` in `app.module.ts`): eligibility, drafting, saving and freezing a sheet are `prepare`. `capabilities.ts` maps every route to its PRC-000 registry entry and proposes the missing entries for PRC-023.

## Follow-ups

- Captured off-platform quotes as columns (`captured_quote`) arrive with document intake (PRC-005) and are refused until then.
- Prequalification evidence (PREQ-001); candidates from matching (MATCH-001) and opted-in broadcast. Today candidates come from the buyer's supplier base.
- The web screens (WEB-011) and the registry entries of `PROPOSED_SOURCING_CAPABILITIES` (PRC-023).

## Tests

`tests/sourcing/sealed-contract.test.ts` and `sealed.test.ts` (ADR 027), `levelling-rules.test.ts` (comparability, eligibility, candidate order), `levelling.test.ts` (runtime role and HTTP: authority, pins, adjustments, frozen versions, staleness, sealed RFQs, forbidden fields over every seller read, tables, outbox and audit, concurrency, eligibility, the entitlement comparison).

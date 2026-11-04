# Sourcing events: levelling, eligibility, awards and outcome notices (PRC-004)

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
| No levelling or award command appends a sourcing outbox event (an approval request appends PRC-001's identifier-only events); the one event is `sourcing.outcome_notice_sent` with `noticeId` and `rfqId`. Audit rows carry identifiers only, never a price or an estimate | `SourcingService` |
| Eligibility answers pass, fail or unknown; unknown is not failure and is never guessed. Region reads the buyer's own record, screening the one fact a counterparty may know. Licence, insurance and passport rules stay `unknown` until PREQ-001 exists | `eligibility.ts`, `PrequalificationEvidencePort` |
| An award selects whole quote versions, because an agreement binds a whole version: a split award is several suppliers each awarded everything their version quotes. A part of a version or a share below 1 is refused at proposal (`partial_award_unavailable`): the supplier first sends a revised version for exactly the awarded lines | `checkSelection` |
| An award rests on the frozen sheet of the current RFQ version and on its comparable columns; one live award per RFQ | `sourcing_propose_award`, `award_decision_one_live` |
| Awards belong to companies: a person who owns an RFQ accepts a quote directly (`company_buyer_required`). A company without an active `award` route is refused (`no_active_route`) | `sourcing_propose_award`, `submitForApproval` |
| The route weighs the exact gross of the selected versions in their own currency. A sheet's exchange rate is the buyer's input, for display only, and never reaches a route or a band; selected versions in different currencies have no amount, so amount conditions hold. A selected supplier missing from the buyer's base, or a split across different statuses, is an unknown status, so `supplier_status_in` steps apply | `awardAmount`, `sharedStatus`, `conditionHolds` |
| The approval binds the award digest (the sheet digest, the selection, the reasons) and stays human. Approved stays approved; rejected, returned, withdrawn, expired and superseded end the award as `rejected`, and `approvalOutcome` keeps which | `sourcing_award_follow_approval` |
| Freezing a newer sheet voids the award in approval; an approved award on a superseded sheet does not execute, so an agent may not freeze one while an award is in approval or approved | `freezeSheet`, `sourcing_begin_execution` |
| Cancelling an approved award needs a person in their own first-party session; no mandate reaches it | `cancelAward`, `sourcing_cancel_award` |
| A company with an active `award` route, or an RFQ with a live award, cannot accept directly: the agreement must name an approved award selecting that version | `agreement_award_guard` |
| An approved award executes only through the COM-002 commands (`acceptTermsIn`, `placeOrderIn`), every selected quote or none: digests rechecked, parties screened, electronic-records consent, an atomic reservation per order. Executing needs `procurement.order.place` and `company.deals.manage` | `executeAward`, `sourcing_begin_execution`, `sourcing_complete_execution` |
| Concurrent proposals, decisions, executions, cancellations and notices resolve once | RFQ and award row locks, unique indexes |
| Approvers read the award and the frozen sheet it rests on, nothing else of the event; no seller reads either | `award_decision_read`, `sourcing_sheet_approver` |
| One notice per invitee, once. The database decides who was awarded from the agreements of the executed award; without one the RFQ must be closed and everybody gets `cancelled`. No amount, line, competitor or winner column exists | `sourcing_send_notices`, `bid_outcome_notice` |
| A band and a reason category appear only for a not-awarded supplier, after an executed award, with the hub's allowance and the buyer's opt-in for this event. A non-comparable column gets no band | `bid_outcome_notice_feedback`, `outcomeFeedback` |
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
| `POST /v1/sourcing/rfqs/:id/awards` | `ProposeAwardCommand` (+ `actor`; `expectedRevision` is the RFQ's): the award and its approval request in one transaction |
| `GET /v1/sourcing/awards/:id` | The award with its digest and `approvalOutcome`, for the buyer side and the people the approval shows it to |
| `POST /v1/sourcing/awards/:id/execute` | `ExecuteAwardCommand` (+ `electronicRecords`, `actor`): agreements and orders for every selected version |
| `POST /v1/sourcing/awards/:id/cancel` | An approved award that will not execute, with a reason |
| `POST /v1/sourcing/rfqs/:id/outcome-notices` | `NotifyOutcomesCommand` (+ `actor`; `expectedRevision` is the RFQ's): `awardDecisionId: null` tells every invitee the event was cancelled |
| `GET /v1/sourcing/outcome-notices` | The bidder's side: notices addressed to the caller or its company (`audience: shared_party`) |

Refusals use the contract codes: `access.not_found`, `access.forbidden` (`details.reason`: `not_authorised`, `sealed_until_deadline`), `access.mandate_scope`, `commercial.digest_mismatch` (`pin_mismatch`), `commercial.stale_version` (`stale_comparable`), `commercial.rfq_version_not_current`, `commercial.version_immutable` (`frozen`), `validation.revision_conflict` (`revision_conflict`, `draft_exists`, `digest_mismatch`) and `validation.schema` (`cell_differs_from_quote`, `cell_missing`, `unknown_line`, `captured_quote_unavailable`, `company_buyer_required`, `not_published`, `no_quotes`, `rfq_mismatch`, `partial_award_unavailable`, `selection_duplicate`, `line_awarded_twice`, `sheet_not_frozen`, `no_active_route`, `rfq_not_open`, `rfq_not_closed`, `award_not_executed`) (`errors.ts`). Awards add `access.forbidden` (`award_required`, `award_not_approved`, `feedback_bands_not_allowed`, `first_party_required`), `access.mandate_scope` (`human_only`), `access.approval_digest_mismatch`, `commercial.stale_version` (`not_comparable`) and `validation.revision_conflict` (`award_exists`, `sheet_superseded`, `already_notified`).

## Agents

`mandates.ts` (`SourcingMandatePort`, wired to the AST-001 store with module key `sourcing_desk` in `app.module.ts`): eligibility, drafting, saving and freezing a sheet and proposing an award are `prepare`; cancelling an approved award is the person's own act; outcome notices are `communicate`; execution is `place_order` on the deal mandate port of the COM-002 commands. Deciding an award is `approve`, which is human-only and has no path here. `capabilities.ts` maps every route to its PRC-000 registry entry and proposes the missing entries for PRC-023.

## Follow-ups

- Captured off-platform quotes as columns (`captured_quote`) arrive with document intake (PRC-005) and are refused until then.
- Prequalification evidence (PREQ-001); candidates from matching (MATCH-001) and opted-in broadcast. Today candidates come from the buyer's supplier base.
- Awarding part of a quote version: an agreement binds a whole version, so today the supplier sends a revised version first. Binding a subset of lines would change COM-002.
- A known limit, kept by the maintainer: a seller who declines after execution leaves the award `executed`. The buyer sees the declined agreement, but no new award on that RFQ is possible, because an executed award is live. Delivering a notice as mail or in the assistant (COMMS-001): the event is there, the template is not.
- The per-hub `feedbackBandsAllowed` setting (HUBC-011): today the engine default applies. The per-company default for the buyer's opt-in (`feedbackBandsDefault`) is not stored yet, so the opt-in is per command.
- The web screens (WEB-011) and the registry entries of `PROPOSED_SOURCING_CAPABILITIES` (PRC-023).

## Tests

`tests/sourcing/sealed-contract.test.ts` and `sealed.test.ts` (ADR 027), `levelling-rules.test.ts` (comparability, eligibility, candidate order), `levelling.test.ts` (runtime role and HTTP: authority, pins, adjustments, frozen versions, staleness, sealed RFQs, forbidden fields over every seller read, tables, outbox and audit, concurrency, eligibility, the entitlement comparison), `award-rules.test.ts` (whole versions, digest, bands), `awards.test.ts` (runtime role and HTTP: authority, split awards, all or nothing, order changes, every approval outcome, stale and superseded awards, notices, bands, concurrency).

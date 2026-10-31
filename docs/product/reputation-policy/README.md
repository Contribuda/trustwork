# Reputation policy (EXE-001)

Status: **Implemented prototype** (API and migration in this repository, real-PostgreSQL tests; not deployed, no real data). Narrative: [Execution, evidence and reputation](../../engine/execution-and-reputation.md). Data: [model sections 19 and 20](../../data/model.md#19-execution-and-evidence). Decisions: [ADR 010](../../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 18 (every participant builds and confirms their reputation; evidence-based, explainable, never for sale), [ADR 012](../../adr/012-integrator-decisions-2026-10-31.md) open question 8 (O07 in [open decisions](../open-decisions.md)).

This page states the rules the execution and trust slice enforces, the published method `engine-evidence-0.1`, and where each rule lives. Weights, windows, minimum-sample display, confirmation and appeal deadlines remain the owner's open decision O07; nothing here sets a public score.

## What is delivered

| Part | Where |
|---|---|
| Nine tables: `execution_claim`, `execution_evidence`, `execution_confirmation`, `execution_defect`, `execution_dispute`, `performance_observation`, `review`, `review_response`, `reputation_snapshot`; guards, fair-timing functions, staff commands, public read | [`packages/data/migrations/execution`](../../../packages/data/migrations/execution) |
| Kysely model and runtime column mirror | [`packages/data/src/schema/execution.ts`](../../../packages/data/src/schema/execution.ts) |
| Repository port | [`packages/data/src/repositories/execution.ts`](../../../packages/data/src/repositories/execution.ts) |
| Claims, evidence, decisions, defects, disputes (`/v1/execution`) | [`apps/api/src/modules/execution`](../../../apps/api/src/modules/execution) |
| Reviews, appeals, snapshots (`/v1/trust`, `/v1/reputation`) and the method | [`apps/api/src/modules/trust`](../../../apps/api/src/modules/trust) |
| Tests (database, HTTP, method) | [`tests/trust`](../../../tests/trust) |

## From claim to fact

| Record | Who | Rule and enforcement |
|---|---|---|
| Claim | The party that owes the obligation (a person, or a company member holding `company.deals.manage`), or that person's agent under a `record_evidence` mandate | The kind fits the obligation (goods delivery for `deliver`, work or service for `perform`, payment for `pay`, remediation for a defect); one open claim per obligation or defect, serialized by an advisory lock; never dated in the future; nothing after a full acceptance (`execution_claim_guard`). A claim is never a fact because it was said |
| Supersession | The claimant | A correcting claim names the open claim it replaces; the original is kept and can no longer be decided or extended |
| Evidence | The claimant (or the defect's reporter) | Only FILE-001 artifacts uploaded to this agreement, not quarantined, with the digest repeated (`execution_artifact_digest`). The artifact keeps its own classification; the link never makes it public |
| Confirmation | A person acting for the counterparty | Accepted, partially accepted (with contested quantities and a reason) or rejected (with a reason). The table has no agent or mandate column: confirming work is human-only (`confirm_execution` is in `HUMAN_ONLY_ACTIONS`). Never by the claimant side or the person who recorded the claim; one decision per claim |
| Defect and remediation | Either party about the other | Severity, location, evidence; closed only by an accepted remediation claim |
| Dispute | The party a decision went against (the claimant of a decided claim, the subject of a defect) | Decided by a trust reviewer (`admin.trust.evidence.decide`) of the hub, appealed once by either party, the appeal decided by a different reviewer (`admin.trust.appeals.decide`); conflicts of interest refused; audited by DATA-002 (`execution_decide_dispute`, `execution_decide_dispute_appeal`) |

Absence of evidence is unknown, not failure: a claim without evidence is still a claim decided on its merits, and an obligation past due without any record is counted as unknown, never as late or failed.

## Fair timing

Observations are derived by `trustwork.execution_observe` in the transaction of the decision (and lazily for TASK-001 milestone decisions). Each one measures performance against the obligation's due date as agreed, plus allowance from approved plan changes (PLAN-001 `plan_change`: cause, accountable party, schedule impact) decided after the agreement and before the performance, that name the agreement or belong to the plan it executes.

| Change, seen from the subject | Effect |
|---|---|
| Accountable party is the subject | No allowance: the delay is the subject's |
| Accountable party is the counterparty, or the owner asked for it (for a supplier) | Allowance; a delay within it is `excused_delay`, attributed to the counterparty, excluded as `client_caused_change` |
| Site condition, regulator or external event (third party accountable) | Allowance; excluded as `external_change` |
| Unknown cause (third party accountable) | Within that allowance the outcome is `unknown` (`unattributed_change`): neither counted against nor for the subject |
| No due date | `unknown` (`no_due_date`), never late |

A client-caused plan change therefore never penalizes the supplier automatically (tested in `tests/trust/database.test.ts` and `tests/trust/api.test.ts`). Every observation keeps the plan change identifiers and the baseline plan version it was measured against; the counterparty sees the cause, accountable party and impact of those changes (`execution_timing_facts`), never the owner's reason text or the plan.

## Method `engine-evidence-0.1`

| Part | Value |
|---|---|
| Facts | Timing (on time, late, late days), payment discipline (the same for payment claims), quality (accepted, partially accepted, rejected), defects (open, resolved, by severity) |
| Opinions | Reviews: distribution of overall stars and of optional timing, quality, payment and cooperation stars; never mixed into facts |
| Window | 730 days; older records are excluded as `outside_window` |
| Minimum samples | 3 per dimension; below it the public summary says "not enough data" and shows no counts |
| Weights | None (O07). The method digest is stored with every snapshot |
| Exclusions, each counted and named | `client_caused_change`, `external_change`, `unattributed_change`, `no_due_date`, `dispute_pending`, `dispute_overturned`, `dispute_partially_upheld`, `appeal_pending`, `appeal_overturned`, `duplicate` (a task review of the same side), `corrected` (a review replaced by its correction), `outside_window` |

A snapshot (`reputation_snapshot`) is computed for the subject the caller acts for, from the evidence that subject can read as a party, and stores the full summary, a masked public summary, the explanation (every observation, defect and review behind each count, with its exclusion reason) and an inputs digest. The public reads only the masked summary (`trust_public_snapshot`), with a flag when newer evidence exists: no identifiers, evidence, counterparties, review text or score.

## What cannot influence reputation

- Payment, plans, sponsorship, credits or any entitlement: no table, function or query of this slice reads a billing table (`tests/billing/policy.test.ts`), and a snapshot computed before and after granting subscription, sponsorship and credit entitlements has the same inputs digest, summary and explanation (`tests/trust/api.test.ts`).
- Staff: reviewers decide disputes and appeals with evidence; they cannot write observations, set a score or edit any record.
- The subject: it computes and reads its snapshot but cannot add, hide or change evidence; it can respond to a review and appeal it, never remove it.

## Public numeric score: disabled

`REPUTATION_POLICY.publicNumericScore` is `false` and the method's `weights` are `null`; both are needed for `publicScore()` to return a number, and every view's `publicScore` is `null`. The switch is a reviewed code constant on purpose: DATA-002's feature-flag vocabulary forbids score and ranking flags. Turning it on needs the owner's O07 decision and a method version with weights released through review (method releases by the hub owner role are a later slice, see below).

## Appeals

| Subject | Path |
|---|---|
| A confirmation or a defect | The dispute above, with one appeal to a different reviewer |
| A review or a performance observation | `POST /v1/trust/appeals` files into DATA-002's `appeal` queue for the hub (`trust_file_appeal`); the original decider is the review's writer or the observation's confirmer, so `admin_decide_appeal` refuses them. Pending and overturned appeals exclude the record from the summary |

## Not delivered here (follow-ups)

- Staff HTTP routes and console screens for disputes and appeals (hub console reputation section); the database commands exist and are tested.
- Worker recomputation of snapshots on new evidence (outbox events are emitted: `trust.snapshot_computed`, `execution.claim_decided`, `trust.review_published`); today the subject recomputes and the public summary flags newer evidence.
- Method version table and release workflow; confirmation requests, contributions and the passport (REP-001, REP-002).
- Disputes of TASK-001 milestone decisions (those decisions feed observations; disputing them waits for the task module).
- Promotion of the module contracts into `packages/contracts/src/execution.ts` and of the repository into the data package entry (integrator bookkeeping).

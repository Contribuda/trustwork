# Execution, evidence and reputation

Normative requirements: [Reputation builder and passport](modules/reputation-and-passport.md), [Execution and field evidence](modules/execution-and-field-evidence.md). Participants: [who uses what](participants/README.md).

Requirements R12–R14, R44. Status: project updates and published milestones are **Demo**; claims, evidence, counterparty decisions, defects, disputes with appeals, fair timing, reviews and explainable reputation snapshots are **Live** in the API without a public score (work package EXE-001, [reputation policy](../product/reputation-policy/README.md)); the reputation builder tools (credentials checked through a register adapter with a fake, evidence portfolio, relationship-bound counterparty confirmations with one reminder, contributions and timeliness derived from canonical records, automated limitations with reason codes and appeals) are **Live** in the API (REP-001, [module routes](../../apps/api/src/modules/reputation/README.md)); the portable reputation passport, coaching and the builder screens are **Proposed** ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 18; REP-002, AGT-005, WEB-008).

Reputation is the reason the engine exists, and also the easiest thing to get wrong. A star rating that anyone can buy, inflate or weaponise is worse than none. The engine builds reputation from **evidence of what actually happened**, separates opinions from facts, and explains every number.

## From claim to fact

```text
claimed → evidence_attached → confirmed | disputed → superseded | reversed
```

- An **assertion** is a claim: "delivered 400 m² of panels on 12 March", "work accepted", "invoice paid". It is not a fact because someone said it.
- **Evidence** supports it: acceptance acts, delivery notes, photographs with dates and grid references, test reports, e-documents from the hub's e-signature or e-invoicing adapters. Each piece keeps its source, observed time, hash and classification.
- **Confirmation** is a recorded decision by an authorized actor (the counterparty, or a trust reviewer in a dispute case) with supporting evidence. Importing a document is not confirmation.
- A **dispute** challenges an assertion. Disputed observations are excluded from reputation or shown annotated until resolved.
- **Supersession and reversal** append history; nothing is rewritten.

## Execution records

| Record | What it captures |
|---|---|
| Delivery | Order lines delivered, quantities, date, evidence |
| Work record | Scope performed in a period, by whom (claimant) |
| Acceptance | What was accepted, in what quantity, by whom, with which evidence; partial acceptance is normal |
| Defect | What is wrong, where, severity, evidence |
| Remediation | What was done about a defect, and its acceptance |
| Obligation | What each party owes (scope, amount, due date) under the agreement |

Staged acceptance of hidden works (fixings, insulation, wind barrier, rails, cladding on a ventilated facade) is the kind of practice the engine makes easy: each stage closes with a short act and photographs, and the client's confirmation is a separate record from the contractor's statement. The demo publications describe exactly this.

## Fair timing: who caused the delay?

Plans have a **baseline** and **changes**. When a client changes scope and the date moves, the change records the reason, who asked for it and which agreement covers it. Timing reputation measures performance against the plan **as it was agreed at the time**, so a client-caused change is never counted as an unexplained supplier delay (R13).

## Reputation

A **reputation snapshot** for a company or a professional contains:

| Part | Meaning |
|---|---|
| Dimensions | Timing, quality, payment discipline, cooperation, and subjective reviews, each separately |
| Method version | Which published method computed it: dimensions, weights, time windows, minimum samples |
| Samples | How many observations each dimension is based on |
| Exclusions | How many observations were excluded and why (dispute pending, client-caused change, duplicate) |
| Missing data | Shown as unknown, never as zero |
| Appeal | How to dispute an observation or appeal a decision |

### Reviews

Commercial reviews can cite permitted facts from the transaction and subjective experience. A review must be tied to a real interaction; unconfirmed reviews are labelled and excluded from aggregates. Reviews can be appealed and corrected. Review authors are people, not anonymous accounts; how much of the author is shown publicly follows the hub's policy and local law.

### What cannot influence reputation

- Payment, plans, sponsorship, advertising.
- Staff decisions outside the method: staff can only confirm or dispute observations with evidence, exclude a disputed observation pending resolution, or release a new method version through a reviewed process. Every such action is attributed and visible in the explanation.
- Another node: reputation is computed only by the home node of the subject and displayed elsewhere with attribution ([Federation](federation.md#authority-stays-home)).

## The reputation builder toolkit

Owner decision 2026-10-31 ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 18). Status: **Proposed**. Reputation is not the platform watching people. **Every participant builds and confirms their own reputation** with tools: a worker, a professional, an expert, a company, a supplier, a client, an author and an organizer alike. The home hub still computes snapshots under a published method (above); the tools help a participant bring the evidence the method counts, and never change a score directly. What each kind of participant builds and the agent's `reputation_builder` jobs are in the [agent catalogue](agent-catalog.md#flagship-build-and-confirm-your-own-reputation); entities are in the [data model](../data/model.md#20-reputation) and states in the [lifecycles](../data/lifecycles.md#confirmation-requests-and-passport-credentials). A professional's view: [guide](../guides/professional.md).

| Tool | What the participant builds | How it is confirmed | Package |
|---|---|---|---|
| **Credentials** | Verified identity; licences (for example state contractor or professional-engineer licences), insurance, professional and platform certificates | The hub's verification recipes record "checked on date by hub X"; documents are never shown publicly; expiry is tracked and reminded | REP-001, CLM-001, HUB-003 |
| **Evidence portfolio** | Completed projects and tasks with photographs, acceptance acts, inspection results | Each entry links to execution records; "client confirmed" only when the owner or client confirmed it, otherwise "self-reported"; shown only with the project owner's consent; the address never | REP-001 |
| **Counterparty confirmations** | Confirmed deliveries, accepted milestones, payments on time | A **confirmation request** tied to a real agreement, task, consultation or project; the counterparty's person answers `confirmed`, `declined` or `partially`; once plus one reminder, never with an incentive | REP-001 |
| **Contributions** | Articles, expert answers, consultations delivered, mentoring, courses taught, checklists and templates others reused | Counted by outcome (a deliverable accepted, an answer confirmed useful through someone's own project, learners who completed), never by volume | REP-001, KNOW-001 |
| **Timeliness** | Response time to invitations, on-time deliveries and payments | Computed by the home node from records against the plan as agreed, with sample sizes; client-caused changes excluded | REP-001 |
| **Reputation passport** | A portable bundle of the above the participant owns and shows anywhere, inside or outside Trustwork | W3C Verifiable Credentials 2.0, compatible with Open Badges 3.0, issued by the home hub and signed with the node key, revocable through published status lists; the holder chooses what is included; issuing it is free ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 5) | REP-002 |
| **Coaching** | Private suggestions from the participant's own agent ("two finished jobs are waiting for client confirmation", "your licence check expires in 30 days") | Limited to legitimate actions: never review swaps, incentives, splitting work to multiply reviews or asking people who were not counterparties | AGT-005 |
| **Appeals** | Disputes of observations and appeals of reviews, with evidence; public responses to reviews | Decided by a different person than the original decider; a participant can respond to a fair negative observation and dispute it, never remove it | EXE-001, REP-001 |

**Never for sale.** No plan, payment, sponsorship, commission or staff action changes a score, a badge, a passport credential or a position. Pass-through costs of a real check buy the check, not its result. Review rings and confirmation swaps open a case for a person to review; they never trigger automatic sanctions or silently change scores.

**Across hubs.** Peers show passport credentials as "verified by hub X"; nobody re-issues or recomputes another hub's credentials ([Federation](federation.md#authority-stays-home)).

**In the hub console.** Credential checks, confirmations, reputation methods and appeals are administered in the console's [reputation building](hub-console/modules.md#reputation-building-credentials-confirmations-methods-and-appeals) section; staff can never set a score.

## Method releases

A method version is proposed by trust reviewers, reviewed, released by the hub owner role and announced publicly with its explanation text. Snapshots are recomputed as a background job and reference the new version. The minimum-sample rule prevents a single review from producing a score; until the minimum is reached the profile says "not enough data".

## Open decisions

Weights, dimensions, windows, minimum sample display, confirmation and appeal deadlines are open (O07). Nothing is ranked publicly until they are decided.

## Invariants

- Absence of evidence is unknown, not failure.
- A disputed observation never silently counts.
- No code path changes a score from a payment or entitlement.
- Every snapshot references its method version and sample counts.

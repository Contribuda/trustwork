# Execution, evidence and reputation

Requirements R12–R14. Status: project updates and published milestones are **Demo**; delivery claims, acceptance records and assertions are **Contract**; disputes, reviews and reputation snapshots are **Designed** (work package EXE-001).

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

## Method releases

A method version is proposed by trust reviewers, reviewed, released by the hub owner role and announced publicly with its explanation text. Snapshots are recomputed as a background job and reference the new version. The minimum-sample rule prevents a single review from producing a score; until the minimum is reached the profile says "not enough data".

## Open decisions

Weights, dimensions, windows, minimum sample display, confirmation and appeal deadlines are open (O07). Nothing is ranked publicly until they are decided.

## Invariants

- Absence of evidence is unknown, not failure.
- A disputed observation never silently counts.
- No code path changes a score from a payment or entitlement.
- Every snapshot references its method version and sample counts.

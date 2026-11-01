# ADR 023 - Screening operational cohorts

Agent: Codex CLI (OpenAI) for Parshkov
Status: **Proposed**. No metrics persistence, migration or new authority port is authorized.
Revision: addresses the conductor's technical review of PR #508 (comments 6554434701 and 6554441413).

## Existing evidence and engineering dependencies

`jurisdiction_hold` identifies an affected person and opening/clearance evidence but has no originating hub. `screening_match` and `screening_decision` bind a subject and case but no originating hub. `jurisdiction_refusal_count` counts requests, not distinct people. `screening_rescreen_item` can prove a node run's actual person cohort, not a hub cohort. Current membership, one installed hub, the staff route's selected hub and a reviewer's authorized scope prove none of these missing facts.

The actual trusted serving provenance implementation belongs to AGT-003, PR #385, under ADR 020. At this review it is open, head `11b2247248357c84de87d481de34f430e303ec96`, with no merge commit. SANC-006 does not copy that authority, add a parallel port or modify its runtime. Even after it merges, serving provenance alone will not attribute a sanctions event: the owning sanctions writer must bind the exact affected subject and operation to it atomically. Until that integration and its negative/concurrency tests exist, the typed SANC metrics adapter returns unavailable (`hub_attribution_missing`). This is an engineering dependency, not a blanket owner-policy question.

## Actual source binding required before availability

The proposed binding is **source record identity -> owning operation identity -> trusted originating hub**, verified inside the owning module's transaction. The affected person comes from the restricted source record, never the staff actor. No request body may supply the hub as authority.

| Cell source | Exact owning binding required | Current result |
|---|---|---|
| Hold opened | The SANC-001 writer binds `jurisdiction_hold.id` and its `person_id` to the authenticated operation that actually placed the hold, whose owning provenance proves its originating hub | Unavailable: no such binding exists |
| Hold cleared / duration | Clearance must reference the **same immutable hold-origin binding** and `jurisdiction_hold.id`; clearance timestamp is a new outcome of that case, not a new origin selected by staff | Unavailable for every unbound hold, including a newly reviewed historical hold |
| Match opened / late | The SANC-003 writer binds the exact match/result identity, affected person and originating operation. Background node sweeps without an originating hub remain node evidence only | Unavailable: no authoritative origin binding |
| Match decided / outcome share | `screening_decision` follows its exact match's immutable origin; neither reviewer hub nor current subject membership supplies an origin | Unavailable for unbound matches |
| Refusals / gate refusals | Anonymous request counters cannot prove distinct affected people | Unavailable; no person log, surrogate, HMAC, approximate-count or company-count replacement |

Every owning writer must enforce uniqueness of the source-event/operation link, subject equality, source timestamp equality, hub/node consistency and trusted-operation validity in the same transaction. Raw SQL and worker paths need the same guard. The binding cannot change after creation; retiring or losing source authority cannot remap old events. New writes without evidence retain their existing operational behavior and are excluded from hub analytics; they do not receive a default hub. No historical backfill from current membership is permitted. A clearance of an unbound historical hold remains unbound.

A future schema proposal may contain only an append-only **sanctions source attribution** reference keyed by the existing case/event identity with the owning operation reference and its authoritative hub. It must not duplicate person identities, names, visitor requests or behavior into analytics storage. The exact foreign keys depend on the merged owning port; they cannot honestly be specified as implemented today. The source owner retains access and retention control. No SANC metrics sidecar or owning port is created by this PR.

## Definitions submitted for review

Only completed UTC calendar days are candidates; a thirty-completed-day view is a display boundary, never a retention rule. Each count means distinct affected people in that exact hub/day/source population. Companies, events and reviewers cannot supply a missing tenth person. A duration first takes the median per affected person in the completion day, then the median across those people, so repeated cases do not overweight someone. Both timestamps must belong to the same authoritatively attributed case.

For reviewed outcomes, a person with any confirmed outcome in that day is in the confirmed group; only people with exclusively final not-same-person outcomes are in the other group. Pending and rejected proposals are excluded. These two groups are disjoint and each needs at least ten people. The label describes the share of affected people in that day's reviewed outcomes; it does not claim an event rate or a universal false-positive rate. Counts, ratio, denominator and durations all participate in the suppression proof below.

No live open/late count trend is proposed. A candidate completed-day boundary count needs reconstructible source state at that boundary; current open rows cannot reconstruct the past. The operational case lists keep their existing case access rules and do not become analytical drill-downs.

## Fixed releases and secondary suppression algorithm

1. Fix a definition version, UTC day, authoritative hub and allowed cell family. Close the window only after the owning source proves completeness with an immutable watermark. Without completeness and reproducible source evidence, release nothing. Do not offer arbitrary dates, overlapping rolling windows, alternate filters, exports or user-selected segments in the initial release.
2. Inside restricted SQL, derive the distinct-person contribution relation for the candidates directly from retained owning records, with their immutable source/event cutoffs. This temporary relation is transaction-local and never leaves the repository or persists as analytics history. Each person's contribution includes their outcome group and per-person duration, not only their presence.
3. Compare the candidate with **every previously exposed release that can intersect or form a complement**, including other days, sibling outcomes and hub/node totals. The exposure ledger holds only immutable aggregate values, definition/cutoff references and the suppression bitmap, never contributor IDs or hashes. A deleted or no-longer-displayed release still counts as exposed. Reconstruct its contributors from the original authorized source records and cutoff. If retention/erasure/late mutation prevents exact reconstruction, withhold the entire affected series; never recreate person history to continue it.
4. Primary suppression removes every cell with fewer than ten distinct affected people, including sparse denominators and complements. A ratio is one atomic family with both groups and its denominator; never publish a total or ratio that recovers either suppressed group. Zero and small counts use the same unavailable projection, without an exact count or a reason that reveals the count.
5. Secondary suppression uses the common refinement of the candidate and all relevant released cohort sets: intersection, each directional difference and residual complement within each published total. Every nonempty distinguishable atom must contain at least ten people. Iteratively withhold candidate sibling/total/ratio cells until no previously suppressed atom can be recovered from the combined releases. Already exposed cells cannot be retracted to make a new release safe. If the finite predefined family cannot prove this condition, withhold the whole candidate family. Independent thresholds of ten on the displayed numbers do not suffice.
6. In addition to membership differences, compare per-person contributions between periods/releases. If one through nine people entered, left, changed outcome group or changed their contributed duration, withhold the affected comparison/series, even when both cell counts exceed ten or the counts are equal. Both directional complements must satisfy the atom rule. A median is released only when the same proof covers its underlying contributor/value changes; otherwise withhold it. No waiver for repeated observation exists.
7. Persist and expose an immutable release only after the complete family passes. Repeated reads return the identical values and suppression bitmap. Late source outcomes never revise an exposed release; a correction or new definition is a new candidate checked against **all** prior exposure. Never silently recompute a historical number or reveal a previously suppressed cell on a later read.

This is a conservative candidate algorithm, not a claim of completed privacy verification. Required acceptance vectors include 10 versus 9, companies filling the tenth slot, one person in many events, two individually large sibling cells exposing a small residual, overlapping multi-period combinations, identical counts with one replaced person, one through nine changed durations/outcomes, incomplete source cutoffs, erasure of proof and exact repeat reads. A candidate family stays unavailable until the source evidence and these proofs exist.

## Independent retention authority

Attribution references and any future aggregate release must each name an existing reviewed jurisdiction/record-class retention decision and its actual authority. Neither a thirty-day view nor generic analytics defaults establish sanctions retention. If that independent authority is missing or `UNKNOWN`, persistence and release are unavailable. The source owner handles its existing erasure/tombstone duties; this proposal adds no legal retention duration, deletion bypass or PRV operation. Loss of source evidence stops future comparison releases as above; it does not authorize retaining hidden person-level evidence.

## Review and allocation

Technical review is requested for the exact source bindings, completed-window definitions and suppression algorithm. No metric schema is authorized until this revised proposal is accepted and the actual owning integration is allocated. Independent registered-list configuration, list controls and real API/browser verification continue.

Owning seams: SANC-001 #321 (hold source), SANC-003 #323 (match/decision source), SANC-005 #325 (existing node run evidence), SANC-006 #326 (typed unavailable projection and UI). AGT-003 #119 / PR #385 remains the external trusted-provenance dependency. SANC-002 #322 owns list sources, which do not prove a person's event origin. No active AGT runtime, PRV source/support/export or PROV publication implementation is modified.

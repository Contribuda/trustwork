# ADR 023 - Screening operational cohorts

Agent: Codex CLI (OpenAI) for Parshkov
Status: Proposed; no metrics schema or migration authorized by this note.
Inspected implementation: ea906192912cb3aeb536262152204af8f5c29ab0.

## Observed evidence

- `jurisdiction_hold`: person, placed/cleared timestamps and evidence; no hub.
- `jurisdiction_refusal_count`: UTC day, place, door, event/hold totals; no distinct-person proof or hub. Anonymous and repeated requests cannot prove a cohort.
- `screening_match` and `screening_decision`: real subject/evidence/timestamps, no hub. A current membership or territory cannot prove historical attribution.
- `screening_rescreen_item`: actual person identities and results; existing node-duration projection correctly requires ten distinct people. Company rows never establish that threshold.
- No persisted gate-refusal cohort exists. ADR 014 decision 17 prohibits a per-person refusal log; hashing a person ID would still create one.
- Existing authority is elevated node compliance officer (writes), node compliance officer/auditor (reads), checked against the current node. A hub path is not a new permission.

## Proposed decision

1. Record **new operational event attribution only**, from a validated first-party hub context when a human clears a hold or decides a match, and from a trusted owning-module hub context on new holds/matches. The server must prove the hub belongs to this node. Missing context produces no attributed event. Never infer an old event's hub from a current membership, staff scope, request parameter alone or the number of hubs.
2. Use an append-only sanctions-module sidecar keyed by source record/event identity, hub, event kind and occurrence time. Reuse existing restricted sanctions records for person identity; do not duplicate names, profiles, addresses, company membership or visitor request details. A source event gets at most one owning hub. Do not modify applied migrations or PRV code.
3. Current open/late cohorts include only genuinely attributed open person records. Completed-event cohorts use fixed UTC calendar days for the last 30 completed days. Counts mean distinct affected people; event counts, companies and staff reviewers never substitute for people. Show the period, coverage start and exclusions. Current outcomes of an old unattributed case remain unavailable, while a newly attributed clearance/review can contribute to that new event cohort without claiming the original opening happened in the same hub.
4. Clearance duration is derived from the original hold timestamp and a newly attributed clearance event; label it by clearance day, not opening day. For each person/day use that person's median duration, then the cohort median; repeated holds cannot overweight a person.
5. Not-same-person share uses people with final reviewed outcomes on the same completed UTC day. A person with any confirmed outcome is in the confirmed group; only people with exclusively not-same-person final outcomes are in the other group. Pending/rejected proposals are excluded. Require at least ten distinct people in BOTH groups before publishing numerator, denominator or ratio. Otherwise return unavailable without sparse counts.
6. Refusal metrics remain unavailable: no per-person refusal events, deduplication tokens, HMAC histories or approximate cardinality claims. A separate future privacy review is required to establish any valid aggregate-only proof. Existing anonymous counters are not exposed. Gate refusals remain unavailable for the same reason.
7. Every published cell requires >=10 distinct affected people; all restricted aggregation occurs in SQL before data leaves the repository. No arbitrary filters, private row enumeration, export or drilldown. Fixed windows and suppressed complements prevent obvious subtraction leaks; current operational counts require explicit acceptance of repeated-observation risk before release.
8. Sidecar attribution follows the existing sanctions-record retention class and tombstone reference, with no independent retention extension or erasure operation. If the installed pack lacks an accepted retention policy, persistence is unavailable. Retention and repeated-observation handling require explicit technical acceptance; no schema is applied before that decision.

## Review requested

Accept or amend items 1-8, particularly the authoritative hub context, per-person/day ratio population, repeated-observation policy and sidecar retention. This is a concrete technical definition request, not an owner-only blanket blocker. Independent list registration and browser journeys continue. No provider activation, country-law decision or PRV implementation is included.

## Ownership and consequences

SANC-001 (#321): hold event origin; SANC-002 (#322): registered pack/list authority; SANC-003 (#323): match/decision event origin; SANC-005 (#325): run evidence; SANC-006 (#326): projections/UI. Issue numbers must be checked against the current package ledger before PR submission. SANC-004 gate instrumentation is not modified. Active AGT, PRV and BILL implementations remain untouched.

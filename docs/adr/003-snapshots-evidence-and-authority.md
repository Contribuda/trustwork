# ADR 003 — Snapshots, evidence and authority

Date: 2026-10-26. Status: selected for foundation from accepted product invariants. Amended 2026-10-27 (FND-002, accepted by integrator) with the digest scheme below.

Published RFQ versions are immutable; invitations and quote versions bind exact requirements, with stale-response handling on amendment. Catalogue versions are reusable offers. Quotes are recipient-specific immutable snapshots after sending; accepted terms bind exact version/digest and acceptance events. Later corrections/amendments supersede, never silently rewrite. Execution claims, evidence, confirmations, disputes and reversals remain separate records. Reputation references methodology, samples, accepted evidence and causal plan changes; absence of evidence is unknown, payment does not improve ranking.

Assistant authority is structured: principal, actions, context, constraints, expiration, revision, budgets and exact approvals. Chat text never sets approval/execution state. Procurement transaction budget and paid platform-deliverable budget are distinct; reserve applicable amounts atomically. Check current principal rights immediately before effect and after every pause. Keep seller floors/buyer constraints in private party data, not shared negotiation records.

The small `evaluateDelegation` example demonstrates fail-closed amount/context/time checking only. It is not a production authorizer: object grants, aggregate budget consumption, approval digests, conditions and durable reservations are future acceptance requirements. Whole-product event sourcing was considered unnecessary; retain append-only history/evidence and versioned critical aggregates alongside current-state tables.

## Amendment 2026-10-27: digest scheme and version pinning

- `Digest = { algorithm: 'trustwork-digest-1', value: <64 lowercase hex> }`; `trustwork-digest-1` is SHA-256 over the RFC 8785 (JCS) canonical UTF-8 bytes of an explicit `digestInput`. A future algorithm is a new name, never a silent re-hash.
- `VersionRef = { id, version, digest }`: identity decisions (staleness, comparability, acceptance) use `id`; `digest` detects corruption or substitution (`commercial.digest_mismatch`).
- Digest inputs: RFQ version `{ payload }`; quote version `{ rfqVersion, payload }` so a quote cannot be re-pointed to another RFQ version without changing its digest; agreement `{ quoteVersion, rfqVersion }` computed once when the agreement is created. Acceptance events reference the agreement digest and are never digest input; approvals bind an `actionDigest` computed the same way.
- Staleness is `rfq_version_id` identity, expressed as `staleReason: 'rfq_amended'` on invitations, quote versions and the quote envelope; statuses stay in the lifecycle set (`draft | sent | superseded | withdrawn | expired | accepted`).
- External outcomes are `unknown | acknowledged | final`; the only path from `unknown` to `final` is a `Reconciliation` record with lookup evidence. `outcome_unknown` never releases a reservation or triggers a duplicate order.
- Implementation and tests: `packages/contracts/src/common/{canonical,digest,version}.ts`, `procurement.ts`, `sales.ts`, `transactions.ts`, `assistant.ts`; [ADR 008](008-contracts-and-validation.md) records the validation stack and conventions.

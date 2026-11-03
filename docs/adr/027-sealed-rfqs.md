# ADR 027 — Sealed-until-deadline RFQs

Date: 2026-11-03. Status: **Proposed**. The maintainer ruled on 2026-11-03 that PRC-004 proceeds on this basis and that the change to the frozen contract is recorded here for review.

## Context

[Procurement and supply](../engine/procurement-and-supply.md#sourcing-events-and-bid-levelling) lets a buyer reveal quotes only after the response deadline, which protects suppliers from bid shopping, and says the setting is part of the published RFQ version and visible to suppliers. The frozen `RfqVersionPayloadSchema` in `packages/contracts/src/procurement.ts` is strict and has no such field, and nothing stopped the buyer side from reading a sent quote version at once.

## Decision

1. `RfqVersionPayloadSchema` gains one optional key, `sealedUntilDeadline: boolean`. It is additive: a payload without the key parses and digests exactly as before, so no existing `trustwork-digest-1` changes. A payload with the key is digest-bound like every other term, and invited suppliers read it in the shared version.
2. The seal is enforced in the database, not in the API. The `quote_version_read` policy refuses the buyer side while `sourcing_sealed(rfq_id)` holds; the policies on quote lines and tax determinations read through it. A bug in a service, an agent or a comparison therefore cannot show a sealed bid.
3. The seal cannot be lifted early. Once any published version of the RFQ was sealed, the seal lasts until the latest response deadline across all published versions. An amendment that drops the flag or moves the deadline back shortens nothing, and closing or cancelling the RFQ does not open it.
4. The buyer still sees who answered: the quote envelope and the invitation status carry no price.
5. Once the deadline of a sealed RFQ has passed, the round is closed. No amendment is published, so the deadline never moves later and a seal never comes back; no invitation goes out, a revalidation included (`validation.schema`, `details.reason = sealed_round_closed`). A quote version is sent only if it answers an open amendment request of the buyer (`commercial.quote_not_acceptable`, `details.reason = sealed_deadline_passed`). A late bid therefore cannot undercut opened bids, while negotiation on an opened bid stays possible. A new round is a new RFQ.
6. A sealed version needs a deadline still ahead when it is published.
7. Owner-run readers are held to the seal too. `agents_competitor_amounts`, which refuses a note repeating a competing seller's price, returns nothing while the seal holds, so a refusal cannot confirm a guessed sealed amount.

## Alternatives considered

- **A sourcing-owned side table keyed by RFQ version.** It keeps the frozen file untouched, but the setting would sit outside the digest and outside the supplier's copy of the version, against the design.
- **Checking in the sales service only.** Every reader of quote versions would have to remember the rule; row-level security holds for all of them.

## Consequences

- `packages/contracts/src/procurement.ts` changes outside the usual freeze, and the migration of PRC-004 replaces a policy first created by COM-002.
- A comparison or a buyer quote view during the seal shows no versions. The buyer reads the setting and the deadline in its own RFQ view.
- Who answered stays visible to the buyer during the seal. If a hub later wants that hidden too, that is a further decision.
- The closed round applies to sealed RFQs only. An RFQ that was never sealed may still be amended and invited to after its deadline, as in COM-001: its buyer reads bids at once, so nothing is opened by the deadline.

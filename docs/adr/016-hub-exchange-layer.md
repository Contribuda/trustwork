# ADR 016 — The hub exchange layer: schema registry, capability profiles, usage policies and `trustwork-mesh/2`

Date: 2026-11-01. Status: **Accepted** 2026-11-01 with the owner-delegated answers of [ADR 025](025-owner-delegated-product-decisions-2026-11-01.md) decisions 1 to 8; counsel questions stay open. Originally proposed (architecture agent for the owner's request of 2026-11-01; escalated to the owner and the integrator). Not implemented. Number 015 is reserved for the editorial office proposal; outreach policy is ADR 017. Full design: [Hub exchange architecture](../engine/hub-exchange-architecture.md).

## Context

The owner asked on 2026-11-01 (translated from Russian) for "a high-quality architecture, models and protocols of communication between all hubs: data exchange, modules, content, with automatic translation, and even with the possibility of creating commercial offers and communications between countries and hubs."

[ADR 011](011-federation-mesh.md) and the frozen wire contract [`trustwork-mesh/1`](../engine/federation-protocol.md) (FED-000) fix how nodes identify, sign, syndicate public objects and route deal objects. Version 1 closes its enums (object kinds, data classes, signature purposes, inbox item types) and refuses unknown members, which is right for safety but leaves no way to add a module, evolve a payload, negotiate what a peer supports, attach purpose and retention rules to shared data, mark translations, or carry the cross-border records (threads, orders, e-document references, screening attestations, credential presentations) the request needs. Protocol section 19 says such changes need a new version introduced by an ADR with a compatibility period. This record is that proposal. It relaxes no rule of ADR 011, ADR 014 or the protocol.

## Decision (proposed)

1. **Seven exchange layers.** Identity and trust; transport and envelopes; schemas and versioning; capability negotiation; data classes and usage policies; delivery guarantees; observability without surveillance. A layer may refuse what a lower layer accepted; no layer may widen a lower layer's refusal.
2. **Exchange schema registry.** Every object that crosses a node boundary has a registered exchange schema `tw.<module>.<object>` with `<major>.<minor>` versions generated from the module's Zod contract. A minor version only adds optional members; anything else is a new major identifier. Each version ships a pure down-projection to earlier minors of its major; members marked `essential` may not be dropped. One module owns each schema.
3. **Senders down-project, receivers stay strict.** A sender never sends a minor above the peer's declared support; the digest and signatures cover exactly the bytes sent. Unknown members are still refused.
4. **Deal pins.** A commercial context pins the schema versions in force at its first cross-hub version for its whole life, so both nodes recompute identical digests whatever upgrades happen.
5. **Capability statements and exchange profiles.** Each node publishes a signed capability statement (modules and schema versions produced and consumed, languages and review status, translation offers, commerce features, policy bounds, limits). Peers compute the same intersection, the exchange profile, and store it with its digest. Nothing is sent outside the profile; a missing capability is shown honestly to participants.
6. **Usage policies.** Every `shared_party` delivery and every consented item references a signed usage policy with a closed vocabulary: purpose, audience, retention, onward sharing, model use (including reading translation), residency and export. A receiver that cannot honour it refuses the delivery and stores nothing. New data classes `consented_items` and `editions`.
7. **Delivery guarantees.** Transactional outbox, at-least-once sending with the existing idempotent inbox, reconciliation of unknown outcomes by resending the identical body under the same delivery identifier (never a new identifier), causal order inside a context by sequence and previous digest, maximum age per kind, dead letters that assume no business effect.
8. **`trustwork-mesh/2`.** A strict superset of version 1 that keeps every byte rule (JCS, `trustwork-digest-1`, object signing input, RFC 9421 coverage, `trustwork-merge-1`) and adds: envelope members `schema`, `language`, `policy`, `context`; shared kinds `thread_message`, `order`, `order_event`, `e_document_ref`, `screening_attestation`, `credential_presentation`, `dispute_referral`, `confirmation_request`, `usage_policy`; public kinds `procurement_notice`, `glossary`, `edition`; signature purposes `capabilities` and `usage_policy`; the endpoints `GET /federation/v2/capabilities` and, opt-in, `POST /federation/v2/search`; error codes `schema_unsupported`, `capability_withdrawn`, `policy_unacceptable`, `context_out_of_order`, `screening_required`, `expired`. Nodes offer both versions during a compatibility period of at least 12 months and two engine minor releases (owner question 5); version 1 objects verify forever.
9. **Translation.** The original in the language of record is the only authority for commitments; translations carry their own digest, are labelled and are never binding; structured values are never translated; legal texts are never machine-translated as binding; reading translations of deal text are produced on the reader's hub under its own egress rules; deal text never enters a translation memory; no shared mesh translation service.
10. **Cross-border commerce.** Both hubs screen both parties before the first commercial message and exchange screening attestations that state only the outcome class and list freshness; restricted places are checked for parties, delivery place and declared origin; applicable law and forum are chosen explicitly by the parties from counsel-reviewed templates; taxes, e-invoicing and e-signatures follow the packs and are recorded with rule sources; quotes carry one currency and optional informational reference rates, and Trustwork never converts or holds money; each hub charges only its own participant, with both fee versions disclosed and recorded; cross-border consumer deals are off unless both hubs enable them.
11. **Federated public search** is opt-in for both hubs, public-only, carries no requester identity, and results inherit the intersection of source audiences (R31).
12. **Lawful requests.** A node answers only for data it holds, never relays a foreign authority's request to peers, and never asks a peer to disclose on its behalf.

## Relation to ADR 011

- Refines decision 4: envelopes gain the members of decision 8; the separation of object and HTTP signatures (protocol section 20) is unchanged.
- Extends decision 5 with the shared and public kinds of decision 8; `party_private`, `owner_private` and `staff_case` still never leave a node.
- Implements the "future federated query protocol" of the federation chapter as decision 11, opt-in.
- Decisions 6 to 13 of ADR 011 are unchanged.

## Alternatives considered

- **Freeze the mesh at version 1 and put schema and language markers inside payloads.** No wire change, but payloads are defined as the home node's exact projection, new kinds still need enum changes, and markers inside payloads would be unsigned by the protocol's own rules. Rejected.
- **Open-world extensibility (JSON-LD, unknown members tolerated).** Easier evolution, but a private field could cross unnoticed; contradicts the strict-object rule. Rejected.
- **Adopt the Dataspace Protocol for negotiation and usage control.** Mature for B2B data sharing, but brings catalogue and contract negotiation machinery that our capability profile and per-delivery policy references cover more simply. Borrowed, not adopted.
- **A central translation or search service for the mesh.** Simpler quality control, but centralizes private text or queries and contradicts independent operators. Rejected.

## Consequences

- New contracts: `exchange-registry.ts`, `federation-v2.ts`, `exchange-policy.ts`, `exchange-language.ts`, `cross-border.ts`.
- New packages XCH-001 to XCH-016; XCH-002 stays **blocked** until this record is accepted; amendments to FED-001 to FED-006, REP-002, PAY-001, BILL-002, BILL-003, ESIG-001, DISP-001, PRC-012, PROC-002, RAG-301, AGT-008, AGT-017, DSA-001 and INTL-007.
- The commerce contracts of COM-001 and COM-002 gain an optional cross-border terms block in a new payload minor version, reviewed by the integrator; existing digests are unaffected.
- Reconsideration triggers: an accepted external standard that covers digest-bound commercial objects across independent operators; measured cost of maintaining down-projections; counsel findings on transfers, consumer contracts or sanctions that change what may cross.

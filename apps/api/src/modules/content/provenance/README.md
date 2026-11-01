# Publication provenance (PROV-001)

Status: implementation checkpoint, not accepted. The module owns append-only declarations, exact translation reviews and narrowly scoped credit consent. Shared CNT public wire schemas, rendering and mandatory publication hooks wait for CNT-003 PR #473 to merge. The package remains `in_progress`; nothing is deployed.

## Authority and storage

A declaration binds one publication version, the content digest recomputed by CNT-001 and the draft revision. Its responsible person is the authenticated caller accepting responsibility, never an arbitrary input identity, an editing credit or an agent. Declared participating role keys use the editorial vocabulary and carry `human_declaration`; no runtime execution evidence is invented. Editorial commands require the caller's live elevation and the existing hub publication permission. Person/company commands require existing publication rights; an edit-only right is insufficient. Delegated API principals are refused.

Five tables in the provenance migration have forced row-level security. The runtime can read only the permitted working records and writes through restricted commands. Every record, review, consent, revocation and image attachment is append-only even under maintenance. Changing provenance appends a revision under the publication lock and an optimistic revision check, with audit and an identifiers-only outbox event. Publication content digests remain unchanged.

A consent names one provenance record, one role (`responsible_editor` or `translation_reviewer`), the person's exact current display name and selected channels (`web`, `feed`, `pdf`). The notice is `provenance.credit.v1`; affirmative informed consent is mandatory. Profile/mention consent is never consulted. Only the actual responsible person or recorded reviewer can consent. Overlapping live consents must be revoked before replacement. A new provenance revision needs new consent. Withdrawal remains possible after publication rights are lost. Delivery checks current consent and current credit text; no identity is disclosed when absent. Machine assistance survives credit withdrawal. Downloaded copies cannot be recalled.

## Commands

All four routes use a first-party session, same-origin CSRF and transactional idempotency:

| Route | Input | Result |
| --- | --- | --- |
| `POST /v1/provenance/declarations` | `declaration`, optional elevated `staff.reason` | Record ID and revision |
| `POST /v1/provenance/reviews` | `review`, optional elevated `staff.reason` | Review and record IDs |
| `POST /v1/provenance/consents` | Exact consent and affirmative notice acknowledgement | Consent ID |
| `POST /v1/provenance/revocations` | Consent ID and reason | Revocation acknowledgement |

`capabilities.ts` records these restricted operations. It grants no agent/MCP execution authority and provides no automatic publication switch. There is no public provenance endpoint in this checkpoint. The API does not expose working records to anonymous readers.

## Translation and delivery seams

`provenance.publish` composes the real CNT-001 publication command in the same transaction. Before publication it verifies the exact current provenance/draft revision, pinned source and a review by a different authorized person. A changed draft invalidates the review, including an edit that restores earlier bytes. Review and publication lock the original and translation in stable order. A correction of the original makes delivery metadata stale; retraction or withholding of the original suppresses translation metadata. Reviewed machine translation stays labelled.

`provenance.deliveryMetadata` is an internal owner projection seam, not a frozen public wire shape. It composes the current CNT public-version authority. Once #473 merges, that authority includes its linked-source revocation checks. Source linkage is never reconstructed from a URL. This checkpoint does not claim that existing CNT commands universally enforce the new gate or that any reader, feed or PDF consumes the metadata yet. Those integrations and their acceptance tests are required remaining engineering.

E3 and all automatic publication policies remain OFF and unapproved. Review records do not activate a policy and do not invent authorship. Existing editorial authorship semantics remain owned by CNT.

## Image adapter

`C2paIptcAdapter` has an unavailable default and an explicitly injected fake. The fake attaches a deterministic unsigned test sidecar to unchanged image bytes and records the exact IPTC type `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`. The input binds asset ID, asset byte digest, publication version/digest and provenance record. The attachment command checks an existing clean image artifact linked to that publication. Byte, sidecar, type and binding substitution are rejected.

The fake is not a C2PA encoder, signed manifest, cryptographic authenticity proof or production signing authority. Its checksums only detect substitution relative to the supplied expected binding. There is no provider activation route or signing dependency. A real standards implementation and configured signing authority remain unavailable and need separate conductor review. Generated imagery is illustrative, never documentary or a depiction of an identifiable real person.

## Continuation after CNT-003

1. Verify #473 is merged, fetch and rebase; preserve all upstream status rows, package objects and current source/privacy guards.
2. Add mandatory owning publication/correction/edition hooks without changing applied migrations. All machine translations must use the exact review gate, including legacy command paths and scheduling.
3. Freeze additive public wire schemas and connect detail, pinned versions, issues, walls, feeds, safe JSON-LD and PDF captures. Revocation, correction, removal and retraction must invalidate previous captures at delivery.
4. Wire the seven-language namespace, credit-consent interaction and labels. Verify actual desktop/375px non-English surfaces, negative authorization and race orders; inspect each rendered PDF page.
5. Report exact-head focused checks and CI separately. Native-language and manual screen-reader review remain human acceptance, not automated evidence.

# Publication provenance (PROV-001)

Status: integrated with CNT-001 and CNT-003; nothing is deployed. The acceptance matrix below says what holds. E3 and autonomous publication stay off (ADR 025 decision 24). A technical guard is not permission to publish autonomously.

## Authority and storage

A declaration binds one publication version, its CNT-computed content digest and draft revision. The responsible person is the authenticated first-party caller accepting responsibility, never an arbitrary input identity, editing credit or agent. Functional assisting roles carry `human_declaration`; this is not verified runtime execution evidence. Editorial commands require current elevation and the existing hub permission; person/company commands require publication rights, not merely an edit grant. Delegated API principals are refused.

Declarations, reviews, consents and revocations are append-only; an image record's request never changes and its outcome is written once, including under maintenance. Commands enter a bounded owning transaction gate before publication, version or bundle locks, check expected revisions, and commit audits and identifier-only outbox events transactionally. Published content digests and original versions are never rewritten. A later disclosure cannot remove a translation's original or rebind an already published translation to another original. A corrected translation requires a new exact declaration and distinct authorized review.

## Command ordering and admission

The additive authority migration installs the same node-local transaction advisory gate before every CNT mutation entrypoint, including the scheduled worker, issue/digest loops, legacy edition paths, moderation and internal publication/release helpers. The gate bounds acquisition to five seconds (or a stricter caller timeout). It serializes short database transactions only; renderers and provider calls run outside it. A conflict is returned without an implicit retry. Runtime roles have no direct table writes or access to the internal gate/helpers; their callable commands all enter the owning gate before any domain lock, including locks taken by declaration initializers.

After all domain waits, new declaration, review, consent, withdrawal and correction commands lock and recheck the exact request session and person epoch using the database current clock. Identity and role writers have different existing row orders, so authority rows use `FOR SHARE NOWAIT`: contention refuses the command instead of creating an inverse wait. Participant membership and publication grants remain required. Editorial admission locks the exact session elevation and a currently valid, scope-matching released role assignment. Expired, revoked, wrong-session or stale-epoch authority cannot be refreshed into approval. The content and provenance API command transactions explicitly disable principal refresh; idempotency completion stays in the original transaction. Credit withdrawal deliberately does not require continuing publication rights.

Deterministic PostgreSQL tests hold real domain rows and inspect `pg_blocking_pids` plus the waiting advisory lock. Release/declaration and release/review run in both orders with original UUID before translation for direct, scheduled, worker, correction, issue and digest commands. Separate tests cross idle/absolute expiry during a domain wait and race actual session, membership, editor, role and elevation revocation. A refused duplicate review remains a refusal; it is never treated as a new approval.

## First-party commands

`GET /v1/provenance/publications/:id` supplies a private, no-store working projection and only the caller's own consents. The editor at `/app/publications/:id/edit` uses the following authenticated, same-origin, transactionally idempotent commands; displaying a control never grants authority.

| Route | Input | Result |
| --- | --- | --- |
| `POST /v1/provenance/declarations` | Exact declaration; optional elevated staff reason | Record ID and revision |
| `POST /v1/provenance/reviews` | Exact original/translation binding and review reason | Review and record IDs |
| `POST /v1/provenance/consents` | Exact role, credit, selected channels and affirmative notice | Consent ID |
| `POST /v1/provenance/revocations` | Consent ID and reason | Revocation acknowledgement |
| `POST /v1/provenance/publications/:id/correction-draft` | Expected publication revision, draft and correction note | Prepared correction |
| `POST /v1/provenance/images` | Exact record and binding, private file, IPTC type, alt text and attestations | Image ID, status `pending` (202) |
| `GET /v1/provenance/publications/:id/images` | Publication ID | Label status of the images the caller may see |

The editor saves actual drafts, declares responsibility, requests a separate review, grants or withdraws narrowly scoped credit, and invokes the owning CNT submit/publish/correct commands. All seven content-language choices and locale dictionaries are available. Native translation and manual assistive-technology review remain separate human acceptance.

## Mandatory publication guards

The common CNT blocker and release function require exact provenance on every real publication path, including legacy commands, scheduling and the scheduled worker. Source authority is checked through current SRC linkage and intersected rights ceilings; a matching URL or old snapshot never creates permission. Corrections must first prepare their exact draft, declare it and obtain any required separate translation review. The release command compares every prepared field before freezing the version. Issue, correction-edition and digest release triggers validate every pinned publication. A legacy edition review boolean cannot replace a provenance review.

A disclosed piece (`ai_assisted`, `generated`, `machine_translation`) is released only under a named responsible person: the version being released needs that person's current consent to a public credit on web pages (`content.provenance_credit_required`). This is what makes the reader label name a human. It applies to a version being released, never to one already published, so consent stays free to withdraw: a withdrawal removes the name, keeps the label and blocks nothing later. A piece declared `none` needs no credit and shows no provenance notice.

A correction keeps at least the disclosure of the version it corrects (`provenance.disclosure_required` on the declaration, `content.provenance_disclosure_required` at release, so a record that reached the draft some other way is refused too). `ai_assisted` may become `generated` or `machine_translation`; those two stay as they are, and a version published without a record counts as `ai_assisted` if its assistance flag was set. The floor is what readers of the corrected version were shown: the record in force at its publication and every record since. A published version's own label may rise but never fall, so it cannot be lowered in place first; a kind changed before release binds nothing. The design has no command that corrects a disclosure itself, so a label cannot be removed by a correction: a mislabelled piece stays labelled until such a command is designed and audited. Clearing `assistantAssisted` on the draft is allowed and changes nothing for readers while the record keeps the kind.

A credit never names a tool. `publication_authorship` refuses the literal names in `MACHINE_CREDIT` (`content.credit_names_a_tool`) and the readers drop them; this is a defensive rule for literal names, not proof that any other credit is a person. The author of an automated piece is the editorial office (`kind: editorial`); source-import drafts already use it, and no automated publication exists.

The scheduled worker entry point `content_publish_due` handles each due piece on its own. A piece that no longer passes stays scheduled and is recorded once per reason (`publication.schedule_blocked`); the others in the run still go out, and blocked pieces do not use up the run's limit. Only rule refusals are caught; anything else aborts the run.

A scheduled release is the act of the person who scheduled it. `publication.scheduled_by` records them; each due piece rechecks, for that person, the same doors `content_publish` checked (owner, company member with `company.publish`, editor with the publish right, or for a reviewed piece staff with the review or publish permission; for editorial pieces staff with the publish permission) and that no jurisdiction hold is open. A person who lost the right leaves the piece scheduled and recorded (`content.schedule_authority_lapsed`) until someone who holds the right releases or returns it. A schedule set before the column existed has no author on record and is refused the same way, never attributed to the drafter. The released version's `published_by` and the `publication.scheduled_release` audit row name the scheduler. An elevation is a session fact and is not rechecked; the staff role behind it is. A revocation in flight leaves the piece for the next run, so the outcome is decided by what commits.

Machine translations require a distinct reviewer with current authority at review time. Draft edits invalidate the binding and review, including edits keeping the same version number. Publication rechecks the current original. After publication, an original correction leaves the immutable original digest and review intact and marks the translation stale; an unavailable original withholds its dependent translation. Recursive dependency checks are bounded and deny cycles. The standard editorial second-editor rule remains independently applicable.

## Public delivery and consent

Additive public schemas expose exact version bindings, declared functional roles, honest declaration evidence, original-language/version/digest and stale status. Detail, pinned versions, issues, walls, digests, readers, all nine feeds, inert JSON-LD and PDF use current owner projections. Readers and feeds link to the exact original version. Existing headline-only body suppression and no-store behavior remain. Unrecorded legacy provenance is labelled unavailable, never invented or retroactively certified.

Every reader gets its label from the same two sources: `PROVENANCE_LABEL_KEYS`, exhaustive over the kinds, and `publicationView`. List cards are labelled from the record as well as the older draft flag, so a piece declared `ai_assisted` with the flag off is still labelled in every list. `tests/web/content/labels.probe.tsx` runs every disclosed kind in every maintained language through the card field, the page, JSON-LD, the feed text, the issue reader and the printed page.

Consent binds one provenance record, one role (`responsible_editor` or `translation_reviewer`), the person's exact current display name and selected `web`, `feed` and `pdf` channels. `provenance.credit.v1` requires explicit informed acknowledgement. Profile or mention consent and staff access are never editorial credit consent. Only the responsible person or actual reviewer can grant it; a new record needs new consent. Withdrawal works after publication authority is lost. Delivery checks current consent and current credit text; absent or withdrawn consent leaves functional labels without a name.

Public JSON accepts only web/feed projection choices and refuses a PDF channel override, including when valid PDF-only consent exists. PDF snapshots include exact PDF-scoped provenance while retaining presentation version 2 and optional runtime browser import. Current projection changes, including consent withdrawal, invalidate captured server delivery and in-flight completion; stored bytes remain immutable. Previously downloaded external copies cannot be recalled. Generated PDF evidence must be rendered and every page inspected before visual acceptance is claimed.

## Generated and AI-edited images

A person states what an image is; the worker writes it into the file; readers get only that labelled file.

1. The source goes up as a private publication file (`POST /v1/files/uploads`, parent `publication`, classification `owner_private`). A holder of a publication right, or staff who publish or review in the hub, may attach. A public source is refused (`image_source_public`), because its unlabelled bytes would already be readable.
2. `POST /v1/provenance/images` binds the file to the exact current record of a draft with kind `generated` or `ai_assisted`, the IPTC type (`trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`) and alt text. The attestations `depictsRealPerson: false` and `documentary: false` are literals, so no valid request exists for such an image. News and company posts are refused (`image_documentary`): a generated image never stands where a reader expects documentation (editorial office section 8.5).
3. The worker job `provenance.image_carry` reads the source, checks its digest and writes the property `Iptc4xmpExt:DigitalSourceType` into a copy ([`apps/worker/src/provenance/xmp.ts`](../../../../../worker/src/provenance/xmp.ts)). This is a container edit for JPEG, PNG and WebP with no dependency and no key: the pixels are copied byte for byte. Earlier XMP is replaced, because a person's declaration outranks what a tool wrote. A file holding a C2PA manifest is refused rather than silently broken (`existing_credentials`). An unreachable store is a retry; a file that cannot be labelled is a recorded failure.
4. The copy becomes a new public file of the same owner and publication and goes through the ordinary scan, so location metadata in a source stops it there. A source deleted or erased while the job ran gives no public file: completion locks the source row, so a request still in flight is waited for, records the failure `source_unavailable` and removes the stored labelled bytes. Every recorded failure clears them, so a retry after a worker died between storing and completing leaves nothing behind.
5. Release refuses a `generated` record with no image, and any record with an image that is not carried and clean (`provenance_image_required`). A failed image needs a new declaration.
6. Public projections list the images of the exact record. `GET /v1/publications/:id/images/:imageId` streams the labelled bytes only while that version is shown, with `private, no-store`, so a retraction, hold or deletion applies at once. The reader shows the image with its alt text and the caption from `publicationProvenance.generated`; JSON-LD carries the IPTC URI as `digitalSourceType`.

The record survives erasure of either file: the links clear, the digests stay, and the reader loses the image while keeping the disclosure.

**C2PA is not signed.** `C2paIptcAdapter` defaults to unavailable, and the job then records no credentials. The IPTC property is a label that travels with the file, not a signature: anyone can strip or rewrite it. The fake adapter, injected only in tests, signs nothing: it has `c2paValid=false`, `test_only_unsigned` and a checksum that proves neither authorship nor authenticity. A real adapter needs a dependency (the proposed one is `@contentauth/c2pa-node` from [contentauth/c2pa-js](https://github.com/contentauth/c2pa-js/tree/main/packages/c2pa-node), which requires root lockfile work) and a separately configured signing authority. Neither exists here. The hub design allows this order: file metadata always, content credentials "where the toolchain supports them" (`docs/engine/hub-console/autonomous-editorial.md`).

The printed PDF stays text only: it carries the label, not the image. The first-party editor has no image control, because the web app has no file upload yet; these are API commands.

## Verification and acceptance

Focused PG/API tests cover absent, withdrawn, stale, cross-person, cross-hub and wrong-role authority; immutable content; scheduling; separate translation review; concurrency; crash rollback/takeover/replay; and captured PDF invalidation. Passing checks are not acceptance; maintainers accept.

| Acceptance item | State |
| --- | --- |
| No AI-assisted content renders without a label (tested) | Holds on every reader; see `tests/web/content/labels.test.ts` and `tests/provenance/integration.test.ts` |
| A machine translation stays a draft until a named reviewer approves it | Holds: `provenance_version_blocker`, on publish, schedule, the worker, corrections and bundles; the reviewer is a distinct person with current authority |
| Generated images carry `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia` | Holds in the file itself; an independent decoder reads it in `tests/provenance/xmp.test.ts`, and `tests/provenance/image-pipeline.test.ts` runs the whole path. C2PA manifests stay behind the adapter with its fake |
| Machine translations under a standing policy carry "Machine translation, not reviewed" | The policy does not exist: E3 is off (ADR 025 decision 24) and `PublicProvenanceSchema` admits only `reviewed: true`. The string `machineUnreviewed` is ready in every maintained language for EDIT-002 |

## Integration order

The three unpublished provenance migrations use `20261120100000` through `20261120100002`, sequenced after the sanctions and privacy continuations. The move from the original 12xxx allocation changes filenames only; all SQL bytes and previously applied migrations remain unchanged. Historical verification remains tied to its original source commits.

The shared principal transaction accepts snapshot isolation independently of the no-refresh admission option. Integrated privacy/content tests preserve both options, including the existing default refresh and transaction isolation for unrelated callers.

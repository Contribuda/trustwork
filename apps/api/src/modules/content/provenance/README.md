# Publication provenance (PROV-001)

Status: actual CNT integration, not package acceptance; nothing is deployed. CNT-003 PR #473 merged before this continuation. PROV-001 #97, CNT-001 #5 and CNT-003 #69 own the declaration, publication, reader and PDF boundaries below. The conductor authorizes the minimal WEB-004/006, INTL/LANG, BE-005 and REL-001 integration seams. E3 and autonomous publication remain OFF. A technical guard is not permission to publish autonomously.

## Authority and storage

A declaration binds one publication version, its CNT-computed content digest and draft revision. The responsible person is the authenticated first-party caller accepting responsibility, never an arbitrary input identity, editing credit or agent. Functional assisting roles carry `human_declaration`; this is not verified runtime execution evidence. Editorial commands require current elevation and the existing hub permission; person/company commands require publication rights, not merely an edit grant. Delegated API principals are refused.

Declarations, reviews, consents, revocations and test image attachments are append-only, including under maintenance. Commands enter a bounded owning transaction gate before publication, version or bundle locks, check expected revisions, and commit audits and identifier-only outbox events transactionally. Published content digests and original versions are never rewritten. A later disclosure cannot remove a translation's original or rebind an already published translation to another original. A corrected translation requires a new exact declaration and distinct authorized review.

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

The editor saves actual drafts, declares responsibility, requests a separate review, grants or withdraws narrowly scoped credit, and invokes the owning CNT submit/publish/correct commands. All seven content-language choices and locale dictionaries are available. Native translation and manual assistive-technology review remain separate human acceptance.

## Mandatory publication guards

The common CNT blocker and release function require exact provenance on every real publication path, including legacy commands, scheduling and the scheduled worker. Source authority is checked through current SRC linkage and intersected rights ceilings; a matching URL or old snapshot never creates permission. Corrections must first prepare their exact draft, declare it and obtain any required separate translation review. The release command compares every prepared field before freezing the version. Issue, correction-edition and digest release triggers validate every pinned publication. A legacy edition review boolean cannot replace a provenance review.

Machine translations require a distinct reviewer with current authority at review time. Draft edits invalidate the binding and review, including edits keeping the same version number. Publication rechecks the current original. After publication, an original correction leaves the immutable original digest and review intact and marks the translation stale; an unavailable original withholds its dependent translation. Recursive dependency checks are bounded and deny cycles. The standard editorial second-editor rule remains independently applicable.

## Public delivery and consent

Additive public schemas expose exact version bindings, declared functional roles, honest declaration evidence, original-language/version/digest and stale status. Detail, pinned versions, issues, walls, digests, readers, all nine feeds, inert JSON-LD and PDF use current owner projections. Readers and feeds link to the exact original version. Existing headline-only body suppression and no-store behavior remain. Unrecorded legacy provenance is labelled unavailable, never invented or retroactively certified.

Consent binds one provenance record, one role (`responsible_editor` or `translation_reviewer`), the person's exact current display name and selected `web`, `feed` and `pdf` channels. `provenance.credit.v1` requires explicit informed acknowledgement. Profile or mention consent and staff access are never editorial credit consent. Only the responsible person or actual reviewer can grant it; a new record needs new consent. Withdrawal works after publication authority is lost. Delivery checks current consent and current credit text; absent or withdrawn consent leaves functional labels without a name.

Public JSON accepts only web/feed projection choices and refuses a PDF channel override, including when valid PDF-only consent exists. PDF snapshots include exact PDF-scoped provenance while retaining presentation version 2 and optional runtime browser import. Current projection changes, including consent withdrawal, invalidate captured server delivery and in-flight completion; stored bytes remain immutable. Previously downloaded external copies cannot be recalled. Generated PDF evidence must be rendered and every page inspected before visual acceptance is claimed.

## Unsigned image boundary

`C2paIptcAdapter` defaults to unavailable. Its explicitly injected fake preserves original image bytes and creates a deterministic unsigned test sidecar. It binds asset ID, byte digest, publication version/digest, provenance record and the IPTC type `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`. Database validation requires an existing clean image artifact linked to that publication. Substituted bytes, sidecars, source types and bindings are rejected.

The fake always has `c2paValid=false` and `test_only_unsigned`; its checksums do not prove authorship or authenticity. Actual C2PA encoding/signing and delivery of signed generated-image assets remain incomplete. The minimal proposed dependency is `@contentauth/c2pa-node`, maintained in [contentauth/c2pa-js](https://github.com/contentauth/c2pa-js/tree/main/packages/c2pa-node), behind the existing adapter. Its current source package declares version 0.9.11 and supports signed manifest writing and validation. Pinning a released version requires runtime/native-binary compatibility review and approved root lockfile work; the upstream repository currently requires a newer patched Node 24 than this workspace. Separately configured signing authority is still required. Neither dependency nor credentials are installed here. No provider setup blocks the independent text/translation/consent delivery work. Generated illustrations must not be presented as documentary imagery or identifiable real people.

## Verification and acceptance

Focused PG/API tests cover absent, withdrawn, stale, cross-person, cross-hub and wrong-role authority; immutable content; scheduling; separate translation review; concurrency; crash rollback/takeover/replay; and captured PDF invalidation. Browser and PDF evidence, exact-head commands, failures and counts are recorded in the conductor's `tools/PROV001-integration-result.md`. Historical tests are not current-head CI. Full CI is unchecked until observed passing; worker completion is not maintainer or conductor acceptance. The PR remains draft.

## Integration order

The three unpublished provenance migrations use `20261120100000` through `20261120100002`, sequenced after the sanctions and privacy continuations. The move from the original 12xxx allocation changes filenames only; all SQL bytes and previously applied migrations remain unchanged. Historical verification remains tied to its original source commits.

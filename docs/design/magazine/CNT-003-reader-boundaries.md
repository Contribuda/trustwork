# CNT-003 reader and PDF implementation boundaries

Status: proposed for the missing provenance contract; implemented behavior below is submitted for review.

## Existing public authority

The reader uses CNT-001 public publication, pinned version, archive and issue projections. It does not query working publications for public pages. The workspace uses the caller's session and the existing working projection. Content bodies are text, with the existing inert Markdown subset in the web reader. Sources are links only: no previews, remote images, font downloads or URL fetches. The PDF renderer disables JavaScript, blocks every browser request and uses installed local fonts. The standard geometric magazine artwork remains decorative; no publication image is inferred from a source URL.

The public wire schemas are extracted unchanged into `packages/contracts/src/content-reader.ts`, shared by the API and DataPort. No publication authority, consent rule or editorial mandate is introduced by that extraction. The owning database serializer omits nonconsenting person credits from public detail and feed projections; the reader and PDF also suppress redacted person/company identifiers. Literal AI/tool names are never promoted to authors; assistant involvement is a separate disclosure. This is not an identity classifier for arbitrary freeform credit strings.

## Missing accepted provenance contract

CNT-003's work package requests the responsible editor, agent role names and stale-edition notices. CNT-001 does not expose a public editorial provenance record. Its public authorship fields are `kind`, nullable `id`, freeform `credit` and `assistantAssisted`. Edition links expose language, original/translation role, `machineAssisted` and `reviewed`; they do not pin the original version or identify the public reviewer/editor. A staff working view is not permission to publish those people or their activity.

Consequently the implementation does not invent an editor, an agent role, a review claim or a stale-translation flag. JSON-LD includes type, headline, dates, language, available correction, disclosures and source citations; `editor` is absent. A translated item preserves the machine-assistance label even if the current link says reviewed. Human authorship is taken only from existing public credits. Atom entries require those credits; entries without public credits are omitted from Atom, while RSS and JSON Feed preserve the public entry without invented authorship.

A proposed additive public provenance contract should define:

- A public, consent-checked responsible-editor credit, with the action/version that establishes responsibility.
- Structured participating agent roles with an accountable person and a public disclosure policy; no agent as author.
- Original publication/version binding, reviewed translation version, reviewer authority and the precise stale rule.
- An explicit source-item and immutable version binding for richer provenance display. Ordinary current-source enforcement already uses the existing authoritative SRC-001 publication linkage; it does not wait for this proposal.

These fields require maintainer acceptance before implementation. This proposal grants no new authority and changes no automatic publication policy.

### Concrete additive proposal (not accepted or implemented)

Propose an optional `publicProvenance` object on a published version, assembled only by the owning serializer:

| Proposed field | Authority and withholding rule |
| --- | --- |
| `responsibleEditor` | A public credit bound to the publication version, editorial responsibility action and accountable person. Requires a dedicated, versioned publication-consent purpose accepted by the owning consent module. An existing staff role, working-view name or authorship string grants no publication consent. Omit on withdrawal. |
| `participatingRoles` | Structured registry role identifiers and localized disclosure keys, pinned to actual contribution events for that version. Keep internal run, prompt, provider and staff fields private. Each event has an accountable person in the private record; publishing that person's credit requires the explicit rule above. Roles are assistance disclosures, never authors. |
| `original` | Original publication identifier, immutable version and digest, plus the translation version that used it. Resolve only through current public projections. Omit links and text when the original is withheld. |
| `review` | Review action bound to the exact translation version and pinned original version, with consent-checked reviewer credit. A later review does not retroactively certify older editions. |
| `stale` | Derive only when a bound original exists, is currently public, and its current version differs from the original version bound to this translation. Without a binding the status is unknown, not false. |

Acceptance needs conductor approval of this shape, the consent purpose and withdrawal behavior, authoring/review authority, locale copy in all seven languages, migration and backward-compatibility rules, and real negative authorization/concurrency tests. No fields above have been added to the live contract. Freeform-name filtering is only a defensive display rule, never proof of human identity.

## PDF persistence and delivery

`CONTENT_PDF_RENDERER=local` opts the existing worker into `content.render_pdf`. It requires the already installed Playwright Chromium runtime. There is no provider or storage account. The job receives a render identifier, obtains the immutable issue revision from the database, and computes a PDF from its pinned public versions. A revision advisory lock serializes duplicate jobs and separate requests. Bytes, SHA-256, captured-projection digest, render completion and the existing worker fencing check commit in one database transaction. A failed transaction leaves no durable artifact. One append-only blob exists per revision, capped at 20 MiB; this is a bounded initial persistence seam, not a general-purpose object store.

`GET`/`HEAD /v1/magazine/issues/:number/pdf?edition=N` rechecks the live public projection and licence eligibility before returning bytes. Responses are `private, no-store`, download-only and sandboxed. A correction, retraction, moderation removal or loss of a consented credit invalidates the old artifact when its captured projection no longer matches. A new issue edition produces a new artifact; old bytes remain retained but unavailable. This is deliberately conservative: it does not silently rewrite an old PDF to add a correction.

Public detail, pinned versions, API feeds, issue slots, walls, local digests and PDF now share the owning `content_source_current_ok` gate. Each external reference requires exactly one SRC-001 item explicitly linked to this publication and URL. Item, source and activated import batch must agree on source and hub; the source is active and the item drafted. An absent or ambiguous link withholds content. A URL match on another publication is insufficient. No remote URL is fetched and no registry working field is projected.

The publication snapshot, imported-item snapshot and current source flags are intersected for the actual treatment (including model assistance). Current rights never widen historical ceilings. `headline_link` never returns a body, including in pinned web/PDF views. Own reporting with no imported linkage needs no registry row. Source changes do not rewrite the immutable publication or issue revision; withheld issue slots retain their position, publication/version binding and digest.

The current publication and the pinned version must each pass. Correction, moderation and retraction rules remain in force; retracted records retain their explanation but withhold the body. Source revocation independently withholds the entire affected publication projection, including title, credits and source fields. A correction to original reporting cannot revive a revoked earlier source version. A consent withdrawal removes the credit in the database projection and invalidates a PDF captured with that credit.

All content API responses and all nine RSS/Atom/JSON Feed routes are `private, no-store`; DataPort fetches are also `no-store`. PostgreSQL statement snapshots determine concurrent read order: a read before a revocation commit may return the previously authorized projection; every later read under the API's READ COMMITTED transactions sees the committed restriction. Tests cover both orders, including an already open transaction re-reading after commit. Previously downloaded client bytes cannot be recalled.

The PDF cover contains only reader-facing issue information and contents. Raw revision UUID and digest stay in the database snapshot/artifact binding, not visible cover text.

## Verification limits

Focused tests exercise restricted database roles, real outbox/worker completion, duplicate requests, concurrent revision locks, rollback, correction/removal/retraction races, source licence revocation and consent revocation. Local browser acceptance uses a real API, embedded PostgreSQL, the live DataPort, installed Chromium and synthetic content. Automated accessibility checks and keyboard focus are not a manual screen-reader review. Native-language editorial review and manual screen-reader review remain incomplete; automated seven-language checks establish neither. Full local checks, production, provider calls and deployment are out of scope for this worker run; CI and maintainer acceptance remain separate.

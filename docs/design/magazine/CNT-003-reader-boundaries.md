# CNT-003 reader and PDF implementation boundaries

Status: proposed for the missing provenance contract; implemented behavior below is submitted for review.

## Existing public authority

The reader uses CNT-001 public publication, pinned version, archive and issue projections. It does not query working publications for public pages. The workspace uses the caller's session and the existing working projection. Content bodies are text, with the existing inert Markdown subset in the web reader. Sources are links only: no previews, remote images, font downloads or URL fetches. The PDF renderer disables JavaScript, blocks every browser request and uses installed local fonts. The standard geometric magazine artwork remains decorative; no publication image is inferred from a source URL.

The public wire schemas are extracted unchanged into `packages/contracts/src/content-reader.ts`, shared by the API and DataPort. No publication authority, consent rule or editorial mandate is introduced by that extraction. Public credits with a redacted person/company identifier are suppressed in the reader and PDF. Literal AI/tool names are never promoted to authors; assistant involvement is a separate disclosure. This is not an identity classifier for arbitrary freeform credit strings.

## Missing accepted provenance contract

CNT-003's work package requests the responsible editor, agent role names and stale-edition notices. CNT-001 does not expose a public editorial provenance record. Its public authorship fields are `kind`, nullable `id`, freeform `credit` and `assistantAssisted`. Edition links expose language, original/translation role, `machineAssisted` and `reviewed`; they do not pin the original version or identify the public reviewer/editor. A staff working view is not permission to publish those people or their activity.

Consequently the implementation does not invent an editor, an agent role, a review claim or a stale-translation flag. JSON-LD includes type, headline, dates, language, available correction, disclosures and source citations; `editor` is absent. A translated item preserves the machine-assistance label even if the current link says reviewed. Human authorship is taken only from existing public credits. Atom entries require those credits; entries without public credits are omitted from Atom, while RSS and JSON Feed preserve the public entry without invented authorship.

A proposed additive public provenance contract should define:

- A public, consent-checked responsible-editor credit, with the action/version that establishes responsibility.
- Structured participating agent roles with an accountable person and a public disclosure policy; no agent as author.
- Original publication/version binding, reviewed translation version, reviewer authority and the precise stale rule.
- A source-item identifier and revision binding for each external reference, with a public projection of current licence/takedown status.

These fields require maintainer acceptance before implementation. This proposal grants no new authority and changes no automatic publication policy.

## PDF persistence and delivery

`CONTENT_PDF_RENDERER=local` opts the existing worker into `content.render_pdf`. It requires the already installed Playwright Chromium runtime. There is no provider or storage account. The job receives a render identifier, obtains the immutable issue revision from the database, and computes a PDF from its pinned public versions. A revision advisory lock serializes duplicate jobs and separate requests. Bytes, SHA-256, captured-projection digest, render completion and the existing worker fencing check commit in one database transaction. A failed transaction leaves no durable artifact. One append-only blob exists per revision, capped at 20 MiB; this is a bounded initial persistence seam, not a general-purpose object store.

`GET`/`HEAD /v1/magazine/issues/:number/pdf?edition=N` rechecks the live public projection and licence eligibility before returning bytes. Responses are `private, no-store`, download-only and sandboxed. A correction, retraction, moderation removal or loss of a consented credit invalidates the old artifact when its captured projection no longer matches. A new issue edition produces a new artifact; old bytes remain retained but unavailable. This is deliberately conservative: it does not silently rewrite an old PDF to add a correction.

A third-party reference must match an explicitly linked SRC-001 source item for that publication and URL. Both snapshot blockers and current source permissions are checked; the source must be active, the item drafted and permitted for the actual treatment. An unlinked source URL fails closed for PDF. Original reporting does not need a fabricated registry row. This guard does not retrofit SRC-001 linkage into all existing CNT-001 web/API projections: those still expose the accepted snapshot contract. Broader live source revocation on those surfaces is a separate contract/integration boundary, not proven by PDF tests.

## Verification limits

Focused tests exercise restricted database roles, real outbox/worker completion, duplicate requests, concurrent revision locks, rollback, correction/removal/retraction races, source licence revocation and consent revocation. Local browser acceptance uses a real API, embedded PostgreSQL, the live DataPort, installed Chromium and synthetic content. Automated accessibility checks and keyboard focus are not a manual screen-reader review. Full local checks, production, provider calls and deployment are out of scope for this worker run; CI and maintainer acceptance remain separate.

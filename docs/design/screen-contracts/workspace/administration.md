# Platform administration: editorial, moderation, support, commercial offers and prices

Routes (proposed): `/admin` (landing by role), `/admin/editorial`, `/admin/moderation`, `/admin/support`, `/admin/commercial`. Entered from the avatar menu ("Administration") only when the person holds at least one platform role. Not a company setting, not in the workspace sidebar.

## Status and evidence

`no reference`. Spec R20 (platform commercial administration versions offers, plans, prices, entitlements, usage and credits; effective dates and price acceptance; separate editorial/moderation/support/company administration), "Content and editorial" (lifecycle with review; issue release freezes order and versions; corrections create revisions), access table rows Editorial/moderation, Commercial platform admin, Support (case-scoped, audited; never customer transactions; no default private negotiation access); IA ("separately permissioned administration surface").

## Audience and access policy

| Role | Area | Boundary |
|---|---|---|
| Editorial | Review queue, scheduling, magazine issue curation/release/corrections, taxonomy | Public content policy only; no commercial data |
| Moderation | Reports on public content/profiles, consent/portrait issues, retractions by policy, directory record disputes (sourced vs claimed) | Scoped case evidence only |
| Support | Case list; per case an explicit audited grant to a diagnostic view of specific objects; never by default | Case-scoped; read-only unless case grant says otherwise; audit visible to the affected user where policy says so |
| Commercial admin | Offers/plans/prices/entitlements versions with effective dates; usage and credits views; no customer transactions | Separate from editorial right |
| Platform admin without case grant | Sees nothing private (authorization suite requirement) | |

Every action is audited with actor identity; UI shows "This action will be recorded in the audit log" on consequential forms.

## Data projection

| Area | Content |
|---|---|
| Editorial queue | Publications in review: title, author credit, format, submitted, reviewer, SLA; actions approve/return with feedback/schedule |
| Magazine issues | Draft/curated/review/released/corrected; TOC editor pinning publication versions; release checklist (web reader check, PDF generated and checked page-by-page, accessibility plan); corrections editor producing edition 2+ |
| Taxonomy | Topics, formats, categories, units (O11) with versions |
| Moderation cases | Report type, target (public projection reference), reporter (if permitted), evidence, decision, appeal |
| Support cases | Case id, user (minimal), subject, granted scope (objects, fields, expiry), actions log |
| Commercial | Offer versions (plan, price, currency, trial duration, entitlements, effective from/to, status draft/published/retired); acceptance stats as counts (no per-user listing beyond permission); credits/usage aggregates |

## Primary tasks

1. Review and schedule publications; release and correct magazine issues.
2. Handle reports and consent problems with evidence.
3. Help a user through a scoped, audited diagnostic view.
4. Publish versioned offers with effective dates; never edit a published version in place.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Admin shell: distinct header band label "Administration" (so staff never confuse it with the workspace), left sub-navigation per granted areas, content with DataTables and detail panels; return link "Back to the workspace" |
| Tablet | Sub-navigation collapses to tabs |
| Mobile <768 | Supported for reading queues and approving/returning; complex editors (issue TOC, offer versions) show "Easier on a wide screen" note but remain operable |

## Component inventory

AdminShell (reuses workspace primitives with a different accent band), SubNav, DataTable with filters and saved views, QueueRow, ReviewPanel (publication preview + feedback form), IssueEditor (ordered list with keyboard reordering: move up/down buttons, not drag-only), ReleaseChecklist (checkbox items with evidence links), CorrectionEditor, TaxonomyTree (tree view pattern), CaseCard, EvidenceList, ScopeGrantForm (objects, fields, expiry; audited), OfferVersionTable, OfferVersionForm (price in minor units with currency, effective dates, entitlements), PublishConfirmDialog ("A published version cannot be changed; create a new one"), AuditNote, EmptyState, Skeleton, Toast.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Queue: "No materials in review"; cases: "No open cases"; offers: "No published versions" |
| Loading | Skeleton |
| Error | Inline + retry |
| Permission-denied | Area missing from sub-nav; direct URL → NoAccess; case view without grant → NoAccess with "Request case-based access" |
| Offline | Read-only |
| Partial/stale | Issue release blocked: checklist shows unmet items; offer with past effective date cannot be edited; publication changed since review started → "The author changed the material; review it again" |

## Keyboard order and focus

Admin header → sub-nav → filters → table → detail panel. Issue TOC reordering via buttons with announcements ("Material moved to position 3"). Publish confirmation focuses Cancel.

## Responsive table behaviour

All admin tables → cards below 768 with a "Show columns" control on tablet.

## Locale keys

| Key | English |
|---|---|
| `admin.title` | Administration |
| `admin.backToWorkspace` | Back to the workspace |
| `admin.nav.editorial` | Editorial |
| `admin.nav.moderation` | Moderation |
| `admin.nav.support` | Support |
| `admin.nav.commercial` | Commercial terms |
| `admin.auditNote` | This action will be recorded in the audit log |
| `admin.editorial.queue` | In review |
| `admin.editorial.queueEmpty` | No materials in review |
| `admin.editorial.approve` | Approve |
| `admin.editorial.return` | Return with comments |
| `admin.editorial.schedule` | Schedule |
| `admin.editorial.changedSinceReview` | The author changed the material; review it again |
| `admin.issues.title` | Magazine issues |
| `admin.issues.state.draft` | Draft |
| `admin.issues.state.curated` | Curated |
| `admin.issues.state.review` | In review |
| `admin.issues.state.released` | Released |
| `admin.issues.state.corrected` | Corrected edition |
| `admin.issues.moveUp` | Move up |
| `admin.issues.moveDown` | Move down |
| `admin.issues.moved` | Material moved to position {index} |
| `admin.issues.checklist` | Issue release checklist |
| `admin.issues.check.web` | Web version checked on mobile |
| `admin.issues.check.pdf` | PDF built and checked page by page |
| `admin.issues.check.a11y` | PDF accessibility plan completed |
| `admin.issues.release` | Release |
| `admin.issues.correct` | Create a corrected edition |
| `admin.taxonomy.title` | Reference lists |
| `admin.moderation.cases` | Cases |
| `admin.moderation.casesEmpty` | No open cases |
| `admin.moderation.decision` | Decision |
| `admin.moderation.appeal` | Appeal |
| `admin.support.cases` | Support cases |
| `admin.support.grantScope` | Case-based access |
| `admin.support.grantExpires` | Access until {date} |
| `admin.support.requestAccess` | Request case-based access |
| `admin.commercial.offers` | Offer versions |
| `admin.commercial.noOffers` | No published versions |
| `admin.commercial.plan` | Plan |
| `admin.commercial.price` | Price |
| `admin.commercial.trialDays` | Trial period, days |
| `admin.commercial.entitlements` | Entitlements |
| `admin.commercial.effectiveFrom` | Effective from |
| `admin.commercial.effectiveTo` | Effective until |
| `admin.commercial.state.draft` | Draft |
| `admin.commercial.state.published` | Published |
| `admin.commercial.state.retired` | Retired |
| `admin.commercial.publishConfirm` | A published version cannot be changed; to make changes, create a new version. |
| `admin.commercial.acceptances` | {count, plural, one {# acceptance} other {# acceptances}} |
| `admin.commercial.usage` | Usage and credits |
| `admin.narrowScreenNote` | Easier on a wide screen |

## Open questions

- Route prefix (`/admin` vs `/app/admin`): proposal `/admin` to keep the separate permission surface obvious.
- Which roles may combine (editorial + commercial) — policy; UI supports any union.
- Support diagnostic view design per object type — deferred to BILL-001/BE-001; only the grant form is contracted.

# Companies hub and company public page

Routes: `/companies`, `/companies/[slug]`.

## Status and evidence

`proposed (reference: accepted direction)` for the hub — `companies-hub.png` (private design archive), manifest `accepted_direction`: "Distinguish sourced, claimed and verified records; no verification based only on company identifiers." `no reference` for the public company page. Spec R02, R06, R14, R15, "Identity, company and public pages"; open decisions O05, O07; access table rows Anonymous / Company member.

## Audience and access policy

| Viewer | Hub | Company page |
|---|---|---|
| Anonymous / registered non-member | Public projections of sourced, claimed and verified records | Public projection: details, wall, public people (consented), public catalogue entries, public projects, reputation summary under O07 policy, external site |
| Company member | Same plus "Open in the workspace" link to `/app/company` | Same plus member link; no inline editing on the public page |
| Company administrator | Same | Same; editing happens in `/app/company` |

A **sourced** record is a directory entry derived from a permitted source with provenance; it has no account. A **claimed** record has an authorized human who asserted control under the claim policy (O05, unresolved). A **verified** record passed the verification policy (not yet defined; INN alone is insufficient). The badge must always say which one applies; never show a star or "checked" for a sourced record.

## Data projection

| Field | Sourced | Claimed | Verified |
|---|---|---|---|
| Name, direction tags, region(s) | from source, labelled with source | editable by claimant | editable |
| Description, logo, photos | not shown unless licensed from source | yes (licensed uploads) | yes |
| External website | from source | yes | yes |
| Catalogue (goods/works/services; public entries only, never private floors) | no | optional | optional |
| People (consented members only) | no | yes | yes |
| Projects (explicit public projections) | no | yes | yes |
| Publications (company-authored, published) | no | yes | yes |
| Reputation: dimension scores (timing, quality, payment, cooperation), sample counts, methodology version, "not enough data" | no | only when evidence exists and O07 policy allows display | same |
| Subjective reviews (published under policy, appealable) | no | yes | yes |
| Provenance line ("Source: …, updated …") | yes | "Stated by a representative" + date | "Verified" + method + date |
| Credentials, private memberships, quotes, budgets, messages | never | never | never |

## Primary tasks

1. Find a company by name, identifier or direction.
2. Judge trustworthiness from labelled evidence, not badges.
3. Open the company's page, catalogue, projects, publications or external site.
4. Claim or create a company page (leads into workspace flow).

## Layout regions

| Width | Hub | Company page |
|---|---|---|
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; outlined "Present a company"; search + "Find"; direction chips; filter row (Region, Goods, works and services, Confirmed experience, sort; `companies.filter.*`); optional "Reputation in detail" block only when policy O07 allows and only for records with sufficient samples; "Find your partner" list rows (logo, name, status badge, tagline, region, description, tags, up to 3 licensed photos, reputation summary or "no data", counts of public projects/publications, "Company profile", "Website"); right rail (directions, "What the profile shows" (`companies.whatVisible`), claim CTA); "Companies share their experience" (`companies.sharingTitle`); "Experience you can see" (`companies.projectsTitle`); CTA band; footer | Public shell; breadcrumb; header card (logo, name, status badge + provenance line, direction tags, region, website, "Open in the workspace" for members); tabs: Overview, Catalogue, People, Projects, Publications, Reputation (`companies.tabs.*`); content per tab; right rail: contact/website, provenance, "Report an error" |
| Tablet | Filters wrap; list rows keep two columns (text, photos) until 900 then stack; rail below | Tabs scroll; rail below |
| Mobile <768 | Chips horizontal scroll; filters in sheet; row: logo+name+badge, tagline, region, 1 photo, counts, two full-width buttons | Header stacks; tabs scroll; each tab single column |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect/FilterSheet, StatusBadge (sourced/claimed/verified), ProvenanceLine, CompanyRow, ReputationSummary (dimension bars with numeric values, sample count, methodology link, "no data" state), PhotoStrip, RailCard, Tabs, CatalogueList (public entries, grouped goods/works/services), PeopleList (consented), ProjectCardList, PublicationCardList, ReviewList (with appeal/correction markers), ReportIssueLink, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (search) | "No companies found" + reset + "Present a company" |
| Empty tab | "The company has not published a catalogue yet" etc.; no fake entries |
| Loading | Skeleton rows; reputation block shows skeleton only when it will render |
| Error | Inline error + retry |
| Permission-denied | Not applicable to public data; member link hidden for non-members; private slug → 404 |
| Offline | Cached readable; actions toast |
| Partial/stale | Sourced record older than policy threshold shows "The source data may be out of date"; reputation with samples below minimum shows "Not enough data" instead of numbers; disputed observations annotated "Disputed" |

## Keyboard order and focus

Shell → breadcrumb → H1 → "Present a company" → search → chips → filters → rows (name link, then "Website", "Company profile") → rail. Company page: header links → tabs (arrow keys, `aria-controls`) → tab panel → rail. After selecting a tab focus stays on the tab; panel has `tabindex="-1"` for programmatic focus when deep-linked (`#catalogue`).

## Responsive table behaviour

Catalogue tab may render a table (name, unit, price-on-request flag, version date). Below 768 it becomes stacked cards with `dt/dd` pairs; sorting controls move to a select. Reputation bars are not tables; they are a description list with visible numbers and sample counts.

## Locale keys

| Key | English |
|---|---|
| `companies.title` | The companies that build the industry *(wording from reference; editorial review)* |
| `companies.lede` | Get to know their experience, projects and publications. Find partners for your projects. *(wording from reference; editorial review)* |
| `companies.present` | Present a company |
| `companies.searchPlaceholder` | Company name, registration identifier of the active country pack (for example STIR in Uzbekistan) or line of business |
| `companies.allDirections` | All areas |
| `companies.filter.region` | Region |
| `companies.filter.offer` | Goods, works and services |
| `companies.filter.confirmedExperience` | Confirmed experience |
| `companies.sort.relevance` | By relevance |
| `companies.findPartner` | Find your partner |
| `companies.profile` | Company profile |
| `companies.site` | Website |
| `companies.openInWorkspace` | Open in the workspace |
| `companies.empty` | No companies found |
| `companies.tabs.overview` | Overview |
| `companies.tabs.catalogue` | Catalogue |
| `companies.tabs.people` | People |
| `companies.tabs.projects` | Projects |
| `companies.tabs.publications` | Publications |
| `companies.tabs.reputation` | Reputation |
| `companies.catalogueEmpty` | The company has not published a catalogue yet |
| `companies.claimTitle` | Is your company already here? |
| `companies.claimBody` | Present the company and manage its public page. |
| `companies.claimAction` | Manage the page |
| `status.sourced` | From open sources |
| `status.claimed` | Claimed by the company |
| `status.verified` | Verified |
| `status.sourcedHint` | The record was created from an open source; the company has not confirmed the data yet. |
| `provenance.source` | Source: {source}, updated {date} |
| `provenance.stale` | The source data may be out of date |
| `reputation.title` | Reputation in detail |
| `reputation.howCounted` | How the score is counted |
| `reputation.timing` | Timing |
| `reputation.quality` | Quality |
| `reputation.payment` | Payment |
| `reputation.cooperation` | Cooperation |
| `reputation.samples` | {count, plural, one {# observation} other {# observations}} |
| `reputation.insufficient` | Not enough data |
| `reputation.disputed` | Disputed |
| `reputation.methodology` | Methodology, version {version} |
| `common.reportIssue` | Report an error |

## Open questions

- O05: claim and verification policy; until decided the hub shows only sourced and claimed labels, never verified.
- O07: whether any reputation numbers may be public; if not, the "Reputation in detail" block is omitted entirely.
- Company registration identifiers (the active country pack's `registrationIdentifier`, e.g. STIR for UZ) in search: allowed as exact lookup; display policy for identifiers on the public page pending legal (O06).

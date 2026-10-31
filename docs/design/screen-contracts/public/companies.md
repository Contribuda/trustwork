# Companies hub and company public page

Routes: `/companies`, `/companies/[slug]`.

## Status and evidence

`proposed (reference: accepted direction)` for the hub — `companies-hub.png` (private design archive), manifest `accepted_direction`: "Distinguish sourced, claimed and verified records; no verification based only on company identifiers." `no reference` for the public company page. Spec R02, R06, R14, R15, "Identity, company and public pages"; open decisions O05, O07; access table rows Anonymous / Company member.

## Audience and access policy

| Viewer | Hub | Company page |
|---|---|---|
| Anonymous / registered non-member | Public projections of sourced, claimed and verified records | Public projection: details, wall, public people (consented), public catalogue entries, public projects, reputation summary under O07 policy, external site |
| Company member | Same plus «Открыть в рабочем пространстве» link to `/app/company` | Same plus member link; no inline editing on the public page |
| Company administrator | Same | Same; editing happens in `/app/company` |

A **sourced** record is a directory entry derived from a permitted source with provenance; it has no account. A **claimed** record has an authorized human who asserted control under the claim policy (O05, unresolved). A **verified** record passed the verification policy (not yet defined; INN alone is insufficient). The badge must always say which one applies; never show a star or «проверено» for a sourced record.

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
| Reputation: dimension scores (timing, quality, payment, cooperation), sample counts, methodology version, «данных недостаточно» | no | only when evidence exists and O07 policy allows display | same |
| Subjective reviews (published under policy, appealable) | no | yes | yes |
| Provenance line («Источник: …, обновлено …») | yes | «Заявлено представителем» + date | «Подтверждено» + method + date |
| Credentials, private memberships, quotes, budgets, messages | never | never | never |

## Primary tasks

1. Find a company by name, identifier or direction.
2. Judge trustworthiness from labelled evidence, not badges.
3. Open the company's page, catalogue, projects, publications or external site.
4. Claim or create a company page (leads into workspace flow).

## Layout regions

| Width | Hub | Company page |
|---|---|---|
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; outlined «Представить компанию»; search + «Найти»; direction chips; filter row (Регион, Товары, работы и услуги, Подтверждённый опыт, sort); optional «Репутация в деталях» block only when policy O07 allows and only for records with sufficient samples; «Найдите своего партнёра» list rows (logo, name, status badge, tagline, region, description, tags, up to 3 licensed photos, reputation summary or «нет данных», counts of public projects/publications, «Профиль компании», «Сайт»); right rail (directions, «Что видно в профиле», claim CTA); «Компании делятся опытом»; «Опыт, который можно увидеть»; CTA band; footer | Public shell; breadcrumb; header card (logo, name, status badge + provenance line, direction tags, region, website, «Открыть в рабочем пространстве» for members); tabs: Обзор, Каталог, Люди, Проекты, Публикации, Репутация; content per tab; right rail: contact/website, provenance, «Сообщить об ошибке» |
| Tablet | Filters wrap; list rows keep two columns (text, photos) until 900 then stack; rail below | Tabs scroll; rail below |
| Mobile <768 | Chips horizontal scroll; filters in sheet; row: logo+name+badge, tagline, region, 1 photo, counts, two full-width buttons | Header stacks; tabs scroll; each tab single column |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect/FilterSheet, StatusBadge (sourced/claimed/verified), ProvenanceLine, CompanyRow, ReputationSummary (dimension bars with numeric values, sample count, methodology link, «нет данных» state), PhotoStrip, RailCard, Tabs, CatalogueList (public entries, grouped goods/works/services), PeopleList (consented), ProjectCardList, PublicationCardList, ReviewList (with appeal/correction markers), ReportIssueLink, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (search) | «Компании не найдены» + reset + «Представить компанию» |
| Empty tab | «Компания пока не опубликовала каталог» etc.; no fake entries |
| Loading | Skeleton rows; reputation block shows skeleton only when it will render |
| Error | Inline error + retry |
| Permission-denied | Not applicable to public data; member link hidden for non-members; private slug → 404 |
| Offline | Cached readable; actions toast |
| Partial/stale | Sourced record older than policy threshold shows «Данные источника могли устареть»; reputation with samples below minimum shows «Данных недостаточно» instead of numbers; disputed observations annotated «Оспаривается» |

## Keyboard order and focus

Shell → breadcrumb → H1 → «Представить компанию» → search → chips → filters → rows (name link, then «Сайт», «Профиль компании») → rail. Company page: header links → tabs (arrow keys, `aria-controls`) → tab panel → rail. After selecting a tab focus stays on the tab; panel has `tabindex="-1"` for programmatic focus when deep-linked (`#catalogue`).

## Responsive table behaviour

Catalogue tab may render a table (name, unit, price-on-request flag, version date). Below 768 it becomes stacked cards with `dt/dd` pairs; sorting controls move to a select. Reputation bars are not tables; they are a description list with visible numbers and sample counts.

## Locale keys

| Key | Russian |
|---|---|
| `ru.companies.title` | Компании, которые создают отрасль *(wording from reference; editorial review)* |
| `ru.companies.lede` | Знакомьтесь с опытом, проектами и публикациями. Находите партнёров по делу. *(wording from reference; editorial review)* |
| `ru.companies.present` | Представить компанию |
| `companies.searchPlaceholder` | Company name, registration identifier of the active country pack (for example STIR in Uzbekistan) or line of business |
| `ru.companies.allDirections` | Все направления |
| `ru.companies.filter.region` | Регион |
| `ru.companies.filter.offer` | Товары, работы и услуги |
| `ru.companies.filter.confirmedExperience` | Подтверждённый опыт |
| `ru.companies.sort.relevance` | По соответствию |
| `ru.companies.findPartner` | Найдите своего партнёра |
| `ru.companies.profile` | Профиль компании |
| `ru.companies.site` | Сайт |
| `ru.companies.openInWorkspace` | Открыть в рабочем пространстве |
| `ru.companies.empty` | Компании не найдены |
| `ru.companies.tabs.overview` | Обзор |
| `ru.companies.tabs.catalogue` | Каталог |
| `ru.companies.tabs.people` | Люди |
| `ru.companies.tabs.projects` | Проекты |
| `ru.companies.tabs.publications` | Публикации |
| `ru.companies.tabs.reputation` | Репутация |
| `ru.companies.catalogueEmpty` | Компания пока не опубликовала каталог |
| `ru.companies.claimTitle` | Ваша компания уже здесь? |
| `ru.companies.claimBody` | Представьте компанию и управляйте её публичной страницей. |
| `ru.companies.claimAction` | Управлять страницей |
| `ru.status.sourced` | Из открытого источника |
| `ru.status.claimed` | Заявлена, ожидает подтверждения |
| `ru.status.verified` | Подтверждена |
| `ru.status.sourcedHint` | Запись создана по открытому источнику; компания ещё не подтвердила данные. |
| `ru.provenance.source` | Источник: {source}, обновлено {date} |
| `ru.provenance.stale` | Данные источника могли устареть |
| `ru.reputation.title` | Репутация в деталях |
| `ru.reputation.howCounted` | Как считается оценка |
| `ru.reputation.timing` | Сроки |
| `ru.reputation.quality` | Качество |
| `ru.reputation.payment` | Оплата |
| `ru.reputation.cooperation` | Взаимодействие |
| `ru.reputation.samples` | {count, plural, one {# наблюдение} few {# наблюдения} many {# наблюдений}} |
| `ru.reputation.insufficient` | Данных недостаточно |
| `ru.reputation.disputed` | Оспаривается |
| `ru.reputation.methodology` | Методика, версия {version} |
| `ru.common.reportIssue` | Сообщить об ошибке |

## Open questions

- O05: claim and verification policy; until decided the hub shows only sourced and claimed labels, never verified.
- O07: whether any reputation numbers may be public; if not, the «Репутация в деталях» block is omitted entirely.
- Company registration identifiers (the active country pack's `registrationIdentifier`, e.g. STIR for UZ) in search: allowed as exact lookup; display policy for identifiers on the public page pending legal (O06).

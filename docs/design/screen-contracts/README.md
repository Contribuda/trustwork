# Screen contracts (DS-000)

Status: **proposed**. Produced by task DS-000 on 2026-10-27 from the eleven reference images in the private design archive, the the private reference manifest, the [design inventory](../README.md), the [product specification](../../product/specification.md), the [information architecture](../../product/information-architecture.md), [access and journeys](../../product/access-and-journeys.md), [open decisions](../../product/open-decisions.md), [accessibility acceptance](../../quality/accessibility.md), the [retrieval API contract](../../architecture/retrieval-api.md) and the current [Russian locale](../../../packages/ui/locales/ru.json). Nothing here grants design approval; the manifest remains the only record of reference status, and `workspace-latest.png` stays **proposed/unapproved** until a human decides (see [human review request](human-review-request.md)).

## What a screen contract is

A contract describes what a screen must do before anyone draws or implements it in full: who may see it, which fields it projects, which tasks it serves, how it lays out at three widths, which components it needs, which states it must handle, how the keyboard moves through it, how tables collapse, which Russian locale keys it needs and where each claim comes from. References determine hierarchy and direction, not exact text or field access (information architecture, "Page contract before implementation"). Synthetic people, companies and numbers in the images are illustrative only and are never carried into copy, fixtures or seeds as real data.

## Method

1. Every PNG was opened and visually inspected; observations, manifest status and corrections are recorded in the private reference inspection notes. No status was upgraded.
2. Binding constraints were extracted from the specification (R01–R31), the IA, the rejection ledger in the design inventory and the accessibility target (WCAG 2.2 AA). Where a reference contradicts a constraint, the constraint wins and the contradiction is listed as a correction.
3. Each surface got one contract using the fixed template below. Surfaces without any reference are marked `no reference` and are derived from the specification and journeys only.
4. Cross-cutting outputs: [component inventory](component-inventory.md) for DS-001, [layout and tokens proposal](layout-and-tokens-proposal.md), [technology recommendations](technology-recommendations.md), [missing design backlog](missing-design-backlog.md), [human review request](human-review-request.md).

## Contract template (fixed; every contract uses these headings in this order)

| Section | Content |
|---|---|
| Status and evidence | Contract status, manifest status of the underlying reference, spec/IA paragraphs used |
| Audience and access policy | Who may open the screen; what anonymous/registered/member/admin see; deny-by-default rule |
| Data projection | Fields shown, public vs private, provenance labels (sourced/claimed/verified), versions |
| Primary tasks | Ordered list of what a person comes to do |
| Layout regions | Desktop ≥1280, tablet 768–1279, mobile <768 (breakpoints provisional, see layout proposal) |
| Component inventory | Components from the shared inventory used by this screen |
| Interaction states | empty, loading, error, permission-denied, offline, partial/stale, plus screen-specific states |
| Keyboard order and focus | Tab order, landmarks, focus target after navigation/actions, dialogs |
| Responsive table behaviour | What happens to each table below tablet width |
| Locale keys | Locale keys with the English reference copy (`en`; dictionaries in `packages/ui/locales` and `apps/web/app/_lib/locales`, where every key exists in all interface languages; DS-001/WEB owners merge). Keys not yet in a dictionary are proposals. Any key containing `{count}` is a plural group in ICU form, for example `{count, plural, one {# project} other {# projects}}`; languages with more plural categories (Russian uses one/few/many) add their own forms in their dictionary |
| Open questions | What a human or a later task must decide |

## Status legend

| Status | Meaning |
|---|---|
| `proposed` | Default for every contract. Derived from specification and references; not reviewed by a human |
| `proposed (reference: accepted direction)` | The underlying reference image has manifest status `accepted_direction`; the hierarchy may be followed, the contract text is still proposed |
| `proposed (reference: reviewed, proceeded)` | Manifest status `reviewed_proceeded`; proceed, but listed corrections are mandatory |
| `proposed (reference: content pattern only)` | Only the content pattern of the reference is usable; its chrome is rejected |
| `proposed (reference: unapproved proposal)` | The reference itself awaits human decision; contract lists alternatives |
| `no reference` | No image exists; contract derived from text sources only |

## Index

### Public resource (`/`, no login required)

| Contract | Routes | Reference |
|---|---|---|
| [Home](public/home.md) | `/` | public-home.png (accepted direction) |
| [News list and news detail](public/news.md) | `/news`, `/news/[slug]` | news.png (content pattern only) |
| [Articles list and article detail](public/articles.md) | `/articles`, `/articles/[slug]` | public-home.png sections (accepted direction); no detail reference |
| [Companies hub and company public page](public/companies.md) | `/companies`, `/companies/[slug]` | companies-hub.png (accepted direction); no detail reference |
| [People hub and person public page](public/people.md) | `/people`, `/people/[slug]` | people-hub.png (reviewed, proceeded); no detail reference |
| [Projects hub and project public page](public/projects.md) | `/projects`, `/projects/[slug]` | projects-hub.png (reviewed, proceeded); no detail reference |
| [Magazine](public/magazine.md) | `/magazine`, `/magazine/[issue]`, `/magazine/[issue]/read`, `/magazine/archive` | weekly-magazine.png (accepted direction); mobile/PDF missing |
| [Search results and retrieval states](public/search-and-citations.md) | `/search`, citation drawer | no reference; retrieval-api.md |
| [Login](public/auth-login.md) | `/login` | login-classic.png (accepted direction) |
| [Signup](public/auth-signup.md) | `/signup` | signup.png (accepted direction, one-name correction) |
| [Recover: request and reset](public/auth-recover.md) | `/recover`, `/recover/[token]` | no reference |
| [Onboarding: capabilities](public/onboarding-capabilities.md) | `/onboarding` | onboarding-capabilities.png (accepted direction) |
| [Onboarding: categories and regions](public/onboarding-categories-regions.md) | `/onboarding/interests` | onboarding-procurement.png (accepted direction) |

### Workspace (`/app`, authenticated)

| Contract | Routes | Reference |
|---|---|---|
| [Shell](workspace/shell.md) | all `/app/*` | workspace-latest.png (unapproved proposal) plus R23/R24 |
| [Overview](workspace/overview.md) | `/app` | workspace-latest.png (unapproved proposal) |
| [My page](workspace/my-page.md) | `/app/me` | no reference |
| [Company](workspace/company.md) | `/app/company` | no reference |
| [Projects list and project detail](workspace/projects.md) | `/app/projects`, `/app/projects/[id]` | no reference |
| [Procurement](workspace/procurement.md) | `/app/procurement/*` | no reference |
| [Sales](workspace/sales.md) | `/app/sales/*` | no reference |
| [Publications](workspace/publications.md) | `/app/publications/*` | no reference |
| [Assistant page and overlay](workspace/assistant.md) | `/app/assistant`, floating launcher | no reference; R09–R11, R29 |
| [Settings](workspace/settings.md) | `/app/settings/*`, `/app/company/settings/*` | no reference; R24 |
| [Platform administration](workspace/administration.md) | `/admin/*` (proposed) | no reference; R20 |

### Cross-cutting

- Reference inspection notes (private design archive)
- [Component inventory](component-inventory.md)
- [Layout and tokens proposal](layout-and-tokens-proposal.md)
- [Technology recommendations](technology-recommendations.md)
- [Missing design backlog](missing-design-backlog.md)
- [Human review request](human-review-request.md)

## Locale key conventions

- Keys are `<area>.<element>[.<state>]` and exist with the same name in every interface language. Areas: `publicShell`, `footer`, `home`, `news`, `articles`, `companies`, `people`, `projects`, `magazine`, `reader`, `archive`, `search`, `answer`, `citation`, `auth`, `onboarding`, `taxonomy`, `shell`, `overview`, `me`, `company`, `projectsWs`, `procurement`, `intake`, `rfq`, `supplier`, `quote`, `compare`, `negotiation`, `order`, `approvals`, `sales`, `quoteEditor`, `salesOrder`, `catalogue`, `publications`, `editor`, `assistant`, `mandate`, `approval`, `run`, `settings`, `admin`.
- Shared enums live once and are reused everywhere: `common.*` (generic actions and states), `status.*` (sourced / claimed / verified), `evidence.*` (asserted / confirmed / disputed / superseded), `kind.*` (goods / works / services / bundle), `role.*`, `projectStatus.*`, `rfqStatus.*`, `pubState.*`, `run.state.*`. A screen contract must not redefine them under its own area.
- Enum labels name a kind in the singular ("Goods", "Service", "Bundle"; "Works" is used as the trade term); counted labels are plural groups with `{count}` as above; column headers and filter labels use the plural noun where the column lists many ("Quotes").
- Values in the tables are product copy. An italic parenthetical after a value, such as *(wording from reference; editorial review)*, is an engineering annotation marking copy carried over from a reference image that the editorial owner must review; it is not part of the string.
- "Help" is a shared key `footer.help` used in the same relative position in every shell (WCAG 2.2 3.2.6 Consistent Help).

## How downstream tasks consume these contracts

| Task | Uses |
|---|---|
| DS-001 | Component inventory with states and accessibility requirements; layout/tokens proposal; locale key proposals; technology recommendations (decides stack together with WEB-001 owner and integrator) |
| WEB-001 | Shell, home, directories hubs, auth, onboarding contracts; navigation order and avatar/bell/launcher constraints; empty/error/denied states |
| WEB-002 | Overview, procurement, sales, projects, assistant contracts; comparison table, version picker, run status states |
| WEB-003 | Search and citation contract; `complete/partial/no_answer/unavailable` and `asserted/confirmed/disputed/superseded` presentation |
| CNT-001 | Publications and magazine contracts; correction banner; reader and PDF separation |
| BILL-001, EXE-001, AST-001, COM-001 | Backend owners read the data-projection sections as the list of fields the UI expects; mismatches go through FND-002 contract freeze |
| QA-001 | The interaction-state and keyboard sections are the checklist for manual and automated acceptance |

## Rules preserved in every contract

- Public navigation is exactly `Home, News, Articles, Events, Companies, People, Projects, Magazine` (`publicNav`; Events added by ADR 010 decision 2); workspace destinations are exactly `Overview, My page, Company, Projects, Procurement, Sales, Publications, Assistant` (`workspaceNav`) plus outbound `To the industry` (`publicExit`).
- One circular avatar top-right, collapse control inside the brand row, bell is not a mailbox, no inbox, no company/workspace switcher, no persona switch, no "Agents" UI, no primary menu-setup button, assistant never reorders navigation.
- One assistant: full page plus icon-only circular bottom-right launcher whose overlay floats and never reflows the page.
- All product copy comes from locale keys in every interface language (English is the reference; Russian is one additional interface language); keys in these contracts that are not yet in a dictionary are proposals.
- Sourced, claimed and verified are always distinct; people need consent and portrait licensing; projects are public only via explicit projection.
- No synthetic metrics, names or counts from the references are to be reused as real data.

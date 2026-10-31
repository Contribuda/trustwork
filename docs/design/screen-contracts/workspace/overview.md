# Overview («Обзор»)

Route: `/app`.

## Status and evidence

`proposed (reference: unapproved proposal)` — `workspace-latest.png` (private design archive), manifest `proposed_unapproved`: "Two buy/sell panels, project list and events; proposal awaiting human feedback. Assistant overlay states missing; catalogue label must include works and services." Spec R23 (daily overview; simultaneous buying and selling when relevant; no endless welcome screen, no role-focus dropdown, no generic charts), journeys 1 and 2; IA "The daily overview highlights decisions, ongoing work and relevant events without giant omnibus charts."

## Audience and access policy

Authenticated. Content is the intersection of what the person may see: own objects, company objects they are granted, projects they participate in. Panels appear by relevance and preference:

| Variant | Panels |
|---|---|
| Personal-only (no commerce preference and no commercial grants) | Decisions, My projects (if any), Publications in progress, Events, Industry picks; **no** procurement/sales panels |
| Buyer only | + Procurement panel |
| Seller only | + Sales panel |
| Mixed (journey 2) | Procurement **and** Sales side by side; no persona switch |

A panel with zero items but a relevant capability shows a purposeful empty state; a panel with no capability and no items is absent. Absence never changes the sidebar.

## Data projection

| Panel | Items (authorized only) |
|---|---|
| Decisions («Нужно ваше решение») | Cross-object list: quote comparison ready, approval digest pending (assistant), order acceptance pending, dispute response due, publication review; each with object link, due time, one primary action |
| Procurement («Закупки») | Count in progress; top item needing action; up to 4 recent RFQs with lifecycle status chip; links «Все закупки», «Найти поставщика» |
| Sales («Продажи») | Count in progress; top item (quote due); recent leads/quotes with status; links «Все предложения», «Каталог товаров, работ и услуг» |
| My projects («Мои проекты») | Up to 4 projects with next milestone (baseline/changed indicator), role (владелец/руководитель/участник) |
| Events («Ближайшие события») | Dated list: deliveries, acceptances, quote validity expiry, mandate expiry, issue release; each links to its object |
| Assistant («Помощник») | One line: runs in progress / outcome unknown count / approvals waiting; link to page |
| Publications | Drafts and items in review, if any |

No omnibus charts. Numeric badges only for counts of authorized items.

## Primary tasks

1. See what needs a decision today and act on it in one click.
2. Check in-progress procurement and sales without switching context.
3. Jump to a project's next step.
4. Create a new object (RFQ, quote, project, publication) via one «Создать» menu.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; H1 «Обзор» + subline that reflects variant («Закупки, продажи и ваши проекты» / «Ваши проекты и публикации»); «Создать ▾» menu button right; row 1: Decisions full width if ≥1 item, else omitted; row 2: Procurement and Sales as two equal cards (or a single card if one capability); row 3: My projects (2/3) + Events (1/3); row 4: Publications + Assistant line. Cards have header (icon, title, count badge, «Все →») |
| Tablet | Cards stack to one column; Projects and Events side by side at ≥1024 |
| Mobile <768 | Single column; each card's list limited to 3 with «Все»; «Создать» as full-width button under H1 |

## Component inventory

PageHeader (H1 + subline + actions), CreateMenu (menu button; items depend on grants: Потребность, Предложение, Проект, Публикация), OverviewCard, DecisionRow (title, context, due, primary Button), ObjectRow (thumbnail optional, title, context line, StatusChip), StatusChip (lifecycle, text + icon), EventRow (date tile with accessible full date), MilestoneIndicator (baseline vs changed), EmptyState (per card), Skeleton, Link «Все».

## Interaction states

| State | Behaviour |
|---|---|
| Empty (personal-only, nothing yet) | Cards: Projects «Проектов пока нет» + «Создать проект»; Publications «Черновиков нет» + «Написать»; Events «Событий нет»; a single short industry picks block; never a welcome wizard |
| Empty (commerce capability, no objects) | Procurement: «Закупок пока нет» + «Создать потребность» + «Найти поставщика»; Sales: «Предложений пока нет» + «Заполнить каталог» (only if company permits) |
| Loading | Card skeletons with fixed heights per card type |
| Error | Card-level error with retry; other cards unaffected |
| Permission-denied | A card whose data the user lost access to (e.g., employment ended) disappears on next load; stale objects show «Доступ изменился» row until reload |
| Offline | Cached cards with «обновлено {time}»; actions disabled |
| Partial/stale | Decisions whose underlying digest changed show «Условия изменились, проверьте заново» |

## Keyboard order and focus

Shell → H1 → «Создать» → Decisions rows (title link, action button) → Procurement card («Все», rows, links) → Sales card → Projects → Events → Publications → Assistant line → launcher. Card headings are `h2`; each card is a `section` with `aria-labelledby`. The «Создать» menu is a menu button with arrow navigation.

## Responsive table behaviour

No tables; lists only.

## Locale keys

| Key | Russian |
|---|---|
| `ru.overview.subtitle.mixed` | Закупки, продажи и ваши проекты |
| `ru.overview.subtitle.personal` | Ваши проекты и публикации |
| `ru.overview.create` | Создать |
| `ru.overview.create.need` | Потребность |
| `ru.overview.create.quote` | Предложение |
| `ru.overview.create.project` | Проект |
| `ru.overview.create.publication` | Публикация |
| `ru.overview.decisions` | Нужно ваше решение |
| `ru.overview.inProgress` | {count, plural, one {# задача в работе} few {# задачи в работе} many {# задач в работе}} |
| `ru.overview.all` | Все |
| `ru.overview.procurement.findSupplier` | Найти поставщика |
| `ru.overview.procurement.empty` | Закупок пока нет |
| `ru.overview.procurement.createNeed` | Создать потребность |
| `ru.overview.sales.allQuotes` | Все предложения |
| `ru.overview.sales.catalogue` | Каталог товаров, работ и услуг |
| `ru.overview.sales.empty` | Предложений пока нет |
| `ru.overview.sales.fillCatalogue` | Заполнить каталог |
| `ru.overview.projects` | Мои проекты |
| `ru.overview.projects.all` | Все проекты |
| `ru.overview.projects.next` | Следующий этап: {name} |
| `ru.overview.projects.empty` | Проектов пока нет |
| `ru.overview.projects.create` | Создать проект |
| `ru.overview.events` | Ближайшие события |
| `ru.overview.events.empty` | Событий нет |
| `ru.overview.publications` | Публикации |
| `ru.overview.publications.empty` | Черновиков нет |
| `ru.overview.publications.write` | Написать статью |
| `ru.overview.assistant.summary` | Помощник: выполняется — {running}, ждут вашего решения — {approvals}, на сверке — {unknown} |
| `ru.overview.digestChanged` | Условия изменились, проверьте заново |
| `ru.overview.accessChanged` | Доступ изменился |
| `ru.overview.industryPicks` | В отрасли |
| `ru.role.owner` | Владелец |
| `ru.role.leader` | Руководитель |
| `ru.role.participant` | Участник |

## Open questions

- Decisions panel vs the reference's «Нужно ваше решение» inside each card: proposal is one cross-object Decisions panel on top **and** the per-card top item; human to choose (see [human review request](../human-review-request.md)).
- Whether «Создать» is a split button (reference) or a plain menu button (proposal: menu button).
- Industry picks block on a workspace page: keep minimal (3 links) or drop.

# Overview (`overview.title`)

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
| Decisions ("Your decision is needed") | Cross-object list: quote comparison ready, approval digest pending (assistant), order acceptance pending, dispute response due, publication review; each with object link, due time, one primary action |
| Procurement (`overview.procurement.title`) | Count in progress; top item needing action; up to 4 recent RFQs with lifecycle status chip; links "All procurement" (`overview.procurement.all`), "Find a supplier" |
| Sales (`overview.sales.title`) | Count in progress; top item (quote due); recent leads/quotes with status; links "All quotes", "Catalogue of goods, works and services" |
| My projects | Up to 4 projects with next milestone (baseline/changed indicator), role (owner/lead/participant) |
| Events ("Upcoming events") | Dated list: deliveries, acceptances, quote validity expiry, mandate expiry, issue release; each links to its object |
| Assistant (`overview.assistant.title`) | One line: runs in progress / outcome unknown count / approvals waiting; link to page |
| Publications | Drafts and items in review, if any |

No omnibus charts. Numeric badges only for counts of authorized items.

## Primary tasks

1. See what needs a decision today and act on it in one click.
2. Check in-progress procurement and sales without switching context.
3. Jump to a project's next step.
4. Create a new object (RFQ, quote, project, publication) via one "Create" menu.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; H1 "Overview" (`overview.title`) + subline that reflects variant ("Procurement, sales and your projects" / "Your projects and publications"); "Create ▾" menu button right; row 1: Decisions full width if ≥1 item, else omitted; row 2: Procurement and Sales as two equal cards (or a single card if one capability); row 3: My projects (2/3) + Events (1/3); row 4: Publications + Assistant line. Cards have header (icon, title, count badge, "All →") |
| Tablet | Cards stack to one column; Projects and Events side by side at ≥1024 |
| Mobile <768 | Single column; each card's list limited to 3 with "All"; "Create" as full-width button under H1 |

## Component inventory

PageHeader (H1 + subline + actions), CreateMenu (menu button; items depend on grants: Need, Quote, Project, Publication; `overview.createItems.*`), OverviewCard, DecisionRow (title, context, due, primary Button), ObjectRow (thumbnail optional, title, context line, StatusChip), StatusChip (lifecycle, text + icon), EventRow (date tile with accessible full date), MilestoneIndicator (baseline vs changed), EmptyState (per card), Skeleton, Link "All".

## Interaction states

| State | Behaviour |
|---|---|
| Empty (personal-only, nothing yet) | Cards: Projects "No projects yet" + "Create a project"; Publications "No drafts" + "Write"; Events "No events"; a single short industry picks block; never a welcome wizard |
| Empty (commerce capability, no objects) | Procurement: "No procurement yet" + "Create a need" + "Find a supplier"; Sales: "No quotes yet" + "Fill in the catalogue" (only if company permits) |
| Loading | Card skeletons with fixed heights per card type |
| Error | Card-level error with retry; other cards unaffected |
| Permission-denied | A card whose data the user lost access to (e.g., employment ended) disappears on next load; stale objects show "Access changed" row until reload |
| Offline | Cached cards with "updated {time}"; actions disabled |
| Partial/stale | Decisions whose underlying digest changed show "The terms changed; check again" |

## Keyboard order and focus

Shell → H1 → "Create" → Decisions rows (title link, action button) → Procurement card ("All", rows, links) → Sales card → Projects → Events → Publications → Assistant line → launcher. Card headings are `h2`; each card is a `section` with `aria-labelledby`. The "Create" menu is a menu button with arrow navigation.

## Responsive table behaviour

No tables; lists only.

## Locale keys

| Key | English |
|---|---|
| `overview.subtitle.mixed` | Procurement, sales and your projects |
| `overview.subtitle.personal` | Your projects and publications |
| `overview.create` | Create |
| `overview.create.need` | Need |
| `overview.create.quote` | Quote |
| `overview.create.project` | Project |
| `overview.create.publication` | Publication |
| `overview.decisions` | Your decision is needed |
| `overview.inProgress` | {count, plural, one {# task in progress} other {# tasks in progress}} |
| `overview.all` | All |
| `overview.procurement.findSupplier` | Find a supplier |
| `overview.procurement.empty` | No procurement yet |
| `overview.procurement.createNeed` | Create a need |
| `overview.sales.allQuotes` | All quotes |
| `overview.sales.catalogue` | Catalogue of goods, works and services |
| `overview.sales.empty` | No quotes yet |
| `overview.sales.fillCatalogue` | Fill in the catalogue |
| `overview.projects` | My projects |
| `overview.projects.all` | All projects |
| `overview.projects.next` | Next milestone: {name} |
| `overview.projects.empty` | No projects yet |
| `overview.projects.create` | Create a project |
| `overview.events` | Upcoming events |
| `overview.events.empty` | No events |
| `overview.publications` | Publications |
| `overview.publications.empty` | No drafts |
| `overview.publications.write` | Write an article |
| `overview.assistant.summary` | Assistant: running — {running}, waiting for your decision — {approvals}, reconciling — {unknown} |
| `overview.digestChanged` | The terms changed; check again |
| `overview.accessChanged` | Access changed |
| `overview.industryPicks` | In the industry |
| `role.owner` | Owner |
| `role.leader` | Lead |
| `role.participant` | Participant |

## Open questions

- Decisions panel vs the reference's "Your decision is needed" inside each card: proposal is one cross-object Decisions panel on top **and** the per-card top item; human to choose (see [human review request](../human-review-request.md)).
- Whether "Create" is a split button (reference) or a plain menu button (proposal: menu button).
- Industry picks block on a workspace page: keep minimal (3 links) or drop.

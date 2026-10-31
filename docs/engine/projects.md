# Projects

Normative requirements: [Projects and plans](modules/projects-and-plans.md), [Consultations](modules/consultations.md), [Tasks and mentoring](modules/tasks-and-mentoring.md), [Knowledge sharing](modules/knowledge-sharing.md). Participants: [who uses what](participants/README.md).

Requirements R04, R12, R28, R41–R43. Status: creation, leadership, publication, ownership transfer and participants are **Live** in the API; public pages and the workspace project view (including a plan tab with a baseline and changes) are **Demo**; baselines, plan changes and dependencies are **Designed**; versioned plans, plan items, plan sharing, consultations, tasks and shared knowledge (the flagship journey "from plan to people", [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 17) are **Proposed** (PLAN-000, PLAN-001, CONS-001, TASK-001, KNOW-001).

A project is where work happens: a school, a facade renovation, a warehouse, someone's own flat. It is a first-class object, not a folder inside a company.

## Ownership, creation and leadership are different things

- A project has exactly **one owner**: a person **or** a company, never both and never neither (a database check enforces the XOR).
- The **creator** is whoever made the record. The **leader** is whoever runs the work. Neither is automatically the owner.
- A homeowner can own a renovation project personally and invite a contractor's company and an independent engineer. No company account is required, and if the engineer changes employer, the homeowner's project does not move.

## Private by default, published by choice

A new project is private. Participants see it according to their **participation** (capabilities, side, audience, validity). Publishing does not flip a visibility flag on everything: it creates an **allowlisted public projection**, chosen field by field:

| Can be public | Never public |
|---|---|
| Title, category, region, short story, cover artwork | Budgets and cost limits |
| Selected milestones (published milestones) | Quotes, agreements, orders and their attachments |
| Updates written as publications | Correspondence and negotiation |
| Participants who agreed to be shown | Private files and internal commitments |
| Open needs the owner chose to announce | Anything the search index, export or notification would otherwise leak |

The public project page, the projects directory, search, exports, notifications and federation feeds all use the same serializer, so a published project never leaks a private value through a side door.

## Participants (Live)

The owner, and people with `manage_participants`, grant and revoke participation. Each grant names capabilities (for example `read.shared`, `write.draft`, `negotiate`), the side (`owner`, `buyer`, `seller`, `participant`), the highest audience, and validity dates. Revocation takes effect immediately and invalidates cached decisions. Participants see **shared milestones without budgets**; the budget tab exists only for the owner.

## Ownership transfer (Live)

Transfer is a consented, audited process, never a side effect of changing the leader:

```text
proposed → accepted_by_recipient → effective
        ↘ rejected | expired | withdrawn
```

The recipient must be an authorized party (the person, or someone with authority in the receiving company). Every step requires step-up, carries an idempotency key and re-evaluates access when it becomes effective.

## Plans: from plan to people

Owner decision 2026-10-31 ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 17). A project gets one **plan**, and the plan is what turns an idea into requests to people. The whole journey, with the agents' jobs and mandates, is in the [agent catalogue](agent-catalog.md#flagship-journey-from-plan-to-people); entities are in the [data model](../data/model.md#7-projects-and-plans) and states in the [lifecycles](../data/lifecycles.md#plans-and-plan-items). How a homeowner experiences it: [guide](../guides/homeowner.md).

```text
project → plan (versions) → plan items → consultations (experts) | tasks (contractors, trades) | RFQs | do it myself
        → progress, evidence and changes with reasons → completion → shared knowledge, with consent
```

### What a plan contains (Proposed, PLAN-001)

Phases, tasks, the expertise and trades each step needs, materials with quantities and uncertainty, permits and inspections the jurisdiction usually requires, budget ranges with their basis, a timeline as ranges, risks and decision points, in plain language and in the owner's language. Each **plan item** has a kind (`phase`, `task`, `milestone`, `consultation`, `purchase`, `material`, `permit`, `inspection`, `decision`, `risk`, `self`), a stable key across versions and terms from the **plan-step taxonomy**. The taxonomy is open data under CC0 1.0 with predecessor relations and crosswalk slots to IFC and ETIM; proprietary classifications are licensed hub data and never ship in the repository ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 14, PLAN-000). Budget ranges use only cost data the hub licensed for display and model use, and never other participants' private quotes (ADR 012 decision 23). The plan is advice, not professional engineering or legal advice; where a licensed professional is required, the plan creates a consultation or a task for one.

### Plan versions (Proposed, ADR 012 decision 13)

```text
draft → proposed → approved → superseded
          ↘ draft (owner returns it; a new draft version)
```

- An agent may draft and propose a version only under a mandate; it never approves.
- A **proposed** version is frozen and digest-bound; edits create a new draft version.
- Only the plan owner, or a person the owner authorized, approves. The **approved** version is the **baseline** of the earlier designs (`plan_baseline` became `plan_version`; a project milestone is a plan item of kind `milestone`).
- An approved version is never edited; a later approved version **supersedes** it. Original and revised versions are both kept.
- The execution state of an item (`proposed`, `accepted`, `requested`, `in_progress`, `done`, `blocked`, `cancelled`, `skipped`) lives beside the frozen version, so linking a request never edits the plan.

### Plan changes and fair timing (Designed)

Construction plans change. A **plan change** records what changed, why, who asked for it, which agreement covers it and who is accountable, so nobody is blamed retroactively. Dependencies (finish-to-start and the other types, with lags) must stay acyclic. When a client changes scope and the delivery date moves, the original and revised plans are both kept with the reason, and timing reputation sees a client-caused change, not an unexplained supplier delay ([Execution and reputation](execution-and-reputation.md#fair-timing-who-caused-the-delay)). Milestone budgets are owner-private.

### Sharing a plan item (Proposed, `plan_share`)

The project and its plan are owner-private. The owner shares **one item at a time, with one audience at a time**, choosing the fields:

| Audience | Sees |
|---|---|
| `public` (the needs board) | Only what the owner published: trade, scope summary, city or county, timing window; never the street address |
| `invited` experts or contractors | Exactly the listed fields: scope, drawings attached to that item, quantities, schedule; the budget range only if the owner chose to share it |
| `after_acceptance` | Address, contact details and site-access notes, after a booked site visit or an accepted task |

Invitees never see private notes, exact budgets, other invitees, other offers, diary entries or files outside the shared item; hub staff see nothing without a case grant; nothing reaches shared knowledge until the owner consents at the end, field by field.

### Consultations and tasks from plan items (Proposed)

| The owner chooses | It becomes | Designed in |
|---|---|---|
| Advice | A **consultation**: an advice session, a review of drawings or quotes, a site visit or a mentoring series, booked from an expert's versioned offering; the booking is an agreement of kind `consultation`, delivered with a deliverable the client accepts (CONS-001; paid bookings CONS-002) | [Consultation](agent-catalog.md#consultation), [data model](../data/model.md#8-consultations-tasks-and-mentoring) |
| Execution | A **task**: a scoped request to contractors and trades with immutable offers; acceptance creates an agreement of kind `task` and a task assignment with milestones (TASK-001) | [Task marketplace](agent-catalog.md#task-marketplace) |
| A larger purchase | An RFQ ([Buying and selling](commerce.md)) | COM-001, COM-002 |
| Do it myself | A checklist from shared knowledge | KNOW-001 |

Both sides' agents automate matching, quoting, scheduling, negotiation within mandates, progress tracking and reporting; people accept, and a private person's commitments are always their own decision (consumer mode). For each step, explained recommendations of products, guides, courses, events and consultants come from the plan-step companion ([Search and knowledge](search-and-knowledge.md#plan-step-recommendations-proposed)). Payments for bookings and tasks go only through licensed providers ([Billing](billing.md#trustwork-never-holds-money)).

### Permits, diaries and shared knowledge (Proposed)

Permit records keep the permit type, authority, number, dates and inspection results per jurisdiction from the country pack; the engine never files permits. A project diary is private while the project runs. When the project completes, the owner's agent proposes (never publishes by itself) a diary, lessons learned, checklists, a plan template with private data removed, and Q&A; each becomes a publication only with the owner's consent and each named participant's consent or anonymization, under a licence the author chooses (KNOW-001, [data model](../data/model.md#9-knowledge-sharing)).

### Hub administration of plans

Planner templates, marketplace categories and commission settings are hub configuration ([console: plan to people](hub-console/modules.md#plan-to-people), PLAN-003, BILL-003).

## Everything else hangs on the project

| Linked object | Where it is described |
|---|---|
| Needs and RFQs | [Buying and selling](commerce.md) |
| Agreements, orders and obligations | [Buying and selling](commerce.md#7-agreements-and-orders) |
| Deliveries, work records, acceptance, defects | [Execution and reputation](execution-and-reputation.md) |
| Updates and stories | [Publishing](publishing.md) |
| Files | Classified attachments; access through the parent object and their own classification, signed URLs with short lifetimes |
| Agent work | Mandates can name a project as their context ([Your agent](agents.md)) |

## Proposed additions

| Item | Why |
|---|---|
| **Open needs on public projects** | A published project can announce what it is looking for (a subcontractor for ventilated facades, a supplier of mineral wool) and feed [partner matching](partners-and-matching.md). The need links to an RFQ only when the owner publishes one. |
| **Portfolio participation** | A person or company that took part can show the project in its portfolio with the owner's consent, and keeps that line after the project ends. |
| **Site location and cadastral reference** | Optional, owner-private by default; the public page shows only the region or city. Country packs define the cadastral identifier format where one exists. |
| **Project templates per hub** | Typical stages and acceptance checkpoints for common project types in a country (for example hidden-works acceptance stages), maintained by the hub's editorial or expert community. |

## Invariants checked by tests

- Owner XOR: never zero, never two owners.
- A participant without a grant gets 404 for the project, its files and its participants list.
- A participant never sees a budget field in any projection.
- Changing the leader does not change the owner; transfer requires the recipient's consent.
- The public projection of a published project contains no budget, quote, agreement, file or correspondence field.

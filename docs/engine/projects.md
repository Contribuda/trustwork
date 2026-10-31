# Projects

Requirements R04, R12, R28. Status: creation, leadership, publication, ownership transfer and participants are **Live**; public pages and the workspace project view are **Demo**; plans, baselines and dependencies are **Designed**.

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

## Planning and change (Designed)

Construction plans change. The engine keeps both the plan that was agreed and every change to it, so nobody is blamed retroactively:

- **Baseline**: an approved version of the plan (milestones, dates, budgets, dependencies).
- **Plan change**: what changed, why, who asked for it, which agreement covers it, and who is accountable.
- **Dependencies**: finish-to-start and other types with lags; the graph must stay acyclic.
- **Milestones** carry dates, scope and optional budgets; the budget is owner-private.

When a client changes scope and the delivery date moves, the original and revised plans are both kept with the reason. Reputation then sees a client-caused change, not an unexplained supplier delay (see [Execution and reputation](execution-and-reputation.md)).

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

# Projects list and project detail (workspace)

Routes: `/app/projects`, `/app/projects/new`, `/app/projects/[id]` with tabs `plan`, `execution`, `acceptance`, `disputes`, `purchases`, `participants`, `files`, `correspondence`, `budget`, `publication`.

## Status and evidence

`no reference`. Spec R04 (owner person OR company; creator and leader distinct; private default; transfer, leadership changes, scoped participants, publication projection), R12 (roadmap/dependencies/milestones/budgets/participants/purchases/obligations/delivery/work/acceptance; baseline and changed plans distinct), R13 (assertion/evidence/confirmed/dispute/correction; customer-caused change must not penalize supplier), journeys 5, 8, 10; [lifecycles](../../../data/lifecycles.md) (project planned → active → suspended/completed/cancelled; transfer proposed → accepted → effective; assertion claimed → evidence_attached → confirmed/disputed → superseded/reversed); IA (contextual object tabs: files, correspondence, approval history, budget, participants within permissions).

## Audience and access policy

| Role | List | Detail |
|---|---|---|
| Owner (person or company admin with owner grant) | Own projects | Everything; transfer ownership; set publication projection; assign leader; budgets |
| Leader (responsible) | Projects led | Operational: plan edits producing change versions, milestones, participants (within grant), execution records, acceptance; no ownership transfer; budget view per grant |
| Participant (person/company with object grant) | Projects participated | Only granted tabs/fields; counterparties see shared terms and their own obligations, never the other side's private budget/notes |
| Company member without grant | Not listed | 404 |

Object-level checks on every tab, attachment and action; a public projection never widens workspace access.

## Data projection

| Tab | Content | Private vs shared |
|---|---|---|
| Overview | Title, status, owner, leader, next milestone, open decisions, publicity state ("Not published" / "Published: …") | Per grant |
| Plan | Roadmap: milestones with dependencies, baseline dates vs current changed plan, change log with reason and responsible party ("at the client's request" etc.), version picker (baseline, each change) | Shared with participants; reasons visible to parties involved |
| Execution | Deliveries, performed work, evidence records (assertion → evidence → confirmed/disputed/superseded), who asserted, who confirmed | Evidence visibility per party |
| Acceptance | Partial/full acceptance records, defects, remediation, acceptance documents | Parties |
| Disputes | Disputed items, positions, resolution status, appeals; "claim is not a fact" labelling | Parties + scoped support if granted |
| Procurement | Linked RFQs/orders from procurement; obligations | Buyer side; supplier sees own order only |
| Participants | People/companies, roles, grants (owner view shows grant scopes), invite, remove, leadership reassignment | Owner/leader |
| Files | Attachments with audience label (private / for participants / published) | Per audience |
| Correspondence | Threads belonging to this project (R08); email provider state | Per party |
| Budget | Owner's cost limits, reservations, settlements (private to owner side) | Owner side only |
| Publication | Projection editor: which fields, milestones, updates, photos, participants (each consented) go public; preview | Owner |

## Primary tasks

1. Create a personal or company project; invite participants with object-level rights (journey 5).
2. Maintain baseline vs changed plan with reasons (journey 8).
3. Record delivery/work/acceptance/dispute as separate records with evidence.
4. Choose exactly what becomes public (journey 10).
5. Transfer ownership or reassign leader with consent and audit.

## Layout regions

| Width | List | Detail |
|---|---|---|
| Desktop ≥1280 | Shell; PageHeader ("Projects", "Create a project"); filters (role, status, owner: me/company); table or card list (title, owner, my role, status, next milestone, updated) | Shell; PageHeader (title, StatusChip, owner/leader line, publicity label, actions menu: Transfer ownership, Assign a lead, Publish…); tabs; panel; optional right rail with key dates and decisions on Overview |
| Tablet | Cards | Tabs scroll; rail below |
| Mobile <768 | Cards; filters sheet | Tabs scroll; tables collapse |

## Component inventory

PageHeader, FilterBar, DataTable (sortable, responsive), ProjectCard, StatusChip, Tabs, VersionPicker (baseline/changes), MilestoneTimeline (baseline and changed rendered as two labelled marks per milestone; text labels, not colour only), ChangeLogList (reason, responsible, date), EvidenceList (state label, actor, timestamp, attachments), AssertionStateBadge, AcceptanceRecordCard, DisputeCard, ParticipantTable with GrantScope chips, InviteDialog, ConfirmDialog (transfer: explains recipient consent and re-evaluation), TransferStatusCard (proposed/accepted/effective/rejected/expired), FileList with AudienceBadge, ThreadList, BudgetTable, ProjectionEditor with Preview, EmptyState, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (list) | "No projects yet" + "Create a project"; explains personal projects need no company |
| Empty (tab) | Per tab, e.g., "No execution records yet" |
| Loading | Skeleton |
| Error | Inline + retry |
| Permission-denied | Tab panel shows NoAccess; tabs the user has no grant for are hidden if the grant model says so, else shown with NoAccess (decide in FND-002; propose hidden for counterparties, NoAccess for members) |
| Offline | Read-only |
| Partial/stale | Plan version viewed is not current: banner "You are viewing the version of {date}" + "To current"; transfer pending: banner for both parties; disputed evidence annotated |
| Transfer | Proposed → recipient sees acceptance card; owner sees "awaiting consent"; expired/rejected shown |

## Keyboard order and focus

Shell → header → actions menu → tabs → panel. Timeline: each milestone is a list item with a disclosure for details; no drag-and-drop requirement (changes are made via forms). Version picker is a listbox/select; changing it moves focus to the panel heading with announcement.

## Responsive table behaviour

Project list, participants, budget and acceptance tables collapse to cards below 768. Plan table (milestone, plan, changed plan, actual, responsible) collapses to a card per milestone with four labelled lines; baseline and changed values always both present when they differ.

## Locale keys

| Key | English |
|---|---|
| `projectsWs.title` | Projects |
| `projectsWs.create` | Create a project |
| `projectsWs.empty` | No projects yet |
| `projectsWs.emptyHint` | A personal project can run without a company. |
| `projectsWs.filter.role` | My role |
| `projectsWs.filter.status` | Status |
| `projectsWs.filter.owner` | Owner |
| `projectsWs.owner.me` | Me |
| `projectsWs.owner.company` | Company |
| `projectsWs.col.title` | Project |
| `projectsWs.col.nextMilestone` | Next milestone |
| `projectsWs.col.updated` | Updated |
| `projectsWs.tabs.overview` | Overview |
| `projectsWs.tabs.plan` | Plan |
| `projectsWs.tabs.execution` | Execution |
| `projectsWs.tabs.acceptance` | Acceptance |
| `projectsWs.tabs.disputes` | Disputes |
| `projectsWs.tabs.purchases` | Procurement |
| `projectsWs.tabs.participants` | Participants |
| `projectsWs.tabs.files` | Files |
| `projectsWs.tabs.correspondence` | Correspondence |
| `projectsWs.tabs.budget` | Budget |
| `projectsWs.tabs.publication` | Publication |
| `projectsWs.notPublished` | Not published |
| `projectsWs.publishedProjection` | Published: {fields} |
| `projectsWs.actions.transfer` | Transfer ownership |
| `projectsWs.actions.assignLeader` | Assign a lead |
| `projectsWs.actions.publish` | Set up publication |
| `projectsWs.plan.baseline` | Baseline plan |
| `projectsWs.plan.change` | Change {index} of {date} |
| `projectsWs.plan.viewingVersion` | You are viewing the version of {date} |
| `projectsWs.plan.toCurrent` | To the current version |
| `projectsWs.plan.reason` | Reason for the change |
| `projectsWs.plan.responsible` | Responsible party |
| `projectsWs.plan.dependsOn` | Depends on |
| `projectsWs.execution.empty` | No execution records yet |
| `projectsWs.execution.addRecord` | Add a record |
| `projectsWs.execution.assertedBy` | Asserted by {actor}, {date} |
| `projectsWs.execution.confirmedBy` | Confirmed by {actor}, {date} |
| `projectsWs.acceptance.partial` | Partial acceptance |
| `projectsWs.acceptance.full` | Acceptance complete |
| `projectsWs.acceptance.defect` | Defect |
| `projectsWs.acceptance.remediation` | Remediation |
| `projectsWs.disputes.claimNotFact` | A party’s claim is not a confirmed fact |
| `projectsWs.disputes.appeal` | File an appeal |
| `projectsWs.transfer.title` | Ownership transfer |
| `projectsWs.transfer.explain` | The recipient must accept the transfer. After that, every participant's access will be reviewed. |
| `projectsWs.transfer.pending` | Awaiting the recipient’s consent |
| `projectsWs.transfer.accept` | Accept the transfer |
| `projectsWs.transfer.reject` | Decline |
| `projectsWs.files.audience.private` | Private |
| `projectsWs.files.audience.participants` | For participants |
| `projectsWs.files.audience.public` | Published |
| `projectsWs.budget.limit` | Limit |
| `projectsWs.budget.reserved` | Reserved |
| `projectsWs.budget.settled` | Paid |
| `projectsWs.publication.preview` | Preview the public page |

## Open questions

- Grant model (hidden vs NoAccess tabs) — FND-002.
- Whether roadmap dependencies need a visual graph; proposal: list with "depends on" text, no Gantt in the first slice.
- Budget tab belongs to EXE-001/BILL-001 contract on transaction vs platform budgets.

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
| Обзор | Title, status, owner, leader, next milestone, open decisions, publicity state («Не опубликован» / «Опубликовано: …») | Per grant |
| План | Roadmap: milestones with dependencies, baseline dates vs current changed plan, change log with reason and responsible party («по инициативе заказчика» etc.), version picker (baseline, each change) | Shared with participants; reasons visible to parties involved |
| Исполнение | Deliveries, performed work, evidence records (assertion → evidence → confirmed/disputed/superseded), who asserted, who confirmed | Evidence visibility per party |
| Приёмка | Partial/full acceptance records, defects, remediation, acceptance documents | Parties |
| Споры | Disputed items, positions, resolution status, appeals; «claim is not a fact» labelling | Parties + scoped support if granted |
| Закупки | Linked RFQs/orders from procurement; obligations | Buyer side; supplier sees own order only |
| Участники | People/companies, roles, grants (owner view shows grant scopes), invite, remove, leadership reassignment | Owner/leader |
| Файлы | Attachments with audience label (приватные / для участников / опубликованные) | Per audience |
| Переписка | Threads belonging to this project (R08); email provider state | Per party |
| Бюджет | Owner's cost limits, reservations, settlements (private to owner side) | Owner side only |
| Публикация | Projection editor: which fields, milestones, updates, photos, participants (each consented) go public; preview | Owner |

## Primary tasks

1. Create a personal or company project; invite participants with object-level rights (journey 5).
2. Maintain baseline vs changed plan with reasons (journey 8).
3. Record delivery/work/acceptance/dispute as separate records with evidence.
4. Choose exactly what becomes public (journey 10).
5. Transfer ownership or reassign leader with consent and audit.

## Layout regions

| Width | List | Detail |
|---|---|---|
| Desktop ≥1280 | Shell; PageHeader («Проекты», «Создать проект»); filters (роль, статус, владелец: я/компания); table or card list (title, owner, my role, status, next milestone, updated) | Shell; PageHeader (title, StatusChip, owner/leader line, publicity label, actions menu: Передать владение, Назначить руководителя, Опубликовать…); tabs; panel; optional right rail with key dates and decisions on Обзор |
| Tablet | Cards | Tabs scroll; rail below |
| Mobile <768 | Cards; filters sheet | Tabs scroll; tables collapse |

## Component inventory

PageHeader, FilterBar, DataTable (sortable, responsive), ProjectCard, StatusChip, Tabs, VersionPicker (baseline/changes), MilestoneTimeline (baseline and changed rendered as two labelled marks per milestone; text labels, not colour only), ChangeLogList (reason, responsible, date), EvidenceList (state label, actor, timestamp, attachments), AssertionStateBadge, AcceptanceRecordCard, DisputeCard, ParticipantTable with GrantScope chips, InviteDialog, ConfirmDialog (transfer: explains recipient consent and re-evaluation), TransferStatusCard (proposed/accepted/effective/rejected/expired), FileList with AudienceBadge, ThreadList, BudgetTable, ProjectionEditor with Preview, EmptyState, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (list) | «Проектов пока нет» + «Создать проект»; explains personal projects need no company |
| Empty (tab) | Per tab, e.g., «Записей об исполнении пока нет» |
| Loading | Skeleton |
| Error | Inline + retry |
| Permission-denied | Tab panel shows NoAccess; tabs the user has no grant for are hidden if the grant model says so, else shown with NoAccess (decide in FND-002; propose hidden for counterparties, NoAccess for members) |
| Offline | Read-only |
| Partial/stale | Plan version viewed is not current: banner «Вы смотрите версию от {date}» + «К текущей»; transfer pending: banner for both parties; disputed evidence annotated |
| Transfer | Proposed → recipient sees acceptance card; owner sees «ожидает согласия»; expired/rejected shown |

## Keyboard order and focus

Shell → header → actions menu → tabs → panel. Timeline: each milestone is a list item with a disclosure for details; no drag-and-drop requirement (changes are made via forms). Version picker is a listbox/select; changing it moves focus to the panel heading with announcement.

## Responsive table behaviour

Project list, participants, budget and acceptance tables collapse to cards below 768. Plan table (этап, план, изменённый план, факт, ответственный) collapses to a card per milestone with four labelled lines; baseline and changed values always both present when they differ.

## Locale keys

| Key | Russian |
|---|---|
| `ru.projectsWs.title` | Проекты |
| `ru.projectsWs.create` | Создать проект |
| `ru.projectsWs.empty` | Проектов пока нет |
| `ru.projectsWs.emptyHint` | Личный проект можно вести без компании. |
| `ru.projectsWs.filter.role` | Моя роль |
| `ru.projectsWs.filter.status` | Статус |
| `ru.projectsWs.filter.owner` | Владелец |
| `ru.projectsWs.owner.me` | Я |
| `ru.projectsWs.owner.company` | Компания |
| `ru.projectsWs.col.title` | Проект |
| `ru.projectsWs.col.nextMilestone` | Следующий этап |
| `ru.projectsWs.col.updated` | Обновлён |
| `ru.projectsWs.tabs.overview` | Обзор |
| `ru.projectsWs.tabs.plan` | План |
| `ru.projectsWs.tabs.execution` | Исполнение |
| `ru.projectsWs.tabs.acceptance` | Приёмка |
| `ru.projectsWs.tabs.disputes` | Споры |
| `ru.projectsWs.tabs.purchases` | Закупки |
| `ru.projectsWs.tabs.participants` | Участники |
| `ru.projectsWs.tabs.files` | Файлы |
| `ru.projectsWs.tabs.correspondence` | Переписка |
| `ru.projectsWs.tabs.budget` | Бюджет |
| `ru.projectsWs.tabs.publication` | Публикация |
| `ru.projectsWs.notPublished` | Не опубликован |
| `ru.projectsWs.publishedProjection` | Опубликовано: {fields} |
| `ru.projectsWs.actions.transfer` | Передать владение |
| `ru.projectsWs.actions.assignLeader` | Назначить руководителя |
| `ru.projectsWs.actions.publish` | Настроить публикацию |
| `ru.projectsWs.plan.baseline` | Базовый план |
| `ru.projectsWs.plan.change` | Изменение {index} от {date} |
| `ru.projectsWs.plan.viewingVersion` | Вы смотрите версию от {date} |
| `ru.projectsWs.plan.toCurrent` | К текущей версии |
| `ru.projectsWs.plan.reason` | Причина изменения |
| `ru.projectsWs.plan.responsible` | Ответственная сторона |
| `ru.projectsWs.plan.dependsOn` | Зависит от |
| `ru.projectsWs.execution.empty` | Записей об исполнении пока нет |
| `ru.projectsWs.execution.addRecord` | Добавить запись |
| `ru.projectsWs.execution.assertedBy` | Заявил {actor}, {date} |
| `ru.projectsWs.execution.confirmedBy` | Подтвердил {actor}, {date} |
| `ru.projectsWs.acceptance.partial` | Частичная приёмка |
| `ru.projectsWs.acceptance.full` | Приёмка завершена |
| `ru.projectsWs.acceptance.defect` | Недостаток |
| `ru.projectsWs.acceptance.remediation` | Устранение |
| `ru.projectsWs.disputes.claimNotFact` | Заявление стороны не является подтверждённым фактом |
| `ru.projectsWs.disputes.appeal` | Подать апелляцию |
| `ru.projectsWs.transfer.title` | Передача владения |
| `ru.projectsWs.transfer.explain` | Получатель должен принять передачу. После этого доступ всех участников будет пересмотрен. |
| `ru.projectsWs.transfer.pending` | Ожидает согласия получателя |
| `ru.projectsWs.transfer.accept` | Принять передачу |
| `ru.projectsWs.transfer.reject` | Отклонить |
| `ru.projectsWs.files.audience.private` | Приватный |
| `ru.projectsWs.files.audience.participants` | Для участников |
| `ru.projectsWs.files.audience.public` | Опубликован |
| `ru.projectsWs.budget.limit` | Лимит |
| `ru.projectsWs.budget.reserved` | Зарезервировано |
| `ru.projectsWs.budget.settled` | Оплачено |
| `ru.projectsWs.publication.preview` | Предпросмотр публичной страницы |

## Open questions

- Grant model (hidden vs NoAccess tabs) — FND-002.
- Whether roadmap dependencies need a visual graph; proposal: list with «зависит от» text, no Gantt in the first slice.
- Budget tab belongs to EXE-001/BILL-001 contract on transaction vs platform budgets.

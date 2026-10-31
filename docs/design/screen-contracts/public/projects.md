# Projects hub and project public page

Routes: `/projects`, `/projects/[slug]`.

## Status and evidence

`proposed (reference: reviewed, proceeded)` for the hub — `projects-hub.png` (private design archive), manifest `reviewed_proceeded`: "Directory lists only permitted public projections; private by default." `no reference` for the public project page. Spec R04, R12, R13, R15, journeys 5 and 10 ("Public/private boundary").

## Audience and access policy

Everyone sees only projects with an **explicit public projection** (an allowlisted set of fields and attachments chosen by the owner/leader). Participants of a private project do not see it here; they use `/app/projects`. Nothing on these pages reveals quotes, attachments, messages, budgets, internal commitments or private participants. A public «open need» is itself an explicit projection of an RFQ (scope summary, region, deadline), never the full RFQ.

## Data projection

| Field | Public when |
|---|---|
| Title, category (жильё, образование, производство, общественные пространства, инфраструктура…), region | in projection |
| Status (планируется, реализуется, приостановлен, завершён, отменён) | in projection |
| Owner (person or company public page) | in projection |
| Public participants with public roles | each participant consented to be listed |
| Description, photos (licensed; «Визуализация» tag when a render) | in projection |
| Published updates: type (результат / сообщение команды / обсуждение) with evidence label (утверждение / подтверждено) | in projection; R13 labels mandatory |
| Milestones chosen for publication (name, planned/actual date) | in projection; baseline vs changed shown only if owner publishes both |
| Open needs (public RFQ projections) | explicit |
| Related publications | published |
| Budgets, quotes, files, correspondence, private participants, disputes | never |

## Primary tasks

1. Discover projects by type, region, stage, participants.
2. Understand who is involved and what was published, with claim vs confirmed labels.
3. Find open needs to respond to (leads to workspace sales flow).
4. Present own project (leads to `/app/projects`).

## Layout regions

| Width | Hub | Project page |
|---|---|---|
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; outlined «Представить проект»; featured project; search + «Найти»; view toggle (cards only in first slice; map deferred); chips (categories); filters (Регион, Стадия, Участники, sort); 2-column project cards (photo with optional «Визуализация», title, category/status chips, region, description, owner line, participant chips, «Участники и их роли», «Открыть проект»); right rail («Что видно в проекте», «Открытые потребности», «История с указанием источников»); «Как движутся проекты» update cards; articles; CTA band; footer | Public shell; breadcrumb; header (title, chips, region, owner, status); photo gallery; tabs: Обзор, Участники, Этапы, Обновления, Потребности, Публикации; right rail: owner card, «Что здесь опубликовано» note, report link |
| Tablet | Cards 2 columns; rail below | Tabs scroll |
| Mobile <768 | Cards 1 column; filters in sheet | Single column; gallery becomes swipeable with buttons and dots that are real controls |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect/FilterSheet, SegmentedControl (view), ProjectCard, StatusChip (lifecycle), ParticipantChipList, UpdateCard (type badge + EvidenceLabel), Tabs, Gallery, MilestoneList (baseline/changed pairs), OpenNeedCard, RailCard, ReportIssueLink, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | «Проекты не найдены» + reset; «Открытые потребности» hidden if none |
| Loading | Skeleton cards |
| Error | Inline error + retry |
| Permission-denied | Private project slug → 404; a participant gets the same 404 here and a hint only inside the workspace |
| Offline | Cached readable |
| Partial/stale | Projection older than its source version shows «Опубликованная версия от {date}»; update marked «Оспаривается» when the assertion is disputed; «Визуализация» tag on renders |

## Keyboard order and focus

Shell → H1 → CTA → search → view toggle → chips → filters → cards (title link, «Участники и их роли», «Открыть проект») → rail. Gallery: previous/next buttons, thumbnails as radio group; images have meaningful alt from the projection.

## Responsive table behaviour

Milestones tab may be a table (этап, план, факт, статус). Below 768: stacked cards per milestone with baseline and changed dates on separate labelled lines; «изменено по инициативе заказчика» note stays visible (R13).

## Locale keys

| Key | Russian |
|---|---|
| `ru.projects.title` | Проекты, за которыми стоит общее дело *(wording from reference; editorial review)* |
| `ru.projects.lede` | Объекты, участники и опубликованная история — от идеи до результата. *(wording from reference; editorial review)* |
| `ru.projects.present` | Представить проект |
| `ru.projects.searchPlaceholder` | Название, тип объекта, компания или участник |
| `ru.projects.allProjects` | Все проекты |
| `ru.projects.view.cards` | Карточки |
| `ru.projects.view.map` | Карта |
| `ru.projects.filter.region` | Регион |
| `ru.projects.filter.stage` | Стадия проекта |
| `ru.projects.filter.participants` | Участники |
| `ru.projects.sort.recent` | Недавно обновлённые |
| `ru.projects.featured` | Проект в фокусе |
| `ru.projects.participants` | Участники проекта |
| `ru.projects.participantsAndRoles` | Участники и их роли |
| `ru.projects.open` | Открыть проект |
| `ru.projects.owner` | Владелец |
| `ru.projects.visualization` | Визуализация |
| `ru.projects.openNeeds` | Открытые потребности |
| `ru.projects.viewNeeds` | Посмотреть запросы |
| `ru.projects.howMoving` | Как движутся проекты |
| `ru.projects.empty` | Проекты не найдены |
| `ru.projects.publishedVersion` | Опубликованная версия от {date} |
| `ru.projects.tabs.overview` | Обзор |
| `ru.projects.tabs.participants` | Участники |
| `ru.projects.tabs.milestones` | Этапы |
| `ru.projects.tabs.updates` | Обновления |
| `ru.projects.tabs.needs` | Потребности |
| `ru.projects.tabs.publications` | Публикации |
| `ru.projectStatus.planned` | Планируется |
| `ru.projectStatus.active` | Реализуется |
| `ru.projectStatus.suspended` | Приостановлен |
| `ru.projectStatus.completed` | Завершён |
| `ru.projectStatus.cancelled` | Отменён |
| `ru.updateType.result` | Результат |
| `ru.updateType.teamMessage` | Сообщение команды |
| `ru.updateType.discussion` | Обсуждение |
| `ru.evidence.asserted` | Утверждение |
| `ru.evidence.confirmed` | Подтверждено |
| `ru.evidence.disputed` | Оспаривается |
| `ru.evidence.superseded` | Устарело |
| `ru.milestone.baseline` | План |
| `ru.milestone.changed` | Изменённый план |
| `ru.milestone.actual` | Факт |
| `ru.milestone.changedByClient` | Изменено по инициативе заказчика |

## Open questions

- Map view: requires a map provider (O08) and geodata licensing; deferred, toggle hidden until decided.
- Whether a public project may list open needs before COM-001 defines the public RFQ projection.

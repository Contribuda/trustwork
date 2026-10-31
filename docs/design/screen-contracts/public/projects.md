# Projects hub and project public page

Routes: `/projects`, `/projects/[slug]`.

## Status and evidence

`proposed (reference: reviewed, proceeded)` for the hub — `projects-hub.png` (private design archive), manifest `reviewed_proceeded`: "Directory lists only permitted public projections; private by default." `no reference` for the public project page. Spec R04, R12, R13, R15, journeys 5 and 10 ("Public/private boundary").

## Audience and access policy

Everyone sees only projects with an **explicit public projection** (an allowlisted set of fields and attachments chosen by the owner/leader). Participants of a private project do not see it here; they use `/app/projects`. Nothing on these pages reveals quotes, attachments, messages, budgets, internal commitments or private participants. A public "open need" is itself an explicit projection of an RFQ (scope summary, region, deadline), never the full RFQ.

## Data projection

| Field | Public when |
|---|---|
| Title, category (housing, education, industry, public spaces, infrastructure…), region | in projection |
| Status (planned, in progress, paused, completed, cancelled) | in projection |
| Owner (person or company public page) | in projection |
| Public participants with public roles | each participant consented to be listed |
| Description, photos (licensed; "Visualisation" tag when a render) | in projection |
| Published updates: type (result / team message / discussion) with evidence label (assertion / confirmed) | in projection; R13 labels mandatory |
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
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; outlined "Present a project"; featured project; search + "Find"; view toggle (cards only in first slice; map deferred); chips (categories); filters (Region, Stage, Participants, sort); 2-column project cards (photo with optional "Visualisation", title, category/status chips, region, description, owner line, participant chips, "Participants and their roles", "Open the project"); right rail ("What a project shows" (`projects.whatVisible`), "Open needs", "A story with sources" (`projects.sourcesTitle`)); "How projects are moving" update cards; articles; CTA band; footer | Public shell; breadcrumb; header (title, chips, region, owner, status); photo gallery; tabs: Overview, Participants, Milestones, Updates, Needs, Publications (`projects.tabs.*`); right rail: owner card, "What is published here" note, report link |
| Tablet | Cards 2 columns; rail below | Tabs scroll |
| Mobile <768 | Cards 1 column; filters in sheet | Single column; gallery becomes swipeable with buttons and dots that are real controls |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect/FilterSheet, SegmentedControl (view), ProjectCard, StatusChip (lifecycle), ParticipantChipList, UpdateCard (type badge + EvidenceLabel), Tabs, Gallery, MilestoneList (baseline/changed pairs), OpenNeedCard, RailCard, ReportIssueLink, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | "No projects found" + reset; "Open needs" hidden if none |
| Loading | Skeleton cards |
| Error | Inline error + retry |
| Permission-denied | Private project slug → 404; a participant gets the same 404 here and a hint only inside the workspace |
| Offline | Cached readable |
| Partial/stale | Projection older than its source version shows "Published version of {date}"; update marked "Disputed" when the assertion is disputed; "Visualisation" tag on renders |

## Keyboard order and focus

Shell → H1 → CTA → search → view toggle → chips → filters → cards (title link, "Participants and their roles", "Open the project") → rail. Gallery: previous/next buttons, thumbnails as radio group; images have meaningful alt from the projection.

## Responsive table behaviour

Milestones tab may be a table (milestone, plan, actual, status). Below 768: stacked cards per milestone with baseline and changed dates on separate labelled lines; "changed at the client's request" note stays visible (R13).

## Locale keys

| Key | English |
|---|---|
| `projects.title` | Projects with a common cause behind them *(wording from reference; editorial review)* |
| `projects.lede` | Sites, participants and the published story, from idea to result. *(wording from reference; editorial review)* |
| `projects.present` | Present a project |
| `projects.searchPlaceholder` | Name, site type, company or participant |
| `projects.allProjects` | All projects |
| `projects.view.cards` | Cards |
| `projects.view.map` | Map |
| `projects.filter.region` | Region |
| `projects.filter.stage` | Project stage |
| `projects.filter.participants` | Participants |
| `projects.sort.recent` | Recently updated |
| `projects.featured` | Project in focus |
| `projects.participants` | Project participants |
| `projects.participantsAndRoles` | Participants and their roles |
| `projects.open` | Open the project |
| `projects.owner` | Owner |
| `projects.visualization` | Visualisation |
| `projects.openNeeds` | Open needs |
| `projects.viewNeeds` | See the requests |
| `projects.howMoving` | How projects are moving |
| `projects.empty` | No projects found |
| `projects.publishedVersion` | Published version of {date} |
| `projects.tabs.overview` | Overview |
| `projects.tabs.participants` | Participants |
| `projects.tabs.milestones` | Milestones |
| `projects.tabs.updates` | Updates |
| `projects.tabs.needs` | Needs |
| `projects.tabs.publications` | Publications |
| `projectStatus.planned` | Planned |
| `projectStatus.active` | In progress |
| `projectStatus.suspended` | Suspended |
| `projectStatus.completed` | Completed |
| `projectStatus.cancelled` | Cancelled |
| `updateType.result` | Result |
| `updateType.teamMessage` | Team message |
| `updateType.discussion` | Discussion |
| `evidence.asserted` | Asserted |
| `evidence.confirmed` | Confirmed |
| `evidence.disputed` | Disputed |
| `evidence.superseded` | Superseded by a newer version |
| `milestone.baseline` | Plan |
| `milestone.changed` | Changed plan |
| `milestone.actual` | Actual |
| `milestone.changedByClient` | Changed at the client’s request |

## Open questions

- Map view: requires a map provider (O08) and geodata licensing; deferred, toggle hidden until decided.
- Whether a public project may list open needs before COM-001 defines the public RFQ projection.

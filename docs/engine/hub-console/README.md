# The hub console

Requirements R20, R28, R31, R36–R39 and ADR 010 decisions 5, 6, 9, 11, 19. Status: **Proposed** (owner decisions of 2026-10-30 and 2026-10-31). The console contracts in [`packages/contracts/src/hub.ts`](../../../packages/contracts/src/hub.ts) are a proposed **Contract** with unit tests ([`tests/contracts/hub.test.ts`](../../../tests/contracts/hub.test.ts)); nothing in this folder is implemented. It extends [Hub administration](../hub-administration.md), which stays the source of the console's guard rails, staff roles and the counterparty-verification design.

The hub console is what a person uses after installing Trustwork for their country or city. It must let an industry association, a trade publisher or one determined engineer go from an empty server to a lawful, useful, well-run hub **without writing code**: choose a country pack (or start from the generic profile), add regions and cities, languages, currency, identifiers and registers, connect their own keys and models, switch modules on, let an AI-assisted editorial office fill the hub with sourced content, mine public registers lawfully, price the agent product, serve users, and keep the whole system healthy. Every country-specific behaviour is data (packs, hub configuration) or an adapter; the console is where that data is edited.

**Worked example.** The owner's reference deployment is a **United States hub** (owner decision 2026-10-31), so the examples in this folder use it: English default and Spanish (`es-US`) as the second language, USD, US states and territories as regions, EIN as the company identifier, LLC and corporation forms, state contractor licence boards as verification sources, SAM.gov and state procurement portals as opportunity sources, state sales tax, card and ACH payments, ESIGN/UETA e-signatures, CCPA/CPRA-type privacy settings, US federal holidays. One non-US example, a **Samarkand city hub in Uzbekistan** (Uzbek Latin and Russian, UZS, in-country data residency), shows that the same screens configure a very different place. No US country pack exists yet: the US hub starts from the generic profile with local additions, and a US pack is proposed as a work package below. Every provider, register and portal named here is a **candidate** until the hub's compliance officer confirms it.

## Documents in this folder

| Document | What it designs |
|---|---|
| [Installation](installation.md) | One-command Docker Compose install (PostgreSQL, object storage, API, web, worker), the setup token, guides for Railway, Fly.io and Kubernetes, sizing, upgrades |
| [Setup wizard](setup-wizard.md) | First run: node identity, hub identity (country pack or generic profile, territory, languages, currency, brand), operator legal entity, first admin with a second factor, storage and data residency, providers, modes, launch checklist |
| [Keys, providers and models](providers-and-models.md) | Provider connections, secret storage that never shows a value back, connection tests, model routing per job, egress by data class and residency, fallbacks, spending caps, kill switches, usage and cost dashboards |
| [Autonomous editorial office](autonomous-editorial.md) | Source discovery with licence, robots and terms checks, ingestion, deduplication, translation, rewriting with attribution and plagiarism safeguards, fact checks, labelled AI images, calendar, magazine assembly, review queues, manufacturer and supplier knowledge |
| [Local data mining](data-mining.md) | Datasets for companies, licences, court cases, debts, procurement, events, articles and people with legal basis, licence, retention and purpose flags; entity resolution by links; review queues; how results feed directories, verification, matching, recommendations and knowledge |
| [Automation and scheduling](automation-and-scheduling.md) | Scheduler for every pipeline: cron, windows, quotas, retries, alerts, run history, pause and resume, dry runs, backfills |
| [Agent product administration](user-agents-admin.md) | What participants' agents may do in the hub: module catalogue, capabilities, models, limits, metering, cost price and sale price versions, plans and trials, external agents over MCP and A2A, abuse controls, privacy-preserving statistics, kill switches |
| [Module administration](modules.md) | Every product module: people and companies, projects, plan-to-people (planner templates, consultation and task marketplace, shared knowledge), publications, events, learning, matching, commerce, execution and reputation (credentials, confirmations, methods, appeals), communications, billing, search and knowledge, federation, country base. For each: what staff see and do, settings, queues, metrics, guard rails |
| [Support workspace](support.md) | Serving users lawfully: lookup, account card, sessions, second factor, recovery escalation, memberships, entitlements, data export, deletion, consents, communications history, support cases with case grants; why there is no impersonation and what replaces it |
| [Operations](operations.md) | Staff and roles, approvals, audit, backups and restore, updates and migrations, health, feature flags, maintenance, incidents, locale completeness, accessibility, onboarding help |
| [Data model view](data-model.md) | Every console section mapped to the entities it reads and writes and the projection layer it may use |
| [Screens](screens.md) | Screen-by-screen contract: purpose, data, actions, empty/error/denied states, mobile behaviour, locale namespace |

## Principles

1. **Configuration, not code.** Anything that differs between countries, cities or operators is a pack fact, a versioned hub configuration record or an adapter choice. If an operator needs a code change to launch, the console has a gap.
2. **Same rules as the product.** Every console action calls a domain use case with a staff principal, a reason and an audit record. The administration module never writes another module's tables ([architecture](../architecture.md#module-boundaries)).
3. **The guard rails of [Hub administration](../hub-administration.md#guard-rails-that-no-console-can-switch-off) hold everywhere**: no access widening, no ranking controls, no impersonation, no raw database or unrestricted export, restricted places are code, baseline sanctions screening stays on, no surveillance dashboards. This design adds three: **no pipeline publishes** (publication, source activation, dataset activation, link decisions, claims, sanctions and price activation are human gates at every automation level, `HUMAN_GATES` in `hub.ts`); **secrets are write-only** (the console never shows a key back); **statistics about participants are cohorts** (every count under ten is suppressed, `AGGREGATE_MIN_COHORT`).
4. **Versioned, two-person, reversible.** Configuration is never edited in place: each change is a version with a reason, activated (by a second person for sensitive domains) and superseded later. Engaging a kill switch is one click; releasing it needs a second person and an incident note.
5. **Honest labels everywhere.** Demo data carries a banner and never leaves the hub; sourced records stay "from sources" until claimed; AI assistance and AI images are labelled; provider modes (fake, manual, live) are always visible; the console never claims a provider, a register or a backup works until a test or drill proved it.
6. **Usable by one person on a phone, and by twenty staff on desktops.** Queues and approvals work at 375 px; complex editors say «more comfortable on a wide screen» and stay operable. WCAG 2.2 AA, keyboard first, every string in every hub language.

## Who uses it

| Console | Scope | Typical people |
|---|---|---|
| **Setup wizard** | One node, before the first hub exists | Whoever installed the engine, holding the one-time setup token |
| **Node console** | The installation: hubs on it, node staff, engine updates, backups, node identity and signing keys, node-level providers and kill switches, the read-only restricted-places list | Node operator |
| **Hub console** | One hub: everything else | Hub owner and hub staff |

A node with one hub (the common case) opens straight into that hub's console; the node console is a separate entry for node operators. On a node with several hubs, staff reach a hub through the node's hub list or a bookmarked address; there is **no hub switcher in the header**, so the console never resembles the company or workspace switching the product forbids, and each page always names the one hub it acts on.

## Information architecture and navigation

The console lives at `/admin` on the hub's origin, entered from the avatar menu («Администрирование» / "Administration") only by people who hold a staff role, after step-up and a second factor (an **elevated session**, `admin.session.elevate`). It has its own shell with a distinct header band so staff never confuse it with the workspace, a grouped left navigation, and a return link to the workspace.

```text
/admin                                   landing: the single hub's overview, or the node console
/admin/setup/[step]                      setup wizard (only before setup finishes; setup token)
/admin/node/...                          node console
/admin/hubs/[hub]/...                    hub console (sections below)
```

### Hub console section map

| Group | Section (route under `/admin/hubs/[hub]`) | Main contents |
|---|---|---|
| **Home** | Overview `/` | Launch checklist, queues needing people, approvals waiting, compliance status, health, spend against caps, demo/live banner |
| | Approvals `/approvals` | Second-person requests I may approve, my own pending requests, recent decisions |
| | Help `/help` | Guided checklists, handbook links, glossary, what each status label means |
| **Hub** | Identity and territory `/hub/identity` | Name in every hub language, country, regions, cities and places, languages, default language, currency, time zone, brand overlay, domain |
| | System modes `/hub/modes` | Lifecycle stage, demo or live data, registration (closed, invite only, open), moderation strictness, automation level per domain, search-engine indexing, maintenance |
| | Modules `/hub/modules` | Which product modules are on, with dependencies and what each needs before it can be switched on |
| | Legal and operator `/hub/legal` | Operator legal entity, legal document versions in every language with counsel approval, imprint, notices |
| | Residency and sub-processors `/hub/residency` | Where personal data is stored and processed; the generated sub-processor register |
| | Country base `/hub/country` | Country pack binding or generic profile, identifiers, registers, licensing, tax, signatures, payments, holidays; local additions exportable as pack changes |
| | Taxonomy and units `/hub/taxonomy` | Topics, categories, plan-step categories, units, local names; versioned releases |
| | Launch checklist `/hub/launch` | Every gate with evidence; request soft launch or public (second person) |
| **Participants** | People `/participants/people` | Public directory projection, account state counts, consent and portrait problems |
| | Companies `/participants/companies` | Sourced, claimed and verified records, sourced manufacturer and supplier pages, claim status, register re-checks |
| | Claims `/participants/claims` | Claim queue with recipe steps and evidence |
| | Verification `/participants/verification` | Recipes, check providers (fake, manual, live), screening lists |
| | Credentials `/participants/credentials` | Credential types the hub verifies, issued verifiable credentials, revocations, status list |
| | Consents `/participants/consents` | Consent and portrait licence records, withdrawals |
| **Support** | Lookup `/support` | Find a person or company; open the account or company card |
| | Account card `/support/accounts/[person]` | Diagnostic account summary and servicing actions |
| | Company card `/support/companies/[company]` | Company status, members (public roles), claim and verification state, representative state |
| | Cases `/support/cases` | Support cases, case grants, access log per case |
| | Recovery `/support/recovery` | Recovery and second-factor escalations in cooling-off |
| | Access explainer `/support/explain` | Why a person can or cannot see or do something, as reason codes |
| **Editorial office** | Desk `/editorial` | Today's queue, calendar, pipeline health, cost per published item |
| | Sources `/editorial/sources` | Source registry including manufacturers and suppliers: legal checks, allowed uses, attribution, content-type mapping, schedule |
| | Discovery `/editorial/discovery` | Sources proposed by discovery runs, with recorded licence, robots and terms checks |
| | Pipelines `/editorial/pipelines` | Ingestion, drafting, translation and magazine-assembly pipelines with steps, models, caps, schedules |
| | Review `/editorial/review` | Items waiting for an editor: side-by-side with sources, similarity, fact checks, AI labels |
| | Calendar `/editorial/calendar` | Planned, scheduled and published items; magazine issues |
| | Publications `/editorial/publications` | Publications board, corrections, retractions, holds |
| | Magazine `/editorial/magazine` | Issues, assembly proposals, release checklist, PDF renders |
| | Translations `/editorial/translations` | Linked editions waiting for human review per language |
| | Policy `/editorial/policy` | Editorial policy, review rules per format and author type, AI-assistance and AI-image labelling, similarity thresholds |
| **Data** | Datasets `/data/datasets` | Mining datasets with legal basis, licence, retention, purpose, outputs |
| | Import batches `/data/batches` | Batches waiting for review and activation |
| | Links `/data/links` | Entity link proposals (never merges) from mining and peers |
| | Knowledge `/data/knowledge` | Knowledge sources, index generations, evaluation summaries |
| | Recommendations `/data/recommendations` | Plan-step mapping, recommendation rules with explanations, sponsored-content policy, quality metrics |
| **Modules** | Projects `/modules/projects` | Publication policy for projects, counts, transfer and dispute queues |
| | Planner `/modules/planner` | Project plan templates per country and project type, expert authors and reviewers |
| | Marketplace `/modules/marketplace` | Consultation and task categories: who may offer, verification, pricing, commission price versions, refunds and disputes, agent automation |
| | Shared knowledge `/modules/knowledge-sharing` | Diaries, templates, Q&A and lessons proposed for publication, consent status, review |
| | Events `/modules/events` | Hosting policy, event review, ticketing, check-in, refunds, payouts |
| | Learning `/modules/learning` | Course review, certificates, accreditation records |
| | Matching `/modules/matching` | Needs board policy, introduction quotas, method versions |
| | Commerce `/modules/commerce` | Category rules, flow counts, reconciliation of unknown outcomes, case-only access to deal objects |
| **Trust and safety** | Moderation `/trust/moderation` | Reports, cases, clause library, sanction ladder |
| | Disputes `/trust/disputes` | Execution and review disputes with dispute-case grants |
| | Reputation methods `/trust/reputation` | Method versions, local parameters within bounds, explanation texts, release |
| | Appeals `/trust/appeals` | Appeals against verification, credentials, moderation and observations |
| | Screening `/trust/screening` | Sanctions lists, potential matches, re-screening |
| | Confirmations `/trust/confirmations` | Abuse controls for confirmation requests |
| **Agents** | Modules `/agents/modules` | Agent module catalogue: actions, eligibility, models, limits, metering, prices |
| | Policy `/agents/policy` | Allowed actions in the hub, outreach quotas, channels, disclosure text; per-jurisdiction disclosure wording, liability allocation, consent, record-keeping and per-action limits with country-pack defaults (ADR 010 decision 22, HUB-005) |
| | Extensions `/agents/extensions` | Governed extension registry (ADR 010 decision 22, AGT-023): functions, tools and integrations the administrator adds to agents, each with declared actions, inputs, data classes, side effects, endpoints, costs, mandate kinds, safety-suite result and second-person activation |
| | External agents `/agents/external` | MCP and A2A access policy, registered client counts, rate limits |
| | Usage `/agents/usage` | Cohort statistics, cost and revenue per module |
| | Abuse `/agents/abuse` | Abuse signals opening cases; throttles |
| **Billing** | Offers and plans `/billing/offers` | Offers, plan versions, trials, free minimum |
| | Prices `/billing/prices` | Price and metered price versions (cost beside sale price), activation |
| | Invoices `/billing/invoices` | Invoice runs and states (no customer transaction contents) |
| | Payouts `/billing/payouts` | Payout batches to organizers, authors and experts |
| | Credits and refunds `/billing/credits` | Credits within role caps, refund policy versions |
| | Tax `/billing/tax` | Tax treatment of the hub's own fees, e-invoicing |
| **Keys and models** | Providers `/integrations/providers` | Connections for every capability: models, embeddings, images, translation, speech, e-mail, SMS, payments, maps, registers, e-signature, tax |
| | Routing `/integrations/routing` | Model per job with fallbacks and limits |
| | Egress `/integrations/egress` | Data class × connection matrix |
| | Spending caps `/integrations/budgets` | Caps per hub, job, pipeline, agent module, connection |
| | Usage and costs `/integrations/usage` | Aggregates by day, job, model, pipeline, module |
| | Kill switches `/integrations/kill-switches` | Every switch in the hub, engaged and released history |
| **Automation** | Schedules `/automation/schedules` | Every schedule: next runs, windows, quotas, retries, alerts, pause |
| | Runs `/automation/runs` | Run history, run detail with step log, dry runs, retries |
| | Alerts `/automation/alerts` | Open and acknowledged alerts |
| **Communications** | Senders `/communications/senders` | Sending domains, SPF/DKIM/DMARC state, SMS sender registration |
| | Templates `/communications/templates` | Versioned templates per language, preview with synthetic data |
| | Deliverability `/communications/deliverability` | Bounce and complaint counts per template and channel |
| | Announcements `/communications/announcements` | Hub announcements to people who opted in; legal notices |
| **Federation** | Peers `/federation/peers` | Peering agreements and levels |
| | Licences `/federation/licences` | Data licences per class in the node manifest |
| | Tombstones `/federation/tombstones` | Outgoing and incoming tombstones and takedowns, peer compliance |
| | Incoming links `/federation/links` | Link proposals from peers |
| **Privacy** | Requests `/privacy/requests` | Access, export, correction, deletion and opt-out requests with deadlines |
| | Retention and holds `/privacy/retention` | Retention classes, legal holds |
| | Settings `/privacy/settings` | Notices, consent categories, opt-out of sale or sharing, Global Privacy Control, cookie policy, breach contacts |
| | Breaches `/privacy/breaches` | Breach register and notification deadlines |
| **Staff and audit** | Staff `/staff` | Staff, roles, second factors, elevation, conflicts of interest |
| | Audit `/audit` | Mutation audit, access log, chain verification, signed export |
| **Operations** | Health `/ops/health` | Readiness, queues, outbox age, provider states, index freshness, certificates, storage |
| | Jobs `/ops/jobs` | Jobs, dead letters, unknown outcomes and reconciliation |
| | Flags `/ops/flags` | Feature flags (never access-widening) |
| | Maintenance `/ops/maintenance` | Read-only mode, banners |
| | Incidents `/ops/incidents` | Incident records, linked kill switches and holds, post-incident reviews |
| | Locales `/ops/locales` | Completeness of strings, templates and legal documents per hub language |
| | Accessibility `/ops/accessibility` | Brand overlay contrast, automated check results, manual checklist |

### Node console section map

| Section (route under `/admin/node`) | Main contents |
|---|---|
| Overview `/` | Hubs and their stages, engine version, backups, node health |
| Hubs `/hubs` | Create a hub (runs the hub steps of the wizard), hub list, close a hub |
| Staff `/staff` | Node operators and node-scoped roles |
| Providers `/providers` | Node-level connections shared by hubs (object storage, e-mail relay, local model servers) |
| Updates `/updates` | Engine version, release notes, pending migrations, maintenance windows |
| Backups `/backups` | Backup schedule and records, restore drills with evidence, restore execution |
| Identity and keys `/identity` | Node identity, manifest, signing keys and rotation (federation and verifiable credentials) |
| Kill switches `/kill-switches` | Node-wide switches |
| Restricted places `/restricted` | Read-only list from code |

### Navigation behaviour

- The left navigation shows only groups and sections the person holds a read permission for (the administration contract: "area missing from sub-nav"); a direct address without permission renders the denied state inside the shell. This differs deliberately from the workspace, whose menu never hides items.
- Every page header shows the hub name, the lifecycle stage, and, when relevant, a **demo data** or **maintenance** band. Attention counts on navigation items count only work the viewer may act on.
- Mobile (< 768 px): the navigation becomes a full-height sheet with the same groups; Overview, Approvals, queues and kill switches are first-class on phones.

## Permission model

Permissions use the frozen `admin.<domain>.<action>` vocabulary of [`admin.ts`](../../../packages/contracts/src/admin.ts) plus the proposed additions `HUB_CONSOLE_PERMISSIONS` in `hub.ts`. Roles are the platform roles plus the hub-scoped `hub-owner`, `compliance-officer` and the node-scoped `node-operator` (`HUB_STAFF_ROLES`); a staff assignment names its hub or node (`HubStaffAssignmentSchema`). Sensitive roles (`hub-owner`, `staff-admin`, `commercial-admin`, `privacy-officer`, `compliance-officer`, `node-operator`, `platform-owner`) need a second approver.

Second-person actions are the frozen A+2 set plus `HUB_SECOND_PERSON_ACTIONS`: going to soft launch or public, changing residency, activating a legal document version, raising a peering level, activating a model route or egress rule that may carry non-public data, activating a dataset with personal data, raising an automation domain to supervised autonomy, enabling an agent module with commitment actions, releasing a payout batch, resetting a second factor or rebinding a recovery e-mail, executing a restore, applying a production migration, rotating the node key, and releasing any kill switch. In reduced separation-of-duties mode (fewer than five staff) only actor ≠ approver is enforced, as in [Hub administration](../hub-administration.md#hub-staff-roles).

| Section | Read | Act | Typical roles | Second person for |
|---|---|---|---|---|
| Overview, Help | any staff role | — | all | — |
| Approvals | any staff role | the approval's own permission | approvers | — (this is where approvals happen) |
| Hub: identity, taxonomy | `admin.hub.read`, `admin.taxonomy.read` | `admin.hub.identity.edit`, `admin.taxonomy.edit`, `admin.taxonomy.release`, `admin.units.edit` | hub owner, data steward | — |
| Hub: modes, modules | `admin.hub.read` | `admin.hub.modes.edit`, `admin.config.maintenance`, `admin.hub.lifecycle.request` | hub owner, ops engineer | lifecycle transitions, supervised autonomy |
| Hub: legal, residency | `admin.hub.read` | `admin.hub.legal.edit`, `admin.hub.legal.activate`, `admin.hub.residency.edit` | compliance officer | document activation, residency change |
| Hub: country base | `admin.hub.read` | `admin.hub.country.edit`, `admin.currency.edit` | data steward, compliance officer | — |
| Hub: launch | `admin.hub.read` | `admin.hub.launch.check`, `admin.hub.lifecycle.request` | hub owner, compliance officer | soft launch, public |
| Participants: people, companies, consents | `admin.people.consent.read`, `admin.claims.read` | `admin.people.consent.record`, `admin.people.flag`, `admin.people.portrait.licence` | trust reviewer, moderator | — |
| Participants: claims, verification | `admin.claims.read` | `admin.claims.decide`, `admin.claims.revoke`, `admin.claims.policy.edit`, `admin.providers.toggle` | trust reviewer, compliance officer | live check providers |
| Participants: credentials | `admin.claims.read` | `admin.credentials.types.edit`, `admin.credentials.issue`, `admin.credentials.revoke` | trust reviewer | — (issue and revoke are single decisions with evidence; appeals go to a different person) |
| Support | `admin.support.account.read` | `admin.support.case.create`, `admin.support.case.close`, `admin.support.grant.request`, `admin.support.grant.approve`, `admin.support.sessions.revoke`, `admin.support.second_factor.reset`, `admin.support.recovery.rebind`, `admin.support.recovery.approve`, `admin.support.explain`, `admin.support.notifications` | support agent, support lead | case grants, second-factor reset, recovery rebind |
| Editorial: desk, review, calendar, publications, translations | `admin.publications.read` | `admin.editorial.items.review`, `admin.publications.review`, `admin.publications.publish`, `admin.publications.correct`, `admin.publications.retract`, `admin.publications.hold`, `admin.publications.links.edit`, `admin.editorial.calendar.edit` | editor, editor-in-chief, moderator (hold) | — |
| Editorial: sources, discovery | `admin.sources.read` | `admin.sources.manage`, `admin.sources.takedown`, `admin.sources.import.activate` | data steward, editor-in-chief | — |
| Editorial: pipelines, policy | `admin.pipelines.read` | `admin.pipelines.edit`, `admin.pipelines.activate`, `admin.editorial.automation.edit` | editor-in-chief, ops engineer | supervised autonomy |
| Editorial: magazine | `admin.issues.read` | `admin.issues.curate`, `admin.issues.release`, `admin.issues.correct`, `admin.issues.render` | editor-in-chief | — |
| Data: datasets, batches, links | `admin.datasets.read`, `admin.sources.read` | `admin.datasets.edit`, `admin.datasets.activate`, `admin.sources.import.activate`, `admin.links.decide`, `admin.sources.dedupe.decide` | data steward, compliance officer | personal-data datasets |
| Data: knowledge | `admin.retrieval.read`, `admin.retrieval.eval.read` | `admin.retrieval.generation.build`, `admin.retrieval.generation.activate`, `admin.retrieval.generation.taint`, `admin.retrieval.quarantine`, `admin.retrieval.reindex` | ops engineer, data steward | — |
| Data: recommendations | `admin.hub.read` | `admin.recommendations.rules.edit`, `admin.sponsored.policy.edit` | editor-in-chief, data steward | — |
| Modules: projects, commerce | `admin.commerce.flows.read` | `admin.commerce.category_rules.edit`, `admin.assistant.reconcile` | commercial admin, ops engineer | — |
| Modules: planner, marketplace, shared knowledge | `admin.hub.read` | `admin.planner.templates.edit`, `admin.planner.templates.publish`, `admin.marketplace.rules.edit`, `admin.knowledge.shares.review` | editor-in-chief, commercial admin, hub experts with editor role | commission price activation |
| Modules: events, learning, matching | `admin.events.read`, `admin.learning.read`, `admin.matching.read` | `admin.events.review`, `admin.events.policy.edit`, `admin.events.refund.decide`, `admin.learning.review`, `admin.learning.accreditation.record`, `admin.learning.certificate.revoke`, `admin.matching.policy.edit`, `admin.matching.method.release` | editor, commercial admin, trust reviewer | — |
| Trust: moderation | `admin.moderation.read` | `admin.moderation.*` | moderator | sanction level 4 |
| Trust: disputes, reputation, appeals | `admin.trust.evidence.decide` (dispute grant) | `admin.trust.evidence.decide`, `admin.trust.exclude`, `admin.trust.method.release`, `admin.trust.appeals.decide` | trust reviewer, hub owner (method release) | — |
| Trust: screening, confirmations | `admin.claims.read` | `admin.claims.policy.edit` | compliance officer | adding live screening providers |
| Agents | `admin.agents.read` | `admin.agents.modules.edit`, `admin.agents.modules.activate`, `admin.agents.policy.edit`, `admin.agents.clients.manage`, `admin.agents.kill` | commercial admin, ops engineer | commitment modules, kill switch release |
| Billing | `admin.commerce.usage.read`, `admin.billing.invoices.read`, `admin.billing.payouts.read` | `admin.commerce.offer.edit`, `admin.commerce.plan.activate`, `admin.commerce.price.draft`, `admin.commerce.price.activate`, `admin.commerce.credit.issue`, `admin.commerce.refund.policy`, `admin.billing.payouts.release` | commercial admin | price activation, payout release |
| Keys and models | `admin.providers.read`, `admin.usage.read` | `admin.providers.connection.edit`, `admin.providers.secret.write`, `admin.providers.test`, `admin.providers.toggle`, `admin.models.route.edit`, `admin.models.route.activate`, `admin.providers.egress.edit`, `admin.providers.budget.edit`, `admin.providers.kill` | ops engineer, compliance officer (egress) | enabling non-fake providers, private routes and egress, kill switch release |
| Automation | `admin.pipelines.read` | `admin.pipelines.run`, `admin.pipelines.pause`, `admin.jobs.retry` | ops engineer, editor-in-chief, data steward | — |
| Communications | `admin.notifications.read` | `admin.notifications.template.edit`, `admin.notifications.broadcast` | editor, ops engineer | — |
| Federation | `admin.federation.read` | `admin.federation.peer.edit`, `admin.federation.defederate`, `admin.links.decide` | hub owner, compliance officer | raising to `deal-routing` or `identity` |
| Privacy | `admin.privacy.request.read` | `admin.privacy.export`, `admin.privacy.hold`, `admin.privacy.retention.edit`, `admin.privacy.erasure.execute` | privacy officer | erasure execution |
| Staff and audit | `admin.staff.read`, `admin.audit.read` | `admin.staff.assign`, `admin.staff.revoke`, `admin.staff.conflict.declare`, `admin.staff.breakglass`, `admin.audit.export`, `admin.audit.verify` | staff admin, auditor | sensitive roles, SoD mode switch |
| Operations | `admin.observability.read`, `admin.ops.locales.read`, `admin.ops.backups.read` | `admin.flags.edit`, `admin.config.maintenance`, `admin.incident.open`, `admin.incident.preserve`, `admin.incident.review`, `admin.jobs.retry` | ops engineer | — |
| Node console | `admin.node.hubs.manage`, `admin.ops.backups.read` | `admin.node.hubs.manage`, `admin.node.keys.rotate`, `admin.ops.restore.drill`, `admin.ops.restore.execute`, `admin.ops.updates.apply` | node operator | restore, production migration, key rotation |

Two invariants hold for the whole table: **no permission reads a private object** (private data is visible only through a case or dispute grant, in the `staff_case` projection, every read logged), and **no permission exists that sets a score, a position, a badge or a ranking weight** (tested: `admin.ranking.edit` is not in `ConsolePermissionSchema`).

## Implementation plan for the UI agent

The console is built **fixtures-first**: contracts in `hub.ts` (and the existing `admin.ts`, `billing.ts`, `retrieval.ts`, `content.ts`) define every read model; the UI renders synthetic, labelled fixtures through a data port until each backend package lands, exactly as the workspace does today with `?persona=`.

### Routes

```text
apps/web/app/admin/
  layout.tsx                         AdminShell: header band, grouped nav, elevation gate, demo/maintenance bands
  page.tsx                           landing: single hub → its overview; several → node console
  not-found.tsx, error.tsx
  setup/[step]/page.tsx              setup wizard (install_check … review), Stepper
  node/{page,hubs,staff,providers,updates,backups,identity,kill-switches,restricted}/page.tsx
  hubs/[hub]/
    layout.tsx                       loads hub, lifecycle, modes, viewer permissions
    page.tsx                         overview
    approvals/ help/
    hub/{identity,modes,modules,legal,residency,country,taxonomy,launch}/
    participants/{people,companies,claims,verification,credentials,consents}/
    support/{page.tsx,accounts/[person],companies/[company],cases,cases/[case],recovery,explain}/
    editorial/{page.tsx,sources,sources/[source],discovery,pipelines,pipelines/[pipeline],review,review/[item],calendar,publications,magazine,translations,policy}/
    data/{datasets,datasets/[dataset],batches,links,knowledge,recommendations}/
    modules/{projects,planner,marketplace,knowledge-sharing,events,learning,matching,commerce}/
    trust/{moderation,disputes,reputation,appeals,screening,confirmations}/
    agents/{modules,modules/[module],policy,extensions,extensions/[extension],external,usage,abuse}/
    billing/{offers,prices,invoices,payouts,credits,tax}/
    integrations/{providers,providers/[connection],routing,egress,budgets,usage,kill-switches}/
    automation/{schedules,runs,runs/[run],alerts}/
    communications/{senders,templates,deliverability,announcements}/
    federation/{peers,licences,tombstones,links}/
    privacy/{requests,retention,settings,breaches}/
    staff/ audit/
    ops/{health,jobs,flags,maintenance,incidents,locales,accessibility}/
  _data/                             ConsoleDataPort, fixture adapter, permission helpers
  _fixtures/                         synthetic US hub (en, es-US) and Samarkand hub (uz-Latn, ru) fixtures
  _components/                       console-only compositions (see below)
```

### Data

- `apps/web/app/admin/_data/port.ts` declares `ConsoleDataPort` with one method per read model and per command, typed by the contracts. `fixture-adapter.ts` serves synthetic fixtures; a later `api-adapter.ts` calls `/v1/admin/*` with the same types. Commands in fixture mode change nothing and show a "demo: not saved" toast.
- Fixtures are **synthetic and labelled**: «Trustwork United States (demo)», people like "Synthetic Editor", no real company names, no real EINs (use the `00-0000000` style placeholder pattern), no real provider keys (secret references only, fingerprints like `0123456789ab`). Every fixture is parsed by the contract schemas in a unit test (`tests/web/admin-fixtures.test.ts`), so a fixture that violates an invariant fails the build.
- Staff personas extend `apps/web/app/_lib/persona.ts`: `?persona=hub-owner|editor|data-steward|trust-reviewer|support|commercial|ops|privacy|auditor|staff-none`, each mapping to a fixture `HubStaffAssignment` set, so every denied state can be exercised. Scenarios `error`, `offline`, `loading` reuse the existing switch; add `demo-data`, `maintenance`, `kill-switch-engaged`.
- Every visible string under the `admin` key of `apps/web/app/_lib/locales/<locale>.json` in all six engine locales (English reference). Spanish (`es`) is not an engine locale yet; the US demo needs the proposed localization package below before `es-US` can be a hub language with complete strings.

### Components to build

Reuse `@trustwork/ui` (`DataTable`, `Tabs`, `Stepper`, `Dialog`/`ConfirmDialog`, `Badge`, `EmptyState tone="denied"`, `Timeline`, `VersionPicker`, `Toast`, `Form` family, `Switch`, `Select`, `TagSelect`, `Breadcrumb`, `Skeleton`, `DemoBanner`). New console compositions (in `apps/web/app/admin/_components`, promoted to `packages/ui` when reused):

| Component | Purpose |
|---|---|
| `AdminShell`, `ConsoleNav`, `HubBand` | Shell with distinct band, grouped permission-filtered nav, hub name and stage, demo/maintenance bands |
| `StatusLabel` | Live / Demo / Contract / Designed / Proposed and provider modes fake / manual / live, with text, never colour alone |
| `ReasonField`, `AuditNote` | Required reason on every mutation; «This action is recorded in the audit log» |
| `SecondPersonRequest`, `ApprovalCard` | Request an approval bound to an action digest; approve or decline with reason; shows exactly what changes |
| `VersionHistory`, `ConfigDiff` | Versions of any configuration domain with field-level diff, who drafted, approved and activated |
| `SecretField` | Write-only input: paste, submit, then only the keyed fingerprint, store and rotation date are shown; never a reveal button |
| `ConnectionTestPanel` | Runs a synthetic test, shows outcome, latency, models listed, cost of the test |
| `RoutingTable`, `EgressMatrix` | Job × model with fallbacks; data class × connection grid with row and column headers, keyboard-operable cells, explanations of each deny reason |
| `BudgetMeter`, `CostCell`, `MarginCell` | Text first, bar second; money through `Intl.NumberFormat`; cost beside sale price; negative margin warning |
| `KillSwitchControl` | Engage with reason (one person); release needs approval and incident note |
| `CronField` | Five-field editor with presets, plain-language preview and the next five run times in the schedule's time zone |
| `WindowEditor`, `QuotaFields`, `RetryPolicyFields` | Schedule details |
| `RunStateBadge`, `RunTable`, `RunLog` | Run history and step log (structured events, no secrets, no private content) |
| `StepListEditor` | Pipeline steps as a list with move up / move down buttons and per-step model route; shows the human gate at the end |
| `LegalChecksPanel`, `AllowedUsesEditor` | Licence, robots and terms checks with dates and digests; allowed-use switches constrained by the licence |
| `ReviewWorkbench` | Draft beside its sources, similarity meter, fact checks, AI labels, attribution, approve / return / reject |
| `CalendarAgenda` | List-first editorial calendar; month grid on desktop |
| `LaunchChecklist` | Gates with evidence links and owners |
| `SetupWizard` | Steps on `Stepper`, resumable, with a summary before finishing |
| `AccountServiceCard`, `CaseGrantForm`, `PolicyExplainer` | Support workspace |
| `CohortCount` | Renders suppressed counts as «fewer than 10», with an explanation |
| `TemplateTreeEditor` | Plan template phases and items with dependencies, keyboard-reorderable |
| `RecommendationExplainer` | Shows which signals a rule uses and why an item fits a plan step |

### Milestones

| Milestone | Delivers | Exit criteria |
|---|---|---|
| **M0 Contracts and fixtures** | Review of `hub.ts`; fixture set for both example hubs; fixture validation test; staff personas | Fixtures parse; personas cover every role and `staff-none` |
| **M1 Shell, overview, approvals, setup wizard** | `AdminShell`, navigation, overview, approvals, help, setup wizard, hub identity, modes, modules, launch checklist | Playwright journeys at 1280, 768 and 375 px; axe clean; denied states for every route; all six locales complete |
| **M2 Keys, models and automation** | Providers, secret field, connection tests, routing, egress, budgets, usage, kill switches, schedules, runs, alerts | Secret never rendered (DOM scan test); egress matrix keyboard test; kill switch two-person release journey |
| **M3 Editorial office and data** | Sources, discovery, pipelines, review workbench, calendar, publications, magazine, translations, policy, datasets, batches, links, knowledge, recommendations | No "publish" control exists outside the review decision; AI labels visible; link proposals never offer "merge" |
| **M4 Participants, support, trust** | People, companies, claims, verification, credentials, consents, support workspace, moderation, disputes, reputation methods, appeals, screening, confirmations | No-impersonation scan (no "log in as" control or route); case-grant journey; no score-setting control (scan) |
| **M5 Modules, agents, billing** | Projects, planner, marketplace, shared knowledge, events, learning, matching, commerce, agent modules, policy, external agents, usage, abuse, billing sections | Cohort suppression rendered; cost beside sale price; second-person price activation journey |
| **M6 Federation, privacy, staff, operations, node console** | Remaining hub sections and the node console | Full browser plan; restore and migration flows require two people; locale completeness screen blocks activation of incomplete templates |
| **M7 Live wiring** | `api-adapter.ts` against each backend package as it lands | Same journeys against the API; negative authorization tests per endpoint |

## Proposed work packages

**Merged on 2026-10-31** ([ADR 012](../../adr/012-integrator-decisions-2026-10-31.md)): HUB-002 is the umbrella of the console packages; HUBC-001 became ADM-002 (the console shell), the console's OPS-001 became OPS-004 and its PROV-001 became KEYS-001, PLAN-002 became PLAN-003 with commissions in BILL-003, REP-002 and REC-001 were merged with the research proposals, INTL-US was split into INTL-US and LANG-ES, and live wiring is HUBC-007 to HUBC-010 instead of one package. The block below is kept as the original proposal.

```json
[
  {
    "id": "HUBC-000",
    "title": "Review and freeze the hub console contracts",
    "area": "contracts",
    "status": "open",
    "dependsOn": ["FND-002"],
    "handbook": "docs/engine/hub-console/README.md",
    "goal": "Accept packages/contracts/src/hub.ts as the console contract: hub, modes, launch gates, config versions, providers and secret references, routing, egress, budgets, kill switches, sources, datasets, links, schedules, pipelines, runs, editorial items, agent product, plan-to-people, credentials, recommendations, setup and support.",
    "read": ["docs/engine/hub-console/README.md", "docs/engine/hub-console/data-model.md", "docs/data/model.md", "packages/contracts/src/admin.ts"],
    "steps": ["Review naming against docs/data/model.md (snake_case tables, projection layers, Party XOR, versioned records).", "Merge HUB_CONSOLE_PERMISSIONS and HUB_SECOND_PERSON_ACTIONS into the admin vocabulary or keep them separate by decision.", "Add JSON Schema generation for the console contracts."],
    "acceptance": ["Every invariant in hub.ts has a positive and a negative test.", "No schema carries a secret value except the write-only submit command.", "No permission or field can set a score, position, badge or ranking weight."],
    "paths": ["packages/contracts/src/hub.ts", "tests/contracts/hub.test.ts"]
  },
  {
    "id": "INST-001",
    "title": "One-command installation with Docker Compose and the setup token",
    "area": "operations",
    "status": "open",
    "dependsOn": ["DATA-001"],
    "handbook": "docs/engine/hub-console/installation.md",
    "goal": "Let anyone start a node with one command: PostgreSQL, S3-compatible object storage, migrations, API, web and worker, printing a one-time setup URL.",
    "read": ["docs/engine/hub-console/installation.md", "docs/operations/runbook.md", "infra/compose.yaml", "infra/Dockerfile"],
    "steps": ["Write infra/install/compose.yaml with healthchecks, a one-shot migrate service and distinct owner and runtime database roles.", "Generate secrets locally on first start; never commit or print them except the one-time setup token.", "Write the Railway, Fly.io and Kubernetes guides as tested recipes or label them untested.", "Smoke test: fresh install reaches the setup wizard."],
    "acceptance": ["docker compose up on a clean machine reaches /admin/setup with a valid token.", "No default password survives first start.", "Upgrades run migrations forward only after a backup."],
    "paths": ["infra/install", "tests/install"]
  },
  {
    "id": "HUB-004",
    "title": "Setup wizard backend and first run",
    "area": "hubs",
    "status": "open",
    "dependsOn": ["HUB-001", "BE-002", "INST-001"],
    "handbook": "docs/engine/hub-console/setup-wizard.md",
    "goal": "Turn a fresh node into a configured draft hub: setup token, node identity, hub identity from a country pack or the generic profile, operator screening, first admin with a second factor, residency, fake providers, modes.",
    "read": ["docs/engine/hub-console/setup-wizard.md", "docs/engine/hubs.md", "packages/contracts/src/hub.ts"],
    "steps": ["Implement setup token issuance, hashing, expiry and single use.", "Implement SetupState transitions in order with resumable steps.", "Create hub, territories, config versions and launch gates; refuse restricted territories at every level.", "Require a second factor for the first admin and issue recovery codes."],
    "acceptance": ["A second setup cannot start after setup finished.", "A restricted country, region or place is refused.", "The first admin cannot finish without a second factor."],
    "paths": ["apps/api/src/modules/hubs/setup", "tests/hubs/setup"]
  },
  {
    "id": "PROV-001",
    "title": "Provider connections, secret store, model routing, egress, spending caps and kill switches",
    "area": "providers",
    "status": "open",
    "dependsOn": ["HUB-001"],
    "handbook": "docs/engine/hub-console/providers-and-models.md",
    "goal": "Let operators connect their own providers safely: write-only secrets with envelope encryption, synthetic connection tests, routing per job with fallbacks, default-deny egress by data class and residency, caps and kill switches.",
    "read": ["docs/engine/hub-console/providers-and-models.md", "docs/adr/004-delivery-and-providers.md", "docs/architecture/retrieval.md"],
    "steps": ["Implement the secret store port with envelope encryption and an external KMS/Vault adapter interface; fake adapter for tests.", "Implement connection tests that send only synthetic input.", "Implement route resolution with fallbacks and the egress decision before every model call.", "Implement caps with hard stop and kill switches with two-person release."],
    "acceptance": ["No API response, log line, audit event or outbox payload contains a secret value (tested by scanning).", "A call with a non-public data class to a connection without an allow rule is refused.", "An exhausted cap blocks new paid calls."],
    "paths": ["apps/api/src/modules/providers", "apps/worker/src/providers", "tests/providers"]
  },
  {
    "id": "PIPE-001",
    "title": "Pipeline engine and scheduler",
    "area": "automation",
    "status": "open",
    "dependsOn": ["PROV-001"],
    "handbook": "docs/engine/hub-console/automation-and-scheduling.md",
    "goal": "Run versioned pipelines on schedules with windows, quotas, retries, alerts, dry runs, pause and resume, using leased jobs in the worker.",
    "read": ["docs/engine/hub-console/automation-and-scheduling.md", "docs/engine/architecture.md"],
    "steps": ["Implement schedules and the cron evaluator in the hub time zone.", "Implement runs with leasing, fencing, quotas, retry policy and state machine.", "Implement dry runs with no committed effects.", "Implement alerts and auto-pause on source changes."],
    "acceptance": ["A dry run commits nothing (tested).", "Retries never repeat an external effect with an unknown outcome.", "A kill switch stops queued and running runs."],
    "paths": ["apps/worker/src/pipelines", "apps/api/src/modules/pipelines", "tests/pipelines"]
  },
  {
    "id": "EDIT-001",
    "title": "Autonomous editorial office",
    "area": "content-automation",
    "status": "open",
    "dependsOn": ["PIPE-001", "CNT-001"],
    "handbook": "docs/engine/hub-console/autonomous-editorial.md",
    "goal": "Discover and propose sources with recorded legal checks, ingest, deduplicate, draft, translate, check facts and similarity, label AI images and fill review queues; people approve every publication.",
    "read": ["docs/engine/hub-console/autonomous-editorial.md", "docs/engine/publishing.md", "docs/engine/magazine.md"],
    "steps": ["Implement discovery and legal checks (robots, terms digest, licence) with proposals.", "Implement ingestion for RSS, Atom, sitemaps and APIs; page crawling only for sources whose checks permit it.", "Implement deduplication, drafting, translation, similarity and fact-check steps behind model routes.", "Implement the review workbench API, calendar and magazine assembly proposals."],
    "acceptance": ["No code path publishes without a person's approval.", "A source whose robots or terms change is paused automatically.", "AI images carry reader and metadata labels."],
    "paths": ["apps/api/src/modules/editorial-office", "apps/worker/src/editorial", "tests/editorial-office"]
  },
  {
    "id": "MINE-001",
    "title": "Local data mining datasets and entity resolution",
    "area": "data",
    "status": "open",
    "dependsOn": ["PIPE-001", "HUB-003"],
    "handbook": "docs/engine/hub-console/data-mining.md",
    "goal": "Configurable datasets with legal basis, licence, retention and purpose; refresh pipelines; link proposals never merges; outputs to directory, verification evidence, eligibility, opportunities, events and knowledge.",
    "read": ["docs/engine/hub-console/data-mining.md", "docs/engine/people-and-companies.md", "docs/engine/federation.md"],
    "steps": ["Implement datasets and their refresh pipelines with retention enforcement.", "Implement entity resolution producing link proposals with evidence.", "Implement outputs as reviewed imports into each module's use cases."],
    "acceptance": ["Court and debt records about natural persons are never displayed.", "No dataset output reaches reputation.", "People are linked only with their own confirmation."],
    "paths": ["apps/api/src/modules/data-mining", "apps/worker/src/data-mining", "tests/data-mining"]
  },
  {
    "id": "AGTP-001",
    "title": "Agent product administration and external agent access",
    "area": "assistant",
    "status": "open",
    "dependsOn": ["AST-001", "BILL-001", "PROV-001"],
    "handbook": "docs/engine/hub-console/user-agents-admin.md",
    "goal": "Module catalogue, limits, metering, metered price versions with cost and sale price, plans and trials, MCP and A2A access for participants' external agents, abuse signals, cohort statistics, kill switches.",
    "read": ["docs/engine/hub-console/user-agents-admin.md", "docs/engine/agents.md", "docs/engine/billing.md"],
    "steps": ["Implement module versions and eligibility checks in the agent runtime.", "Implement metering and metered price versions with second-person activation.", "Implement the MCP server and A2A endpoint bound to a person and their mandates.", "Implement cohort statistics with suppression and abuse signals opening cases."],
    "acceptance": ["External agents act only under the person's mandates and are labelled.", "Plans and prices never change ranking or matching (comparison test).", "Counts below ten are suppressed in every statistics response."],
    "paths": ["apps/api/src/modules/agent-product", "apps/api/src/modules/external-agents", "tests/agent-product"]
  },
  {
    "id": "SUP-001",
    "title": "Support workspace and account servicing",
    "area": "platform-admin-backend",
    "status": "open",
    "dependsOn": ["ADM-001", "BE-002"],
    "handbook": "docs/engine/hub-console/support.md",
    "goal": "Serve users lawfully without impersonation: lookup, diagnostic account card, servicing actions with cooling-off, case grants, access explainer, consented diagnostic snapshots.",
    "read": ["docs/engine/hub-console/support.md", "docs/engine/trust-safety-privacy.md"],
    "steps": ["Implement the account summary allowlist projection.", "Implement servicing actions with evidence, second person and 72-hour cooling-off where required.", "Implement the access explainer returning reason codes only.", "Implement user-initiated diagnostic snapshots attached to cases."],
    "acceptance": ["No endpoint issues a session for another person.", "Sign-in factor changes notify every verified channel and wait 72 hours.", "Explainer responses contain no private values."],
    "paths": ["apps/api/src/modules/support", "tests/support"]
  },
  {
    "id": "OPS-001",
    "title": "Backups, restore drills, updates and health in the console",
    "area": "operations",
    "status": "open",
    "dependsOn": ["HUB-001", "INST-001"],
    "handbook": "docs/engine/hub-console/operations.md",
    "goal": "Scheduled encrypted backups, restore drills with evidence, two-person restore and production migrations, update notices, readiness and health counts.",
    "read": ["docs/engine/hub-console/operations.md", "docs/operations/runbook.md"],
    "steps": ["Implement backup records and drills against an isolated environment.", "Implement update checks and migration status with backup-before-apply.", "Implement readiness and health aggregates."],
    "acceptance": ["A restore replays tombstones before reconnecting workers.", "A production migration without a fresh backup is refused."],
    "paths": ["apps/api/src/modules/operations", "tests/operations"]
  },
  {
    "id": "PLAN-002",
    "title": "Planner templates, consultation and task marketplace rules, shared knowledge administration",
    "area": "gathering-point",
    "status": "open",
    "dependsOn": ["MATCH-001", "BILL-001", "CNT-001"],
    "handbook": "docs/engine/hub-console/modules.md",
    "goal": "Hub experts maintain plan templates per country and project type; operators set marketplace category rules and commission price versions; consented completed projects become reviewed shared knowledge.",
    "read": ["docs/engine/hub-console/modules.md", "docs/engine/partners-and-matching.md", "docs/engine/billing.md"],
    "steps": ["Implement plan template versions with author and reviewer separation.", "Implement marketplace category rules, commission offers and refund windows.", "Implement knowledge shares with consent of the owner and every named party."],
    "acceptance": ["A template author cannot publish their own template.", "Licensed categories accept only verified providers.", "No knowledge share publishes without every consent or with private fields."],
    "paths": ["apps/api/src/modules/planner-admin", "tests/planner-admin"]
  },
  {
    "id": "REP-002",
    "title": "Credential types, hub-issued verifiable credentials and confirmation controls",
    "area": "trust",
    "status": "open",
    "dependsOn": ["HUB-003", "EXE-001", "FED-001"],
    "handbook": "docs/engine/hub-console/modules.md",
    "goal": "Hubs define which credentials they verify and how, issue and revoke verifiable credentials signed with node identity keys, publish a status list, and keep confirmation requests honest.",
    "read": ["docs/engine/hub-console/modules.md", "docs/engine/execution-and-reputation.md", "docs/engine/federation.md"],
    "steps": ["Implement credential types bound to verification recipes.", "Implement issuance and revocation with a status list.", "Implement confirmation request limits and reciprocal-confirmation flags."],
    "acceptance": ["A credential is never a score.", "Revocation is visible in the status list within minutes.", "Agents may request but never give confirmations."],
    "paths": ["apps/api/src/modules/credentials", "tests/credentials"]
  },
  {
    "id": "REC-001",
    "title": "Manufacturer knowledge and plan-step recommendations",
    "area": "gathering-point",
    "status": "open",
    "dependsOn": ["EDIT-001", "PLAN-002", "RAG-301"],
    "handbook": "docs/engine/hub-console/autonomous-editorial.md",
    "goal": "Sourced manufacturer and supplier pages with content-type mapping; recommendations per plan step with explanations; sponsored content labelled and outside ranking.",
    "read": ["docs/engine/hub-console/autonomous-editorial.md", "docs/engine/hub-console/data-mining.md", "docs/engine/search-and-knowledge.md"],
    "steps": ["Implement content-type mapping for manufacturer sources.", "Implement recommendation rules with explanation records.", "Implement the sponsored-content policy and its exclusion tests."],
    "acceptance": ["Every recommendation carries its explanation.", "Rankings with and without sponsorship or paid plans are identical (test)."],
    "paths": ["apps/api/src/modules/recommendations", "tests/recommendations"]
  },
  {
    "id": "INTL-US",
    "title": "United States country pack and Spanish locale",
    "area": "international",
    "status": "open",
    "dependsOn": ["CTRY-002"],
    "handbook": "docs/engine/country-specifics.md",
    "goal": "Pack the reference deployment's country: EIN, entity forms, states and territories, licensing boards, sales tax facts, SAM.gov, ESIGN/UETA, payments, federal holidays, state privacy laws; add Spanish as an engine locale.",
    "read": ["docs/engine/country-specifics.md", "docs/engine/localization.md", "docs/country-packs/how-to-add-a-country.md"],
    "steps": ["Write the US pack with sources and honest verification levels.", "Add the es locale with complete strings and native review.", "Add a US demo fixture set labelled synthetic."],
    "acceptance": ["Every fact cites a source.", "es passes the locale completeness tests."],
    "paths": ["packages/country-packs/packs/us.json", "packages/ui/locales/es.json", "apps/web/app/_lib/locales/es.json"]
  },
  {
    "id": "HUBC-001",
    "title": "Console shell, overview, approvals and setup wizard on fixtures",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-000", "WEB-001", "DS-001"],
    "handbook": "docs/engine/hub-console/README.md",
    "goal": "Milestones M0 and M1: fixtures, staff personas, AdminShell, overview, approvals, help, setup wizard, hub identity, modes, modules, launch checklist.",
    "read": ["docs/engine/hub-console/screens.md", "docs/engine/hub-console/setup-wizard.md", "docs/design/screen-contracts/workspace/administration.md"],
    "steps": ["Build fixtures validated by contract schemas and staff personas.", "Build the shell and the M1 screens with every state.", "Localize in all six languages; Playwright and axe at three widths."],
    "acceptance": ["Denied state on every route for staff-none.", "No English text in non-English locales.", "Demo band visible on demo data."],
    "paths": ["apps/web/app/admin", "tests/web/admin"]
  },
  {
    "id": "HUBC-002",
    "title": "Console: keys, models and automation screens",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-001"],
    "handbook": "docs/engine/hub-console/providers-and-models.md",
    "goal": "Milestone M2 on fixtures.",
    "read": ["docs/engine/hub-console/screens.md", "docs/engine/hub-console/automation-and-scheduling.md"],
    "steps": ["Build providers, secret field, connection tests, routing, egress, budgets, usage, kill switches.", "Build schedules, runs and alerts."],
    "acceptance": ["A DOM scan finds no secret value.", "Egress matrix operable by keyboard and screen reader."],
    "paths": ["apps/web/app/admin/hubs/[hub]/integrations", "apps/web/app/admin/hubs/[hub]/automation", "tests/web/admin"]
  },
  {
    "id": "HUBC-003",
    "title": "Console: editorial office and data screens",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-001"],
    "handbook": "docs/engine/hub-console/autonomous-editorial.md",
    "goal": "Milestone M3 on fixtures.",
    "read": ["docs/engine/hub-console/screens.md", "docs/engine/hub-console/data-mining.md"],
    "steps": ["Build editorial sections including the review workbench.", "Build datasets, batches, links, knowledge and recommendations."],
    "acceptance": ["No publish control outside the review decision.", "No merge control anywhere."],
    "paths": ["apps/web/app/admin/hubs/[hub]/editorial", "apps/web/app/admin/hubs/[hub]/data", "tests/web/admin"]
  },
  {
    "id": "HUBC-004",
    "title": "Console: participants, support and trust screens",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-001"],
    "handbook": "docs/engine/hub-console/support.md",
    "goal": "Milestone M4 on fixtures.",
    "read": ["docs/engine/hub-console/screens.md", "docs/engine/hub-console/modules.md"],
    "steps": ["Build participants and support sections.", "Build trust and safety sections."],
    "acceptance": ["No impersonation route or control.", "No control sets a score or badge."],
    "paths": ["apps/web/app/admin/hubs/[hub]/participants", "apps/web/app/admin/hubs/[hub]/support", "apps/web/app/admin/hubs/[hub]/trust", "tests/web/admin"]
  },
  {
    "id": "HUBC-005",
    "title": "Console: modules, agents and billing screens",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-001"],
    "handbook": "docs/engine/hub-console/user-agents-admin.md",
    "goal": "Milestone M5 on fixtures.",
    "read": ["docs/engine/hub-console/screens.md", "docs/engine/hub-console/modules.md"],
    "steps": ["Build module sections including planner, marketplace and shared knowledge.", "Build agent product and billing sections."],
    "acceptance": ["Cohort suppression rendered.", "Cost price shown beside sale price; activation needs a second person."],
    "paths": ["apps/web/app/admin/hubs/[hub]/modules", "apps/web/app/admin/hubs/[hub]/agents", "apps/web/app/admin/hubs/[hub]/billing", "tests/web/admin"]
  },
  {
    "id": "HUBC-006",
    "title": "Console: federation, privacy, staff, operations and node console",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-001"],
    "handbook": "docs/engine/hub-console/operations.md",
    "goal": "Milestone M6 on fixtures.",
    "read": ["docs/engine/hub-console/screens.md", "docs/engine/hub-console/operations.md"],
    "steps": ["Build federation, privacy, staff and audit, operations sections.", "Build the node console."],
    "acceptance": ["Restore and production migration need two people.", "Locale completeness blocks activation of incomplete templates."],
    "paths": ["apps/web/app/admin/hubs/[hub]/federation", "apps/web/app/admin/hubs/[hub]/privacy", "apps/web/app/admin/hubs/[hub]/ops", "apps/web/app/admin/node", "tests/web/admin"]
  },
  {
    "id": "HUBC-007",
    "title": "Console: wire screens to the live API",
    "area": "hubs-web",
    "status": "open",
    "dependsOn": ["HUBC-002", "HUBC-003", "HUBC-004", "HUBC-005", "HUBC-006", "HUB-004", "PROV-001", "PIPE-001", "SUP-001"],
    "handbook": "docs/engine/hub-console/README.md",
    "goal": "Milestone M7: replace the fixture adapter section by section as backends land.",
    "read": ["docs/engine/hub-console/data-model.md"],
    "steps": ["Implement the API adapter per section.", "Run the browser plan against the API with negative authorization."],
    "acceptance": ["Every private object is not found to staff without a case grant through every console path."],
    "paths": ["apps/web/app/admin/_data", "tests/web/admin"]
  }
]
```

## Open questions for the owner

Answered on 2026-10-31 by the conductor and the integrator ([ADR 012](../../adr/012-integrator-decisions-2026-10-31.md)): staff roles may be scoped to a node or a hub; the setup wizard offers OpenRouter as one optional choice next to direct providers; sponsored content is a per-hub option, off by default, always labelled and never used for ranking, matching or recommendations; court and debt datasets are off by default in every hub; Spanish is the seventh engine language (`es`, with US formats in a US hub); the passport uses W3C Verifiable Credentials 2.0 compatible with Open Badges 3.0, signed with node keys. The original questions follow.

1. **Hub-scoped roles vs platform roles.** `admin.ts` freezes `scope: 'platform'`; this design proposes hub and node scopes. Accept, or keep one platform scope per node?
2. **OpenRouter by default?** The design treats a broker as an ordinary provider whose egress is limited to public data unless its routed vendors' retention terms are recorded. Should the setup wizard suggest it at all?
3. **Sponsored content.** Allowed per hub with the strict policy above, or forbidden engine-wide?
4. **Court and debt records.** The design allows them about companies with an impact assessment and only as reviewed verification evidence about natural persons; some operators will want stricter defaults (off). Default off?
5. **Spanish.** Add `es` as the seventh engine locale for the US demo (proposed INTL-US)?
6. **Verifiable credential format.** W3C VC data model with a status list, signed by node keys; confirm before REP-002.

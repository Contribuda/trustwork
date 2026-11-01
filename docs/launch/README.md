# Launching a Trustwork hub in a new country

Status: **Proposed** playbook (owner request of 2026-11-01, author Claude, an AI agent working for the repository owner Dmitry Parshkov). Nothing in this folder is implemented by itself: it tells a future hub operator what to decide, what to prepare and what the engine will do, and it states honestly which parts work today and which are designed or proposed ([What works today](../engine/status.md)). It is not legal advice; every legal point is a question for the operator's counsel.

This folder is for anyone who wants to run Trustwork for a country or a city: an industry association, a chamber of commerce, a trade publisher, a university, a training body, an entrepreneur or a community of engineers. It explains what you can do, what is possible, what stays with people, and how to let the engine's agent teams do the tireless part of a launch.

| Document | What it gives you |
|---|---|
| This page | The generic playbook for any country: decisions, setup, data sourcing, agent automation, outreach and claims, compliance gates, go-live, operations, a 90-day template, costs, KPIs and approvals |
| [Top 10 launch countries](../research/top-10-launch-countries-2026-11.md) | How the first ten countries were chosen: method, indicators, scorecard, sensitivity and sources |
| [Country playbooks](#country-playbooks) | For each of the ten countries: the market, competitors, culture and trust, law and compliance, payments, local data resources, infrastructure, partners, and a full autonomous launch plan |

Integration review: source facts and cost estimates below retain their original research provenance; this pass did not refresh external sources, approve legal conclusions, verify a deployment or authorize a launch.

## Contents

1. [What a launch is](#what-a-launch-is)
2. [What works today and what is designed](#what-works-today-and-what-is-designed)
3. [Phase 0: decide](#phase-0-decide)
4. [Phase 1: prepare](#phase-1-prepare)
5. [Phase 2: install and set up](#phase-2-install-and-set-up)
6. [Phase 3: data sourcing](#phase-3-data-sourcing)
7. [Phase 4: let the agent teams work](#phase-4-let-the-agent-teams-work)
   - [The hub operating company: an AI operator team first, people as you grow](#the-hub-operating-company-an-ai-operator-team-first-people-as-you-grow)
8. [Phase 5: claims and outreach](#phase-5-claims-and-outreach)
9. [Phase 6: compliance gates](#phase-6-compliance-gates)
10. [Phase 7: soft launch and go-live](#phase-7-soft-launch-and-go-live)
11. [Phase 8: operations](#phase-8-operations)
12. [The first 90 days, week by week](#the-first-90-days-week-by-week)
13. [Seed content plan](#seed-content-plan)
14. [What always stays human](#what-always-stays-human)
15. [Costs](#costs)
16. [KPIs without surveillance](#kpis-without-surveillance)
17. [Risks every launch shares](#risks-every-launch-shares)
18. [Approvals before going live](#approvals-before-going-live)
19. [Country playbooks](#country-playbooks)
20. [Feature gaps and the packages that close them](#feature-gaps-and-the-packages-that-close-them)
21. [Where to read more](#where-to-read-more)

## What a launch is

A **hub** is the platform for one territory: a country, a region or a city ([Hubs](../engine/hubs.md)). Launching one means taking a fresh installation (a **node**) through the hub lifecycle:

```text
draft → preparing → soft_launch (invite-only) → public
```

The engine refuses to go public until the **launch checklist** is green ([Hubs: launch checklist](../engine/hubs.md#launch-checklist)). A good launch is **content first**: sources and a newsroom before registration, real companies labelled honestly as "from sources", invitations to claim pages through a verification recipe, one event a month, local champions as editors and experts, and never anything fake ([Hubs: growing a hub](../engine/hubs.md#growing-a-hub)).

What makes Trustwork different from a directory or a lead marketplace, and what every launch should explain to the people of its territory:

| Promise | Why it matters in a new market |
|---|---|
| Sourced is not claimed is not verified | A company page built from a public register says so; nobody looks endorsed by accident ([People and companies](../engine/people-and-companies.md)) |
| Reputation is built from evidence and cannot be bought | Contractors and workers build a portfolio confirmed by real clients; payment never changes ranking ([Execution and reputation](../engine/execution-and-reputation.md)) |
| A plan for every project | A homeowner's agent turns "I want to build a house" into phases, trades, materials, permits and budget ranges, and each step finds guides, experts and contractors ([Projects](../engine/projects.md)) |
| Trustwork never holds money | Payments go only through licensed providers the hub configures ([Billing](../engine/billing.md#trustwork-never-holds-money)) |
| One agent per person, under mandates | The agent works for the person, inside limits they set; chat text never authorises a commitment ([Your agent](../engine/agents.md)) |
| One worldwide mesh | A hub peers with neighbouring hubs so participants see a bigger market from day one ([Federation](../engine/federation.md)) |

## What works today and what is designed

Be honest with partners and participants about this table; it changes as work packages land ([status](../engine/status.md), [roadmap](../engine/roadmap.md)).

| Capability | Status | Package |
|---|---|---|
| Country selection, seven interface languages, country packs as data, restricted places refused | **Live** | INTL-002, CFG-001, CTRY-002, SANC-001 |
| Hubs, territories, hub staff, versioned configuration, lifecycle and launch gates as an API | **Live** (no console yet) | HUB-001 |
| Accounts, companies, projects, plans, tasks, reputation builder backends | **Live** in code and tests, not deployed | BE-001, PLAN-001, TASK-001, REP-001 |
| Sanctions list ingestion, screening, re-screening, deployment-location attestation | **Live** in code and tests | SANC-002, SANC-003, SANC-005, SANC-009 |
| Transactional mail through the outbox | **Live** in code and tests | MAIL-001 |
| Setup wizard backend | In progress | HUB-004 |
| Hub console screens | Fixtures and contracts; live wiring proposed | ADM-002, HUBC-002 to HUBC-010 |
| Source registry, pipelines, data mining, editorial office, editorial agent team | **Proposed** | SRC-001, PIPE-001, MINE-001, EDIT-001; editorial agent team proposed in [pull request #367](https://github.com/Contribuda/trustwork/pull/367) |
| Discovery, sourced pages, claim hand-over and per-country outreach policy | **Proposed** | REG-001, CLM-001; outreach design in [Discovery and outreach](../engine/discovery-and-outreach.md) (OUTR-001 to OUTR-004, ENT-001) |
| The operator's agent team in the console | **Proposed** | Console design in [Console design](../engine/hub-console/console-design.md) (AGT-030) |
| Payments through licensed providers, mobile money adapters | **Proposed** | PAY-001, PAY-003 |
| SMS, WhatsApp, USSD, offline mobile web | **Proposed** | CHAN-001, CHAN-002, MOB-001 |

The hosted reference hub (United States, San Diego) is intended to remain **demo-only with synthetic data** until its release candidate passes, counsel reviews it and the owner switches real sign-ups on ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decisions 26 to 28; [platform release candidate](../quality/release/platform.md)). A new country hub follows the same rule: **no real people before counsel and the operator's switch.**

**What you can do now, before the engine is complete:** form the operator entity and engage counsel; contribute or review your country pack (facts with sources); translate or review a language; inventory your sources and their licences; draft the editorial policy, community rules and outreach policy; find your local champions and partners; and run the demo to show people what the hub will be. Every country playbook lists these "now" tasks in its first weeks.

## Phase 0: decide

Answer these before installing anything. Each country playbook answers them for its country; the answers become the values you enter in the setup wizard.

| # | Decision | Options and guidance | Recorded where |
|---|---|---|---|
| 1 | **Territory** | A country hub (ISO 3166-1), a region (ISO 3166-2) or a city (a place key). Start where you have partners and density; a city hub can launch first and peer with a country hub later ([Hubs: territories](../engine/hubs.md#territories)) | Setup wizard step 3 |
| 2 | **Operator legal entity** | Who is legally responsible: an association, a company, a foundation. It must be screened against sanctions lists and record the deployment-location attestation ([ADR 014](../adr/014-sanctions-compliance-engine.md) decision 4) | Wizard step 4 |
| 3 | **Counsel** | A lawyer in the territory who reviews terms, privacy notice, sanctions section, outreach policy, agent disclosure and liability wording, consumer and platform rules. Required for the `legal_documents_approved` gate | Launch gate 2 |
| 4 | **Data residency** | Where personal data is stored and processed. Some countries require storage in the country (Uzbekistan; Rwanda unless authorised); others restrict transfers. Decide before choosing hosting ([setup wizard step 6](../engine/hub-console/setup-wizard.md#6-storage-and-data-residency-storage_residency)) | Wizard step 6; gate 3 |
| 5 | **Languages and default** | One default plus others; a language with incomplete strings blocks the `i18n_complete` gate ([Countries and languages](../engine/localization.md)) | Wizard step 3 |
| 6 | **Currency and formats** | From the country pack or the ISO profile | Wizard step 3 |
| 7 | **Model providers and egress** | Which AI model routes the hub uses and which data classes may reach them; by default nothing non-public leaves the residency country ([Keys, providers and models](../engine/hub-console/providers-and-models.md)) | Console; KEYS-001 |
| 8 | **Outreach mode** | `strict` by default everywhere (no contact with non-participants); `notice_only` or `governed` only after counsel and a second person approve ([Discovery and outreach](../engine/discovery-and-outreach.md)) | Hub configuration domain `outreach` (proposed OUTR-001) |
| 9 | **Verification recipe** | How a company claim becomes verified: register match, signatory tie, sanctions screening ([Hub administration: counterparty verification](../engine/hub-administration.md#counterparty-verification)) | Console; HUB-003, CLM-001 |
| 10 | **Payment providers** | Licensed providers only; the hub never holds money; start with none (no paid features) if unsure | Console; PAY-001, PAY-003 |
| 11 | **Commissions and prices** | Versioned, disclosed, second-person activation; free is a valid start ([Billing](../engine/billing.md#commissions-and-fees-are-hub-settings)) | Console; BILL-003 |
| 12 | **Staff** | At least two people with distinct roles and second factors (gate 4); an editor-in-chief (gate 5); a compliance officer; a trust reviewer for claims | Console; gate 4 and 5 |
| 13 | **Partners** | Industry bodies, professional bodies, training bodies, universities, development programmes; their role (editorial exchange, event co-hosting, verification help, distribution) | Cooperation agreements (outside the engine) |
| 14 | **Federation** | Which hubs to peer with and at what level ([Federation](../engine/federation.md)) | Console |

## Phase 1: prepare

| Workstream | What to produce | Engine reference |
|---|---|---|
| Legal | Operator entity documents; counsel engagement letter; draft terms, privacy notice, sanctions section, imprint, community rules, editorial policy, outreach policy, agent disclosure wording; registration with the data protection authority where required (for example Kenya's ODPC, Nigeria's NDPC, Ghana's Data Protection Commission, Rwanda's NCSA, the Philippines' NPC for a data protection officer) | [Legal templates](../legal/templates/README.md), HUB-005 jurisdiction settings |
| Country pack | Facts for your country with sources and verification levels: identifiers, registers, licensing, codes, procurement, tax and e-invoicing, e-signature, payments, privacy, holidays, languages, units; and the taxonomy's permit and inspection answers (`data/taxonomy/jurisdictions/<CC>.json`) | [How to add a country](../country-packs/how-to-add-a-country.md), [Country specifics](../engine/country-specifics.md) |
| Language | Translation or review of the interface language(s); review status recorded honestly (machine draft, community reviewed, native reviewed) | [Adding a language](../engine/localization.md#adding-a-language) |
| Sources inventory | A spreadsheet (later a launch kit, LAUNCH-001) of candidate sources: registers, licence boards, procurement portals, statistics, regulators, trade media, associations, manufacturers and suppliers, training providers, event organisers; with URL, feed or API, licence, robots and terms status, personal data, refresh cadence | [Autonomous editorial office: discovering sources](../engine/hub-console/autonomous-editorial.md#1-discovering-sources), [Local data mining](../engine/hub-console/data-mining.md) |
| Partners | A list of kinds of partners and what each could do; cooperation agreements drafted by the operator | [Hubs: how country and city hubs complement each other](../engine/hubs.md#how-country-and-city-hubs-complement-each-other) |
| People | Named accountable editor, compliance officer, trust reviewer, moderator, support; at least two staff with distinct roles before soft launch | [Hub staff roles](../engine/hub-administration.md#hub-staff-roles) |
| Infrastructure | Hosting in the residency region, domain, mail sender domain with SPF, DKIM and DMARC, backups with a restore drill | [Installation](../engine/hub-console/installation.md), [Backup and restore](../operations/backup-and-restore.md) |

## Phase 2: install and set up

Install the node ([installation](../engine/hub-console/installation.md), INST-001 proposed) and run the **setup wizard** ([setup wizard](../engine/hub-console/setup-wizard.md), backend HUB-004 in progress). At the end the hub is a `draft`, registration is closed, every provider is a fake, search-engine indexing is off and nothing has been sent anywhere.

| Wizard step | What to enter for a new country | Notes |
|---|---|---|
| 1. Install check | HTTPS address, database, storage, worker, clock, secret store | Fix before continuing |
| 2. Node identity | Node name and domain; the signing key is generated; node jurisdiction | A restricted place is never offered |
| 3. Hub identity | Starting point: the country pack if it exists, otherwise the generic ISO profile with local additions that become pack-change proposals; territory; hub name in every hub language; languages and default; currency; time zone; identifiers; brand overlay | Each country playbook gives the values |
| 4. Operator legal entity | Legal name, form, registration identifier, addresses, deployment-location attestation, ownership declaration, sanctions screening | Gate `operator_recorded_and_screened` passes only with a real screening result |
| 5. First administrator | Second factor mandatory; reduced separation-of-duties mode until a second staff member joins | |
| 6. Storage and data residency | Where personal data lives; where database, storage and backups are; which privacy regime applies | A sensitive domain: changing it later needs a second person |
| 7. Providers | Keep every capability on its fake; prepare e-mail; invite the second staff member by one-time link | Live providers need a second person (`providers.enable_non_fake`) |
| 8. Modes | Data `demo` or `live` empty; registration `closed`; modules; moderation; automation `manual` everywhere | Raise automation later, domain by domain |
| 9. Review | Finish; the launch checklist appears with the "next five things" | |

A **launch kit** (LAUNCH-001, proposed) will let the wizard prefill steps 3, 6 and 8 and import the country's candidate sources as proposals from a reviewed file in `data/launch-kits/<CC>.json`. Until it exists, the country playbook tables are the kit.

## Phase 3: data sourcing

A hub becomes useful when it knows the local industry. The engine is built around **sources with recorded legal flags, datasets with a declared purpose and legal basis, links instead of merges, and people deciding what goes live** ([local data mining](../engine/hub-console/data-mining.md)).

### Kinds of local data and how each is used

| Kind | Typical sources | Becomes | Rules |
|---|---|---|---|
| Company registers | Business and tax registers, statistics registers, chambers of commerce | Sourced company records (`directory_sourced_records`), verification evidence | Field-level provenance; an identifier never upgrades a badge by itself |
| Contractor and professional registers | Construction authorities, licensing boards, engineers' and architects' councils, training bodies | Licence facts with expiry (`verification_evidence`, `matching_eligibility`), REG-001 and REG-002 | Natural persons appear often: personal-data flags; never "certified by Trustwork" |
| Public procurement | National portals, ideally OCDS feeds (PROC-002, PROC-003) | Labelled opportunities on the needs board; awards as sourced track records | The engine never submits bids |
| Building permits | Municipal or national permit systems where open | Sourced project facts (PRMT-001) | Never publish homeowner names or private addresses |
| News and knowledge | Regulators, statistics offices, trade media, associations, manufacturers' technical libraries | Items in the editorial review queue; knowledge base entries with licence flags | Licence decides the treatment: headline and link, summary, rewrite, translation |
| Manufacturers and suppliers | Public sites, catalogues, training and events pages | Sourced manufacturer pages, plan-step recommendations ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 19) | Robots and terms respected; sponsored content never ranks |
| Events | Associations, manufacturers, training centres | Sourced events labelled as such | Never presented as hosted on the hub |
| Geography | OpenStreetMap (ODbL), national digital address systems where they exist | Places, service areas, coarse locations (ADDR-001) | ODbL attribution; never expose an active site location |
| Courts and debts | Off by default in every hub | Only reviewed verification evidence, never public about people | Impact assessment required |

### How to admit a source

1. A **Scout** (an agent role, or a person) proposes the source with recorded checks: licence, robots.txt, terms of use, feeds and APIs, personal data and legal basis, takedown contact.
2. A **data steward** or the editor-in-chief reviews purposes and allowed uses, writes the attribution template and **activates** it. Only people activate sources.
3. Ingestion runs on a schedule with per-host limits and auto-pause triggers (robots or terms changed, licence ended, error streak).
4. Imported items land in review queues; nothing is published without a person's decision.

### Personal data, everywhere

- Never create public profiles of people from datasets; people appear only when they join or as business contacts in a staff-only projection where the outreach policy allows ([Discovery and outreach](../engine/discovery-and-outreach.md), section 5).
- Sole proprietors are often natural persons: treat their records as personal data.
- Record a legal basis per dataset; a second person activates a dataset with personal data.
- Keep data in the residency region; model egress only for allowed data classes.

## Phase 4: let the agent teams work

A launch needs tireless work: finding sources, reading registers, building sourced pages, drafting news and guides, translating, preparing claim checks, watching freshness. The engine gives the operator **agent teams** for this. They are hub automation, not participants: no accounts of their own, no participant mandates, no public presence, every output labelled and audited, every role with an accountable person, budgets and kill switches.

| Team | Roles (as designed) | Autonomy vocabulary | Design |
|---|---|---|---|
| Discovery and outreach | Scout, Collector, Resolver, Enricher, Page assembler, Watcher, Outreach drafter, Sender, Reply triager, Claim assistant | `manual`, `assisted`, `supervised_autonomous` | [Discovery and outreach](../engine/discovery-and-outreach.md), section 11 |
| Editorial | Scout, Collector, Researcher, Writer, Fact-checker, Translator, Post-editor, Editor-assistant, Layout and PDF designer, Designer, Illustrator, Photo researcher, SEO and metadata, Newsletter and social, Curator, Licence checker, Accessibility checker, Corrections watcher, Knowledge packager | Off, Draft only, Auto with review, Auto-publish allowed (only under an active standing publication policy) | [Pull request #367](https://github.com/Contribuda/trustwork/pull/367), section 8; today's chapter: [autonomous editorial office](../engine/hub-console/autonomous-editorial.md) |
| Operator (platform) | Support triage, Moderation triage, Trust and safety assistant, Sanctions review assistant, Data steward assistant, Operations monitor, Billing reconciliation, Analytics reporter, Setup assistant | Observe, Draft, Act with review, Act within limits | [Console design](../engine/hub-console/console-design.md), section 8 (ADR 010 decision 26 as proposed there) |

### The hub operating company: an AI operator team first, people as you grow

Owner direction of 2026-11-01 (relayed by the conductor): a person becomes a hub operator and launches a whole **company** around the hub, run from day one by a full AI operator team across every function, and adds human staff as it grows, developing quality and culture in the region. The design of that company, with presets per hub size, is being written in a parallel chapter, *The hub operating company* (`docs/engine/hub-operating-company.md`, not yet on `main`); this playbook uses the same idea and will link to the chapter once it exists. Until then the function names below are this playbook's working names, mapped to the agent roles that the editorial, discovery and console designs already define.

Every function has an **accountable human** from the first day, even when that human is the founder holding several functions: an agent role suspends when no accountable person remains, and every decision in [What always stays human](#what-always-stays-human) stays with a person at every size.

| Function | AI roles that run from day one (highest autonomy at launch) | Needs a local human first? | When to hire or assign a dedicated person |
|---|---|---|---|
| Editorial | Scout, Collector, Researcher, Writer, Fact-checker, Translator, SEO and metadata, Curator (Auto with review; guides Draft only) | **Yes**: an accountable editor-in-chief who knows the local industry and language (launch gate 5) | Day one (founder or partner editor); a second editor when output passes about 30 items a week or a second language goes live |
| Data and sourced pages | Scout, Collector, Resolver, Enricher, Page assembler, Watcher (Assisted) | Yes: a data steward who activates sources and accepts links | Founder at first; a dedicated steward when link and batch queues exceed about two hours a day |
| Outreach | Outreach drafter, Sender, Reply triager (off in `strict` mode) | Yes, and counsel: nothing is sent before an approved policy | Only if counsel approves a mode beyond `strict`; usually after go-live |
| Marketing and partnerships | Newsletter and social, Designer, Analytics reporter (Auto with review) | Yes: relationships with associations, training bodies and media are personal | Week 1 for the founder; a partnerships lead in the first growth stage |
| Community | Moderation triage (Draft), Newsletter and social (Auto with review) | Yes: a moderator who knows local norms and languages | Before soft launch (gate 6 needs the rules); a community manager when the first city has active groups |
| Events and learning | Researcher and Writer for event listings and course outlines (Draft only) | Yes: hosts, venues and trainers are local | Week 11 for the first event (founder or partner); an events lead in the first growth stage |
| Trust and safety, claims | Claim assistant, Trust and safety assistant (Draft) | **Yes**: a trust reviewer decides every claim; a different person decides appeals | Before soft launch; a second reviewer when claims exceed about 20 a week |
| Compliance and privacy | Sanctions review assistant (Draft), Licence checker (deterministic) | **Yes**: a compliance officer and external counsel | Day one (can be part-time or outsourced with a named person) |
| Support | Support triage (Act with review) | Yes for escalations and anything touching sign-in | Before soft launch; a dedicated agent when tickets exceed about 15 a day |
| Commerce and sales | Billing reconciliation (Draft); later the hub's offers and plans | Yes: prices and commissions need a commercial admin and a second person | Only when the hub charges anything; many hubs start free |
| Accounting | Billing reconciliation (Draft); bookkeeping exports | Yes: a local accountant for tax filings and e-invoicing of the operator's own fees | As soon as the operator entity exists (often outsourced) |
| Project management | Setup assistant (Draft) for the launch plan, gates and evidence packs | The founder | Founder; a launch manager for a multi-city rollout |
| Quality and standards | Fact-checker metrics, Accessibility checker, agent evaluations (Auto with review) | Yes: a practitioner reviewer for construction guides | Week 8 (seed guides) as paid or volunteer reviewers from partner bodies |
| Research | Researcher, Analytics reporter (Auto with review; reports Act within limits) | No for desk research; yes for interviews with practitioners (consent and ethics) | When the hub starts practitioner research (AGT-020 style studies) |
| IT operations | Operations monitor (Act with review: may open an incident, never engage a kill switch) | Yes: an ops engineer or a hosting partner for restores and incidents | Before soft launch (restore drill, gate 11); can be a contracted engineer |
| People operations and culture | None beyond drafting role descriptions and onboarding checklists (Draft) | Yes: hiring, contracts and culture are human | From the first hire; the founder sets the values (no fakes, evidence over advertising, privacy) |

The volume thresholds in the last column are rules of thumb (estimates), not measurements; adjust them to your hub.

**Presets by stage** (working names until the operating-company chapter defines its presets):

| Stage | People | AI operator team | Typical trigger to move on |
|---|---|---|---|
| Seed (founder-led) | One founder holding the hub owner, editor-in-chief and data steward roles, plus a second person with a distinct role (gate 4), external counsel and an accountant | Editorial, data, support triage, operations monitor, setup assistant, analytics; outreach off | Soft launch with real claims and weekly content |
| Growing | Add a trust reviewer, a moderator or community manager, a partnerships and events lead, a part-time ops engineer | Add claim assistant at higher volume, newsletter and social, moderation triage | Public launch; first partner city or a second language |
| Established | Dedicated editors per language, a compliance officer, a support lead, a commercial admin if the hub charges | Full roster within budgets; outreach only under an approved policy | Federation with neighbouring hubs; new city hubs on the same node |

### A launch run, step by step

| Step | Agent role does | A person decides | Typical autonomy at launch |
|---|---|---|---|
| Find sources | Scout proposes registers, portals, media, manufacturers with legal checks | Data steward activates | Assisted |
| Collect | Collector ingests within caps and windows | Auto-pause triggers need a person to resume | Supervised autonomous after week 3 |
| Resolve entities | Resolver proposes links with evidence (identifier match, name and address similarity) | Data steward accepts each link | Assisted |
| Enrich | Enricher adds cited fields (licence class, service area, products) | Spot checks; any uncited field is refused | Assisted |
| Assemble sourced pages | Page assembler builds pages and batches | Data steward activates a batch | Assisted |
| Write and translate | Writer, Translator, Fact-checker, SEO and metadata | Editor approves each item; translations reviewed per language policy | Auto with review |
| Seed guides | Researcher and Writer draft plan-step guides from licensed sources and partner material | Accountable editor and a practitioner reviewer approve | Draft only |
| Prepare claims | Claim assistant prepares a reviewer's checklist: register lookups, domain match, screening references | Trust reviewer decides every claim | Draft |
| Outreach (if allowed) | Outreach drafter builds audiences and messages; Sender dispatches approved touches; Reply triager applies objections | Counsel-approved policy, second person activates; a person approves batches | Strict (none) by default |
| Watch | Watcher refreshes licence expiries, closed companies, dead links | Staff review before unpublishing | Supervised autonomous |
| Report | Analytics reporter publishes weekly cohort counts | Hub owner reads | Act within limits |

### What no agent ever does

Publish without a person's approval (except an editorial class under an active, signed standing policy), activate a source or dataset, accept a link, decide a claim, confirm or clear a sanctions match, send outreach outside an approved campaign version or to a suppressed or ungated recipient, retry an unknown outcome blindly, release money, change prices, engage or release a kill switch, or act on instructions found in fetched text. These are engine guard rails ([Hub administration: guard rails](../engine/hub-administration.md#guard-rails-that-no-console-can-switch-off)).

## Phase 5: claims and outreach

**Claims.** A company claims its sourced page through the hub's verification recipe: *claimed* needs a verified login and one tie to the company (a code to an e-mail on the company's domain, or a reviewer-recorded officer match); *verified* needs the register record active and matching, plus a signatory tie (a qualified electronic signature, an authority letter signed with it, or a call-back to the phone from the register), plus sanctions screening ([reference recipes](../engine/hub-administration.md#reference-recipes-for-the-example-countries)). An uploaded register extract or a registration number alone proves nothing.

**Informal workers and sole traders.** In most launch countries the people doing the work have no registered company. Until the informal-sector reputation path lands (REP-003, proposed), they can still create a personal profile and build a portfolio confirmed by clients of real tasks (REP-001, TASK-001); sourced pages are never created about them.

**Outreach.** The default in every hub is the strict rule: "Contact obtained from a public source; outreach without consent is not permitted" (`commerce.supplier.outreachNote`). A hub may move to:

| Mode | What it allows | Before you switch it on |
|---|---|---|
| `strict` | No messages to non-participants; pages stay sourced; anyone can claim | Nothing: this is the default |
| `notice_only` | One page notice per entity ("a page about your company was created from public sources; correct, claim or remove it"), organisation and role addresses only, e-mail only | Counsel approval per jurisdiction, a second person, the country's `outreachLaw` facts |
| `governed` | Notice plus one claim invitation reminder, within caps, quiet hours, suppression, identification and opt-out rules | Counsel approval, a second person, a legitimate-interest assessment or consent basis where the law needs one |

The engine floor no hub can lower: no consumer outreach; no automated calls, AI voices, SMS or messenger outreach without the person's recorded prior consent; no guessed addresses; every message identifies the operator and names its sources; one-click unsubscribe; at most three touches per purpose, ever ([Discovery and outreach](../engine/discovery-and-outreach.md), section 8). The country playbooks give the suggested first mode after counsel for each country; in most of them it is `strict`, and the hub grows through partners, events, content and invitations from participants instead.

**Lawful ways to grow without outreach**, used in every country playbook: partner associations announce the hub to their members; training bodies give graduates a way to publish their certificates; events and site visits; useful content that people share in their own messaging groups; companies invite their own colleagues and clients; buyers invite their own suppliers to an RFQ (within the buyer's quota and the hub policy); and a visible "Is this your company? Claim it" on every sourced page.

## Phase 6: compliance gates

### The engine's launch checklist

The engine refuses to switch a hub to `public` until every gate is green; soft launch needs the first six plus `demo_data_purged` and `ai_egress_policy_reviewed` ([Hubs: launch checklist](../engine/hubs.md#launch-checklist)):

1. Operator legal entity recorded and screened.
2. Terms, privacy notice and sanctions section approved by counsel, with date and version, in every hub language.
3. Data-residency decision recorded and storage configured accordingly.
4. At least two staff with distinct roles, each with a second factor.
5. Editorial team with an editor-in-chief; editorial policy published.
6. Community rules in every hub language; moderation clause library mapped to local law.
7. At least one information source registered with licence flags.
8. A company verification recipe enabled (real or "manual review only").
9. Sanctions screening configured (baseline plus national lists).
10. Every template and dictionary complete in every hub language.
11. Backup and restore exercised once, with evidence.
12. Accessibility check of the brand overlay passed.

### Country gates to add (recorded by the operator, checked by counsel)

| Gate | Typical requirement | Examples in the playbooks |
|---|---|---|
| Data protection registration | Register as controller or appoint a data protection officer | Kenya ODPC, Nigeria NDPC, Ghana DPC, Rwanda NCSA, Philippines NPC, Colombia RNBD where thresholds apply, Peru ANPD, Uzbekistan State Register of Personal Data |
| Residency | In-country storage or an authorisation | Uzbekistan, Rwanda |
| Platform and e-commerce rules | Marketplace duties, merchant identification, complaint handling | Philippines Internet Transactions Act; consumer protection authorities everywhere |
| Outreach law | `outreachLaw` facts approved by counsel before any mode other than `strict` | Every country |
| Agent disclosure | Wording that tells people an automated assistant acted | HUB-005 settings per jurisdiction |
| Tax on the hub's own fees | VAT or sales tax registration, e-invoicing for the operator's own invoices if it charges | Every country that charges fees |
| Sanctions and national lists | National lists the operator must apply in addition to the baseline | Each country's financial intelligence unit |

## Phase 7: soft launch and go-live

| Stage | Entry criteria | What happens |
|---|---|---|
| `draft` → `preparing` | Wizard finished | Configuration, pack and sources; demo data only |
| `preparing` → `soft_launch` | First six gates, `demo_data_purged`, `ai_egress_policy_reviewed` | Invite-only: partner members, champions, editors, companies that asked to claim; real content and real claims; no fake activity |
| `soft_launch` → `public` | Every gate green, counsel sign-off on the country gates, the operator's switch | Anyone may join; search-engine indexing on for public projections; federation peering |

Keep soft launch long enough to prove claims, moderation, support and backups with real people (four to eight weeks in the 90-day template).

## Phase 8: operations

| Rhythm | What | Who |
|---|---|---|
| Daily | Review queues (editorial, imports, links, claims), incidents, source auto-pauses | Editors, data steward, trust reviewer, ops |
| Weekly | Magazine issue; cohort report; outreach health if enabled (objections, bounces); licence expiry watch | Editor-in-chief, hub owner |
| Monthly | One event or site visit; partner meeting; sanctions list freshness; restore drill on schedule; review of agent budgets and evaluations | Hub owner, ops, compliance officer |
| Quarterly | Counsel review of policy changes; accessibility check; review status of translations; pack updates | Compliance officer, editors |

Kill switches exist per agent role, per campaign, for all outreach, per model and per provider. Engaging one is one click; releasing needs a second person and an incident note.

## The first 90 days, week by week

A template built around the operator team: in every week the table says which functions the AI operator team runs (with autonomy) and which humans must be in place. Each country playbook adapts it with its own sources, partners, gates and calendar (holidays, rainy seasons, fiscal year).

| Week | Goal | AI operator team: functions and autonomy | Humans in place or hired this week |
|---|---|---|---|
| 1 | Decisions and counsel | Project management: Setup assistant drafts the decision record and evidence pack (Draft); Research: Researcher drafts the market brief (Auto with review) | Founder (hub owner); counsel engaged; accountant for the operator entity |
| 2 | Country pack and language | Research: Researcher drafts pack facts with sources (Draft); Editorial: Translator pre-translates missing strings (Draft) | Pack maintainer review; translator or native reviewer |
| 3 | Install and wizard | IT operations: Operations monitor (Observe) | Second staff member with a distinct role (gate 4); contracted ops engineer |
| 4 | Sources | Data: Scout proposes the source inventory with legal checks (Assisted); Compliance: Licence checker (deterministic) | Data steward (founder or hire) activates the first 10 to 20 sources |
| 5 | Registers and datasets | Data: Collector and Resolver run the first register imports (Assisted) | Compliance officer approves datasets |
| 6 | Sourced pages | Data: Page assembler builds the first batch (Assisted) | Data steward activates batches |
| 7 | Newsroom | Editorial: Writer, Fact-checker, Translator, SEO (Auto with review) | Editor-in-chief approves; editorial policy published (gate 5) |
| 8 | Guides per plan step | Editorial: Researcher and Writer draft seed guides (Draft only); Quality: Accessibility checker | Practitioner reviewers from partner bodies (quality and standards) |
| 9 | Legal texts and gates | Project management: Setup assistant prepares gate evidence (Draft); IT operations: restore drill support | Counsel approves texts (gate 2); ops engineer runs the restore drill (gate 11) |
| 10 | Soft launch | Trust: Claim assistant (Draft); Support: Support triage (Act with review); Community: Moderation triage (Draft) | Trust reviewer and moderator in place; hub owner switches to `soft_launch`; partners invite members |
| 11 | First claims and first event | Data: Watcher (Supervised autonomous); Marketing: Newsletter and social (Auto with review); Events: listings drafted (Draft only) | Events lead or partner host runs the first meetup or site visit |
| 12 | Review | Research: Analytics reporter publishes cohort counts (Act within limits) | Hub owner and partners review KPIs; decide the first growth hires |
| 13 | Go-live decision | Project management: Setup assistant compiles the go-live evidence pack (Draft) | Owner and counsel approvals; switch to `public`, or extend soft launch; hire per the growing preset |

## Seed content plan

People come back for useful content. Seed the hub with knowledge that maps to the plan-step taxonomy (`data/taxonomy`, CC0), so each step of a participant's plan finds something useful from day one ([plan-step recommendations](../engine/hub-console/autonomous-editorial.md#plan-step-recommendations)).

| Plan stage (taxonomy id) | Seed guides to commission (adapt per country) |
|---|---|
| `stage.define` | How to describe your project; budget ranges and what drives them; building in stages over several years |
| `stage.site_and_feasibility` | Land title and plot checks; soil and drainage basics; access to water and power |
| `stage.design` | When you need an architect or engineer; reading a drawing; earthquake, typhoon or flood considerations where relevant |
| `stage.permitting` | The local permit path, documents and fees (from the country's taxonomy jurisdiction file); what an inspection checks |
| `stage.contracting` | Choosing a contractor; checking a licence or registration; written agreements; milestone payments and deposits |
| `stage.site_preparation` to `stage.structure` | Foundations, concrete quality and curing, block and brick work, reinforcement; common mistakes and how to spot them |
| `stage.envelope` to `stage.exterior_finishes` | Roofing, waterproofing, windows, plaster and finishes for the local climate |
| `stage.rough_in`, `stage.systems_finish` | Electrical and plumbing safety; licensed trades where required |
| `stage.final_inspections`, `stage.handover` | Snag lists, warranties, keeping records (home passport, HOME-001) |

Sources for seed guides, in order of preference: the hub's own reporting with practitioners; open-licence material from regulators, standards bodies and development programmes; partner material under a written licence; manufacturers' technical guides used within their licence and labelled; never copied text from all-rights-reserved sources.

## What always stays human

| Decision | Who |
|---|---|
| Activating sources and datasets | Data steward (second person for personal data) |
| Publishing, magazine release | Editor; editor-in-chief |
| Claim and verification decisions; appeals | Trust reviewer; a different reviewer for appeals |
| Sanctions match decisions, holds | Compliance officer with a second person |
| Legal texts, outreach policy, data residency, providers, prices | Counsel and a second staff member |
| Kill switches release, incidents | Ops engineer with a second person |
| Going public | The hub owner, after counsel |

## Costs

All numbers below are **estimates under stated assumptions**, not quotes. Replace them with real quotes before budgeting. Trustwork itself is free software; the costs are infrastructure, models, messaging, people and counsel.

| Line | Assumption | Estimated range per month | Notes |
|---|---|---|---|
| Hosting (soft launch) | Managed platform with web, API, worker, PostgreSQL, object storage, backups; low traffic | USD 50 to 300 | Proposed managed hosting in an approved residency region; deployment and these indicative costs were not verified by this design review |
| Hosting (public, first year) | Same plus a staging copy and point-in-time recovery | USD 300 to 1,500 | In-country hosting where residency requires it (Uzbekistan, Rwanda) may cost more; get local quotes |
| Models: editorial pipeline | 50 items a day; about 20,000 input and 3,000 output tokens per item across collect, summarise, fact-check, metadata; translation into one more language adds about half | USD 75 to 400 | Computed with an assumed route price of USD 1 to 5 per million input tokens and USD 5 to 25 per million output tokens; check your provider's current prices |
| Models: sourced pages (one-time) | 20,000 entities; about 10,000 input and 1,000 output tokens each for extraction and enrichment | USD 300 to 1,500 once | Deterministic parsing of structured registers needs no model at all and should be preferred |
| E-mail | Transactional mail through a provider | USD 0 to 50 | Outreach (if any) on a separate sending identity |
| SMS, WhatsApp, USSD | Verification codes for phone accounts; consented notifications | Obtain quotes | Per-message prices differ by country and provider; strict outreach mode sends no marketing messages |
| Register and data access | Most registers used here are free to search; some charge per search or extract | Obtain quotes | Budget a manual-lookup allowance for claims |
| People | Accountable editor, data steward, trust reviewer, compliance officer, support; part-time at first | 1.5 to 3 full-time equivalents in the first 90 days (estimate) | The largest cost; partners can share editorial and verification work |
| Counsel | Initial review of terms, privacy, outreach, agent disclosure, platform and consumer rules | Planning placeholder only: obtain fixed-fee quotes | Required before soft launch |

## KPIs without surveillance

Measure the hub, never individuals ([Analytics](../engine/modules/analytics.md), [vision](../engine/vision.md#how-we-will-know-it-works)). Cohorts below a minimum size are suppressed.

| Area | KPI | Healthy direction |
|---|---|---|
| Sources | Active sources with complete legal checks; auto-pauses resolved within a week | Up; fast |
| Sourced pages | Pages with full field provenance; corrections and takedowns resolved and their median time | 100 percent; fast |
| Claims | Claims started, decided, verified; median days to decision; appeals upheld | Up; down; low |
| Content | Published items per week by treatment; corrections published; share of AI-assisted items labelled | Steady; visible; 100 percent |
| Plans | Plan steps with at least one verified recommendation or guide (coverage per stage) | Up |
| Participation | New members per week by kind; companies with at least one confirmed portfolio entry; consultations and tasks completed | Up |
| Return | Aggregate share of members returning within 30 days (cohort counts only) | Up |
| Trust | Complaints, moderation cases and their resolution time; outreach objections if outreach is enabled | Low; fast |
| Inclusion | Share of profiles with a worker credential from a training body; women's participation where members choose to share it (optional, aggregate) | Up |
| Cost | Cost per published item; model and messaging spend against budgets | Down; within caps |

No per-person engagement profiles, no open-tracking pixels, no productivity dashboards.

## Risks every launch shares

| Risk | Mitigation in the engine and the playbook |
|---|---|
| Fake or impersonated companies claim pages | Recipes with register match and signatory tie; disputes and takeover protection; sanctions screening |
| Outreach complaints or regulator action | `strict` default; counsel-approved `outreachLaw`; suppression ledger; caps and kill switches |
| Copyright or licence breach in news and guides | Licence-driven treatments; similarity checks; takedown flow |
| Model errors in published text | Fact-check step; human approval; visible corrections |
| Exposing site locations or values that help extortion or theft | Coarse public locations (ADDR-001); no active-site addresses on public pages |
| Payment fraud | Licensed providers only; payee bank-detail waiting period; screening gates |
| Low connectivity and old phones | Low-bandwidth pages, offline drafts, SMS, WhatsApp and USSD channels (MOB-001, CHAN-001, CHAN-002) |
| Single point of human failure | Two staff with distinct roles; second-person rules; accountable person per agent role |
| Political or security shocks | Hub lifecycle `suspended` state; data export for participants; federation tombstones |

## Approvals before going live

Each country playbook ends with the exact list for its country. The template:

| Approval | By | Evidence recorded |
|---|---|---|
| Operator entity and deployment-location attestation | Operator, screened | Wizard step 4 |
| Terms, privacy notice, sanctions section, imprint, community rules | Counsel | Launch gate 2 with version and date |
| Data residency and hosting | Compliance officer, second person; counsel where the law requires | Residency configuration version |
| Data protection registration | Operator | Registration number recorded |
| Outreach mode and `outreachLaw` facts (if not `strict`) | Counsel, second person; on the reference hub also the owner | Outreach configuration version |
| Agent disclosure and liability wording (HUB-005) | Counsel | Jurisdiction settings version |
| Each live provider (mail, SMS, payments, models, registers) | Second person after a synthetic test | Provider activation records |
| Datasets with personal data | Compliance officer and a second person | Dataset activation |
| Prices and commissions (if any) | Commercial admin and a second person; public disclosure | Price version |
| Switch to `public` | Hub owner | Lifecycle transition with all gates green |
| Use of the Trustwork name and any brand overlay | Per [BRAND.md](../oss/BRAND.md) | Brand configuration |

For a hub operated by Contribuda or Contribuddha, the repository owner's explicit approval is also required before real sign-ups open, as for the reference hub.

## Country playbooks

Ranked by the [scorecard](../research/top-10-launch-countries-2026-11.md#scorecard). Each playbook is a deep dive plus a launch plan.

| Rank | Country | Playbook | Score (estimate) | Live interface language | Country pack |
|---|---|---|---|---|---|
| 1 | Peru | [pe.md](countries/pe.md) | 85 | Spanish | Proposed CTRY-PE |
| 2 | Philippines | [ph.md](countries/ph.md) | 84 | English | Proposed CTRY-PH |
| 3 | Kenya | [ke.md](countries/ke.md) | 81 | English | Proposed CTRY-KE |
| 4 | Ghana | [gh.md](countries/gh.md) | 80 | English | Proposed CTRY-GH |
| 5 | Colombia | [co.md](countries/co.md) | 80 | Spanish | Proposed CTRY-CO |
| 6 | Dominican Republic | [do.md](countries/do.md) | 78 | Spanish | Proposed CTRY-DO |
| 7 | Uzbekistan | [uz.md](countries/uz.md) | 75 | Uzbek (Latin), Russian | Live (v2) |
| 8 | Nigeria | [ng.md](countries/ng.md) | 73 | English | Proposed CTRY-NG |
| 9 | Mexico | [mx.md](countries/mx.md) | 72 | Spanish | Implemented CTRY-MX (#381) |
| 10 | Rwanda | [rw.md](countries/rw.md) | 72 | English | Proposed CTRY-RW |

Not in the ten but ready to use this playbook: South Africa (deep dive and Cape Town plan in the companion market scan, [pull request #370](https://github.com/Contribuda/trustwork/pull/370)), Georgia (pack and language live), Ecuador and Guatemala (Spanish, daily OCDS), Tanzania (after Swahili, LANG-SW).

## Feature gaps and the packages that close them

Found while studying the ten countries and added to [work-packages.json](../engine/work-packages.json) (open; `node scripts/work-packages.mjs show <ID>` for any of them).

| Gap | Countries | Package |
|---|---|---|
| Country packs with sourced facts and taxonomy permit answers | Peru, Philippines, Kenya, Ghana, Colombia, Dominican Republic, Nigeria, Rwanda | CTRY-PE, CTRY-PH, CTRY-KE, CTRY-GH, CTRY-CO, CTRY-DO, CTRY-NG, CTRY-RW (CTRY-MX amended) |
| Languages | Kenya and East Africa; Philippines; Nigeria; Rwanda | LANG-SW, LANG-FIL, LANG-HA, LANG-YO, LANG-IG, LANG-RW |
| Mobile money and instant-payment adapters behind the payment port | All ten | PAY-003; PAY-001 amended for asynchronous push-to-phone authorisation |
| USSD and feature-phone access | Kenya, Ghana, Nigeria, Rwanda, Philippines | CHAN-002 |
| Phone-number accounts (sign-up and recovery without e-mail, with SIM-swap protection) | All ten | ACCT-001 |
| Low-bandwidth public pages | All ten, especially Kenya, Nigeria, Rwanda | MOB-001 amended |
| Informal addresses and coarse public locations | Ghana, Kenya, Nigeria, Rwanda, Philippines, Peru | ADDR-001 |
| Informal-sector reputation path for workers without a registered company | All ten | REP-003 |
| Progressive (incremental) building plans | Peru, Mexico, Colombia, Philippines, Kenya, Nigeria, Ghana | PLAN-004 |
| Remote owner oversight with a delegated local representative (diaspora-funded homes) | Philippines, Mexico, Dominican Republic, Nigeria, Ghana, Colombia | PLAN-005 |
| Contractor and professional register connectors | All ten | REG-002 |
| OCDS tender adapters for the launch countries | Peru, Kenya, Ghana, Colombia, Dominican Republic, Nigeria, Mexico, Rwanda | PROC-003; PROC-002 amended |
| National digital ID verification through licensed verifiers only | Ghana, Philippines, Nigeria, Kenya, Uzbekistan, Peru | IDV-001 amended |
| Launch kits: per-country source lists and hub presets imported as proposals | All countries | LAUNCH-001 |

## Where to read more

- [Vision](../engine/vision.md), [What works today](../engine/status.md), [Concepts](../engine/concepts.md)
- [Hubs](../engine/hubs.md), [Hub administration](../engine/hub-administration.md), [The hub console](../engine/hub-console/README.md), [Setup wizard](../engine/hub-console/setup-wizard.md)
- [Autonomous editorial office](../engine/hub-console/autonomous-editorial.md), [Local data mining](../engine/hub-console/data-mining.md), [Automation and scheduling](../engine/hub-console/automation-and-scheduling.md), [Keys, providers and models](../engine/hub-console/providers-and-models.md)
- [Country specifics](../engine/country-specifics.md), [Countries and languages](../engine/localization.md), [How to add a country](../country-packs/how-to-add-a-country.md)
- [Federation](../engine/federation.md), [Security, trust and privacy](../engine/trust-safety-privacy.md), [ADR 014: sanctions](../adr/014-sanctions-compliance-engine.md)
- [Guide for hub operators](../guides/hub-operator.md), [Roadmap](../engine/roadmap.md)

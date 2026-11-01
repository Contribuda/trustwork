# Agent catalogue: representative agents for every participant

Normative requirements: [The agent and its runtime](modules/agent.md), [The capability registry](capability-registry.md). Participants: [who uses what](participants/README.md).

Requirements R09–R11, R19, R20, R29, R32–R35. Status: **Proposed** in full (2026-10-30, the flagship capability of the engine; extended by owner decisions of 2026-10-31: United States reference hub, plan to people, reputation building, plan-step knowledge from manufacturers and suppliers). It builds on what is already **Contract** (mandates, approvals, action states, external outcomes, reconciliation in [`packages/contracts/src/assistant.ts`](../../packages/contracts/src/assistant.ts); budgets and price versions in `billing.ts`) and **Designed** (the durable runtime, AST-001). Nothing in this chapter runs today. Proposed work packages are listed at the [end](#proposed-work-packages).

[Your agent](agents.md) explains what an agent is, how authority works and what keeps it safe. This chapter is the catalogue: **what the agent actually does for each kind of participant**, packaged as modules, metered and priced by the hub, reachable from the participant's own external agent, and shown on one assistant surface. Two flagship journeys lead it: [from plan to people](#flagship-journey-from-plan-to-people), where anyone's project becomes a plan and the plan becomes requests to the right experts and trades, and [build and confirm your own reputation](#flagship-build-and-confirm-your-own-reputation). Examples use the United States reference hub (owner decision 2026-10-31); every country-specific behaviour is hub configuration.

## Contents

1. [What does not change](#what-does-not-change)
2. [Vocabulary](#vocabulary)
3. [Anatomy of a job](#anatomy-of-a-job)
4. [Flagship journey: from plan to people](#flagship-journey-from-plan-to-people)
5. [Flagship: build and confirm your own reputation](#flagship-build-and-confirm-your-own-reputation)
6. [Procurement and supply](#procurement-and-supply-proposed): every procurement operation as an agent capability
7. [The module system](#the-module-system), including [country-specific configuration](#country-specific-behaviour-is-configuration)
8. [Metering, quotas and hub pricing](#metering-quotas-and-hub-pricing)
9. [Catalogue by participant](#catalogue-by-participant)
10. [How agents meet: interaction patterns](#how-agents-meet-interaction-patterns)
11. [One assistant surface for every participant](#one-assistant-surface-for-every-participant)
12. [Connect your own agent: MCP and A2A](#connect-your-own-agent-mcp-and-a2a)
13. [Data model and contract additions](#data-model-and-contract-additions)
14. [Safety](#safety)
15. [Open questions for the owner](#open-questions-for-the-owner)
16. [Proposed work packages](#proposed-work-packages)

## What does not change

The catalogue adds breadth, never authority. Every rule of [Your agent](agents.md) holds for every job below, and each job was checked against them:

| Invariant | Consequence for the catalogue |
|---|---|
| One person, one agent; one company, at most one standing representative with an accountable person | Modules are **abilities of the one agent**, never separate bots. There is no screen listing agents, no per-module agent identity and no agent marketplace. An external agent a person connects is a **connection** of their one agent, not a second agent |
| Authority only from structured, revocable mandates; never above the principal's current rights | Every job names the mandate it needs. A module may **propose** a mandate (a template); it is inert until the person confirms the structured form |
| Chat text never authorizes | Neither does a call from a connected external agent: it can propose, and act only inside mandates confirmed on the first-party surface |
| Untrusted input never issues commands | Files, mail, web pages, imported source items, other agents' notes and external agents' free text inform drafts only |
| Commitments need budgets; unknown outcomes are reconciled | Transaction budget for buying from participants; platform budget for agent usage beyond the free quota; `outcome_unknown` is never retried blindly |
| Private stays private | Floors, ceilings, private priorities, private projects and negotiation notes never enter envelopes, shared threads, other parties' agents, search, notifications, exports, other hubs or the hub's statistics |
| Payment never changes ranking, matching or reputation | Paid modules buy capacity and automation for the payer's own work, never reach, position, earlier visibility or a badge ([fairness rules](#what-money-can-never-buy)) |
| No fakes, no surveillance | Agents never write reviews, invent offers or impersonate humans; KPIs are private to the principal; no per-employee productivity view exists |
| Restricted places | No job targets, serves or routes through a restricted place; screening runs before the first commercial message |

## Vocabulary

| Term | Meaning in this chapter |
|---|---|
| **Agent** | The person's single assistant, "Assistant" in the English interface (`assistant.title`; every language from the locale files, never hard-coded). |
| **Standing representative** | The company's single agent ([Company representation](agents.md#company-representation)). |
| **Participant type** | A **lens for suggestions** (supplier, homeowner, editor…), derived from optional onboarding preferences and what the person actually does. It is never a role, confers no rights, is never shown to others and can be changed or cleared at any time. A person often fits several types; the agent combines them. |
| **Module** | A versioned, engine-defined package of capability: job templates, the actions and tools it needs, mandate templates, triggers, report sections, meters and its safety tests. Enabled per hub, entitled per payer. |
| **Job** | A recurring kind of work the agent does ("answer RFQ invitations in my categories"). A job runs as **runs** and proposes **action intents**. |
| **Mandate template** | A pre-filled mandate a module proposes for a job. It becomes a mandate only when the principal (or for a company, an authorized member) confirms it in the structured form. |
| **Standing mandate** | A mandate whose contexts are a **selector** ("RFQ invitations in category Facade works in region US-TX") rather than a fixed list of ids; each action it authorizes records the concrete context it resolved to. Proposed contract addition ([below](#mandate-v2)). |
| **Trigger** | What starts a run: a schedule, a domain event, a goal step, a deadline, or the principal's request. |
| **Report** | A periodic or on-demand summary the agent drafts for its principal; private unless the principal shares it. |
| **KPI** | A measure the principal sees about their own results, computed only from records they may see. |
| **Connection** | A registered external agent or system (Claude, ChatGPT, a custom agent, an ERP) that acts **through** the person's agent under scoped tokens bound to mandates. |

## Anatomy of a job

Every job in the catalogue is specified with the same eight parts, so that implementers, reviewers and hub operators read them the same way.

| Part | What it states |
|---|---|
| **Goal it serves** | The outcome the principal typically asks for |
| **Module** | Which module packages it |
| **Trigger** | `schedule` (in the principal's time zone), `event` (named domain event), `goal` (step of an active goal), `deadline`, or `request` |
| **Mandate** | Actions · contexts or selector · limits · conditions · budget · approval policy · escalation |
| **Never** | What the job must not do even with a mandate |
| **Agent-to-agent** | Which envelope intents it sends or receives |
| **Output** | Drafts, action intents, decisions waiting, report sections |
| **KPI** | What the principal measures |

### Mandate notation

Job tables use a compact mandate line:

```text
actions | contexts or selector | limits and conditions | budget | approval
```

For example `send_quote | invitations: cat Facade works, region US-TX | catalogue lines only, ≤ USD 250,000 per quote, counterparty claimed+ | — | ask above USD 50,000`.

Approval policies (proposed, [contract](#mandate-v2)):

| Policy | Meaning |
|---|---|
| `ask_each` | Every action becomes a decision waiting; approval binds the action digest |
| `ask_first(n)` | The first *n* actions are approved one by one; afterwards the mandate is pre-authorized. Any material change of the mandate restarts the count |
| `ask_above(amount)` | Pre-authorized up to the amount; above it, approval |
| `pre_authorized` | No confirmation within limits ([rule 5](agents.md#authority-mandates)) |
| `human_only` | The action class can never be pre-authorized; the engine forces `ask_each` regardless of what a mandate says |

Escalation when a condition cannot be evaluated or is missing: `ask_principal`, `ask_person(id)` (a named colleague who holds the right), or `stop`. A condition written as free text is **display-only**: the engine cannot evaluate it, so any action under it falls back to `ask_each`.

### Action vocabulary v2 (Proposed)

The frozen vocabulary (`prepare`, `research`, `communicate`, `send_quote`, `negotiate`, `place_order`, `accept_order`, `generate_deliverable`) covers commerce. The catalogue needs a few more verbs so that quotas, approvals and kill switches can target them precisely instead of hiding everything under `communicate`:

| New action | Covers | Default approval | Budget |
|---|---|---|---|
| `introduce` | Request, accept or decline an introduction; express interest in a need | `ask_first(3)` | — (quota-bound) |
| `schedule` | Propose, accept or move a meeting slot (events, site visits, calls inside a context) | `ask_each` for accept, pre-authorizable for propose | — |
| `maintain_profile` | Apply revisions to the principal's own capability profile, portfolio entries and availability | `ask_each` for public fields, pre-authorizable for private fields | — |
| `publish` | Publish a version the principal authors: publication, catalogue offering, open need, partner post, event, course version | `ask_each`; hub may forbid pre-authorization per format | — |
| `register` | Register for an event or enrol in a course, including colleagues the principal may register | `ask_above(0)` for paid, pre-authorizable for free | transaction |
| `record_evidence` | Attach execution evidence and submit an assertion (delivered, performed, defect, remediation) | `ask_first(5)` | — |
| `confirm_execution` | Confirm or dispute a counterparty's assertion | **`human_only`** | — |
| `approve` | Decide an approval step in a company approval route (requisition, award, order, invoice, payment proposal, document, substitution, budget change, payee change) or clear a payment risk signal ([Procurement and supply](procurement-and-supply.md#approval-routes)) | **`human_only`** | — |
| `release_payment` | Release approved payment instructions to the hub's licensed payment provider, or record a payment made outside the platform | `ask_each`; a hub may allow `ask_above` for matched, approved invoices to payees unchanged for 90 days; never pre-authorized during a payee's cooling-off period or with an open risk signal | transaction |
| `maintain_records` | Apply changes to the company's own internal procurement records: supplier base, allocations, cost codes, stock movements, invoice capture, settings drafts | `ask_first(5)`; write-offs and supplier blocks `ask_each` | — |

Confirmation of execution is `human_only` because it feeds reputation ([Execution and reputation](execution-and-reputation.md)); an agent prepares it with the evidence, a person decides. Other `human_only` classes: accepting a price version or legal terms, anything requiring step-up, submitting to an official public procurement portal, and every staff decision listed under [hub staff](#15-hub-operator-staff).

Contexts gain the kinds `introduction`, `open_need`, `partner_post`, `event`, `course`, `publication`, `profile`, `catalogue_offering`, `order`, `opportunity` (an imported public procurement notice) and `company`.

## Flagship journey: from plan to people

Owner addition 2026-10-31. Trustwork is also a place where people share experience and teach each other. The flagship journey shows every principle of this chapter at work: **anyone launches a project, their agent turns the idea into a clear plan, and the plan becomes requests to the right people**, for advice and for execution, with the agents of both sides doing the routine work and people making the decisions. Finished projects, with the owner's consent, teach the next ones.

Five modules carry it: [`project_planner`](#project-planner), [`plan_step_companion`](#plan-step-companion), [`consultation`](#consultation), [`task_marketplace`](#task-marketplace) and [`knowledge_sharing`](#knowledge-sharing). They reuse the engine's existing objects (projects, needs, RFQ and quote versions, agreements, orders, execution evidence, publications, events, introductions) rather than inventing a parallel marketplace.

### The journey

```text
idea ("build a 2,000 sq ft house on my lot near Austin")
  → project (private, owned by the person or company)
  → plan v1: phases, tasks, trades and expertise, materials, permits and inspections,
             budget ranges, timeline, risks, decision points, in plain language
  → for every step: explained recommendations of products, guides, training, events, consultants
  → per plan item, the owner chooses:
      consultation  (advice session, review of drawings or quotes, site visit)  → expert
      execution     (scoped task or work package)                              → contractor or trade
      do it myself  (with a checklist from the knowledge base)
  → agents of both sides: find, propose, quote, schedule, negotiate within mandates
  → agreements, milestones, evidence, payments
  → plan v2, v3…: progress and changes with reasons
  → completion → with consent: project diary, lessons learned, checklists, templates, mentoring
```

The same journey serves a homeowner building a house, a small developer building four townhouses, and a company planning a facade retrofit. Only the scale of the plan and the mandates differ.

### Project planner

**What it produces.** A **plan** attached to a project, versioned (each shared or accepted version is immutable, like RFQ versions):

| Plan part | Content | Source discipline |
|---|---|---|
| Phases and tasks | Site preparation, foundation, framing, roofing, MEP rough-in, inspections, finishes…; dependencies between tasks | Plan templates from the knowledge base and the owner's answers |
| Trades and expertise | Which trades each task needs (excavation, concrete, framing, roofing, electrical, plumbing, HVAC) and where an expert's advice helps (structural engineer, architect, energy rater) | Hub taxonomy |
| Materials | Main materials and quantities with units and uncertainty | Owner inputs, drawings parsed with evidence per line |
| Permits and inspections | What permits and inspections the jurisdiction usually requires, and in which order | **Hub jurisdiction facets** (for the US hub: county and city building departments as configured); unknown stays unknown and the plan says "ask your building department" |
| Budget ranges | Low–high per phase with the basis named | Only public, licensed cost sources the hub registered and the owner's own quotes; **never** other participants' private quotes or agreements |
| Timeline | Durations as ranges; weather and holiday calendars from the hub | Hub calendar facets |
| Risks | For example soil conditions, long-lead items, inspection failures, cost overruns | Templates and lessons learned, cited |
| Decision points | Where the owner must choose (design, contractor, materials, go/no-go) | Become decisions waiting at the right time |

Everything is explained in plain language in the owner's language (English or Spanish on the US hub) with a "why" for each item and citations for facts. The plan is **advice, not professional engineering or legal advice**, and says so: where the jurisdiction requires a licensed professional (for example stamped structural drawings), the plan creates a consultation or execution item for one.

| Job | Trigger | Mandate |
|---|---|---|
| Draft plan from the idea | request | `prepare` \| own project \| — \| platform budget beyond the free plan quota \| — |
| Re-plan after a change | event: `change.recorded`, `quote.received`, `inspection.failed` | `prepare` \| own project \| change records name the reason \| — \| new plan version `ask_each` |
| Turn a plan item into a request | decision per item | `publish` (need or RFQ) or `introduce` \| that plan item \| shares only the fields the owner chose \| — \| `ask_each`; `ask_first(3)` once the owner trusts it |
| Progress and payment tracking | schedule: weekly; event: milestone and obligation events | `communicate`, `record_evidence` \| project agreements \| — \| — \| reminders `pre_authorized` |

**Privacy of a private project.** The project and its plan are `owner_private` by default. Each request created from a plan item is a **projection** the owner reviews before it leaves:

| Audience | Sees |
|---|---|
| The public (needs board), if the owner publishes the item | Trade, scope summary, city or county (never the street address), timing window |
| Invited experts or contractors | The task brief: scope, drawings the owner attached to that item, quantities, schedule; budget range **only if** the owner chooses to disclose it |
| After an accepted introduction or agreement | Address, contact details, site access notes for that item |
| Participants of other items | Nothing about other items unless the owner adds them to the project with a grant |
| Hub staff | Nothing, except under a case grant |
| Knowledge base | Nothing until the owner consents at the end, field by field |

### Consultation

A consultation is a **service offering** in the expert's catalogue, bought like any service and delivered with evidence. It is how practitioners share experience and earn from it.

| Kind | Delivered as | Typical deliverable |
|---|---|---|
| Advice session | Video call or chat inside the consultation context, or phone through a channel grant | Written advice note |
| Review of drawings | Asynchronous review of attached files | Marked-up drawings and a findings list |
| Review of quotes | Asynchronous review of quotes the owner chose to share **with that expert only** | Comparison note: exclusions, risks, questions to ask |
| Site visit | In person, scheduled | Visit report with photographs |
| Mentoring | A series of sessions under one agreement | Session notes, goals |

- **Offerings and prices.** The expert publishes consultation offerings (fixed price, per hour, or free) as catalogue offering versions with price versions; a booking pins the exact versions, like a quote does. Free consultations are welcome and use the same flow without payment.
- **Booking.** Request → the expert's agent proposes slots and the offering version (`propose_slots`, `propose`) → the owner accepts (agreement) → payment through the hub's payment adapter, captured per the hub's policy (at booking, or held until delivery where the provider supports it) → session → deliverable → acceptance by the owner.
- **Video and chat** run through communication adapters with fakes; recording only with both parties' consent, stored in the consultation context.
- **Credentials shown honestly.** "Licensed professional engineer in Texas, checked on date by hub X" appears only when the hub's check recorded it; otherwise the expert is shown as a practitioner with experience, not as a licensed professional. Advice that legally requires a licence is offered only by experts whose licence check passed.
- **Ratings tied to evidence.** There are no free-floating stars. After a booking completes, the client may review it under the [review rules](execution-and-reputation.md#reviews): tied to the real booking, the delivered deliverable and its acceptance; unconfirmed reviews are labelled and excluded from aggregates. Timeliness and delivery (deliverable on time, session held) are factual observations from the booking records.
- **Expert's agent jobs.** Filter incoming requests against the expert's scope, languages, region and calendar; propose slots and the matching offering; prepare the deliverable draft from the session notes for the expert to finish; send reminders; report weekly earnings and bookings. The deliverable is always the expert's own work product: the agent drafts, the expert signs off.

| Job (expert side) | Trigger | Mandate |
|---|---|---|
| Filter and answer consultation requests | event: `consultation.requested` | `communicate`, `schedule` \| own offerings \| scope, region, languages, calendar \| — \| propose `pre_authorized`, accept `ask_first(5)` |
| Quote a custom consultation | event | `send_quote` \| consultation requests \| own price list; floor private \| — \| `ask_above(USD 500)` |
| Deliverable draft | event: `session.ended` | `prepare` \| booking \| — \| — \| delivery by the expert |
| Mentoring follow-ups | schedule | `communicate` \| mentoring agreement \| — \| — \| `pre_authorized` |

### Task marketplace

A **task** is a scoped piece of work cut from a plan item: "frame the 2,000 sq ft house per drawings A-101 to A-104", "install a 200 A electrical service", "pour the slab foundation". Under the hood a task is an **RFQ whose lines come from the plan item**, so offers are quote versions, acceptance is the agreement digest, milestones are execution records and payments follow obligations. Nothing about immutability, private constraints or reconciliation is weaker for a homeowner than for a general contractor.

| Step | Owner's agent | Contractor's agent |
|---|---|---|
| Publish | Turns the plan item into a task brief; publishes it to invited contractors or to the needs board (`publish`, `ask_each`) | Filters tasks by trade, region, licence, capacity and calendar (`research`) |
| Questions | Answers from the plan; anything not in the plan goes to the owner | Asks `clarify` on structured lines |
| Offers | Compares offers honestly: exclusions, unknowns, schedule, licence and insurance status | Drafts an offer from the contractor's catalogue and price list; sends within mandate |
| Negotiate | Counters within the owner's private ceiling, consumer-mode limits apply | Negotiates within the private floor |
| Accept | The owner accepts (consumer: always a person's decision) | The contractor accepts within mandate |
| Execute | Tracks milestones, asks for evidence, schedules inspections from the plan | Records evidence per milestone, requests confirmation |
| Pay | Reminds the owner of obligations; payments through the hub's payment adapter or outside the platform as agreed | Sends payment reminders within limits |
| Close | Updates the plan; proposes a review | Proposes a portfolio entry with the owner's consent |

Milestone payments through the platform are possible only where the hub configured a payment adapter that supports them; otherwise the platform records obligations and evidence while money moves outside it.

### Plan-step companion

Owner decision 2026-10-31 (ADR 010 decision 19). For **every step** of a plan, the `plan_step_companion` module recommends what helps the owner do that step well, and explains why:

| Recommendation | Examples for "frame the house" | Comes from |
|---|---|---|
| Materials and products | Engineered lumber, structural sheathing, hold-down connectors suited to the local wind and seismic requirements | Catalogue offerings of claimed companies and **sourced** manufacturer and supplier pages, labelled as such |
| Articles and guides | A practice article on framing inspections; a manufacturer's installation guide for the connectors | Publications and indexed guides whose source licence allows display and indexing |
| Training and courses | A course on reading framing plans; a manufacturer's own installer training | Courses on the platform and indexed training from manufacturers' public pages |
| Events | A framing and building-science meetup next month | Events in the region and topic |
| Consultants and contacts | A structural engineer for a drawing review; local framing crews | Matching over capability profiles and consultation offerings ([Partners and matching](partners-and-matching.md)) |

Rules:

- **Explained.** Each recommendation states the step it serves, the criteria it meets (region, climate or code facets, trade, language, verified or sourced status) and what is unknown.
- **Never paid for.** Recommendations are ranked by fit with the same payment-blind method as matching. If a hub allows sponsored content at all, it is labelled "sponsored", shown separately and never enters the ranking.
- **Sourced stays sourced.** Pages the editorial office built from manufacturers' and suppliers' public sites, within the hub's legal basis and each site's licence and robots rules, stay labelled "from sources" until the company claims them. Being recommended never permits bulk outreach to a sourced company; contact goes through a lawful channel a person chooses.
- **Private plan, public recommendations.** The companion reads the owner's private plan to choose recommendations; nothing about the plan leaves the owner by being recommended something.

| Job | Trigger | Mandate |
|---|---|---|
| Recommendations for upcoming steps | event: a plan step becomes current or next; schedule: weekly | `research` \| own plan \| — \| — \| none |
| Save, enrol or register from a recommendation | decision | `register`, `introduce` \| that step \| — \| transaction budget for paid courses or events \| `ask_each` |
| Ask a manufacturer or supplier a step question | request | `communicate` (`step_question`) \| that plan item \| shares only the step description and the fields the owner chose; anonymous by default \| — \| `ask_each` |

### Manufacturers and suppliers as knowledge partners

Manufacturers and suppliers are not only sellers in the plan-to-people journey; they are a source of practical knowledge. Once a company has claimed its page, its **standing representative** (or a member's agent under a company mandate) keeps a knowledge profile:

| Job | Mandate |
|---|---|
| Publish and version catalogues, installation guides, technical articles, training and events | `publish` \| company content \| labelled company-authored \| — \| `ask_each` |
| Answer plan-step questions | `communicate` \| incoming `step_question` envelopes in the company's categories \| answers cite the company's published documents; labelled as from a party with a commercial interest \| — \| `ask_first(5)` |
| Keep sourced facts accurate after claiming | `maintain_profile` \| company page \| corrections of sourced fields recorded with provenance \| — \| `ask_each` |

The asker stays anonymous unless they choose to reveal themselves or request an introduction; the company sees the step question, not the project, the address or the budget. Answers arrive in the asker's assistant as untrusted content from a labelled commercial party, never as a recommendation the platform makes. A company's answering activity counts as a knowledge contribution in its [reputation](#flagship-build-and-confirm-your-own-reputation) only through structured feedback from askers, never by volume.

### Knowledge sharing

When a project completes, the owner's agent proposes, never publishes by itself, ways to give the experience back:

| Artefact | What it is | Consent and credit |
|---|---|---|
| Project diary | A publication series (format `diary`) telling the story phase by phase with photographs, costs as ranges if the owner wishes, problems and how they were solved | Owner's consent per entry; participants named only with their consent; the address never |
| Lessons learned | Short, structured notes linked to plan items ("our inspection failed because…") | Owner's consent; feeds plan risks for others as cited lessons |
| Checklists | Reusable checklists from completed tasks (for example "before the framing inspection") | Credited to their authors |
| Plan templates | A plan with private data removed, reusable by others as a starting point | Owner's consent; reviewed by the owner field by field before publication |
| Q&A | Questions to the community and expert answers ([expert answers](publishing.md#community-around-publications-proposed)) | Answers are publications with authorship and corrections |
| Mentoring | An experienced owner or practitioner offers sessions to newcomers, free or paid through `consultation` | Labelled; reviews tied to sessions |

Experts earn **reputation from evidence** (consultations delivered and accepted, answers that others confirmed useful through structured feedback tied to their own projects) and **income** from consultations and mentoring. Helpfulness signals are never sold and never bought.

### Mandates per step (homeowner example)

| Step | Owner's mandate | Approval |
|---|---|---|
| Plan drafting and re-planning | `prepare` on the project | — |
| Find experts and contractors | `research`; `introduce` ≤ 5 open | `ask_each` |
| Book a consultation up to USD 300 | `place_order` on the consultation context, personal transaction budget | `ask_each` (consumer mode) |
| Publish a task brief | `publish` per plan item | `ask_each` |
| Negotiate an offer | `negotiate` inside the private ceiling, ≤ consumer round limit | counters `ask_first(2)` |
| Accept and pay | `place_order` | always a person's decision |
| Progress and evidence | `record_evidence`, `communicate` | `pre_authorized` reminders |
| Share the experience | `publish` diary entries, templates | `ask_each`, field by field |

### Pricing and commissions

Hubs configure the economics with the same versioned records as everything else:

| Item | Configurable as | Rule |
|---|---|---|
| Planner usage | Included quota (one active project plan on the free floor) and meter rates | Planning is never paywalled for the first project |
| Consultation commission | A hub price version: a percentage or a fixed fee per booking, the same for every expert in a category | Shown to both sides before booking |
| Task marketplace commission | A hub price version per task value band, the same for everyone | Shown before acceptance; zero is allowed |
| Payment processing | Pass-through | Labelled |
| Knowledge sharing | Free | Diaries, templates, checklists and Q&A are free to publish and to read on the free floor |

Commissions never change who the owner's agent suggests: candidates are ranked identically whether or not a booking would earn the hub a fee, and the owner's agent shows off-platform options (for example "ask your building department") where they fit better. The commission is a marketplace fee like the existing ticket and course fees, never an incentive inside the agent.

## Flagship: build and confirm your own reputation

Owner decision 2026-10-31. Reputation is not something the platform watches people for. **Every participant gets tools to build and confirm their own reputation** from evidence, and the agent's `reputation_builder` module does the routine work: collecting, organising, requesting confirmations, presenting and defending. The home hub still computes reputation snapshots under a published method ([Execution, evidence and reputation](execution-and-reputation.md)); the module never changes a score directly, it helps the participant bring the evidence that the method counts. Explainable, evidence-based, **never for sale**.

### Building blocks

| Block | What the participant builds | How it is confirmed |
|---|---|---|
| Identity and credentials | Verified identity; state licences, insurance certificates, professional certifications, platform certificates | Hub verification recipes and checks ("checked on date by hub X"); documents themselves never shown publicly; expiry tracked |
| Evidence-backed portfolio | Completed projects and tasks with photographs, acceptance acts, inspection results, before/after | Each entry links to execution records; "client confirmed" only when the project owner or client confirmed, otherwise "self-reported" |
| Confirmations from counterparties | Confirmed deliveries, accepted milestones, payments made on time | `confirm_execution` decisions by the counterparty's person, tied to real agreements |
| Reviews | Commercial reviews and consultation reviews | Only from real counterparties of a completed interaction ([review rules](execution-and-reputation.md#reviews)); unconfirmed reviews labelled and excluded from aggregates |
| Knowledge contributions | Articles, expert answers, consultations delivered, mentoring, courses taught, checklists and templates others reused | Publication authorship, completed bookings with accepted deliverables, course versions and certificates issued |
| Timeliness signals | Response time to invitations received on the platform, on-time deliveries against the plan as agreed, on-time payments | Computed by the home node from records under the method version, with sample sizes; client-caused changes excluded ([fair timing](execution-and-reputation.md#fair-timing-who-caused-the-delay)) |
| Reputation passport | A portable, verifiable bundle of the above | Verifiable credentials signed by the home hub ([below](#reputation-passport)) |
| Coaching | "What would strengthen your profile" | Private suggestions limited to legitimate actions |
| Disputes and appeals | Challenges to observations or reviews, with evidence | Moderation and trust cases; appeals decided by a different person |

### What each participant builds

| Participant | Main reputation they build |
|---|---|
| Worker, installer, foreman | Certifications, confirmed work stages, portfolio of tasks with photographs, timeliness on tasks |
| Engineer, architect, estimator | Licence checks, portfolio with owner consent, consultations and reviews of drawings delivered, expert answers |
| Expert or mentor | Consultations and mentoring delivered and accepted, answers others confirmed useful through their own projects, courses taught |
| Job seeker or freelancer | Credentials, confirmed engagements, references from real counterparties |
| Small contractor, subcontractor | Licence and insurance status, confirmed completions, homeowner and GC confirmations, payment and delivery timeliness |
| General contractor | Packages delivered on time against agreed plans, change records with reasons, payment discipline towards subcontractors |
| Supplier, distributor, manufacturer | On-time deliveries confirmed, quote response time, product certificates and test reports, technical answers and courses |
| Design office | Commissions delivered, change notices handled, licence checks, portfolio with client consent |
| Developer, homeowner, public client | Payment discipline, fair change records, timely confirmations and clear briefs: clients have reputations too |
| Editor, author | Publications with sources, corrections made promptly, expert answers |
| Event organizer, course author | Events held as announced, materials published, courses with clear assessments and certificates issued |
| Company representative | Keeps the company's credentials, portfolio and confirmation requests current under company mandates |

### Jobs

| Job | Trigger | Mandate |
|---|---|---|
| Credential collection and expiry | request; deadline 60, 30, 7 days | `maintain_profile` \| own credentials \| submits to the hub's checks; pass-through cost shown \| platform budget for pass-through checks \| `ask_each` for paid checks |
| Portfolio entry from finished work | event: `acceptance.confirmed`, `project.completed` | `publish` (portfolio entry) \| own portfolio \| owner or client consent recorded; address never \| — \| `ask_each` |
| Confirmation requests | event: assertion recorded without confirmation after N days | `communicate` (`request_confirmation`) \| that agreement \| once, then one reminder \| — \| `pre_authorized` |
| Review requests | event: `acceptance.confirmed` or `booking.completed` | `communicate` \| that interaction \| once; never with an incentive \| — \| `pre_authorized` |
| Showcase contributions | schedule: monthly | `maintain_profile` \| own profile \| links to own publications, consultations, courses \| — \| `ask_each` for public fields |
| Passport issuance and refresh | request; event: new snapshot or credential | `prepare` \| own credentials \| holder chooses what to include \| — \| issuance needs the person's confirmation |
| Coaching | schedule: monthly | `research` \| own records \| — \| — \| none |
| Dispute or appeal draft | event: `review.published`, `observation.recorded` the participant disagrees with | `prepare` \| that observation \| evidence attached \| — \| submission `ask_each` |
| Public response to a review | event: `review.published` | `prepare` \| that review \| factual, no personal data \| — \| `ask_each` |

### Reputation passport

A portable, verifiable record the participant owns and can show anywhere, inside or outside Trustwork.

- **Format.** W3C Verifiable Credentials (data model 2.0) and Open Badges 3.0 credentials (pinned versions chosen in the implementing work package), issued by the participant's **home hub** with the node's key and a resolvable issuer identifier on the hub's domain.
- **Credential kinds (proposal).** `IdentityVerified` (categories checked, never documents), `LicenceChecked` (jurisdiction, licence type, checked on, valid until), `CertificateEarned` (course version, from [learning](learning.md#certificates)), `ProjectContribution` (public project card, role, confirmed by owner), `ConsultationDelivered` (counts by kind, accepted deliverables), `ReputationSnapshot` (method version, dimensions with samples and exclusions, valid only until the next snapshot).
- **Holder control.** The participant chooses which credentials to include and can export them to a wallet of their choice; selective disclosure where the chosen format supports it.
- **Revocation and freshness.** Status lists published by the hub, fetched as whole lists so that verification does not tell the hub who is checking whom; short validity for snapshot credentials; revoked verification or licence updates the status at once.
- **Across hubs.** Peers at `trust-verifications` level show passport credentials as "verified by hub X"; nobody re-issues or recomputes another hub's credentials ([Authority stays home](federation.md#authority-stays-home)).
- **No private data.** Counterparties' names appear only with their consent; amounts, private projects and negotiation details never.
- **Free.** Issuing and refreshing the passport is on the free floor.

### Coaching without gaming

Suggestions are private and limited to legitimate actions: "add the acceptance act for the Oak Street job", "your Texas licence check expires in 30 days", "two finished jobs are waiting for client confirmation", "your answer on framing inspections was reused in three plans: publish it as a checklist". The agent never suggests review swaps, incentives, splitting work to multiply reviews, deleting fair negative observations or asking people who were not counterparties.

### Never for sale

- No plan, payment, sponsorship or staff action changes a score, a badge, a passport credential or a position ([What money can never buy](#what-money-can-never-buy)).
- Pass-through costs of a real check (for example a paid register lookup) buy the check, not its result.
- Review rings, reciprocal-review patterns and confirmation swaps open a case for a person to review; they never trigger automatic sanctions and never silently change scores.
- A participant can respond to a fair negative observation and dispute it with evidence; they cannot remove it.

## Procurement and supply (Proposed)

The company-side suite of [Procurement and supply](procurement-and-supply.md) (R53) is part of the one agent through the Supply family of the [module table](#families-and-modules) (AGT-024). By [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 23 **every operation a person can perform in the procurement and supply interface is also an agent capability, and vice versa**: each is defined once with a kind (`read`, `draft`, `commit`), a mandate action and a confirmation policy in the [parity table](procurement-and-supply.md#agent-parity-every-operation-is-an-agent-capability), and PRC-023 registers them in the shared capability registry that the agent runtime, MCP connections and the interface use.

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Requisitions from the plan's takeoff (general contractor) | requisition_desk | event: `plan_version.approved`; schedule: weekly | `prepare` \| project \| lines carry plan items and cost codes; drafts only \| — \| none (drafts) |
| Chase suppliers who have not answered | sourcing_desk | deadline: RFQ response date minus 2 days | `communicate` \| RFQs of the project \| invitees only, template wording, at most 2 reminders \| — \| `pre_authorized` |
| Level bids and propose the award | sourcing_desk | event: RFQ deadline passed | `prepare` \| RFQs of the project \| stale quotes non-comparable; adjustments labelled \| — \| proposal `ask_each`; the award itself goes through the approval route (`approve` is `human_only`) |
| Off-platform quotes and invoices into drafts | document_intake | event: `intake_document.received` | `prepare`, `maintain_records` \| company documents \| drafts only; never approve, pay or change a payee \| platform budget for pages beyond quota \| review stays human for quotes and invoices |
| Receipts at the gate, offline | receiving_clerk | request (mobile) | `record_evidence` \| orders delivered to the site \| photos with capture time; discrepancies typed \| — \| `ask_first(5)` |
| Match, exceptions and payment proposal | payables_desk | event: `trade_invoice.received`; schedule: weekly payment run | `maintain_records`, `communicate` \| company invoices \| tolerance policy of the company \| — \| exceptions to suppliers `ask_each` |
| Release scheduled payments | payables_desk | schedule: payment dates of an approved proposal | `release_payment` \| approved proposals of the project \| matched invoices; payee unchanged 90 days; no open risk signal \| project transaction budget \| `ask_above(USD 10,000)` where the hub allows it, otherwise `ask_each` |
| Supplier auto-quotes from price lists | quoting (supplier side) | event: `rfq_invitation.received` | `send_quote` \| invitations in categories \| catalogue lines only; never below the private floor \| — \| `ask_above` per mandate |

**Never**: approve anything; clear a payment risk signal; change or accept new payee details from a document, an e-mail or another agent; call a phone number found in a document; reveal one bidder's price or identity to another; rank buyers, approvers or storekeepers; send a buyer's budget, levelling sheet or supplier notes anywhere outside the company.

## The module system

A **module** is the unit in which the engine ships agent capability, a hub enables it, a payer is entitled to it and a test suite proves it safe. To the participant a module is invisible as a "thing": they see what their agent can do, the jobs it proposes and the mandates it asks for. There is no module store inside the product and no per-module agent.

### What a module contains

| Part | Notes |
|---|---|
| Manifest | id, version, family, status label, the participant types it suits, dependencies on product modules (commerce, matching, events…) |
| Job templates | The jobs below, each with trigger, default mandate template and report section |
| Action and tool allowlist | Which mandate actions it may propose and which internal tools it may call (for example `matching.run`, `quotes.draft`); nothing outside the list is reachable from its runs |
| Data classes | Which projections it reads (`public`, `shared_party`, the principal's `party_private`/`owner_private`) and which it may send to a model provider under the hub's egress matrix |
| Meters | What it consumes ([Metering](#metering-quotas-and-hub-pricing)) |
| Safety suite | Injection, disclosure, competition-law and quota tests that must pass before a hub can enable it |
| Locale keys | Every label, job name, decision text and report heading in all six languages |

Modules are code in the engine, versioned with it. A hub enables, configures and prices them. Since ADR 010 decision 22 a hub administrator can also **add** functions, tools, integrations and other capabilities through the **governed extension registry** (AGT-023): each extension declares its actions (mapped to mandate kinds), inputs, data classes, side effects, external endpoints and costs, ships with a safety suite and an adapter with a fake, and is activated only after review by a second person. Extensions may add actions; neither a module setting nor an extension can widen a mandate or a data class beyond what the principal confirmed, or bypass budgets, kill switches, privacy rules, the restricted-places list or the rule that untrusted text never issues commands. Agent disclosure wording, liability allocation, consent, record-keeping and per-action limits are per-hub and per-jurisdiction settings with country-pack defaults (HUB-005).

### Families and modules

| Module | Family | What it does | Mandate actions | Typical participants |
|---|---|---|---|---|
| `core` | — | Conversation, decisions waiting, goals, mandates, runs, reports, backlog, stop, cited answers within quota | `prepare`, `research` | Everyone |
| `profile_keeper` | Presence | Keeps capability profile, portfolio, availability and catalogue presentation current; flags stale or inconsistent fields; drafts portfolio entries from finished project participations (with the project owner's consent) | `maintain_profile`, `publish` (offerings), `prepare` | Professionals, all companies |
| `compliance_checker` | Presence | Tracks expiry of own licences, certificates, insurance and verification evidence; checks tender document completeness; shows counterparty badge and screening **status** (the hub performs screening) | `research`, `prepare` | Contractors, suppliers, manufacturers, design offices, public clients |
| `reputation_builder` | Presence | Helps the principal **build and confirm** their own reputation: credentials, evidence-backed portfolio, confirmations and reviews from real counterparties, knowledge contributions, timeliness signals, a portable verifiable passport, coaching, disputes and appeals ([flagship section](#flagship-build-and-confirm-your-own-reputation)) | `maintain_profile`, `record_evidence`, `communicate` (confirmation and review requests), `publish` (portfolio), `prepare` | **Every participant type** |
| `discovery` | Opportunity | Runs explainable matching for the principal's needs, posts and RFQs; keeps watchlists; explains candidates with uncertainty | `research` | Clients, contractors, suppliers, designers |
| `opportunity_watch` | Opportunity | Watches the needs board, partner posts, RFQ invitations and the hub's imported public procurement notices; pre-checks eligibility; drafts a go/no-go note | `research`, `prepare` | Contractors, suppliers, manufacturers, design offices, freelancers |
| `bid_desk` | Opportunity | For suppliers, contractors, manufacturers and design offices that bid: qualifies opportunities, drafts bid/no-bid scorecards, extracts requirements into a cited compliance matrix, drafts sections from the content library and labelled translations, checks specifications and prices with a private margin guard, drafts questions for the official channel, finds partners, prepares reviews and the submission checklist, tracks outcomes and debriefs; never submits, signs or shares prices ([The supplier bid desk](tender-desk.md#the-suppliers-agent-the-bid-desk-module)) | `research`, `prepare`, `communicate`, `introduce`, `negotiate`, `maintain_records`, `record_evidence`; `send_quote` only with the person's step-up confirmation | Contractors, subcontractors, suppliers, manufacturers, design offices |
| `introductions` | Opportunity | Double-opt-in introduction requests and responses, follow-ups, turning accepted introductions into RFQ invitations or project participation | `introduce`, `communicate` | Everyone with a commercial or professional goal |
| `engagements` | Opportunity | For individuals: finds open needs and partner posts that want a person (site engineer, estimator, crew), proposes availability, prepares applications as introductions | `introduce`, `maintain_profile` | Individual professionals, job seekers, freelancers |
| `project_planner` | Plan to people | Turns an idea into a versioned plan (phases, tasks, trades and expertise, materials, permits and inspections, budget ranges, timeline, risks, decision points) in plain language; turns plan items into requests; tracks progress ([flagship](#project-planner)) | `prepare`, `publish`, `introduce`, `record_evidence` | Homeowners, small developers, companies, anyone with a project |
| `plan_step_companion` | Plan to people | For every plan step, recommends materials and products, articles and guides, training and courses (including manufacturers' own), events, consultants and contacts, each explained, never paid for; relays anonymous step questions to manufacturers and suppliers ([flagship](#plan-step-companion)) | `research`, `register`, `introduce`, `communicate` | Anyone with a plan; manufacturers and suppliers answer |
| `consultation` | Plan to people | Consultation offerings, booking, slots, sessions by video, chat or site visit, deliverables, reviews tied to bookings; mentoring series ([flagship](#consultation)) | `send_quote`, `schedule`, `place_order`, `accept_order`, `prepare` | Experts, professionals, design offices, and everyone who needs advice |
| `task_marketplace` | Plan to people | Scoped tasks from plan items as RFQs, offers as quote versions, acceptance, milestones, evidence and payments ([flagship](#task-marketplace)) | `publish`, `send_quote`, `negotiate`, `place_order`, `accept_order`, `record_evidence` | Project owners, contractors and trades |
| `knowledge_sharing` | Plan to people | Project diaries, lessons learned, checklists, plan templates, Q&A and mentoring from completed projects, with consent ([flagship](#knowledge-sharing)) | `prepare`, `publish` | Everyone |
| `need_intake` | Deal | Turns notes, spreadsheets, e-mails and drawings into structured needs and RFQ drafts with evidence per line; asks for missing scope, units, schedule | `prepare`, `publish` (need, RFQ) | Clients, contractors buying, homeowners |
| `quoting` | Deal | Answers RFQ invitations with quote drafts from the catalogue and price lists; sends within mandate | `prepare`, `send_quote` | Suppliers, manufacturers, contractors selling, design offices |
| `negotiation` | Deal | Counters and amendments inside private floors or ceilings; round limits; escalates deadlock | `negotiate`, `send_quote` | Sellers and buyers |
| `procurement` | Deal | Compares quotes honestly, proposes terms, places orders within budget, follows up deliveries | `research`, `place_order` | Clients, contractors, developers |
| `order_desk` | Deal | Accepts orders within limits, confirms schedules, flags capacity conflicts | `accept_order`, `communicate` | Suppliers, manufacturers, subcontractors |
| `public_tender_desk` | Deal | For public and institutional clients: market sounding, specification drafts, equal-treatment clarifications, anti-splitting guard; never awards | `prepare`, `publish` (notices on the platform), `communicate` | Public clients |
| `requisition_desk` | Supply | Drafts requisitions from takeoffs, photos, voice notes, spreadsheets and reorder points; allocates and merges approved lines; tracks fulfilment for requesters ([Procurement and supply](procurement-and-supply.md#requisitions)) | `prepare`, `maintain_records` | Contractors, general contractors, developers, site staff |
| `sourcing_desk` | Supply | Drafts RFQs and invitation lists, chases non-responding suppliers within quotas, answers clarifications from approved facts, levels bids with exclusions and adjustments, proposes awards, sends outcome notices; organizes opt-in demand pools where the hub allows them | `prepare`, `publish`, `communicate`, `place_order` | General contractors, developers, contractors, public clients |
| `document_intake` | Supply | Extracts quotes, invoices, credit notes, delivery notes and price lists with confidence and locators, matches lines and units, flags discrepancies and duplicates; everything lands in a human review queue | `prepare`, `maintain_records` | Every buying company; suppliers for their own price lists |
| `receiving_clerk` | Supply | Records goods receipts offline with photos, discrepancies and returns; proposes delivery slots and site-resource bookings; keeps stock movements and transfers | `record_evidence`, `schedule`, `maintain_records`, `communicate` (`confirm_execution` stays human) | Storekeepers, site engineers, foremen |
| `payables_desk` | Supply | Runs the three-way match, routes exceptions, prepares payment proposals and schedules, watches payee changes and risk signals, releases payments only within mandates | `maintain_records`, `communicate`, `release_payment` (`approve` stays human) | Accounts payable, small-contractor owners |
| `supply_watch` | Supply | Budget burn and overrun warnings, price-index escalation alerts, lead-time and delivery-date risks, expiring supplier documents, plan-change flags on open purchases, embodied-carbon totals | `research`, `prepare` | Project managers, commercial directors, homeowners with a plan |
| `surplus_exchange` | Supply | Lists leftover stock as surplus offerings, answers pickup requests, prepares returns to suppliers | `publish`, `communicate`, `accept_order` | Contractors, suppliers |
| `project_desk` | Delivery | Tracks participants, milestones, changes and dependencies; asks participants for updates through context threads; drafts change records with reasons | `prepare`, `communicate`, `record_evidence` | General contractors, developers, design offices |
| `execution_clerk` | Delivery | Collects delivery notes, acts and photographs, submits assertions, reminds counterparties to confirm, tracks obligations and due dates | `record_evidence`, `communicate`, `prepare` (`confirm_execution` stays human) | Contractors, subcontractors, suppliers, clients |
| `content_writer` | Content | Drafts publications, project stories, company announcements, expert answers; checks sources and entity links; labels assistant-assisted writing | `prepare`, `publish` | Editors, authors, experts, companies |
| `editorial_desk` | Content | For hub editors: triages imported source items, drafts summaries with attribution, proposes corrections, assembles magazine issue drafts | `prepare` | Editors (staff) |
| `translation` | Content | Drafts linked language editions, translates context messages for reading, keeps glossary per hub; machine-assisted drafts stay labelled until a person reviews | `prepare`, `publish` (reviewed editions) | Everyone across languages |
| `event_networking` | Community | Finds events, registers within budget, maintains the meeting profile, proposes meetings that serve goals, merges schedule, follows up | `register`, `schedule`, `introduce`, `maintain_profile` | Everyone |
| `organizer_desk` | Community | For organizers: programme drafts, speaker invitation drafts, registration and waitlist handling, announcements from templates, check-in reports, materials | `prepare`, `publish` (event), `communicate` (registrants via templates) | Event organizers |
| `learning_coach` | Community | Suggests courses tied to goals and gaps, reminds of progress and certificate renewals; progress stays private | `register`, `research` | Professionals, job seekers, installers |
| `course_studio` | Community | For authors: course and assessment drafts, practice tasks, language editions, learner question answer drafts | `prepare`, `publish` (course version) | Course authors, trainers, manufacturers |
| `hub_ops` | Operations | For hub staff: queue summaries (sources, claims, moderation, verification), evidence checklists, launch-gate evidence, drafts of decisions; never decides | `prepare` under a staff principal | Hub operator staff |
| `representative` | Operations | The standing company representative's front desk: answers invitations and introduction requests, schedules, routes decisions to named approvers, weekly report to the accountable person | Company mandates only | Companies |
| `channels` | Connectivity | Per-channel, per-scope e-mail and messenger connections ([External channels](agents.md#external-channels)) | `communicate` on named channels | Everyone who allows it |
| `connections` | Connectivity | MCP and A2A connections for the principal's own external agent ([below](#connect-your-own-agent-mcp-and-a2a)) | Bound to existing mandates; adds none | Everyone who allows it |

`core` and the safety controls inside it (stop, revocation, approvals, audit of one's own agent, export of one's own activity) are never paid features and can never be switched off by a hub.

### Tiers: free floor, included quota, paid capacity

| Tier | Meaning | Who sets it |
|---|---|---|
| **Free floor** | What every participant gets in every hub, matching the [free minimum participation](billing.md#free-to-participate-fair-to-pay) of both commercial sides | Engine minimum; a hub may be more generous, never less (open question [Q1](#open-questions-for-the-owner)) |
| **Included quota** | Free use up to a hub-set quota per window | Hub, in the agent plan version |
| **Paid capacity** | Higher quotas, standing mandates with pre-authorization at scale, long-running goals, deliverables, more connections | Hub, in plan, credit-pack and meter-rate versions |
| **Pass-through** | Checks or provider services with a real external cost (a paid register lookup, an e-signature) shown as cost plus a declared fee | Hub, labelled as pass-through |

The engine's free floor, per module:

| Module | Free floor | Paid capacity adds |
|---|---|---|
| `core` | Everything, cited answers within a small monthly quota | Larger answer quota |
| `profile_keeper` | Monthly freshness check, drafts of profile and portfolio edits | Weekly checks, catalogue presentation deliverables, multi-language profile sets |
| `compliance_checker` | Expiry reminders from the principal's own records | Tender completeness checks, counterparty status sweeps over many contexts, pass-through register checks |
| `reputation_builder` | Everything needed to build and confirm one's own reputation: credentials, portfolio, confirmation requests, passport issuance, coaching, disputes and appeals | Bulk evidence preparation across many projects; pass-through credential checks with a real cost; **never** a better score, position or badge |
| `discovery` | A few match runs per month with explanations | More runs, saved watchlists, re-runs on schedule |
| `opportunity_watch` | Alerts with reasons, **at the same moment as for paying participants** | Eligibility pre-checks and go/no-go notes at volume |
| `introductions` | Requests within the hub quota | Follow-up drafting and conversion help; **the quota itself is never sold** |
| `project_planner` | One active project plan with re-planning | More projects, larger drawing sets, plan templates for teams |
| `plan_step_companion` | Recommendations for every step of the free plan | Recommendations across many projects |
| `consultation` | Offering and booking free and paid consultations (hub commission applies to paid ones) | Video minutes or recordings at volume, if the hub prices them |
| `task_marketplace` | Publishing tasks and answering them | Standing mandates at volume |
| `knowledge_sharing` | Everything | — (sharing experience is never paywalled) |
| `need_intake` | A few structured needs per month, small files | Large files, more needs, spreadsheet lines at volume |
| `quoting` | Drafts for every invitation received; sending with `ask_each` | Standing mandates with pre-authorization, many price lists, bulk revalidation after RFQ amendments |
| `negotiation` | Drafting counters the principal sends | Agent-run sessions under floors or ceilings |
| `procurement` | Honest comparison of quotes received | Order placement under standing mandates, delivery follow-up at volume |
| `order_desk` | Drafts of acceptances | Pre-authorized acceptance within limits |
| `public_tender_desk` | Specification and clarification drafts | Market sounding at volume, multilingual notices (hubs may make it free for public bodies) |
| `requisition_desk`, `receiving_clerk`, `payables_desk` | One active project with the full suite (requisitions, receipts, match, payment proposals) | More projects and locations, standing mandates at volume |
| `sourcing_desk` | Levelling of quotes received and outcome notices | Reminder sequences and award preparation at volume; pools where the hub enables them |
| `document_intake` | A small monthly page quota | More pages (`document_pages` meter), batch intake |
| `supply_watch` | Budget and document-expiry warnings for one project | Index alerts and lead-time watch across many projects |
| `surplus_exchange` | Everything (reuse is never paywalled) | — |
| `project_desk`, `execution_clerk` | One active project | More projects, scheduled update requests |
| `content_writer`, `translation` | Short drafts and reading translations | Long-form drafts, linked editions at volume |
| `event_networking`, `learning_coach` | Full, within event and course rules | — (tickets and courses are bought from their sellers, not from the agent plan) |
| `organizer_desk`, `course_studio` | One event or course at a time | More events or courses, larger audiences |
| `hub_ops` | Hub-internal, not billed to participants | — |
| `representative` | — | Company plan only; at most one per company |
| `channels` | One channel | More channels |
| `connections` | One connection with read and propose scopes at the base rate limits | More connections, higher rate limits, act scopes at volume |

### Country-specific behaviour is configuration

No module contains country logic. Everything that differs between countries, states or cities comes from the [country pack](country-specifics.md), the hub's versioned configuration ([Hub administration](hub-administration.md)) or an adapter with a fake, so that an operator can set up any territory without code. The United States reference hub (owner decision 2026-10-31) is the first full example; the Uzbekistan, Georgia, Armenia and Azerbaijan packs remain examples of other countries.

| Module behaviour | Comes from | United States reference hub | Other example |
|---|---|---|---|
| Licence and credential checks (`compliance_checker`, `discovery` eligibility) | Hub verification recipes and check types | State contractor licence lookups and state professional-engineer boards, configured state by state; certificate-of-insurance expiry as a document check | Licence categories from national registers |
| Imported procurement notices (`opportunity_watch`, `public_tender_desk`) | Hub sources registry, each with licence flags | SAM.gov notices and state and city procurement portals the hub registered | National procurement portal feeds |
| Thresholds for the anti-splitting guard and approval prompts | Country and state facets | Federal and state purchasing thresholds recorded in the facets with sources | National thresholds |
| Consumer protection when the client is a private person | Country and state facets | Home-improvement contract cancellation rights and required contract contents per state | National consumer law |
| Taxes shown on quote lines | Tax facets | State and local sales tax treatment | VAT |
| Electronic agreements and signatures | Signature facets and adapters | ESIGN and UETA; e-signature provider adapters | Qualified electronic signature adapters |
| Payments for tickets, courses and platform plans | Hub payment adapters | Card and ACH adapters | Local providers |
| Business identifiers and company forms | Country pack | EIN; LLC, corporation, partnership, sole proprietorship | National tax numbers |
| Working days in schedules and reminders | Country pack calendar | US federal holidays plus hub-added state holidays | National holidays |
| Languages of drafts, translations and disclosure labels | Hub locales | English, Spanish (es-US) | Hub languages |
| Personal data rules for model egress and connections | Hub privacy settings | CCPA/CPRA and other state privacy laws as configured by the operator | National residency rules |
| Units of measure | Hub taxonomy and unit catalogue | US customary units (square feet, linear feet, cubic yards) alongside metric | Metric |

A module asks the configuration, never the country code. When a fact is missing for a territory, the job shows "unknown for this hub" and escalates instead of guessing.

## Metering, quotas and hub pricing

### Meters

| Meter | Unit | Counted when | Notes |
|---|---|---|---|
| `model_tokens` | Input and output tokens, by provider class `local`, `in_country`, `hosted_external` | Each model call of a run step | A run started by a connected external agent that does its own reasoning uses few hub tokens: bringing your own model is cheaper for everyone |
| `agent_actions` | Action intents that reach `succeeded` | On final success only | Failed or revoked actions are not charged; `outcome_unknown` is charged only if reconciliation ends in `succeeded` |
| `checks` | Compliance or verification checks with an external cost | On provider result | Pass-through price, labelled |
| `document_pages` | Pages or sheets parsed | On successful extraction | Intake of large files |
| `deliverables` | Generated deliverables | On delivery | Existing `deliverable` offers |
| `translation_characters` | Source characters translated | On draft creation | Reading translations of short messages fall under the free floor |
| `retrieval_queries` | Cited answers | On delivery of an answer | Governed retrieval ([Search and knowledge](search-and-knowledge.md)) |
| `external_calls` | MCP or A2A calls by a connection | Per call | Rate-limited separately from billing |

The participant sees money and simple counts, never only tokens: before an expensive run the agent shows an estimate in the hub currency (from the active meter rate version), and every run detail lists the meters it consumed.

### How a metered step runs

```text
check module entitlement and hub enablement
  → check quota window (per principal, per module, per meter)
  → if beyond included quota: reserve the estimate from the platform budget the mandate names
  → execute the step (model call, tool call)
  → append usage record (idempotent per step and attempt)
  → settle the reservation with the actual amount, or release it
```

- **No surprise overage.** Without a platform budget named in the mandate, a job stops at its quota and asks; it never runs into debt.
- **Idempotent usage.** A usage record is keyed by run step and attempt; replaying a step never charges twice. An unknown provider billing outcome goes to reconciliation like any other external outcome.
- **Quota windows** are per principal (person or company), per module and per meter, rolling or calendar as the plan version says. Alerts at 80 % and 100 % arrive as decisions waiting, never as e-mail campaigns.
- **Company usage** is billed to the company's platform budget only through company mandates; a member's personal plan never pays for company work and vice versa.

### Limits that are protection, not product

Some limits exist to protect other people and the commons. They are set by the hub in the agents policy, are identical for every plan and **cannot be bought**:

| Limit | Default proposal |
|---|---|
| Open introduction requests per person | Hub quota (for example 10 open); lowered temporarily after repeated declines |
| New counterparties contacted per day by one principal's agent | Hub cap |
| Envelopes per negotiation session | Max rounds (for example 6) and expiry |
| Envelopes per counterparty per day | Hub cap |
| Meeting requests per event per attendee | Organizer cap within hub cap |
| Concurrent runs per principal | Small fixed number |
| Public records read per connection per day | Anti-scraping cap |

### How a hub prices modules

Pricing uses the existing billing contracts: **offers**, **price versions** with second-person activation and no back-dating, and immutable **price acceptances** ([Billing](billing.md#versioned-prices-and-acceptance)). The catalogue adds two versioned records:

| Record | Contains |
|---|---|
| `agent_plan_version` | The plan offer it belongs to, payer kind (person or company), enabled modules, included quota per module and meter per window, number of connections and channels, whether the company representative is included, effective dates |
| `meter_rate_version` | Price per unit per meter (and per provider class for tokens) beyond included quota, in the hub currency, effective dates |

Rules:

- Drafted by a commercial admin, activated by a second person with a different role; effective from a future time; never overlapping another active version of the same plan or meter.
- A payer accepts a specific plan version and acceptance text version; a new price version applies only from the payer's next acceptance or renewal, with notice.
- The engine ships **no real prices**. Fixtures and demo plans are labelled synthetic; actual prices, trial lengths and tiers are owner and hub decisions (O03).
- Credit packs (existing offer kind `credit_pack`) fund the platform budget in advance.
- Sponsorship is possible and labelled: a manufacturer may sponsor `learning_coach` capacity or courses for installers; the sponsor never sees who used it or how.
- **Proposed default: no outcome-based fees for agent work** (no commission for the agent's own effort when it closes a deal). An agent paid by results is tempted to push its principal into deals. Marketplace commissions on consultations and tasks ([plan to people](#pricing-and-commissions)) and on tickets and courses are a separate hub setting: a flat price version per category, shown before booking, and never an input to what the agent suggests (open question [Q3](#open-questions-for-the-owner)).

### What money can never buy

Each item has an automated test that compares behaviour with and without paid entitlements:

1. A higher rank or any position in matching, search, directories, needs board, event listings or another agent's candidate list.
2. Earlier alerts: notifications about new needs, invitations and procurement notices are dispatched in the same batch for every plan.
3. More introductions or a higher outreach cap.
4. A badge, label or visual marker visible to others. The plan of a principal is never in any projection other than their own billing view; a counterparty's agent cannot see it.
5. Priority in a counterparty's decisions waiting list or a faster answer from another agent.
6. Reputation, verification or a softer moderation outcome.
7. Access to anybody's private data, including aggregated private quotes.

## Catalogue by participant

Each section follows the [anatomy of a job](#anatomy-of-a-job). Examples use the **United States reference hub** (owner decision 2026-10-31: English and Spanish, USD, US states, state licensing, SAM.gov and state procurement portals); the same jobs run in any hub, because every country-specific step is [hub configuration](#country-specific-behaviour-is-configuration). Amounts are illustrative, in the hub currency, and never defaults: every limit is the principal's choice. "Company work" means the job runs under a **company mandate** executed either by a member's own agent or by the standing representative; it stops when the executor's authority or membership ends.

Participant types at a glance:

| # | Type | Principal | Default modules (free floor) | Typically paid |
|---|---|---|---|---|
| 1 | [Individual professional](#1-individual-professional) | Person | core, reputation_builder, consultation, knowledge_sharing, profile_keeper, compliance_checker, learning_coach, event_networking, introductions | content_writer, translation, connections |
| 2 | [Job seeker or freelancer](#2-job-seeker-or-freelancer) | Person | core, reputation_builder, task_marketplace, engagements, profile_keeper, introductions, learning_coach | quoting, opportunity_watch at volume |
| 3 | [Small contractor](#3-small-contractor) | Person acting for own company | core, reputation_builder, opportunity_watch, quoting, task_marketplace, execution_clerk | procurement, negotiation, representative |
| 4 | [General contractor](#4-general-contractor) | Company | core, reputation_builder, discovery, need_intake, procurement, project_desk | negotiation, execution_clerk at volume, representative |
| 5 | [Subcontractor or installer firm](#5-subcontractor-or-installer-firm) | Company | core, reputation_builder, task_marketplace, opportunity_watch, quoting, order_desk, execution_clerk | negotiation, representative |
| 6 | [Supplier or distributor](#6-supplier-or-distributor) | Company | core, reputation_builder, quoting, order_desk, profile_keeper | negotiation, standing quoting mandates, representative |
| 7 | [Manufacturer](#7-manufacturer) | Company | core, reputation_builder, profile_keeper, course_studio, content_writer | discovery at volume, organizer_desk, representative |
| 8 | [Design office](#8-design-office) | Company | core, reputation_builder, consultation, opportunity_watch, quoting, project_desk | discovery, translation |
| 9 | [Developer or client company](#9-developer-or-client-company) | Company | core, reputation_builder, project_planner, plan_step_companion, need_intake, discovery, procurement | negotiation, project_desk, execution_clerk |
| 10 | [Private homeowner](#10-private-homeowner) | Person | core, project_planner, plan_step_companion, consultation, task_marketplace, knowledge_sharing, reputation_builder, need_intake, discovery, introductions, execution_clerk | — (the free floor is designed to be enough) |
| 11 | [Public or institutional client](#11-public-or-institutional-client) | Company (public body) | core, reputation_builder, public_tender_desk, execution_clerk | hub may make all of it free |
| 12 | [Editor, author or expert](#12-editor-author-or-expert) | Person (editors also as staff) | core, reputation_builder, consultation, knowledge_sharing, content_writer, translation | long-form and editions at volume |
| 13 | [Event organizer](#13-event-organizer) | Person or company | core, reputation_builder, organizer_desk | larger events |
| 14 | [Course author or trainer](#14-course-author-or-trainer) | Person or company | core, reputation_builder, consultation, course_studio | more courses, editions |
| 15 | [Hub operator staff](#15-hub-operator-staff) | Staff principal | hub_ops | — (hub-internal) |
| 16 | [Company standing representative](#16-company-standing-representative) | Company representative | representative (keeps the company's reputation_builder work current) | company plan |

### 1. Individual professional

Engineers, foremen, installers, estimators and architects. Their story is personal and lifelong; their daily work belongs to an employer and runs under the employer's company mandates, never under personal ones.

**Goals they give**: "Keep my profile and portfolio current"; "Make sure my licence and welding certificate never lapse"; "Meet three facade manufacturers at the facade trade show in Dallas"; "Answer expert questions about hidden-works acceptance".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Profile freshness check and edit drafts | profile_keeper | schedule: monthly; event: `participation.ended` | `maintain_profile` \| own profile \| private fields only \| — \| `pre_authorized` (public fields `ask_each`) |
| Portfolio entry from a finished project | profile_keeper | event: `project.completed` where the person participated | `maintain_profile` \| own portfolio \| only with the project owner's recorded consent \| — \| `ask_each` |
| Credential expiry reminders | compliance_checker | deadline: 60, 30 and 7 days before expiry | `research` \| own credentials \| — \| — \| none (no external effect) |
| Course suggestions tied to gaps | learning_coach | goal; schedule: weekly | `register` \| free courses in chosen topics \| — \| personal transaction budget for paid \| `pre_authorized` free, `ask_above(0)` paid |
| Meetings at an event | event_networking | event: `event.registration_opened` in chosen topics and regions | `register`, `schedule`, `introduce` \| selector: events in region \| ≤ 5 meeting requests per event \| — \| propose pre-authorized, accept `ask_each` |
| Expert answer drafts | content_writer | event: `question.published` in the person's topics | `prepare`, `publish` \| expert-answer format \| cites sources \| — \| `ask_each` |

Role variants:

| Role | What the agent adds |
|---|---|
| Engineer | Cited answers from licensed codes and standards; state professional-engineer licence status where the hub configured a state board lookup ("checked on date by hub X") |
| Foreman | Under the employer's company mandate only: drafts of daily site updates, stage acts and photo evidence in the project context |
| Installer | Manufacturer system certificates; evidence capture checklists for hidden works |
| Estimator | Under the employer's mandate: quantity take-off from drawings into RFQ lines with units and evidence per line (`need_intake`) |
| Architect | Portfolio and authorship credits with client consent; competition calls through `opportunity_watch` |

**Never**: copy the employer's private project data into the personal profile or portfolio; present a credential as verified when it was not checked; keep acting for the employer after the membership ends; report on colleagues.

**Agent-to-agent**: a manufacturer's representative proposes training slots (`schedule_meeting`); the installer's agent shows the slots that fit the calendar, the installer chooses.

**Reports**: monthly profile health; credential calendar; event plan with meetings.

**KPIs (private)**: profile completeness and freshness; credentials valid; introductions accepted; meetings held; expert answers published and corrected.

### 2. Job seeker or freelancer

A person looking for employment or for engagements as an independent professional. Employment is not commerce: the agent helps find and prepare, a person decides.

**Goals**: "Find a site-engineer role or a three-month contract in the Austin area from March"; "Fill April with estimating work"; "Find BIM modelling work through peered hubs".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Availability and "open to work" profile | engagements | request; schedule: weekly | `maintain_profile` \| own availability \| visible only to chosen audiences \| — \| `pre_authorized` |
| Watch engagements | engagements, opportunity_watch | event: `need.published`, `partner_post.published` wanting a person | `research` \| selector: categories, regions \| — \| — \| none |
| Apply through introductions | introductions | goal step | `introduce` \| matching needs and posts \| ≤ 5 per week within the hub quota; counterparty claimed or verified \| — \| `ask_first(3)` |
| Interview or call scheduling | event_networking | event: `introduction.accepted` | `schedule` \| that introduction \| — \| — \| `ask_each` for accept |
| Freelance quote for a services RFQ | quoting | event: `rfq_invitation.received` | `send_quote` \| invitations to the person \| personal catalogue lines; private rate floor \| — \| `ask_each` |
| Skills gaps and courses | learning_coach | goal | `register` \| free courses \| — \| — \| `pre_authorized` |

**Never**: reveal "open to work" to members of the person's current employer (the visibility setting excludes them by default); apply in bulk; inflate experience or credentials; accept an employment offer (`human_only`); accept a freelance order without approval.

**Agent-to-agent**: a general contractor's representative sends `request_proposal` for a three-month site-engineer engagement; the freelancer's agent asks `clarify` about schedule and site, then prepares a quote draft for approval.

**Reports**: weekly opportunities with reasons; applications and their states.

**KPIs (private)**: applications sent and accepted; response time; days booked ahead; achieved rate against the private target.

### 3. Small contractor

Two to twenty people; the owner sells, buys, manages and signs. Usually the owner's own agent works under company mandates they granted themselves as company administrator; a standing representative becomes useful when the owner is on site all day.

**Goals**: "Keep two months of work booked"; "Answer homeowner requests in my district the same day"; "Get paid on time"; "Get good reviews from every finished job".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Go/no-go on new needs | opportunity_watch | event: `need.published` in categories and districts | `research`, `prepare` \| selector \| — \| — \| none |
| Quote from a simple price list | quoting | event: `rfq_invitation.received` | `send_quote` \| invitations in categories \| catalogue lines only; ≤ USD 75,000; floor private \| — \| `ask_above(USD 15,000)` |
| Site visit scheduling | event_networking | event: `introduction.accepted` | `schedule` \| that context \| working hours only \| — \| propose pre-authorized |
| Material orders for a won job | procurement | goal step after agreement | `place_order` \| project \| approved suppliers; ≤ USD 20,000 per order \| project transaction budget \| `ask_above(USD 5,000)` |
| Stage acts and payment reminders | execution_clerk | event: `milestone.due`, `obligation.due` | `record_evidence`, `communicate` \| agreement context \| ≤ 1 reminder per 3 days; template wording \| — \| `ask_first(5)` |
| Review request after confirmed completion | reputation_builder | event: `acceptance.confirmed` | `communicate` \| that agreement \| once, after confirmation only \| — \| `pre_authorized` |

**Never**: quote below the private floor; contact a homeowner outside an accepted introduction or RFQ; send a home-improvement contract without the cancellation notice and licence number the state facets require; offer anything in exchange for a review; ask for a review before the counterparty confirmed completion; deviate from the country's consumer terms when the client is a consumer.

**Agent-to-agent**: a homeowner's agent publishes an RFQ invitation; the contractor's agent asks `clarify` ("is scaffolding available on site?"), the answer is attached to the RFQ version, the quote draft waits for the owner.

**Reports**: weekly pipeline (invitations, quotes sent, won, lost with reasons); cash calendar from obligations.

**KPIs (private, company)**: win rate; invitation response time; weeks booked ahead; days to payment; share of completions confirmed with evidence.

### 4. General contractor

Buys packages of works from subcontractors and materials from suppliers, sells to developers and public clients, and carries the schedule.

**Goals**: "Assemble facade, MEP and roofing subcontractors for project Riverside Elementary (Austin, US-TX) by March"; "Keep procurement inside the project budget"; "Record every change with its reason"; "Answer developer tenders".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Subcontractor discovery per work package | discovery | goal | `research` \| project needs \| eligibility: region, licence, screening; verified or claimed \| — \| none |
| Introductions to shortlisted firms | introductions | goal step | `introduce` \| project needs \| ≤ 10 open within quota \| — \| `ask_first(3)` |
| RFQ packages from a bill of quantities | need_intake | request | `prepare`, `publish` (RFQ) \| project \| evidence per line; buyer-private weights stay private \| platform budget for large files \| publish `ask_each` |
| Honest comparison and negotiation | procurement, negotiation | event: `quote.received`; RFQ deadline | `negotiate` \| RFQs of the project \| within private ceilings; ≤ 6 rounds \| — \| `pre_authorized` within the ceiling; counters that change scope `ask_each` |
| Orders within the project budget | procurement | agreement accepted | `place_order` \| project, category Materials \| ≤ USD 500,000 per order; verified suppliers; delivery before March 1 \| project transaction budget \| `ask_above(USD 150,000)`, two company approvers above USD 350,000 |
| Participant updates and change records | project_desk | schedule: weekly; event: `change.requested` | `communicate`, `prepare` \| project contexts \| change records name who asked and why \| — \| change records `ask_each` |
| Hidden-works stage acceptance | execution_clerk | event: `milestone.due` | `record_evidence`, `communicate` \| project agreements \| — \| — \| confirmation stays `human_only` |
| Tender responses as a seller | quoting | event: `rfq_invitation.received` from developers | `send_quote` \| selector \| — \| — \| `ask_each` |
| Subcontractor licence and insurance status before invitation | compliance_checker | goal step; deadline before mobilisation | `research` \| invited subcontractors \| state licence lookup and certificate-of-insurance expiry where the hub configured them; unknown shown as unknown \| platform budget for pass-through checks \| none |

**Never**: show one subcontractor's price to another or use it as a lever ("bid shopping" through the platform); split an order to stay under an approval threshold (the anti-splitting guard applies to every buyer); record a client-caused delay as a subcontractor's delay; track individual workers.

**Agent-to-agent**: GC agent `request_proposal` to a subcontractor's representative → `propose` (quote v1) → `counter` referencing lines 4 and 7 → quote v2 → acceptance by the approvers. Later `request_confirmation` of a stage act goes to the subcontractor; the GC's own confirmation of the subcontractor's claim is a human decision.

**Reports**: weekly procurement board (packages planned, invited, quoted, awarded); budget against commitments (private); change log; evidence gaps.

**KPIs (private, company)**: packages awarded against plan; procurement cycle time; budget variance; changes recorded with reasons; evidence completeness per stage.

### 5. Subcontractor or installer firm

Sells installation and works; lives from GC invitations; gets paid on documented acceptance.

**Goals**: "Get invited to facade packages of contractors in my region"; "Keep crews busy without overbooking"; "Document hidden works so we get paid"; "Become a certified installer of system X".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Capacity and availability on the capability profile | profile_keeper | schedule: weekly | `maintain_profile` \| company profile \| capacity ranges only, no names \| — \| `pre_authorized` for availability |
| Watch GC needs and partner posts | opportunity_watch | event | `research` \| selector \| — \| — \| none |
| Quotes on invitations | quoting | event: `rfq_invitation.received` | `send_quote` \| selector \| labor-rate catalogue; floor private \| — \| `ask_above(USD 100,000)` |
| Order acceptance within capacity | order_desk | event: `order.placed` | `accept_order` \| agreements of the company \| only if the schedule has capacity; verified buyers \| — \| `ask_each` until `ask_first(5)` passes |
| Stage evidence | execution_clerk | event: `milestone.due` | `record_evidence` \| agreements \| photos with dates and grid references or locations \| — \| `ask_first(5)` |

**Never**: expose crew members' personal data; accept beyond capacity; align prices or territories with competing installers; see employees' learning progress (only certificates a holder chose to show).

**Agent-to-agent**: a manufacturer's representative announces a certification course; the firm's agent posts it in the company context for members to decide individually.

**KPIs (private, company)**: invitations received; quote-to-award; stage acceptances confirmed on time; days to payment.

### 6. Supplier or distributor

Sells goods from stock and on order; competes on response time, availability and terms.

**Goals**: "Answer every invitation in my categories within 24 hours"; "Keep catalogue and availability current"; "Find distribution partners in Mexico and Canada through peered hubs"; "Accept routine reorders without me".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Quotes from price lists | quoting | event: `rfq_invitation.received` | `send_quote` \| selector: categories Facade panels, Insulation \| catalogue lines only; ≤ USD 250,000; buyer claimed or verified \| — \| `ask_above(USD 50,000)` |
| Revalidate quotes after an RFQ amendment | quoting | event: `rfq.amended` (quotes flagged `stale_reason: rfq_amended`) | `send_quote` \| affected RFQs \| new version against the current RFQ version only \| — \| `ask_each` |
| Price-list update to offering versions | profile_keeper | request; schedule | `publish` \| catalogue offerings \| public fields allowlist \| — \| `ask_each` |
| Negotiation inside floors | negotiation | event: `counter.received` | `negotiate`, `send_quote` \| quotes of the company \| never below the private floor; ≤ 6 rounds \| — \| `pre_authorized` within floor |
| Reorder acceptance | order_desk | event: `order.placed` | `accept_order` \| agreements \| in-stock catalogue items; ≤ USD 40,000; verified buyers \| — \| `pre_authorized` |
| Delivery notes | execution_clerk | event: `delivery.dispatched` | `record_evidence` \| orders \| — \| — \| `pre_authorized` |
| Distribution partners abroad | discovery, introductions | goal | `introduce` \| partner posts on peered hubs at `deal-routing` \| ≤ quota; screening clear \| — \| `ask_each` |
| Knowledge profile and plan-step answers | representative, plan_step_companion | event: `step_question.received` in the company's categories | see [knowledge partners](#manufacturers-and-suppliers-as-knowledge-partners) |

**Never**: quote below the floor or reveal it; change a sent quote (a new version is sent instead); answer a superseded RFQ version; coordinate prices, territories or customers with other distributors; claim availability the catalogue does not show.

**Agent-to-agent**: buyer's agent `clarify` about the fire class of line 3 → supplier's agent `answer` attached to the quote version with the test report reference → buyer's agent `counter` on price → supplier's agent proposes quote v2 within the floor, or escalates.

**Reports**: daily invitations and response times; weekly conversion by category; stale quotes revalidated.

**KPIs (private, company)**: response time; hit rate per category; quote-to-order conversion; on-time deliveries confirmed.

### 7. Manufacturer

Makes systems (facade kits, insulation, fixings); sells through distributors and directly; needs installers who install correctly and designers who specify correctly.

**Goals**: "Grow a network of certified installers in Texas and the Southwest"; "Get our system specified by design offices"; "Answer technical questions in projects where we take part"; "Publish installation guidance".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Installer course and assessment | course_studio | request | `prepare`, `publish` (course version) \| company courses \| labelled company-authored \| — \| `ask_each` |
| Technical articles and guidance | content_writer | schedule: monthly | `prepare`, `publish` \| company publications \| labelled company, sources cited \| — \| `ask_each` |
| Design-office and installer discovery | discovery, introductions | goal | `research`, `introduce` \| selector \| ≤ quota; purpose stated \| — \| `ask_first(3)` |
| Technical answers in projects | quoting | event: `clarification.requested` in contexts where the company participates | `communicate` \| those contexts \| structured answer with document refs \| — \| `ask_each` |
| Open day on the plant | organizer_desk | request | see [type 13](#13-event-organizer) |
| Product certificates and test reports validity | compliance_checker | deadline | `research` \| company documents \| — \| — \| none |
| Knowledge profile: catalogues, installation guides, training, events; answers to plan-step questions | representative, plan_step_companion | event: `step_question.received`; schedule: monthly content review | see [knowledge partners](#manufacturers-and-suppliers-as-knowledge-partners) |

**Never**: learn which installer passed or failed a course (completion data is private; certificates are public only as their holders choose); present advertising as editorial; let sponsorship or payment influence anyone's matching; read distributors' private floors or their customers' data.

**Agent-to-agent**: a design office's agent sends `request_proposal` for specification data and budget pricing; the manufacturer's representative `answer`s with references to published technical documents and a quote draft for approval.

**KPIs (private, company)**: certificates issued on own courses (counts); specification inquiries; technical answer turnaround; content reach as aggregate counts only.

### 8. Design office

Sells design services; specifies systems; coordinates design changes during construction.

**Goals**: "Win design commissions from developers in the Dallas–Fort Worth area"; "Find curtain-wall manufacturers with documentation in English and Spanish"; "Keep our licences and portfolio current"; "Get design change notices acknowledged quickly".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Design competitions and service tenders | opportunity_watch | event: imported procurement notices, needs | `research`, `prepare` \| selector \| — \| — \| none |
| Fee proposals | quoting | event: `rfq_invitation.received` | `send_quote` \| services RFQs \| services catalogue lines \| — \| `ask_each` |
| Manufacturer discovery with test reports | discovery | request | `research` \| — \| cited answers only \| — \| none |
| Design change notices | project_desk | request | `communicate`, `prepare` \| project contexts \| change records with reasons \| — \| `ask_each` |
| Portfolio and project stories | profile_keeper, content_writer | event: `project.completed` | `maintain_profile`, `publish` \| — \| client consent recorded \| — \| `ask_each` |

**Never**: publish client project data without consent; favour a manufacturer because of sponsorship; accept a commission without approval.

**Agent-to-agent**: a developer's agent `request_proposal` for design services → office agent `clarify` on scope stages → fee quote draft.

**KPIs (private, company)**: proposals sent and won; hours from invitation to proposal; change notices acknowledged; portfolio items approved by owners.

### 9. Developer or client company

Owns the project and the money; selects general contractors and designers; carries payment discipline as part of its own reputation.

**Goals**: "Select a general contractor for residential building B by June"; "Keep commitments inside the approved budget"; "Track milestones with evidence, not with phone calls"; "Pay on time".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Tender package for a general contractor | need_intake | request | `prepare`, `publish` (RFQ) \| project \| buyer-private evaluation weights and ceiling stay private \| platform budget for large files \| publish `ask_each` |
| Eligible candidates | discovery, compliance_checker | goal | `research` \| project needs \| state licence, verified badge, screening, reputation **with sample sizes**; unknown shown as unknown \| — \| none |
| Honest comparison | procurement | RFQ deadline | `research` \| RFQs of the project \| exclusions and non-comparable scope shown; historical quotes unranked \| — \| none |
| Negotiation inside the ceiling | negotiation | event: `quote.received` | `negotiate` \| RFQs \| never reveals the ceiling; ≤ 6 rounds \| — \| `ask_each` for any counter that changes scope |
| Agreement and order | procurement | decision | `place_order` \| project \| transaction budget of the project \| — \| `ask_each`; two company approvers above USD 1,000,000 |
| Milestones and payment obligations | project_desk, execution_clerk | schedule: weekly; event: `obligation.due` | `communicate`, `prepare` \| project agreements \| reminders to the company's **own** payers first \| — \| `pre_authorized` for internal reminders |

**Never**: reveal the budget ceiling or evaluation weights; disclose one bidder's quote to another or invite a "best and final" by quoting a competitor; use the agent to watch contractors' workers; publish contractors' prices.

**Agent-to-agent**: GC representatives `propose`; the developer's agent compares and drafts a `counter` on exclusions; the approvers accept; acceptance events bind the agreement digest.

**Reports**: tender status per package; commitments against budget (private); milestone evidence; own payment timeliness.

**KPIs (private, company)**: tender cycle time; comparable bids per package; budget variance; milestones confirmed on time; own days to pay.

### 10. Private homeowner

A consumer with one project, little time and no procurement experience. The free floor is designed to be enough: the homeowner's agent is the clearest example of an agent working **for** a person who is otherwise the weaker party.

**Goals**: "Re-roof my house in Austin before the storm season: find two or three trustworthy, licensed contractors and help me understand their quotes"; "Keep every document of the job"; "Remind me about the warranty".

For a whole build or a large renovation the homeowner starts from the [plan to people](#flagship-journey-from-plan-to-people) journey: `project_planner` drafts the plan, `consultation` books advice, `task_marketplace` turns plan items into tasks. The jobs below are the single-trade case.

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Describe the job clearly | need_intake | request (photos, a description) | `prepare`, `publish` (need) \| own project \| address hidden until an introduction is accepted; units and scope asked for \| — \| `ask_each` |
| Find licensed, verified contractors nearby | discovery, compliance_checker | goal | `research` \| — \| state licence where configured; verified or claimed badge; reputation with samples \| — \| none |
| Introductions | introductions | goal step | `introduce` \| own need \| ≤ 5 open \| — \| `ask_each` |
| Site visit scheduling | event_networking | event: `introduction.accepted` | `schedule` \| that introduction \| — \| — \| `ask_each` |
| Plain-language comparison | procurement | event: `quote.received` | `research` \| own RFQ \| exclusions, unknowns and taxes explained; no ranking by price alone \| — \| none |
| Sign and pay | procurement | decision | `place_order` \| own project \| transaction budget \| — \| **always a person's decision for a consumer** (`human_only` in consumer mode) |
| Job documents and warranty | execution_clerk | event: `acceptance.recorded`; deadline before warranty ends | `record_evidence` \| own agreements \| — \| — \| `pre_authorized` |

**Consumer mode** applies whenever one side is a private person: a seller's agent must show the total price with taxes, the cancellation rights the state facets require and a minimum quote validity (no false urgency); it may not counter more than the hub's consumer round limit; and the consumer's own commitments are never pre-authorized.

**Never**: commit without the homeowner's decision; reveal the address or phone before an introduction is accepted; push a paid plan; draft the subjective text of a review (the agent may prefill dates and scope from the agreement; the opinion is typed by the person).

**Agent-to-agent**: a roofer's agent proposes three site-visit slots (`propose_slots`); the homeowner's agent shows them in the homeowner's calendar; the homeowner picks one.

**Reports**: one page per job: quotes received and what each excludes, decisions taken, documents.

**KPIs (private)**: comparable quotes received; days from need to signed agreement; spend against own budget; documents complete.

### 11. Public or institutional client

A school district, a city, a state agency, a university. Statutory procurement law governs them; the platform helps prepare and keep things transparent, and **never replaces the official procedure**.

**Goals**: "Run market research for the roof replacement at Lincoln Middle School"; "Prepare a specification with cited codes"; "Answer every bidder's question to all bidders at the same time"; "Track execution with evidence".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Market research notice (sources sought) | public_tender_desk | request | `publish` (open need labelled "market research, not a solicitation") \| project \| — \| — \| `ask_each` |
| Specification draft | public_tender_desk | request | `prepare` \| project \| cites codes and standards the hub may cite; flags brand-name requirements \| — \| — |
| Watch the official notice and awards | opportunity_watch | event: imported SAM.gov or state portal items about the body's own notices | `research` \| — \| — \| — \| none |
| Equal-treatment clarifications | public_tender_desk | event: `clarification.requested` | `communicate` \| the RFQ or notice \| answers go to **all** invited parties at once as a structured Q&A on the version \| — \| `ask_each` |
| Anti-splitting guard | public_tender_desk | event: new need or RFQ in the same category within the facets' look-back window | `research` \| body's own needs \| thresholds from facets \| — \| none (warning to approvers) |
| Execution evidence | execution_clerk | event: `milestone.due` | `record_evidence`, `communicate` \| agreements \| — \| — \| confirmation `human_only` |

**Never**: submit to SAM.gov or a state portal, award, or sign (`human_only`, outside the platform); negotiate where the procedure forbids it; tell one bidder anything not published to all; schedule meetings with bidders of an open procurement (quiet period: the agent declines `schedule_meeting` from them and says why); recommend splitting.

**Agent-to-agent**: a bidder's agent sends `clarify`; the public body's agent queues it without identifying the bidder to others; after approval the `answer` is published to every invited party simultaneously.

**Reports**: market research responses (counts and capability summaries); clarification log; execution evidence.

**KPIs (private, body)**: responses to market research; clarification turnaround; share of answers published to all; evidence completeness. Hubs may offer this module free to public bodies.

### 12. Editor, author or expert

Independent authors and experts publish under their own name; hub editors also work as staff (see [type 15](#15-hub-operator-staff)) and use `editorial_desk` there.

**Goals**: "Publish two practical articles a month"; "Answer questions on hidden-works acceptance"; "Correct fast when a source changes"; for editors, "Clear the source queue every morning and prepare Friday's issue".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Draft with sources | content_writer | request; schedule | `prepare` \| own publications \| every factual claim cited; unsupported claims flagged \| — \| — |
| Publish | content_writer | decision | `publish` \| own publications \| assistant-assisted label kept \| — \| `ask_each` (editorial publications are always a person's decision) |
| Spanish edition | translation | event: `publication.published` | `prepare`, `publish` \| linked editions \| machine-assisted label until a person reviews \| platform budget beyond quota \| `ask_each` |
| Correction proposals | content_writer | event: a cited source issued a new version | `prepare` \| own publications \| correction note drafted \| — \| `ask_each` |
| Source queue triage (editors) | editorial_desk | schedule: daily | `prepare` \| hub source items \| sources licensed for display only are never sent to a model provider \| — \| — |
| Magazine issue draft (editors) | editorial_desk | schedule: weekly | `prepare` \| issue draft \| — \| — \| release by the editor-in-chief |
| Consultations and mentoring (experts) | consultation | event: `consultation.requested` | `schedule`, `send_quote` \| own consultation offerings \| scope, languages, calendar; own price list \| — \| propose `pre_authorized`, accept `ask_first(5)` |
| Turn experience into checklists and templates | knowledge_sharing | event: a consultation or project completed | `prepare`, `publish` \| own contributions \| client data removed; client consent where the client is identifiable \| — \| `ask_each` |

**Never**: publish without a person's decision; invent quotes, sources or interviews; send licence-restricted text to a model provider; write under someone else's name; remove the assistance label; optimise for outrage.

**Agent-to-agent**: a company's representative sends a press release to the hub's press-release inbox; it becomes an untrusted source item; the editor's agent drafts a summary with attribution, the editor decides.

**KPIs (private)**: drafts published; corrections and time to correct; readership as aggregate counts only (never reader lists); expert answers accepted.

### 13. Event organizer

A person, a company or the hub's editorial team running conferences, trade shows, meetups, site visits and open days.

**Goals**: "Run the facade conference on April 12 with 300 attendees"; "Fill the waitlist"; "Help attendees meet with purpose"; "Publish materials within a week".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Event and programme draft | organizer_desk | request | `prepare`, `publish` (event) \| own events \| hub hosting policy \| — \| `ask_each` |
| Speaker invitations | organizer_desk | request | `communicate` \| event \| structured speaker consent request; nothing public before consent \| — \| `ask_each` |
| Ticket types and price versions | organizer_desk | request | `prepare` \| event \| — \| — \| price activation by a person |
| Waitlist promotion | organizer_desk | event: `registration.cancelled` | `communicate` \| event \| within capacity; promotion offers expire \| — \| `pre_authorized` |
| Announcements and reminders | organizer_desk | schedule | `communicate` \| registrants only, from templates \| — \| — \| `pre_authorized` for templates |
| Meeting slot allocation | organizer_desk | event: `meeting_request.accepted` | `schedule` \| rooms and slots \| sees counts and slots, never request contents or declines \| — \| `pre_authorized` |
| Refunds outside policy | organizer_desk | request | `communicate` \| registrations \| through the payment adapter; unknown outcomes reconciled \| — \| `ask_each` |
| Materials and attendance certificates | organizer_desk | event: `event.finished` | `publish` \| event materials \| — \| — \| `ask_each` |

**Never**: write to people who did not register; export attendee fields beyond their consent; show who declined whom; let sponsors buy listing position; inflate registration numbers.

**Agent-to-agent**: attendees' agents send `schedule_meeting` to each other; the organizer's agent only allocates rooms. An exhibitor's representative proposes booth meeting slots to attendees who opted in.

**KPIs (private)**: registrations, check-ins and waitlist conversion; meetings held (counts); own revenue; days to publish materials.

### 14. Course author or trainer

Experts, trainers, manufacturers and the hub's editorial team teaching practical skills.

**Goals**: "Publish a course on cold-weather concreting in English and Spanish"; "Keep the assessment fair"; "Answer learner questions within two days"; "Update the course when the code changes".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Course and lesson drafts | course_studio | request | `prepare` \| own courses \| — \| — \| — |
| Assessment items and answer keys | course_studio | request | `prepare` \| course version \| reviewed by the author before publication \| — \| — |
| Publish a course version | course_studio | decision | `publish` \| course \| hub review policy \| — \| `ask_each` |
| Spanish edition | translation | event: `course.published` | `prepare` \| linked edition \| machine-assisted label \| platform budget beyond quota \| — |
| Learner question drafts | course_studio | event: `course_question.asked` | `communicate` \| course context \| learner identity only as the course discloses \| — \| `ask_first(5)` |
| Update proposals when a cited code changes | course_studio | event: source new version | `prepare` \| course \| new course version, never edits a certified one \| — \| `ask_each` |
| Accreditation application pack | course_studio | request | `prepare` \| course \| for the hub's accreditation record \| — \| — |

**Never**: issue or revoke certificates (rules and people do); grade with hidden criteria; see learners' progress beyond what the course design discloses; claim an accreditation that has no recorded source.

**Agent-to-agent**: a manufacturer's representative offers to sponsor free seats (structured sponsorship offer); the author decides; the sponsor never learns who enrolled.

**KPIs (private)**: enrolments; completion and pass rates as aggregates; question turnaround; editions available.

### 15. Hub operator staff

Data stewards, trust reviewers, editors, moderators, commercial admins, support, ops engineers and compliance officers. A staff member uses **their own single agent** inside the administration surface; the surface sets the staff principal, so there is no switcher. Staff mandates are separate from personal mandates and stop when the staff role ends.

**Goals**: "Clear the claims queue within two business days"; "Prepare evidence for the launch gates"; "Keep imported sources within their licences".

| Job | Role | Trigger | Mandate |
|---|---|---|---|
| Source import triage and licence flags check | Data steward | event: `import_batch.ready` | `prepare` \| batch \| — \| — \| activation by a person |
| Claim evidence checklist against the recipe | Trust reviewer | event: `claim.submitted` | `prepare` \| claim evidence visible to the role \| — \| — \| decision by a person |
| Moderation case summary with rule clauses | Moderator | event: `report.received` | `prepare` \| case \| — \| — \| decision by a person |
| Price version draft | Commercial admin | request | `prepare` \| offers \| — \| — \| activation by a second person |
| Launch gate evidence pack | Compliance officer | request | `prepare` \| launch gates \| — \| — \| — |
| Provider, queue and dispatch anomaly summary | Ops engineer | schedule: daily | `research` \| operational counts \| — \| — \| kill switch pulled by a person |
| Support diagnostics | Support | request | `research` \| non-private diagnostics \| — \| — \| — |

**Never**: decide a claim, a sanction, an appeal, a reputation method or a price activation (all `human_only`); request or approve a case grant; read private data outside an active case grant; use staff-case data at all unless the case grant explicitly allows assistant use **and** the hub's egress matrix allows that data class for the provider (both off by default); produce per-person behaviour analytics; impersonate anyone.

**KPIs (operational, aggregate)**: queue age; time to decision; reversal rate on appeal; launch gates closed. Never per-person productivity of staff.

### 16. Company standing representative

The company's one representative ([Company representation](agents.md#company-representation)), with an accountable person and company mandates only. It is the front desk of the company, not a person's agent.

**Goals set by authorized members**: "Answer every invitation and introduction request within one business day"; "Keep the catalogue current"; "Book meetings for us at the Dallas trade show"; "Accept repeat orders within limits"; "Send me a Monday report".

| Job | Module | Trigger | Mandate |
|---|---|---|---|
| Triage incoming invitations, introductions and meeting requests | representative | event | `research`, `prepare` \| company contexts \| routes by category to named approvers \| — \| — |
| Answer within company mandates | representative + quoting, order_desk, event_networking | event | company mandates as for types 3–9 \| — \| company budgets only \| as granted |
| Route decisions to people | representative | any action needing approval | appears in the named approvers' own assistant, never in a shared inbox |
| Continuity after a member leaves | representative | event: `membership.ended` of a granting member | the mandate suspends unless another authorized member re-confirms it within 7 days |
| Weekly report to the accountable person | representative | schedule: weekly | — |

**Never**: exceed the company's current grants; act while no accountable person exists; claim to be a person; read members' personal agents, goals or private data; inherit a leaver's personal mandates; monitor employees.

**Agent-to-agent**: every message reads "Representative of Sample Facades LLC (accountable: Jordan Example)"; counterparties' agents treat it as untrusted content like any other agent.

**KPIs (private, company)**: median response time; age of decisions waiting; invitations answered; conversion; mandates awaiting re-confirmation.

## How agents meet: interaction patterns

All agent-to-agent traffic is [agent envelopes](agents.md#agents-talking-to-agents) that reference structured objects; the note is untrusted for the receiver. The catalogue uses the existing intents (`request_proposal`, `propose`, `counter`, `clarify`, `answer`, `accept`, `decline`, `withdraw`, `schedule_meeting`, `introduce`) and proposes four more:

| New intent | Purpose | Moves state only through |
|---|---|---|
| `propose_slots` | Offer time slots for a meeting or site visit | A `schedule` action of the receiver |
| `request_confirmation` | Ask the counterparty to confirm an execution assertion | A `confirm_execution` decision by a person (`human_only`) |
| `express_interest` | Lightweight interest in an open need | The need owner's list of interested parties |
| `step_question` | Anonymous-by-default question about one plan step to a manufacturer or supplier | Nothing: the answer is untrusted content for the asker |

Canonical flows:

```text
Quote:          buyer agent ─request_proposal(RFQ v2, digest)→ seller agent
                seller agent ─clarify(line 3)→ buyer agent ─answer(attached to RFQ v2)→ seller agent
                seller agent ─propose(quote v1, digest)→ buyer agent ─counter(lines 4, 7)→ …
                acceptance events bind the agreement digest; each side checks its own mandate

Introduction:   requester agent ─introduce(purpose, context)→ recipient agent
                recipient's person or mandate accepts → thread opens in the introduction context

Event meeting:  attendee agent ─schedule_meeting(event, slot)→ attendee agent
                organizer agent allocates the room; never sees the request content

Execution:      seller agent ─request_confirmation(assertion, evidence refs)→ buyer agent
                buyer's person confirms or disputes

Public clarification: bidder agent ─clarify→ public body agent
                public body publishes answer on the version → every invited party receives it at once
```

Rules every module obeys:

- **Competition firewall.** Agents of competing sellers never receive each other's prices, terms or even participation in an RFQ. A buyer's agent never quotes one seller's price to another. No module computes "market prices" from private quotes; price references come only from public catalogue fields and licensed sources.
- **Refuse collusive goals.** Goals or mandates that ask the agent to agree prices, divide customers or territories, rig bids or exchange competitively sensitive information are refused with an explanation and a pointer to the hub's competition-law note. Repeated attempts open a case for a person to review; they never trigger an automatic sanction.
- **Sessions end.** Every negotiation session has a maximum number of rounds and an expiry; deadlock escalates to the people on both sides.
- **Labels everywhere.** The receiver's person sees "proposal from Anna's agent on behalf of Sample Facades LLC" in the hub's disclosure text for their language.
- **Cross-node.** Between nodes, envelopes travel only at `deal-routing` peering to the counterparty's home node; mandates, budgets and approvals stay at home ([Federation](federation.md#agents-across-nodes)).

## One assistant surface for every participant

The agent keeps one surface: the full assistant page and the floating overlay, one conversation and one state ([One agent, one surface](agents.md#one-agent-one-surface)). The catalogue adds content to it, never a second surface.

### Regions of the surface

| Region | What it shows | Notes |
|---|---|---|
| Conversation | Requests, answers with citations, proposals | Chat proposals become structured forms; nothing in chat authorizes |
| Decisions waiting ("Your decision is needed", `decision.kicker`) | Each pending action with its exact effect, amount, counterparty, digest-bound approve and decline | Sorted by deadline; the same list for every plan |
| Goals | Active goals with plan, progress log and evidence | Pause, edit, close with an outcome |
| Mandates | Every active, suspended and expiring mandate in plain language, with the job that uses it | Revise, suspend, revoke; expiring ones surface a week ahead |
| Runs | What the agent did, step by step, with evidence and meters consumed | Includes runs started by a connection, labelled with its name |
| Reports | Weekly and on-demand reports as drafts | Shareable by the person, private by default |
| Plans | The plan of each project the person owns, with the current step, its recommendations and the requests it became | Lives on the project; the assistant shows the current step and the decisions it needs |
| Reputation | What the person has built and what would strengthen it, with the passport | Private coaching; the public profile shows only what the method and the person allow |
| What my agent can do | The modules enabled in the hub and entitled to the payer, shown as abilities with the jobs they offer | Turning a job on opens a mandate proposal; there are no per-module agents to configure |
| Connections | External agents and channels connected to this agent | In settings, next to sessions; revoke one or all |
| Settings | The person's detailed agent settings (ADR 010 decision 22): goals, modules, behaviour and tone, mandates and limits per action, budgets, schedules, channels, approval rules, what to share with whom, external connections | Each setting has a preview of what the agent would do and a plain-language explanation; settings compile into mandate proposals and never authorize by themselves (AGT-022) |
| Stop | Suspends all mandates and all connections at once | Always visible, never paid, never hidden |

### What each participant sees first

The surface is the same; the first cards differ by the participant-type lens, which the person can change.

| Participant | First cards |
|---|---|
| Individual professional | Expiring credentials, profile freshness, upcoming events with suggested meetings |
| Job seeker or freelancer | New engagements with reasons, applications and their states, interviews |
| Small contractor | Invitations to answer today, quotes waiting for approval, payments due |
| General contractor | Procurement board per project, decisions above thresholds, evidence gaps |
| Subcontractor | Invitations, orders to accept against capacity, stage acts due |
| Supplier or distributor | Invitations by deadline, stale quotes to revalidate, reorders accepted |
| Manufacturer | Technical questions in projects, course and content drafts, specification inquiries |
| Design office | Service tenders, proposals due, change notices awaiting acknowledgement |
| Developer | Tender status, commitments against budget, milestones and own payments |
| Homeowner | "Your project" card: current plan step, recommendations for it, quotes explained, next decision |
| Public client | Clarifications to answer to all, anti-splitting warnings, market research responses |
| Editor or author | Drafts and corrections; for editors, the source queue and the issue draft |
| Event organizer | Registrations, waitlist, speaker consents, materials due |
| Course author | Learner questions, assessment drafts, update proposals |
| Hub staff | Queues for their role with drafted summaries (in the administration surface) |

Company representative: configured and observed on the company page ("Company" → "Representative"); its decisions arrive in the named approvers' own assistant. Members with the right see its activity there. There is no list of agents anywhere.

Accessibility and small screens are part of done: every region is keyboard-operable and announced to screen readers; decisions can be approved on a phone with the full effect visible; all text comes from locale files in every hub language, dates, numbers and money through `Intl`.

### Onboarding

The optional onboarding question "what do you want to do" (read, publish, buy, sell, find work, host events, teach) sets the participant-type lens and suggests two or three goal templates. It creates **no** mandate: the first job the person turns on shows the mandate it needs in one structured screen, prefilled from the module's template, with the limits empty until the person chooses them.

## Connect your own agent: MCP and A2A

Many participants already work with a general-purpose agent (Claude, ChatGPT, a custom agent, an ERP integration). They can connect it to their Trustwork agent identity. A connection is **another hand of the same agent**: it acts as that person's agent, under that person's mandates, quotas, labels and kill switches. It is never a second agent and never an authority of its own.

Two directions, two protocols:

| Direction | Protocol | Purpose |
|---|---|---|
| The participant's own external agent → their Trustwork agent | **MCP** (Model Context Protocol) server exposed by the node | Read the briefing, decisions, contexts; draft; propose; act inside bound mandates |
| Another participant's agent ↔ this participant's Trustwork agent | **A2A** (Agent2Agent) gateway mapped to agent envelopes | Interoperate with agents built elsewhere, under the same envelope rules |

Exact protocol versions are pinned in the implementing work package; the engine ships both behind adapters with fakes, and no external call happens in tests.

**The MCP side is now designed in full** in [The MCP server](mcp-server.md) and [ADR 013](../adr/013-mcp-server.md) (2026-10-31): the tool catalogue is the shared capability registry (ADR 010 decision 23, full parity) and covers every participant-facing module; protocol revision 2026-07-28 over Streamable HTTP; the hub's own authorization server with Client ID Metadata Documents (Dynamic Client Registration only as a fallback); toolsets; on-site confirmation of commitments through URL-mode elicitation; public and admin surfaces. Where this section and the chapter differ, the chapter wins; the tool list below is the earlier proposal.

### Registration and consent

```text
person opens Settings → Connections → "Connect an agent"
  → the external client identifies itself (a Client ID Metadata Document, or dynamic client registration as a rate-limited fallback; the client name is self-asserted and labelled "unverified" unless the hub lists it)
  → authorization code flow with PKCE on the hub's origin, step-up required
  → consent screen: client name, redirect URI, requested scopes, mandates to bind, data classes, rate limits, expiry
  → person confirms; the connection record is created; tokens are issued for the MCP resource only
```

- **Audience-bound tokens.** Access tokens are opaque, short-lived (proposal: 15 minutes), stored only as hashes like sessions, and valid only for the node's MCP resource (resource indicators). Refresh tokens rotate; reuse of an old refresh token revokes the whole connection. Sender-constrained tokens (DPoP) are used where the client supports them.
- **The MCP endpoint never accepts cookies**; first-party session cookies never authorize MCP or A2A calls, and bearer tokens never authorize the first-party web API.
- A hub sets the maximum number of connections per person (free floor: one) and may list known clients; listing is informational and never grants extra scope.

### Scopes and mandate binding

| Scope | Allows | Default |
|---|---|---|
| `read.public` | Public projections: directories, events, publications, public catalogue fields | Granted |
| `read.me` | The person's own briefing, decisions waiting, goals, mandates, runs, reports | Granted |
| `read.contexts` | `shared_party` views of contexts the person participates in | Asked |
| `read.private:<class>` | The person's own `party_private` or `owner_private` data, per class (for example `negotiation_constraints`, `budgets`, `private_projects`) | **Off**; each class is opted in separately with a warning that the data leaves the hub's residency guarantees |
| `propose` | Create drafts, goal proposals, mandate change proposals and action intents that wait in decisions | Asked |
| `act` + mandate bindings | Execute action intents **only** within the listed mandates (bound by id and revision as rich authorization details) | Asked, per mandate |

What a connection can **never** do, whatever its scopes: approve or decline a decision; confirm, widen or create a mandate; perform step-up; change credentials, e-mail, memberships or company roles; accept a price version, legal terms or a plan; request a case grant; export in bulk; press or release a kill switch; disable the stop control. Those exist only on the first-party surface.

If a bound mandate is revised, suspended or revoked, the binding stops at once (authorization epoch); the connection must be re-consented to bind the new revision.

### Tools exposed over MCP (proposal)

Superseded by the [tool catalogue](mcp-server.md#tool-catalogue) of the MCP chapter, which keeps every tool below under a domain-prefixed name. Tools appear only when the hub enabled and the payer is entitled to the module behind them.

| Tool | Scope | Module |
|---|---|---|
| `get_briefing` | `read.me` | core |
| `list_decisions`, `get_decision` | `read.me` | core |
| `list_goals`, `propose_goal` | `read.me`, `propose` | core |
| `list_mandates`, `propose_mandate_change` | `read.me`, `propose` | core |
| `search_public`, `get_public_card` | `read.public` | core |
| `ask_cited` | `read.public` (+ `read.contexts`) | core |
| `run_match`, `list_candidates` | `read.public`, `propose` | discovery |
| `list_opportunities` | `read.public` | opportunity_watch |
| `draft_need`, `draft_rfq` | `propose` | need_intake |
| `draft_quote`, `list_invitations` | `read.contexts`, `propose` | quoting |
| `propose_action` | `propose` or `act` | any; executes immediately only when a bound mandate pre-authorizes it, otherwise lands in decisions |
| `get_run`, `get_report` | `read.me` | core |
| `draft_publication`, `draft_translation` | `propose` | content_writer, translation |
| `list_events`, `propose_meetings` | `read.public`, `propose` | event_networking |
| `get_plan`, `propose_plan_change`, `list_step_recommendations` | `read.me`, `propose` | project_planner, plan_step_companion |
| `request_consultation`, `draft_task` | `propose` | consultation, task_marketplace |
| `explain_reputation`, `list_evidence_gaps`, `draft_confirmation_request` | `read.me`, `propose` | reputation_builder |

Tool results carry the projection layer they came from, and every text field that originated from another party is marked as untrusted content for the external model.

### A2A gateway

- A principal may publish an **Agent Card** for their agent only if their profile is public and they opt in. It names the agent with the stable label ("Anna's agent"), the intents it accepts and the authentication schemes; it reveals no mandate, limit or plan.
- **Authentication.** State-moving tasks require the sender to be a Trustwork principal: either a connection token of a person on the same node, or a peer node's signature at `deal-routing` peering. Agents that are not Trustwork principals may only call public read skills (public card, public catalogue fields, public events) at low rate limits. There is no anonymous outreach.
- **Mapping.** An A2A task maps to a negotiation session or an introduction; structured data parts are validated against the envelope contract; text parts become the untrusted note; files are quarantined, scanned and stored as untrusted attachments.

### Audit, rate limits and revocation

| Concern | Design |
|---|---|
| Audit | Every call writes a `connection_call` record: connection, token family, tool, digest of the arguments (not the arguments themselves), result code, mandate and action intent refs, time. The person sees it in Runs; staff only through a case grant |
| Rate limits | Per connection and per principal, token buckets by tool class (proposal: read 60 per minute, propose 20 per minute, act 30 per hour, 3 concurrent runs), plus the anti-scraping cap on public records per day; `429` with retry-after; limits are protection and identical across plans except where a plan raises read and propose capacity |
| Circuit breaker | Repeated denials, loops or injection signatures suspend the connection and notify the person |
| Revocation | One connection, all connections, or the stop control; password change and account recovery revoke all connections; ending a membership removes company bindings; the hub kill switch blocks dispatch from connections too. In-flight intents not yet executing are revoked; executing ones go to reconciliation |
| Expiry | Unused connections expire after a hub-set period (proposal: 90 days); refresh tokens have an absolute lifetime |
| Company integrations | A company may connect one system (for example an ERP) to its **standing representative**, approved by a company administrator and the accountable person, bound only to company mandates and labelled as the representative |

## Data model and contract additions

All additions are **Proposed**. They extend `packages/contracts/src/assistant.ts` and `billing.ts` without changing the frozen v1 shapes: new schemas live in a new contract file and the frozen `MandateSchema` stays valid as the v1 subset. Changing them is an integrator decision (contracts first, ADR 008).

### Mandate v2

```ts
// Proposed: packages/contracts/src/agent-catalog.ts (not part of the frozen v1 contract)
import { z } from 'zod';
import { PartySchema } from './access.js';
import { MandateActionSchema, MandateStatusSchema } from './assistant.js';
import { DigestSchema } from './common/digest-schema.js';
import { IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema, BusinessDateSchema } from './common/ids.js';
import { MoneySchema, NonNegativeMoneySchema, CurrencySchema } from './common/money.js';

export const MandateActionV2Schema = z.enum([
  ...MandateActionSchema.options,
  'introduce', 'schedule', 'maintain_profile', 'publish', 'register', 'record_evidence', 'confirm_execution',
]);
/** Action classes that can never be pre-authorized, whatever a mandate says. */
export const HUMAN_ONLY_ACTIONS = ['confirm_execution'] as const;

export const ContextKindV2Schema = z.enum([
  'project', 'rfq', 'quote', 'agreement', 'order', 'introduction', 'open_need', 'partner_post', 'event', 'course',
  'publication', 'profile', 'catalogue_offering', 'opportunity', 'company', 'plan_item', 'consultation',
]);
export const ContextRefSchema = z.strictObject({ kind: ContextKindV2Schema, id: IdSchema });
/** Standing mandates: resolved at action time; each ActionIntent records the concrete context it resolved to. */
export const ContextSelectorSchema = z.strictObject({
  kind: ContextKindV2Schema,
  categories: z.array(z.string().min(1).max(80)).max(50),
  regions: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)).max(50), // ISO 3166-1 / 3166-2
  projectId: IdSchema.nullable(),
});

export const ConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('counterparty_status_at_least'), level: z.enum(['claimed', 'verified']) }),
  z.strictObject({ kind: z.literal('counterparty_region_in'), regions: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('category_in'), categories: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('delivery_before'), date: BusinessDateSchema }),
  z.strictObject({ kind: z.literal('catalogue_lines_only') }),
  z.strictObject({ kind: z.literal('within_private_constraint'), constraintRecordId: IdSchema }), // floor or ceiling, party-private
  z.strictObject({ kind: z.literal('max_open'), count: z.int().min(1).max(1000) }),
  z.strictObject({ kind: z.literal('screening_clear') }),
  z.strictObject({ kind: z.literal('credential_checked'), checkType: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal('consent_recorded'), consentKind: z.enum(['project_owner', 'client', 'participant']) }),
  /** Display only: the engine cannot evaluate it, so actions under it fall back to ask_each. */
  z.strictObject({ kind: z.literal('note'), text: ShortTextSchema }),
]);

export const ApprovalPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('ask_each') }),
  z.strictObject({ mode: z.literal('ask_first'), count: z.int().min(1).max(100) }),
  z.strictObject({ mode: z.literal('ask_above'), threshold: NonNegativeMoneySchema }),
  z.strictObject({ mode: z.literal('pre_authorized') }),
]);
export const ApproverRuleSchema = z.strictObject({
  approverPersonIds: z.array(IdSchema).min(1),
  minApprovals: z.int().min(1).max(5),
  above: NonNegativeMoneySchema.nullable(), // e.g. two company approvers above USD 350,000
});
export const EscalationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ask_principal') }),
  z.strictObject({ kind: z.literal('ask_person'), personId: IdSchema }),
  z.strictObject({ kind: z.literal('stop') }),
]);
export const GranteeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('own_agent') }),
  z.strictObject({ kind: z.literal('colleague_agent'), personId: IdSchema, companyId: IdSchema }),
  z.strictObject({ kind: z.literal('company_representative'), companyId: IdSchema }),
]);

export const MandateV2Schema = z.strictObject({
  id: IdSchema,
  principal: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  grantee: GranteeSchema,
  moduleIds: z.array(z.string().min(1).max(60)).min(1),
  actions: z.array(MandateActionV2Schema).min(1),
  contexts: z.array(z.union([ContextRefSchema, ContextSelectorSchema])).min(1),
  limits: z.strictObject({
    ceiling: MoneySchema.nullable(), perActionCeiling: MoneySchema.nullable(),
    transactionBudgetId: IdSchema.nullable(), platformBudgetId: IdSchema.nullable(),
    perWindow: z.strictObject({ count: z.int().min(1), windowHours: z.int().min(1).max(24 * 31) }).nullable(),
  }),
  conditions: z.array(ConditionSchema),
  approvalPolicy: ApprovalPolicySchema,
  approvers: z.array(ApproverRuleSchema),
  escalation: EscalationSchema,
  /** Mandates are created and confirmed only on the first-party surface, never by a connection or by chat. */
  confirmedVia: z.literal('first_party_form'),
  validUntil: TimestampSchema,
  status: MandateStatusSchema,
  revision: RevisionSchema,
  revokedAt: TimestampSchema.nullable(),
});
```

### Modules, hub policy, plans and metering

```ts
export const ModuleFamilySchema = z.enum(['core', 'presence', 'opportunity', 'deal', 'plan_to_people', 'delivery', 'content', 'community', 'operations', 'connectivity']);
export const MeterSchema = z.enum(['model_tokens', 'agent_actions', 'checks', 'document_pages', 'deliverables', 'translation_characters', 'retrieval_queries', 'external_calls']);
export const ProviderClassSchema = z.enum(['local', 'in_country', 'hosted_external']);
/** A suggestion lens, never a role; confers no rights; never in any projection other than owner_private. */
export const ParticipantTypeSchema = z.enum([
  'individual_professional', 'job_seeker', 'small_contractor', 'general_contractor', 'subcontractor', 'supplier',
  'manufacturer', 'design_office', 'developer', 'homeowner', 'public_client', 'editor_author_expert',
  'event_organizer', 'course_author', 'hub_staff', 'company_representative',
]);

/** Engine-defined, code-shipped; hubs cannot widen these. Hubs add capabilities only as governed extensions (ADR 010 decision 22, AGT-023). */
export const AgentModuleManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
  version: z.string().min(1).max(40),
  family: ModuleFamilySchema,
  status: z.enum(['live', 'demo', 'contract', 'designed', 'proposed']),
  actions: z.array(MandateActionV2Schema),
  tools: z.array(z.string().min(1).max(80)),
  readsProjections: z.array(z.enum(['public', 'shared_party', 'party_private', 'owner_private'])),
  meters: z.array(MeterSchema),
  suits: z.array(ParticipantTypeSchema),
  freeFloor: z.boolean(), // true: hubs cannot remove its free floor
});

/** Stored as hub_config_version domain `agents`; drafted by one person, activated by another. */
export const HubAgentPolicySchema = z.strictObject({
  hubId: IdSchema,
  enabledModules: z.array(z.strictObject({ moduleId: z.string(), moduleVersion: z.string(), settings: z.record(z.string(), z.unknown()) })),
  protectionLimits: z.strictObject({
    openIntroductionsPerPerson: z.int().min(0), newCounterpartiesPerDay: z.int().min(0),
    maxNegotiationRounds: z.int().min(1).max(20), consumerMaxRounds: z.int().min(1).max(20),
    envelopesPerCounterpartyPerDay: z.int().min(0), publicRecordsPerConnectionPerDay: z.int().min(0),
    connectionsPerPerson: z.int().min(0).max(20), connectionIdleExpiryDays: z.int().min(1).max(365),
  }),
  forbiddenPreAuthorization: z.array(MandateActionV2Schema),
  disclosureTextKeys: z.record(z.string(), z.string()), // locale -> template key
  killSwitch: z.strictObject({ dispatch: z.enum(['on', 'off']), connections: z.enum(['on', 'off']), modulesOff: z.array(z.string()) }),
});

export const AgentPlanVersionSchema = z.strictObject({
  id: IdSchema, offerId: IdSchema, version: z.int().min(1),
  payerKind: z.enum(['person', 'company']),
  modules: z.array(z.string()),
  includedQuota: z.array(z.strictObject({ moduleId: z.string(), meter: MeterSchema, units: z.string().regex(/^(0|[1-9]\d*)$/), window: z.enum(['day', 'week', 'month']) })),
  connections: z.int().min(0), channels: z.int().min(0), representativeIncluded: z.boolean(),
  priceVersionId: IdSchema, // existing PriceVersion with second-person activation
});
export const MeterRateVersionSchema = z.strictObject({
  id: IdSchema, hubId: IdSchema, version: z.int().min(1), meter: MeterSchema,
  providerClass: ProviderClassSchema.nullable(), currency: CurrencySchema,
  pricePerThousandUnits: NonNegativeMoneySchema, passThrough: z.boolean(),
  effectiveFrom: TimestampSchema, effectiveTo: TimestampSchema.nullable(),
  draftedBy: IdSchema, activatedBy: IdSchema.nullable(),
});
/** Append-only; idempotent per (runStepId, attemptId, meter). */
export const UsageRecordSchema = z.strictObject({
  id: IdSchema, principal: PartySchema, billingAccountId: IdSchema, moduleId: z.string(),
  runId: IdSchema, runStepId: IdSchema, attemptId: IdSchema, connectionId: IdSchema.nullable(),
  meter: MeterSchema, providerClass: ProviderClassSchema.nullable(), units: z.string().regex(/^(0|[1-9]\d*)$/),
  withinIncludedQuota: z.boolean(), meterRateVersionId: IdSchema.nullable(), reservationId: IdSchema.nullable(),
  recordedAt: TimestampSchema,
});
export const MarketplaceFeeVersionSchema = z.strictObject({
  id: IdSchema, hubId: IdSchema, kind: z.enum(['consultation', 'task', 'ticket', 'course']),
  category: z.string().nullable(), basisPoints: z.int().min(0).max(10_000).nullable(), fixed: NonNegativeMoneySchema.nullable(),
  priceVersionId: IdSchema, // activation and acceptance rules of PriceVersion apply
});
```

### Goals, triggers, envelopes, reports

```ts
export const GoalSchema = z.strictObject({
  id: IdSchema, principal: PartySchema, text: z.string().min(1).max(2000),
  successCriteria: z.array(ShortTextSchema).min(1), mandateIds: z.array(IdSchema),
  horizon: TimestampSchema, reportCadence: z.enum(['none', 'daily', 'weekly', 'monthly']),
  status: z.enum(['proposed', 'active', 'paused', 'closed']), outcome: z.enum(['achieved', 'partly', 'abandoned']).nullable(),
  revision: RevisionSchema,
});
export const TriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('schedule'), rrule: z.string().max(200), timeZone: z.string() }),
  z.strictObject({ kind: z.literal('event'), eventType: z.string().regex(/^[a-z_]+\.[a-z_]+$/) }),
  z.strictObject({ kind: z.literal('deadline'), offsetsDays: z.array(z.int().min(0).max(365)) }),
  z.strictObject({ kind: z.literal('goal'), goalId: IdSchema }),
  z.strictObject({ kind: z.literal('request') }),
]);
export const JobSubscriptionSchema = z.strictObject({
  id: IdSchema, principal: PartySchema, moduleId: z.string(), jobTemplateId: z.string(),
  trigger: TriggerSchema, mandateId: IdSchema.nullable(), status: z.enum(['on', 'paused', 'off']), revision: RevisionSchema,
});
export const EnvelopeIntentSchema = z.enum([
  'request_proposal', 'propose', 'counter', 'clarify', 'answer', 'accept', 'decline', 'withdraw', 'schedule_meeting', 'introduce',
  'propose_slots', 'request_confirmation', 'express_interest', 'step_question',
]);
export const AgentEnvelopeSchema = z.strictObject({
  id: IdSchema, from: PartySchema, actorLabelKey: z.string(), viaConnectionId: IdSchema.nullable(),
  context: ContextRefSchema, intent: EnvelopeIntentSchema,
  refs: z.array(z.strictObject({ kind: ContextKindV2Schema, id: IdSchema, version: z.int().min(1), digest: DigestSchema })),
  note: z.string().max(4000).nullable(), // untrusted for the receiver, never parsed for commands
  mandateDigest: DigestSchema, expiresAt: TimestampSchema,
  deliveryStatus: z.enum(['queued', 'delivered', 'rejected', 'expired']),
});
export const AgentReportSchema = z.strictObject({
  id: IdSchema, principal: PartySchema, period: z.strictObject({ from: TimestampSchema, to: TimestampSchema }),
  sections: z.array(z.strictObject({ moduleId: z.string(), headingKey: z.string(), items: z.array(z.record(z.string(), z.unknown())) })),
  audience: z.literal('owner_private'), sharedWith: z.array(IdSchema),
});
```

### Plan to people and reputation

```ts
export const PlanVersionSchema = z.strictObject({
  id: IdSchema, projectId: IdSchema, version: z.int().min(1), digest: DigestSchema,
  status: z.enum(['draft', 'shared', 'superseded']), basedOnTemplateId: IdSchema.nullable(), createdAt: TimestampSchema,
});
export const PlanItemSchema = z.strictObject({
  id: IdSchema, planVersionId: IdSchema, phase: z.string().max(120), title: ShortTextSchema,
  kind: z.enum(['task', 'consultation', 'permit', 'inspection', 'decision', 'purchase', 'self']),
  trades: z.array(z.string()), dependsOn: z.array(IdSchema),
  budgetRange: z.strictObject({ low: NonNegativeMoneySchema, high: NonNegativeMoneySchema, basis: ShortTextSchema }).nullable(), // owner_private
  durationDays: z.strictObject({ low: z.int().min(0), high: z.int().min(0) }).nullable(),
  sources: z.array(z.strictObject({ kind: z.enum(['template', 'licensed_source', 'own_quote', 'lesson', 'jurisdiction_facet']), ref: IdSchema })),
  linkedContext: ContextRefSchema.nullable(), // the need, RFQ, consultation or agreement it became
});
/** What of a private plan item leaves the owner, per audience; reviewed by the owner before sharing. */
export const PlanItemShareSchema = z.strictObject({
  planItemId: IdSchema, audience: z.enum(['public', 'invited', 'after_acceptance']),
  fields: z.array(z.enum(['scope', 'trade', 'locality', 'address', 'drawings', 'quantities', 'schedule', 'budget_range', 'contact'])),
  confirmedBy: IdSchema, confirmedAt: TimestampSchema,
});
export const ConsultationBookingSchema = z.strictObject({
  id: IdSchema, client: PartySchema, expert: PartySchema, offeringVersion: z.strictObject({ id: IdSchema, digest: DigestSchema }),
  kind: z.enum(['session', 'drawing_review', 'quote_review', 'site_visit', 'mentoring']),
  mode: z.enum(['video', 'chat', 'phone', 'in_person', 'async']), slot: z.strictObject({ start: TimestampSchema, end: TimestampSchema }).nullable(),
  agreementId: IdSchema, recordingConsent: z.boolean(),
  status: z.enum(['requested', 'proposed', 'booked', 'held', 'delivered', 'accepted', 'cancelled', 'disputed']),
  deliverableRefs: z.array(IdSchema), revision: RevisionSchema,
});
export const KnowledgeArtefactSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['diary_entry', 'lesson', 'checklist', 'plan_template', 'answer']),
  sourceProjectId: IdSchema.nullable(), publicationId: IdSchema, consents: z.array(z.strictObject({ personId: IdSchema, scope: z.string(), at: TimestampSchema })),
});
export const PortfolioEntrySchema = z.strictObject({
  id: IdSchema, holder: PartySchema, projectRef: IdSchema.nullable(), evidenceRefs: z.array(IdSchema),
  confirmation: z.enum(['self_reported', 'client_confirmed']), ownerConsentAt: TimestampSchema.nullable(), revision: RevisionSchema,
});
export const PassportCredentialSchema = z.strictObject({
  id: IdSchema, holder: PartySchema, issuerHubId: IdSchema,
  kind: z.enum(['IdentityVerified', 'LicenceChecked', 'CertificateEarned', 'ProjectContribution', 'ConsultationDelivered', 'ReputationSnapshot']),
  format: z.enum(['vc_2_0', 'open_badges_3_0']), payloadDigest: DigestSchema,
  statusListIndex: z.int().min(0), issuedAt: TimestampSchema, validUntil: TimestampSchema.nullable(),
  status: z.enum(['valid', 'revoked', 'expired']),
});
```

### External connections

```ts
export const ConnectionScopeSchema = z.enum(['read.public', 'read.me', 'read.contexts', 'read.private', 'propose', 'act']);
export const ExternalConnectionSchema = z.strictObject({
  id: IdSchema, owner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person'), personId: IdSchema }),
    z.strictObject({ kind: z.literal('company_representative'), companyId: IdSchema, approvedBy: z.array(IdSchema).min(2) }),
  ]),
  protocol: z.enum(['mcp', 'a2a']), clientId: z.string().min(1).max(200),
  clientNameSelfAsserted: z.string().max(120), listedByHub: z.boolean(),
  scopes: z.array(ConnectionScopeSchema), privateDataClasses: z.array(z.enum(['negotiation_constraints', 'budgets', 'private_projects', 'drafts'])),
  mandateBindings: z.array(z.strictObject({ mandateId: IdSchema, revision: RevisionSchema })),
  rateLimitProfile: z.string(), status: z.enum(['active', 'suspended', 'revoked', 'expired']),
  createdAt: TimestampSchema, lastUsedAt: TimestampSchema.nullable(), revision: RevisionSchema,
});
/** Tokens are opaque; only hashes are stored, like sessions. */
export const ConnectionTokenSchema = z.strictObject({
  id: IdSchema, connectionId: IdSchema, family: IdSchema, kind: z.enum(['access', 'refresh']),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), audience: z.string().url(), expiresAt: TimestampSchema, revokedAt: TimestampSchema.nullable(),
});
export const ConnectionCallSchema = z.strictObject({
  id: IdSchema, connectionId: IdSchema, tokenFamily: IdSchema, tool: z.string().max(80), argsDigest: DigestSchema,
  resultCode: z.string().max(80), mandateRef: z.strictObject({ id: IdSchema, revision: RevisionSchema }).nullable(),
  actionIntentId: IdSchema.nullable(), at: TimestampSchema,
});
export const KillSwitchSchema = z.strictObject({
  id: IdSchema, scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('node') }), z.strictObject({ kind: z.literal('hub'), hubId: IdSchema }),
    z.strictObject({ kind: z.literal('hub_module'), hubId: IdSchema, moduleId: z.string() }),
    z.strictObject({ kind: z.literal('company_representative'), companyId: IdSchema }),
    z.strictObject({ kind: z.literal('person_stop'), personId: IdSchema }),
    z.strictObject({ kind: z.literal('connection'), connectionId: IdSchema }),
  ]),
  state: z.enum(['engaged', 'released']), engagedBy: IdSchema, reason: ShortTextSchema, incidentNote: z.string().max(4000).nullable(),
  at: TimestampSchema,
});
```

Projection rules for the new records: plans, plan items, budget ranges, mandates, goals, usage, reports, connections and connection calls are `owner_private` (company ones `party_private` to members with the right); envelopes are `shared_party` minus the note's provenance internals; consultation bookings are `shared_party` between client and expert; portfolio entries, knowledge artefacts and passport credentials are `public` only after the holder's and the owners' consents. Forbidden-field tests extend to `budgetRange`, `constraintRecordId`, `privateDataClasses`, `tokenHash`, `argsDigest` and plan item addresses.

## Safety

| Threat | Defence |
|---|---|
| **Prompt injection** from files, e-mail, web pages, imported sources, other agents' notes, A2A text parts and tool output of external agents | Content is tagged untrusted at ingestion and stays tagged through retrieval; state-moving tools accept only structured inputs from first-party records; a run plans first, then every proposed action is checked against mandate, conditions and current rights outside the model; addresses, amounts and counterparties found in untrusted text are never used without a person's confirmation; module safety suites include canary instructions in every untrusted channel |
| **Data exfiltration** through drafts, envelopes, tool output or external connections | Every outbound payload passes the projection serializer for its audience; the envelope builder has no access to party-private fields; `read.private` classes are off by default; egress to model providers follows the hub's data-class × provider matrix |
| **Collusion and competition law** | Competition firewall between competing sellers; no market prices from private quotes; refusal of collusive goals; pattern signals (identical bids, rotation, reciprocal reviews) open cases for people, never automatic sanctions; hub-configurable competition-law note per country |
| **Consumer harm** | Consumer mode: total price with taxes, cancellation rights from state or country facets, minimum quote validity, consumer round limit, consumer commitments always a person's decision |
| **Public procurement integrity** | Equal-treatment answers, quiet period, anti-splitting guard, no submission or award by agents |
| **Impersonation and disclosure** | Every agent message, quote, booking and acceptance carries the hub's disclosure label in the reader's language; agents never claim to be human; connections act under the same label; representatives name the accountable person |
| **Runaway automation** | Per-mandate windows, protection limits, round limits, concurrent run caps, circuit breakers on repeated denials or loops, platform budget stops without overage |
| **Account takeover through a connection** | Step-up for consent, audience-bound short-lived tokens, refresh rotation with reuse detection, revoke-all on password change and recovery |
| **Reputation gaming** | Reviews and confirmations only from real counterparties; `confirm_execution` is `human_only`; no incentives; pattern signals open cases |
| **Surveillance** | No per-person analytics for hubs or employers; KPIs private; organizers and authors see aggregates only |

### Kill switches

| Switch | Who | Effect |
|---|---|---|
| Node | Node operator | Stops all agent dispatch and connections on the node |
| Hub | Hub ops engineer (release needs an incident note) | Stops all agent dispatch in the hub |
| Hub module | Hub ops engineer | Stops one module (for example `negotiation`) while the rest works |
| Hub connections | Hub ops engineer | Stops all MCP and A2A traffic |
| Company representative | Any company administrator | Suspends the representative |
| Person stop | The person | Suspends all their mandates and connections |
| Connection | The person | Revokes one connection |

Every switch is effective before the next action check (authorization epoch), never deletes history, and leaves executing actions to reconciliation.

## Open questions for the owner

On 2026-10-31 [ADR 012](../adr/012-integrator-decisions-2026-10-31.md) (decision 23) adopted the proposals for Q1–Q6, Q8 and Q9 as defaults; Q7 became configuration (HUB-005) whose wording still needs counsel.

| # | Question | Proposal in this chapter |
|---|---|---|
| Q1 | May a hub reduce the engine's free floor for agent modules? | No; a hub can only be more generous |
| Q2 | Are introduction quotas ever purchasable? | Never; they protect recipients |
| Q3 | Outcome-based fees for agent work, and the level of marketplace commissions on consultations and tasks | No outcome fees for agent work; flat, category-level marketplace commissions configurable by the hub (O03) |
| Q4 | Are tickets, courses and consultations bought from the transaction budget? | Yes: they are purchases from participants; the platform budget is only for platform usage |
| Q5 | Default for `read.private` data classes to external agents | Off, opt-in per class with a residency warning |
| Q6 | Anonymous A2A public read skills | Allowed at low rate limits, public data only |
| Q7 | Liability for agent commitments and consultations, and wording of agent disclosure per jurisdiction | Configurable per hub and jurisdiction (ADR 010 decision 22, HUB-005); the wording itself stays open for counsel (O12, ADR 012) |
| Q8 | Which reputation passport formats and issuer identifiers to pin | VC data model 2.0 and Open Badges 3.0 issued by the home hub; versions pinned at implementation |
| Q9 | Whether budget ranges in plans may use any commercial cost dataset | Only datasets the hub licensed for display and model use |

## Proposed work packages

**Merged on 2026-10-31.** These proposals are now part of [work-packages.json](work-packages.json) ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md)): AGT-006 became REP-002, AGT-011 became CONS-001 and TASK-001, AGT-012 became KNOW-001 and MAT-001, the plan-step companion part of AGT-010 became AGT-021, and AGT-022 (detailed agent settings) and AGT-023 (governed extension registry) were added for ADR 010 decision 22. The block below is kept as the original proposal.

These packages are a proposal for the conductor and maintainers; they are **not** in `work-packages.json` until a maintainer adds them (identifiers may be renumbered on merge). They extend AGT-001 and depend on the existing graph. The JSON uses the exact shape of [work-packages.json](work-packages.json) and passes `validate()` from `scripts/work-packages.mjs` when appended to the current list.

```json
[
  {
    "id": "AGT-002",
    "title": "Freeze agent catalogue contracts: mandate v2, modules, plans, metering, connections, plan to people and passport",
    "area": "integrator-contracts",
    "status": "open",
    "dependsOn": [
      "FND-002"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Add the proposed catalogue schemas as a new contract file without changing the frozen v1 shapes, so that backend, billing and web work can proceed independently.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/architecture/api.md",
      "docs/adr/008-contracts-and-validation.md"
    ],
    "steps": [
      "Add MandateV2 (action vocabulary v2, context selectors, structured conditions, approval policies, approver rules, escalation, grantee) keeping MandateSchema as the v1 subset.",
      "Add module manifest, hub agent policy, agent plan version, meter rate version, usage record and marketplace fee version schemas.",
      "Add goal, trigger, job subscription, agent envelope (with the four new intents) and report schemas.",
      "Add plan version, plan item, plan item share, consultation booking, knowledge artefact, portfolio entry and passport credential schemas.",
      "Add external connection, connection token, connection call and kill switch schemas; generate JSON Schema and validated examples."
    ],
    "acceptance": [
      "confirm_execution can never be pre-authorized by any schema-valid mandate.",
      "A note-kind condition forces ask_each in the pure policy function.",
      "Forbidden-field tests cover budgetRange, constraintRecordId, privateDataClasses, tokenHash and plan item addresses in every non-owner projection.",
      "Frozen v1 fixtures still validate unchanged."
    ],
    "paths": [
      "packages/contracts/src/agent-catalog.ts",
      "tests/contracts/agent-catalog.test.ts"
    ]
  },
  {
    "id": "AGT-003",
    "title": "Implement the module registry, hub agent policy, job subscriptions and kill switches",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AGT-002",
      "AST-001",
      "HUB-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let a hub enable and configure engine-defined modules, let a principal turn jobs on through mandate proposals, and stop dispatch at every kill-switch level.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/hub-administration.md",
      "docs/engine/trust-safety-privacy.md"
    ],
    "steps": [
      "Load code-defined module manifests; reject hub settings that widen actions, tools or data classes.",
      "Store hub agent policy as hub_config_version domain agents with second-person activation.",
      "Implement job subscriptions with schedule, event, deadline, goal and request triggers in the principal's time zone and hub calendar.",
      "Implement node, hub, hub module, hub connections, company representative, person stop and connection kill switches through authorization epochs.",
      "Read every country-specific value from packs and hub configuration, never from code."
    ],
    "acceptance": [
      "Turning a job on creates only a mandate proposal; nothing runs until it is confirmed on the first-party form.",
      "Each kill switch blocks the next action check; executing actions go to reconciliation.",
      "No module code path branches on a country code (lint or test)."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules",
      "tests/agent-modules"
    ]
  },
  {
    "id": "AGT-004",
    "title": "Implement agent metering, quotas, agent plans and marketplace fee versions",
    "area": "billing",
    "status": "open",
    "dependsOn": [
      "AGT-002",
      "BILL-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Meter agent usage idempotently, enforce quotas and protection limits, and let a hub price modules and marketplaces with versioned, second-person-activated records.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/billing.md"
    ],
    "steps": [
      "Append usage records idempotently per run step, attempt and meter.",
      "Check quota windows per principal, module and meter; reserve estimates from the named platform budget beyond included quota and settle on actuals.",
      "Implement agent plan versions, meter rate versions and marketplace fee versions on top of offers, price versions and acceptances.",
      "Keep protection limits independent of plans."
    ],
    "acceptance": [
      "Replaying a step never charges twice; unknown billing outcomes reconcile.",
      "Without a platform budget a job stops at quota and asks.",
      "Introduction quotas, alert timing and ranking are identical with and without paid entitlements (tests).",
      "No real prices: fixtures are labelled synthetic."
    ],
    "paths": [
      "apps/api/src/modules/billing/agent-metering",
      "tests/billing/agent-metering"
    ]
  },
  {
    "id": "AGT-005",
    "title": "Implement presence modules: profile keeper, compliance checker and reputation builder",
    "area": "execution-trust",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "EXE-001",
      "HUB-003"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Give every participant tools to build and confirm their own reputation from evidence: credentials, evidence-backed portfolio, confirmations, reviews, contributions, timeliness signals, coaching, disputes and appeals.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/execution-and-reputation.md",
      "docs/engine/people-and-companies.md"
    ],
    "steps": [
      "Implement credential collection through hub verification checks with expiry reminders.",
      "Implement portfolio entries linked to execution records with owner or client consent and self-reported versus client-confirmed labels.",
      "Implement confirmation and review requests only after real completed interactions, once plus one reminder.",
      "Implement private coaching limited to legitimate actions and dispute or appeal drafts with evidence."
    ],
    "acceptance": [
      "The module never changes a score directly; snapshots change only through the method.",
      "Review and confirmation requests to non-counterparties are impossible (negative tests).",
      "Paid entitlements never change scores, badges or passport content (tests)."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/presence",
      "tests/agent-modules/presence"
    ]
  },
  {
    "id": "AGT-006",
    "title": "Issue the portable reputation passport as verifiable credentials",
    "area": "execution-trust",
    "status": "open",
    "dependsOn": [
      "AGT-005",
      "FED-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let participants export holder-controlled, verifiable credentials of identity checks, licences, certificates, contributions and reputation snapshots, issued by their home hub.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/federation.md",
      "docs/engine/learning.md"
    ],
    "steps": [
      "Pin the W3C Verifiable Credentials and Open Badges versions and the issuer identifier scheme on the hub domain.",
      "Issue credentials signed with the node key through an adapter with a fake.",
      "Publish status lists for revocation and expiry; short validity for snapshot credentials.",
      "Let peers at trust-verifications level show credentials as verified by hub X."
    ],
    "acceptance": [
      "Credentials contain no counterparties' private data and no documents.",
      "Revoking a verification or licence check updates status before the next verification.",
      "Verification does not reveal to the hub who is being checked by whom."
    ],
    "paths": [
      "apps/api/src/modules/trust/passport",
      "tests/trust/passport"
    ]
  },
  {
    "id": "AGT-007",
    "title": "Implement opportunity modules: discovery, opportunity watch, introductions and engagements",
    "area": "matching",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "AGT-001",
      "MATCH-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let agents find partners, watch opportunities and request double-opt-in introductions for every participant type within shared quotas.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/partners-and-matching.md"
    ],
    "steps": [
      "Implement standing selectors over needs, partner posts, invitations and imported procurement notices.",
      "Implement go/no-go notes with eligibility pass, fail and unknown.",
      "Implement engagements for individuals with availability hidden from the current employer by default.",
      "Label every agent-sent request and draw from the principal's quota."
    ],
    "acceptance": [
      "Alerts are dispatched in the same batch for every plan.",
      "Sourced companies never receive bulk outreach.",
      "Applications to employment are never accepted by an agent."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/opportunity",
      "tests/agent-modules/opportunity"
    ]
  },
  {
    "id": "AGT-008",
    "title": "Implement deal modules with consumer mode and the anti-splitting guard",
    "area": "commerce-backend",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "AGT-001",
      "COM-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let agents take intake, quote, negotiate, procure and accept orders inside mandates for sellers and buyers of every size, with stronger protections when one side is a consumer.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/commerce.md",
      "docs/engine/country-specifics.md"
    ],
    "steps": [
      "Implement need intake with evidence per line, quoting from catalogue under standing mandates and revalidation after amendments.",
      "Implement negotiation sessions inside party-private floors and ceilings with round limits.",
      "Implement procurement comparison, orders and order desk acceptance with approver rules.",
      "Implement consumer mode from state or country facets and the anti-splitting guard for every buyer."
    ],
    "acceptance": [
      "Competing sellers never receive each other's pricing or participation (test).",
      "Consumer commitments are never pre-authorized.",
      "Splitting an order below an approval threshold triggers approval."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/deal",
      "tests/agent-modules/deal"
    ]
  },
  {
    "id": "AGT-009",
    "title": "Implement the public tender desk",
    "area": "commerce-backend",
    "status": "open",
    "dependsOn": [
      "AGT-008",
      "CTRY-002"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Help public and institutional clients prepare and keep procurement transparent without ever replacing the statutory procedure.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/commerce.md",
      "docs/engine/country-specifics.md"
    ],
    "steps": [
      "Implement market research notices labelled as not a solicitation.",
      "Implement equal-treatment clarifications published to all invited parties at once.",
      "Implement the quiet period for meetings with bidders and the anti-splitting guard with thresholds from facets.",
      "Import notices from configured official sources such as SAM.gov and state portals through adapters with fakes."
    ],
    "acceptance": [
      "No agent submits to an official portal, awards or signs.",
      "A clarification answer is never delivered to one bidder before others."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/public-tender",
      "tests/agent-modules/public-tender"
    ]
  },
  {
    "id": "AGT-010",
    "title": "Implement plan to people: project planner and plan-step companion",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "MATCH-001",
      "RAG-301",
      "CTRY-002"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Turn anyone's idea into a versioned, plain-language project plan and recommend explained, payment-blind materials, guides, training, events, consultants and contacts for every step.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/projects.md",
      "docs/engine/search-and-knowledge.md",
      "docs/engine/partners-and-matching.md"
    ],
    "steps": [
      "Model plan versions and items with phases, trades, materials, permits and inspections from jurisdiction facets, budget ranges with basis, durations, risks and decision points.",
      "Implement plan item shares reviewed by the owner per audience.",
      "Implement per-step recommendations with explanations; sponsored content labelled and outside ranking.",
      "Implement anonymous step questions to manufacturers and suppliers."
    ],
    "acceptance": [
      "Budget ranges never use other participants' private quotes.",
      "Recommendations are identical with and without sponsorship or commissions (test).",
      "Sourced pages stay labelled sourced until claimed."
    ],
    "paths": [
      "apps/api/src/modules/planner",
      "tests/planner"
    ]
  },
  {
    "id": "AGT-011",
    "title": "Implement consultations and the task marketplace",
    "area": "commerce-backend",
    "status": "open",
    "dependsOn": [
      "AGT-010",
      "AGT-008",
      "AGT-004"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let plan items become consultation bookings with experts and scoped tasks for contractors, reusing offerings, RFQs, quotes, agreements and execution records.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/commerce.md",
      "docs/engine/execution-and-reputation.md",
      "docs/engine/communications.md"
    ],
    "steps": [
      "Implement consultation offerings, booking, slots, video or chat through adapters with fakes, deliverables and acceptance.",
      "Implement tasks as RFQs from plan items with offers as quote versions, milestones and evidence.",
      "Apply marketplace fee versions shown before booking or acceptance.",
      "Allow reviews only for completed bookings and tasks."
    ],
    "acceptance": [
      "Licence-requiring advice is offered only by experts whose licence check passed.",
      "Recording happens only with both parties' consent.",
      "Commissions never change suggestions (test)."
    ],
    "paths": [
      "apps/api/src/modules/consultations",
      "apps/api/src/modules/planner/tasks",
      "tests/consultations"
    ]
  },
  {
    "id": "AGT-012",
    "title": "Implement knowledge sharing and manufacturer and supplier knowledge profiles",
    "area": "content-magazine",
    "status": "open",
    "dependsOn": [
      "AGT-010",
      "CNT-001",
      "LRN-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Turn completed projects, with consent, into diaries, lessons, checklists, plan templates, Q&A and mentoring, and let claimed manufacturers and suppliers publish guides and answer plan-step questions.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/publishing.md",
      "docs/engine/learning.md"
    ],
    "steps": [
      "Implement knowledge artefacts as publications with field-by-field consent and credits.",
      "Implement plan templates with private data removed and owner review.",
      "Implement knowledge profiles and answers to step questions under company mandates."
    ],
    "acceptance": [
      "No address or private amount reaches a knowledge artefact.",
      "Answers from companies are labelled as from a party with a commercial interest."
    ],
    "paths": [
      "apps/api/src/modules/knowledge",
      "tests/knowledge"
    ]
  },
  {
    "id": "AGT-013",
    "title": "Implement delivery modules: project desk and execution clerk",
    "area": "execution-trust",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "EXE-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let agents track participants, milestones, changes and evidence and request confirmations without ever confirming on a person's behalf.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/execution-and-reputation.md",
      "docs/engine/projects.md"
    ],
    "steps": [
      "Implement change records with reasons, update requests and stage evidence collection.",
      "Implement request_confirmation envelopes and reminders within limits."
    ],
    "acceptance": [
      "confirm_execution remains human-only (negative test).",
      "Client-caused changes are excluded from supplier timing."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/delivery",
      "tests/agent-modules/delivery"
    ]
  },
  {
    "id": "AGT-014",
    "title": "Implement content and community modules",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "CNT-001",
      "EVT-001",
      "LRN-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Give authors, editors, organizers, trainers and attendees their agent jobs: content writer, editorial desk, translation, event networking, organizer desk, learning coach and course studio.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/publishing.md",
      "docs/engine/events.md",
      "docs/engine/learning.md"
    ],
    "steps": [
      "Implement drafts with citations, assistance labels and machine-assisted translation labels.",
      "Implement source triage that never sends display-only sources to a model provider.",
      "Implement meeting proposals, organizer slot allocation without request contents, waitlist promotion and template announcements.",
      "Implement course drafting, learner question drafts and update proposals."
    ],
    "acceptance": [
      "Nothing is published without a person's decision where the policy requires it.",
      "Organizers never see who declined whom; learner progress stays private."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/community",
      "tests/agent-modules/community"
    ]
  },
  {
    "id": "AGT-015",
    "title": "Implement the hub operations assistant and the representative front desk",
    "area": "platform-admin-backend",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "AGT-001",
      "ADM-002"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Help hub staff with drafted summaries that never decide, and give the company representative its triage, routing, continuity and weekly report.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/hub-administration.md"
    ],
    "steps": [
      "Implement staff-principal runs on queues with no access outside case grants.",
      "Keep staff-case data unavailable to the assistant unless the grant and egress matrix both allow it.",
      "Implement representative triage, routing to named approvers, 7-day re-confirmation and weekly report."
    ],
    "acceptance": [
      "Claims, sanctions, appeals, method releases and price activation are human-only (negative tests).",
      "No per-person staff analytics exist."
    ],
    "paths": [
      "apps/api/src/modules/agent-modules/operations",
      "tests/agent-modules/operations"
    ]
  },
  {
    "id": "AGT-016",
    "title": "Implement external agent connections over MCP",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AGT-003",
      "AST-001",
      "BE-002"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let a participant connect their own external agent to their single Trustwork agent identity with scoped, mandate-bound tokens, audit, rate limits and revocation.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/architecture/api.md",
      "docs/engine/trust-safety-privacy.md"
    ],
    "steps": [
      "Pin the MCP version; expose the tool set behind entitlements through an adapter with a fake client.",
      "Implement OAuth 2.1 dynamic client registration, authorization code with PKCE, step-up consent, resource-bound opaque tokens stored as hashes and refresh rotation with reuse detection.",
      "Implement scopes, per-class private data opt-in and mandate bindings by id and revision.",
      "Implement connection call audit, rate limits, circuit breaker, expiry and revocation paths."
    ],
    "acceptance": [
      "A connection can never approve, confirm or widen a mandate, step up, accept terms or press a kill switch (negative tests).",
      "Cookies never authorize MCP and bearer tokens never authorize the first-party API.",
      "Revoking a mandate stops its binding before the next call."
    ],
    "paths": [
      "apps/api/src/modules/connections/mcp",
      "tests/connections/mcp"
    ]
  },
  {
    "id": "AGT-017",
    "title": "Implement the A2A gateway mapped to agent envelopes",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AGT-016",
      "AGT-001"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Let agents built elsewhere interoperate with Trustwork agents through the same envelope rules, with no anonymous outreach.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/federation.md"
    ],
    "steps": [
      "Pin the A2A version; publish opt-in agent cards with labels and accepted intents only.",
      "Map tasks to negotiation sessions or introductions; validate data parts; treat text as untrusted notes; quarantine files.",
      "Require a Trustwork principal for state-moving tasks; allow only public read skills otherwise."
    ],
    "acceptance": [
      "No A2A text part changes state.",
      "Agent cards reveal no mandate, limit or plan."
    ],
    "paths": [
      "apps/api/src/modules/connections/a2a",
      "tests/connections/a2a"
    ]
  },
  {
    "id": "AGT-018",
    "title": "Build the catalogue on the single assistant surface",
    "area": "frontend",
    "status": "open",
    "dependsOn": [
      "WEB-002",
      "AGT-003"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Show goals, decisions, mandates, runs, reports, abilities, connections, plans and the stop control for every participant type on the one assistant page and overlay.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/design/system/README.md",
      "docs/engine/localization.md"
    ],
    "steps": [
      "Implement abilities that open mandate proposals, first cards per participant lens and the connections settings.",
      "Implement the plan view and per-step recommendations on the project.",
      "Add every string to locale files for all hub languages, including English and Spanish for the reference hub.",
      "Verify keyboard, screen reader and small-screen behaviour."
    ],
    "acceptance": [
      "There is still exactly one assistant surface per person and no agent management screen.",
      "Browser tests pass in a non-English language."
    ],
    "paths": [
      "apps/web/features/assistant-catalog",
      "tests/web-flows/assistant-catalog"
    ]
  },
  {
    "id": "AGT-019",
    "title": "Agent safety evaluation suite",
    "area": "qa-release",
    "status": "open",
    "dependsOn": [
      "AGT-007",
      "AGT-008",
      "AGT-011",
      "AGT-016",
      "AGT-017"
    ],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Prove injection resistance, privacy, competition-law, consumer, disclosure, quota and kill-switch behaviour across all modules before any hub enables them.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/engine/trust-safety-privacy.md",
      "docs/quality/validation.md"
    ],
    "steps": [
      "Seed canary instructions in files, mail, sources, envelope notes, A2A text and connection inputs.",
      "Run competition firewall, consumer mode, anti-splitting and fairness comparisons with and without entitlements.",
      "Drill every kill switch and connection revocation under concurrency."
    ],
    "acceptance": [
      "No canary causes a state change or egress.",
      "Rankings, alerts and recommendations are identical across plans and sponsorship."
    ],
    "paths": [
      "tests/agent-safety"
    ]
  },
  {
    "id": "AGT-020",
    "title": "Validate participant jobs and KPIs with practitioners",
    "area": "product-research",
    "status": "open",
    "dependsOn": [],
    "handbook": "docs/engine/agent-catalog.md",
    "goal": "Test the catalogue jobs, mandates and KPIs with real practitioners of each participant type in the reference hub before prioritising implementation.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/agents.md",
      "docs/engine/agent-catalog.md",
      "docs/product/open-decisions.md"
    ],
    "steps": [
      "Interview practitioners of each type with consent; record real stories and counterexamples.",
      "Rank jobs by observed value without inventing frequencies."
    ],
    "acceptance": [
      "Findings cite consented interviews only; no invented results.",
      "Proposed changes to the catalogue come as a pull request."
    ],
    "paths": [
      "docs/research/agent-jobs"
    ]
  }
]
```

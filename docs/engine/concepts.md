# Concepts and glossary

The engine uses a small set of words precisely. When a document, a contract or a test uses one of these words, it means exactly this.

## The shape of the network

| Term | Meaning |
|---|---|
| **Engine** | Trustwork, the free software in this repository. |
| **Node** | One independently operated installation of the engine: its own database, web origin, operator and signing key. |
| **Hub** | A community served by a node for a **territory**: a country, a region inside it, or a city. A node may host several hubs. See [Hubs](hubs.md). |
| **Territory** | What a hub serves, as ISO 3166-1 / 3166-2 codes and optional named places. Descriptive and never exclusive: a country hub and a city hub can overlap. |
| **Hub operator** | The organisation or person who develops the platform for a territory and is responsible for its legal compliance. See [Hub administration](hub-administration.md). |
| **Mesh** | All nodes that federate with each other. See [Federation](federation.md). |
| **Home node** | The node where an object was created; the only node that can change it. Other nodes hold read-only replicas. |
| **Country pack** | Reviewed, sourced data about a country (identifiers, regions, currency, languages, legal facts) in `packages/country-packs/packs/<cc>.json`. See [Country specifics](country-specifics.md). |
| **Hub configuration** | Operator decisions stored in the database and versioned: enabled sources, verification providers, legal document versions, taxonomy extensions, policies. |
| **Restricted place** | A country or region under sanctions where nothing is built, hosted, served or federated. The list lives in code and cannot be changed from an admin screen. |
| **Brand overlay** | A deployment's own name, lettering and strings on top of the neutral engine (`apps/web/brand`). |

## People and organisations

| Term | Meaning |
|---|---|
| **Person** | One human, one lifelong identity. Profiles, publications and authorship survive changes of employer. |
| **Company** | An organisation with a page, people, catalogue, projects and reputation. |
| **Membership** | A person's employment link to a company. One active ordinary employer at a time; history is kept. |
| **Capability preference** | What a person wants to do (read, publish, buy, sell). Preferences are not roles and confer no rights. |
| **Sourced / claimed / verified** | A company record taken from a licensed public source; a record someone asserted control of; a record whose claim was confirmed with documentary evidence. Always shown distinctly. |
| **Principal** | Whoever is acting right now: a person, or a person's agent acting under a mandate. |

## Access and visibility

| Term | Meaning |
|---|---|
| **Participation** | A row that joins a resource (project, RFQ, quote, agreement, order, thread, publication) to a party with capabilities, side, audience and validity. |
| **Capability** | One of fifteen fixed verbs: `read.public`, `read.shared`, `read.party_private`, `read.owner_private`, `write.draft`, `publish`, `invite`, `negotiate`, `accept`, `commit_order`, `manage_participants`, `transfer_ownership`, `lead`, `export`, `staff.case_read`. |
| **Projection** | A fixed allowlist of fields for one audience. Five layers: `public`, `shared_party`, `party_private`, `owner_private`, `staff_case`. Every API read, search hit, export, notification and federation envelope goes through the same serializer. |
| **Disclosure rule** | If you are not allowed to know that something exists, you get "not found", never "forbidden". |
| **Case access grant** | The only way staff can see a customer's private object: scoped, at most 72 hours, approved by a second person, every read logged. |

## Content

| Term | Meaning |
|---|---|
| **Publication** | One store for news, articles, posts and announcements; personal, company or editorial authorship. |
| **Publication version** | An immutable edition of a publication. Corrections create new versions with a visible note. |
| **Wall** | A personal or company page section that references publication versions; never a copy. |
| **Issue** | A numbered, dated magazine edition that freezes an ordered list of publication versions. |
| **Source** | Where a news item or a directory fact came from, with licence, observed time and allowed uses. |

## Commerce

| Term | Meaning |
|---|---|
| **Need** | An intake of what someone wants, possibly vague, before it becomes a request. |
| **RFQ** | A request for quotes. Its published versions are immutable. |
| **Quote** | A seller's answer to one RFQ version, with immutable sent versions. |
| **Stale** | A quote pinned to an RFQ version that has since been amended. A flag, never a status. |
| **Digest** | `trustwork-digest-1`: SHA-256 over the RFC 8785 canonical bytes of a payload. Binds versions, acceptances and approvals. |
| **Agreement** | Accepted terms pinned by digest to exact quote and RFQ versions; buyer acceptance and seller acceptance are separate events. Its kind (`terms_kind`: `rfq_quote`, `task` or `consultation`) will be part of the digest input (proposed: COM-002, ADR 012 decision 19). |
| **Order** | A commitment under an agreement, possible only with authority and a budget reservation. |
| **Catalogue offering** | A reusable, versioned description of goods, works or services. Changing the catalogue never changes a sent quote. |
| **Introduction** | A double-opt-in connection between two parties proposed by a person, an agent or the matching engine. See [Partners and matching](partners-and-matching.md). |

## Agents and authority

| Term | Meaning |
|---|---|
| **Your agent** | The single assistant that works for a person. Same thing as "the assistant"; there is no list of agents. |
| **Company representative** | A company's single standing agent, with a named accountable person, acting only under company mandates; suspends when no accountable person or confirmed mandate remains. |
| **Mandate** | A structured grant from a principal to their agent: allowed actions, contexts, limits, conditions, budgets, expiry, revision. Readable, changeable, revocable. |
| **Goal** | A proposed object that tells your agent what to achieve (for example "find three facade subcontractors in the Austin area before 1 December") with success criteria and allowed actions. |
| **Run** | One durable piece of agent work, made of steps with checkpoints. |
| **Action intent** | A proposed external effect with its digest, states and reservations. |
| **Approval** | A human decision bound to the exact action digest; any material change invalidates it. |
| **Budget** | A limit of money of one of two kinds: `transaction` (buying goods, works, services) or `platform` (paying the platform for generated deliverables). One never implies the other. |
| **Reservation** | Money set aside atomically for an action; settled or released only from evidence. |
| **Outcome unknown** | A provider call whose result is not known (timeout, crash). It keeps its reservation and goes to reconciliation; it is never retried blindly. |

## Trust

| Term | Meaning |
|---|---|
| **Assertion** | A claim that something happened (delivered, accepted, paid). Not a fact until confirmed. |
| **Evidence** | Files and records that support an assertion, with provenance. |
| **Dispute** | A challenge to an assertion; disputed observations are excluded or annotated in reputation until resolved. |
| **Reputation snapshot** | Scores per dimension (timing, quality, payment, cooperation, reviews) under a published method version, with sample counts and exclusions. |
| **Verification recipe** | A hub's configured set of checks (register lookup, licence lookup, sanctions screening, documents) that produce evidence types for a claim. See [Hub administration](hub-administration.md#counterparty-verification). |

## Plans and the gathering point

| Term | Meaning |
|---|---|
| **Plan** | The one plan of a project: phases, tasks, required expertise and trades, materials, permits and inspections, budget ranges, timeline, risks and decision points. Owner-private by default. See [Projects](projects.md#plans-from-plan-to-people) and the [data model](../data/model.md#7-projects-and-plans). |
| **Plan version** | An edition of the plan with the status `draft`, `proposed`, `approved` or `superseded`. A proposed version is frozen; only the plan owner (or a person the owner authorized) approves; an agent may only propose under a mandate; an approved version is never edited, it is superseded. The approved version is the **baseline**. |
| **Plan item** | One element of a plan version (phase, task, milestone, consultation, purchase, material, permit, inspection, decision, risk or a do-it-yourself step), keyed stably across versions and tagged with plan-step terms. Its execution state lives beside the frozen version. |
| **Plan change** | A recorded move from one plan version to the next with its reason, who asked for it and who is accountable, so client-caused changes never count against a supplier's timing. |
| **Plan share** | A per-item, per-audience grant (`public`, `invited`, `after_acceptance`) that reveals exactly the listed fields of a plan item, for example scope and drawings but not the budget range or address. |
| **Plan-step taxonomy** | The open classification of plan steps (work types, trades, materials, stages) with predecessor relations, published as CC0 1.0 data (PLAN-000). Proprietary classifications are licensed hub data and never ship in the repository. |
| **Consultation** | Paid or free expert time booked from a plan item or directly: an advice session, a review of drawings or quotes, a site visit or a mentoring session, ending in a deliverable the client accepts. A booking is an agreement of kind `consultation`. |
| **Task** | A scoped piece of work cut from a plan item for a contractor or trade. Under the hood an RFQ-like request with immutable offers; acceptance creates an agreement of kind `task`. |
| **Mentoring** | A double-opt-in relationship between a mentor and a mentee, free or paid; its sessions are consultations. |
| **Knowledge item** | A diary entry, lesson, checklist, plan template, answer or case study published from a completed project with the owner's and named participants' consent. |
| **Recommendation** | A suggestion for a plan step (material or product, guide, course, event, consultant or contact) with an explanation of why it fits and what is unknown. Ranked by fit only; never paid for. |
| **Sponsored slot** | A separate, labelled place where a hub that switched sponsored content on (off by default) may show sponsored items. It never feeds ranking, matching, recommendations or reputation. |
| **Sourced manufacturer page** | A company page the editorial office built from a manufacturer's or supplier's public site, within the hub's legal basis and the site's licence and robots rules, labelled "from sources" until the company claims it. |

## Reputation building

| Term | Meaning |
|---|---|
| **Credential** | A licence, insurance certificate, professional certification or platform certificate a participant holds, with the hub's check result ("checked on date by hub X") and expiry. Documents are never shown publicly. |
| **Portfolio entry** | Completed work with evidence, labelled "client confirmed" only when the client or owner confirmed it, otherwise "self-reported". |
| **Confirmation** | A counterparty's recorded decision (`confirmed`, `declined`, `partially`) on a statement tied to a real agreement, task, consultation or project. The answer to a **confirmation request**. |
| **Contribution** | A recorded knowledge contribution with its outcome: a publication, an accepted answer, a consultation given, mentoring, a course taught, a talk, a document review or a knowledge item. Counted by outcome, never by volume. |
| **Timeliness signal** | An observation of response, delivery, payment or milestone timing against what was agreed, with attribution; client-caused changes are excluded. |
| **Reputation passport** | A portable, verifiable bundle of a participant's credentials, portfolio, contributions and current snapshot, issued by the home hub as W3C Verifiable Credentials 2.0 (Open Badges 3.0 compatible), signed with the node key and revocable through status lists. The holder chooses what it contains. |
| **Appeal** | A request to reconsider a review, an observation or a decision, decided by a different person than the original decider. |

## Configuration and administration

| Term | Meaning |
|---|---|
| **Hub setting** | A versioned hub configuration record (prices and commissions, jurisdiction settings, modules, policies), changed by a new version with a reason, activated by a second person for sensitive domains, and never edited in place. |
| **Commission** | A marketplace fee (for consultations, tasks, marketplace categories, tickets, courses, agent capacity) set as a hub price version with second-person activation, an effective date and public disclosure. Never an input to ranking, matching, recommendations or reputation. |
| **Jurisdiction settings** | Per-hub and per-jurisdiction settings for agent disclosure wording, liability allocation, consent, record-keeping and per-action limits, starting from sourced country-pack defaults (HUB-005). The wording needs the hub's counsel. |
| **Module** | A packaged ability of the one agent (for example `project_planner`, `consultation`, `reputation_builder`), shipped with the engine and enabled and priced per hub. Never a separate agent. |
| **Extension** | A capability a hub administrator adds to agents through the governed extension registry (AGT-023): declared actions, inputs, data classes, side effects, endpoints, costs and mandate kinds, a safety suite, an adapter with a fake and second-person activation. It can add actions but never bypass mandates, budgets, kill switches, privacy rules, restricted places or the untrusted-text rule. |
| **Agent settings** | A participant's detailed configuration of their own agent: goals, modules, behaviour and tone, mandates and limits per action, budgets, schedules, channels, approval rules, sharing and external connections, with previews and explanations (AGT-022). |
| **Kill switch** | A control that stops agent dispatch (or one module, connection or provider) at once; releasing it needs a second person and an incident note. |
| **Setup wizard** | The first-run flow on a fresh node, opened with a one-time setup token, that creates a draft hub (HUB-004). |
| **Review status** | How far a contributed record has been checked before anyone relies on it, never overstated. A locale is *reference* (English), *machine draft*, *community reviewed* or *native reviewed*, raised only when a named reviewer actually reviewed it (ADR 012 decision 30, INTL-007). A country pack is `enabled` once maintainers reviewed it, its `status` says how complete its dictionaries are (`complete`, `partial`, `draft`), and each fact carries a `verification` note such as "pending official confirmation". Imported items and AI drafts wait in a review queue until a person decides. |
| **Demo-only hub** | A hub that runs on synthetic, labelled data and accepts no real sign-ups. The US reference hub is demo-only until QA-002, counsel review and the owner's switch. |

# Product specification and accepted constraints

Decision baseline: human discussion reconciled by the coordinator on 2026-10-26. The human confirmed a Russian product UI on 2026-10-26 (superseded by ADR-009: multilingual, English fallback); English remains the engineering language. New lifecycle decision: standalone development, tests, public deployment, explicit client approval, then adoption by an external development-management platform for continued development. This bootstrap does not authorize deployment. **Accepted constraints are not implemented features.** Research hypotheses and design status remain separately labelled. This document supersedes contradictory legacy flows and generated screenshot text.

## Purpose and success

Trustwork combines a useful public industry publication/community with tools for buying, selling and delivering goods, works and services. It serves a persistent human identity. Personal relief, professional agency, confidence and a good experience come before employer surveillance or efficiency dashboards. Test usefulness through consenting participant research, not invented engagement numbers. The planned ten procurement interviews have not happened.

Basic participation exists for both commercial sides and for non-commercial readers/authors. A company can buy and sell simultaneously. The product starts and develops independently. Adoption by an external development-management platform happens only after the tested system is publicly deployed and the client explicitly approves it. The product remains operable without that platform after connection. Delivery agents building software and assistants serving customers are different systems.

## Accepted requirement register

| ID | Requirement and invariant | Implementation boundary |
|---|---|---|
| R01 | Persistent human profile, public page/wall, experience, publications and reputation; own contributions survive employment changes | Authentication recovery/email rebinding must prove ownership; corporate mailbox access is not assumed to survive departure |
| R02 | One ordinary current employer company, many employees, shared company page with permission-scoped editing | No company/workspace switcher; multiple simultaneous employers unresolved/out of scope; historical memberships retained privately |
| R03 | Buy/sell/industry participation are combinable preferences and capabilities | They are not accounts, company roles, authorship rights, subscriptions or spending authority |
| R04 | Projects are first-class; owner person OR company; creator and responsible leader distinct | Private default; explicit transfer, leadership changes, scoped participants and publication projection |
| R05 | Procurement intake -> clarification -> RFQ -> discovery -> eligibility -> quote versions -> normalization -> negotiation -> selection/order -> fulfillment -> acceptance -> review | Manual, file, trusted email and assistant input; scope includes goods, works, services and mixed bundles |
| R06 | Reusable, versioned supplier catalogue separate from client-specific quote snapshots | Sent quote and agreed terms never change when catalogue changes; private floors never published |
| R07 | Sales leads/requests -> quote -> negotiation -> order acceptance -> fulfillment/acceptance | Contacts/templates/campaigns contextual; no overloaded default CRM navigation |
| R08 | Correspondence belongs to RFQ, quote, transaction or project; preserve existing email | Provider adapters and idempotence; notifications separate; no standalone generic inbox |
| R09 | One personal assistant, full page and icon-only bottom-right overlay launcher | Floating overlay does not shrink content; internals may specialize without exposing agent management |
| R10 | Buyers and suppliers may delegate preparation, research, communication, bargaining and transactions immediately within explicit authority | Action/context/conditions/limits/time/budgets/approval/escalation/revocation; no privilege amplification |
| R11 | Assistant proactively proposes useful deliverables and backlog work | User service backlog distinct from software-development backlog; no blanket mailbox/screen/company access |
| R12 | Project lifecycle includes roadmap/dependencies/milestones/budgets/participants/purchases/obligations/delivery/work/acceptance | Baseline and changed plans distinct; future scope preserved even when phased |
| R13 | Separate assertion, evidence, confirmed fact, dispute, correction/reversal and accountability | Customer-caused change must not automatically penalize supplier timing |
| R14 | Reputation combines subjective reviews and evidence-backed dimensions: timing, quality, payment, cooperation | Sample counts, methodology/version, missing data and appeals; paid access cannot buy ranking |
| R15 | Public resource includes the exact public sections of the information architecture (eight since ADR 010: home, news, articles, events, companies, people, projects, magazine) and company/people/project directories | Source-derived, claimed and verified are distinct; people publication/consent and licensing controlled |
| R16 | Publications have author, format, topics, entity links, lifecycle and corrections | Personal/company/editorial authorship; walls reference the same publication, not duplicate stores |
| R17 | Weekly curated magazine has issue number/date/contents/archive, responsive reader and separately laid-out PDF | Not just a news grid; desktop spread optional, mobile single column readable |
| R18 | Personalized intelligence journal is an opportunity with unresolved free/sample/recurrence terms | Markets/competitors/materials/technology coverage; no surveillance or invented paywall |
| R19 | Free minimum participation for both sides; paid assistant trial, tiered subscriptions, separately billed outputs | Actual prices, trial duration and journal rules unknown; personal/company payers and employee/project budgets |
| R20 | Platform commercial administration versions offers, plans, prices, entitlements, usage and credits | Effective dates and price acceptance; separate editorial/moderation/support/company administration |
| R21 | Email/password login, recovery and signup; Apple and Google alternatives | Left visual/right form; one name field, email/password/terms; no compulsory surname/company details |
| R22 | Optional multi-select onboarding; optional categories/regions second step; skip | No forced INN questionnaire; preferences confer no legal/company access |
| R23 | Daily overview and stable sidebar; simultaneous buying and selling when relevant | No endless welcome screen, role-focus dropdown, generic charts, AI reshuffling or primary menu-setup button |
| R24 | Account only circular top-right avatar; sidebar collapse inside brand row | No avatar chevron/name, bottom-left duplicate account block, company selector; contextual settings |
| R25 | Three blue squares in L arrangement plus a black stacked wordmark reading "trust / work" in every language, and a stacked Russian-language wordmark only in the Russian interface (ADR 010 decision 14); light restrained design | Canonical editable logo not yet created; latest workspace proposal not approved; mobile/accessibility required |
| R26 | Russian UI through i18n, English engineering artifacts | Reference image content synthetic; never seed real claims |
| R27 | Independent runtime, optional external development-management adapter with explicit export/detach | No external DB/login/deployment dependency; unsupported manifests forbidden |
| R28 | Multi-party private/shared/public data projections and auditable access | Single-employer UI does not reduce data access to current_company_id; each object checks participation |
| R29 | Durable, structured assistant run/action/approval/outcome records | External timeout -> outcome_unknown -> reconciliation; no blind duplicate order/payment |
| R30 | Evidence-based parallel delivery with atomic claims and review gates | Foundation/contracts before dependent implementation; one integrator for shared contracts/migrations/lockfiles |

## Requirements added by owner decisions of 2026-10-30 (ADR 010)

Accepted as requirements; every detailed design in the [engine handbook](../engine/README.md) remains proposed until its task is accepted.

| ID | Requirement and invariant | Implementation boundary |
|---|---|---|
| R32 | Events: participants attend and host events (editorial, company or personal organizer); programme, speakers, tickets, registration, check-in, materials and partner meetings | Speakers appear only with consent; ticket prices are versioned; paid tickets use billing adapters; sponsorship is labelled and never changes ranking |
| R33 | Learning: courses and verifiable platform certificates shown on the personal profile | A platform certificate is not a state qualification unless the hub records an accreditation with its source; certificates can be revoked with reason |
| R34 | Partners and matching: discover partners; explainable matching of needs with offers and of clients with contractors; double-opt-in introductions | Criteria and uncertainty are shown; no pay-to-rank; outreach quotas and consent; external candidates are not platform users |
| R35 | Representative agents: each participant's agent represents them under their direction, finds partners, presents services, negotiates and pursues goals, including with other participants' agents | One assistant surface per person (R09); a company may enable one standing representative with a named accountable person (ADR 010 decision 9); only structured mandates authorize (R10); agent-to-agent exchange moves through RFQ/quote/agreement/introduction objects; agent messages are labelled and untrusted for the receiver |
| R36 | Hubs: the engine runs as hubs, each serving a country or a region or city inside it, operated by a hub operator responsible for local legal compliance | Territory claims are descriptive and non-exclusive; a hub never covers a restricted place |
| R37 | Hub administration: the hub operator configures information sources, counterparty verification against local registers, sanctions screening, legal documents, payments, electronic signatures, taxonomy, editorial and agent policies | Same use cases with staff authority, audit, second-person activation for providers and prices; no control can widen data access or buy ranking |
| R38 | Country specifics: identifiers and registers, construction licensing, codes and standards, procurement, tax and e-invoicing, e-signatures, payments, calendars, languages and scripts, privacy and content law are data in country packs and hub configuration | Every pack fact cites its source and verification state; engine logic stays country-agnostic |
| R39 | Worldwide mesh: independently operated deployments federate; country and city hubs complement each other; public content, directories and events flow between nodes; participants on different nodes can deal | Only the public projection federates by default; shared deal data travels only between the parties' nodes; home node is the only writer; links, never merges; tombstones propagate; restricted places cannot join ([ADR 011](../adr/011-federation-mesh.md)) |

## Requirements added by owner decisions of 2026-10-31 (ADR 010 decisions 16–22, ADR 012)

Accepted as requirements; designs remain proposed until their work packages are accepted. Traced to packages in [traceability.json](traceability.json).

| ID | Requirement and invariant | Implementation boundary |
|---|---|---|
| R40 | Configurable engine with a United States reference hub: country, city, languages, currency, identifiers, registers, legal texts and defaults are configuration (country packs, hub configuration, setup wizard); the reference and demo deployment is a US hub (English and Spanish, USD, states and territories, EIN, state licensing, sales tax, SAM.gov, ESIGN/UETA, card and ACH, state privacy laws, federal holidays) | No country-specific engine code; no default country when nothing is configured; the setup wizard requires one; demo data is synthetic and labelled; the other country packs remain examples |
| R41 | Plan to people: anyone launches a project and their agent turns it into a versioned plan (phases, tasks, trades and expertise, materials, permits and inspections, budget ranges, timeline, risks, decision points); plan items become requests for consultations and scoped tasks | Only the owner approves a plan version; agents propose under mandates; plans are private by default and budgets never reach other parties; the plan-step taxonomy is open (CC0) |
| R42 | Consultations and mentoring: advice sessions, reviews of drawings or quotes, site visits and mentoring series with experts, scoped, scheduled, free or priced, with deliverables | Booked terms are immutable and digest-bound; a site address only after booking; paid status never changes rank; charging only through licensed payment providers |
| R43 | Shared knowledge: with consent, completed projects become diaries, lessons, checklists, templates, questions and answers and mentoring | The owner's consent and each named participant's consent or anonymization; redaction review; the author's licence travels with every copy |
| R44 | Reputation building: every participant builds and confirms their own reputation (verified identity, licences, insurance, certificates, an evidence-backed portfolio, confirmations tied to real interactions, knowledge contributions, timeliness, a portable verifiable passport, coaching, disputes and appeals) | Explainable and evidence-based; never for sale; no surveillance or per-employee metrics; confirmations only from real counterparties |
| R45 | Plan-step knowledge: for every plan step the system recommends materials and products, guides, training, events, consultants and contacts, including sourced manufacturer and supplier content | Within the hub's legal basis, licences and robots rules; sourced until claimed; every recommendation explained; never paid; sponsored content off by default, labelled and outside ranking |
| R46 | No held funds: Trustwork and hub operators never hold, pool or move participants' money; payments, escrow, retainage and payouts go only through licensed providers configured per hub | The engine records instructions, provider references, evidence and reconciliation; unknown outcomes are reconciled; no card or bank data is stored |
| R47 | Hub commissions and fees are versioned settings of the hub administrator | Second-person activation, effective date and public disclosure; no hidden or per-lead fees; payment never changes ranking, matching, recommendations or reputation |
| R48 | Jurisdiction settings: agent disclosure wording, liability allocation, consent, record-keeping and per-action limits are per-hub and per-jurisdiction settings with sourced country-pack defaults | Versioned, audited and activated by a second person; a hub may be stricter than a mandatory pack rule, never weaker; wording reviewed by counsel |
| R49 | Detailed agent settings: participants configure their own agent (goals, modules, behaviour and tone, mandates and limits per action, budgets, schedules, channels, approval rules, sharing, external connections) with previews and explanations | Settings compile into structured mandates and never authorize by themselves; one assistant surface per person; no agent management UI |
| R50 | Agent extensions: hub administrators add functions, tools, integrations and capabilities to agents through a governed extension registry | Each extension declares actions, inputs, data classes, side effects, endpoints, costs and mandate kinds, ships a safety suite and an adapter with a fake, and is activated by a second person; extensions never bypass mandates, budgets, kill switches, privacy rules, restricted places or the untrusted-text rule |
| R51 | International by default: languages and country packs. No region is privileged in documentation, examples or defaults beyond the United States reference hub; languages follow the roadmap of ADR 012 decision 30 (Spanish, Portuguese, French, German, Italian, Polish, Ukrainian, Turkish, Arabic with right-to-left support, Chinese in Simplified script, Hindi and Japanese with their typography, and any language a contributor brings), and country packs follow it too (Canada, Mexico, Brazil, the United Kingdom, an EU layer with Germany, France, Spain, Italy and Poland, Ukraine, Türkiye, the United Arab Emirates, India, Australia) | Every locale carries an honest review status (machine draft, community reviewed, native reviewed) shown in the language picker and the docs; every pack fact cites an official source or is labelled with its lower verification level; Ukraine covers government-controlled territory only and restricted places are never offered; Russia is not a market and Russian is never a default |
| R52 | Complete, accurate and visual documentation in English: a handbook that matches the code, guides per participant role, an operator installation guide, a generated API reference and a visual handbook with current screenshots and diagrams | Documentation is English only and contains no Cyrillic (checked by `npm run validate:docs`); statements about what works are checked against the code and dated; screenshots are regenerated by a script from the running demo, never edited by hand; diagrams are Mermaid sources in the repository; API reference is generated from contracts and registered routes |

## Identity, company and public pages

A human can read and publish without a company. Personal public profile and personal private work view must be separate projections, even if reachable from one destination. A company hub contains details, wall, people, catalogue, projects, reputation and external website. Joining or editing a company needs invitation/verified authority under a still-to-be-chosen claim policy. A sourced directory record is not a verified business or a registered account.

Employment end removes company-derived grants, sessions/cached decisions as needed and active delegations promptly. Own identity and public authorship remain. Access to company history is not a personal export right. Any residual read-only grant must be explicit, scoped, revocable and policy-approved; the default and retention details remain open. Historical actions retain accountable actor identity even when membership changes.

Projects can involve several companies and people. Buyer cost limits, seller margin floors and private correspondence are separate from shared accepted agreement terms. Publication is an allowlisted projection, not a visibility flag on every attachment. Transfer requires consent by an authorized recipient, audit and re-evaluation of access; leadership assignment alone transfers no ownership.

## Commercial journeys

A requester captures an ambiguous need from a file/email/conversation. Missing scope, quantity, measurement unit, location, schedule and acceptance requirements are clarified before solicitation. Discovery can include external suppliers with sourced contact provenance; source availability does not grant permission for bulk outreach. Eligibility and fit scoring show criteria and uncertainty, not a magic reputation badge.

Each quote version preserves goods/works/services lines, specifications, options/substitutions, quantities, unit basis, taxes, currency, delivery/work milestones, payment and validity terms, attachments and originating catalogue version. Comparisons show exclusions and non-comparable scope. A human or properly delegated assistant selects a supplier and commits an order only after authority/budget checks. Seller acceptance is a separate event. Changes require agreed revisions; accepted snapshots are immutable.

Delivery, performed work, partial acceptance, defects, remediation and disputed payment produce separate records. A counterparty's claim is not automatically a confirmed fact. Commercial reviews can cite permitted facts and subjective experience, and can be appealed or corrected. Record missing data as unknown.

## Assistant journeys

The assistant can draft, research, negotiate and act under structured, inspectable mandates. A user can stop, revoke or change a mandate; UI must explain already-committed external actions that cannot be undone. A queued task rechecks current principal rights, mandate version, participant access, limits and both applicable budgets just before execution. Approval must bind an exact action digest/version; changing material terms invalidates it.

Procurement/sales commitments use transaction budgets. A paid generated catalogue, presentation or report uses a platform-service budget and versioned price acceptance. One grant does not imply the other. Reserve budgets atomically, reconcile unknown outcomes, and settle/release reservations only from evidence. Negotiation floors, private priorities, personal notes and credentials never enter the counterparty projection. Logs show useful actions/evidence without exposing private chain-of-thought.

Connected channels are individually granted with scopes and revocation. Incoming messages/documents are untrusted content. Recommendations to create useful deliverables may become drafts; sending, publication, spending or other consequential actions require applicable authority. No mandatory per-action human confirmation when a valid sufficient mandate already authorizes the action.

## Content and editorial

News carries source and event/publication times. Article format is separate from topic taxonomy (materials, technologies, markets) and entity links. Publications may be editorial, personal or company-authored, optionally assistant-assisted. Editing rights are independent from authorship credit. Lifecycle: draft, review where required, scheduled, published, corrected/retracted. Walls and magazine items refer to versioned publication records.

Magazine issue release freezes a curated order and selected publication versions; corrections create visible revisions. The web reader and PDF are separate output artifacts with shared content provenance and appropriate layouts. Personalized journals need explicit audience, sources, permitted data, cadence, and billing policy before implementation; the earlier invented one-free-then-paywall behavior is rejected.

## Measures and discovery gates

Research personal relief, perceived control, confidence, useful completion, interruption burden and willingness to return. Pair with voluntary qualitative feedback; do not monitor employee performance covertly. Quantitative baselines and targets are unknown. Interview synthesis must preserve dissent and avoid gender stereotypes or claims of prevalence from ten people. Product quality gates include task success without surprise external action, correct permission denial and understandable explanations.

## Required retrieval capability

| ID | Requirement | Boundary / acceptance |
|---|---|---|
| R31 | First-class Russian/multilingual hybrid RAG over permitted companies, people, projects, needs, quotes, publications and files | Source truth vs versioned derived projections; current field and party rights re-checked at candidacy, hydration and egress and delivery gates; exact structured facts and complete-domain calculations; reproducible lineage/citations; revocation/deletion/reindexing; evaluated semantic quality and bounded cost. Architecture/contracts/fixtures prepared, runtime not implemented. |

See [retrieval design](../architecture/retrieval.md), [knowledge schema](../data/knowledge-model.md) and [evaluation gates](../quality/retrieval-evaluation.md). RAG is required now; only a separate external vector database remains conditional on evidence.

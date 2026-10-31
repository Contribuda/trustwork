# Module administration

Status: **Proposed**. Every product module is administrable from the hub console. For each module this chapter lists what staff **see**, what they **do**, the **settings**, the **queues**, the **metrics** (aggregate, never per-person behaviour) and the **guard rails** that no setting removes. Contracts are named where they exist; [data model view](data-model.md) maps each section to entities and projection layers; [screens](screens.md) has the screen contracts.

Rules common to every module:

- Staff see **public projections** and **operational counts** by default. Anything private (a project's budget, an RFQ's private constraints, a quote's floor, a negotiation, a private file, a message) is visible only inside a **case or dispute grant**: scoped to named objects, approved by a second person, at most 72 hours, every read logged, `negotiation_private`, `credentials` and `payment_refs` always excluded (`CaseAccessGrantSchema`).
- No control sets a score, a rank, a position, "featured" or a badge directly.
- Every mutation calls the module's own use case with a reason and an audit record.
- Settings are versioned configuration (`HubConfigVersionSchema`, domain per module).
- Each module's agent capabilities can be turned off per hub, participant type and plan, the model each one uses is a route choice, and its prices are versioned price records: the complete control set of [ADR 010](../../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 25 is in [agent product administration](user-agents-admin.md#the-complete-control-set-adr-010-decision-25) and [keys, providers and models](providers-and-models.md#the-administrators-complete-control-set). No module setting can switch off the guard rails listed there.

## People and companies

| | |
|---|---|
| **Sees** | Public profiles; account state counts; companies with sourced / claimed / verified state, legal identifiers (pack kinds or local additions such as EIN), register re-check dates; company representatives' state (active, suspended, accountable person named or missing) |
| **Does** | Decide claims (recipe steps with evidence); revoke verification with reason; record consent and portrait licences; flag records; activate import batches of sourced companies; decide link proposals; suspend a company representative for safety (the company is notified; company administrators can resume it after fixing the cause) |
| **Settings** | Claim and verification recipes per subject and trigger ([Hub administration](../hub-administration.md#recipes)); which evidence types exist in the country; recheck cadence; whether insurance evidence is requested; profile visibility defaults (private by default) |
| **Queues** | Claims; potential sanctions matches; register changes affecting verified companies; consent withdrawals; link proposals |
| **Metrics** | Companies by state (sourced, claimed, verified); claim decision time; revocations by reason category |
| **Guard rails** | An identifier never upgrades a badge; uploaded register extracts prove nothing; verified never means good; staff never edit a person's public profile content (they can hold it under moderation) |

US example recipe `company-claim-us`: Secretary of State register match (active, name and address), EIN confirmation through an IRS-issued letter checked by the reviewer, signatory tie by an e-signature compliant with ESIGN/UETA or a call-back to the registered phone, sanctions screening, ownership declaration. Contractor licence check through the state licence board for regulated trades.

## Projects

| | |
|---|---|
| **Sees** | Public projections of published projects; counts by status; ownership transfer and dispute queues |
| **Does** | Hold a published project under moderation; handle transfer disputes with a dispute grant |
| **Settings** | Whether projects may be published at all in the hub; which fields the public projection may contain (a subset of the engine allowlist, never wider) |
| **Queues** | Reports on published projects; transfer disputes |
| **Metrics** | Projects created, published, completed (counts) |
| **Guard rails** | Projects are private by default; budgets never reach participants without the right, public projections, search or peers |

## Plan to people

The flagship journey (owner decision 2026-10-31): a participant launches a project, their agent turns it into a plan, plan items become **consultation requests** and **task requests** to experts and contractors, both sides' agents automate within mandates, and completed projects become **shared knowledge** with consent. Modules `project_planner`, `expert_marketplace`, `shared_knowledge`, `plan_recommendations` (`HUB_MODULES`).

### Planner templates

| | |
|---|---|
| **Sees** | Template versions per country and project type (`PlanTemplateVersionSchema`): phases, items (task, consultation, milestone, document, permit check), categories, licence categories, typical durations, dependencies, references to codes and permit rules |
| **Does** | Hub experts (staff with an editor role and a declared expertise) draft templates; **a different person reviews and publishes** (the contract forbids an author publishing their own template); retire versions |
| **Settings** | Which project types exist; which templates are offered by default per territory; how much the agent may adapt a template (add items, remove items, reorder) before the owner confirms |
| **Queues** | Templates in review; feedback from participants ("this step is missing in Texas") |
| **Metrics** | Plans created per template, share of plan items turned into requests, share of projects completed (cohort counts) |
| **Guard rails** | Templates contain no private data; a plan instantiated from a template is the owner's private project; templates cite their regulatory references and say they are not legal advice |

US example: "Single-family house, new build" with phases design, permits, site preparation, foundation, framing, MEP (mechanical, electrical, plumbing), inspections, finishes; permit items reference the city's building department; electrical items require a licensed electrical contractor where the state licenses them. Samarkand example: "Private house, Uzbekistan" with phases from the UZ pack's licensing facet.

### Consultation and task marketplace

| | |
|---|---|
| **Sees** | Category rules (`MarketplaceCategoryRuleSchema`); counts of open requests and accepted engagements per category; payout and dispute queues |
| **Does** | Edit category rules; set commissions as **fee versions** per category (`MarketplaceFeeVersionSchema`, second-person activation, public disclosure); decide refunds within policy; handle disputes with a dispute grant |
| **Settings** | Per category: consultation or task; who may offer (verified company, verified professional, either, or claimed); verification recipe and licence category (required for licensed categories); pricing model (fixed, hourly, quote-based); the category's fee version (`marketplace_fee_version`); cancellation window and dispute window; agent automation (may draft requests, may draft offers, may accept within mandate with verified counterparties only, requests per week) |
| **Queues** | Disputes; refund requests outside policy; providers whose licence expired (automatically paused in that category) |
| **Metrics** | Requests, matches, acceptances, completions, refunds, disputes per category (cohort counts); median time to first offer; commission revenue |
| **Guard rails** | Commission and plans never affect who is matched or in which order; licensed work only to verified licence holders; payment outcomes that are unknown go to reconciliation; experts' private rates and floors stay private |

### Shared knowledge

| | |
|---|---|
| **Sees** | Proposed knowledge shares (`KnowledgeShareSchema`): diaries, templates, Q&A, lessons; consent status of the owner and every named party |
| **Does** | Review and publish (as a publication, with corrections like any other); return for changes; withdraw when consent is withdrawn |
| **Settings** | Which kinds are accepted; whether anonymised sharing is allowed; review requirements; mentoring offers on or off |
| **Queues** | Shares awaiting consent; shares in review; withdrawals |
| **Metrics** | Shares published by kind; consent withdrawal rate; reads as cohort counts |
| **Guard rails** | Published only with the consent of the owner and every named party, after review, with private fields (budgets, prices, private files) excluded (`privateFieldsExcluded: true`); withdrawal unpublishes and tombstones |

### Plan-step recommendations

Configured in **Data → Recommendations**; see [autonomous editorial office](autonomous-editorial.md#plan-step-recommendations).

## Publications and the magazine

Configured in the [editorial office](autonomous-editorial.md): sources, pipelines, review, calendar, publications board, corrections, retractions, holds, translations, magazine issues and releases, editorial policy. Metrics: items published by treatment, corrections, retractions, review time. Guard rails: published versions immutable, corrections visible, no automatic publication, AI labelled.

## Events

| | |
|---|---|
| **Sees** | Events by state; organizers (editorial team, companies, persons); ticket types and price versions; registration and check-in **counts**; payout batches; refund requests |
| **Does** | Review events when the hosting policy requires; hold or cancel an event under moderation; decide refunds outside the organizer's policy; release payout batches (second person); screen organizers who take payments |
| **Settings** | Hosting policy (editorial only; verified companies and editorial; anyone with review; anyone without review); ticketing on or off; marketplace fee price version; refund defaults; check-in device rules; partner meetings on or off |
| **Queues** | Events in review; organizer screening; refunds; payout batches; reports |
| **Metrics** | Events published, registrations, attendance rate, cancellations, refunds (counts) |
| **Guard rails** | Attendee lists and online links never public; staff see attendees only with a case grant; sponsors never affect listing position; no public event ratings |

## Learning

| | |
|---|---|
| **Sees** | Courses and versions in review; certificates issued and revoked (counts); accreditation records with sources |
| **Does** | Review courses; revoke a certificate with a reason category; record an accreditation with its source and validity |
| **Settings** | Review requirements; paid courses on or off; author revenue share (price version); certificate validity defaults |
| **Queues** | Courses in review; revocation requests; accreditation proposals |
| **Metrics** | Enrolments, completions, certificates (counts) |
| **Guard rails** | Learning progress is private, no employer view; no accreditation shown without a recorded source; a certificate is never presented as a state licence |

## Partners and matching

| | |
|---|---|
| **Sees** | Needs board, partner posts, introductions (counts by state), matching method versions |
| **Does** | Moderate needs and posts; set introduction quotas; release a matching method version (reviewed, published with its explanation) |
| **Settings** | Quotas per person per week (shared with agents); needs board on or off; cross-border interest; method parameters within engine bounds |
| **Queues** | Reports on needs and posts; spam reports on introductions |
| **Metrics** | Needs published, filled; introductions requested and accepted (counts) |
| **Guard rails** | Paid entitlements never change rank (comparison test); matching uses only data the requester may see; no list of who viewed whom |

## Commerce: catalogue, RFQs, quotes, agreements, orders

| | |
|---|---|
| **Sees** | Counts of RFQs, quotes, agreements, orders by state; reconciliation queue of unknown external outcomes (identifiers and states only); public catalogue fields |
| **Does** | Edit category rules (for example "RFQs in category Electrical require a licence check"); reconcile unknown outcomes with evidence; open a case grant when a party asks for help |
| **Settings** | Category rules; whether quotes show prices with or without sales tax by default (US: without, with state and local tax computed per line where a tax provider is live); e-invoicing and e-signature providers; units and local names |
| **Queues** | Unknown outcomes; disputes escalated from execution |
| **Metrics** | Flow counts and median durations (published RFQ to first quote, acceptance to order) |
| **Guard rails** | Staff never see budgets, floors, private constraints or negotiation without a case grant (and `negotiation_private` is excluded even then); published RFQ versions and sent quote versions are immutable; no admin action changes accepted terms |

## Procurement and supply

The company-side suite from plan step to payment ([Procurement and supply](../procurement-and-supply.md), R53). Status: **Proposed** (HUBC-011: on fixtures first, then live). Companies own their routes, suppliers, budgets, documents and payments; the hub only publishes templates and policies and enables adapters.

| | |
|---|---|
| **Sees** | Template and policy versions; adapter connections and modes; cohort counts (companies using the suite, documents processed by kind, median requisition-to-receipt and receipt-to-payment times across at least ten companies); unknown payment and e-document outcomes (identifiers and states only) |
| **Does** | Publish **approval route templates** per company size and subject kind (requisition, award, order, invoice, payment proposal, document, substitution, budget change, payee change); bind the country pack's **document types** and publish **requirement-set templates** (supplier onboarding, order, receipt, invoice, handover); enable **e-invoicing networks** (for example Peppol with UBL in an EU hub, CFDI in a Mexican hub, NF-e in a Brazilian hub; none mandatory in a US hub) and **integrations** (accounting, ERP, project-tool imports, takeoff extensions) as fake, manual or live; reconcile unknown outcomes with evidence; open a case grant when a company asks for help |
| **Settings** | **AI intake**: allowed extraction adapters and model routes per data class, default confidence thresholds, file retention, languages, external OCR on or off. **Match tolerances**: default policy versions. **Fraud-control defaults**: cooling-off for changed payee details (engine minimum, hub may lengthen), callback requirement, risk-signal rules. **Agent payments**: whether `release_payment` may use `ask_above` for matched invoices to long-unchanged payees (off by default). **Benchmarks**: off by default; minimum group sizes, dominance share, time lag, method version, counsel sign-off. **Demand pooling**: off by default; pool rules and maximum share, counsel sign-off. **Units**: packaging conversions with sources |
| **Queues** | Template drafts awaiting a second person; adapter activations; unknown outcomes; benchmark cells flagged by the suppression check |
| **Metrics** | Cohort counts and medians only, never per company and never per person |
| **Guard rails** | Staff never see a company's routes, supplier base, levelling sheets, budgets, receipts, stock, invoices, payee details or payments without a case grant (and payee tokens are excluded even then); no template can remove the built-in segregation-of-duties rules or make an approval, a substitution decision or a risk-signal clearance automatic; no setting lets document text change a payee; benchmarks and pooling cannot be switched on without the counsel record; no Russian network, provider or software is offered |

US example: no e-invoicing network enabled by default; requirement-set template "subcontractor onboarding" asks for the vendor tax form, a certificate of insurance with expiry and the state licence where the trade needs one; QuickBooks Online and Xero adapters in fake mode until the operator connects them; ACH through the hub's licensed processor for supplier payments. Samarkand example: the Uzbekistan pack's e-invoicing facet decides the network; payments through the hub's licensed local provider; Uzbek Latin and Russian labels from the locale files.

## Execution and reputation

| | |
|---|---|
| **Sees** | Dispute cases; exclusion decisions; method versions; snapshot recomputation jobs |
| **Does** | Decide evidence in disputes with a dispute grant; exclude a disputed observation pending resolution; propose and release method versions (released by the hub owner role) |
| **Settings** | Local method parameters inside engine bounds (windows, minimum samples, confirmation period); appeal deadlines |
| **Queues** | Disputes; appeals |
| **Metrics** | Disputes opened, resolved, median time; observations excluded by reason |
| **Guard rails** | No control sets a score; missing data is unknown, not failure; payments never weigh |

### Reputation building: credentials, confirmations, methods and appeals

Owner decision 2026-10-31: every participant gets tools to **build and confirm** their own reputation. The console's part:

| Area | What staff configure and decide | Contract |
|---|---|---|
| **Credential types** | Which facts the hub verifies (identity, licence, insurance, qualification, certificate, membership, completed work, counterparty confirmation, knowledge contribution), for persons or companies, through which verification recipe, validity, re-check on source change, whether portable across hubs | `CredentialTypeSchema` |
| **Issued credentials** | The hub issues **verifiable credentials** (W3C VC data model) signed with a key from the node identity, after a reviewer's decision with evidence; holders keep and present them anywhere (the "reputation passport"); revocation is a status entry with a reason category in the hub's status list | `IssuedCredentialSchema` |
| **Confirmation requests** | Abuse controls: requests only for real linked transactions or projects, open requests per requester, requests per counterparty per month, cool-down after a decline, reciprocal confirmations flagged for review, agents may request but **never confirm** | `ConfirmationPolicySchema` |
| **Method versions** | Draft, review, release (hub owner) and publish with explanation texts in every hub language | Existing method release design |
| **Appeals** | One queue for appeals against claims, credentials, moderation decisions and excluded observations; the decider differs from the original reviewer | `admin.trust.appeals.decide` |
| **Metrics** | Credentials issued, revoked, expired by type; confirmation requests and acceptance rate; appeals and outcomes (cohort counts) | `AgentUsageStatSchema`-style suppression |

Guard rails: a credential is a checked fact, never a score; credentials are never sold (a hub may charge for the cost of a check, never for the result); revocation is visible but the reason shown publicly is a category only.

## Communications

| | |
|---|---|
| **Sees** | Sender identities and their DNS state (SPF, DKIM, DMARC), SMS sender registration (US: 10DLC brand and campaign registration), template versions per language, deliverability counts |
| **Does** | Edit templates (editors), activate versions (ops), send announcements to people who opted in, send legal notices |
| **Settings** | Channels offered; frequency defaults; quiet hours |
| **Queues** | Templates missing a language (blocks activation); bounces above threshold |
| **Metrics** | Delivery, bounce and complaint rates per template and channel |
| **Guard rails** | No message bodies of participants' correspondence; no marketing without a recorded lawful basis; transactional notices cannot be turned off by users; no per-person open tracking |

## Billing

| | |
|---|---|
| **Sees** | Offers, plan versions, price and metered price versions (cost beside sale price), prices per model and per capability, credit-pack versions, commission and fee versions, acceptances as counts, invoice runs, payout batches, credits issued |
| **Does** | Draft prices (one person) and activate (another), flat or as a markup over the cost price materialized into a fixed version; draft a new version when a cost change makes a margin negative (never an automatic price change); issue credits within role caps; set refund policy versions; release payout batches (second person) |
| **Settings** | Currency and accepted secondary currencies; tax treatment of the hub's own fees (US: state sales tax rules where platform fees are taxable, decided with tax advice); e-invoicing; free minimum and trial parameters; credit validity and refund policy shown before purchase (ADR 012 decision 33); advance notice for price increases |
| **Queues** | Payment outcomes unknown; refunds outside policy; payouts awaiting approval |
| **Metrics** | Revenue by offer, refunds, credits, payouts (aggregate) |
| **Guard rails** | No overlapping active versions; no back-dating; acceptances immutable; entitlements never change ranking, matching, recommendations or reputation; credits are never hidden refunds and never expire silently; every active price, fee and commission is on the public price page; Trustwork never holds participants' money (ADR 010 decision 20) |

## Search and knowledge

| | |
|---|---|
| **Sees** | Index generations and their states; evaluation summaries; knowledge sources with licence flags; quarantine |
| **Does** | Build, validate, activate, drain, taint and retire generations; quarantine a source; reindex |
| **Settings** | Embedding configuration per generation (frozen); languages and transliteration aliases; which sources are indexed or only linked |
| **Queues** | Tainted generations; erasure replays pending |
| **Metrics** | Freshness, recall against the exact oracle, latency (from evaluation runs) |
| **Guard rails** | Retrieval never widens access; a generation that may have mixed public and private material is tainted and can only retire |

## Federation

| | |
|---|---|
| **Sees** | Peers, levels, licences per data class, tombstones in and out, peer compliance (tombstones applied within the agreed period), incoming link proposals |
| **Does** | Propose and accept peering; raise to `deal-routing` or `identity` (second person); lower or end peering; defederate; decide links |
| **Settings** | Node manifest licences (stricter than defaults only); defederation list |
| **Queues** | Peering requests; links; takedown notices |
| **Metrics** | Replicas received and sent, tombstone latency per peer |
| **Guard rails** | Private data never federates; restricted places are refused at handshake; authority stays home |

## Country base and taxonomy

| | |
|---|---|
| **Sees** | Bound country pack version with facts, sources and verification levels, or the generic profile with local additions |
| **Does** | Add local facts (identifiers, registers, licence categories, holidays, tax facts, units); export additions as a ready-to-submit pack change; release taxonomy versions (topics, categories, plan-step categories, units) |
| **Settings** | Pack binding and upgrade; local additions |
| **Queues** | Pack upgrades available; additions awaiting compliance review |
| **Metrics** | Share of facts verified `official` versus `candidate` |
| **Guard rails** | Engine code never branches on country; nothing can enable a restricted place |

US example local additions until the US pack exists: identifier kind `US-EIN` (pattern `^\d{2}-\d{7}$`, issuer IRS, verification `candidate`); entity forms LLC, corporation, partnership, sole proprietorship; regions = 50 states, DC and territories (`US-PR`, `US-GU`, …); US federal holidays; licence categories per state board; sales tax as a per-state fact with sources. Samarkand: everything from the UZ pack plus city places.

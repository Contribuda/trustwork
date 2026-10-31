# Hub administration: the operator's console

Normative requirements: [Hubs and the hub console](modules/hubs-and-console.md), [Trust, safety, privacy and compliance](modules/trust-safety-privacy-compliance.md). Participants: [who uses what](participants/README.md).

Requirements R37, R38, R20, R28. Status: administration permissions, audit events, case grants and second-person approvals are **Contract**; the platform administration backend is **Designed** (ADM-001); the hub console described here (built by ADM-002 and HUBC-002 … HUBC-010 under the HUB-002 umbrella; ADM-003 was superseded), its sources registry, verification recipes, screening configuration, launch checklist, jurisdiction settings (HUB-005), commission settings (BILL-003) and the agent extension registry (AGT-023) are **Proposed**. The project's own United States reference hub is described in [Hubs](hubs.md#the-reference-hub-united-states-decided).

The complete console design (installation, setup wizard, keys and models, autonomous editorial office, data mining, automation, agent product, every module, support workspace, operations, data model view and screen contracts) is in [The hub console](hub-console/README.md); this chapter keeps the guard rails, roles and verification design it builds on.

The hub operator develops the platform for a country or a city. Complying with local law, they connect the territory's information sources, check counterparties against local registers and sanctions lists, publish legal documents, choose payment and signature providers, shape the taxonomy, lead the editorial team and set the rules for agents. This chapter designs the console that makes that possible without ever becoming a back door into anyone's private data.

## Two levels of administration

| Console | Who | What |
|---|---|---|
| **Node console** | The node operator (whoever runs the installation) | Hubs on this node, node staff, platform-level provider adapters, engine version and migrations, backups and restore evidence, node signing key, node-level kill switches, the read-only list of restricted places |
| **Hub console** | The hub operator's staff | Everything in this chapter, for one hub |

On a node with a single hub the same people usually hold both. Every action in both consoles calls the same use cases as the product, with a staff principal, a required reason and an audit record. The administration module owns staff authority, case grants, queues and audit; it never writes other modules' tables directly.

## Guard rails that no console can switch off

1. **No access widening.** No setting, flag or role reads a customer's private object. Staff see private data only through a case access grant: scoped, at most 72 hours, approved by a second person, every read logged.
2. **No ranking controls.** No control sets a score, a position, "featured" or "top". Reputation changes only through evidence decisions and method releases.
3. **No impersonation.** There is no "log in as user".
4. **No raw database console and no unrestricted export.** Exports go through projection serializers.
5. **Restricted places are code.** The list cannot be edited from a console; a restricted territory cannot be configured.
6. **Baseline sanctions screening stays on.** The engine's baseline screening of partners and operators cannot be disabled from the console; a hub can only add lists.
7. **No surveillance dashboards.** Operational counts, never per-person behaviour analytics.

## Hub staff roles

Roles are scoped to one hub. A person keeps one identity and may also be an ordinary member of a company; conflict-of-interest declarations stop them acting on their own employer.

| Role | Main responsibilities |
|---|---|
| Hub owner | Final authority in the hub; releases reputation method versions; second approver |
| Staff admin | Assigns and revokes staff roles |
| Compliance officer | Legal documents, counsel approvals, sources' legal basis, screening lists, launch gates |
| Data steward | Sources, imports, directory linking, taxonomy and units |
| Trust reviewer | Claims and verification, evidence in disputes, exclusions |
| Editor-in-chief / editor | Publications, magazine, translations, event and course review |
| Moderator | Reports, moderation cases, sanctions levels 1–2 |
| Commercial admin | Hub offers, plans, price versions, payment and invoicing settings |
| Privacy officer | Deletion and erasure, retention, legal holds, subject access requests |
| Support agent / support lead | Support cases, diagnostics without private data, case grant requests and approvals |
| Ops engineer | Jobs, providers, index generations, kill switches, incidents |
| Auditor | Read-only audit browsing and export |

**Two people** are required (the second with a different role) for: assigning sensitive roles, activating a price version, executing an erasure, sanction level 4, enabling a non-fake provider of any kind (payment, verification, e-signature, e-invoicing, model, messaging), activating a legal document version, changing the data-residency setting, and raising a peering agreement to `deal-routing` or `identity` level. With fewer than five staff the hub runs in a reduced separation-of-duties mode where only actor ≠ approver is enforced.

## Console map

### Overview

- **Launch checklist** with each gate's state ([Hubs](hubs.md#launch-checklist-proposed)).
- **Queues**: claims, reports, import batches, reconciliation of unknown outcomes, case grant requests, deletion requests.
- **Compliance status**: legal documents due for review, screening lists last updated, sources with expiring licences, providers in fake mode.
- **Health**: jobs, outbox age, index freshness, delivery failures, as counts.

### Hub profile and legal

| Setting | Notes |
|---|---|
| Name, brand overlay, domain, languages, default language | Lettering checked for contrast and every hub language |
| Operator legal entity | Name, registration identifier from the country pack, address, contact for legal notices and abuse |
| Legal documents | Terms, privacy notice, sanctions and export-controls section, cookie notice, community rules, organizer terms for events, author terms for courses. Each is a **version** in every hub language, drafted from the engine templates, with a **counsel approval record** (who, when, which version) before activation |
| Imprint and media registration | Where local media law requires a registered outlet or editor-in-chief name |
| Data residency | Where personal data is stored and processed; drives storage configuration and which providers may receive personal data |
| Sub-processor register | Generated automatically from enabled adapters (hosting, e-mail, payments, verification, models) for the privacy notice; the operator adds descriptions |

### Country base

- **Country pack binding**: which pack version the hub uses; the console shows the pack's facts with their sources and verification state.
- **Local additions**: holidays, local unit names, taxonomy extensions, legal entity types missing from the pack. Additions that are facts about the country can be exported as a ready-to-submit change to the pack, so every hub in that country benefits ([Country specifics](country-specifics.md)).

### Information sources

The news desk, the directory and the knowledge base start from registered sources.

| Field | Meaning |
|---|---|
| Kind | `rss`, `api`, `file_drop`, `register_open_data`, `register_api`, `procurement_portal`, `standards_body`, `statistics`, `press_inbox`, `manual` |
| Purpose | News desk, company directory, people directory (consent rules apply), knowledge base, opportunities (procurement notices) |
| Legal basis and licence | Licence text or link, terms of use, robots policy where relevant, legal basis for personal data in the source |
| Allowed uses | Separate flags: display headline and link, display summary, store full text, index for search, send to model providers, syndicate to peer hubs |
| Attribution | Template shown with every item |
| Cadence | Polling interval or schedule; observed-at semantics |
| Takedown contact | Who to call when the source asks for removal |
| Owner | The data steward responsible |

Flow: **connector → import batch → review → activation**. News items become drafts in the editors' queue; directory records arrive as "from sources" with field-level provenance and go through **link proposals** (never automatic merges) when they match existing records. A source can be taken down: its records are deactivated, tombstones reach indexes and peers, and the audit explains why.

### Counterparty verification

This is where a hub turns local registers into trustworthy badges and eligibility signals.

#### Check types

| Check | Typical provider in a country | Produces |
|---|---|---|
| Company exists and is active | Business register (open data, API or manual lookup) | `register_match`, `status_active` |
| Identifier matches name and address | Business or tax register | `identifier_match` |
| Director or authorised signatory | Business register | `officer_match` |
| Tax status, VAT registration | Tax authority service | `tax_registered`, `vat_payer` |
| Construction licence or permit category | Licensing authority register | `licence_valid:<category>` with expiry |
| Professional qualification of a person | Professional body register | `qualification_valid:<kind>` |
| Beneficial ownership | Beneficial ownership register, where public | `ownership_disclosed` |
| Sanctions and export restrictions | Baseline list plus national and international lists | `screened_clear`, `potential_match` |
| Corporate domain control | E-mail code to the company domain | `domain_confirmed` |
| Signed authority | National electronic signature or ID | `signature_verified` |
| Call-back | Phone from the register | `callback_confirmed` (recorded by the reviewer) |

#### Providers and modes

Each check runs through an adapter in one of three modes: **fake** (tests and demos), **manual** (a trust reviewer looks it up and records the result with evidence), **live** (an API with credentials kept in the secret store, never shown in the console). Enabling live mode needs a second person. Each provider entry records cost per check, quotas, retention of results, the legal basis, and what personal data it receives.

#### Recipes

A **verification recipe** combines checks for a subject and a moment:

```yaml
recipe: company-claim-standard
subject: company
when: claim
steps:
  - check: register_match          # required
  - check: officer_match           # required unless signed_authority passes
  - any_of: [domain_confirmed, signed_authority, callback_confirmed]
  - check: sanctions_screening     # always
result:
  verified_if: all required pass and reviewer confirms
  badge_categories: [register record matches, signatory confirmed, sanctions screening clear]
recheck: every 12 months or when the register changes
```

Other typical recipes: seller onboarding before the first quote above a threshold; a licence check before an RFQ in a regulated category; re-screening of every counterparty when a sanctions list updates; professional qualification for a person's profile.

#### Reference recipes for the example countries

Decided by the integrator on 2026-10-30 under the owner's delegation (ADR 010 decision 11). These are the reference recipes the engine starts with; every hub may tighten them. Provider names are **candidates** gathered from secondary sources and become pack facts only after confirmation against official sources (CTRY-002, HUB-003).

**Two levels, the same everywhere:**

| Level | The claimant must show | Badge |
|---|---|---|
| **Claimed** | A verified login **and** one tie to the company: a code sent to an e-mail on the company's own domain, **or** a reviewer-recorded match between the claimant's name and an officer in the official register | "Claimed, awaiting verification" (`company.claim.claimed`), immediately |
| **Verified** | (a) the company is **active** in the official register and the registration identifier, name and address match, fetched by the reviewer or the register adapter, never taken from an uploaded extract; **and** (b) a **signatory tie**, one of: a statement signed with the national qualified electronic signature of the director or an authorized signatory; a power of attorney or authority letter signed with that signature; or, where no e-signature is available, a call-back to the phone listed in the official register **plus** a signed authority letter **plus** the reviewer's identity check of the claimant (a live video attestation, recorded as a check, never stored); **and** (c) sanctions screening clear (baseline list plus the hub's national lists); **and** (d) the ownership declaration signed | "Verified" (`company.claim.verified`), after the reviewer's decision |

**Rules that apply everywhere:** a registration number alone proves nothing; an uploaded register extract proves nothing; free e-mail services (common among small contractors) cannot satisfy the domain tie, so those firms use the register match plus the signatory tie; verification is re-checked every 12 months and whenever the register record changes; a potential sanctions match always goes to human review; spending authority (who may sign orders) is a separate proof and is not granted by verification.

**Country starting points (candidates).** These rows cover the four countries whose packs exist in the repository today. The United States recipe (state business entity registers, EIN, state contractor licence boards) is sourced with the US pack and demo hub (INTL-US, DEMO-US); every other country gets its recipe with its pack (CTRY-CA … CTRY-AU, CTRY-EU), sourced the same way.

| Country | Register check | Signatory tie | Notes |
|---|---|---|---|
| Uzbekistan | Tax identification (STIR) and legal entity status through the State Tax Committee services (soliq.uz is the identifier issuer recorded in the pack) | National electronic signature; E-IMZO is the candidate scheme, not yet confirmed | Personal data of citizens must stay in Uzbekistan (pack note): verification evidence is stored on the hub's in-country storage |
| Georgia | National Agency of Public Registry (napr.gov.ge), public company search by 9-digit identification code | ID card or mobile ID electronic signature | Register data is public; officer match by name is practical |
| Armenia | State Register of Legal Entities of the Ministry of Justice (e-register.am / e-register.moj.am) | ID card or mobile ID electronic signature | Records are in Armenian; reviewers need Armenian or a verified translation |
| Azerbaijan | Taxpayer (VÖEN) check of the State Tax Service (e-taxes.gov.az) | Asan İmza, named by several sources as the common enhanced signature | VÖEN check confirms tax registration; officer data may need a register extract fetched by the reviewer |

Sources consulted: [Georgia company register (NAPR)](https://napr.gov.ge/en/news/113), [Armenian legal entities register](https://e-register.moj.am/en/about-us), [Armenia registry services (Ministry of Justice)](https://moj.gov.am/en/իրավաբանական-անձանց-ռեգիստրի-ծառայություններ-1), [Azerbaijan VÖEN verification guide](https://lookuptax.com/docs/how-to-verify/tin-azerbaijan), [Azerbaijan company search guide](https://businessdataguide.com/blog/jurisdictions/azerbaijan-company-search-guide).

#### Results, appeals and retention

- Results are evidence records with source, time and classification; badges show categories, never documents.
- A **potential sanctions match** never auto-blocks or auto-clears: it opens a review case; the subject is told only what the law allows.
- Every adverse result can be appealed; the decider of the appeal differs from the original reviewer.
- Retention follows the legal basis; results expire and trigger re-checks.

#### Sanctions screening configuration

| Setting | Notes |
|---|---|
| Baseline list | The US Consolidated Screening List through `packages/compliance` (the engine's author is a US person); cannot be disabled |
| Additional lists | For example the UN Security Council consolidated list and national lists the operator must apply; each with source, update cadence and matching rules |
| Matching | Name normalisation, transliteration variants, threshold for "potential match"; every potential match goes to review |
| Ownership declaration | The partner declaration (organised in, operates in, 50% ownership by listed persons, appears on list) is mandatory for sellers and event organizers who take payments |
| Re-screening | On list update and on schedule |

### Claims and trust

- Evidence type catalogue for the hub, built from enabled checks.
- Claims queue and decisions; revocations with reasons.
- Reputation method: the engine defines the method structure and invariants; the hub may set local parameters inside allowed bounds (windows, minimum samples, review confirmation period), released as a method version by the hub owner and published with its explanation.
- Exclusion decisions and dispute cases.

### Editorial and community

| Setting | Notes |
|---|---|
| Editorial policy | Published; required review per format and author type |
| Magazine | Publication day and time, numbering, sections, PDF layout options |
| Translations | Which languages need human review before publishing |
| Community rules | Published in every hub language |
| Moderation clause library | Each rule maps to a published clause and, where relevant, to the local legal basis (defamation, hate speech, advertising labelling, consumer protection) |
| Comments and expert answers | On or off; who may comment |
| Sanction ladder | Durations for levels 1–3 within engine bounds; level 4 needs two people |

### Events and learning

Hosting policy, review requirements, ticketing on or off, marketplace fee price version, refund defaults, accreditation records with sources for courses recognised by professional bodies.

### Commerce and payments

Currency and secondary currencies (from the pack), VAT and tax settings for the hub's own fees, e-invoicing provider, e-signature providers, payment providers, payouts to organizers and authors, hub offers, plans and price versions (second-person activation), credits within role caps. Payment providers must be licensed; no setting can route participants' funds through an operator account, because Trustwork and hub operators never hold participants' money ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 20). **Commissions and fees** (consultations, tasks, marketplace categories, events, courses, agent capacity) are versioned price records with second-person activation, an effective date and public disclosure, never inputs to ranking, matching, recommendations or reputation (decision 21, BILL-003, [Billing](billing.md#commissions-and-fees-are-hub-settings)). Sponsored content is off by default; a hub that turns it on shows it only in a labelled slot outside ranking ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 3).

### Agents policy

| Setting | Notes |
|---|---|
| Allowed agent actions in the hub | For example commitments allowed only for verified companies; outreach only to platform participants |
| Outreach quotas | Introduction requests per person per week |
| External channels | Which messengers and e-mail integrations are allowed |
| Disclosure text | How agent-generated messages are labelled, in each hub language; part of the per-jurisdiction settings below |
| Jurisdiction settings | Agent disclosure wording, liability allocation for agent commitments, consent, record-keeping and per-action limits, per hub and per jurisdiction inside it, from sourced country-pack defaults; stricter than a mandatory pack rule allowed, weaker never; wording reviewed by counsel (ADR 010 decision 22, HUB-005, [console](hub-console/user-agents-admin.md#jurisdiction-settings)) |
| Modules and extensions | Which engine modules participants' agents may use, and capabilities added through the governed extension registry: declared actions, data classes, side effects, endpoints, costs and mandate kinds, a safety suite, an adapter with a fake and second-person activation; extensions can add actions but never bypass mandates, budgets, kill switches, privacy rules or restricted places (AGT-003, AGT-023, [console](hub-console/user-agents-admin.md#extensions-adding-capabilities-to-agents)) |
| Model providers and egress | A matrix of data class × provider: allowed, denied, allowed only for public data; respects data residency |
| Kill switch | Stops all agent dispatch in the hub immediately; release needs an incident note |

### Communications

Sender domains and identities, SMS sender registration, template versions per language, delivery health counts.

### Privacy and data

Retention classes mapped to local law (for example accounting documents kept for the statutory period), subject access requests with deadlines, deletion and erasure with second-person execution, legal holds, breach notification contacts and the local authority to notify.

### Federation

Peering agreements with levels and dates, data licences per class in the node manifest, defederation list, tombstone compliance of peers, incoming link proposals for companies and people known to peers ([Federation](federation.md)).

### Staff, audit and operations

Detailed in [hub console operations](hub-console/operations.md). Staff roles and conflicts, audit browsing and signed export, jobs and reconciliation, provider states, index generations, feature flags (which can never widen access), maintenance mode, incidents and post-incident reviews.

## Data model (Proposed)

| Entity | Key fields |
|---|---|
| `hub` | node, name, status, default locale, locales, brand ref |
| `hub_territory` | hub, level, code, place key |
| `hub_config_version` | hub, domain (`legal`, `sources`, `verification`, `commerce`, `agents`, `editorial`, …), payload, digest, drafted_by, activated_by, effective_from |
| `legal_document_version` | hub, kind, locale, body, digest, counsel_approval ref, status |
| `counsel_approval` | hub, document versions, counsel name, firm, date, scope note |
| `source` | hub, kind, purpose, licence, allowed uses, attribution, cadence, owner, status |
| `import_batch` | source, counts, conflicts, status, activated_by |
| `verification_provider` | hub, check type, adapter, mode, cost, quotas, retention, legal basis |
| `verification_recipe` | hub, subject kind, trigger, steps, result mapping, recheck policy, version |
| `verification_check` | subject, recipe version, check type, provider, result, evidence ref, expires_at |
| `screening_list` | hub, name, source, cadence, last updated |
| `screening_result` | subject, lists version, outcome, case ref |
| `peering_agreement` | hub, peer node, level, licences, started_at, ended_at |
| `launch_gate` | hub, gate, state, evidence ref |

## Acceptance tests for the console (when implemented)

- A staff member without a case grant gets "not found" for every private object through every console path.
- Enabling a live verification provider without a second approver fails.
- A legal document version without a counsel approval record cannot be activated.
- The hub cannot go public with an open launch gate.
- No console action changes a reputation score directly.
- Disabling baseline sanctions screening is impossible.

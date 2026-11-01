# Country specifics

Normative requirements: [Country packs and localization](modules/country-packs-and-localization.md). Participants: [who uses what](participants/README.md).

Requirement R38 (with ADR 009). Status: country pack v1 (identifier format, legal entity types, regions, currency, formats, address order, legal template references, data-residency note, sources) is **Live** for Uzbekistan, Georgia, Armenia and Azerbaijan. The pack v2 schema (facets at country and subdivision level, verification levels, several time zones and identifier kinds, the measurement-unit catalogue) is a **Contract** (CTRY-002); sourced v2 facts for the four example packs are **Live** as pack data (CTRY-003: registers, procurement, VAT, e-invoicing, e-signature, payments and holidays, each fact with its source and verification level), and the facets' use by engine modules is **Proposed**. The United States pack is the first sourced v2 pack (**Live**, INTL-US: every state, the District of Columbia and the territories, with California and San Diego County in depth; facts at candidate or pending level are labelled), shared layers are a **Contract** and the EU layer is **Live** as layer data (CTRY-EU: every fact read in the Official Journal or on another europa.eu page), no member pack lists it yet, and fourteen more packs are planned (ADR 012 decision 30; [Languages and countries](localization.md#languages-and-countries)), plus South Africa (CTRY-ZA), proposed by the [market-opportunities note](../research/market-opportunities-2026-11.md).

The United Kingdom pack is **Live** as pack data (CTRY-GB): four nations and 217 child subdivision entries from a secondary CLDR snapshot, sourced national and nation-specific facts, and published 2026-2028 bank holidays. Current ISO and counsel checks remain labelled.

Construction is local. What a valid company looks like, who may legally pour concrete for a school, which code a facade must meet, how an invoice must be issued, how a document is signed, what counts as a working day: all of this differs from country to country. The engine handles these differences with two layers and one rule.

## Two layers and one rule

| Layer | What it holds | Who changes it | How |
|---|---|---|---|
| **Country pack** | Facts about the country that are true for every hub there: identifier formats, registers and how to query them, licence categories, codes and standards, tax rates, e-invoicing and e-signature systems, holidays, scripts, legal facts. Every fact cites sources and states its verification level | Country-pack maintainers through reviewed pull requests | `packages/country-packs/packs/<cc>.json`, validated by schema and tests |
| **Hub configuration** | Decisions of one operator: which providers are enabled, credentials, policies, legal document versions, local taxonomy additions | Hub staff in the console | Versioned records in the database with audit and, where sensitive, a second approver |

**The rule:** engine logic stays country-agnostic. No code says `if (country === 'US')`, not even for the reference hub. Code asks the pack for a fact or the hub for a decision, and an adapter does the country-specific talking to the outside world.

### Shared layers (Contract; EU layer data Live)

Some facts are the same for a group of countries. A **layer** (`packages/country-packs/layers/<code>.json`, CTRY-EU) states them once, with sources; a pack lists the layers it inherits (`"layers": ["EU"]`, v2 only) and adds only what is national. The rules, enforced by the validator in `packages/country-packs/src/layers.ts`:

- a layer fact applies to every pack that lists the layer, unless the pack or one of its subdivisions declares a fact with the same `id`; that override keeps the facet and kind and must cite at least one source the layer fact does not cite, so a member pack never contradicts a layer fact silently;
- a layer that lists its members accepts only those packs, and a layer can never list a restricted place; a restricted pack stays refused whatever it lists;
- every layer fact cites a page on the layer's official hosts (for the EU: `europa.eu`);
- what members vary is recorded in `memberVaries` and left to the member packs (for the EU: VAT rates, national e-invoicing mandates, invoice retention, supervisory authorities, Eurocode national annexes, eID schemes, holidays, currency, construction licensing, national portals);
- a pack that lists a layer is refused by the plain validator (`validatePack`); it validates with `validateLayeredPack`, so a layer is never skipped.

Engine code reads facts with `layeredFactsFor(pack, facet, regionCode)`, which returns each fact with its scope and, for inherited facts, the layer as their source; it never branches on a layer code or on membership. Layer data is reached only through `@trustwork/country-packs/layers`, which the package index does not re-export, so it stays out of browser bundles.

The **EU layer** covers the GDPR, eIDAS and the European Digital Identity Wallet, the VAT Directive and VAT in the Digital Age (e-invoicing to public buyers, intra-EU e-invoicing and digital reporting from 1 July 2030), the Eurocodes (EN 1990 to EN 1999) and the Construction Products Regulation (EU) 2024/3110, the procurement directives with TED, eForms and the 2026 thresholds, SEPA and instant credit transfers, the Late Payment Directive, the Digital Services Act (notice and action, advertising, recommender systems, trader traceability), the AI Act disclosure duty (below official until counsel review, HUB-005), the European Accessibility Act and the EU consolidated financial sanctions list. Adapters are named only as candidates. Other groups (a customs union, a regional standards body) can become layers the same way.

## The facets

Each facet lists what the pack records, what adapters may exist, and what the hub configures.

### Companies, identifiers and registers

| Pack records | Adapters | Hub configures |
|---|---|---|
| All identifier kinds (tax number, register number, VAT number, statistical codes) with label, pattern, check-digit rule, issuer, example | Register lookup (open data dump, API, or manual) | Which register providers are live, credentials, cadence |
| Legal entity types | Beneficial ownership lookup where public | Verification recipes ([Hub administration](hub-administration.md#counterparty-verification)) |
| Business register(s): name, URL, what can be queried, licence of the data | — | Source registration for directory imports |

Pack v1 already has one identifier per country (`UZ-STIR`, `GE-IDC`, `AM-TIN`, `AZ-VOEN`); v2 allows several.

### Construction licensing and professional qualifications

| Pack records | Adapters | Hub configures |
|---|---|---|
| Which construction activities need a licence, permit or membership; categories or grades of contractors; issuing authority; public register | Licence register lookup | Which RFQ categories require which licence; recheck cadence |
| Regulated professions (engineers, architects, surveyors, welders) and the bodies that certify them | Professional register lookup | Professional qualification checks for profiles |
| Insurance requirements for contractors where mandatory | — | Whether insurance evidence is requested at onboarding |

Platform course certificates are never presented as these qualifications ([Learning](learning.md)).

### Building codes and standards

| Pack records | Adapters | Hub configures |
|---|---|---|
| National code system and its naming, the standards body, adoption of international standards (for example Eurocodes) where it applies, where official texts are published and under what licence | Knowledge source import where licensed | Which code texts may be indexed, cited or only linked ([Search and knowledge](search-and-knowledge.md#hub-knowledge-sources-proposed)) |

Articles and RFQ lines can reference a code clause as a structured link, so a reader in another country sees what it is and that it is foreign.

### Public procurement

| Pack records | Adapters | Hub configures |
|---|---|---|
| National e-procurement portal(s), thresholds, notice formats, open data availability | Procurement notice feed | Whether public notices appear as opportunities on the needs board, licence flags |

The engine does not submit bids to state portals; it helps people find and prepare for them.

### Tax and invoicing

| Pack records | Adapters | Hub configures |
|---|---|---|
| VAT or sales tax: standard and reduced rates, zero-rated cases, registration threshold, invoice requirements | E-invoicing adapter (issue, receive, status) | Tax settings for the hub's own fees; which e-invoicing provider is live |
| Mandatory e-invoicing system, scope (B2B, B2G, B2C), signature requirement | — | Whether quotes show prices with or without VAT by default |
| Withholding taxes relevant to services from abroad | — | — |

Quote lines already carry `taxAmount` so totals are recomputed exactly; the tax rule comes from the pack and the parties' tax registration, never from a hard-coded rate.

Procurement document types (tax forms, certificates of insurance, delivery and transport documents, lien waivers) and e-invoicing networks (for example Peppol with UBL in the EU, CFDI in Mexico, NF-e in Brazil; none mandatory in the US) are pack data used by [Procurement and supply](procurement-and-supply.md#documents-completeness-and-e-invoicing-networks) (proposed, PRC-012).

### Electronic identity and signatures

| Pack records | Adapters | Hub configures |
|---|---|---|
| National electronic signature schemes, their legal status, mobile ID, ID cards | Signature verification, signing service | Which schemes count as evidence for claims and authority, which can sign acceptance acts |
| National electronic identity for sign-in where it exists | OIDC or national eID adapter | Whether national eID sign-in is offered |

### Electronic documents in construction

| Pack records | Adapters | Hub configures |
|---|---|---|
| Typical documents and their legal forms: acceptance acts of works, hidden-works acts, delivery notes, as-built documentation, statutory retention periods | E-document exchange where a national system exists | Templates for acceptance acts per country ([Execution and reputation](execution-and-reputation.md)) |

### Payments

| Pack records | Adapters | Hub configures |
|---|---|---|
| Domestic card schemes and instant payment systems, common wallets, currency controls relevant to cross-border payments | Payment provider adapters | Live providers, payouts, refunds |

No provider is assumed to exist everywhere. Sanctioned banks and Russian payment rails are never integrated (ADR 009).

### Money, numbers and units

Currency, minor units and display rounding (already in v1), cash rounding rules, secondary currencies, the local names and symbols of units of measure (square metre, cubic metre, tonne, running metre; square foot, cubic yard and board foot where imperial units are used) mapped to the engine's unit catalogue, and local estimate norms where they exist.

### Calendar and time

Time zones (v1), working week, public holidays (fixed and movable, published by year with sources), fiscal year, date and number formats (taken from `Intl`). Holidays affect delivery dates, RFQ deadlines and event scheduling.

### Languages and scripts

Official and common languages (v1 `locales`), scripts (for example Latin and Cyrillic for Uzbek, Georgian, Armenian, Arabic written right to left, Han and Kana, Devanagari), transliteration rules for search and names, personal name order and patronymics, typography rules (quotation marks, decimal separators come from `Intl`).

### Addresses and geography

Address format and order (v1), postal codes (v1), ISO 3166-2 regions (v1), cities and named places for territories, cadastral identifiers for land and buildings where they exist, preferred geocoding sources (OpenStreetMap by default).

### Privacy and data

Data-residency rules (v1 has a note), consent requirements, subject access deadlines, breach notification authority and deadline, rules for minors, cookie consent, retention periods for accounting and construction documents, cross-border transfer rules. The hub's data-residency decision is recorded in the console and drives storage and provider egress.

### Content, media and consumer law

Media registration for news outlets, defamation and right-of-reply rules, rules on reviews and testimonials, advertising labelling, copyright exceptions for quotation, takedown procedures, consumer protection for paid tickets and courses, distance-selling cooling-off rules. These map to the hub's moderation clause library and legal documents.

### Sanctions and export controls

Restricted places (engine-wide, in code), the engine baseline screening list, and national lists the hub must apply (for example a financial intelligence unit's list), each with source and update cadence.

### Communications

Sender registration for SMS, popular messengers and their business-use terms, e-mail deliverability expectations.

## Pack v2 shape (Contract)

Pack v2 (`"schemaVersion": 2`, CTRY-002) keeps every v1 field and adds `timeZones`, verification levels on the v1 facts, region kinds `state`, `district`, `territory` and `province`, a region `parent`, and `facets` on the pack and on any region. Each facet is a list of facts with a stable `id`, at least one source and a verification level (`official`, `secondary`, `candidate`, `pending`); a narrower scope overrides a wider fact by `id` with its own sources, which is also how a member pack overrides a shared layer (CTRY-EU, see [Shared layers](#shared-layers-contract-eu-layer-data-live)). Rates are decimal strings, adapters referenced by a fact must exist in the engine (`ENGINE_ADAPTERS`), unit codes come from the catalogue in `packages/contracts/src/common/units.ts`, and nothing in a pack can name or enable a restricted place. v1 files stay valid and are upgraded losslessly when loaded. The field-by-field reference is in [How to add a country](../country-packs/how-to-add-a-country.md#2a-add-facts-facets); `tests/country-packs/v2/federal-fixture.ts` is a synthetic federal example.

## Recorded v2 facts for the example countries (CTRY-003)

Since CTRY-003 the four example packs are v2 files. Every fact cites its source with the retrieval date (2026-10-31) and a verification level; anything below `official` carries a note saying what is still unconfirmed, and adapters are named only as candidates (no live register call). The pack files are the reference; this table only shows the levels.

| Facet | Uzbekistan | Georgia | Armenia | Azerbaijan |
|---|---|---|---|---|
| VAT rate | 12%, official (Tax Code art. 258) | 18%, official (Tax Code art. 166); threshold GEL 100 000 (art. 165) | 20%, secondary (2018 translation of the Tax Code, art. 63) | 18%, official (Tax Code art. 173.1); threshold AZN 200 000 (art. 155.1) |
| E-invoicing | Official (Tax Code art. 47, Resolution No. 522) | Pending (Tax Code art. 180 allows written or electronic invoices; the Minister's order is not reviewed) | Secondary (Tax Code arts. 56, 66, 68 in the 2018 translation) | Official (Tax Code art. 71-1) |
| E-signature | Official (Law ZRU-793, art. 4) | Official (Law on Electronic Documents and Electronic Trust Services, art. 3) | Secondary (EKENG description; the law is not opened) | Official (Law No. 602-IIQ, art. 3.2) |
| Payments | Secondary (Uzcard, Humo); candidate (instant payments) | Official (cards, RTGS; instant payments are a project) | Official (ArCa); candidate (ArcaPay) | Official (cards, AZIPS and XÖHKS, instant payments) |
| Registers | Candidate (statistics register) | Secondary (NAPR register) | Candidate (Ministry of Justice e-register) | Official (state register of VAT payers) |
| Procurement portal | Official (xarid.uzex.uz) | Official (tenders.procurement.gov.ge) | Official (armeps.am) | Not recorded |
| Holidays | Official fixed days (Labour Code art. 208); 2026 Eid dates secondary | Official fixed days (Labour Code art. 30); 2026 Easter dates secondary | Official (Law HO-200 as in force from 24.07.2026) | Official fixed days (Labour Code art. 105); Novruz, Ramazan and Gurban dates not recorded |

## Starting points for the example countries (secondary sources, pending confirmation)

These are research leads for pack maintainers, gathered on 2026-10-30 from secondary sources. They are **not** pack facts until a maintainer confirms them against official sources and adds them to the pack with citations; the table above shows which ones CTRY-003 confirmed.

| Topic | Uzbekistan | Georgia | Armenia | Azerbaijan |
|---|---|---|---|---|
| Standard VAT rate | 12% | 18% | 20% | 18% |
| Mandatory e-invoicing | Yes, B2B and B2G since 2020, through the State Tax Committee's e-Faktura system; input VAT credit depends on a matching e-invoice | Yes, B2B since 2012 through the Revenue Service portal (rs.ge) | Yes, through the State Revenue Committee's electronic settlement documents platform (start date differs between sources) | Yes, for VAT payers since 2017 through the Internet Tax Office (e-taxes.gov.az), signed with an enhanced electronic signature such as Asan İmza |
| E-procurement portal (candidate, not confirmed) | xarid.uzex.uz | tenders.procurement.gov.ge | armeps.am | etender.gov.az |
| Electronic signature (candidate unless noted) | E-IMZO (not confirmed by the sources consulted) | ID card and mobile ID | ID card and mobile ID | Asan İmza (named by several sources) |
| Data residency | Required for personal data of citizens (pack v1 note, pending article confirmation) | See pack | See pack | See pack |

Sources consulted: [VAT policy in Uzbekistan 2025](https://www.vatupdate.com/2025/01/09/overview-of-vat-policy-changes-and-exemptions-in-uzbekistan-by-2025/), [Uzbekistan e-invoicing](https://www.vatupdate.com/2024/06/21/how-does-e-invoicing-works-in-uzebekistan), [Georgia e-invoicing overview](https://www.e-invoice.app/country/GE), [Georgia VAT guide](https://lappa.org/guides/vat/georgia-vat-for-international-businesses/), [Armenia electronic settlement documents](https://lookuptax.com/docs/einvoicing/electronic-settlement-documents-einvoicing-armenia), [Armenia VAT guide](https://lappa.org/guides/vat/armenia-vat-registration-and-compliance-guide/), [Azerbaijan State Tax Service: electronic invoice](https://taxes.gov.az/en/page/elektron-qaime-faktura), [Azerbaijan e-invoicing](https://www.vatupdate.com/2025/05/17/e-invoicing-in-azerbaijan/).

## Planned packs

Each planned pack has a work package that lists the facets to source for its country: regions and formats, company registers and identifiers, construction licensing, building codes, public procurement, tax and e-invoicing, e-signatures, payment rails, privacy law, holidays, languages and scripts, and units. The leads named there are candidates to confirm, never pack facts. Run `node scripts/work-packages.mjs show CTRY-BR` (or any other code) to read one.

| Region | Packages |
|---|---|
| Americas | INTL-US (live), CTRY-CA, CTRY-MX, CTRY-BR |
| Europe | CTRY-GB; CTRY-EU, then CTRY-DE, CTRY-FR, CTRY-ES, CTRY-IT, CTRY-PL; CTRY-UA (government-controlled territory only) |
| Middle East | CTRY-TR, CTRY-AE |
| Asia-Pacific | CTRY-IN, CTRY-AU |
| Africa | CTRY-ZA (South Africa, with the Cape Town demo hub DEMO-ZA); other African countries are leads in the [market-opportunities note](../research/market-opportunities-2026-11.md) |
| Everywhere else | No pack planned yet: the generic profile works today, and a contributed pack is welcome |

## Adding a country

The existing guide covers pack v1: [How to add a country](../country-packs/how-to-add-a-country.md). For v2 facets, start with identifiers and registers, then tax and e-invoicing, then licensing and standards; each facet is useful on its own, and partial packs are welcome as long as every fact is sourced and its verification level is honest.

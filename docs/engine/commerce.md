# Buying and selling

Requirements R05–R08, R10. Status: procurement and sales lists and the decisions panel are **Demo**; RFQ and quote versions, digests, staleness, agreements, acceptance and comparison are **Contract** with tests and database rules specified; the full flows are **Designed** (work package COM-001).

A company buys and sells at the same time, often on the same day: it buys facade panels and sells installation work. The engine gives both sides one honest workflow in which nothing that was sent can silently change.

## The procurement journey

```text
need → clarification → RFQ published → quotes collected → negotiation → terms selected
     → order placed (authority + budget) → supplier accepted → fulfilling ⇄ partially accepted
     → accepted → reviewed;  fulfilling → disputed → resolution
```

### 1. Intake: from a vague need to a clear one

A need arrives as a typed note, a spreadsheet, a forwarded e-mail thread, a photo of a drawing or a conversation with your agent. The agent extracts lines **with evidence** (which cell, which sentence) and asks for what is missing: scope, quantity, **unit of measure**, location, schedule, acceptance requirements. Parsing a file never grants authority and never sends anything to addresses found in it.

### 2. The RFQ and its versions

- An RFQ has an owner, a status (`draft`, `published`, `closed`, `cancelled`, `expired`) and a current version.
- A **published version is immutable**; its digest (`trustwork-digest-1` over the payload) proves it.
- Lines can be goods, works, services or mixed bundles, with specifications, quantities as exact decimal strings and units from the hub catalogue.
- **Buyer-private constraints** (budget ceiling, evaluation weights, internal notes, shortlist) are a separate record that suppliers never see.
- **Invitations** pin the exact RFQ version. If the buyer amends the RFQ, prior invitations and quotes are flagged `stale_reason: rfq_amended` (a flag, not a status) and must be explicitly revalidated.

### 3. Discovery and eligibility

Suppliers come from the buyer's own list, the platform directory, [matching](partners-and-matching.md) and external sourced records. Eligibility shows criteria and uncertainty, never a magic badge. External candidates are not platform users, and being in a source does not permit bulk outreach.

### 4. Quotes

- A quote answers one RFQ version; each **sent quote version** is an immutable, recipient-specific snapshot with lines, specifications, options and substitutions, quantities, unit basis, taxes, currency, delivery or work milestones, payment terms, validity and attachments.
- Each line may cite the **catalogue offering version** it came from; later catalogue changes never touch the sent quote.
- **Seller-private constraints** (floor prices, margin targets, cost basis, negotiation notes) are a separate record the buyer never sees.
- Quote lifecycle: `draft → sent → superseded | withdrawn | expired | accepted`.

### 5. Comparison

`comparableQuoteVersions` splits quotes pinned to the current RFQ version from historical ones. Comparison shows exclusions and non-comparable scope instead of a misleading total; historical mode shows no ranking. Mixed currencies are compared only with an explicit, dated exchange-rate snapshot. Raw quotes stay available to permitted participants.

### 6. Negotiation

Negotiation rounds propose new versions; private priorities stay private. Agents may negotiate within mandates ([Your agent](agents.md#negotiation)), and every proposal is a structured version, not chat prose.

### 7. Agreements and orders

- An **agreement** pins accepted terms to exact quote and RFQ versions by id and digest. Its digest is computed once over `{ quoteVersion, rfqVersion }`.
- **Buyer acceptance and seller acceptance are separate events** (`proposed → accepted_by_buyer → accepted_by_both`, or `declined | withdrawn | superseded`). Both reference the agreement digest; a database trigger checks they match.
- An **order** is possible only after authority and budget checks: the person or their agent must hold `commit_order` within a mandate, and the **transaction budget** reservation must succeed atomically. If a paid platform deliverable was requested, a separate **platform budget** reservation is needed too.
- Changes append jointly accepted versions; history never mutates. Cancellation, refund and compensation depend on what actually happened externally.
- Party-private agreement records (`AgreementBuyerPrivate` with budget and approval references, `AgreementSellerPrivate` with the fulfilment plan) are never joined into the other side's view.

### Around the deal: the company's procurement suite

Requisitions from site staff, approval routes, the company's private supplier base, bid levelling and awards, AI intake of off-platform quotes and invoices, project budgets, receiving, site stock, the three-way match and payment proposals are designed in [Procurement and supply](procurement-and-supply.md) (Proposed, R53). They reuse the RFQ, quote, agreement and order records above and never change their invariants.

## The sales journey

```text
lead or RFQ invitation → quote draft → sent version → negotiation → buyer acceptance
     → seller acceptance → fulfilment → acceptance
```

Sales are contextual: leads, contacts, templates and campaigns live where they are used, not in an overloaded CRM navigation. A seller sees invitations, drafts, sent versions and their status, decisions waiting for them, and acceptances.

## The catalogue

Each company (or person, for individual professionals) keeps reusable, versioned **offerings**: goods, works, services and bundles with specifications, options, availability, capacity and scope. A published offering version is immutable; public fields are an explicit allowlist; private commercial knowledge is separate. In the platform catalogue a complex subsystem is presented as a kit per building, not a list of article numbers, because the price depends on the specific facade.

## Correspondence belongs to the work

Messages belong to an RFQ, a quote, a transaction, an introduction or a project. Existing e-mail is preserved through channel adapters with idempotent intake. There is no standalone generic inbox. See [Communications](communications.md).

## Country specifics that commerce uses

| Need | Source |
|---|---|
| Currency, minor units, display rounding | Country pack |
| VAT or sales tax treatment of quote lines, tax registration of the parties | Country facets: tax ([Country specifics](country-specifics.md#tax-and-invoicing)) |
| Electronic invoices and acceptance acts | Hub e-invoicing and e-document adapters |
| Units of measure and their local names | Hub taxonomy, engine unit catalogue |
| Public procurement notices as opportunities | Hub sources: procurement portal feeds |
| Electronic agreement validity | Open legal decision O12, per country |

## Invariants checked by tests

- A published RFQ version and a sent quote version cannot be updated (database trigger `reject_update_when_frozen` and contract guards).
- A quote cannot be sent against an RFQ version that is not the current published one.
- Acceptance recomputes digests from stored payloads; a tampered row fails with `commercial.digest_mismatch`, a superseded version with `commercial.stale_version`.
- Concurrent orders cannot exceed a budget.
- A provider timeout never produces a second order.
- Buyer budget and seller floors never appear in shared or counterparty projections, search, notifications or federation envelopes.

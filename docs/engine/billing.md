# Billing, plans and budgets

Normative requirements: [Billing and commissions](modules/billing-and-commissions.md), [Getting paid](modules/getting-paid.md). Participants: [who uses what](participants/README.md).

Requirements R19, R20, R46, R47. Status: billing state in settings is **Demo**; the BILL-001 service/database foundation implements entitlements, immutable price acceptance, two budget kinds, reservations and a balanced ledger ([implementation boundary](../../apps/api/src/modules/billing/README.md)). It does not establish provider payments or complete public catalogue delivery. Hub commissions have **partial implementation** ([BILL-003 boundaries](../../apps/api/src/modules/billing/fees/README.md)). The business-model playbook and [public pricing screen contract](../design/screen-contracts/public/pricing.md) are **Designed** (BIZ-001); payment adapters, invoices and complete public fee/model/capability/credit readers remain separate implementation work (PAY-001, BILL-002, BILL-003, PAY-002). [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 20, 21 and 25 govern those implementations; no operational prices or providers are selected here.

## Free to participate, fair to pay

Both commercial sides and non-commercial readers and authors get **free minimum participation**: reading, a profile, publishing under the hub's rules, responding to RFQs, basic company presence. A hub earns money from things that cost money to provide or that create clear value: agent work beyond a trial, generated deliverables, tiered subscriptions with more capacity, paid event tickets and courses (as a marketplace), and services such as verification where checks have a real cost. Actual prices, trial lengths and tiers are open (O03) and set by each hub.

**Money never buys ranking, matching position, reputation or a verified badge.**

## Hub business-model playbook

This playbook applies the existing owner decisions; it does not activate an offer. A hub first identifies the actual service, the payer, the budget kind, the published price version and the evidence that proves delivery. A second person activates the version. Missing legal, provider, price or consent authority leaves the paid operation unavailable. A synthetic catalogue is labelled test/demo evidence and never supplies an operational price.

| Revenue option | What the participant pays for | Invariant and disclosure |
|---|---|---|
| Capacity subscription | Published additional capacity, integrations or workspace features above the engine's free floor | Participation and basic RFQ responses stay free. More capacity never changes directory order, matching, recommendations, reputation or verification. Publish included quotas, billing period and cancellation/renewal terms; a paid plan grants no staff or resource authority. |
| Metered agent work | A named model/capability meter or action beyond the published allowance, charged to the platform budget | Publish the unit, fixed participant price version, included usage and any explicit overage limit before admission. Reserve against the correct budget and settle only from evidence; unknown outcomes retain their reconciliation state. No outcome-based agent fee, purchasable introduction quota or ranking advantage. |
| Generated deliverable | A specified report, export or other output with a price and delivery definition | Price the work, never access to another party's private data or a favourable conclusion. Existing source licences, projections and mandates still apply. A paid due-diligence report does not buy a badge, score or recommendation. |
| Consultations and tasks | A disclosed category commission or fee on the actual booked service or accepted task | Same published category terms for everyone; zero requires an explicit valid zero version. Bind both parties' applicable disclosures to the real immutable booking/agreement. A commission never influences candidate selection, ranking, recommendations or reputation. |
| Events and courses | A published marketplace fee or organiser capacity subscription for a ticket/course service | Show the participant's full applicable fee breakdown before acceptance. Never sell attendee contacts, profile views or better matching; certificates describe earned completion, not purchased verification. The owning booking and licensed-provider paths must exist first. |
| Verification at cost | The real cost of a documented check or manual review, independently of any plan | Same published check price for everyone; the hub may waive the cost under its policy. Payment never guarantees success, changes evidence, buys a badge or affects rankings, matching or reputation. Publish the check's scope and limits. |
| Labelled sponsorship | A separately identified editorial, newsletter, event or training placement where hub policy permits it | Off by default. Never a directory/search/matching/plan-suggestion position and never a change to editorial evidence or reputation. No private-data targeting, contact exports or implied endorsement. Existing editorial and consent rules remain mandatory. |

Amounts, tiers, trials, commission levels, waiver criteria and real legal/tax/refund text remain owner/operator decisions. A markup, if chosen, is materialized into a fixed participant price version; it is not a hidden spread or a mutable checkout calculation. Model/provider credentials and internal cost records are not part of the public participant-price projection.

The engine does not sell leads, introductions, received RFQs, higher matching positions, featured directory slots, badges, ratings, awards tied to purchases, attendee lists, profile-view data or worker data. It does not target advertisements using private data, convert a trial into recurring billing without separate explicit acceptance, or collect participants' funds into an operator/platform account. Paying for software never bypasses sanctions, mandates, privacy or human confirmation.

The reference research's optional public-data licensing and payment-orchestration ideas are not additional enabled products. They require their own accepted ownership, legal/licence and provider contracts. No engine-code dual licence, referral programme, autonomous payment release or operational price is established by this playbook.

### Before offering a paid service

1. Keep the engine's free participation floor available and identify the actual owning service and fulfilment evidence.
2. Publish the complete applicable price/fee, unit, currency, scope, dates and acceptance/refund/renewal terms in every supported language; obtain the existing second-person activation.
3. Bind disclosure and acceptance to the real operation and current authorized payer. A transaction budget never authorizes platform spending, or the reverse.
4. Use only the configured licensed-provider path for charges, refunds and payouts; otherwise leave payment unavailable or record agreed off-platform payment where the owning contract permits it. Never invent a successful charge.
5. Compare directory, matching, recommendation and reputation results with and without payment state. Catalogue visibility must not depend on the viewer's plan. Preserve immutable accepted versions when prices change.

The [public pricing contract](../design/screen-contracts/public/pricing.md) distinguishes a confirmed empty section from a missing reader or failed request. Missing prices never mean free service. Fair renewal, cancellation and credit terms remain governed by BILL-004 and the existing [billing requirements](modules/billing-and-commissions.md), including advance disclosure and no silent credit expiry.

## Two kinds of budget

| Budget | Pays for | Example |
|---|---|---|
| **Transaction** | Buying goods, works and services from other participants | Ordering 400 m² of panels |
| **Platform** | Paying the hub for platform services and deliverables | A generated catalogue, an analytical report, agent work beyond the plan |

One never implies the other. A company can give an employee a transaction budget for a project without giving them the right to spend on platform services, and vice versa. Reservations are atomic, concurrent requests cannot overspend, and a reservation is settled or released only from evidence.

## Versioned prices and acceptance

- An **offer** says what is sold; a **subscription plan version** says what a subscription plan includes (`subscription_plan_version`, named so it is never confused with a project [plan version](projects.md#plan-versions-proposed-adr-012-decision-13)); a **price version** says how much, in which currency, from when.
- A price version is drafted by one person and activated by **another**, cannot be back-dated, and never overlaps another active version of the same offer.
- Customers **accept** a price version with a specific acceptance text version; the acceptance record is immutable. Changing a price never changes what someone already accepted.

## Payers

Personal and company payers are both supported. A company can pay for its members; a person can pay for themselves. Economic rights (entitlements) are separate from roles: being an administrator does not give a plan, and having a plan does not give admin rights.

## Trustwork never holds money

Owner decision 2026-10-31 ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 20). Status: **Proposed** (PAY-001, BILL-002, PAY-002). The engine and hub operators **never hold, pool or move participants' funds themselves**. Payments, escrow, retainage and payouts go only through **licensed payment providers** configured per hub; the engine records instructions, provider references, evidence and reconciliation.

- Payment providers are adapters with fakes. Each hub chooses providers available in its country ([Country specifics](country-specifics.md#payments), for a US hub for example card and ACH through a licensed processor) and enables them in the console with second-person activation. No provider is assumed to be available in every country; no Russian payment rails and no sanctioned banks are integrated.
- PAY-001 **refuses** any configuration that would route participants' funds through an operator account ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 22).
- Holding funds until delivery, retainage and milestone payouts exist only where the configured provider supports them; otherwise the platform records obligations and evidence while money moves outside it, as the parties agreed.
- Payment outcomes that are unknown go to reconciliation and are never retried blindly; webhooks arrive through an idempotent inbox.
- In the demo, card, ACH and sales-tax flows appear only through fake providers and are labelled "demo: no money moves" (ADR 012 decision 22).

## Commissions and fees are hub settings

Owner decision 2026-10-31 (ADR 010 decision 21). Status: **Partial implementation** (BILL-003 remains in progress): scoped fee authority, public pricing and exact consultation/task bindings are implemented; [remaining acceptance boundaries](../../apps/api/src/modules/billing/fees/README.md) include BIZ-001 design acceptance, missing price readers, marketplace fee mapping and referral authority. The hub administrator sets commissions and fees, for consultations, tasks, marketplace categories, events, courses and agent capacity, as **versioned price records**:

| Rule | How it holds |
|---|---|
| Versioned | A fee version has a category scope, an amount or percentage, an effective date and no overlap with another active version; it is never back-dated |
| Second person | The person who drafted a fee version cannot activate it; activation is audited |
| Disclosed | Every active price, fee and commission is listed on the hub's public price page in every hub language, and shown to both sides **before** a booking or acceptance; the booking or acceptance records the version that was shown |
| No hidden fees | The engine supplies no hidden or per-lead fees; introduction quotas are never purchasable (ADR 012 decision 23); there are no outcome-based fees for agent work |
| Same for everyone | A commission is the same for every participant in a category; zero is allowed |
| Never an incentive | Payment, commissions and fees never change ranking, matching, recommendations or reputation; the owner's agent ranks candidates identically whether or not a booking would earn the hub a fee (tested in BILL-003) |

The commission levels of the reference hub are an open owner question ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md#questions-that-remain-for-the-owner-or-counsel), row 7). Where commissions appear in the flows: [plan to people pricing](agent-catalog.md#pricing-and-commissions); in the console: [consultation and task marketplace](hub-console/modules.md#consultation-and-task-marketplace) and [cost and sale prices of agent modules](hub-console/user-agents-admin.md#cost-price-and-sale-price).

## Hub commercial settings (Proposed)

| Setting | Notes |
|---|---|
| Hub currency and accepted secondary currencies | From the country pack |
| Tax treatment of the hub's own fees | From country facets and the operator's tax advice |
| Invoices and e-invoices for platform fees | Hub e-invoicing adapter where required |
| Marketplace fees for tickets, courses, consultations and tasks | Fee versions under the rules above; payouts to organizers, authors and experts through the payment provider |
| Free minimum and trial parameters | Versioned, published |
| Credits for goodwill or corrections | Capped per staff role; never a hidden refund |

## Invariants

- No overlapping active price versions; activation needs a second person.
- Acceptances are immutable.
- Budgets never go negative under concurrency.
- No entitlement, fee or commission changes ranking, matching, recommendations or reputation.
- No configuration routes participants' funds through an account of the operator or of Trustwork.

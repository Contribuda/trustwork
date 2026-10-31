# Billing, plans and budgets

Normative requirements: [Billing and commissions](modules/billing-and-commissions.md), [Getting paid](modules/getting-paid.md). Participants: [who uses what](participants/README.md).

Requirements R19, R20, R46, R47. Status: billing state in settings is **Demo**; budgets, price versions and acceptances are **Contract**; offers, entitlements, usage and payment adapters are **Designed** (work package BILL-001); licensed payment providers only (Trustwork never holds money), hub commissions and fees as versioned, disclosed settings and other hub-level commercial settings are **Proposed** ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 20 and 21; PAY-001, BILL-002, BILL-003, PAY-002).

## Free to participate, fair to pay

Both commercial sides and non-commercial readers and authors get **free minimum participation**: reading, a profile, publishing under the hub's rules, responding to RFQs, basic company presence. A hub earns money from things that cost money to provide or that create clear value: agent work beyond a trial, generated deliverables, tiered subscriptions with more capacity, paid event tickets and courses (as a marketplace), and services such as verification where checks have a real cost. Actual prices, trial lengths and tiers are open (O03) and set by each hub.

**Money never buys ranking, matching position, reputation or a verified badge.**

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

Owner decision 2026-10-31 (ADR 010 decision 21). Status: **Proposed** (BILL-003; the public price page is designed in BIZ-001). The hub administrator sets commissions and fees, for consultations, tasks, marketplace categories, events, courses and agent capacity, as **versioned price records**:

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

# Billing, plans and budgets

Requirements R19, R20. Status: billing state in settings is **Demo**; budgets, price versions and acceptances are **Contract**; offers, entitlements, usage and payment adapters are **Designed** (work package BILL-001); hub-level commercial settings are **Proposed**.

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

- An **offer** says what is sold; a **plan version** says what a plan includes; a **price version** says how much, in which currency, from when.
- A price version is drafted by one person and activated by **another**, cannot be back-dated, and never overlaps another active version of the same offer.
- Customers **accept** a price version with a specific acceptance text version; the acceptance record is immutable. Changing a price never changes what someone already accepted.

## Payers

Personal and company payers are both supported. A company can pay for its members; a person can pay for themselves. Economic rights (entitlements) are separate from roles: being an administrator does not give a plan, and having a plan does not give admin rights.

## Payments (Designed and proposed)

Payment providers are adapters with fakes. Each hub chooses providers available in its country ([Country specifics](country-specifics.md#payments)) and configures them in the console with second-person activation. No provider is assumed to be available in every country; no Russian payment rails are integrated; sanctioned banks are never integrated. Payment outcomes that are unknown go to reconciliation.

## Hub commercial settings (Proposed)

| Setting | Notes |
|---|---|
| Hub currency and accepted secondary currencies | From the country pack |
| Tax treatment of the hub's own fees | From country facets and the operator's tax advice |
| Invoices and e-invoices for platform fees | Hub e-invoicing adapter where required |
| Marketplace fees for tickets and courses | Price versions; payouts to organizers and authors |
| Free minimum and trial parameters | Versioned, published |
| Credits for goodwill or corrections | Capped per staff role; never a hidden refund |

## Invariants

- No overlapping active price versions; activation needs a second person.
- Acceptances are immutable.
- Budgets never go negative under concurrency.
- No entitlement changes ranking, matching or reputation.

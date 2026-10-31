# Billing policy (BILL-001)

Status: **Draft** (migrations on an unmerged branch, not applied to any shared environment). Normative requirements: [Billing and commissions](../../engine/modules/billing-and-commissions.md) (BIL-F01 to BIL-F05, BIL-F16, BIL-F17). Narrative: [Billing, plans and budgets](../../engine/billing.md). Data: [model section 23](../../data/model.md#23-billing-budgets-and-payments), slice B1 of the [migration plan](../../data/migration-plan.md). Decisions: [ADR 010](../../adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 20 and 21, [ADR 012](../../adr/012-integrator-decisions-2026-10-31.md) decisions 22 and 23.

This page states the rules the billing slice enforces and where each rule lives. Prices, trials, tiers and commission levels of the reference hub remain an open owner question (ADR 012, question 7); nothing here sets one.

## What is delivered

| Part | Where |
|---|---|
| Fifteen tables: `billing_account`, `offer`, `subscription_plan_version`, `price_version`, `price_acceptance`, `subscription`, `entitlement`, `meter`, `meter_rate_version`, `marketplace_fee_version`, `usage_record`, `budget`, `reservation`, `ledger_entry`, `credit_grant` | [`packages/data/migrations/billing`](../../../packages/data/migrations/billing) |
| Kysely model and runtime column mirror | [`packages/data/src/schema/billing.ts`](../../../packages/data/src/schema/billing.ts) |
| Repository port (runtime and owner-run calls) | [`packages/data/src/repositories/billing.ts`](../../../packages/data/src/repositories/billing.ts) |
| Entitlement checks, price acceptance, budget and reservation commands, synthetic catalogue | [`apps/api/src/modules/billing`](../../../apps/api/src/modules/billing) |
| Tests on a real PostgreSQL with the runtime role | [`tests/billing`](../../../tests/billing) |

No payment provider is registered, nothing is charged and no money moves. Payments, invoices and payouts arrive with BILL-002 and PAY-001 behind adapters with fakes.

## Rules and where they are enforced

| Rule | Enforcement |
|---|---|
| Free basic participation for both commercial sides (reading, a profile, publishing under hub rules, responding to RFQs and tasks, basic company presence, requesting consultations, the agent free floor) | `FREE_BASIC_FEATURES` in the billing module: granted to every person and company with no account, entitlement, plan or payment |
| Economic rights are separate from roles | Entitlement decisions take the feature and the party's valid entitlements only; an administrator has no plan by being one, and a plan gives no permission |
| Two budget kinds; one never implies the other | `budget.kind` is `transaction` or `platform`; the kind a reservation needs comes from the contract's `budgetKindFor(action)`, and `billing_reserve` refuses a budget of the other kind (`billing.budget_kind_mismatch`). There is no fallback between kinds |
| Transaction authority never implies platform spending | A company-wide platform budget is spent only by a member holding `company.billing.manage`; `company.deals.manage` opens only company-wide transaction budgets; an employee-scoped budget is spent only by that employee while employed there |
| No self-grant | A budget is never granted to oneself, and the scoped employee cannot raise their own limit (`billing.self_grant`) |
| Reservation before commitment | `billing_reserve` locks the budget row, checks kind, period, currency, project scope and authority, and reserves only if `limit - consumed - held` covers the amount; idempotent per effect correlation key |
| Settlement on actual, no overrun | `billing_settle` needs outcome evidence and an amount not above the reservation; more needs a new reservation under a new approval (`billing.settlement_exceeds_reservation`). The unsettled remainder stops holding the budget |
| Expiry | Holds past `expires_at` stop counting immediately, cannot be settled, and the owner-run sweep marks them `expired` |
| Refunds and corrections | Owner-run, from provider or staff evidence: a refund never exceeds the settlement; a correction reverses a ledger batch once and is refused if it would overrun the budget |
| Balanced append-only ledger | Every movement is a batch of signed legs that sums to zero per currency, checked at commit; entries are never updated or deleted |
| No float money | All amounts are `bigint` minor units in the database and strings in code, tested beyond 2^53 |
| Versioned prices | Price, plan, meter rate and fee versions are born as drafts, activated by a person other than the drafter with the database clock as the activation time, never back-dated, frozen once active (an active version may only be end-dated earlier, never into the past) and never overlapping another active version of the same scope; fee versions also need a second-person approval id |
| Immutable acceptance | `price_acceptance` binds the exact version, amount, currency and acceptance text the payer was shown, on the payer's own active account; it is append-only and later price versions never touch it |
| Cancel at any time | The payer (or a billing manager of the paying company) cancels a subscription in one step with no fee; participants cannot change a subscription in any other way |
| Credits are capped and never expire silently | `credit_grant` records the staff role and cap applied, refuses amounts above the cap and credits to oneself or one's employer, posts a ledger batch, and an expiring credit must record the disclosure shown when it was granted |
| Private to the payer | Accounts, acceptances, subscriptions, entitlements, usage, credits and ledger rows are visible to the payer and the paying company's billing viewers and managers only; budgets also to their scoped employee; forced row-level security on every billing table |
| Payment never changes ranking, matching, recommendations or reputation | No module outside billing reads a billing table (tested by a source scan), and directory listings are identical with and without paid entitlements, budgets and credits (tested) |

## Who writes what

| Path | Calls |
|---|---|
| Runtime (participant principal, row-level security) | open a billing account, accept a price version, cancel a subscription, grant, change and close budgets, reserve, settle and release (SECURITY DEFINER commands) |
| Owner-run (maintenance transaction) | catalogue administration until the staff roles of DATA-002 exist; starting subscriptions and granting entitlements from payment evidence (BILL-002); usage recording for the agent runtime (AGT-004); refunds, ledger corrections, credits and the expiry sweep |

The version, money and immutability rules are triggers and constraints, so they hold on the owner-run path too.

## Synthetic catalogue

`seedSyntheticCatalogue` creates three offers whose codes start with `synthetic_` and whose names start with "Synthetic". Their amounts are placeholders (zero or one unit of the currency), not prices. They exist so demos and tests exercise versioning, acceptance, budgets and the ledger end to end.

## Follow-ups outside this package

| Item | Owner |
|---|---|
| Foreign keys for `hub_id` (hub anchor, DATA-003), `approval_id` and `case_id` (DATA-002), `action_intent_id` (AST-001), `payment_id` (BILL-002) | Those packages |
| Staff commands for catalogue administration with roles and audit | DATA-002, HUBC billing console |
| Payment evidence starting subscriptions and granting entitlements; invoices; payouts | BILL-002, PAY-001 |
| Expiry sweep scheduled on the worker role | REL-001 follow-up |
| HTTP routes, capability registry entries (`core.get_my_billing`, `core.accept_price_version`, `core.cancel_subscription`, `core.propose_budget`, `core.grant_budget`) and registration in the composition root | Integrator, AGT packages |
| Locale strings for the meter description keys (`billing.meter.*`) and the credit expiry notice | Web billing surface (INTL-004 namespaces) |
| Billing error codes in the frozen error list (today mapped to existing codes with `details.reason`) | Contracts owner |
| Data model: the ledger counter-account `commitment` (what a payer owes another participant outside the platform) and the reservation `expires_at`, `refunded_minor` and `evidence_ref` columns | Data model owner |

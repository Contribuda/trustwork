# Agent metering, quotas, plans and usage statistics (AGT-004)

Agent: Claude Code (Opus 5.5) for Parshkov

Status: in progress. No operational price is seeded or activated: every amount in the tests is synthetic, and a plan price, a model price and a credit-pack price are operator settings. Nothing here contacts a payment provider, and no money moves.

## Agent usage prices

ADR 010 decision 25. A hub prices agent usage per module unit, per capability, per catalogue model (one price per direction) or as a hub-wide rate of one meter.

A sale price is an ordinary `price_version` of its own offer (kind `agent_metered`). Second-person activation, no back-dating, no overlapping active versions and immutable `price_acceptance` are therefore the BILL-001 rules and the BILL-001 guard, not a parallel set. `metered_price_term` adds what a price version cannot hold: the subject, the exact unit price and the cost beside it. Money stays integer: `sale_micro` and `cost_micro` are millionths of a minor unit, and the API carries the same value as an exact decimal string. `price_version.amount_minor` is the same price as a whole number of minor units for `per_units` units, so 0.3 minor units per thousand tokens is stored as 3 for 10 units and no rounding happens.

| Route (staff, elevated, server-configured hub) | Permission | What it does |
|---|---|---|
| `POST /v1/admin/billing/metered/costs` | `admin.commerce.price.draft` | Records a versioned cost for a module, capability or meter. Catalogue model costs stay in KEYS-001 `model_pricing`. |
| `POST /v1/admin/billing/metered/prices` | `admin.commerce.price.draft` | Drafts a version, flat or markup. A cost record for the subject and currency is required: every paid unit shows two numbers. |
| `POST /v1/admin/billing/metered/prices/:id/activate` | `admin.commerce.price.activate` | Consumes one `commerce.activate_price_version` approval bound to the digest of the stored terms. The activator differs from the drafter and the approver from the requester. An earlier open-ended version is end-dated at the new start; a closed interval that overlaps is refused. |
| `POST /v1/admin/billing/metered/prices/:id/cancel` | `admin.commerce.price.draft` | Cancels a draft. |
| `GET /v1/admin/billing/metered/prices` | any of the commerce price permissions or `admin.commerce.usage.read` | Every version with cost, sale, margin and, when a newer cost record exists, the current margin and the suggested markup price. |

### Cost is information, never a price

A markup is computed in `billing_metered_draft`, once, from the current cost record, and stored as a fixed number with the identifier of that record. The caller cannot supply the result. No trigger, job or reader writes a stored price: a new cost record only changes what the staff list reports (`currentCost`, `currentMarginPerUnitMinor`, `suggestedSalePerUnitMinor`). Taking that suggestion is an ordinary new draft with the normal second person and effective date. A negative margin is allowed and shown.

Costs and markups round up to a millionth of a minor unit, so a cost is never understated and a markup never falls below it. Meters without a priced unit (`METER_TO_METERING_UNIT`: `document_pages`, `translation_characters`) are reported, not priced: the refusal is `billing.meter_unpriced`.

### Public disclosure

`GET /v1/pricing` lists every active and upcoming version through `billing_metered_public`, an explicit allowlist: subject, unit, sale price, interval and acceptance text. The runtime role has no table access to `metered_price_term`, `metered_cost_record` or `metered_subject`, so cost cannot leave through a query. Models and capabilities have their own sections; module and meter rates appear with the services section. A failed reader is an `error` section, never an empty one.

## The metered step

A step is admitted before it runs and closed once by its outcome. `metered_step` is that durable admission; `usage_record` is the append-only result.

```text
check module entitlement and hub enablement   (AGT-003 authority, plan through the entitlement port)
  -> lock the quota windows of this principal, module and meter
  -> split the estimate across the included quota
  -> beyond it: reserve the estimate from the platform budget the mandate names
  -> run the step
  -> close from the outcome: append usage, settle on actuals or release, consume credits
```

| Outcome | What happens |
|---|---|
| Within the included quota | Units held on the window, counted when the step closes. Nothing is reserved. |
| Beyond it, price accepted, budget named | The estimate is reserved and held. On success the actual is settled; the rest returns. |
| Beyond it, otherwise | The job stops and asks: `no_price`, `price_not_accepted`, `no_budget` or `budget_insufficient`. Nothing is reserved. |
| Failed or revoked | Holds released, nothing recorded or charged. |
| Unknown | Every hold stays, past any expiry. Only a final outcome closes the step. |

A meter the hub neither limits nor prices is recorded and free. Priced without a quota, every unit is beyond it. Quota windows are calendar windows in UTC; the free quota is a floor under a plan, never added to it, and a smaller plan quota cannot lower it.

**Replay.** Admission and closing are idempotent per run step, attempt and meter. A partial unique index allows one success per step and meter, so a later attempt id gets `already_charged`, and an attempt whose outcome is open blocks the next one with `billing.attempt_open`: an unknown outcome is reconciled, not retried.

**Overrun.** Usage above the estimate is recorded honestly and `overrun_units` shows it, but the charge never exceeds the reservation. An overrun is the hub's cost, not the participant's surprise.

### Runtime bindings

The owning transactions meter themselves, so a crash cannot separate a charge from its outcome.

- `model_tokens`: a `BEFORE INSERT` trigger on `model_call` admits inside `models_begin`, so a stop rolls back the mandate use and nothing is dispatched. `AFTER UPDATE` closes the step in the same transaction as `models_finish`, which also covers the reconciliation path. A priced call may not also carry `estimatedCost`: the participant's charge is the sale price (`billing.priced_twice`).
- `agent_actions`: admitted when an intent is queued, closed when it reaches a final state. Failed and revoked actions are free, and `outcome_unknown` is charged only if reconciliation ends in `succeeded`. `proposeAction` asks first (`quota_reached`), so the person gets a decision rather than an error; the queue rechecks under the window lock.
- Other meters: an owning module calls `meteredSteps.admit` and `finish` for a step of its own active run. No such module calls them yet.

A worker task parks steps that lost their lease as `outcome_unknown` and keeps their holds. Direct steps can be closed by staff with `admin.assistant.reconcile`, from evidence; steps bound to a model call or an action close only through that outcome.

## Price acceptance

`POST /v1/billing/prices/:id/accept` is a first-party session route: an agent, a connection or chat text never accepts a price. A charge uses the newest version this account accepted, so a new version applies only from the payer's own next acceptance, and a superseded version keeps pricing the account that accepted it. A published version the payer has not accepted is a question (`price_not_accepted`), never a charge.

## Plans and entitlements

`POST /v1/admin/billing/metered/plans` drafts a plan version and its price version together; one `commerce.activate_price_version` approval covers both (`admin.commerce.plan.activate`). The strict terms have no field for a protection limit, a rank, a match or a reputation input.

`AgentPlanEntitlements` implements the AGT-003 entitlement port. The plan key is the offer code of the principal's active subscription, or `free`. A module is refused only when the hub sells it, it has no free quota and the plan does not include it: a plan can add a module, never take the free floor away, and `NON_PURCHASABLE_CAPABILITIES` are checked first. A subscription still starts owner-run from payment evidence (BILL-002).

## Prepaid credits

ADR 012 decision 33. `credit_pack_term` carries validity, reminder and refund policy version; a validity without a reminder is refused. The public page shows them before purchase.

A lot is funded only owner-run, from payment evidence of an accepted pack, and idempotently on that evidence: no runtime role can create credit. A settled charge consumes lots earliest validity first. A lot stays usable past its validity until it has been announced for the whole reminder period, so credits never expire silently.

## Boundaries

- Database rechecks in AGT-003 still pass the literal plan `free` (`agent_modules_policy_refusal` callers). A capability switched off for `free` is therefore refused at dispatch even for a paying principal: conservative, but paid capability widening works only at the first check until those callers resolve the plan.
- `assistant_model_check` still requires a named platform budget for every model call, so free in-quota model use without a budget stops at that older LLM-001 rule, before metering.
- Windows are calendar UTC. The catalogue also mentions rolling windows; the frozen `QuotaWindowSchema` has no field for them.
- Refunds of a metered charge, and restoring consumed credits, wait for BILL-002 and BILL-004. `agent_credit_use` already has the `restore` kind.

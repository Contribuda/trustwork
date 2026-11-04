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

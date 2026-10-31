# Billing module (BILL-001)

Entitlement checks with a free basic floor for every person and company, immutable price acceptance, the two budget kinds (`transaction` and `platform`) with atomic reservations, settlement on actual and a balanced ledger, plus a labelled synthetic catalogue. Policy and enforcement map: [billing policy](../../../../../docs/product/billing-policy/README.md). Contracts: [`billing.ts`](../../../../../packages/contracts/src/billing.ts), AGT-002 plan, meter rate and usage schemas in [`agent-catalog.ts`](../../../../../packages/contracts/src/agent-catalog.ts), fee versions in [`hub.ts`](../../../../../packages/contracts/src/hub.ts). Storage: [`packages/data/migrations/billing`](../../../../../packages/data/migrations/billing), [`packages/data/src/repositories/billing.ts`](../../../../../packages/data/src/repositories/billing.ts).

| File | Contents |
|---|---|
| `billing.service.ts` | `BillingService`: every call under the caller's principal; database refusals mapped to frozen contract codes with `details.reason` |
| `policy.ts` | `FREE_BASIC_FEATURES`, `decideEntitlement` (feature and entitlements only: no role, ranking or reputation input), spending actions |
| `synthetic-catalogue.ts` | Owner-run seeding of three `synthetic_` offers with placeholder amounts, drafted and activated by two different people |
| `billing.module.ts` | Nest module; not yet registered in the composition root (shared registration file, integrator bookkeeping) |
| `deps.ts` | Relative re-exports of the slice's contracts and repository |

No route is exposed yet and nothing contacts a payment provider: no money moves.

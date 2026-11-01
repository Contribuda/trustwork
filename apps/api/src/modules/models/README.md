# Model gateway integration boundary (LLM-001)

Status: **blocked, partial implementation; not registered in the API or worker**. No production provider, credentials, network adapter, migration or durable model-call store is included. All model responses in tests are synthetic. This module does not replace the assistant's existing `ModelPort`.

## Implemented core

- Strict internal call and metadata contracts bind an operation, principal, mandate revision, run, route version and exact model revision. Prompt text is passed only to the selected adapter; the metadata sink and aggregate projection have no prompt/response fields.
- `KeysRouteResolver` uses the real KEYS-001 `providerCalls.authorize` dry-run port. Each candidate is checked against the current route, egress rules, residency and KEYS kill controls immediately before its call. A changed route or missing candidate fails closed. Dry runs do **not** reserve a budget.
- `ModelAuthorityPort` is mandatory. It must resolve trusted principal/mandate/run authority, source permissions, residency, retention and every node/provider/model/job/module/capability/extension switch. There is no permissive default. AGT-003 integration is still required; the synthetic authority is confined to tests.
- Only registered fake adapters can run. A fallback gets its own policy check, hold-transfer boundary and second current-policy check. Only a definite `not_sent` receipt can select a fallback. Timeout, exception, malformed result, over-estimate receipt or ambiguous storage acknowledgement returns `outcome_unknown`; no blind retry follows.
- Reconciliation looks up the same operation on the same pinned adapter and never resubmits its body. It is bounded by the pinned timeout. The production store must enforce ownership, durable holds and single settlement; the interface alone does not prove those properties.
- `aggregateModelUsage` groups strict metadata by exact route/model revision, stage, participant type, plan and module. It suppresses fewer than ten **distinct principals**, rejects duplicate operation rows and emits no individual identifiers. It is an internal pure projection, not a persisted dashboard or public query API.

## Blocking dependencies

### BILL-001: unknown-outcome holds

The owning implementation is `packages/data/migrations/billing/20261031150000_billing_core.sql`, with the public repository in `packages/data/src/repositories/billing.ts`:

- `billing_reserve` accepts a finite TTL between one second and thirty days.
- `billing_budget_committed` and `budgets.balance` exclude elapsed reservations even before a sweep changes their state.
- `billing_expire_reservations` expires elapsed reservations; the reservation immutability trigger forbids changing their expiry.
- `20261102105000_billing_outcome_settlement.sql` provides outcome settlement, but does not add a nonexpiring uncertain-outcome hold.

The real PostgreSQL dependency test reserves seven units from ten, leaves the outcome unresolved, waits for the one-second TTL, and reserves another seven. It verifies that the original row is still `reserved` but no longer counted, then becomes `expired` after the owning sweep. This is evidence of an integration gap, not a claim that the existing finite-TTL billing contract is defective.

Required owner change: a supported durable hold/reconciliation API that keeps an unresolved model effect counted until authoritative settlement or no-effect evidence. It must preserve existing budget locking, principal authority and ledger rules. Charging an estimate permanently, auto-renewing leases, or directly rewriting another domain's billing tables would invent policy or leave a crash window; none is implemented.

KEYS-001 operator caps must also be reserved with the platform hold and durable dispatch intent. Calling `providers_settle_call` with `unknown` closes its decision at the estimate; the gateway must instead retain the open decision until reconciliation. The store port specifies this boundary but does not implement it.

The conductor's one models-only migration permission does not authorize changing the billing domain's reservation semantics. No migration was created merely to persist incomplete metadata around an unsafe hold.

### AST-001: trusted execution context and commit boundary

`apps/api/src/modules/assistant/ports.ts` supplies `personId`, history, text and evidence to `ModelPort.respond`. It does not supply a trusted hub, run, mandate revision or platform budget binding. `AssistantService.converse` starts its run and invokes that port inside the same uncommitted principal transaction.

Required owner integration: resolve trusted model execution authority and commit the run/dispatch intent and budget reservation before adapter execution, then record the outcome in a separate transaction. Supplying fabricated context or wrapping the current call with an independent store would not prove authority or crash safety. This exceeds a minimal route registry change, so the existing assistant runtime is untouched.

### AGT-003 and MODEL-001: mandatory authority and rollout ports

AGT-003 must supply authoritative model/capability switches and capability/mandate scope. Missing or unknown switches refuse before any adapter call. No AGT-003 files are changed.

The default KEYS resolver supports only its current route. MODEL-001 can implement the route-resolution interface for activated pinned canaries/rollback; the default resolver explicitly refuses those stages. Synthetic canary-denial tests prove the core rechecks a candidate, not that a live rollout exists. Embeddings and rerank refuse mixed candidates/canaries.

## Acceptance evidence and limits

| Criterion | Evidence | Remaining boundary |
|---|---|---|
| Private data denied for a disallowed connection | Real KEYS/PostgreSQL negative test; adapter invocation count stays zero | Production authority/store integration |
| Concurrent calls stay within a mandate cap | Only test-double same-operation deduplication | **Not met:** no durable store, cross-process cap or crash test |
| Logs contain no bodies | Strict metadata tests; fake output/error canaries absent from metadata | No application logging or persisted ledger integration |
| Fallback/canary must pass current egress | Real fallback revocation test; core canary refusal test | Activated MODEL-001 canary integration absent |
| Exact pin and no person rows in usage aggregates | Real route-change refusal, exact fake invocation pin, distinct-principal threshold tests | No durable model-call ledger or dashboard |

No criterion is claimed as end-to-end application acceptance. The module is intentionally unregistered until all mandatory ports have real implementations and their negative authorization, cross-process budget and crash/reconciliation evidence passes.

## Focused verification

```sh
TRUSTWORK_TEST_PG_BACKEND=embedded TRUSTWORK_REQUIRE_PG=1 node --import tsx --test --test-concurrency=1 tests/contracts/models.test.ts tests/models/*.test.ts
npx tsc --noEmit -p tsconfig.json
npx eslint apps/api/src/modules/models packages/contracts/src/models.ts tests/contracts/models.test.ts tests/models
npm run validate:docs
node scripts/work-packages.mjs validate
```

The database tests use isolated embedded PostgreSQL and existing synthetic fixture builders. The model registry has no network implementation. `MemoryStore` is explicitly a test double and is never exported as application persistence. No visible UI strings were added, so locale changes and browser screenshots are not applicable. The PR records command exit codes, test counts, the first failed assertion and its isolated correction, and the exact tested head; the full local check remains unrun under the conductor's load limit.

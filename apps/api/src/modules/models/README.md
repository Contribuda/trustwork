# Model gateway (LLM-001)

Status: **partial; mandatory governance integration remains blocked**. Fake-only software implementation with real PostgreSQL persistence and BILL-001, AST-001 and KEYS-001 owning commands. Production adapters remain unconfigured. No live model, deployment or completed AGT-003 integration is claimed.

## Runtime and authority

`createRuntimeAssistantModel` composes the existing AST `model` option with `KeysRouteResolver`, `RuntimeModelAuthority`, `PostgresModelCallStore` and registered fake adapters. Its required `ModelExecutionPolicyPort` selects a structured mandate/context, job, capability, data classes, permitted connections, residency/retention intersection, token limits and cost estimate from trusted runtime state. Conversation text is not an authority input. The default policy refuses; the application retains its built-in unavailable model until this policy is implemented by the owning services.

The remaining integration boundary is precise: current main lacks AGT-003's authoritative capability/module eligibility and model/capability switch resolution. The execution-policy port must also supply current source permissions and intersected provider hosting/retention facts. Unknown or missing answers refuse before any adapter invocation. Test governance supplies synthetic answers only for that boundary; it is not application wiring.

The supported database authority path validates the current authenticated session and authorization epoch, owner of the active run, live exact mandate revision, module/action, own-agent grantee, pre-authorized unconditional policy, exact confirmed own-profile or currently accessible project context, participant/dispatch stops and spendable platform budget. Conditional mandates, selectors, company representation and human approval are refused here until their owning resolver supports them. One call per run applies the mandate's per-action ceiling to the run; cumulative and window ceilings use the existing locked mandate-use ledger. Nothing increases a cap or borrows another principal's budget.

`KeysRouteResolver` resolves the most-specific current KEYS route and checks each exact candidate again immediately before invocation. Every fallback separately checks all mandatory authority scopes, residency, retention and current egress. Changed route/version/limits, denied private egress or missing exact provider revision refuses. The default resolver supports current routes; activated canary/rollback belongs to MODEL-001 and is not required for this default. Embedding/rerank routes cannot mix candidates or canaries.

## Durable effect boundary

Three forward-only, unpublished migrations use the conductor-authorized range:

- BILL-001: `billing/20261105100000_billing_effect_holds.sql` adds the internal `billing_hold_for_effect` API. Pending effects remain counted by both budget balance and admission after TTL; the expiry sweep skips them. Public settlement/release cannot discard an unresolved hold. Only owning authoritative outcome closure settles/releases it. Ordinary finite reservations retain their expiry behavior.
- AST-001: `assistant/20261105100100_assistant_model_boundary.sql` adds authenticated model authority, locked mandate-use accounting, receipt authority and a principal-only conversation intent/result ledger. These helpers own all mandate accounting.
- LLM-001: `models/20261105100200_model_calls.sql` atomically records immutable request digest, exact pins and authority binding with the BILL platform hold, AST mandate use and KEYS operator decision. Prompt/response bodies are absent. Per-attempt no-effect/final receipts are immutable; raw rows are accessible only to their principal.

KEYS assigns fake connections **zero operator cost**. The model transaction uses that existing contract unchanged while reserving the supplied platform estimate; the test amounts are synthetic, not product prices. The KEYS decision stays open on unknown outcome: `providers_settle_call(..., 'unknown', ...)` is never used. Live/manual modes are refused, so nonzero paid operator fallback transfer is not enabled or claimed.

A stable operation ID and command digest deduplicate across processes. A one-use dispatch token is committed before invoking the adapter. Duplicate callers never dispatch; a lost/ambiguous admission acknowledgement never authorizes sending. Only an authoritative `not_sent` result allows another pinned candidate; fallback preserves the prior attempt receipt. Timeout, exception, malformed/over-estimate receipt and ambiguous settlement become `outcome_unknown` with the original hold retained, never an automatic retry or final estimated charge.

Reconciliation only looks up the same operation and pinned adapter, with current egress/governance checks. Mere absence is unknown; a no-effect receipt must also fence any delayed invocation. Revocation forbids new actions but does not prevent the authenticated owner from reconciling an existing receipt. Final metadata replay does not call an adapter. Closure strictly rejects cost above the original estimate, body-bearing metadata and conflicting terminal receipts; BILL and AST accounting and the KEYS receipt close atomically.

AST commits the run/incoming turn before invoking an effect-bearing model, then finalizes reply, tool proposals, run state and HTTP idempotency completion in a separate transaction. Its durable request key comes from the HTTP idempotency record, not the ephemeral request ID. A pending conversation serializes subsequent turns; retries use receipt recovery only. A crash after model settlement can finalize from stored metadata without resending; response bodies are deliberately not recovered from model metadata. The built-in unavailable model retains the existing single-transaction path because it has no effect or adapter.

## Privacy and acceptance evidence

The metadata sink is strict and body-free. `aggregateModelUsage` groups by exact route/model revision, stage and participant-type/plan/module cohort, suppresses fewer than **ten distinct principals**, rejects duplicate operations and emits no per-person identifiers. It remains an internal projection; no public dashboard or arbitrary cohort-query API is introduced.

| Criterion | Software evidence | Remaining boundary |
|---|---|---|
| Private call to a disallowed connection is refused | Real KEYS/PostgreSQL negative test, zero denied-adapter invocations | Real mandatory governance integration |
| Concurrent calls cannot exceed mandate cap | Independent OS processes, real locked mandate and shared platform budget; unknown holds survive TTL/sweep | No live provider acceptance claimed |
| Logs contain no bodies | Strict metadata contracts, prompt/error canaries, body-free durable model rows and receipts | Conversation content stays in AST's principal-only conversation ledger |
| Fallback/canary needs current egress | Real fallback revocation, durable fallback receipts and pin test, synthetic canary denial | MODEL-001 activated rollout remains external |
| Exact pins and no person rows in aggregates | Real pinned-route drift refusal, fake exact revision invocation, distinct-principal threshold | No public aggregate endpoint |

Additional focused evidence covers wrong owner/session/run/context, mandate revision and revocation, missing governance, terminal immutability, cross-process same-operation replay, process death before commit/after admission/after fake effect, authoritative receipt recovery, AST conversation serialization and failed final transaction recovery. Synthetic governance is explicitly identified in fixtures. These are software boundaries, not completed application acceptance. Package status stays `blocked` until the mandatory owning-policy integration is complete and independently reviewed.

## Scope and verification

The conductor authorized narrow BILL-001 and AST-001 expansion in issue #123 before edits. No applied migration, root configuration, lockfile or dependency was changed. The small `common/idempotency/completion.ts` accessor is required to preserve a stable operation across HTTP lease takeovers; it exposes no token or body. Per-module schema/access inventories are additive. No AGT-003, HUB-005 or SANC-006 files are edited.

The PR records exact-head focused test commands, exit codes, counts and limitations. Tests use embedded PostgreSQL and local fake adapters; cross-process child workers disable fetch and contain no network provider. The full local check/browser suite is intentionally not run under the conductor's load rule. No visible UI copy or UI behavior is added, so seven-locale edits, bounded UI build and non-English screenshots are not applicable; no live UI criterion is claimed.

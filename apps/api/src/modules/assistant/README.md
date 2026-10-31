# Assistant module: durable mandates and the agent action workflow (AST-001)

The person's one agent ([Your agent](../../../../../docs/engine/agents.md), [the agent and its runtime](../../../../../docs/engine/modules/agent.md), [data model section 21](../../../../../docs/data/model.md#21-assistant-and-agents), [lifecycles](../../../../../docs/data/lifecycles.md)). Contracts: [`assistant.ts`](../../../../../packages/contracts/src/assistant.ts) (frozen v1 states, outcomes, reconciliation) and [`agent-catalog.ts`](../../../../../packages/contracts/src/agent-catalog.ts) (MandateV2, proposals, `evaluateMandateV2`, `mandateChangeAllowed`, capabilities, stop controls). Storage: [`packages/data/migrations/assistant`](../../../../../packages/data/migrations/assistant), [`packages/data/src/repositories/assistant.ts`](../../../../../packages/data/src/repositories/assistant.ts). Worker side: [`apps/worker/src/assistant`](../../../../worker/src/assistant/README.md).

Status: Live in the API and the worker with fake providers only. No model, retrieval, order, payment or channel provider is connected; the default model answers with the locale key `assistant.overlay.stateUnavailable` and sends nothing anywhere.

## Rules the module enforces

| Rule | Where |
|---|---|
| Only the principal confirms a mandate, on the first-party form, with a recent authentication | `POST /v1/assistant/mandates`, `/mandates/:id/confirm`, `/mandate-proposals/:id/confirm` are `@Authenticated('step_up')`; the server builds the whole MandateV2 (id, principal, revision, status, `confirmation`); `mandateChangeAllowed` must answer `ok`; `assistant_confirm_mandate` repeats it in SQL (principal = confirming person = current person, `via = first_party_form`, company basis = active employer, every named budget spendable by the person, next revision) |
| Chat text, the model, agents and connections only propose | The conversation stores turns as content; model tool calls become `mandate_proposal` rows (status `draft`, no confirmation) or actions decided by the policy; there is no tool to confirm, approve, stop or change settings; a proposal becomes `confirmed` only inside the confirmation command (trigger refuses it otherwise) |
| A mandate never exceeds the person's current rights | Company mandates need the active employment at confirmation and at every check; the identity hook (`MandateRevocationPort`) narrows company mandates when the membership is really gone and personal mandates whose project context the person no longer owns or participates in; every dispatch rechecks status, revision, expiry, the company basis, kill switches and the stop |
| `confirm_execution` and `approve` are never pre-authorized | `evaluateMandateV2` asks (`human_only`); `assistant_record_intent` refuses to authorize them without an approval |
| Approvals bind the exact action digest and mandate revision | `actionDigest` covers mandate id and revision, capability, verb, concrete context, amount and the structured effect; money and human-only actions need step-up to approve; a new revision voids pending actions of earlier revisions |
| Money actions hold a budget | `assistant_queue_intent` reserves through BILL-001's `billing_reserve` with the intent's correlation key; outcomes settle (final success) or release (failure, revocation, cancellation) it; `outcome_unknown` keeps it |
| Private constraints never leave | An effect payload with a private field name (floor, ceiling, budget, private, constraint, notes, limits, conditions, approvers, reservation) is refused (`private_field`); worker entry points return only the structured effect; errors carry reason codes, never values |
| Stop control | `POST /v1/assistant/stop` suspends every active mandate and revokes every not yet started action in one transaction, never needs step-up; releasing it reactivates nothing |

## One mandate port for every module

`AssistantMandateStore` (`mandate-store.ts`) answers the structural ports of the existing modules (`TaskMandatePort`, `DealMandatePort`, `CommerceMandatePort`, `PlanMandatePort`, `ProfileMandatePort`, `FileMandatePort`, `ExecutionMandatePort`); `app.module.ts` wires it with the module keys of each slice (`MODULE_KEYS`). A check runs as the person (their principal transaction), evaluates `evaluateMandateV2` on structured facts (no free text reaches it), and:

- `allow`: records a mandate use under the mandate row lock (cumulative ceiling, per-action ceiling and window rechecked there) and lets the module proceed;
- `ask`: records a decision waiting for the person (`GET /v1/assistant/decisions`), bound to the digest; after the person approves it, the identical retry is allowed once;
- anything else (unknown, foreign, malformed, revoked, suspended, expired mandate, kill switch, stop) is refused, and the module answers `403 access.mandate_scope` as before.

Limits of this release: module checks carry no condition facts and no context facts (categories, region), so a mandate with conditions asks and a standing selector with categories or regions does not match; only `own_agent` mandates are accepted (colleague agents and the company representative arrive with AGT-001); company approver rules are recorded but the principal is the only approver.

## Routes

All mutations: authenticated session, CSRF metadata, `Idempotency-Key`, completed inside the request transaction (`in_transaction`, crash-tested in `tests/backend/idempotency/crash.test.ts`). Bodies are strict: an `actor` field is refused.

| Route | Result |
|---|---|
| `GET /v1/assistant/mandates`, `GET /v1/assistant/mandates/:id` | The person's mandates (owner view: the MandateV2 snapshot, digest, revision history); others get `404` |
| `POST /v1/assistant/mandates` (step-up) | Creates and confirms a mandate from a draft (`MandateDraftSchema`) |
| `POST /v1/assistant/mandates/:id/confirm` (step-up) | Next revision (edit, or reactivation after suspension or the stop) with `expectedRevision` |
| `POST /v1/assistant/mandates/:id/suspend`, `/revoke` | Narrowing; not yet started actions are revoked and their reservations released |
| `GET /v1/assistant/mandate-proposals`, `POST /v1/assistant/mandate-proposals/:id/confirm` (step-up, digest), `/decline` | Proposals from the agent, chat, goals or templates; confirming repeats the digest the person was shown |
| `GET /v1/assistant/decisions`, `POST /v1/assistant/decisions/:id/approve` (digest), `/decline` | "Your decision is needed" (`decision.kicker`); approving a run action authorizes and queues it in the same transaction |
| `GET /v1/assistant/runs`, `GET /v1/assistant/runs/:id`, `POST /v1/assistant/runs/:id/cancel` | Runs with their steps (decisions, model and tool calls by digest and reference, never reasoning), actions and outcomes |
| `GET /v1/assistant/stop`, `POST /v1/assistant/stop`, `POST /v1/assistant/stop/release` | The stop control |
| `GET /v1/assistant/conversation`, `POST /v1/assistant/conversation` | One conversation shared by the page and the overlay; a turn may produce proposals and policy-decided actions |
| `GET /v1/assistant/backlog`, `POST /v1/assistant/backlog/:id/status` | Proposed work for the person (separate from any software backlog) |

## Ports

`ports.ts`: `ModelPort` (`UnavailableModel` default, `ScriptedModel` fake) and the contracts' `RetrievalPort` (`UnavailableRetrieval` default until RAG-301, `FakeRetrieval` returns only evidence whose audience is public or the person; RAG-401 verifies the integration). Live model providers arrive with LLM-001 behind the egress policy.

## Tests

`tests/assistant/policy.test.ts` (pure), `tests/assistant/mandates.test.ts` (first-party confirmation, database write paths, module wiring, prompt text, human-only verbs, concurrency on ceilings and windows, basis loss, stop control), `tests/assistant/runtime.test.ts` (dispatch, crash after effect, lease loss, acknowledged and accepted-then-rejected, unknown outcomes, cancellation, expiry, revocation, concurrent dispatchers and approvers, private fields).

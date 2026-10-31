# Assistant goals and representation module (AGT-001)

Goals of the person's one agent, job subscriptions, report drafts, agent-to-agent envelopes, negotiation sessions, the company's one standing representative and company mandates ([Your agent](../../../../../docs/engine/agents.md), [data model section 21](../../../../../docs/data/model.md#21-assistant-and-agents), ADR 010 decisions 4, 9 and 23, ADR 012 decision 32). Contracts: [`agents.ts`](../../../../../packages/contracts/src/agents.ts) (commands, the negotiation state machine, the note guard, `AGENT_CAPABILITIES`) next to the catalogue shapes in [`agent-catalog.ts`](../../../../../packages/contracts/src/agent-catalog.ts). Storage: [`packages/data/migrations/agents`](../../../../../packages/data/migrations/agents), [`packages/data/src/repositories/agents.ts`](../../../../../packages/data/src/repositories/agents.ts). It reuses the AST-001 mandate store ([assistant module](../assistant/README.md)): first-party confirmation, narrowing, the authority-basis revocation, decisions bound to digests and the kill-switch check.

Status: Live in the API with fake providers only. No model is connected, nothing leaves the node, and the company page interface for the representative is not built yet (it follows on the assistant surface packages).

## Rules the module enforces

| Rule | Where |
|---|---|
| A goal never widens authority | `POST /v1/assistant/goals` binds the active own-agent mandates that already cover a need (by revision) and turns every other need into an inert mandate proposal (origin `goal`); goal needs never include money or human-only verbs (`GoalNeedSchema`). The goal is born `proposed` (trigger) |
| One structured confirmation | `POST /v1/assistant/goals/:id/confirm` (step-up) repeats the digest of the goal, its covering mandates and every proposal; all proposals are confirmed on the first-party form and the goal activated in one transaction (`agents_confirm_goal` repeats every check, including covering mandates unchanged). Concurrent confirmations confirm once |
| Only structured intents move state | `agents_deliver_envelope` decides from the intent and the digest-pinned references; the note is stored as untrusted text and never read. Session rounds, turn, expiry and agreement follow `negotiationStep`; the receiver's own mandate decision is a receiver-private receipt |
| Who speaks is derived, never claimed | The acting mandate decides: the person's own agent (for the person, or for the active employer with `company.deals.manage`), a colleague's agent under a company mandate, or the representative run inside its accountable person's transaction. A `from` field is refused (strict bodies) |
| Private constraints and competitors' prices never travel | References name exact published versions; a quote is referenced only between its buyer and seller. A note repeating the sender's private ceiling, floors, margin targets, cost bases or goal budget range, or a competing seller's price, is refused (`agents_note_leaks`). Sender mandate references, receiver decisions and escalations live in party-private tables |
| Sessions end | Round limit (`maxNegotiationRounds`, default 6), alternating turns, expiry (default 14 days); the round past the limit is not delivered and both sides get an escalation; `accept` only reaches "agreed, pending confirmation": agreements are formed by people through COM-002 |
| At most one representative, always accountable | `company_representative.company_id` is unique; only a company administrator configures, suspends (instantly), resumes or disables it; the accountable person holds `company.deals.manage` and accepts the role; without an accountable person or an effective company mandate it suspends automatically |
| Company mandates | Granted on the first-party form (step-up) by a member holding `company.deals.manage` for their active employer, to a colleague's agent or the representative; the executor cannot revise them; a re-confirmation repeats the identical terms digest |
| Membership loss stops dependent authority in the same transaction | Trigger `agents_membership_authority` on `membership`: the person's company mandates (AST-001 `assistant_revoke_for_basis`), the colleague mandates they execute (revoked), the company mandates they granted (stopped, awaiting re-confirmation for 7 days, then suspended) and their accountable role (the representative suspends) |
| Kill switches | Every dispatch checks the hub and node switches and the person's stop control (`assistant_dispatch_blocked`); the representative view reports `blockedBy` |

## Routes

All mutations: authenticated session, CSRF metadata, `Idempotency-Key`, completed inside the request transaction (`in_transaction`, crash-tested in `tests/backend/idempotency/cases/agents.ts`). Capabilities: `AGENT_CAPABILITIES` lists every route once for the interface, the agent and connections (governance never for connections).

| Route | Result |
|---|---|
| `GET /v1/assistant/goals`, `GET /v1/assistant/goals/:id`, `GET /v1/assistant/goals/:id/confirmation` | The person's goals with progress; the one confirmation to show |
| `POST /v1/assistant/goals`, `POST /v1/assistant/goals/:id/confirm` (step-up), `/status`, `/progress`, `/report` | Create (proposals only), confirm, pause, resume or close, record evidence, prepare a report draft |
| `GET /v1/assistant/reports`, `POST /v1/assistant/reports/:id/share` | Report drafts; sharing only with colleagues of the active employer |
| `GET /v1/assistant/job-subscriptions`, `POST /v1/assistant/job-subscriptions`, `/:id/status` | Triggers that start runs under the person's own mandates; a goal trigger ends with its goal |
| `GET /v1/assistant/envelopes`, `POST /v1/assistant/envelopes` | Envelopes of the parties the person acts for (with the reader's own receipt); send: `delivered`, `escalated`, `approval_required` or `not_delivered` |
| `GET /v1/assistant/negotiations`, `GET /v1/assistant/negotiations/:id` | Sessions of the two parties only |
| `GET /v1/assistant/escalations`, `POST /v1/assistant/escalations/:id/resolve` | "Your decision is needed" items from agent-to-agent work |
| `GET /v1/assistant/company-mandates` | Company mandates the person's agent executes |
| `GET /v1/companies/:id/representative`, `POST …/representative` (step-up), `/accept` (step-up), `/suspend`, `/resume` (step-up), `/disable` (step-up) | The company's one representative |
| `GET /v1/companies/:id/agent-mandates`, `POST …/agent-mandates` (step-up), `/:mandateId/reconfirm` (step-up), `/:mandateId/revoke` | Company mandates |

## Limits of this release

- Envelope contexts are RFQs and quotes (their parties and versions are verifiable); introductions, events and plan items follow with their modules.
- The receiver's decision uses a deterministic, fail-closed subset of `evaluateMandateV2` (exact contexts or selectors without categories, regions or project; any condition, approver rule or non-pre-authorized policy escalates).
- Company mandates that ask for approval escalate to the company's members holding `company.deals.manage`; named approver rules are recorded but not yet routed per approver.
- The worker sweeps (`agents_expire_sessions`, `agents_lapse_reconfirmations`) are granted to the worker role but not yet scheduled; the API applies expiry and lapsed windows lazily on access.
- Protection limits use engine defaults until the hub agent policy (HUB-002) is stored.

## Tests

`tests/assistant-goals/contracts.test.ts` (pure: state machine, note guard, schemas, capability parity against the mounted routes), `goals.test.ts`, `envelopes.test.ts` and `representation.test.ts` (real PostgreSQL under the runtime role: negative authorization, injection attempts, privacy, concurrency, same-transaction membership loss, kill switches).

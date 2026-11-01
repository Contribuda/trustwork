# ADR 020 — Agent job execution and authoritative hub attribution

Date: 2026-11-01. Status: **Accepted technical architecture, 2026-11-01**. ADR 019 is reserved for the separate admin UI proposal.

Agent: Codex CLI (OpenAI) for Parshkov. Decision owner: maintainer for architecture, contracts, migrations and coordinated scope. Product-policy changes are not proposed.

## Maintainer decision

The delegated conductor accepted option 3 and the technical decisions below in [PR #445](https://github.com/Contribuda/trustwork/pull/445#issuecomment-6552887365), merged as `17850921c556a30841d34181462fe0967b7900b2`. This records architecture acceptance, not implementation acceptance. Scope allocation, isolated additive migrations, feed inventory and legacy disposition remain implementation review obligations. The conductor coordinates them under the existing handoff. No historical catch-up, expanded standing mandate, external provider or launch is authorized.

## Context

AGT-003 must turn confirmed job subscriptions into runs and enforce the same capability policy across participant interfaces, the agent runtime and MCP. A readiness event is not a run. A hub policy cannot accurately preview its impact or isolate its kill switches using node-wide objects without authoritative attribution.

This proposal follows a bounded review of [PR #385](https://github.com/Contribuda/trustwork/pull/385) at `3484d78e62558a584c5e22e2624743d16b5c2804` (A). Evidence below is pinned to that commit; it is not a claim about a later revision. The implementation remains incomplete. No tests of the proposed runtime, provider calls or deployment were performed. Passing CI for groundwork would not establish the missing acceptance.

Authority remains the product specification (especially R54, R73 and the assistant rules), recorded owner decisions 23/25 in ADR 010, frozen contracts and ADRs 003/004/008. ADR 013 is itself **proposed**; its transport details are not promoted to accepted policy here. Onboarding sections 7–8 distinguish implementation choices, proposed architecture and maintainer acceptance.

## Current evidence

Paths below are relative to A; line numbers refer to its pinned commit.

| Evidence | Verified behavior and limitation |
|---|---|
| `packages/contracts/src/agent-catalog.ts:1078`, `JobTriggerSchema`, `JobSubscriptionSchema` | Five trigger kinds already exist. A trigger starts a run; only the mandate authorizes. Subscription shape has no hub field. |
| `packages/contracts/src/agent-modules.ts:153`, `JobTemplateSchema`; `policyDocumentViolations` job checks around 280–300 | Templates declare actions and triggers, not executable code. Standing jobs explicitly reject human-only, commitment and budget-bearing actions. This proposal preserves those exclusions. |
| `apps/api/src/modules/agent-modules/jobs.service.ts`, `turnOn`, `runNow` | Turn-on records an inert proposal and request; `firstDue` exists only for schedule triggers. Request records the authority object's hub. Run-now calls `agentJobs.requestRun`; it does not start an assistant run. Goal ownership is checked at turn-on, not a general event-resource authorization feed. |
| `packages/data/migrations/agent-modules/20261104100000_agent_modules.sql:649`, `agent_modules_on_proposal` | First-party confirmation creates the subscription and schedule. Existing job requests/schedules already carry nullable `hub_id`. |
| Same migration:623, 683–755, `agent_modules_fire`, `agent_modules_due_jobs`, `agent_modules_record_fire`, `agent_modules_request_run` | Fire deduplicates by `(subscription, due_at)`, records readiness and emits `agents.job_due`. It checks active subscription/mandate, expiry, offered template and switches, but is not the full principal/resource/action authorizer. `coalesce(p_hub, schedule.hub_id)` permits a caller-provided hub to take precedence; no equality assertion is present. Worker wrapper must not become a hub override. |
| `apps/api/src/modules/agent-modules/scheduler.ts:18`, `runDueJobs`; contracts `deadlineOccurrences:575`, `triggerMatchesEvent:584` | Time scheduler records firings. Event matching and deadline offsets are pure functions, not durable authorized feeds. One `next_due_at` is insufficient to enumerate multiple context deadlines/offsets. |
| `apps/worker/src/main.ts:31–70`, `buildRegistry`; `apps/worker/src/assistant/handlers.ts:131`, `registerAssistant`; `apps/worker/src/relay.ts`, `relayOnce` | No job-due consumer or due-job task registration. Assistant handlers dispatch/reconcile existing intents only. Unhandled outbox events are marked published, so adding a handler later does not replay old published rows automatically. |
| `apps/api/src/modules/assistant/assistant.service.ts:332`, `converse`, `proposeAction:421`; `packages/data/migrations/assistant/20261102110000_assistant.sql:194,1390` | Conversation starts a run under an authenticated principal; run INSERT policy requires that principal. No durable subscription-to-run worker entry point exists. Existing run states/checkpoints can be reused. Calling the session-based service with a fabricated RequestState is not a worker authorization design. |
| AGT-003 migration:190,301,321,393 | Epoch locking precedes intent locking; switch engagement fences executing/pending intents for reconciliation. `assistant_begin_attempt` takes a process-supplied hub; intents and mandates lack hub attribution. Hub switch fencing explicitly covers matching intents node-wide. |
| Same migration:461–479,515,539, `agent_modules_affected` | Counts match modules across the node; hub is checked for staff permission, not passed into the count query. Suppression requires ten distinct principals. Preview validation repeats the same node-wide calculation. |
| `apps/api/src/modules/agent-modules/authority.ts`, `CapabilityAuthority.check`, `requireCapability`, `agentRuntimeGate`, `mcpGate` | Shared gate checks manifest action binding and policy; it explicitly does not replace mandates. Repository search finds `requireCapability` used by the availability endpoint, not all business operations. `mcpGate` has no production transport caller. |
| `packages/data/migrations/connections/*`, `connection` and its activation function | Connections already have nullable `hub_id`, set on activation; mandate and job counts need separate attribution. Do not infer connection hub from another mandate owned by the same person. |
| `docs/engine/work-packages.json`, AGT-003, MCP-001, MCP-003, AGT-004, AGT-023 | AGT-003 requires all five triggers and identical refusal. MCP runtime/transport and real entitlement/extension adapters have their own packages, which depend on AGT-003. This is a sequencing issue, not permission to remove parity. |

## Options

1. Register the timer and call conversation/runtime code as a stored person. Rejected: events still lack a consumer; an arbitrary session surrogate, broad worker table access or raw event text cannot authorize execution.
2. Keep readiness-only behavior and declare AGT-003 complete. Rejected: the requested implementation and trigger/parity acceptance remain unmet.
3. **Recommended: narrowly typed occurrence execution on the existing worker, with stored provenance, owner-module authorization and per-operation hub attribution.** Preserve public trigger and mandate contracts; add only the internal coordination records and worker entry points needed. Review those cross-module authority changes through this ADR. No generic automation executor or new workflow product.

## Accepted technical decisions

### 1. One durable occurrence, one run

Introduce an internal occurrence ledger, owned jointly by AGT-003 and AST-001, with subscription ID/revision, source kind and stable source identity, request/schedule reference, authoritative hub, template implementation version, confirmed mandate revision/digest, run ID, terminal refusal/reconciliation reason and worker fencing identity. Store identifiers and digests, not raw event bodies or private text.

Use distinct unique keys: schedule `(subscription, revision, scheduled instant)`; request `(subscription, committed API idempotency operation)`; event `(subscription, source event ID)`; goal `(subscription, goal progress ID)`; deadline `(subscription, context kind/id, deadline revision, offset)`. Do not use a timestamp alone for unrelated events. Preserve legacy `agent_job_fire` as readiness history; a new unique link maps each valid old fire to at most one occurrence. `AgentModulesController.runNow` is already decorated with `@Idempotent('agent_modules.job_run_now')` (`agent-modules.controller.ts:130`); propagate its committed operation identity and test the transaction boundary rather than creating a second idempotency system.

The `agents.job_due` consumer transaction validates its source row, inserts/gets the occurrence and durably enqueues its run-start job. AST-001 exposes a worker-only `startSubscriptionRun(occurrenceId, leasedJobId, fencingToken)` use case (proposed name). It derives all principals, contexts and hub from stored records. Its transaction rechecks authority, inserts one `run` and links it uniquely to the occurrence, writes an audit/run step and a durable continuation. Crash before commit rolls everything back; crash after commit resumes that same run. A terminal refusal is visible to its principal and does not become success.

Bind a template key to an engine-owned, versioned handler in the module registry. Hub JSON supplies allowed configuration, never executable text or arbitrary tools. Initially use deterministic local/fake handlers. A model, if later permitted, may only propose typed calls through the same action pipeline; it cannot select its own principal, hub or authority. Unsupported template implementations remain explicitly unavailable. Pin execution semantics; a changed implementation that needs broader actions/contexts requires a new first-party proposal, never reuse of old confirmation.

### 2. Resource-authorized feeds

Each owning domain exports a narrow feed adapter: given a stored subscription and source ID, it resolves the resource, revision, home/serving hub and minimum permitted projection, and checks current principal access and mandate contexts. No wildcard listener sends every matching node event to every subscriber. Matching `eventType` is necessary but never sufficient. Unknown source kinds fail closed.

For goals, consume stored `goal_progress` IDs; validate ownership, active confirmed goal, linked mandate and subscription. Paused/closed goals do not resume work because a progress event arrives late. Existing `goal_progress` writes in `GoalsService` and `agents` migration are the producer locations; a type string alone is not proof that an outbox feed exists.

For deadlines, the source module exposes only readable deadlines within mandate contexts, with stable resource/deadline revision and time-zone semantics. Persist each pending offset from `deadlineOccurrences`, not merely the next timestamp. A changed/removed deadline invalidates unfired old-revision occurrences and creates distinct new ones. Recheck the source before execution. Deduplicate repeated offsets. Private deadline values stay in the authorized module/runtime projection, not global event payloads or metrics.

Use the accepted scheduler's calendar, interval and time-zone helpers. Retain its schedule progression semantics; do not introduce a catch-up flood, quiet-hours exception or changed cadence. Domain adapters and the supported template/feed inventory must be explicit acceptance evidence for every trigger kind. An unsupported feed is a remaining gap, not a completed trigger.

### 3. Principal, authority, revocation and races

Worker identity is `trustwork_worker` plus a persisted lease and occurrence, not a person login. A restricted definer/use case may evaluate the stored person's current rights for this occurrence; it must not expose `runAs(personId, arbitraryCommand)`, change `current_person` to bypass caller checks, grant direct party-table reads or let staff start another person's job.

At fire admission, run start, every continuation after a pause, every tool read and immediately before an effect, intersect current identity/hold status, company membership and permissions, representative/accountable-person state if applicable, active confirmed mandate revision/expiry/contexts, active subscription, goal state, template availability, manifest action binding, hub policy, entitlement, extension status, stop/kill switches, exact approvals and applicable reservations. Reuse owning-module screening/authorization; the occurrence never grants resource access. Turn-on's profile/company context is not blanket access to every matching RFQ or deadline: if the action needs an unconfirmed resource context, refuse/escalate for structured confirmation.

Extend existing epoch synchronization to subscription/goal/feed-resource invalidation. Lock global scopes in the existing node/hub/company/person/connection order, then domain source/subscription/mandate and occurrence/run/intent locks in a documented consistent order. Every corresponding revoker must acquire the same relevant lock or bump the same epoch; an unchecked snapshot is insufficient. Test both serialization orders. A revocation committed before dispatch refuses the effect. A dispatch that won the serialization point may already be in flight; switch engagement fences local settlement and parks it for reconciliation. Releasing a switch does not resurrect ended subscriptions or replay parked effects.

### 4. Hub attribution without rewriting mandates

Persist a server-derived execution-hub binding for every new request, run and intent. Resolve it from the trusted first-party serving-hub context, stored job request or validated connection audience/`connection.hub_id`; owning resource modules independently resolve resource authority. A payload hub, language, country, company address or process default is not evidence. Reject conflicting/unknown binding for new automated execution. Cross-hub resources require the existing explicit access contract and all applicable gates; they do not silently move an operation to a permissive hub.

Do not add a hub field to old signed mandate JSON or recompute its digest. Use an immutable provenance/usage relation linking mandate revision to an authenticated hub context. A mandate may have multiple proven hub uses; each run/intent has exactly one execution hub. This is execution attribution, not a new rule that globally restricts a person's mandate to one hub. Mandate/resource access remains an independent intersection.

Pass the stored hub to dispatch, and validate any supplied hub equals it. Filter kill-switch fencing and all four impact counts by the same proven attribution; connections use their own hub binding. Count a mandate once per hub where relevant and a run once; suppress counts unless ten distinct principals support that category. Bind the preview digest to a deterministic attribution/policy snapshot and recheck it at activation.

Legacy unknown attribution must not be guessed. Keep conservative fencing for unresolved in-flight actions and preserve their operation IDs/reservations for reconciliation. For a hub preview that cannot establish an exact scope, refuse the preview/activation as unavailable until attribution is resolved; do not label node-wide counts as hub counts or use `null` to mean unknown (`PreviewCountSchema` defines it as a small suppressed cohort). Backfill only from verifiable stored request, connection and originating command evidence. Otherwise keep the row unresolved and require a fresh authorized operation/proposal when needed. No silent replay.

### 5. Egress and outcomes

Creating an occurrence or run is local. Domain data enters model/channel adapters only through allowed projections and an explicitly activated data-class/endpoint policy. No automatic publication, real payment, external provider setup or egress expansion follows from this ADR. Fake adapters are sufficient for this package's runtime acceptance; real entitlements/extensions remain AGT-004/AGT-023 ports.

Reuse AST-001 operation IDs, stable correlation keys, attempts, leases and reconciliation for effects. A timeout, stale lease, lost result or acknowledgement is not final success. Keep `outcome_unknown` and reservations until authoritative lookup/receipt evidence resolves the same operation. Never create a new occurrence/run/action to evade an unknown result. Internal transaction ambiguity is reconciled by querying occurrence/run linkage; provider ambiguity by the provider-specific lookup contract or recorded manual evidence. A provider with no definitive lookup cannot justify a blind retry.

### 6. Parity scope and package acceptance

Preserve full participant capability parity. Inventory every implemented operation, its capability, action, object authorizer and UI/agent/MCP adapter. Apply the shared gate on real service entry points before reads/writes, and again at durable dispatch; an availability endpoint is not enforcement. Human-only govern actions retain first-party handoffs; a handoff never invokes the action.

Within AGT-003, test identical decisions through actual participant service execution, agent invocation and the MCP adapter, including scope differences as explicit inputs. Record transport end-to-end tests as pending until MCP-001/003 connect the adapter. Do not call adapter tests full MCP transport acceptance. Maintainer must record the dependency boundary: AGT-003 supplies and proves the shared authority and trigger runtime; MCP packages consume it and prove transport parity. If the maintainer considers actual transport execution part of AGT-003 acceptance, agree a coordinated dependency/scope change before marking anything done. The maintainer accepts this boundary: AGT-003 proves shared service/agent/MCP-adapter authority and all five durable triggers; MCP-001/003 prove actual transport integration. The package graph is unchanged, and unfinished AGT-003 does not open dependent work.

## Work possible without a new ADR

The following enforce existing contracts and can be normal implementation repairs, with existing path ownership and migration agreement where applicable:

- Wire `requireCapability` into implemented participant operations and add real negative service tests. Action/manifest binding and full parity are already required; no policy choice is needed.
- Reject a fire hub that disagrees with the stored schedule/request hub. Existing nullable rows must fail closed for automated execution, not be assigned arbitrarily.
- Use existing request/schedule hub links for job-subscription impact isolation and `connection.hub_id` for connection isolation. This alone does not fix mandates/open runs or make the full preview correct; do not ship it as complete hub attribution.
- Reuse `runDueJobs`, calendar helpers, REL-001 receipts/jobs and AST-001 reconciliation. Registering the timer is ordinary wiring **after** an authorized consumer exists, not a standalone completion fix.

There is no verified zero-contract/zero-migration repair that completes the entire package today. New worker authority, durable source identity and attribution require coordinated owning-module work; their exact internal shapes are architecture choices in this proposed ADR, not reasons to weaken product rules.

## Migration, compatibility and implementation order

1. Maintainer accepts or amends the architecture, assigns coordinated non-overlapping scopes to AGT-003, AST-001, AGT-001, REL-001 and affected resource/API owners, and resolves the MCP acceptance boundary. Preserve `in_review` meanwhile.
2. Add reviewed forward-only migrations for internal occurrence/run links, proven hub bindings and narrow worker functions/grants. Revoke default PUBLIC execution and app-role access to worker-only functions; grant only the exact worker entry points with a fixed search path and validated lease/source identity. Preserve old mandate digests and public trigger shapes; do not edit an applied migration. Update repository schemas and contracts for any genuinely new exposed shape before consumers. No root configuration/lockfile change is implied.
3. Implement run-start and one safe deterministic template through the existing assistant pipeline, then resource-authorized event/goal/deadline adapters and all pending offsets. Test authority and race behavior before registering the scheduler/consumer together.
4. Enumerate already-published `agents.job_due` events and old readiness rows. A controlled, audited reconciliation pass joins exact source identities and deduplicates against the occurrence ledger. Default: do not execute historical readiness merely because a consumer was installed; stale/ambiguous work needs an explicit disposition and current authority. Agree any catch-up behavior separately.
5. Complete service-level parity and hub-isolation tests, exact-head quality gates, status/limitations and maintainer review. Disabling the consumer halts new execution; retained ledger/unknown outcomes remain available to reconcile. No destructive rollback or auto-acceptance.

## Acceptance evidence required

These are proposed tests, **not tests run in this review**:

- Real PostgreSQL: confirmed versus unconfirmed/expired/revised mandates; other person/staff denied; lost membership/permission, held identity, paused goal/subscription, withdrawn template, disabled module/action/plan all refuse with zero effect.
- Each of five triggers reaches exactly one authorized run from durable input; duplicate same-instant events stay distinct, replayed same-event IDs do not; request retries preserve identity; all deadline offsets survive restart and deadline revision changes. DST/closed-day behavior remains the current contract.
- Worker cannot read arbitrary party tables, choose a different person/hub/resource or execute an unregistered template. Forged event fields and untrusted text cannot alter action, authority or publication state.
- Crash before/after occurrence/run commit, duplicate relay/redelivery, stale fence and lost lease produce one run; crash after fake provider commit causes lookup, never a second effect. Unknown retains reservations; late receipt and kill-switch race reconcile.
- Two hubs with the same principal/module: proven hub-A counts and switches exclude hub-B, node switches cover both, unknown legacy rows stay conservative. Cohorts of nine distinct people suppress; ten mandates of one person still suppress. Attribution/policy changes invalidate previews.
- Actual service mutation/read, agent path and MCP adapter return equivalent capability refusals. A transport test remains explicitly pending until that owner integrates it; no baseline masks an ungoverned operation.
- Forbidden-field projections cover event/deadline feeds, logs, outbox, reports and external adapter input. Fakes prove egress denial without providers.

## Consequences and implementation coordination

This reuses the existing durable runtime and keeps authority at domain boundaries, at the cost of several narrow cross-module migrations and negative/concurrency tests. It avoids a broker, generic automation service and broader standing mandates.

Maintainer decisions: occurrence and attribution design; narrow worker grants; resource-feed inventory and ownership; safe legacy disposition; coordinated migration order; exact AGT-003/MCP acceptance boundary. Owner/hub-operator decisions are needed only if someone proposes changed cadence, catch-up behavior with new consequences, broader standing actions, external egress or other product policy. None is assumed here. Current provider readiness, deployed behavior and remote acceptance remain unknown.

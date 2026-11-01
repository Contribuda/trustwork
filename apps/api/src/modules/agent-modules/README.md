# Agent modules: registry, hub agent policy, job subscriptions and kill switches (AGT-003)

The administrator's agent-functionality controls of [ADR 010](../../../../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decision 25 and the participant's side of them ([agent product administration](../../../../../docs/engine/hub-console/user-agents-admin.md), [agent catalogue](../../../../../docs/engine/agent-catalog.md), [Your agent](../../../../../docs/engine/agents.md)). Contracts: [`agent-modules.ts`](../../../../../packages/contracts/src/agent-modules.ts) (policy document, module controls, capability switches, participant bounds, job templates, triggers, preview, the shared check) on top of AGT-002's [`agent-catalog.ts`](../../../../../packages/contracts/src/agent-catalog.ts) and the console contract [`hub.ts`](../../../../../packages/contracts/src/hub.ts), which gained the additive `agent_capability` kill-switch scope (integrator agreement). Storage: [`packages/data/migrations/agent-modules`](../../../../../packages/data/migrations/agent-modules), [`repositories/agent-modules.ts`](../../../../../packages/data/src/repositories/agent-modules.ts).

Status: **Live** in the API with fakes: no entitlement provider (everyone is on the `free` plan until AGT-004), no extension registry (AGT-023), no model, no MCP transport (MCP-001 and MCP-003 wire the MCP adapter). AGT-003 is not complete: the scheduler's database entry points and `runDueJobs` pass are tested, but no periodic task or `agents.job_due` consumer is registered. A due event is readiness, not an executed run. Goal-source discovery now uses the owning RLS projection and durable deadline offsets; neither is an executed subscription. See the dependency boundary and [access inventory](ACCESS-INVENTORY.md).

## Rules the module enforces

| Rule | Where |
|---|---|
| Module manifests ship with the engine; a hub never widens one | `ENGINE_MANIFESTS` (execution evidence, profile keeper, project planner, reputation builder, task marketplace) plus activated extension versions (`ExtensionCatalogPort`); `policyDocumentViolations` refuses actions, capabilities (tools) and private data classes beyond the manifest, unknown modules and lowered free floors |
| The hub agent policy is the `agents` configuration domain | The payload is an `AgentPolicyDocument`: AGT-002's `HubAgentPolicy` unchanged, module controls (status, participant types, verified company, verbs, capabilities, data classes, limits), capability switches (hub, participant type, plan), participant defaults and maximums, job templates, the hub calendar and the preview. HUB-001 versions it; the domain is sensitive, so a second person approves the digest of the payload, which carries the preview |
| The preview the approver saw is the one that activates | Drafting computes the preview (changed modules and capabilities, narrowed modules, participant types, plans, cohort counts of active mandates, job subscriptions, connections and open runs, each suppressed unless at least ten distinct principals are represented) and stores it in the payload; `agent_modules_record_draft` recomputes the counts and checks the base version. The activation hook on `hub_config_version` refuses a version AGT-003 did not validate (`agents.policy_unvalidated`) and a preview whose base version or counts changed (`agents.preview_stale`) |
| Guard rails no setting can switch off | Strict schemas everywhere; the free-form module settings map refuses guard-rail keys; `release_payment` stays never pre-authorizable; the database repeats the key check (`agent_modules_guard_rail_keys`). A commitment module never acts for an unverified company |
| One shared authority check for every surface | `CapabilityAuthority.check`: the hub's active policy (or the engine default, which switches nothing off) through `capabilityRefusal`, then every kill switch and stop through `agent_modules_dispatch_refusal`. Adapters: `requireCapability` (interface routes), `agentRuntimeGate` (wired into AST-001 `AssistantService.proposeAction` by `app.module.ts`), `mcpGate` (scopes first, then the same check). Modules without a manifest are not governed yet; kill switches still apply to them |
| Turning a job on is a proposal only | `POST /v1/assistant/jobs` inserts an inert mandate proposal (origin `module_template`, the strictest of the hub's default approval and the verb defaults) and a pending `agent_job_request`. The hook on `mandate_proposal` creates the `job_subscription` and its schedule only when the person confirms on the first-party form; declining, expiry or supersession withdraws the request; a template the hub withdrew meanwhile lapses it |
| Triggers in the principal's time zone and the hub calendar | `nextScheduleOccurrence` (FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE; DST-safe), closed dates as hub data with `skip`, `next_open_day` or `run`; `deadlineOccurrences`; event and goal triggers by `triggerMatchesEvent`; minimum intervals from the template, the hub and the engine floor (60 minutes) |
| Firing records readiness after basic checks | `agent_modules_fire`: active subscription, active unexpired mandate, template still offered, no module-wide kill switch or stop; per-capability and verb checks still belong to the missing run consumer; idempotent per due time; only `due` emits `agents.job_due` |
| Kill switches through authorization epochs | Engaging or releasing an agent switch, a person's stop, a representative suspension or a connection ending bumps `agent_authz_epoch` in that transaction. The dispatch recheck (`assistant_begin_attempt`, extended here) locks the epochs it depends on before it locks the action, so an engagement and a dispatch serialize: the dispatch refuses (`kill_switch`, or `capability_off` for a policy switch), or the engagement fences the executing action to reconciliation (attempt abandoned, outcome unknown, reconcile job queued; the dispatcher's own result is refused). Releasing reactivates nothing |
| Staff never manage one participant's agent | Admin routes take only a hub, a policy version or a switch; job requests, schedules and firings are principal-only under FORCE RLS; staff functions return cohort counts |
| No module code path branches on a country code | Calendars and defaults are data; linted in `tests/agent-modules/contracts.test.ts` |

## Routes

Staff routes (`/v1/admin/agent-modules/:hubId/...`): session, staff role covering the hub, live elevation; mutations carry CSRF metadata, an `Idempotency-Key` restated in the console command and a reason, and complete in the request transaction (crash-tested in `tests/backend/idempotency/cases/agent-modules.ts`).

| Route | Result |
|---|---|
| `GET registry` | Module manifests and activated extension capabilities |
| `GET policy`, `GET policy/:versionId` | The current policy (or the engine default), validated versions with their stored preview and the digest a second person approves |
| `POST policy/preview` | The preview of a candidate document; stores nothing |
| `POST policy` | A validated draft with its preview (`admin.agents.policy.edit` or `admin.config.edit`) |
| `POST policy/:versionId/activate` | HUB-001's activation: `pending_second_person`, then applied with `approvalId`; refused when stale or unvalidated |
| `GET kill-switches`, `POST kill-switches`, `POST kill-switches/:killSwitchId/release` | Agent switches (`hub_agent_dispatch`, `agent_module`, `agent_capability`, `agent_action`, `external_agent_api`; `admin.agents.kill`); release asks a second person and needs an incident note |

Participant routes (`/v1/assistant/...`, the signed-in person only):

| Route | Result |
|---|---|
| `GET capabilities`, `GET capabilities/:capabilityId` (`for=self\|employer`) | Availability of every governed capability; one capability answers 200 or the shared refusal (`access.forbidden` with `reason` and `messageKey`) |
| `GET agent-settings/bounds` | Hub defaults and maximums for the participant's agent settings and the protection limits |
| `GET job-templates` | Jobs the enabled modules offer, with whether this person may turn each on |
| `POST jobs`, `GET jobs`, `POST jobs/:id/run` | Turn a job on (a proposal), list requests with their next run, run an active job now |

## Changes outside the package paths (minimal, justified)

- `packages/contracts/src/hub.ts`: the additive `agent_capability` scope of `KillSwitchScopeSchema`; `agent-catalog.ts`: `agentDispatchBlocked` reads an optional capability; `hub-core.ts`: the `agents` payload schema is the AGT-003 document.
- `packages/data/src/schema/admin.ts`: the new `kill_switch.capability_id` column (the migration alters the ADM-001 table and replaces its engage, guard and permission functions additively).
- `apps/api/src/modules/assistant`: an optional capability gate in `AssistantService.proposeAction`; `apps/api/src/modules/assistant-goals`: envelopes take `maxNegotiationRounds` and `envelopesPerCounterpartyPerDay` from the active policy's protection limits (`agentProtectionLimits`), as AGT-001 anticipated; `apps/api/src/modules/hubs/errors.ts`: two activation-hook hints; `app.module.ts` and the idempotency route map: one entry each, in alphabetical position.
- `tests/hubs/hubs-data.test.ts` no longer activates an unvalidated `agents` payload.

## Tests

`tests/agent-modules/contracts.test.ts` (pure: widening, eligibility, defaults, templates, guard-rail schema test, the shared check, preview diff, schedules and the country-code lint), `policy.test.ts` (HTTP and database: negative authorization, guard rails, previews, second person, stale and unvalidated activation, kill-switch API, no per-person staff access), `runtime.test.ts` (jobs as proposals only, scheduler, every kill-switch level, reconciliation of executing actions, concurrency on the epochs, parity of the interface, the agent runtime and MCP).

## Job execution dependency boundary

Do not register `runDueJobs` alone and claim working subscriptions. `apps/worker/src/main.ts` has no `agents.job_due` handler; the relay marks unhandled events published. AST-001 exposes conversational runs and action dispatch/reconciliation, but no trusted subscription-to-run entry point that reloads the principal, confirmed mandate, template and capability policy without a user session. A consumer must durably deduplicate a firing and create that run under current authority before the periodic scheduler is enabled. This is a concrete dependency on the assistant runtime, not a new product-policy decision.

`GoalOccurrenceFeed` loads current goals, progress, subscriptions and confirmed explicit mandate contexts through the real principal RLS projection. New goal evidence emits an identifiers-only event, and reports do not recursively trigger work. `agent_modules_sync_goal_deadlines` is a narrow worker-only discovery function: it stores every offset against subscription, goal and hub-calendar revisions, retains elapsed offsets without catch-up and invalidates pending offsets on goal/subscription/calendar changes. It grants no execution authority and creates no run. Worker lease admission, the authorized event consumer and deterministic template execution remain unimplemented. Schedule and request paths still record readiness only. All five trigger-to-run acceptance criteria remain open.

The coordinated direction in ADR 020/022 was technically accepted in PR #445, comment 6552887365; PR #472 records that decision in the ADR documents. PR #406 and #472 are now merged. The shared runtime is being implemented on that reviewed foundation; model recovery, fencing, cancellation and unknown-effect holds remain independent and must be preserved. No new owner policy decision is needed for this engineering scope.

The dispatch recheck uses `free`, matching `FreePlanEntitlements`. AGT-004 must replace both the API port and the database resolution together when real plans arrive. MCP parity is verified at `mcpGate`; MCP-001/MCP-003 must connect the transport. Existing participant feature routes do not yet all call `requireCapability`, so adapter parity is not end-to-end interface enforcement.

Multi-hub limitation: mandates and action intents have no hub attribution, so `agent_modules_affected` aggregates matching modules across the node and hub kill switches conservatively fence matching executing intents node-wide. These are not isolated per-hub impact counts. Accurate hub previews require authoritative hub attribution from the owning modules; do not infer it from a staff request or a free-form setting.

## First-party serving provenance

New job proposals resolve the exact configured first-party server origin against an explicit `agent_serving_hub` registration. The runtime role can read registrations, but cannot install or modify them. There is no fallback to `TRUSTWORK_HUB_ID`, a client Host/Origin header, locale or address. An installation without an authorized routing registration fails with `hub_provenance_unavailable`; no deployment registration is created by this package.

The proposal transaction stores immutable `agent_job_provenance` with the real session and API idempotency operation. First-party confirmation records the exact signed mandate revision/digest separately in `agent_mandate_usage`. Existing signed JSON and digests stay unchanged. Legacy requests receive no guessed backfill and remain unproven for automated execution. Run/intent attribution and isolated policy previews remain pending runtime integration. `tests/agent-modules/provenance.test.ts` checks default/header substitution, replay identity, digest preservation and real-role privacy.

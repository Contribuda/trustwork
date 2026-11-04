# Governed extension registry (AGT-023)

How a hub administrator adds functions, tools, integrations and capabilities to the participant's one agent ([ADR 010](../../../../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 22 and 25; [agent product administration](../../../../../docs/engine/hub-console/user-agents-admin.md#extensions-adding-capabilities-to-agents)). Contract: [`agent-extensions.ts`](../../../../../packages/contracts/src/agent-extensions.ts). Storage and every rule: [`packages/data/migrations/agent-extensions`](../../../../../packages/data/migrations/agent-extensions). Suites: [`apps/worker/src/agent-extensions`](../../../../worker/src/agent-extensions).

Status: **implemented for fake connections, API and worker.** No live adapter ships, so an extension runs only where its route resolves to a fake connection. The console is wired by HUBC-009. Adapter output is dropped after its digest is taken: nothing delivers it to the conversation yet.

## Rules

| Rule | Where |
|---|---|
| A manifest is a closed vocabulary with no key that can disable a guard rail | `EXTENSION_MANIFEST_KEYS` and `agent_extensions_manifest_keys` (the registry test compares them); any other key at any depth is `guard_rail` |
| Every action names a mandate kind | `manifestRefusals` and `agent_extensions_check_manifest` (`action_without_mandate_kind`); `read` and `govern` are not extension actions |
| A confirmation is never weaker than the strongest built-in action of the same mandate kind | `confirmationFloor` and `agent_extensions_confirmation_floor`, read from the engine manifests |
| A declared side effect fixes the mandate kind | `SIDE_EFFECT_MANDATE_KINDS`: `outbound_message` needs `communicate`, so the action meets that kind's floor and the `outbound_messages` kill switch; a mismatch is `side_effect_needs_mandate_kind` |
| What leaves is declared | `external_call` needs a non-empty `dataClassesSent` (`data_classes_undeclared`), and each private class needs an egress class that carries it (`PRIVATE_CLASS_EGRESS`, `private_class_not_sent`) |
| No endpoint in a restricted place | The stated country and region and the country-code domain, at draft and again at activation, through `hubs_place_restricted` (which also reads places the hub added) |
| A mandate binds what the person confirmed | The key is its own module key (a built-in key is refused, `key_reserved`), and each first-party confirmation records, per hub, the digest of the active version's authority: the manifest without its titles. A wider version, or the same key in another hub, needs a new confirmation (`extension_not_confirmed`); a new wording does not |
| `tested` is the engine's word | Staff ask for a run (`agents.extension_safety_run`); only the worker role records it, under a live job lease, on the fake adapter, for this manifest digest |
| `active` is a hub configuration version | Domain `agent_extensions`, activated by HUB-001 under `agents.activate_extension`. The hook `agent_extensions_on_activation` checks every listed version again |
| Activation by the drafter alone fails | The configuration drafter never activates (HUB-001), the activator never approves their own request, and the approver is never the manifest's drafter (`drafter_cannot_approve`) |
| The egress matrix decides | The hook needs an active route scoped to this extension and a dry run of the call gate for every data class sent; a refusal is `egress_denied` with the gate's reason |
| A charge has a price | A charged action needs a mandate kind that spends a budget and names a metered price version. It does not activate yet: only billing may read its tables (payment neutrality), and AGT-004 owns the check that the version is active. Until then the hook refuses it (`price_version_unavailable`) |
| An engine update re-tests | `agents.extension_engine_tick` asks a run for every tested or active version whose passing suite is from another engine; a failure suspends it in the same transaction and fences executing actions |
| Today's rules bind what is already active | The tick withdraws any tested or active version below today's rules, even with no new engine number; `record_run` fails a manifest the database refuses, whatever the report says; `manifest-holds` compares against the built-ins of the running engine |
| A dead suite job is not a pass | The tick expires a run whose job is gone or dead, or that passed its deadline (an hour), and suspends the version when its passing suite is from another engine. A version on the current engine keeps its valid suite |
| Staff never manage one participant's agent | No route names a participant; an audit shows digests and outcomes only |

Lifecycle `draft -> tested -> active -> suspended -> retired`. Suspending needs one person (`admin.agents.extensions.suspend`) because withdrawing an ability is always safe. A suspended version returns to `tested` only with a new passing suite, and to `active` only through a new configuration version.

The two-person flow: the drafter writes the manifest, a reviewer proposes the activation, the drafter asks and applies, the reviewer approves. A third person may ask and apply instead.

## Runtime

There is no second path. `20261210100100_agent_extensions_runtime.sql` adds an extension branch to the bindings the agent runtime already asks, so `AssistantService.proposeAction` and the dispatch recheck treat an extension action as a built-in one:

| Check | Where it comes from |
|---|---|
| Mandate: status, expiry, grantee, module, verb, context, ceilings, window | `evaluateMandateV2`, unchanged. The module is the extension's own key |
| What the person confirmed | `agent_extensions_mandate_covers`, at proposal and again at dispatch: this hub, this authority digest |
| Hub policy and capability switches | `agent_modules_policy_refusal`; an extension has no engine default, so the hub policy must list the active version and enable its module |
| Approval bound to a digest | `action_intent`, unchanged. The effect pins `extensionVersion` (id and manifest digest), and the digest covers it: an approval never carries over to another version (`version_changed`) |
| Budget | The mandate kind's reservation, unchanged. A proposed amount below a declared cost is refused (`amount_below_cost`, for when charged actions can activate) |
| Kill switches and stops | `agent_modules_dispatch_refusal_internal` gains the `agent_extension` scope; engaging fences executing actions like any agent switch |
| Declared inputs | `extensionCallRefusal` at proposal, again in the worker |
| Egress, caps, routes | `providers_authorize_call` for every call, inside `agent_extensions_begin_call`, with the rule of that moment. The extension's own route must be active: a disabled one stops the call and never falls through to a module or job route (`route_missing`). A private class also stays inside the hub's residency by endpoint country, at activation and at every call |
| Restricted places | Again at every call, in case a place became restricted after activation |

A call that reaches the gate leaves one `agent_extension_call` row of digests, refused or not. A crash can roll that row back with its transaction; reconciliation writes it, so no call that may have reached an adapter stays out of the audit.

Adapter output is untrusted. It is parsed against `ExtensionCallOutputSchema`, digested and dropped. An output that fails the contract is recorded as `output_refused` and the action fails, so its reservation is released: the participant received nothing usable.

Lock order matters: every writer of a kill switch takes the provider callback lock and then an authorization epoch, so a dispatch takes `agent_extensions_lock_gate` before `agent_modules_enter_effect`. The other order deadlocks with a kill switch engaged during a dispatch (regression test: `tests/agent-extensions/runtime.test.ts`). The lock is held through the adapter call, which is harmless for a fake; a live adapter must move the gate out of that transaction first.

## Routes

Staff routes (`/v1/admin/agent-extensions/:hubId/...`): session, staff role covering the hub, live elevation; mutations carry CSRF metadata, an `Idempotency-Key` restated in the console command and a reason, and complete in the request transaction (crash-tested in `tests/backend/idempotency/cases/agent-extensions.ts`).

| Route | Result |
|---|---|
| `GET /`, `GET versions/:versionId` | Extensions with their versions and latest run; one version with its transitions |
| `POST versions` | A draft (`admin.agents.extensions.edit` or `admin.config.edit`) |
| `POST versions/:versionId/safety-runs` | Asks the worker for a run; the result arrives only from the worker |
| `POST activations` | Proposes the next list of active versions as a configuration version, with the digest a second person approves |
| `POST activations/:configVersionId/activate` | `pending_second_person`, then applied with `approvalId` |
| `POST versions/:versionId/suspend`, `POST versions/:versionId/retire` | Immediate; executing actions go to reconciliation |
| `POST :extensionId/kill-switch` | Engages `agent_extension` (`admin.agents.kill`); `POST /v1/admin/agent-modules/:hubId/kill-switches/:id/release` releases it with a second person |
| `GET calls` | The newest 200 calls by digest: no person, payload or output |

## Adapters

An adapter is code installed with the engine; a manifest names one and its fake and never supplies code. The engine installs one synthetic pair (`synthetic_http`, `synthetic_http_fake`). No live adapter ships: a live adapter is an owner-approved integration.

## Changes outside the package paths (minimal, justified)

- `apps/worker/src/agent-extensions` and `apps/worker/src/main.ts`: the suite job, the engine tick and the effects. Only the worker role may record a result, so the suite has to run there.
- `apps/worker/src/assistant/handlers.ts`: dispatch and reconciliation fall back to the extension effects.
- `apps/api/src/modules/assistant/assistant.service.ts`: one block in `proposeAction` for the declared inputs and cost and the version pin.
- `apps/api/src/modules/agent-modules` and `packages/contracts/src/agent-modules.ts`: the registry is read per hub; extension entries can be enabled by a policy but never join the engine default.
- `apps/api/src/modules/hubs`: refusal hints of the activation hook, and an optional `onlyDomain` on `activate`, so this module's route activates only its own domain inside HUB-001's single transaction.
- `apps/api/src/app.module.ts` and the idempotency route map: one entry each.
- `tests/agent-modules/helpers.ts`: `buildAgentWorld` takes extra permissions for the hub roles.

The contract is deliberately not reachable from `packages/contracts/src/client.ts`: `hub-core.ts` feeds the client entry, so it does not import this contract, and the hook validates the configuration payload instead.

## Tests

`tests/contracts/agent-extensions.test.ts` (pure), `tests/agent-extensions/safety.test.ts` (the suite on the EVAL-001 harness and every misbehaving fake), `tests/agent-extensions/registry.test.ts` (HTTP and database under the runtime and worker roles), `tests/agent-extensions/runtime.test.ts` (the AST-001 service with a hijacked model and a real worker: every refusal counts what reached the adapter).

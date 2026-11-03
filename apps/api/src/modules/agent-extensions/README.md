# Governed extension registry (AGT-023)

How a hub administrator adds functions, tools, integrations and capabilities to the participant's one agent ([ADR 010](../../../../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 22 and 25; [agent product administration](../../../../../docs/engine/hub-console/user-agents-admin.md#extensions-adding-capabilities-to-agents)). Contract: [`agent-extensions.ts`](../../../../../packages/contracts/src/agent-extensions.ts). Storage and every rule: [`packages/data/migrations/agent-extensions`](../../../../../packages/data/migrations/agent-extensions). Suites: [`apps/worker/src/agent-extensions`](../../../../worker/src/agent-extensions).

Status: **registry implemented, runtime pending.** Staff can draft, test, activate, suspend and retire versions. An active version is not yet callable: the capability binding has no extension branch, so an extension action is refused as `capability.unknown` until the runtime pull request of this package lands.

## Rules

| Rule | Where |
|---|---|
| A manifest is a closed vocabulary with no key that can disable a guard rail | `EXTENSION_MANIFEST_KEYS` and `agent_extensions_manifest_keys` (the registry test compares them); any other key at any depth is `guard_rail` |
| Every action names a mandate kind | `manifestRefusals` and `agent_extensions_check_manifest` (`action_without_mandate_kind`); `read` and `govern` are not extension actions |
| A confirmation is never weaker than the strongest built-in action of the same mandate kind | `confirmationFloor` and `agent_extensions_confirmation_floor`, read from the engine manifests |
| No endpoint in a restricted place | The stated country and region and the country-code domain, at draft and again at activation, through `hubs_place_restricted` (which also reads places the hub added) |
| An extension's key is its own module key | A mandate covers it only when the person confirmed that key, so no existing mandate is widened; a built-in key is refused (`key_reserved`) |
| `tested` is the engine's word | Staff ask for a run (`agents.extension_safety_run`); only the worker role records it, under a live job lease, on the fake adapter, for this manifest digest |
| `active` is a hub configuration version | Domain `agent_extensions`, activated by HUB-001 under `agents.activate_extension`. The hook `agent_extensions_on_activation` checks every listed version again |
| Activation by the drafter alone fails | The configuration drafter never activates (HUB-001), the activator never approves their own request, and the approver is never the manifest's drafter (`drafter_cannot_approve`) |
| The egress matrix decides | The hook needs an active route scoped to this extension and a dry run of the call gate for every data class sent; a refusal is `egress_denied` with the gate's reason |
| A charge has a price | A charged action needs a mandate kind that spends a budget and an active `meter_rate_version` of this hub for its meter and currency |
| An engine update re-tests | `agents.extension_engine_tick` asks a run for every tested or active version whose passing suite is from another engine; a failure suspends it in the same transaction and fences executing actions |
| Staff never manage one participant's agent | No route names a participant; an audit shows digests and outcomes only |

Lifecycle `draft -> tested -> active -> suspended -> retired`. Suspending needs one person (`admin.agents.extensions.suspend`) because withdrawing an ability is always safe. A suspended version returns to `tested` only with a new passing suite, and to `active` only through a new configuration version.

The two-person flow: the drafter writes the manifest, a reviewer proposes the activation, the drafter asks and applies, the reviewer approves. A third person may ask and apply instead.

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

## Adapters

An adapter is code installed with the engine; a manifest names one and its fake and never supplies code. The engine installs one synthetic pair (`synthetic_http`, `synthetic_http_fake`). No live adapter ships: a live adapter is an owner-approved integration.

## Changes outside the package paths (minimal, justified)

- `apps/worker/src/agent-extensions` and `apps/worker/src/main.ts`: the suite job and the engine tick. Only the worker role may record a result, so the suite has to run there.
- `apps/api/src/modules/hubs`: refusal hints of the activation hook, and an optional `onlyDomain` on `activate`, so this module's route activates only its own domain inside HUB-001's single transaction.
- `apps/api/src/app.module.ts` and the idempotency route map: one entry each.
- `tests/agent-modules/helpers.ts`: `buildAgentWorld` takes extra permissions for the hub roles.

The contract is deliberately not reachable from `packages/contracts/src/client.ts`: `hub-core.ts` feeds the client entry, so it does not import this contract, and the hook validates the configuration payload instead.

## Tests

`tests/contracts/agent-extensions.test.ts` (pure), `tests/agent-extensions/safety.test.ts` (the suite on the EVAL-001 harness and every misbehaving fake), `tests/agent-extensions/registry.test.ts` (HTTP and database under the runtime and worker roles).

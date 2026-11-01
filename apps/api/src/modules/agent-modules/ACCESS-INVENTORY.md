# AGT-003 access and operation inventory

Agent: Codex CLI (OpenAI) for Parshkov

This inventory describes implemented owning services and the remaining shared-gate integration. A manifest declaration is not evidence that the service calls `CapabilityAuthority`. The current continuation shares the AGT-001 private report projection with the leased occurrence worker. PR #406 is merged; shared authority integration continues on its preserved model recovery/accounting foundation. AGT-003 remains incomplete.

## Source ports implemented in this slice

| Source | Exact owning paths | Current authorizer and projection | AGT-003 adapter |
|---|---|---|---|
| Goal horizon | `apps/api/src/modules/assistant-goals/goals.service.ts`; `packages/data/src/repositories/agents.ts`; `packages/data/migrations/agents/20261102170000_agents.sql` | Goal and subscription principal RLS, current own-agent confirmed mandate, explicit goal context, matching personal/company scope, active confirmed goal | `goal-feed.ts` returns identifiers, horizon, resource revision and stored hub calendar version. No supplied person or calendar is accepted. |
| Goal progress | Same paths; `goal_progress` immutable evidence | Same owner RLS; evidence recorded after the subscription; current goal and mandate; exact goal or exact `agents.goal_progress` trigger | `goal-feed.ts` returns source identifiers only. A trigger writes an identifiers-only outbox event for new evidence; generated reports cannot recursively trigger work. |
| Pending goal deadlines | `packages/data/migrations/agent-modules/20261109100100_agent_occurrence_sources.sql`; `packages/data/src/repositories/agent-modules.ts` | Worker-only definer derives owner, mandate, goal contexts and hub from the stored subscription/request. It does not establish execution authority or a person session. | One row per subscription/resource/calendar revision and offset; elapsed offsets never catch up. Source rows are locked before invalidation. API callers cannot invoke the worker function; staff cannot read another person's rows. |
| Schedule/request readiness | `scheduler.ts`; `jobs.service.ts`; `packages/data/migrations/agent-modules/20261109100000_agent_modules.sql` | Existing first-party proposal confirmation and stored request/subscription; worker hub argument must exactly match stored hub | Readiness remains separate from a run. Stored legacy hub values are not yet proof of trusted serving provenance. |

No wildcard event listener, arbitrary-principal query port, synthetic worker session or external provider was added. No historical outbox replay is authorized. Project, commerce, consultation, mail and content events are not subscribed by these adapters.

## Real service operations requiring shared enforcement

All method names below refer to actual service entry points, not the availability endpoint. The integration must check capability and resource authority inside the same serialized transaction used by the operation. A preflight outside that transaction does not close revocation races. Anonymous public projection paths also need an explicit serving-context treatment; they must not be converted into an invented participant.

### Project planner

Owner: `apps/api/src/modules/plans/plans.service.ts`, `PlansService`. Authorizers: `ParticipationService.evaluate`, `ownerSide`, project owner/private participation, current company permissions, `PlanMandatePort.allows` for agent preparation, database plan guards; invitees receive `invitedViewFromRows`, never the owner projection. Read-only integration can call the existing projections without editing plan contracts or legal sources.

| Capability suffix (`project_planner.`) | Service methods |
|---|---|
| get_plan | get, getVersion |
| list_shared_items | sharedWithMe |
| preview_share | previewShare |
| list_licensing_notices | licensing |
| list_timing_facts | timingFacts |
| draft_plan | create, createDraft, saveDraft |
| propose_version | propose |
| approve_version | approve |
| return_version | returnVersion |
| record_change | recordChange |
| decide_change | decideChange |
| share_item | share |
| revoke_share | revokeShare |
| update_item_state | updateItemState |
| record_permit | recordPermit |
| add_diary_entry | addDiaryEntry |
| set_location | setLocation |

Implemented read variants `listItemStates`, `listChanges`, `listShares`, `getLocation`, `listPermits`, `listDiary` bind explicitly to `project_planner.get_plan`. All 26 exported plan operations now enter the shared gate inside the owning transaction through `plans.module.ts` and `plan-bindings.ts`. Version approval, return and change decisions retain their first-party handoff. Location does not establish execution hub attribution. Plan timeline/item schedules are potential project deadline resources, but no worker projection port has been implemented here.

### Profile keeper

Owner: `apps/api/src/modules/profiles/profiles.service.ts`, `ProfilesService`. Authorizers: principal RLS; `authority` requires a current `ProfileMandatePort` for delegated commits and refuses delegated governance. Public reads use allowlisted public projection functions and serializers. Private attention records must not become event feeds or behavior logs.

| Capability suffix (`profile_keeper.`) | Service methods |
|---|---|
| get_my_profile | myProfile |
| get_public_profile | publicProfile, publicProfileByHandle |
| apply_profile_edit | saveProfile |
| add_experience | addExperience |
| update_experience | updateExperience |
| set_visibility | setVisibility |
| grant_consent | grantConsent |
| withdraw_consent | withdrawConsent |
| set_portrait | setPortrait |
| list_bookmarks | listBookmarks |
| list_reading_progress | listReadingProgress |

Additional methods needing explicit registry treatment: `listConsents`, `recordLicence`, `revokeLicence`, `removePortrait`, `listExperience`, `archiveExperience`, `getPreferences`, `savePreferences`, `listFollows`, `follow`, `unfollow`, `addBookmark`, `removeBookmark`, `recordReadingProgress`, `companyPeople`. Consent, visibility, portrait and licence governance remain human-only. These methods are not automatically authorized by a similar capability name.

### Execution evidence

Owner: `apps/api/src/modules/execution/execution.service.ts`, `ExecutionService`. Authorizers: `executionAgreements.side`, agreement-party RLS, `actsFor` including `company.deals.manage`, `ExecutionMandatePort.allows` with exact agreement and action, execution database guards. `view` can materialize deterministic observations and is not assumed to be a side-effect-free query.

| Capability suffix (`execution_evidence.`) | Service method |
|---|---|
| get_execution | view |
| record_claim | recordClaim |
| attach_evidence | attachEvidence |
| report_defect | reportDefect |
| decide_claim | decideClaim |
| open_dispute | openDispute |
| appeal_dispute | appealDispute |

### Reputation builder

Owner: `apps/api/src/modules/reputation/reputation.service.ts`, `ReputationService`. Authorizers: `requireActsFor`, current company permissions, party-specific repository commands, owner/inbox/public serializers, limitation and appeal rules. Reputation policy and legal decisions stay with their owners; capability gating must not invent scores or publishability.

| Capability suffix (`reputation_builder.`) | Service method |
|---|---|
| explain_my_reputation | own |
| list_confirmation_requests | inbox |
| view_public_reputation | publicView |
| record_credential | recordCredential |
| check_credential | checkCredential |
| publish_portfolio_entry | addPortfolioEntry |
| send_confirmation_request | requestConfirmation |
| remind_confirmation_request | remind |
| withdraw_confirmation_request | withdraw |
| answer_confirmation_request | answer |
| declare_relation | declareRelation |
| submit_appeal | fileAppeal |
| appeal_limitation | appealLimitation |

### Task marketplace

Owner: `apps/api/src/modules/tasks/tasks.service.ts`, `TasksService`. Authorizers: `ownRequest`, `ownOffer`, `ownAssignment`, `actsFor`, `TaskMandatePort`, party RLS and projection serializers; immutable sent versions and digest-bound acceptance; existing screening/commitment and electronic-record consent rules. A shared gate must preserve these checks and operation keys.

| Capability suffix (`task_marketplace.`) | Service method |
|---|---|
| list_requests | listRequests |
| get_request, get_brief | getRequest (owner/offeror projection selected by existing authority) |
| list_open_requests | listOpen |
| list_invitations | listInvitations |
| list_offers | listOffers |
| get_offer | getOffer |
| list_assignments | listAssignments |
| get_assignment | getAssignment |
| draft_request | createRequest |
| save_request_draft | saveDraft |
| set_request_private | setPrivate |
| publish_request | publish |
| invite | invite |
| cancel_request | cancel |
| draft_offer | createOffer |
| save_offer_draft | saveOffer |
| send_offer | sendOffer |
| withdraw_offer | withdrawOffer |
| accept_offer | acceptOffer |
| withdraw_acceptance | withdrawAcceptance |
| confirm_agreement | confirmAgreement |
| decline_agreement | declineAgreement |
| record_delivery, decide_delivery | record (structured execution command selects the operation) |
| review | review |

## Remaining authority integration

The original five manifests declare 74 capability entries. The additional core manifest registers the existing goal/subscription operations from `packages/contracts/src/agents.ts`; the deterministic report binds `prepare` to `core.generate_goal_report`. The inventory above exposes missing method bindings rather than declaring parity complete. Existing agent and MCP adapter checks do not prove actual participant-service enforcement, and adapter tests do not prove MCP transport E2E.

Occurrence request/run provenance, the versioned deterministic report handler, leased entry points and paired registration are implemented and tested. The shared implementation still needs full service-level capability enforcement and the remaining final-dispatch revoker matrix. The model governance port must be derived from real owning policy ports against the merged recovery/accounting foundation. Missing model, role, source, retention or residency policy stays unavailable. Original-operation model recovery must remain independent of fresh-dispatch permission.


## Occurrence execution paths

| Path | Owning purpose and authority |
|---|---|
| `packages/data/migrations/agent-modules/20261109100300_agent_occurrence_runtime.sql` | AGT/AST occurrence ledger, immutable source signals, worker-only lease admission/final effect; request entry derives current owner and existing idempotency operation. No arbitrary principal parameter is granted to runtime roles. |
| `apps/worker/src/agent-modules/` and minimal `main.ts` registrations | REL paired source consumer/scheduler and transactional leased handlers. Loads without API runtime files. |
| `apps/api/src/modules/assistant-goals/goals.service.ts` | AGT-001 private deterministic report uses the same bounded owning projection as the worker. No communications/content/task/consultation service is edited. |
| `packages/contracts/src/agents.ts` | Registers the existing core capabilities and exact report action binding; no new standing action class. |
| `tests/agent-modules/execution.test.ts` | Real-role source-to-run tests, request replay, duplicate evidence, crash/restart, stale lease, policy/resource denial and staff isolation. |

The worker derives the goal from confirmed explicit contexts, uses the existing mandate coverage/member authority and screening hold ports, and rechecks the active policy and stop/switch epochs. The local private report is not a money or commitment effect. Unknown model/source/residency/retention rules remain unavailable through the merged model governance port; this runtime evidence does not complete LLM work.

## General assistant provenance and hub previews

`20261109100400_agent_execution_provenance.sql` adds immutable run/intent provenance, owner-only reads, stored-hub dispatch and explicit lease fencing. Fresh AST model admission binds a real session to the exact registered serving origin in the same transaction. The old accepted attempt/accounting body remains an internal helper; only the new worker boundary is granted. Original-operation receipt/reconciliation functions are unchanged. The API gate rejects caller-supplied other-person identifiers.

`20261109100500_agent_hub_previews.sql` records first-party mandate confirmations separately from signed JSON, resolves exact current-revision hub membership and uses stored connection audiences. Counts are scoped to the requested hub and require ten distinct principals per category. Unknown legacy attribution fails closed. Draft/activation both compare an opaque attribution digest, including changes hidden by count suppression. Tests create actual synthetic confirmation sessions, rather than copying mandate rows to manufacture authority.

## Service / adapter continuation

- `apps/api/src/modules/plans/plans.module.ts`: wraps the existing owning service with explicit capability bindings; no replacement plan authorizer or projection.
- `service-bindings.ts`, `service-authority.ts`, `plan-bindings.ts`: per-invocation transaction boundary, exact trusted serving context, current-company derivation and default denial of unmapped methods.
- `20261109100600_agent_capability_bindings.sql`: immutable shipped registry, exact version/action checks at final dispatch, no unknown/extension fallback, current-principal epoch lock function.
- `authority.ts` MCP adapter: stored connection/consent, current mandate bindings and validated audience; company-representative connection invocation unavailable without its owning proof.
- `tests/agent-modules/service-gate.test.ts`: real HTTP/service read and mutation refusals, unchanged resource privacy, immutable SQL manifest parity and unknown/audience denial.
- Owning plan, task, consultation and procurement API fixtures and backend crash suite install an explicit synthetic serving origin. This does not register a real installation or modify the task/consultation services.

Remaining: other participant service factories, public-read boundaries, the full revoker/race matrix and generic assistant/model quota integration. A manifest/action match alone must not authorize a model-selected provider/operation. Engine-owned local occurrence handlers remain the only implemented automated job handlers.


## Effect and protection-quota bindings

`agent_effect_handler` contains only code-installed exact module-version/capability/provider/operation tuples. The production migration installs no generic external effects. API proposals and final worker dispatch both check the tuple; prompt output cannot select a different handler. First-party-only capabilities return `first_party_required` before any generic intent, approval or hold. Synthetic order/channel handlers exist only in test maintenance fixtures. Original receipt reconciliation remains independent of fresh permission.

`20261109100700_agent_runtime_limits.sql` records immutable per-operation run/action usage for the deterministic occurrence handler. A single quota lock serializes all subscriptions for the same principal/module/hub. The current hub calendar defines the day, retries consume each measure once, and concurrent run limits count outstanding runs. These free protection limits do not grant billable capacity. Generic assistant/model accounting and quota integration remain separate.

The MCP lock port `agent_modules_lock_connection_consent` derives the current person, locks only that person's stored consent and its bound mandates, returns no private data and cannot be used by worker roles. The read role receives no UPDATE grants merely to obtain row locks.

The OPS-owned restore registry requires entries for `agents.start_occurrence` and `agents.execute_occurrence`, both transactional. The conductor report records the exact seam; restore source files were not modified.


## Execution and model integration continuation

- `execution-bindings.ts` and `apps/api/src/modules/execution/execution.module.ts` bind all seven execution service operations inside their existing transactions. Agreement-side classification calls the real `executionAgreements.side/get` ports; claim/dispute references are resolved under the principal RLS. Existing agreement, membership, mandate and projection authority remains mandatory.
- `task-bindings.ts` supplies explicit bindings for the existing task service, including mixed personal/company projections and structured delivery decisions. It does not replace fee or mandate ports. BILL-003 owns the production task/consultation factories in PR #501; the conductor must wire the adapter while preserving its exact fee constructor dependencies. A real-service test proves default missing-mandate denial. This is not production task parity.
- Fresh local unavailable-model conversation runs and manual goal reports now persist the same serving/session provenance as model and worker runs. Existing-operation recovery is checked before fresh admission.
- `model-governance.ts` contributes only stored run/hub and exact current capability authority to the mandatory model governance port. It sends no prompt to the SQL check. Model/role/source/retention/residency decisions still require an owning port; its default remains unavailable.
- `20261109100800_agent_model_authority.sql` wraps the merged foundation's shared fresh-authority helper, preserving its complete original implementation. Durable model begin, fallback and final admission therefore also enforce AGT inside their real transaction. Receipt/recovery functions are unchanged. No external adapter or permissive governance is installed.
- Model test fixtures install an exact synthetic research manifest and bind runs using the existing real test session and explicit synthetic origin. They do not register a production research capability or fabricate an authenticated worker.

Model tests cover wrong hub/run, unknown capability, action/context substitution, missing owning governance, both serving-withdrawal/admission orders and preservation of unknown financial holds. Generic model protection-quota integration and the remaining service/revoker matrix are still incomplete; this evidence does not complete LLM.

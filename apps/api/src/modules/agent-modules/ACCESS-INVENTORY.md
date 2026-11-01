# AGT-003 access and operation inventory

Agent: Codex CLI (OpenAI) for Parshkov

This inventory records the implemented owning services, exact shared-gate bindings and explicit unavailable boundaries. A manifest declaration is not evidence that the service calls `CapabilityAuthority`. The current continuation shares the AGT-001 private report projection with the leased occurrence worker. PR #406 is merged; shared authority integration continues on its preserved model recovery/accounting foundation. AGT-003 remains incomplete.

## Source ports implemented in this slice

| Source | Exact owning paths | Current authorizer and projection | AGT-003 adapter |
|---|---|---|---|
| Goal horizon | `apps/api/src/modules/assistant-goals/goals.service.ts`; `packages/data/src/repositories/agents.ts`; `packages/data/migrations/agents/20261102170000_agents.sql` | Goal and subscription principal RLS, current own-agent confirmed mandate, explicit goal context, matching personal/company scope, active confirmed goal | `goal-feed.ts` returns identifiers, horizon, resource revision and stored hub calendar version. No supplied person or calendar is accepted. |
| Goal progress | Same paths; `goal_progress` immutable evidence | Same owner RLS; evidence recorded after the subscription; current goal and mandate; exact goal or exact `agents.goal_progress` trigger | `goal-feed.ts` returns source identifiers only. A trigger writes an identifiers-only outbox event for new evidence; generated reports cannot recursively trigger work. |
| Pending goal deadlines | `packages/data/migrations/agent-modules/20261121100100_agent_occurrence_sources.sql`; `packages/data/src/repositories/agent-modules.ts` | Worker-only definer derives owner, mandate, goal contexts and hub from the stored subscription/request. It does not establish execution authority or a person session. | One row per subscription/resource/calendar revision and offset; elapsed offsets never catch up. Source rows are locked before invalidation. API callers cannot invoke the worker function; staff cannot read another person's rows. |
| Schedule/request readiness | `scheduler.ts`; `jobs.service.ts`; `packages/data/migrations/agent-modules/20261121100000_agent_modules.sql` | Existing first-party proposal confirmation and stored request/subscription; worker hub argument must exactly match stored hub | Readiness remains separate from a run. Stored legacy hub values are not yet proof of trusted serving provenance. |

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

Implemented read variants `listItemStates`, `listChanges`, `listShares`, `getLocation`, `listPermits`, `listDiary` bind explicitly to `project_planner.get_plan`. All 27 exported plan operations now enter explicit shared capability or first-party privacy boundaries inside the owning transaction through `plans.module.ts` and `plan-bindings.ts`. Version approval, return and change decisions retain their first-party handoff. Location does not establish execution hub attribution. Plan timeline/item schedules are potential project deadline resources, but no worker projection port has been implemented here.

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

## Historical foundation and current integration

The original five manifests declare 74 capability entries. The additional core manifest registers the existing goal/subscription operations from `packages/contracts/src/agents.ts`; the deterministic report binds `prepare` to `core.generate_goal_report`. The inventory above exposes missing method bindings rather than declaring parity complete. Existing agent and MCP adapter checks do not prove actual participant-service enforcement, and adapter tests do not prove MCP transport E2E.

Occurrence request/run provenance, the versioned deterministic report handler, leased entry points and paired registration are implemented and tested. The continuations below implement the owning service bindings, final callback revoker matrix and model governance callbacks against the merged recovery/accounting foundation. Missing model, role, source, retention or residency policy stays unavailable. Original-operation model recovery must remain independent of fresh-dispatch permission.


## Occurrence execution paths

| Path | Owning purpose and authority |
|---|---|
| `packages/data/migrations/agent-modules/20261121100300_agent_occurrence_runtime.sql` | AGT/AST occurrence ledger, immutable source signals, worker-only lease admission/final effect; request entry derives current owner and existing idempotency operation. No arbitrary principal parameter is granted to runtime roles. |
| `apps/worker/src/agent-modules/` and minimal `main.ts` registrations | REL paired source consumer/scheduler and transactional leased handlers. Loads without API runtime files. |
| `apps/api/src/modules/assistant-goals/goals.service.ts` | AGT-001 private deterministic report uses the same bounded owning projection as the worker. No communications/content/task/consultation service is edited. |
| `packages/contracts/src/agents.ts` | Registers the existing core capabilities and exact report action binding; no new standing action class. |
| `tests/agent-modules/execution.test.ts` | Real-role source-to-run tests, request replay, duplicate evidence, crash/restart, stale lease, policy/resource denial and staff isolation. |

The worker derives the goal from confirmed explicit contexts, uses the existing mandate coverage/member authority and screening hold ports, and rechecks the active policy and stop/switch epochs. The local private report is not a money or commitment effect. Unknown model/source/residency/retention rules remain unavailable through the merged model governance port; this runtime evidence does not complete LLM work.

## General assistant provenance and hub previews

`20261121100400_agent_execution_provenance.sql` adds immutable run/intent provenance, owner-only reads, stored-hub dispatch and explicit lease fencing. Fresh AST model admission binds a real session to the exact registered serving origin in the same transaction. The old accepted attempt/accounting body remains an internal helper; only the new worker boundary is granted. Original-operation receipt/reconciliation functions are unchanged. The API gate rejects caller-supplied other-person identifiers.

`20261121100500_agent_hub_previews.sql` records first-party mandate confirmations separately from signed JSON, resolves exact current-revision hub membership and uses stored connection audiences. Counts are scoped to the requested hub and require ten distinct principals per category. Unknown legacy attribution fails closed. Draft/activation both compare an opaque attribution digest, including changes hidden by count suppression. Tests create actual synthetic confirmation sessions, rather than copying mandate rows to manufacture authority.

## Service / adapter continuation

- `apps/api/src/modules/plans/plans.module.ts`: wraps the existing owning service with explicit capability bindings; no replacement plan authorizer or projection.
- `service-bindings.ts`, `service-authority.ts`, `plan-bindings.ts`: per-invocation transaction boundary, exact trusted serving context, current-company derivation and default denial of unmapped methods.
- `20261121100600_agent_capability_bindings.sql`: immutable shipped registry, exact version/action checks at final dispatch, no unknown/extension fallback, current-principal epoch lock function.
- `authority.ts` MCP adapter: stored connection/consent, current mandate bindings and validated audience; company-representative connection invocation unavailable without its owning proof.
- `tests/agent-modules/service-gate.test.ts`: real HTTP/service read and mutation refusals, unchanged resource privacy, immutable SQL manifest parity and unknown/audience denial.
- Owning plan, task, consultation and procurement API fixtures and backend crash suite install an explicit synthetic serving origin. This does not register a real installation or modify the task/consultation services.

Remaining: other participant service factories, public-read boundaries, the full revoker/race matrix and generic assistant/model quota integration. A manifest/action match alone must not authorize a model-selected provider/operation. Engine-owned local occurrence handlers remain the only implemented automated job handlers.


## Effect and protection-quota bindings

`agent_effect_handler` contains only code-installed exact module-version/capability/provider/operation tuples. The production migration installs no generic external effects. API proposals and final worker dispatch both check the tuple; prompt output cannot select a different handler. First-party-only capabilities return `first_party_required` before any generic intent, approval or hold. Synthetic order/channel handlers exist only in test maintenance fixtures. Original receipt reconciliation remains independent of fresh permission.

`20261121100700_agent_runtime_limits.sql` records immutable per-operation run/action usage for the deterministic occurrence handler. A single quota lock serializes all subscriptions for the same principal/module/hub. The current hub calendar defines the day, retries consume each measure once, and concurrent run limits count outstanding runs. These free protection limits do not grant billable capacity. Generic assistant/model accounting and quota integration remain separate.

The MCP lock port `agent_modules_lock_connection_consent` derives the current person, locks only that person's stored consent and its bound mandates, returns no private data and cannot be used by worker roles. The read role receives no UPDATE grants merely to obtain row locks.

The OPS-owned restore registry requires entries for `agents.start_occurrence` and `agents.execute_occurrence`, both transactional. The conductor report records the exact seam; restore source files were not modified.


## Execution and model integration continuation

- `execution-bindings.ts` and `apps/api/src/modules/execution/execution.module.ts` bind all seven execution service operations inside their existing transactions. Agreement-side classification calls the real `executionAgreements.side/get` ports; claim/dispute references are resolved under the principal RLS. Existing agreement, membership, mandate and projection authority remains mandatory.
- `task-bindings.ts` supplies explicit bindings for the existing task service, including mixed personal/company projections and structured delivery decisions. It does not replace fee or mandate ports. BILL-003 owns the production task/consultation factories in PR #501; the conductor must wire the adapter while preserving its exact fee constructor dependencies. A real-service test proves default missing-mandate denial. This is not production task parity.
- Fresh local unavailable-model conversation runs and manual goal reports now persist the same serving/session provenance as model and worker runs. Existing-operation recovery is checked before fresh admission.
- `model-governance.ts` contributes only stored run/hub and exact current capability authority to the mandatory model governance port. It sends no prompt to the SQL check. Model/role/source/retention/residency decisions still require an owning port; its default remains unavailable.
- `20261121100800_agent_model_authority.sql` wraps the merged foundation's shared fresh-authority helper, preserving its complete original implementation. Durable model begin, fallback and final admission therefore also enforce AGT inside their real transaction. Receipt/recovery functions are unchanged. No external adapter or permissive governance is installed.
- Model test fixtures install an exact synthetic research manifest and bind runs using the existing real test session and explicit synthetic origin. They do not register a production research capability or fabricate an authenticated worker.

Model tests cover wrong hub/run, unknown capability, action/context substitution, missing owning governance, both serving-withdrawal/admission orders and preservation of unknown financial holds. Generic model protection-quota integration and the remaining service/revoker matrix are still incomplete; this evidence does not complete LLM.

## Profile, reputation and core service continuation

All exported methods of `ProfilesService`, `ReputationService` and `GoalsService` now have exhaustive, compiler-checked bindings in `profile-bindings.ts`, `reputation-bindings.ts` and `core-bindings.ts`. The same configured authority object and its entitlement/extension ports reach Plans, Execution, Profiles, Reputation and Goals through the owning module factories. Each invocation still runs inside the owning principal transaction. Unknown methods fail closed; there is no prefix fallback or alternate authorizer.

Profile read variants use `get_my_profile`; experience archival uses `update_experience`; private bookmarks, follows and reading-progress writes use `apply_profile_edit` and retain the owning `maintain_profile` mandate check. These are explicit operation aliases, not new capabilities or private event feeds. Onboarding preferences are a first-party identity boundary. Consent inspection, grants/withdrawal, visibility, media licensing and portrait governance retain the owning human-only authority independently of purchased availability.

Reputation bindings resolve the acting party from the owning input or RLS-projected credential/request. An unauthorized company input does not manufacture company authority: the original service returns its not-found response. Reputation has no implemented delegated mutation authorizer, so those mutations refuse delegated principals. Confirmation answers, conflict declarations, withdrawal and appeal paths are first-party controls and cannot be sold or disabled through plans. No fee, score, legal policy, source or publication implementation is changed.

Core goal and report reads/mutations use exact core capabilities. Mixed personal/company lists intersect both scopes. Confirmation, pause/closure, subscription inspection/stops, report disclosure and escalation decisions stay with the person's owning controls. Re-enabling a subscription or resolving a decision is never fresh execution permission. Identity recovery and assistant stop/mandate-revocation services remain separate mandatory authority boundaries, not purchasable agent modules. Negotiation and representative operations are now explicit engine manifests with exhaustive owning-factory bindings. Newly explicit modules are not default-enabled; existing hub policy must activate negotiation. Representative authority controls remain non-purchasable first-party boundaries. No new remote execution implementation is declared.

Anonymous profile, company-people and reputation projections retain their existing consent serializers and public visibility. A narrow boolean `agent_modules_public_serving_context` resolves an explicit server origin and holds node/hub epochs through the owning read. It never sets a person, accepts a supplied hub, reads party data or grants table access. Serving withdrawal and public reads are tested in both serialization orders. First-party/public capability availability explicitly identifies its non-purchasable boundary; it never permits generic effect execution or a human-only MCP action.

The MCP adapter now requires a presented-token hash, validated audience and proof binding from its authenticating transport. Its narrow SQL port rechecks the live token/family, original authorization-code scopes and current consent; the supplied connection can only narrow that intersection. Missing, narrowed, unknown and wrong-proof tokens refuse. Stored token/family locks survive through the invoking transaction; an access-token revoke race is tested in both orders. No connection snapshot can add a mandate or broaden token scope. Context authorization is still the owning service's obligation, and actual MCP transport acceptance remains MCP-001/003.

`tests/agent-modules/domain-service-parity.test.ts` exercises real Profile/Reputation/Core reads and mutations under module, capability, participant and free-plan disables, shared agent/MCP-adapter refusals, actual HTTP behavior, mandatory consent/stop access, raw-role isolation and public/token revocation races. Other final-dispatch revokers, generic AST/model quotas, immutable executable-provider binding and Task/Consultation factories remain open. The authorized OPS-003 seam is now implemented: exactly two transactional occurrence registry entries, with its 12-test focused suite passing. No other restore source was changed.

## Post-BILL501 owning factory integration

`TasksModule` and `ConsultationsModule` now bind every exported service method through the same per-invocation transaction seam. BILL501's actual fee adapters, constructor ports, guards and immutable agreement terms are preserved; the subsequently allocated21100980 compatibility port recognizes only exact immutable legacy source captures. `CONSULTATION_MANIFEST` was already shipped by CONS-001 but omitted from the AGT engine registry; it is now included with an identical SQL manifest in migration `20261121100930_agent_consultation_manifest.sql`. No unknown consultation operation is implicitly allowed.

Task and consultation scopes resolve the current participating company from owning RLS rows and the current membership; a supplied offeror or resource identifier cannot introduce another caller identity. Owning authorization still decides whether a request, offering, agreement, booking or deliverable is accessible. Public offerings and explicitly published deliverables are named public-projection boundaries; their owning public serializers require the exact trusted serving registration and never invent an anonymous participant. All other Consultation methods name their existing capability, including reads, calendar export, mentoring and human-only decisions. Delegated mandate checks remain in CONS-001/TASK-001 and do not inherit consent from capability availability.


## Bound callback and shared protection admission continuation

Migration `20261121100910_agent_dispatch_limits.sql` extends the existing quota port to actual AST and model admission. Run usage is keyed by the immutable run; model action usage is keyed by its original mandate-use identity, including zero-cost calls without a financial reservation; the accepted model schema still permits one model operation per run. The same principal/module/hub lock serializes both measures. A nested SQL savepoint rolls back both usage measures and one-use admission on denial. Unknown invoked model calls and unresolved action intents retain occupied capacity after outer-run cancellation; only original terminal evidence frees that capacity. Immutable daily usage does not disappear when a hold settles. No money or token units are added to run/action units.

`20261121100920_agent_effect_implementations.sql` adds immutable executable declarations and per-attempt pins. `implementations.ts` captures code-owned submit/lookup methods and a payload projector at worker composition; exact module/version/capability/provider/operation, mandate action, contexts, data classes, egress and payload-contract identity must match. Equal names alone cannot select code. No production implementation or external egress is installed. Legacy unpinned attempts cannot be recovered by asking a newly selected provider to prove absence. Original pinned recovery remains receipt-only.

`20261121100940_agent_effect_authority.sql` pins owning person/company authorization epochs without fabricating sessions or granting resource access. The final callback boundary retains current AGT epochs, owning person/company epochs, original session, mandate, run, approval and existing budget/reservation authority through the local code callback. Admission is committed before that transaction, preserving crash identity. A revoker that commits first prevents a callback; withdrawal between admission and callback preserves the original attempt and hold for receipt recovery. Worker roles still cannot read party tables or call internal helpers.

The focused callback matrix tests both lock orders against actual handler calls for serving withdrawal, module kill, session withdrawal, mandate revocation, run cancellation, resource-participation revocation and budget closure. The original AST crash, lease-loss, concurrency, unknown-outcome and private-constraint tests remain. Model admission tests cover concurrent capacity, crash rollback, daily-action rollback, outer cancellation and exact receipt release. The additional allocated model/KEYS callback seam below holds the actual owning writer fence and explicit synthetic source policy. Missing operational source/model/retention/residency authority still refuses; this is not standalone LLM acceptance.

Inert job requests now explicitly report `executionAvailability=implementation_unavailable` and the existing locale refusal key. This does not change their historical proposal/confirmation records into executable templates. The deterministic private-report handler and all five source triggers remain available only through their existing proven bindings.


## Current invocation and callback boundary

`20261121100950_agent_invocation_authority.sql` locks only the authenticated caller's current person, active membership/company epoch and real session. All nine governed service factories apply it inside their existing transaction after shared capability admission; mandatory first-party controls apply the identity check without commercial gating. The existing principal refresh path handles changed role/company epochs. Session withdrawal returns the normal authentication refusal. Public projections continue without a fabricated person. Tests exercise the actual company reputation read and mutation with stale cached roles, both role-revocation orders, cached revoked-session reads/controls and raw foreign-session denial. No identity service or PROV publication source is modified.

`20261121100960_agent_model_callback.sql` extends only the original admitted fake model operation with an AGT/AST/BILL callback transaction. It reuses `assistant_model_check`, locks the real session/person/current company, mandate/run and budget/reservation, and retains original dispatch identity across callback-transaction crashes. `ModelCallStore.withDispatchAuthority` holds this boundary around the actual adapter invocation. Tests cover both orders for serving, mandate, run and budget; session withdrawal, original receipt recovery after a callback crash and preserved unknown holds. This is not standalone LLM completion and does not supply a mutable source/model/egress policy implementation.

The exact deferred-MCP boundary is unavailable: `connection_call` stores a token family but no original access-token/proof reference suitable for the deferred callback. Such intents return `connection_dispatch_authority_unavailable` without invoking code. A supplied connection snapshot or another token in the family cannot fill that gap. Immediate MCP service adapters retain their stored-token/consent transaction; the deferred transport binding belongs to MCP-003. Original historical receipt recovery is not disabled.

The actual effect matrix additionally covers human approval withdrawal, current company role, every shipped module/capability/participant/free-plan policy switch, node/hub/module/capability/action kill switches and personal stop. Expiry and stale-fence checks remain in the original suites. An actual AST quota test proves that cancelled unknown outcomes still occupy capacity and daily-action denial rolls back its prior run reservation. Unknown original operations, immutable terms and all five durable trigger paths remain intact.

The allocated callback contracts now require owning source/version policy and serialize KEYS route/egress/connection writers through the fake invocation. Operational source-policy implementations and provider activation remain separately owned and unavailable; the fake-only tests do not fabricate MODEL-001 catalogue data. The deferred MCP proof binding remains an explicit unsupported transport path, while immediate service/agent/MCP adapter equality is tested here.

## Allocated internal BILL callback fence

Conductor allocated BILL-001 (#2) migration `20261121100935_billing_effect_authority.sql`. `billing_lock_effect_authority(reservation, budget)` is invoker-only, has no app/worker EXECUTE grant, returns only a boolean and changes no financial state. Authorized AGT/AST definer commands call it after checking original provenance. It locks the original budget before its reservation and rechecks budget and finite-reservation expiry after both waits. An unknown effect retains its original pending hold. AGT migrations no longer read financial tables directly; payment-neutrality rules are unchanged. Raw-role denial, mismatched binding, both budget-close orders, expiry during reservation waits and unresolved holds have focused tests; actual handler/model receipt recovery remains separately tested.

The authenticated service person fence uses `FOR NO KEY UPDATE`: it conflicts with identity-epoch revocation and owning profile writes but permits the existing nested mandate command's immutable person foreign-key check. The real consultation confirmation/unknown/revoked-mandate regression covers this interaction; no mandate or financial authority is invented.


### Allocated model/KEYS callback seam

The model gateway requires immutable source bindings and owning authority callbacks. The final route check runs in the exact original-operation transaction through an internal AsyncLocalStorage seam, with no caller identity/hub input. Migration21100970 adds the KEYS statement fence and preserves original writer bodies behind entrypoint wrappers; app/worker cannot call the unfenced implementations or internal callback port. Exact wrapper signatures are registered in `tests/data/access/modules/providers.ts`; the renamed AGT owning helper is internal in the AGT inventory. Missing real source/model policy remains unavailable. `tests/models/keys-callback.test.ts` covers real writer ordering, source-policy test fakes, post-wait expiry and original receipts after withdrawal.


### Exact historical fee compatibility

Allocated BILL-003/TASK-001/CONS-001 migration21100980 exposes a minimal app-only `billing_task_legacy_proceeds` owning port. It locks the original agreement and immutable offer/request, verifies current seller authority and exact captured kind/ID/digest, and returns only original price for private-floor checks. No caller price, timestamp, absence of fee origin or chosen hub grants exemption. Explicit fee confirmations still use the unchanged versioned path. The consultation confirmation wrapper preserves original stored pricing/commission only for its exact capture and authorized current side; its renamed versioned implementation loses direct runtime grants. Neither port creates fees or edits the capture. Current actual factories, fresh backdated/unbound refusals, source-kind/digest/company negatives, concurrent confirmation and raw immutability denial are covered by the strict-prefix historical upgrade test. Its explicitly pre-upgrade owning construction cannot run after migration; no production bypass was introduced.


## AGT-001 registry tail and merged PRV privacy boundaries

Nine shipped manifests now include every existing live AGT-001 capability: seven negotiation entries and eleven representative entries are assembled from their original code-owned objects. SQL21100990 stores those exact manifests. Both TypeScript and SQL defaults refuse negotiation/representative module activation; the normal validated hub draft, preview and second-person activation are required. No action, transport, effect provider, data class or model is introduced.

`negotiation-bindings.ts` binds all four exported EnvelopesService methods. Structured intent selects exactly negotiate/message/schedule/introduce. The current RLS-visible original mandate determines personal/company scope; the exact stored company mandate and representative/accountable person determine representative scope. Reads use their specific existing list/get capabilities. Actual delivery resolves the trusted server origin and the SQL wrapper requires matching immutable mandate revision/digest/serving provenance. Unknown historical provenance, arbitrary hub, stopped representative and disabled capabilities refuse. The original owning SQL command still checks receiver participation, immutable references, budgets, human decisions, turns, expiry, receipts and private projections.

`representative-bindings.ts` binds all eleven exported methods to current first-party authority controls. Inspection, confirmation, suspension and revocation survive disabled modules/plans. Existing company permissions, accountable-person acceptance, step-up and separation rules remain. A narrow transaction ordering fence serializes local envelope delivery and the existing representative/company-mandate command entrypoints before their original row/epoch locks; it grants no authority. Renamed owning implementations are internal with runtime EXECUTE revoked. `tests/data/access/modules/agent-modules.ts` inventories these exact internal definers. No global party table grant or session impersonation is added.

ADR013 governance remains first-party handoff-only: the invocation adapter refuses it. Declared representative MCP reads retain their original read metadata but remain explicitly unavailable because the strict summary projector has not shipped. The full first-party page, accountability history and company mandates are never forwarded as that summary. Stored token/consent/owner/audience checks precede the refusal; snapshots cannot turn this boundary into a private read.

Merged PRV exports `PlansService.privacyShared`, `TasksService.privacyExport`, and `ConsultationsService.privacyInventory` have explicit non-purchasable first-party bindings. Their owning subject/RLS/projection and snapshot transaction semantics remain unchanged; no PRV exporter is modified. Actual tests cover own export under disabled policy and foreign-subject refusal.

`negotiation-parity.test.ts` exercises every negotiation capability through actual service operations, four disable dimensions and shared agent/stored-token refusals; real delivery and private projections; raw internal-command denial; both representative/company-mandate revocation orders; token withdrawal; rollback before local delivery/withdrawal commits; and legacy unknown refusal. Original AGT-001 negative/concurrency suites remain. Policy tests explicitly distinguish nine people/eighteen mandates (suppressed) from ten people/nineteen mandates (publishable), preserving exact all-hub isolation and current-source invalidation.

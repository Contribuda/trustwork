# AGT-003 access and operation inventory

Agent: Codex CLI (OpenAI) for Parshkov

This inventory describes implemented owning services and the remaining shared-gate integration. A manifest declaration is not evidence that the service calls `CapabilityAuthority`. In this continuation, no owning domain service below has been modified. Shared AST/model integration is sequenced after PR #406 merges; AGT-003 remains incomplete.

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

Additional implemented reads `listItemStates`, `listChanges`, `listShares`, `getLocation`, `listPermits`, `listDiary` need an explicit binding, not silent omission. Version approval, return and change decisions retain their first-party handoff. Location does not establish execution hub attribution. Plan timeline/item schedules are potential project deadline resources, but no worker projection port has been implemented here.

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

The five loaded manifests declare 74 capability entries. Core goal/subscription operations are separately declared in `packages/contracts/src/agents.ts`; they are not presently an engine manifest in `ports.ts`. The inventory above exposes missing method bindings rather than declaring parity complete. Existing agent and MCP adapter checks do not prove actual participant-service enforcement, and adapter tests do not prove MCP transport E2E.

The shared implementation still needs immutable trusted hub provenance, per-hub distinct-principal cohort counts, final-dispatch epoch/lock checks, engine-versioned supported template handlers, a leased occurrence-to-run entry point, and paired consumer/scheduler registration. The model governance port must be derived from real owning policy ports after the reviewed recovery/accounting foundation lands. Missing model, role, source, retention or residency policy stays unavailable. Original-operation model recovery must remain independent of fresh-dispatch permission.

# Tasks module: scoped tasks from plan items (TASK-001)

The flagship journey "from plan to people" ([Projects](../../../../../docs/engine/projects.md#consultations-and-tasks-from-plan-items-proposed), [agent catalogue: task marketplace](../../../../../docs/engine/agent-catalog.md#task-marketplace), [data model section 8](../../../../../docs/data/model.md#8-consultations-tasks-and-mentoring)). A homeowner's or small owner's approved plan item (kind `task` or `phase`) becomes a **task request** to contractors and trades (ADR 012 decision 37: inside companies every purchase starts as a requisition, so a company-owned project gets `422 requisition_required`). Contracts: [`tasks.ts`](../../../../../packages/contracts/src/tasks.ts). Storage: [`packages/data/migrations/tasks`](../../../../../packages/data/migrations/tasks), [`packages/data/src/repositories/tasks.ts`](../../../../../packages/data/src/repositories/tasks.ts).

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key`. Every action completes its idempotency record inside its own request transaction (BE-005, `in_transaction` in `apps/api/src/common/idempotency/routes.ts`) and is crash-tested in `tests/backend/idempotency/crash.test.ts`. Errors use the contract envelope; specific reasons are in `details.reason`.

## The commercial kernel, reused

| Task object | Kernel counterpart | Shared rule |
|---|---|---|
| `task_request` | `rfq` | owner-side envelope, `draft -> published -> closed / cancelled` |
| `task_request_version` | `rfq_version` | immutable once published, `trustwork-digest-1` over `{ taskRequestId, version, payload }`; an amendment flags earlier offers `request_amended` in the same transaction |
| `task_offer` (one row per version) | `quote_version` | pinned to the current published request version by id and digest; frozen once sent (`reject_update_when_frozen`, every role); digest over `{ taskRequestId, requestVersion, offeror, version, payload }` |
| `task_offer_private` / `task_request_private` | `quote_private_constraint` / `rfq_private_constraint` | floor and notes of the offeror; ceiling and notes of the owner; each readable only by its side |
| `agreement` with `terms_kind = task` | COM-002 `agreement` | `offer_ref_id` = offer version, `request_ref_id` = request version; digest `{ termsKind: 'task', quoteVersion: offer, rfqVersion: request version }`; two acceptance events with the same digest |
| `task_assignment` | order and obligations | created only by the offeror's confirmation; repeats the agreement id and digest, the offer and request versions, the plan item (project, plan, approved plan version, key) and the offer's milestones |
| `task_execution_record` | execution evidence | a delivery claim is asserted until the owner accepts or rejects it in person |

The data model's statement in the agent catalogue that "a task is an RFQ whose lines come from the plan item" is realised as this one-to-one mapping onto separate tables (the COM-002 agreement already reserved `offer_ref_id` and `request_ref_id` for it), so the brief can be built field by field from the plan item and the consumer flow needs no line-level quote machinery.

## Routes

| Route | Who | Result |
|---|---|---|
| `POST /v1/task-requests` | The person owning the project | A draft request cut from an item of the approved plan; the brief is built by `buildTaskRequestPayload` from exactly the chosen fields (`scope`, `trade`, `locality`, `drawings`, `quantities`, `schedule`, `budget_range`; never the address or contact); milestone anchors are the item or steps below it. The plan item records the path `task` (a second path is refused) |
| `GET /v1/task-requests`, `GET /v1/task-requests/:id` | Owner: `OwnerTaskRequestView` (versions, private half, invitations, sent offers newest first, agreements). Invitee or offeror: `OfferorTaskRequestView` (published versions and its own invitation only). Others `404` |
| `GET /v1/task-requests/open` | Signed-in people | The open board: published open requests of others, payment-blind newest first, with only their public picks |
| `POST /v1/task-requests/:id/draft`, `/publish`, `/private`, `/invitations`, `/cancel` | Owner | Saves the draft (or opens the amendment draft), publishes (refused while an acceptance is pending or agreed; the first publication moves the plan item to `requested`), saves the private half (audit names the change, never values), invites a person or company, cancels |
| `POST /v1/task-offers`, `POST /v1/task-offers/:id`, `/send`, `/withdraw`; `GET /v1/task-offers`, `GET /v1/task-offers/:id` | Offeror (the person, or members of the company with `company.deals.manage`) | Drafts version 1 or the next version pinned to the current request version (an invited request takes offers from invited parties only, `403 not_invited`); saves the draft; sends (supersedes the previous sent version); withdraws (not while an agreement on it is live). The desk is the offeror's only: the owner gets `404` and reads sent offers in its request view |
| `POST /v1/task-requests/:id/acceptances` | Owner | Accepts the exact offer version against the current request version by id and digest, with consent to electronic records; both stored digests are recomputed; one live agreement per request (request row lock plus the database guard), so concurrent acceptances get `409` |
| `POST /v1/task-agreements/:id/confirm`, `/decline` | Offeror | Confirm states the digest it accepts (`409 commercial.digest_mismatch` otherwise); in one transaction: agreement `accepted_by_both`, offer `accepted`, obligations per milestone, the assignment, the request `closed` and remaining offers flagged `request_closed`. Decline withdraws the offer |
| `POST /v1/task-agreements/:id/withdraw` | Owner | Withdraws a pending acceptance |
| `GET /v1/task-assignments`, `GET /v1/task-assignments/:id` | The two parties | `TaskAssignmentView` with the agreement, milestone states, records, reviews and the site (address, contact, access notes), which reaches the assignee only now |
| `POST /v1/task-assignments/:id/records` | Assignee claims (`record_evidence` for an agent); owner accepts or rejects in person | When every milestone is accepted the assignment is `accepted` (completed) and the plan item `done` |
| `POST /v1/task-assignments/:id/reviews` | Either party, once | Allowed only for completed tasks (`422 review_not_allowed`; the database repeats it) |

## Agents, money and privacy

Commands accept `actor: { via: 'agent', mandateId }`: drafts need `prepare`, publishing and cancelling `publish`, invitations `communicate`, sending and withdrawing offers `send_quote`, acceptance and its withdrawal `place_order`, confirmation and decline `accept_order`, delivery claims `record_evidence`. The `TaskMandatePort` decides (money actions pass the price); the default `NoTaskMandates` refuses every agent request (`403 access.mandate_scope`) until the mandate store exists. An agent never accepts above the owner's private ceiling or sends or confirms below the offeror's floor (`details.reason = outside_private_constraints`, never the value). Accepting delivered work and reviews have no actor field: the person decides. Registry entries: `TASK_MARKETPLACE_MANIFEST` (module `task_marketplace`, ADR 010 decision 23).

No money moves: obligations record that the owner pays each milestone outside the platform or through a licensed provider (ADR 010 decision 20); placing a budget-reserved order for a task follows with payments (PAY-001). Nothing here reads a billing table; every list a party sees is ordered by time and id only (`paymentBlindOrder`, equality test with entitlements and sponsorship). Outbox events carry identifiers only (`TASK_EVENT_PAYLOAD_KEYS`); notifications (MAIL-001) read projections under the recipient's authority. COM-002 agreement routes (`/v1/agreements`) list and read `rfq_quote` agreements only.

## Tests

`tests/contracts/tasks.test.ts` (brief allowlist, offer rules, digest binding, acceptance check, milestones, obligations, payment-blind order, registry), `tests/tasks/database.test.ts` (FORCE RLS isolation, frozen offers for every role, forged staleness, agreement and assignment guards, site definer, human-only decisions, reviews), `tests/tasks/api.test.ts` (the journey through HTTP with negative authorization, competitor isolation, amendments, concurrent acceptances and confirmations, agents, outbox and payment equality).

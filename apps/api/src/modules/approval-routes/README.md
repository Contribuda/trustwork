# Approval routes: routes, decisions and delegation (PRC-001)

A company's own versioned rules for who approves what ([Procurement and supply, "Approval routes"](../../../../../docs/engine/procurement-and-supply.md#approval-routes), [data model section 18a](../../../../../docs/data/model.md#18a-procurement-and-supply), [lifecycles](../../../../../docs/data/lifecycles.md#procurement-and-supply)). Contracts: the frozen supply contracts [`approvals.ts`](../../../../../packages/contracts/src/supply/approvals.ts) and [`commands.ts`](../../../../../packages/contracts/src/supply/commands.ts) (PRC-000). Storage: [`packages/data/migrations/approval-routes`](../../../../../packages/data/migrations/approval-routes), [`packages/data/src/repositories/approval-routes.ts`](../../../../../packages/data/src/repositories/approval-routes.ts).

Status: Live in the API with no interface yet (WEB-011). Nothing here holds or moves money: an approval is a recorded human decision that a subject module (requisitions, awards, orders, trade invoices, payment proposals, ...) reads before it acts; payments stay with licensed providers.

## Rules the module enforces

| Rule | Where |
|---|---|
| Routes are drafted and activated by members holding `procurement.routes.manage` (company administrators hold every procurement permission; other members through a live `permission_grant` scoped to the company, granted by an administrator or a member manager) | `approval_draft_route`, `approval_activate_route` |
| One active version per company and subject kind; payload and digest freeze once the version leaves draft; activation restates the reviewed digest, needs the person's own session and a recent authentication; a hub may require a second person (`routeActivationSecondPerson`) | Route trigger, `approval_activate_route`, `@Authenticated('step_up')` |
| A request binds the exact subject version id and `trustwork-digest-1`; one pending request per subject; a new version supersedes it (`approval_submit`, `approval_supersede`) | `port.ts`, request trigger |
| Conditions are structured and fail closed (unknown or foreign amounts make an amount condition hold); a subject with no applicable step, or a step whose quorum people other than the requester cannot reach, is refused at submission | `resolution.ts`, `approval_submit` |
| Approver selectors (permission holders in the company or the project, a named person, the project leader, "any of" with a quorum) are resolved at the moment of the decision against active memberships | `approval_selector_matches` |
| A pending step past its timeout goes to its escalation target (`next_selector` or the route owner); a second timeout expires the request. Nothing is approved by silence | `approval_effective_selector`, `approval_escalate_request`, worker sweep `approval_escalate_due` |
| Deciding is the human-only verb `approve`: a person in their own first-party session (the page or the assistant overlay); an agent actor is refused whatever its mandate; no mandate, connection or extension column exists; the worker role has no grant; approving an amount needs a recent authentication | `ApprovalRoutesService.decide`, `approval_first_party_session`, `approval_decide` |
| Segregation of duties, not switchable by a route: the requester never decides (no exception, also not through a delegation); the payee changer never approves a payment to that payee; the payee verifier, the receipt recorder above the route threshold and the proposal preparer never approve alone. For the "alone" rules a company with exactly one eligible approver gets an audit flag (`sodFlag`) instead of a silent bypass | `approval_sod_check`, decision trigger |
| Delegation: to another active member of the same company, for chosen subject kinds, optionally up to a limit, at most 90 days, revocable and audited; it counts only while the delegator is selected for the step, both memberships are active and the window is open; one vote per delegator and step; no re-delegation | `approval_authority`, `approval_delegate`, `approval_revoke_delegation` |
| Concurrent decisions on one step resolve once: the request row lock serialises them and the loser sees a new revision or a decided step | `approval_decide` |
| Existence never leaks: who may not read a request (requester, deciders, people a step selects now directly or as a delegate, administrators and route managers) gets `404` | `approval_request_visible`, row-level security |

## Routes

All routes need a session; mutations carry CSRF metadata and an `Idempotency-Key` (the frozen commands also carry it in the body; both must match) and complete in their request transaction (`in_transaction`, crash-tested in `tests/backend/idempotency/cases/approval-routes.ts`).

| Route | Result |
|---|---|
| `GET /v1/approvals/templates` | Engine templates (`owner_approves`, `project_manager_then_director`); hub templates arrive with HUBC-011 |
| `GET /v1/approvals/routes[?subjectKind=]`, `GET /v1/approvals/routes/:id` | The company's route versions (every active member reads them) |
| `POST /v1/approvals/routes` | `DraftApprovalRouteCommand` (+ `actor`): a new draft version with its digest; an agent drafts under a `prepare` mandate |
| `POST /v1/approvals/routes/:id/activate` | `ActivateApprovalRouteCommand`: human-only, step-up, restates the digest; supersedes the previous active version |
| `GET /v1/approvals/requests[?status=&mine=&limit=]` | Requests the person may read |
| `GET /v1/approvals/requests/waiting` | "Your decision is needed": pending steps the person may decide now, directly or as a delegate |
| `GET /v1/approvals/requests/:id` | The decision card: request, steps, decisions (with `sodFlag`), the viewer's options per pending step and whether approving needs step-up |
| `POST /v1/approvals/requests/:id/decide` | `DecideApprovalCommand`: approve, reject (reason) or return (reason) one step; human-only |
| `POST /v1/approvals/requests/:id/withdraw` | The requester withdraws a pending request (agent: `maintain_records`) |
| `GET /v1/approvals/delegations`, `POST /v1/approvals/delegations`, `POST /v1/approvals/delegations/:id/revoke` | Delegations given and received; create (`DelegateApprovalsCommand` plus an optional `limit`) and revoke with a reason (agent: `maintain_records`) |

Refusals use the contract codes: `access.forbidden` (`details.reason`: `requester_cannot_decide`, `not_an_approver`, `delegation_exceeds_rights`, `first_party_required`, `not_authorised`), `access.second_approver_required` (`sod_violation` with `details.rule`, or `second_person_required`), `access.approval_digest_mismatch`, `auth.step_up_required`, `access.mandate_scope` (`human_only`), `validation.revision_conflict`, `validation.schema` and `access.not_found` (`errors.ts`).

## Ports

- `port.ts`: `submitForApproval(trx, input, now)` and `supersedePendingApprovals(trx, input, now)`, called by subject modules in their own transaction as the requester. Outcomes arrive as outbox events `approval.request_submitted`, `approval.step_escalated` and `approval.request_closed` (identifiers only).
- `mandates.ts`: `ApprovalMandatePort` for the agent-reachable commands; `app.module.ts` wires the AST-001 mandate store with module key `procurement`.
- `capabilities.ts`: the capability registry entry each route serves (PRC-000 entries) and the entries proposed for PRC-023 (lists, withdrawal, revocation).

## Follow-ups

- Worker job running `approvalSweep.escalateDue` on a schedule (the database function and repository exist; decisions already apply escalation and expiry lazily, and reads evaluate the effective selector).
- Registry entries of `PROPOSED_APPROVAL_CAPABILITIES` (PRC-023); hub route templates and the console (HUBC-011); the web screens (WEB-011).

## Tests

`tests/approval-routes/policy.test.ts` (conditions, templates, route digest, no mandate, extension or connection decides), `database.test.ts` (runtime role: routes, binding and supersession, requester and delegation rules, SoD, steps, escalation and expiry, first-party decisions, visibility, concurrent decisions), `api.test.ts` (HTTP journey, step-up, agents, second person).

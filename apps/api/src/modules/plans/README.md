# Plans module (PLAN-001)

Project plans for the flagship journey "plan to people" ([ADR 010](../../../../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decision 17; [ADR 012](../../../../../docs/adr/012-integrator-decisions-2026-10-31.md) decisions 13, 14, 23 and 37). Contracts: [`packages/contracts/src/plans.ts`](../../../../../packages/contracts/src/plans.ts). Storage: [`packages/data/migrations/plans`](../../../../../packages/data/migrations/plans), [`packages/data/src/repositories/plans.ts`](../../../../../packages/data/src/repositories/plans.ts). Narrative: [Projects](../../../../../docs/engine/projects.md#plans-from-plan-to-people).

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key` (the BE-001 interceptor; BE-005's in-transaction completion is not merged yet). Errors use the contract envelope; plan-specific reasons are in `details.reason`.

## Who may do what

The project is the authorization anchor. **Owner side** = the policy allows the capability with the `owner_private` projection: the owner person, members of the owner company holding `company.deals.manage` (`company.publish` for public shares), or a project participation with audience `owner_private` carrying the capability.

| Operation | Capability | Others get |
|---|---|---|
| Read the plan, versions, changes, timing facts, shares, states, licensing, location, permits | `read.owner_private` | `404` |
| Create the plan, open, edit and propose drafts, record changes, item states, location, permits, diary | `write.draft` | `404` without owner-side read, `403` with it |
| Approve or return a version, approve or reject a change | `accept` (owner act) | `403` / `404` |
| Share an item with an invitee / on the public needs board | `invite` / `publish` | `403` / `404` |
| Read the invited view (`GET .../plan`, `GET .../plan/shared`) | a live share addressed to the person or to their employer (members with `company.deals.manage`) | `404` |

Anonymous callers get `404` for every plan read. The database repeats every rule under FORCE RLS (`trustwork.plan_project_can`), so a bug in this layer cannot widen access.

## Routes (`/v1/projects/:id/plan`)

| Route | Result |
|---|---|
| `GET` | Owner side: `OwnerPlanView` (plan, every version summary, the approved, proposed and draft versions). Invitee: `InvitedPlanView`. Otherwise `404` |
| `POST` | Creates the plan with draft version 1 (`CreatePlanCommand`); a second plan is `409` |
| `POST versions` | Opens the one draft, copying `basedOnVersionId` or the approved baseline; a second open draft is `409` |
| `GET versions/:versionId` | One version with its full content; every version is kept for ever |
| `POST versions/:versionId/content` | Replaces a draft's content with `expectedRevision` (two editors: one wins, the other `409 validation.revision_conflict`); a proposed or approved version is `409 commercial.version_immutable` |
| `POST versions/:versionId/propose` | Freezes the draft: items and dependencies materialised, digest recorded, an earlier proposal superseded (`replaced`) |
| `POST versions/:versionId/approve` | `{ expectedRevision, digest }`: the digest the owner saw (`409 commercial.digest_mismatch` otherwise). No actor field: an agent cannot express an approval. The previous baseline is superseded (`replaced`) and kept |
| `POST versions/:versionId/return` | The proposal stays frozen (`superseded`, `returned`); its content continues as the open draft |
| `GET items/states`, `POST items/:itemKey/state` | Execution state beside the frozen version; an item records one path (`task`, `rfq`, `requisition`, `consultation`, `self`) and never takes another (`409`, `details.reason = item_path_taken`); `requested` needs a matching link |
| `GET changes`, `POST changes`, `POST changes/:changeId/decide` | Plan changes (reason, cause, requested by, accountable, agreement). Approving a change approves its target version in the same transaction; a change is never rewritten |
| `GET timing` | `PlanTimingFact` per approved change for EXE-001: both version numbers and the attribution (`client`, `counterparty`, `neutral`, `unattributed`) |
| `POST shares/preview` | The projection a share would reveal and its digest, with the notice that forwarded copies leave the platform |
| `POST shares` | Shares one item of the approved baseline with one audience and exactly the listed fields; the request carries the preview digest the owner confirmed |
| `GET shares`, `POST shares/:shareId/revoke` | Owner side; revocation is immediate and final |
| `GET shared` | The invited view only |
| `GET licensing` | Which steps may need a licensed professional in the project's region, from `data/taxonomy/jurisdictions/<PACK>.json` and the country pack; `unknown` where the hub has no answer |

Beside the plan (`/v1/projects/:id`): `GET/POST location` (owner-private site location; restricted places refused), `GET/POST permits` (records only; the engine never files permits), `GET/POST diary` (append-only; `participants` entries are visible to live project participants, never to plan invitees).

## Privacy

- The invited view is built by `trustwork.plan_shared_view` (owner-run: live share for the principal, every column outside the share's fields NULL, address and contact only for `after_acceptance`) and re-projected by the contract serializer `toInvitedPlanView`. Private notes, sources, exact or single-figure budgets, risk and decision notes, other invitees and their items never reach an invitee.
- Budgets are `estimate_range` objects with `low < high`, a basis and a date, never a single figure.
- Outbox events carry identifiers only (`PLAN_EVENT_PAYLOAD_KEYS`); plans are not retrieval sources, not federated and not part of any public projection (`PLAN_EGRESS`).

## Agents

Drafts and proposals accept `actor: { via: 'agent', mandateId }`. The `PlanMandatePort` decides; the default `NoPlanMandates` refuses every agent request (`403 access.mandate_scope`) until the mandate store exists. The capability registry entries are `PROJECT_PLANNER_MANIFEST` (module `project_planner`, ADR 010 decision 23).

## Tests

`tests/contracts/plans.test.ts` (contracts and serializer), `tests/plans/database.test.ts` (RLS, guards, concurrency under the runtime role), `tests/plans/api.test.ts` (the journey through HTTP with negative authorization).

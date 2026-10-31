# Platform administration module (ADM-001)

Audited staff authority for the node and hub consoles ([Hub administration](../../../../../docs/engine/hub-administration.md), [hub console](../../../../../docs/engine/hub-console/README.md)): scoped staff roles and their materialised `admin.*` grants, separation-of-duties modes, second-person approvals bound to an action digest, break-glass, case access grants, audit queries, moderation with the sanction ladder and appeals, feature flags and incidents. Storage, row-level security and every authority rule are DATA-002's ([`packages/data/migrations/admin`](../../../../../packages/data/migrations/admin), [`repositories/admin.ts`](../../../../../packages/data/src/repositories/admin.ts)); contracts are `admin.ts` and the frozen console contract `hub.ts` (HUBC-000). The console UI is ADM-002 and the HUBC packages; the support workspace built on case grants is SUP-001.

Status: **Live** as an API (no console yet, not deployed). Tests: `tests/admin/*` and the ADM-001 block of `tests/backend/idempotency/crash.test.ts`, on real PostgreSQL under the runtime role.

## Guard rails

- **Every staff route** (`/v1/admin/*` here) needs a signed-in session, a staff role covering the hub this API serves (`TRUSTWORK_HUB_ID`, resolved from `staff_role_assignment` by BE-004's resolver) and a live elevation of the acting session (`ElevationGuard`, TOTP step-up). Refusals: `401` without a session, `403 access.forbidden` with `details.required = 'staff'` or `'elevation'`.
- **The database is the authority.** Every command runs in one `PrincipalService.runAs` transaction as the staff member through a DATA-002 SECURITY DEFINER command, which checks the permission at the scope, conflicts of interest and the second-person rules and writes the `admin_audit_event` row in the same transaction; the idempotency record completes there too (BE-005, `in_transaction`). The API checks only what it adds (the full-mode role rule, the idempotency key in the body).
- **Denied attempts are audited**: a refusal of authority (`access.forbidden`, `access.second_approver_required`, `access.approval_required`, `access.approval_digest_mismatch`) writes an `outcome = 'denied'` audit row in its own transaction when the person holds a role covering the target.
- **No impersonation.** No route issues a session for, or acts as, another person (tested over every controller of the API). A case access grant is a scoped, time-boxed (at most 72 hours), second-person-approved read right on named objects, logged per read; it never changes who the caller is.
- **No ranking controls.** No request schema accepts a score, rank, position, badge, weight, boost or priority (tested by walking every schema); flags refuse those words in keys, values and descriptions, and the database refuses access words in flag keys.
- **No module imports platform-admin** (tested); the composition root mounts it. It reaches other modules only through `ports.ts`.

## Routes

All mutations: CSRF header, `Idempotency-Key`, and a console command body (`contractVersion: "1.0.0"`, `idempotencyKey` equal to the header, `reason`, optional `reasonCode`). Errors use the contract envelope; the database refusal is in `details.reason` (for example `self_approval`, `same_role`, `approval_consumed`, `conflict_of_interest`, `sanction_level_not_allowed`).

| Route | Who | Result |
|---|---|---|
| `GET /v1/admin/node` | staff | The node anchor (`nodeId`, `label`) |
| `GET /v1/admin/access` (query `hubId` or `nodeId`) | staff | The caller's materialised grants at the target: roles, permissions, permissions held only through break-glass |
| `GET /v1/admin/staff/sod` (query `hubId` or `nodeId`) | `admin.staff.read` at the target | Separation-of-duties mode: `reduced` below five distinct staff people covering the target, `full` from five |
| `GET /v1/admin/staff/definitions`, `GET /v1/admin/staff/assignments`, `GET /v1/admin/staff/conflicts` | staff (rows filtered by row-level security) | Released role definitions; assignments and conflict declarations the caller may see |
| `POST /v1/admin/staff/assignments` | `admin.staff.assign` at the scope | Assigns a role; sensitive roles need `approvalId` (`staff.assign_sensitive_role`); never to oneself |
| `POST /v1/admin/staff/assignments/:id/revoke` | `admin.staff.revoke` | Revokes; the person's elevations and grants end with their last role (DATA-002) |
| `POST /v1/admin/staff/breakglass` | `admin.staff.breakglass` | Break-glass role: an open incident, at most 12 hours, a consumed `staff.grant_breakglass` approval |
| `POST /v1/admin/staff/conflicts`, `POST .../:id/end` | staff | Declare a conflict of interest (narrows), end one (recorded staff action) |
| `GET/POST /v1/admin/incidents` | `admin.incident.*` | Incidents (break-glass names one) |
| `POST /v1/admin/approvals` | a permission that executes the action, at its scope | Requests a second person. For `staff.assign_sensitive_role`, `staff.grant_breakglass` and `moderation.apply_sanction_l4` the server computes the digest from the described action; actions of other modules carry the digest their module computes |
| `GET /v1/admin/approvals`, `GET /v1/admin/approvals/:id` | staff | `forMe` (pending, not mine), `mine`, `decided` |
| `POST /v1/admin/approvals/:id/approve` | a different person holding an executing permission | Restates the reviewed digest; lasts at most 72 hours. In full mode the approver must act through a role the requester does not hold for that action (checked when the approver may read the staff directory; the response states `sod.verified`) |
| `POST /v1/admin/approvals/:id/decline`, `/withdraw` | approver, requester | Decline with reason; the requester withdraws (audited) |
| `POST /v1/admin/case-grants`, `POST .../:id/decide`, `POST .../:id/revoke` | `admin.support.grant.request`; a different person with `admin.support.grant.approve`; requester or approver | Case access grant inside an open support case, restating the request digest to approve |
| `GET /v1/admin/case-grants/:id`, `GET /v1/admin/support-cases/:id/case-grants`, `GET /v1/admin/case-grants/coverage`, `GET /v1/admin/access-log` | staff | Grant state (`active` false once expired or revoked), coverage of an object for the caller, the access log |
| `GET /v1/admin/audit` | own actions, or `admin.audit.read` at the scope | Mutation audit in sequence order, filters and keyset paging (`afterSequence`) |
| `GET /v1/admin/audit/continuity` | `admin.audit.read` at the platform | Sequence continuity of the whole audit (`gapFree`, missing sequences) |
| `GET /v1/admin/moderation/reports`, `/cases`, `/appeals` (query `hubId`), `GET /v1/admin/moderation/cases/:id` | `admin.moderation.read` | Reports (never the reporter's identity), cases with sanctions and appeals |
| `POST /v1/admin/moderation/cases` | `admin.moderation.case.open` (`emergency.hold` for a hold) | Opens a case; a hold reaches the content owner through `ModerationTargetPort` |
| `POST /v1/admin/moderation/cases/:id/decide` | `admin.moderation.decide`, no conflict | Decision; removal and restoration reach the content owner through the port; the subject is notified |
| `POST /v1/admin/moderation/cases/:id/sanctions` | `admin.moderation.decide` | Sanction ladder: moderators levels 1-2 (bounded durations), other roles level 3, level 4 only with a consumed `moderation.apply_sanction_l4` approval of exactly that sanction (a second person); enforcement through `SanctionEnforcementPort` |
| `POST /v1/admin/moderation/sanctions/:id/lift`, `POST /v1/admin/moderation/appeals/:id/decide` | `admin.moderation.appeal.decide` (or `admin.trust.appeals.decide`), never the original decider | Lift; decide an appeal (overturning a sanction lifts it; overturning a removal restores the content) |
| `GET/POST /v1/admin/flags` | staff; `admin.flags.edit` to set | Feature flags with owner, scope and expiry (at most 400 days); never access, never ranking |
| `POST /v1/moderation/reports`, `GET /v1/moderation/me`, `POST /v1/moderation/appeals` | any signed-in person | Report content against a clause; see cases, sanctions and appeals about oneself or one's employer (no staff identities); appeal a sanction or a moderation decision |

## Facade ports (`ports.ts`)

| Port | Called when | Default until the owner lands |
|---|---|---|
| `ModerationTargetPort` | a hold is opened, content is removed or restored (also on an overturning appeal) | `RecordingModerationTargets` (CNT-001 replaces it) |
| `SanctionEnforcementPort` | a sanction is applied or lifted | `RecordingSanctionEnforcement` |

Each call runs inside the staff command's transaction: a refusal by the owning module rolls the decision, its audit row and its notices back. Owning modules implement the interfaces structurally and never import this module.

## Notices

Outbox intents (MAIL-001 delivers them; identifiers only): `admin.staff_role_assigned`, `admin.staff_role_revoked`, `admin.breakglass_granted`, `admin.approval_requested`, `admin.approval_decided`, `admin.case_grant_requested`, `admin.case_grant_decided`, `moderation.report_received`, `moderation.case_decided`, `moderation.sanction_applied`, `moderation.sanction_lifted`, `moderation.appeal_filed`, `moderation.appeal_decided`. Their mail templates are a MAIL follow-up.

## Known limits

- The full-mode "different role" rule needs the staff directory; an approver without `admin.staff.read` at the scope cannot read it, so only the database rules apply (different person, executing permission at the scope, digest, expiry) and the response says `sod.verified: false`. Follow-up for the data integrator: a SECURITY DEFINER `admin_sod_mode(node, hub)` and the role check inside `admin_decide_approval`.
- The separation-of-duties mode is derived from the staff count (contract: "`reduced` while staff < 5"); an explicit per-hub switch (`staff.switch_sod_mode`) belongs to the versioned hub configuration (HUB-001).
- Support cases themselves (opening, notes, closing) and reads under a grant are SUP-001; appeals on other modules' decisions are filed by those modules (DATA-002 owner-run path) and decided here.

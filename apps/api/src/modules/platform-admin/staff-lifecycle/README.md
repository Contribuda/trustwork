# Staff lifecycle and access governance (ADM-004)

Status: live in the API: the staff directory and effective access (part 1), staff invitations (part 2), eligible roles with just-in-time activation and the role-change preview (part 3). Access reviews and offboarding follow. Design: [console design, section 4.2](../../../../../../docs/engine/hub-console/console-design.md). Contract: `packages/contracts/src/staff-lifecycle.ts`. Migration: `packages/data/migrations/staff-lifecycle`.

## Routes

Every route needs a signed-in person whose session is elevated (`ElevationGuard`), like every console read.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /v1/admin/staff/directory?hubId=` | Anyone holding an active staff role covering the hub | The people who hold an active staff role covering the hub (hub, node or platform scope), by name. With `admin.staff.read` at the hub, also each active role with its scope, end and break-glass flag, and whether a second factor is enrolled (`detail: true`). |
| `GET /v1/admin/staff/effective-access?hubId=&personId=` | `admin.staff.read` at the hub | The person's roles and permissions at the hub now, from released role definitions and active assignments; permissions only break-glass grants carry are listed apart. |

| `GET /v1/admin/staff/invitations?hubId=` | `admin.staff.read` at the scope (row-level security) | Invitations of the hub, the node and the platform, with the address, status, computed expiry and the approval and assignment they led to. |
| `POST /v1/admin/staff/invitations` | `admin.staff.assign` at the scope | Invites an e-mail address to one role, optionally for one hour to 366 days; expires unused after seven days. |
| `POST /v1/admin/staff/invitations/:id/apply` | The inviter | Turns an accepted invitation into the assignment. A sensitive role first asks a second person (`outcome: pending_second_person`); once approved, the same call consumes the approval and assigns. |
| `POST /v1/admin/staff/invitations/:id/withdraw` | `admin.staff.assign` at the scope | Ends an open invitation and revokes the approval it asked for. |
| `GET /v1/me/staff-invitations` | Any signed-in person | Their own open invitations, by their verified addresses, with the inviter's name. |
| `POST /v1/me/staff-invitations/:id/respond` | The person whose verified address it names | Accepts (needs an active second factor) or declines; to anyone else the invitation does not exist. |

| `GET /v1/admin/staff/eligible-roles?hubId=&personId?=` | One's own; everyone's with `admin.staff.read` at the scope (row-level security) | Eligible roles covering the hub with their activation ceiling and whether they can be activated now. |
| `POST /v1/admin/staff/eligible-roles` | `admin.staff.assign` at the scope | Makes a person eligible for a role (never oneself) with an activation ceiling at most the role's `grantMaxHours` and 12 hours; refused as a full-mode conflict when the person holds a conflicting role. |
| `POST /v1/admin/staff/eligible-roles/:id/revoke` | `admin.staff.revoke` at the scope | Ends the eligibility, withdraws its pending activation and ends its running one at once. |
| `GET /v1/admin/staff/activations?hubId=&personId?=` | One's own; everyone's with `admin.staff.read` at the scope | Activations with their state now (`pending`, `active`, `ended`, `declined`, `withdrawn`, `expired`); pending ones are the second person's queue. |
| `POST /v1/admin/staff/activations` | The eligible person, with a second factor used within five minutes | Activates the role for a window within the ceiling. A non-sensitive role is active at once (`outcome: active`); a sensitive role asks a second person (`pending_second_person`). |
| `POST /v1/admin/staff/activations/:id/decide` | `admin.staff.assign` at the scope; neither the holder nor the eligibility's grantor; in full mode through a role the grantor does not hold | Approves (the role is held from now until the window ends) or declines. |
| `POST /v1/admin/staff/activations/:id/end` | The holder, or `admin.staff.revoke` at the scope | Withdraws a pending activation or ends a running one early. |
| `POST /v1/admin/staff/role-changes/preview` | `admin.staff.read` and `admin.staff.assign` at the scope | The difference a role change would make: roles and permissions before and after, gained and lost permissions, separation-of-duties conflicts, the approvals needed with their digests, and the preview digest. Computed, never stored. |
| `POST /v1/admin/staff/role-changes/apply` | `admin.staff.assign` (and `admin.staff.revoke` for removals) at the scope | Recomputes the preview under a per-person lock and refuses a stale one (`preview_stale`) or a blocking conflict (`sod_conflict`); then revokes and assigns through the ADM-001 commands. |

## Invitations

1. **Invite.** A staff member with `admin.staff.assign` invites an address to one role at a scope with a reason. Nobody invites their own address; at most one open invitation per address, role and scope; an expired one is closed by the next.
2. **Respond.** The person whose verified address it names accepts or declines. Accepting needs an active second factor (staff open elevated sessions with it). Nobody else learns whether an account with the address exists.
3. **Apply.** The inviter, in an elevated session, turns the accepted invitation into the staff assignment, audited with their elevation. For a sensitive role the first call asks a second person for exactly that assignment (`staff.assign_sensitive_role`, digest over the person, role, scope, definition and validity); the approver differs from the inviter and the invitee; after approval the same call consumes it and assigns. An invitation that expired (seven days, the wait for the second person included) is refused here too, whether or not an approval was asked; withdrawing it revokes that approval.
4. **Withdraw.** Any open invitation can be withdrawn; an approval it asked for is revoked.

In the console the staff screen (HC-150) offers the invitation, its list, apply and withdraw; the invited person answers in the workspace settings (`/app/settings#staff-invitations`, HUBC-007). The invitation itself is not mailed yet.

The design sketch in the console design (section 4.2) asked for the approval before acceptance. The approval binds the exact assignment digest, which names the person, and an invitation names only an address until it is accepted; so the approval is asked after acceptance, and nothing takes effect before it.

## Eligible roles and just-in-time activation

A role may be held as *eligible* instead of active (console design, "Time-boxed roles and just-in-time elevation"). The pieces and how they fit ADM-001 without weakening it:

1. **Eligibility** is a standing pre-authorization by a staff administrator with `admin.staff.assign` at the scope: the person, the role, the released definition, an activation ceiling (`maxActivationSeconds`, at most the definition's `grantMaxHours` and `BREAKGLASS_MAX_HOURS`) and an optional end. It grants nothing by itself.
2. **Activation** is requested by the eligible person in an elevated session whose elevation was created within `FRESH_SECOND_FACTOR_SECONDS` (five minutes): a fresh second factor every time. The window is bounded by the eligibility, the definition and twelve hours; one activation per eligibility is open at a time; the grantor must still hold `admin.staff.assign` at the scope (else `eligibility_stale`); a full-mode conflict with a held role is refused. A person's role changes (eligibility grants, activations, approvals of activations and the API's role-change apply) serialize on one advisory lock taken before the conflict check, so two simultaneous activations of a conflicting pair never both commit (tested).
3. **The assignment** is an ordinary `staff_role_assignment` from now until the window ends, with the eligibility's grantor as `grantedBy` (nobody grants a role to themselves). The window end is the assignment's `validUntil`, checked at every request like every other assignment: no job runs at the end, and the activation's `state` is computed from the assignment at every read.
4. **A sensitive role** asks a second person: the activation creates a `second_person_approval` for `staff.assign_sensitive_role` in the grantor's name, bound to the exact assignment digest (person, role, scope, definition, window). The second person holds `admin.staff.assign` at the scope and is neither the holder nor the grantor; in full separation-of-duties mode (five or more people covering the scope) they act through a role the grantor does not hold for `admin.staff.assign`, a rule the database decides (`staff_sod_full`, `staff_roles_granting`; the API repeats it early when it can read the staff). Approving consumes the approval and creates the assignment in the same transaction; an approval already given through the approvals inbox is honoured.
5. **Ending early**: the holder ends their own activation; `admin.staff.revoke` ends anyone's. Revoking the eligibility withdraws its pending and ends its running activation. Revoking a person's last standing role revokes their eligible roles, ends their activations and (through ADM-001) their elevations and open approval requests at once; an activation always ends, named as the revoker's revocation when they hold `admin.staff.revoke` at its scope and otherwise as the holder's own with the reason recorded.
6. **Audit**: grants, revocations and decisions are audited under the staff permission used; the holder's own acts (request, early end) are audited under `admin.session.elevate` with a role they hold covering the scope (or the eligible role itself): an activation is the elevation of the session into a role.

## Role change with preview

`POST /v1/admin/staff/role-changes/preview` computes, from the rows as they are now, what adding and removing roles would change for one person at a scope (console design, section 5.5): permissions gained and lost, the separation-of-duties conflicts (`blocking` when the definition that lists the other role runs in full mode, which is what the database refuses; otherwise a recorded warning), the approvals a sensitive addition needs with the digests to ask for, and a `previewDigest` over the person's current active assignments and the requested change. `apply` takes an advisory lock per person, recomputes the preview and refuses when the digest differs (`validation.revision_conflict`, `preview_stale`), when a conflict blocks (`sod_conflict`) or when a sensitive addition names no approval; then each removal and addition runs through the ADM-001 commands, which audit and check the second person and the conflicts again. Two concurrent applies of one preview change the roles exactly once (tested).

## Rules

- **Existence never leaks.** A participant, staff of another hub and any unknown hub get "not found" from the database itself (`staff_require_hub_staff`); effective access of a person who is not staff of the hub is "not found" too.
- **Names for accountability, detail by permission.** Approvals and audit name who asked and who decided, so every staff member of the hub reads names; roles and second-factor state need `admin.staff.read`.
- **No surveillance.** Nothing here returns what a staff member did: no sign-in, elevation or decision times, counts, response times or other behaviour measures. A schema walk in `tests/admin/staff-lifecycle` checks the field names.
- **The database decides.** Both reads are SECURITY DEFINER functions that resolve the caller from the request principal (`staff_directory`, `staff_effective_assignments`); the API only maps rows and computes permissions with the same `effectiveGrants` the platform-administration API uses.

## Tests

`tests/admin/staff-lifecycle/invitations.test.ts` on PostgreSQL under the runtime role: only `admin.staff.assign` invites, never oneself, one open invitation per address and role; the invitee alone sees and answers it, accepting needs a second factor; only the inviter applies; a sensitive role asks a second person for the exact assignment digest and takes effect only after approval, with an end date; withdrawal and expiry without a job; terms immutable, rows never deleted. `tests/admin/staff-lifecycle/invitations-api.test.ts` walks the same path through the HTTP API, and `tests/admin/crash-routes.ts` runs the four invitation commands through the BE-005 crash sequence.


`tests/admin/staff-lifecycle/eligible-roles.test.ts` on PostgreSQL under the runtime role: only `admin.staff.assign` grants eligibility, never to oneself, within the role cap and twelve hours, never a full-mode conflict; activation needs a second factor used within five minutes, one's own eligibility and a window within the ceiling; a non-sensitive role is active at once and ends with its window without a job (time travel on the assignment); early ends by the holder and by `admin.staff.revoke`; a sensitive role asks a second person in the grantor's name bound to the exact digest, the holder and the grantor never decide, approval consumes and assigns, decline grants nothing, an inbox approval is honoured; revoking the eligibility and revoking the last standing role cascade; reads under row-level security; immutability. `tests/admin/staff-lifecycle/eligible-roles-api.test.ts` walks the HTTP path in full separation-of-duties mode (ten staff), including the same-role refusal, the role-change preview, a stale preview, a blocking conflict, a sensitive addition with its approval, two concurrent applies and the schema walk; `tests/admin/crash-routes.ts` runs the six commands through the BE-005 crash sequence.

`tests/admin/staff-lifecycle/directory.test.ts` on real PostgreSQL through the HTTP API: anonymous, participants, other-hub staff and unelevated sessions are refused; names only without `admin.staff.read`; roles and second-factor state with it; the database refuses a participant, other-hub staff and an unknown hub; effective access needs `admin.staff.read` and never confirms who is not staff; the schema walk.

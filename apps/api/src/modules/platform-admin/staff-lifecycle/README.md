# Staff lifecycle and access governance (ADM-004)

Status: live in the API: the staff directory and effective access (part 1), staff invitations (part 2). Eligible roles, access reviews and offboarding follow. Design: [console design, section 4.2](../../../../../../docs/engine/hub-console/console-design.md). Contract: `packages/contracts/src/staff-lifecycle.ts`. Migration: `packages/data/migrations/staff-lifecycle`.

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

## Invitations

1. **Invite.** A staff member with `admin.staff.assign` invites an address to one role at a scope with a reason. Nobody invites their own address; at most one open invitation per address, role and scope; an expired one is closed by the next.
2. **Respond.** The person whose verified address it names accepts or declines. Accepting needs an active second factor (staff open elevated sessions with it). Nobody else learns whether an account with the address exists.
3. **Apply.** The inviter, in an elevated session, turns the accepted invitation into the staff assignment, audited with their elevation. For a sensitive role the first call asks a second person for exactly that assignment (`staff.assign_sensitive_role`, digest over the person, role, scope, definition and validity); the approver differs from the inviter and the invitee; after approval the same call consumes it and assigns.
4. **Withdraw.** Any open invitation can be withdrawn; an approval it asked for is revoked.

The design sketch in the console design (section 4.2) asked for the approval before acceptance. The approval binds the exact assignment digest, which names the person, and an invitation names only an address until it is accepted; so the approval is asked after acceptance, and nothing takes effect before it.

## Rules

- **Existence never leaks.** A participant, staff of another hub and any unknown hub get "not found" from the database itself (`staff_require_hub_staff`); effective access of a person who is not staff of the hub is "not found" too.
- **Names for accountability, detail by permission.** Approvals and audit name who asked and who decided, so every staff member of the hub reads names; roles and second-factor state need `admin.staff.read`.
- **No surveillance.** Nothing here returns what a staff member did: no sign-in, elevation or decision times, counts, response times or other behaviour measures. A schema walk in `tests/admin/staff-lifecycle` checks the field names.
- **The database decides.** Both reads are SECURITY DEFINER functions that resolve the caller from the request principal (`staff_directory`, `staff_effective_assignments`); the API only maps rows and computes permissions with the same `effectiveGrants` the platform-administration API uses.

## Tests

`tests/admin/staff-lifecycle/invitations.test.ts` on PostgreSQL under the runtime role: only `admin.staff.assign` invites, never oneself, one open invitation per address and role; the invitee alone sees and answers it, accepting needs a second factor; only the inviter applies; a sensitive role asks a second person for the exact assignment digest and takes effect only after approval, with an end date; withdrawal and expiry without a job; terms immutable, rows never deleted. `tests/admin/staff-lifecycle/invitations-api.test.ts` walks the same path through the HTTP API, and `tests/admin/crash-routes.ts` runs the four invitation commands through the BE-005 crash sequence.


`tests/admin/staff-lifecycle/directory.test.ts` on real PostgreSQL through the HTTP API: anonymous, participants, other-hub staff and unelevated sessions are refused; names only without `admin.staff.read`; roles and second-factor state with it; the database refuses a participant, other-hub staff and an unknown hub; effective access needs `admin.staff.read` and never confirms who is not staff; the schema walk.

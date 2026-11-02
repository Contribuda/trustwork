# Staff lifecycle and access governance (ADM-004)

Status: part 1 live in the API (the staff directory and effective access); invitations, eligible roles, access reviews and offboarding follow. Design: [console design, section 4.2](../../../../../../docs/engine/hub-console/console-design.md). Contract: `packages/contracts/src/staff-lifecycle.ts`. Migration: `packages/data/migrations/staff-lifecycle`.

## Routes

Every route needs a signed-in person whose session is elevated (`ElevationGuard`), like every console read.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /v1/admin/staff/directory?hubId=` | Anyone holding an active staff role covering the hub | The people who hold an active staff role covering the hub (hub, node or platform scope), by name. With `admin.staff.read` at the hub, also each active role with its scope, end and break-glass flag, and whether a second factor is enrolled (`detail: true`). |
| `GET /v1/admin/staff/effective-access?hubId=&personId=` | `admin.staff.read` at the hub | The person's roles and permissions at the hub now, from released role definitions and active assignments; permissions only break-glass grants carry are listed apart. |

## Rules

- **Existence never leaks.** A participant, staff of another hub and any unknown hub get "not found" from the database itself (`staff_require_hub_staff`); effective access of a person who is not staff of the hub is "not found" too.
- **Names for accountability, detail by permission.** Approvals and audit name who asked and who decided, so every staff member of the hub reads names; roles and second-factor state need `admin.staff.read`.
- **No surveillance.** Nothing here returns what a staff member did: no sign-in, elevation or decision times, counts, response times or other behaviour measures. A schema walk in `tests/admin/staff-lifecycle` checks the field names.
- **The database decides.** Both reads are SECURITY DEFINER functions that resolve the caller from the request principal (`staff_directory`, `staff_effective_assignments`); the API only maps rows and computes permissions with the same `effectiveGrants` the platform-administration API uses.

## Tests

`tests/admin/staff-lifecycle/directory.test.ts` on real PostgreSQL through the HTTP API: anonymous, participants, other-hub staff and unelevated sessions are refused; names only without `admin.staff.read`; roles and second-factor state with it; the database refuses a participant, other-hub staff and an unknown hub; effective access needs `admin.staff.read` and never confirms who is not staff; the schema walk.

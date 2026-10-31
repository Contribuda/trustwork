# Directory module (BE-003)

Company creation, public handles and keyset-paginated directories, so a person can reach the states the web shows: create a company, find their projects and browse people, companies and projects by handle. Contracts: [`packages/contracts/src/directory.ts`](../../../../../packages/contracts/src/directory.ts). Storage: [`packages/data/migrations/directory`](../../../../../packages/data/migrations/directory), [`packages/data/src/repositories/directory.ts`](../../../../../packages/data/src/repositories/directory.ts). Decision: [ADR 012](../../../../../docs/adr/012-integrator-decisions-2026-10-31.md) decision 18.

All mutations: authenticated session, `X-Trustwork-Request` + same-origin metadata, `Idempotency-Key`. Errors use the contract envelope.

## Routes

| Route | Who | Result |
|---|---|---|
| `POST /v1/companies` | signed in, verified e-mail, no active employer | `201 { company, membership }`: a `registered`, `unclaimed` company; the caller is its only administrator (all company permissions). Employed callers get `409 membership.already_employed`; the whole creation (company, membership, handle) is one transaction |
| `GET /v1/people`, `GET /v1/companies`, `GET /v1/projects` | everyone | `{ items, nextCursor }` of public projections only: public profiles, every company, published projects. Identical content for every caller |
| `GET /v1/me/projects` | signed in | projects the person owns or takes part in (live buyer, seller or participant row), plus the employer's when the membership holds `company.deals.manage`; `relation` is `owner` or `participant`; no owner-private field |
| `GET /v1/{people,companies,projects}/by-handle/:handle` | everyone | `{ item, redirect }`: the public entry with its current handle; `redirect: true` when the requested handle was retired. Private subjects are not found for everyone |
| `GET /v1/handles/:kind/:handle` | everyone | `{ kind, id, handle, requested, redirect }`, resolved with the caller's visibility: owners and participants resolve a private project, others get `404` |
| `POST /v1/me/handle`, `POST /v1/companies/:id/handle`, `POST /v1/projects/:id/handle` | the subject's owner | `{ kind, id, handle }`. Company: active employer with `company.page.edit` (outsiders `403`, the company being public). Project: the owner party; company projects need `company.publish`; participants `403`, invisible projects `404` |

Pagination: `?limit=1..100` (default 20) and an opaque `cursor`; order `(createdAt DESC, id DESC)`, both immutable, so concurrent inserts never duplicate or skip existing items. A cursor that this API did not issue is `422 validation.schema`. Pages carry no totals.

## Handles

Lower-case ASCII letters and digits in hyphen-separated groups, 3 to 40 characters, never all digits, never UUID-shaped, never one of `RESERVED_HANDLES`. Unique per kind (a person and a company may share a text). UUIDs remain the identifiers; a handle is a URL name:

- Changing a handle retires the previous one, which keeps resolving to the subject (`redirect: true`).
- A handle is never reused for another subject: rows are permanent (no delete, no re-pointing, for every role, enforced by a trigger). The subject itself may reclaim a former handle.
- At most ten handle records per subject, so renaming cannot squat names.
- Handle problems answer `422 validation.schema` with `details: { field: "handle", reason: "handle_unavailable" | "handle_invalid" | "handle_limit" }` until the frozen error list gains a directory code.

## Authorization layers

- Application policy first (membership permissions, the object policy for projects), then the SECURITY DEFINER commands `directory_set_handle` and `directory_create_company` re-check the same authority in the database. The runtime role has no write privilege on `directory_handle` and no longer inserts companies directly.
- `directory_handle` is under `FORCE ROW LEVEL SECURITY`; a handle row is visible exactly when its subject is visible under the subject's own policy, so private profiles' and private projects' handles never leak.
- Anonymous callers have no identity: people and projects come from the owner-run `directory_public_people`, `directory_public_projects` and `directory_public_resolve` (public columns of public rows only); companies are public rows read by the runtime role without identity.

Tests: `tests/contracts/directory.test.ts`, `tests/directory/api.test.ts` (HTTP, negative authorization per projection), `tests/directory/database.test.ts` (permanence, definer authority, RLS, concurrency, pagination under concurrent inserts) and `tests/directory/plans.test.ts` (index scans on 100,000 synthetic rows under the runtime role).

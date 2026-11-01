# Support workspace module (SUP-001)

Serving people lawfully without impersonation ([Support workspace](../../../../../docs/engine/hub-console/support.md)): support cases on someone's behalf and the person's own support path, recorded lookups, the allowlisted account card, servicing actions with evidence, a second person and a 72-hour cooling-off for sign-in factor changes, the access explainer (reason codes only) and diagnostic snapshots the person shares from their own session. Built on ADM-001 / DATA-002 (support cases, notes, second-person approvals, conflicts of interest, the staff audit) and BE-004 (elevated sessions, the support reset of a second factor). Storage, row-level security and every authority rule are in [`packages/data/migrations/support`](../../../../../packages/data/migrations/support) ([repository](../../../../../packages/data/src/repositories/support.ts), [schema mirror](../../../../../packages/data/src/schema/support.ts)).

Status: **Live** as an API (no console screens yet, not deployed). Tests: `tests/support/*` and `tests/backend/idempotency/cases/support.ts`, on real PostgreSQL under the runtime role.

## Guard rails

- **No impersonation.** No route, service method or SQL function issues a session for, signs in as, or acts as another person; the module never calls the session, cookie or principal-switching code of identity (tested by scanning the sources and by checking that no support call creates a session row or sets a cookie). Where support needs to see something, the alternatives of the handbook apply: the account card, the access explainer, diagnostic snapshots, DATA-002 case access grants and guided tasks the person performs themselves.
- **Every staff route** (`/v1/admin/support/*`) needs a signed-in session, a staff role covering this deployment and a live elevation (`ElevationGuard`). The database re-authorizes every command at the case's hub (`admin_authorize`), refuses closed cases, persons who are not the case's subject or requester, and staff handling their own account, their employer, a declared conflict or a case they requested, and writes the `admin_audit_event` row in the same transaction.
- **Sign-in factor changes** (`rebind_recovery_email`, `reset_second_factor`, `COOLING_OFF_ACTIONS`) need recorded evidence (identifiers of checks, never the documents), a second-person approval of the exact request digest through the ADM-001 approvals inbox (actions `support.rebind_recovery_email` and `support.reset_second_factor`), a requester who starts the cooling-off by consuming that approval (the approver must not be the person or conflicted), and at least 72 hours on the database clock before execution. Every verified address of the person is told when the change is requested, approved, cancelled and completed; the person, the requester or the approver can cancel until then. A second-factor reset opens the BE-004 reset in its cooling-off state (the person sees and can cancel it in their security settings; the servicing action follows), and execution ends every factor, recovery code, challenge, elevation and session. A rebind never binds an address itself: it mails an e-mail change proof to the new address, and only the person opening it binds the address.
- **The account card** is built inside the database from an allowlist (`SupportAccountSummarySchema`): masked e-mail, counts and states only; never an address, token, IP, device, secret, message, budget or private object. The response is parsed with a strict schema, so an extra field fails the request. Entitlements are billing's: payment neutrality forbids any other module to read billing tables, so the card asks billing through `SupportEntitlementsPort` (`ports.ts`), and the response says `entitlementsAvailable`.
- **The access explainer** evaluates the identity policy for the person and one object and answers reason codes only (`AccessExplanationSchema`: effect, capability, projection or deny reason and disclosure); no id, name, participation or field value.
- **Recorded reads.** Lookups, account cards and explanations write a `support_access_record` with the case and a SHA-256 of the query (never the query). The person sees when support looked at their account and for which case, never who (`GET /v1/support/access`).
- **No ranking controls**: no request schema accepts a score, rank, position, badge, weight or boost (tested); the case urgency is called `urgency` in requests and responses.

## Routes

Staff mutations: CSRF header, `Idempotency-Key`, a console command body (`contractVersion: "1.0.0"`, `idempotencyKey` equal to the header, `reason`, optional `reasonCode`); they complete their idempotency record in the request transaction (BE-005). Recorded queries are POST without an idempotency key, so a query never sits in a URL. `hubId` defaults to `TRUSTWORK_HUB_ID` of the process.

| Route | Who | Result |
|---|---|---|
| `GET /v1/admin/support/cases` (query `status`) | support staff of the hub | The case queue (never the caller's own requests) |
| `POST /v1/admin/support/cases` | `admin.support.case.create` | Opens a case on someone's behalf |
| `GET /v1/admin/support/cases/:id` | support staff | Case, internal and requester notes, servicing actions, shared snapshots |
| `POST .../cases/:id/update`, `POST .../cases/:id/notes` | support staff (closing: `admin.support.case.close`) | DATA-002 lifecycle, assignment, urgency, notes |
| `POST /v1/admin/support/lookup` | `admin.support.account.read` | Exact e-mail, person or company id, legal identifier; name prefixes only inside a case; at most 20 results, names and ids only |
| `POST .../cases/:id/people/:personId/account` | `admin.support.account.read` | The allowlisted account card of a party of the case |
| `POST .../cases/:id/explain` | `admin.support.explain` | Reason codes for one person, one object and one capability |
| `POST .../cases/:id/actions` | the action's permission (below) | Immediate actions apply; sign-in factor changes are born `pending` with an approval request |
| `GET /v1/admin/support/actions/:id` | support staff, the requester, the approver | The action with its request digest and the masked new address |
| `POST .../actions/:id/activate` | the requester, after a different person approved the digest | Starts the cooling-off (at least 72 hours) |
| `POST .../actions/:id/execute` | the requester or the approver, after the cooling-off | Executes the change |
| `POST .../actions/:id/cancel` | the requester or the approver | Cancels before it takes effect |
| `GET /v1/support/cases`, `POST /v1/support/cases`, `GET /v1/support/cases/:id` | any signed-in person | Their own cases (about themselves or, with `company.members.manage`, their employer); notes from support without staff identities |
| `POST /v1/support/cases/:id/notes`, `POST /v1/support/cases/:id/status` | the requester | Reply inside the case; answer, reopen or confirm |
| `POST /v1/support/cases/:id/diagnostics` | the requester | Shares page id, versions, feature flags, error codes, request ids and only the objects they take part in (references) |
| `GET /v1/support/actions`, `POST /v1/support/actions/:id/cancel` (step-up) | the person | Servicing actions on their account; cancels a pending sign-in factor change |
| `GET /v1/support/access` | the person | When support looked at their account and for which case |

| Action | Permission | Effect |
|---|---|---|
| `resend_verification` | `admin.support.notifications` | A fresh verification link to the unverified address on file only; once per 15 minutes |
| `unlock_after_lockout` | `admin.support.diagnose` | Clears the failed sign-in counters of the person's addresses and second factor |
| `revoke_all_sessions` | `admin.support.sessions.revoke` | Ends every session and elevation |
| `require_password_reset` | `admin.support.sessions.revoke` | Disables the password and ends every session; the person resets it from their mailbox |
| `rebind_recovery_email` | `admin.support.recovery.rebind` | Cooling-off change; mails an e-mail change proof to the new address |
| `reset_second_factor` | `admin.support.second_factor.reset` | Cooling-off change through the BE-004 reset |
| `start_data_export`, `open_deletion_request` | `admin.support.case.create` | Recorded `pending` for the privacy officer (PRV-001 executes; exports reach the person, not staff) |
| `send_guided_task` | `admin.support.notifications` | A structured task code the person performs in their own session |

## Notices

Security notices (template `security_notice`, every verified address): the BE-004 `second_factor_reset_*` events and `recovery_email_rebind_requested|approved|cancelled|completed`, `sessions_revoked_by_support`, `password_reset_required`, `account_unlocked`, `support_guided_task` (all seven mail languages). Outbox intents carry identifiers only: `support.case_opened`, `support.case_updated`, `support.case_answered`, `support.requester_replied`, `support.diagnostics_shared`, `support.action_requested`, `support.action_cooling_off`, `support.action_done`, `support.action_cancelled`, plus the identity intents `identity.sessions_revoked` and `identity.second_factor_reset_*`.

## Known limits

- Billing has no staff read of a person's entitlements yet (`admin.commerce.entitlement.read`, a BILL follow-up), so the default `UnavailableEntitlements` adapter answers "not available": the card carries `entitlements: []` with `entitlementsAvailable: false`, and the console must show "not available", not "none".
- The contract `SupportAccountSummarySchema` requires a display name and a masked e-mail; a provider sign-up may have neither, so the served card (`SupportAccountCardSchema`) allows `null` for both. Follow-up for the contract owner: make both nullable in `hub.ts`.
- `AccountServiceActionSchema` requires `approvedBy` for sign-in factor changes, so a change waiting for its second person is served without the `record` field (`record: null`) until it is approved and activated.
- The company card, communications history (delivery metadata), memberships and usage against quotas, data rights flows (PRV-001) and support metrics are not built yet. Reads of private objects under a case grant stay DATA-002's `admin_case_evidence` and the owning modules' `admin_case_grant_covers` policies.
- The access explainer does not know whether an object has a public projection (it evaluates `publishedProjection: false`); "projection not published" is reported as the participation reason instead.
- DATA-002's `admin_add_case_note` does not refuse a conflicted staff member; the support commands of this module do.
- The older BE-004 routes `/v1/admin/support/second-factor-resets` remain; the console should use the case-bound servicing actions of this module.

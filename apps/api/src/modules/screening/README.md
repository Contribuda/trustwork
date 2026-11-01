# Screening (SANC-003)

The API side of the screening engine ([ADR 014](../../../../../docs/adr/014-sanctions-compliance-engine.md) decisions 13 to 15; handbook [Sanctions compliance](../../../../../docs/engine/modules/sanctions-compliance.md); data [section 24a](../../../../../docs/data/model.md#24a-sanctions-compliance)). Screening itself runs in the worker ([`apps/worker/src/screening`](../../../../worker/src/screening/README.md)).

## Routes

| Route | Who | What |
|---|---|---|
| `GET /v1/screening/me[?companyId=]` | the subject (or an administrator of the company) | `core.compliance_status`: status words only (`OwnComplianceStatusSchema`); never a list, an entry, a matched name or a reviewer |
| `POST /v1/screening/me/appeal` | the subject, fresh step-up | `core.appeal_compliance_decision`: every confirmed match of the subject goes to `appeal`; answers with the generic receipt `{ recorded: true }`, and a replay of a success stored before SANC-007 is minimized to the same receipt without running the command again |
| `GET /v1/admin/screening/queue` | compliance staff, elevated | one item per subject waiting for a reviewer, late after `SCREENING_REVIEW_SERVICE_LEVEL_DAYS` business days (1 to 5, default 1) |
| `GET /v1/admin/screening/subjects/:stateId`, `GET /v1/admin/screening/matches/:id` | compliance staff, elevated | the entry and the screened name side by side, the decision trail and any second-person request |
| `GET /v1/admin/screening/rescreen-runs` | node compliance officer or auditor, elevated | operational SANC-005 run projection, newest first; progress suppressed below ten proven distinct people |
| `POST /v1/admin/screening/rescreen-runs` | node compliance officer, elevated | existing SANC-005 manual full-run request with a required reason; unfinished runs serialize, response and audit complete in one idempotent transaction |
| `GET /v1/admin/screening/report-drafts` | compliance staff, elevated | drafts for the operator's blocked-property or rejected-transaction reports |
| `POST /v1/admin/screening/matches/:id/confirm` | compliance officer, elevated | confirm (one person, the safe direction): suspension, agent stop, report draft |
| `POST /v1/admin/screening/matches/:id/propose-not-same-person` | compliance officer, elevated | starts `screening.clear_match` |
| `POST /v1/admin/screening/matches/:id/proposal-decision` | another compliance officer, elevated | approves (restating the digest) or rejects a proposal or a reversal |
| `POST /v1/admin/screening/matches/:id/appeal-decision` | a compliance officer other than the one who confirmed | upholds, or proposes a reversal (`screening.reverse_confirmation`) |

Every decision route is `@Idempotent` and completes in its request transaction (BE-005). The database decides authority: a compliance officer of the node under an elevation, never the subject, a member of the subject company or a reviewer with a declared conflict; a second person for "not the same person" and reversals. Refusals map to `access.forbidden`, `access.second_approver_required`, `access.approval_digest_mismatch`, `validation.revision_conflict` or `access.not_found` (`errors.ts`).

## Ports and hooks

- `port.ts`: `screeningState(trx, subject)`, the internal port the money and commitment gates read (SANC-004). It throws when the state cannot be read; a gate must then refuse. Its reasons are never shown to a counterparty.
- `suspension.ts`: an `onRequest` hook after the jurisdiction gate. A person suspended by a confirmed match reaches only `GET /v1/me`, sign-out, step-up, the second-factor step, their compliance status and the appeal; everything else answers `403 auth.compliance_suspended`. A possible match never refuses anything.

The routes are mounted by the identity module (they share its elevation guard), like the jurisdiction routes.

SANC-006 adds the re-screen HTTP adapter and read-only list/version/freshness, exact person/company subject-state lookup and metric projections. Every new read checks the existing node staff authority before accessing RLS tables or the SECURITY DEFINER freshness function. See the [console read API and missing cohort data](../../../../../tests/web/admin/screening/README.md#read-apis-and-privacy). GET and command responses project runs without raw participant counters; progress needs ten distinct recorded people. Its deadline uses the worker's existing `RESCREEN_WINDOW_HOURS` bounds (1 to 168, default 6), never a client-supplied window. It does not expose list management or invent new permissions. The focused [console/API tests](../../../../../tests/web/admin/screening/README.md) exercise real PostgreSQL, authorization, concurrent requests, rollback and idempotent replay.

SANC-007 adds `GET /v1/admin/screening/matches/:id/appeal-assignment` under the existing elevated screening staff reader. Its current-authority projection returns appeal/original-decision ids, version, assignment time and an eligible reviewer or null, with `assigned`, `unassigned`, `unavailable` or `closed` status. Revoked roles, conflicts, subject/company membership, holds, suspension and break-glass assignments cannot become an effective reviewer. Historical snapshots remain immutable.

`POST` to the same route accepts only `expectedVersion`, nullable `reviewerId` and `reason`. An elevated independent node compliance officer can assign or explicitly leave the appeal unassigned. The command serializes on the existing subject/match locks, appends routing history, moves the current pointer and audits atomically; stale versions return `validation.revision_conflict`. To cover absent conflict/hold rows without changing other modules' writers, this short staff command takes SHARE table locks on role assignments, conflict declarations, memberships, jurisdiction holds and screening states. It uses NOWAIT: a concurrent authority writer yields a revision conflict, never an inferred permission or a lock-order cycle. These locks can reject routing during unrelated authority writes; reload and submit a fresh version. No provider runs under these locks.

Routing grants no permission to decide and is not exclusive authority: the existing appeal-decision API still checks the acting officer, elevation, original decider, subject, company/conflicts and second-person reversal rules. An eligible independent officer can resolve an unassigned appeal through that API. No automated decision or deadline is introduced. See the [SANC-007 report](../../../../../tests/web/compliance/README.md).

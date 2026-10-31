# Screening (SANC-003)

The API side of the screening engine ([ADR 014](../../../../../docs/adr/014-sanctions-compliance-engine.md) decisions 13 to 15; handbook [Sanctions compliance](../../../../../docs/engine/modules/sanctions-compliance.md); data [section 24a](../../../../../docs/data/model.md#24a-sanctions-compliance)). Screening itself runs in the worker ([`apps/worker/src/screening`](../../../../worker/src/screening/README.md)).

## Routes

| Route | Who | What |
|---|---|---|
| `GET /v1/screening/me[?companyId=]` | the subject (or an administrator of the company) | `core.compliance_status`: status words only (`OwnComplianceStatusSchema`); never a list, an entry, a matched name or a reviewer |
| `POST /v1/screening/me/appeal` | the subject, fresh step-up | `core.appeal_compliance_decision`: every confirmed match of the subject goes to `appeal` |
| `GET /v1/admin/screening/queue` | compliance staff, elevated | one item per subject waiting for a reviewer, late after `SCREENING_REVIEW_SERVICE_LEVEL_DAYS` business days (1 to 5, default 1) |
| `GET /v1/admin/screening/subjects/:stateId`, `GET /v1/admin/screening/matches/:id` | compliance staff, elevated | the entry and the screened name side by side, the decision trail and any second-person request |
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

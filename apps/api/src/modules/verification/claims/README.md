# Company claims (CLM-001)

Management access to a company page passes only through the hub's verification recipe. Design: [discovery and outreach](../../../../../../docs/engine/discovery-and-outreach.md) section 7, [ADR 026](../../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md), reference recipes in [hub administration](../../../../../../docs/engine/hub-administration.md). Database: [`migrations/claims`](../../../../../../packages/data/migrations/claims), repository [`claims.ts`](../../../../../../packages/data/src/repositories/claims.ts).

Status: claims, disputes, hand-overs, the cooling period, per-hub badges with expiry and re-checks, their routes and notices are **Live in the API**, without screens yet (HUBC-009 wires the console). Company identifiers, registrations and branches follow.

| Rule | Where it holds |
|---|---|
| A claim comes from a verified login and names an active company recipe for its level (`claim_claimed` or `claim_verified`) | `claims_submit`, `claims_recipe` |
| One open claim per page; a second claim opens a dispute and a third waits until it ends | `company_claim_open_uq`, `claims_submit` |
| A dispute is decided by two people: one reviewer proposes the outcome, a different reviewer (not a claimant) confirms; nothing is handed over by the dispute itself | `claims_propose_dispute`, `claims_confirm_dispute` |
| A claim against a page someone else runs (an active administrator or a hand-over, `claims_page_people`) aims at the verified level and waits a hub-set period (default seven days); a holder or founder claiming their own page does not wait for themselves | `claims_submit`, `claims_settings` |
| The decider is never the claimant; approval needs the recipe standing passed with nothing blocking it (company screening, an unavailable screening store) and the claimant screened clear | `claims_decide` |
| A decision counts only checks bound to this claim: a reviewer binds a check of its hub, company and recipe, recorded after the claim was submitted, and a check serves one claim only. An earlier holder's results prove nothing for a challenger | `company_claim_evidence`, `claims_bind_evidence`, `claims_evidence_passes` |
| A claim asks SANC-003 to screen the claimant and the company | `identity.company_claim_submitted` and `company.claim_submitted` (`SCREENING_TRIGGER_EVENTS`, trigger `claim`) |
| The claimed level needs a company tie: a mailbox on the company's own domain, or the reviewer's recorded register officer match; it gives limited page control and no company role | `claims_decide` |
| A mailbox tie counts only when the address is the claimant's own verified login, on a domain recorded for the company (verified domains, the website of its sourced records) and not a free mail service; a typed address proves nothing | `claims_submit`, `claims_company_domains`, `claims_free_mail_domains` |
| An invitation link is the same tie under its own name, and until OUTR-002 issues single-use tokens it needs the same proof; a link, a reply or a message alone never changes a claim or grants a role | `claims_submit` |
| The verified level gives the company administrator role (refused while the claimant works for another company) | `claims_decide` |
| A hand-over writes a `company_verification` row: what the hub stands behind, its badge categories and until when (the earliest expiry of the recipe's latest results). It is a record: only its state moves | `claims_handover_verification`, `claims_verification_guard` |
| The company's claim status is derived from the strongest active verification in the same transaction; revocation ends the role, revokes the verification and derives again; every change appends `company.verification_changed` | `claims_derive`, `claims_revoke` |
| A verification past its date lapses on the worker; the badge goes, the page stays `claimed` while someone holds it, the role stays and the holder is told | `claims_run_expiry`, `apps/worker/src/verification/claims-expiry.ts` |
| A re-check needs a reviewer who is not the holder, a passing standing and the holder screened clear, and writes a new row; a refusal changes nothing and the old date runs out | `claims_recheck` |
| A `verified` page without an active administrator falls back to `claimed` and loses its verified badge; a new verified claim restores it; companies that never went through a claim are not touched. This is a safety net: `end_membership` and the role change refuse to remove the last administrator and revocation takes the verification with the role, so today only a maintenance write reaches it | `claims_membership_ended`, `claims_derive`, `claims_public_badges` |
| A public badge shows the level, categories and dates. A category naming sanctions or screening is left out (ADR 014 decision 16) | `claims_public_badges` |
| For a hub-set cooling period (default seven days) the legal name, identifiers, verified domains and the representative cannot change | `claims_company_cooling_guard`, `claims_representative_cooling_guard` |
| Every state change raises its notice in the same transaction, whichever command made it | `claims_claim_notice`, `claims_handover_notice` |

## Routes

The claimant's own path, `/v1/claims` (a signed-in session; a mutation carries the CSRF header and an `Idempotency-Key`):

| Method and path | Use |
|---|---|
| `GET /recipes?hubId=` | The recipes a hub offers per level: steps and badge categories |
| `GET /` | The caller's claims and hand-overs, without who reviewed, the reviewer's note, a dispute's id or anything about another claimant. The same projection applies through the console when the claimant also holds a staff role, and a dispute they are a party to is hidden from them there |
| `POST /` | `{ hubId, companyId, level, recipeId, tie }`; `tie` is null or `{ kind: 'own_domain_mailbox' \| 'invitation_link', email }`. An address that proves nothing is recorded as no tie |
| `POST /:claimId/withdraw` | Withdraw; a dispute left with one claim dissolves and that claim is back in review. Another person's claim is not found |

The hub console, `/v1/admin/hubs/:hubId/claims`. Every route needs a staff role and a live elevation; a mutation also carries an `Idempotency-Key` restated in the console command and a staff reason, is authorized again by the database at the hub and audited. A row of another hub is not found.

| Method and path | Permission | Use |
|---|---|---|
| `GET /?state=` | any claims permission | Claims, disputes and the hub's periods |
| `GET /requests/:claimId` | any claims permission | One claim |
| `GET /handovers?companyId=` | any claims permission | Hand-overs of the hub or one company |
| `POST /requests/:claimId/evidence` | `admin.claims.decide` | `{ checkIds }`: binds checks to the claim |
| `POST /requests/:claimId/decide` | `admin.claims.decide` | `{ expectedRevision, decision, officerMatch, note }` |
| `POST /disputes/:disputeId/propose` | `admin.claims.decide` | `{ expectedRevision, winnerClaimId \| null, note }` |
| `POST /disputes/:disputeId/confirm` | `admin.claims.decide` | A second person confirms; `403 access.second_approver_required` for the proposer |
| `POST /handovers/:handoverId/revoke` | `admin.claims.revoke` | `{ revocationReason }` |
| `GET /verifications?companyId=&dueDays=` | any claims permission | Verifications of the hub, one company, or those lapsing within `dueDays` |
| `POST /verifications/:verificationId/recheck` | `admin.claims.decide` | `{ recipeId }`, an active recipe of the level |
| `POST /settings` | `admin.claims.policy.edit` | `{ waitingDays, coolingDays }`, each 1 to 30 |

`GET /v1/companies/:companyId/badges` needs no session and answers for the hub this API serves.

Evidence stays in the verification checks of HUB-003 (`/v1/admin/hubs/:hubId/verification`): a reviewer records them there after the claim arrives, then binds them to it. Refusals carry `details.reason` (`waiting_period`, `company_tie_required`, `evidence_required`, `evidence_mismatch`, `standing_not_passed`, `claimant_not_clear`, `own_claim`, and so on).

## Notices (COMMS-001)

Two account templates, so e-mail is never held back by preferences and an unsubscribe does not stop them. Their parameters are the public company name, one word and a date: never who claims, never a note, never evidence.

| Template | Goes to | Parameters |
|---|---|---|
| `claims.page_notice` | The page's active administrators and hand-over holders, not the claimant | `stage` (`claim_opened`, `handed_over`), `companyName`, `waitingUntil` |
| `claims.claim_update` | The claimant or holder | `outcome` (`in_dispute`, `back_in_review`, `approved`, `rejected`, `revoked`, `expired`), `companyName` |

The triggers write the bell notice and plan the e-mail (`expired` comes from the worker, where no person acts, so it stays in the bell). The API renders the hub's active text in the same transaction (`CommunicationsService.deliverPlanned`), so a crash loses neither. Without a text in a language the hub serves the delivery settles as `skipped`, as for every template. The design also asks for a notice in the page's context thread; `company` is not a context kind yet (COMMS-001), so the bell and e-mail carry it for now.

## Next

- Company identifiers, registrations, tax registrations and branches as their own records with the US worked example; payout details under the cooling lock.

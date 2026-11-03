# Company claims (CLM-001)

Management access to a company page passes only through the hub's verification recipe. Design: [discovery and outreach](../../../../../../docs/engine/discovery-and-outreach.md) section 7, [ADR 026](../../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md), reference recipes in [hub administration](../../../../../../docs/engine/hub-administration.md). Database: [`migrations/claims`](../../../../../../packages/data/migrations/claims), repository [`claims.ts`](../../../../../../packages/data/src/repositories/claims.ts).

Status: claims, disputes, hand-overs, the cooling period, their routes and notices are **Live in the API**, without screens yet (HUBC-009 wires the console). Company identifiers, registrations, branches and per-hub badges follow.

| Rule | Where it holds |
|---|---|
| A claim comes from a verified login and names an active company recipe for its level (`claim_claimed` or `claim_verified`) | `claims_submit`, `claims_recipe` |
| One open claim per page; a second claim opens a dispute and a third waits until it ends | `company_claim_open_uq`, `claims_submit` |
| A dispute is decided by two people: one reviewer proposes the outcome, a different reviewer (not a claimant) confirms; nothing is handed over by the dispute itself | `claims_propose_dispute`, `claims_confirm_dispute` |
| A claim against a page someone else holds aims at the verified level and waits a hub-set period (default seven days); a holder moving from claimed to verified does not wait for themselves | `claims_submit`, `claims_settings` |
| The decider is never the claimant; approval needs the recipe standing passed with nothing blocking it (company screening, an unavailable screening store) and the claimant screened clear | `claims_decide` |
| A claim asks SANC-003 to screen the claimant and the company | `identity.company_claim_submitted` and `company.claim_submitted` (`SCREENING_TRIGGER_EVENTS`, trigger `claim`) |
| The claimed level needs a company tie: a mailbox on the company's own domain, or the reviewer's recorded register officer match; it gives limited page control and no company role | `claims_decide` |
| A mailbox tie counts only when the address is the claimant's own verified login, on a domain recorded for the company (verified domains, the website of its sourced records) and not a free mail service; a typed address proves nothing | `claims_submit`, `claims_company_domains`, `claims_free_mail_domains` |
| An invitation link is the same tie under its own name, and until OUTR-002 issues single-use tokens it needs the same proof; a link, a reply or a message alone never changes a claim or grants a role | `claims_submit` |
| The verified level gives the company administrator role (refused while the claimant works for another company) | `claims_decide` |
| The company's claim status is derived from the strongest active hand-over in the same transaction; revocation ends the role and derives again | `claims_derive`, `claims_revoke` |
| For a hub-set cooling period (default seven days) the legal name, identifiers, verified domains and the representative cannot change | `claims_company_cooling_guard`, `claims_representative_cooling_guard` |
| Every state change raises its notice in the same transaction, whichever command made it | `claims_claim_notice`, `claims_handover_notice` |

## Routes

The claimant's own path, `/v1/claims` (a signed-in session; a mutation carries the CSRF header and an `Idempotency-Key`):

| Method and path | Use |
|---|---|
| `GET /recipes?hubId=` | The recipes a hub offers per level: steps and badge categories |
| `GET /` | The caller's claims and hand-overs. A claimant never sees who reviewed, the reviewer's note, a dispute's id or anything about another claimant |
| `POST /` | `{ hubId, companyId, level, recipeId, tie }`; `tie` is null or `{ kind: 'own_domain_mailbox' \| 'invitation_link', email }`. An address that proves nothing is recorded as no tie |
| `POST /:claimId/withdraw` | Withdraw; a dispute left with one claim dissolves and that claim is back in review. Another person's claim is not found |

The hub console, `/v1/admin/hubs/:hubId/claims`. Every route needs a staff role and a live elevation; a mutation also carries an `Idempotency-Key` restated in the console command and a staff reason, is authorized again by the database at the hub and audited. A row of another hub is not found.

| Method and path | Permission | Use |
|---|---|---|
| `GET /?state=` | any claims permission | Claims, disputes and the hub's periods |
| `GET /requests/:claimId` | any claims permission | One claim |
| `GET /handovers?companyId=` | any claims permission | Hand-overs of the hub or one company |
| `POST /requests/:claimId/decide` | `admin.claims.decide` | `{ expectedRevision, decision, officerMatch, note }` |
| `POST /disputes/:disputeId/propose` | `admin.claims.decide` | `{ expectedRevision, winnerClaimId \| null, note }` |
| `POST /disputes/:disputeId/confirm` | `admin.claims.decide` | A second person confirms; `403 access.second_approver_required` for the proposer |
| `POST /handovers/:handoverId/revoke` | `admin.claims.revoke` | `{ revocationReason }` |
| `POST /settings` | `admin.claims.policy.edit` | `{ waitingDays, coolingDays }`, each 1 to 30 |

Evidence stays in the verification checks of HUB-003 (`/v1/admin/hubs/:hubId/verification`); a reviewer reads the standing there before deciding. Refusals carry `details.reason` (`waiting_period`, `company_tie_required`, `standing_not_passed`, `claimant_not_clear`, `own_claim`, and so on).

## Notices (COMMS-001)

Two account templates, so e-mail is never held back by preferences and an unsubscribe does not stop them. Their parameters are the public company name, one word and a date: never who claims, never a note, never evidence.

| Template | Goes to | Parameters |
|---|---|---|
| `claims.page_notice` | The page's active administrators and hand-over holders, not the claimant | `stage` (`claim_opened`, `handed_over`), `companyName`, `waitingUntil` |
| `claims.claim_update` | The claimant or holder | `outcome` (`in_dispute`, `back_in_review`, `approved`, `rejected`, `revoked`), `companyName` |

The triggers write the bell notice and plan the e-mail. The API renders the hub's active text in the same transaction (`CommunicationsService.deliverPlanned`), so a crash loses neither. Without a text in a language the hub serves the delivery settles as `skipped`, as for every template. The design also asks for a notice in the page's context thread; `company` is not a context kind yet (COMMS-001), so the bell and e-mail carry it for now.

## Next

- Company identifiers, registrations, tax registrations and branches as their own records with the US worked example; per-hub badges with expiry and re-checks; payout details under the cooling lock.
- Recovery when the last administrator leaves.

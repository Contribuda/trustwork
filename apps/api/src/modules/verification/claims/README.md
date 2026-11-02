# Company claims (CLM-001)

Management access to a company page passes only through the hub's verification recipe. Design: [discovery and outreach](../../../../../../docs/engine/discovery-and-outreach.md) section 7, [ADR 026](../../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md), reference recipes in [hub administration](../../../../../../docs/engine/hub-administration.md). Database: [`migrations/claims`](../../../../../../packages/data/migrations/claims), repository [`claims.ts`](../../../../../../packages/data/src/repositories/claims.ts).

Status: claims, disputes, hand-overs and the cooling period are **Live in the database** (part 1). Routes, notices to current administrators, and company identifiers, registrations and branches as their own records follow.

| Rule | Where it holds |
|---|---|
| A claim comes from a verified login and names an active company recipe for its level (`claim_claimed` or `claim_verified`) | `claims_submit`, `claims_recipe` |
| One open claim per page; a second claim opens a dispute and a third waits until it ends | `company_claim_open_uq`, `claims_submit` |
| A dispute is decided by two people: one reviewer proposes the outcome, a different reviewer (not a claimant) confirms; nothing is handed over by the dispute itself | `claims_propose_dispute`, `claims_confirm_dispute` |
| A claim against a claimed or verified page aims at the verified level and waits a hub-set period (default seven days) | `claims_submit`, `claims_settings` |
| The decider is never the claimant; approval needs the recipe standing passed with nothing blocking it (company screening, an unavailable screening store) and the claimant screened clear | `claims_decide` |
| The claimed level needs a domain tie: an accepted invitation link, or the reviewer's recorded register officer match; it gives limited page control and no company role | `claims_decide` |
| An invitation link counts only when its address is on a domain recorded for the company (verified domains, the website of its sourced records) and not a free mail service; a link, a reply or a message alone never changes a claim or grants a role | `claims_submit`, `claims_company_domains`, `claims_free_mail_domains` |
| The verified level gives the company administrator role (refused while the claimant works for another company) | `claims_decide` |
| The company's claim status is derived from the strongest active hand-over in the same transaction; revocation ends the role and derives again | `claims_derive`, `claims_revoke` |
| For a hub-set cooling period (default seven days) the legal name, identifiers, verified domains and the representative cannot change | `claims_company_cooling_guard`, `claims_representative_cooling_guard` |

## Next

- Console and claimant routes; notices to current administrators when a claim arrives against a managed page (COMMS-001).
- Company identifiers, registrations, tax registrations and branches as their own records with the US worked example; payout details under the cooling lock.
- Recovery when the last administrator leaves.

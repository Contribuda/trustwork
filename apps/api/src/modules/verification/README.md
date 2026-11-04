# Verification module (HUB-003)

Counterparty verification for the hub console: providers, recipes, check results and a subject's standing. Design: [Hub administration, "Verification"](../../../../../docs/engine/hub-administration.md); people: [ADR 026](../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md) decision 6; sanctions: [ADR 014](../../../../../docs/adr/014-sanctions-compliance-engine.md).

Storage: [`packages/data/migrations/verification`](../../../../../packages/data/migrations/verification), [`packages/data/src/repositories/verification.ts`](../../../../../packages/data/src/repositories/verification.ts).

## Rules

- **Providers.** A provider starts in `fake` or `manual` mode. `live` needs a credential reference of the hub (KEYS-001) and consumes a different person's approval (`providers.enable_non_fake`) of exactly that provider version (`GET .../providers/:id/live-digest`).
- **Recipes.** Recipes are immutable versions per key. Every version carries `sanctions_screening` as a required step, and no version can drop it. No check repeats. Activation supersedes the active version.
- **Results.** Check results are append-only evidence references, never documents, with an expiry from the recipe's re-check period. A person records only fake or manual results; live results come from the adapter.
- **The sanctions check** keeps no lists and decides no match. It records a reference to the SANC-003 subject state and passes only when screening is available and the subject is neither held nor suspended. It is never `fail`.
- **Standing** (`GET .../standing`) re-reads screening. An unscreened subject, a possible match, a hold or an unavailable screening store blocks every hand-over, whatever the other checks say. Badges show categories only.
- **Appeals.** Only a non-sanctions result that is not a pass is appealable here; sanctions matches are decided and appealed in SANC-003. One open appeal per result. A trust reviewer decides, but never the person who recorded the result and never the filer. Overturning records a new passing result with an evidence reference, and the original stays. A decision is final and audited.
- **Authority.** Every route needs a staff role and a live elevation. Mutations carry the CSRF header, an `Idempotency-Key` restated in the body (in-transaction completion, BE-005) and a staff reason, and are authorized again by the database at the hub: `admin.claims.policy.edit` for providers and recipes, `admin.claims.decide` for results. Staff of the hub with a claims permission read; anyone else finds nothing.

## Routes (`/v1/admin/hubs/:hubId/verification`)

| Method and path | Use |
|---|---|
| `GET /` | Providers and recipes |
| `GET /standing?subjectKind&subjectId&recipeId` | A subject's standing under a recipe |
| `GET /subjects/:kind/:id/checks` | Check results of a subject |
| `GET /providers/:id/live-digest?credentialRefId` | The digest a second person approves |
| `POST /providers` | Register a fake or manual provider |
| `POST /providers/:id/live` | Live mode with a credential reference and the approval |
| `POST /recipes`, `POST /recipes/:id/activate` | Draft and activate a recipe version |
| `POST /checks`, `POST /checks/screening` | Record a result; record the sanctions check from SANC-003 |
| `GET /rechecks?days` | Results that expire soon: manual ones wait for a reviewer, fake ones the worker re-checks |
| `GET /appeals`, `POST /appeals/:id/decide` | Appeals of the hub; uphold or overturn (overturning records a new passing result with its evidence) |

The subject's own path (`/v1/verification`, a signed-in session):

| Method and path | Use |
|---|---|
| `POST /checks/:checkId/appeals` | A person appeals an adverse result about themselves, or an active company administrator appeals one about the company; anyone else finds nothing |
| `GET /appeals` | The caller's own appeals |

## Re-checks (worker)

`apps/worker/src/verification/recheck.ts` runs every hour and takes the results that expire within a week:
- a **fake** provider repeats its deterministic answer, recorded with no person as author;
- a **manual** result waits for a reviewer (`GET /rechecks`);
- a **live** provider without an adapter is reported, never guessed;
- the **sanctions** check is re-screened by SANC-003.

A result replaced in the meantime is skipped.

## Later

- Live register and licence adapters per country, with the country packs (the reference recipes name the candidate registers).
- Console screens for checks, standing and appeals (HC-23 reads and configures providers and recipes on these routes, HUBC-007; the claim and appeal queues still show fixtures).
- Notices to the subject when an appeal is decided (COMMS-001).

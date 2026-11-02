# Verification module (HUB-003)

Counterparty verification for the hub console: providers, recipes, check results and a subject's standing. Design: [Hub administration, "Verification"](../../../../../docs/engine/hub-administration.md); people: [ADR 026](../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md) decision 6; sanctions: [ADR 014](../../../../../docs/adr/014-sanctions-compliance-engine.md).

Storage: [`packages/data/migrations/verification`](../../../../../packages/data/migrations/verification), [`packages/data/src/repositories/verification.ts`](../../../../../packages/data/src/repositories/verification.ts).

## Rules

- **Providers.** A provider starts in `fake` or `manual` mode. `live` needs a credential reference of the hub (KEYS-001) and consumes a different person's approval (`providers.enable_non_fake`) of exactly that provider version (`GET .../providers/:id/live-digest`).
- **Recipes.** Recipes are immutable versions per key. Every version carries `sanctions_screening` as a required step, and no version can drop it. No check repeats. Activation supersedes the active version.
- **Results.** Check results are append-only evidence references, never documents, with an expiry from the recipe's re-check period. A person records only fake or manual results; live results come from the adapter.
- **The sanctions check** keeps no lists and decides no match. It records a reference to the SANC-003 subject state and passes only when screening is available and the subject is neither held nor suspended. It is never `fail`.
- **Standing** (`GET .../standing`) re-reads screening. An unscreened subject, a possible match, a hold or an unavailable screening store blocks every hand-over, whatever the other checks say. Badges show categories only.
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

## Not yet (HUB-003 continues)

- Deterministic fake adapters run by the worker.
- Live adapters.
- Review cases and appeals decided by a different reviewer.
- Re-check scheduling in the worker (the list is `verification_due_rechecks`).
- Console screens on these routes (HUBC-004 shows fixtures).

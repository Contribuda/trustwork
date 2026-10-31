# Catalogue module (COM-001)

Reusable, versioned offerings of a person or a company: goods, works, services and bundles ([Catalogue and manufacturer knowledge](../../../../../docs/engine/modules/catalogue-and-manufacturer-knowledge.md), CAT-F01, CAT-F02, CAT-F16). Contracts: the frozen [`catalogue.ts`](../../../../../packages/contracts/src/catalogue.ts) plus [`commerce.ts`](../../../../../packages/contracts/src/commerce.ts). Storage: [`packages/data/migrations/commerce`](../../../../../packages/data/migrations/commerce). Shared plumbing (mandate port, error mapping) comes from [`../procurement`](../procurement/README.md).

## Rules

- The owner side is the owner person or members of the owner company holding `company.catalogue.edit`; everyone else gets the public projection of an active offering or `404`.
- A published version is immutable for every role (`reject_update_when_frozen`); an edit opens the next version (`POST /v1/catalogue/:id/versions`) and publishing it supersedes the previous one. A quote line that cites version N copies its specification (`offeringQuoteSnapshot`) and keeps citing exactly what N said; `GET /v1/catalogue/:id?version=N` still returns N's public fields.
- Bundles list exact published component versions; the components are materialised into `bundle_component` at publication and never change.
- Private commercial knowledge (cost basis, margin target, notes) is a separate record per version, editable after publication, and never part of a public, shared or event payload.
- The public catalogue (`GET /v1/catalogue?ownerKind=&ownerId=`, anonymous callers included) is filtered in the database to the allowlisted fields of published versions of active offerings and ordered newest first, then by id: payment cannot reorder it.

## Routes

`POST /v1/catalogue` (create with draft version 1), `GET /v1/catalogue/:id`, `POST /v1/catalogue/:id/versions` (open the next draft), `POST /v1/catalogue/:id/versions/:versionId` (save the draft), `POST .../private` (private knowledge), `POST .../publish`, `POST /v1/catalogue/:id/archive`. Writes carry the envelope `expectedRevision`, a session, the CSRF header and an `Idempotency-Key`, and complete in their own transaction (BE-005).

## Agents

Drafting and private knowledge need a `prepare` mandate, publishing a `publish` mandate (`profile_keeper.*` entries in `COMMERCE_CAPABILITIES`); the default port refuses every agent request.

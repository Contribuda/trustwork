# Projects module (BE-001)

Projects are first-class (R04): exactly one owner, person XOR company; creator and leader are distinct roles that transfer nothing; private by default; publication is an allowlisted projection. The module depends on the identity module for the principal, the policy and the participation commands; it writes only `project`, `ownership_transfer`, `leadership_assignment`, `object_participation`, `audit_event` and `outbox_event`.

All mutations: authenticated session, `X-Trustwork-Request` + same-origin metadata, `Idempotency-Key`; versioned commands carry `expectedRevision`. Errors use the contract envelope.

## Create

`POST /v1/projects` with `CreateProjectCommand`:

```json
{ "owner": { "kind": "person", "id": "<own person id>" }, "name": "Летний дом", "summary": "Частная стройка", "leaderPersonId": null }
```

-> `201 Project` (owner_private). A personal project is owned by its creator; a company project requires an active membership in the owner company with `company.deals.manage`. The owner participation row (`side: owner`, every non-staff capability, `owner_private`) is materialised in the same transaction; a leader distinct from the owner receives a `participant` row with `read.shared` + `lead` (shared_party) and a `leadership_assignment` row.

## Read

`GET /v1/projects/:id` -> `{ "projection": "owner_private" | "shared_party" | "public", "project": … }` chosen by the highest readable layer:

- `public` (`PublicProject`: `id`, `name`, `summary`, `status`, `publishedStory`, `openNeedIds`, `publicParticipantIds`) for anonymous callers and anyone without a grant, only when `publicity.enabled`; otherwise `404 access.not_found`. Private notes, budgets, private files, participant list, baseline, milestones, shared files, owner and leader are absent.
- `shared_party` (`ParticipantProject`: public fields + `owner`, `leaderPersonId`, shared milestones without budgets, `sharedFiles`) for scoped participants (person party, or company party through `company.deals.manage`).
- `owner_private` (`Project`) for the owner party and members of the owner company holding `company.deals.manage`.

Example public projection:

```json
{ "projection": "public", "project": { "id": "…", "name": "Фасады: общественный проект", "summary": "Строим", "status": "planned", "publishedStory": "Опубликованная история", "openNeedIds": [], "publicParticipantIds": [] } }
```

## Commands

| Route | Body | Authority | Result |
|---|---|---|---|
| `POST /v1/projects/:id/publish` | `PublishProjectCommand` (`openNeedIds` must be `[]` until the procurement slice) | `publish` (owner; company owner needs `company.publish`), verified primary e-mail | `Project` |
| `POST /v1/projects/:id/leader` | `AssignLeaderCommand` | `manage_participants` | `Project`; previous leader row revoked, new leader row granted |
| `POST /v1/projects/:id/transfers` | `TransferOwnershipCommand` | `transfer_ownership`, step-up | `201 OwnershipTransfer` (`proposed`, 14-day expiry) |
| `POST …/transfers/:transferId/consent` / `reject` | – | recipient person, or an administrator of the recipient company (step-up for consent) | `OwnershipTransfer` |
| `POST …/transfers/:transferId/withdraw` | – | proposer | `OwnershipTransfer` |
| `POST …/transfers/:transferId/apply` | – | current owner, step-up; `409 commercial.transfer_consent_pending` without consent | `Project` with the new owner; `trustwork.finalize_ownership_transfer` applies the transfer, revokes the old owner row and materialises the new one; the former owner loses access immediately; the project admission scope is revoked |
| `GET /v1/projects/:id/participants` | – | `read.owner_private` | `{ "items": ObjectParticipation[] }` |
| `POST /v1/projects/:id/participants` | `{ "party": Party, "side": "buyer"\|"seller"\|"participant", "capabilities": Capability[], "audience": GrantAudience, "validUntil": timestamp\|null }` | `manage_participants`; `canGrant` no-amplification (`403 access.forbidden`); `transfer_ownership` is never granted | `201 ObjectParticipation` |
| `POST …/participants/:participationId/revoke` | `{ "expectedRevision", "reason" }` | manager, or the party itself; the live owner row is protected (`403`) | `ObjectParticipation`; admission scopes of the party and the project revoked, mandate hook called |

Every command writes an `audit_event` (actor, object, request id, basis) and an `outbox_event` in the same transaction.

## Not in this slice

Milestones, budgets, shared/private files, open needs and public participant lists have no persistence yet (DATA-001 scope); the serializers emit empty lists so the contract shapes stay stable. Residual read-only access for former owners/members is not implemented (H09). Company creation / claim flows wait for the claim policy (O05); the dev seed creates companies through maintenance.

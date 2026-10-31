# Profiles module (PPL-001)

Profiles, consent records, portraits and experience: every person gets a lifelong public profile that exists only with their consent, and every public mention of a person needs a recorded consent ([ADR 010](../../../../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decision 18, [data model section 4](../../../../../docs/data/model.md#4-people-and-profiles)). Contract: [`packages/contracts/src/profiles.ts`](../../../../../packages/contracts/src/profiles.ts). Storage: [`packages/data/migrations/profiles`](../../../../../packages/data/migrations/profiles), [`packages/data/src/repositories/profiles.ts`](../../../../../packages/data/src/repositories/profiles.ts). Narrative: [People and companies](../../../../../docs/engine/people-and-companies.md).

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key`. Every route completes its idempotency record inside its own request transaction (`in_transaction` in `apps/api/src/common/idempotency/routes.ts`) and is crash-tested in `tests/backend/idempotency/crash.test.ts`. Errors use the contract envelope; profile-specific reasons are in `details.reason`.

## Rules

- **Own rows only.** Every profile table is under FORCE RLS and readable and writable only by its person. Employers, colleagues (whatever their company permissions), other people and anonymous callers read nothing: a foreign id is "not found".
- **No consent, no public link.** A profile is public only with a live `profile_public` consent (`POST /v1/me/profile/visibility`); the database refuses the switch without it. A company page lists a member only with a live `listed_by_company` consent naming that company and an active membership; a publication links a mention only with a live `mentioned_in_publication` consent naming it (`trustwork.profiles_consented_mentions`, for the content module).
- **Consent records are explicit, versioned and revocable.** Evidence is the person's first-party form (request id); the notice version belongs to the purpose and must be the current one (`notice_outdated` otherwise); a record is never rewritten, and its one change is the withdrawal. Agents never give or withdraw consent (`access.mandate_scope`).
- **Withdrawal unpublishes in the same transaction.** A database trigger hides the dependent projection (the profile goes private, a portrait is withdrawn, a listing or mention disappears from the public functions) and writes a `profile_tombstone` plus an identifiers-only `profile.projection_withdrawn` outbox event for search, retrieval, federation and caches. Revoking a media licence and replacing or removing a portrait do the same.
- **Portraits need consent and a licence.** A portrait is shown only with a live `portrait_display` consent of the person, a live media licence on the same file and the person's own clean, public image attached to their page (JPEG, PNG or WebP). FILE-001 quarantines public images that carry location metadata, so such a file is never shown; a derived public copy without location is a follow-up for the files worker.
- **Experience belongs to the person.** Entries reference no membership and survive every change of employer. They are labelled `self_declared` until a company confirmation is recorded; the runtime role can never set a confirmation (REP-001 owns confirmation requests), and editing the confirmed facts clears it.
- **Attention stays private.** Bookmarks, follows, reading progress and preferences are the person's own and are deliberately neither audited nor announced, so no behaviour log exists for an employer or anyone else to read.

## Routes

| Route | Result |
|---|---|
| `GET /v1/me/profile` | `MyProfileView`: identity part, profile, consents, licences, portraits, experience, the exact public preview and the current notice versions |
| `POST /v1/me/profile` | `SaveProfileCommand` with `expectedRevision` (`null` for the first save); two editors: one wins, the other `409 validation.revision_conflict`; restricted places refused |
| `POST /v1/me/profile/visibility` | `{ visibility: 'public', noticeVersion }` records the consent and publishes; `{ visibility: 'private' }` withdraws it and unpublishes |
| `GET/POST /v1/me/consents`, `POST /v1/me/consents/:id/withdraw` | Grant (current notice, target required by the purpose) and withdraw; `profile_public` goes through the visibility route |
| `POST /v1/me/media-licences`, `POST /v1/me/media-licences/:id/revoke` | Licence records for the person's own files; terms are immutable, revocation is final |
| `POST /v1/me/portrait`, `POST /v1/me/portraits/:id/remove` | Shows a portrait (a previous one is replaced in the same transaction); removal leaves a tombstone |
| `GET/POST /v1/me/experience`, `POST /v1/me/experience/:id`, `POST /v1/me/experience/:id/archive` | Self-declared entries with `expectedRevision`; archiving is final |
| `GET/POST /v1/me/preferences`, `GET/POST /v1/me/follows`, `POST /v1/me/follows/:id/end`, `GET/POST /v1/me/bookmarks`, `POST /v1/me/bookmarks/:id/remove`, `GET/POST /v1/me/reading-progress` | Private records; following a person needs their public, consented profile |
| `GET /v1/people/:id/profile`, `GET /v1/people/by-handle/:handle/profile` | `PublicPersonProfile` (allowlisted, identical for every caller) or `404` |
| `GET /v1/companies/:id/people` | People who consented to be listed by that company and keep a public profile |

## Agents

Profile edits and experience are `commit` capabilities under a `maintain_profile` mandate; visibility, consent and portraits are `govern` capabilities on the first-party form. The `ProfileMandatePort` decides; the default `NoProfileMandates` refuses every delegated request until the mandate store exists. Registry entries: `PROFILE_KEEPER_MANIFEST` (module `profile_keeper`, ADR 010 decision 23).

## Tests

`tests/contracts/profiles.test.ts` (contracts, serializer, manifest), `tests/profiles/database.test.ts` (RLS, guards, unpublication, concurrency under the runtime role), `tests/profiles/api.test.ts` (HTTP with negative authorization for anonymous callers, other people, employers and colleagues).

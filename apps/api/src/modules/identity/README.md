# Identity module (BE-001)

Classic e-mail/password authentication, opaque PostgreSQL sessions, recovery, Google/Apple linking by `(provider, subject)`, per-request principal resolution, company memberships and the in-process object policy. Every request body, query and path parameter set is validated against the frozen Zod contracts (`packages/contracts`); every failure is the contract error envelope with the fixed HTTP status (`httpStatusFor`). Russian product copy is a web concern (`ru.error.<code>`); this module emits English machine codes only.

## Environment

Nothing is read from `.env` implicitly. `DATABASE_URL` (migrator/superuser) is used by migrations and the dev seed; the API itself must connect as a restricted runtime login (member of `trustwork_app`) and refuses a superuser/BYPASSRLS role at startup.

| Variable | Default | Meaning |
|---|---|---|
| `API_DATABASE_URL` | falls back to `DATABASE_URL` | Runtime connection (restricted role). Without any URL only the health routes are served (`/health/ready` answers 503). |
| `API_HOST`, `API_PORT` | `127.0.0.1`, `3001` | Bind address. |
| `PUBLIC_ORIGIN` | `http://<host>:<port>` | Exact origin the browser loads the app from; mutations prove same-origin against it; provider redirect URIs derive from it. Required and `https` with `NODE_ENV=production`. |
| `AUTH_RETURN_PATH` | `/` | Where provider callbacks redirect (`?auth=<outcome>`). |
| `API_INSECURE_COOKIES` | `false` | Drops `__Host-` and `Secure` for plain-HTTP hosts other than localhost; refused with `NODE_ENV=production`. |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `SESSION_STEP_UP_MINUTES` | `30`, `12`, `10` | Session windows (integrator defaults; H02 still open). |
| `PASSWORD_MIN_LENGTH`, `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | `15`, `19456`, `2`, `1` | Password policy (H01) and Argon2id parameters; hashes are upgraded on login. |
| `TOKEN_VERIFY_EMAIL_HOURS`, `TOKEN_RECOVERY_MINUTES`, `TOKEN_EMAIL_CHANGE_HOURS`, `TOKEN_INVITATION_DAYS` | `24`, `30`, `24`, `7` | Single-use token lifetimes. |
| `AUTH_LOCKOUT_THRESHOLD`, `AUTH_LOCKOUT_WINDOW_MINUTES`, `AUTH_LOCKOUT_IP_THRESHOLD`, `AUTH_DISABLE_THRESHOLD` | `5`, `15`, `50`, `100` | H03: from the account threshold on, each further attempt waits a delay that doubles per failure (30 s base, capped at the window) and the owner is notified once; per-IP failures inside the window answer `auth.throttled`. Failures never disable a password (BE-002); `AUTH_DISABLE_THRESHOLD` is no longer used. |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `60` | `@fastify/rate-limit` per client address on `/v1/auth/*` (process-local burst protection; answers 429 `auth.throttled`). |
| `IDEMPOTENCY_RETENTION_HOURS` | `24` | `idempotency_record` retention. |
| `AUTH_PROVIDER_MODE` | `disabled` | `disabled`: provider routes answer 404 and `/health.externalProviders` says `disabled`; `fake`: scriptable adapters (`POST /v1/auth/:provider/fake-identity`, loopback callers only, refused with `NODE_ENV=production`); `live`: openid-client adapters with `GOOGLE_CLIENT_ID/SECRET`, `APPLE_CLIENT_ID/SECRET` (never used by tests or checks). `/health.externalProviders` reports the mode truthfully (`disabled` \| `fake` \| `live`, `HealthSchema`). |
| `AUTH_FLOW_SECRET` | random per process (development only) | Hex key (>= 32 bytes) signing the pre-login flow cookie; required with `NODE_ENV=production` (the process refuses to boot without it). |
| `API_LOG_MAIL` | unset | `1` prints fake outbound mail (verification/recovery tokens) to stdout in fake mode (local only). |
| `API_TRUSTED_PROXY_HOPS`, `API_TRUSTED_PROXIES` | `0`, unset | Which `X-Forwarded-For` hops are trusted for the client address (rate limits, lockout, session list): by default none (the socket peer); set the number of proxies in front of the API or their addresses/CIDRs, not both. The former trust-all `API_TRUST_PROXY` is refused. |

Pool limits, structured logs, readiness, telemetry and security headers (`API_DB_*`, `API_LOG_*`, `API_READINESS_*`, `OTEL_*`, `API_HSTS_MAX_AGE_SECONDS`) are listed in the repository `.env.example` (OPS-001).

Sweeper (bounded tables): scheduled by `apps/worker` (`trustwork.worker_sweep_expired()`); the manual `DATABASE_URL=<migrator> npm run sweep -w @trustwork/api` runs in a maintenance transaction (the API role may not run it since BE-002) and deletes expired/consumed tokens, expired login failures and idempotency records, settled admission leases past the grace period, old revoked sessions and never-verified signups older than seven days; `login_failure` is additionally capped at 10,000 rows in the database.

Local stand: `npm run infra:up`, `DATABASE_URL=postgresql://trustwork_dev:local_only_change_me@localhost:54329/trustwork_dev npm run db:migrate`, `DATABASE_URL=... npm run seed:dev -w @trustwork/api` (prints personas and `apiDatabaseUrl`), then `API_DATABASE_URL=<printed> AUTH_PROVIDER_MODE=fake API_LOG_MAIL=1 npm run dev:api`.

## Transport rules

- Session cookie `__Host-sr_session` (`SESSION_COOKIE`): 256-bit random token, SHA-256 stored, `HttpOnly; Secure; SameSite=Lax; Path=/`. No session before e-mail verification. Pre-login provider flow state lives in the HMAC-signed `__Host-sr_flow` cookie (10 minutes).
- Mutations require `X-Trustwork-Request: 1` **and** `Sec-Fetch-Site: same-origin` (or, without fetch metadata, `Origin`/`Referer` equal to `PUBLIC_ORIGIN`); otherwise `auth.csrf_rejected`. Provider callbacks (`GET`) are exempt and protected by `state` + the flow cookie.
- Authenticated mutations require `Idempotency-Key`; scope `(principalId, action, contextId, key)` with the canonical payload digest: replay returns the recorded status and body, a different payload is `validation.idempotency_conflict`, an unfinished first execution `validation.idempotency_in_progress`.
- Versioned edits send `expectedRevision`; a mismatch is `validation.revision_conflict`.
- `X-Request-Id` is echoed (or generated) on every response and inside the error envelope; `Cache-Control: no-store` on `/v1/*`.
- Login, step-up and password change share the H03 lockout: the per-account progressive delay and the per-IP count answer `auth.throttled` (with `retryAfterSeconds`) before any password verification; a successful sign-in, step-up, password change or recovery clears the account counter.
- Step-up (`auth.step_up_required`, 403) protects: revoke-others, password/e-mail change, provider link/unlink, invitations, role changes, membership end, transfer proposals/consent/apply.

## Endpoints and examples

`POST /v1/auth/signup` -> `202 { "status": "verification_sent" }` for new and existing addresses alike (the mailbox receives either the verification link or an "already registered" notice).

```json
{ "name": "Peter", "email": "petr@example.invalid", "password": "correct horse battery staple 42", "acceptedTermsVersion": "draft-2026-10" }
```

`POST /v1/auth/verify-email { "token": "<from mail>" }` -> `200 { "status": "verified", "personId": "…", "email": "petr@example.invalid" }` + `Set-Cookie: __Host-sr_session=…`. Sessions, tokens and provider links created before verification are revoked (pre-hijack defence). The same route completes e-mail changes.

`POST /v1/auth/login { "email", "password" }` -> `200 { "status": "authenticated", "personId": "…" }` + cookie; `401 auth.invalid_credentials` for unknown address, wrong password, unverified or disabled credential (identical body); `429 auth.throttled` after the lockout threshold without verifying.

`POST /v1/auth/logout` -> `204` (cookie cleared). `POST /v1/auth/recovery { "email" }` -> `202 { "status": "recovery_sent" }` always. `POST /v1/auth/recovery/complete { "token", "newPassword" }` -> `200 { "status": "password_reset" }`, every session revoked, no auto-login. `POST /v1/auth/step-up { "password" }` -> `200 { "status": "authenticated", "authenticatedAt": "…" }`.

`GET /v1/me` -> `{ "person": Person, "principal": Principal }` (owner_private: bindings, provider identities, preferences; never a token hash). `GET /v1/me/sessions` -> `{ "items": SessionView[], "currentSessionId" }`. `POST /v1/me/sessions/revoke { "sessionId" }` -> `204`. `POST /v1/me/sessions/revoke-others` -> `{ "revoked": n }`. `POST /v1/me/password { "currentPassword", "newPassword" }` -> `204` (other sessions revoked). `POST /v1/me/email { "newEmail" }` -> `202`.

Providers: `POST /v1/auth/google/start` or `/v1/auth/apple/start` -> `{ "authorizationUrl" }` + flow cookie; the provider returns to `GET /v1/auth/:provider/callback?code&state` -> `303` to `AUTH_RETURN_PATH?auth=signed_in|verification_pending|account_exists|email_required|provider_unavailable|linked|already_linked`. Rules: identity is `(provider, subject)`; a matching e-mail never auto-links (`account_exists`, no session); Google `email_verified: true` binds the address as verified and may claim an **unverified** binding (the pre-registered person's password and tokens are invalidated); Apple and unverified Google addresses stay unverified until our own verification. `POST /v1/auth/link/start { "provider" }` (step-up, verified primary address) links; `POST /v1/auth/unlink { "provider" }` refuses to leave the person without a credential. In fake mode `POST /v1/auth/:provider/fake-identity { "subject", "email", "emailVerified", "name" }` scripts the next callback.

`GET /v1/people/:id` -> `PublicPerson` for `profileVisibility: public`, else `404`. `GET /v1/companies/:id` -> `{ "company": PublicCompany, "privateView": { internalNotes, billingAccountId, verifiedDomains } | null, "membership": Membership | null }` (private view only for active members).

Memberships (`/v1/companies/:id/memberships`): `GET` (active members), `POST InviteMemberCommand` -> `202 { "status": "invited" }` regardless of whether the address belongs to a verified account (the invitee receives `membershipId` + token), `POST …/accept AcceptMembershipCommand` -> `Membership` (`409 membership.already_employed` while another employer is active), `POST …/change ChangeMembershipCommand` (never oneself; `409 membership.last_administrator`), `POST …/end EndMembershipCommand` -> `{ "membership", "revokedParticipations", "revokedGrants", "admissionEpoch" }`: the owner-run `trustwork.end_membership` ends the row, revokes company-derived participations and company-scoped permission grants, bumps both authorization epochs, revokes the person's admission scope, and the mandate hook is called; identity, sessions and own public contributions survive.

## Principal resolution and policy

Each request: cookie -> `auth_lookup_session(hash)` -> idle/absolute/revocation check -> one `withPrincipal` transaction loading the person, the active employer membership with permissions and both epochs (`Principal` contract), touching `lastSeenAt` at most every five minutes. The database verifies the identity: `trustwork.set_principal` stores an HMAC over `(person, company, epoch, backend pid, transaction start)` with an owner-only secret and `trustwork.verify_person_id()` recomputes it, so a forged `set_config('trustwork.person_id', …)` has no identity. A stale epoch (authority changed) re-resolves the principal once and retries.

`policy/policy.ts` implements the frozen `PolicyDecision`: deny by default; `read.public` only for published projections; owner (person, or company through the membership permission); participation rows (company parties additionally need the permission: `company.publish` for `publish`, `company.deals.manage` for everything else); a delegated principal is denied (`mandate_scope`) until mandates exist; staff without a case grant see nothing. Decisions are cached per `PolicyCacheKey` (person and company epochs + resource revision) for at most 60 s or the nearest `validUntil`; a bump is a miss. Grants pass `canGrant` (no amplification) at the command layer; the owner row is never granted or revoked directly (ownership transfer only).

## Hardening (BE-002)

- **One transaction per identity change.** Sign-up, verification, login, failed login, lockout, recovery request and completion, and the provider events (first sign-in, H06 claim, sign-in, link, unlink) write their audit rows and outbox intents in the transaction of the change (`journal.ts`); pre-identity definer calls run inside it and `assumePrincipal` sets the identity afterwards. Mail still leaves through the `MailPort` after COMMIT until MAIL-001. Outbox types: `identity.person_registered`, `identity.signup_on_bound_address`, `identity.session_started`, `identity.login_throttled`, `identity.recovery_requested`, `identity.sessions_revoked`, `identity.email_verified`, `identity.email_changed`, `identity.binding_claimed`, `identity.provider_linked`, `identity.provider_unlinked`; payloads carry identifiers only, never addresses or tokens.
- **Squatting.** A sign-up for an address held only by another person's unverified binding answers as usual and mails the address a verification link; the mailbox proof (`verify-email` with a verification or e-mail change token) removes the squatting binding and binds the address to the prover. A verified address is never claimable (`auth.email_taken`).
- **Providers.** With `AUTH_PROVIDER_MODE=disabled` every provider route, including the callback, answers `404 access.not_found`. A provider identity without a name stores `displayName: null`; clients render the localized placeholder (`personPage.unnamed`).
- **Idempotency.** An unfinished first execution answers `validation.idempotency_in_progress` (with `retryAfterSeconds`) for at most the 30-second takeover lease; then exactly one retry takes the record over and executes again (effects committed by a crashed execution are not deduplicated). A recorded 5xx is re-executed by exactly one retry. All instants come from the injected clock.

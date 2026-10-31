# ADR 002 — Identity and multi-party access

Date: 2026-10-26. Status: product invariants accepted; first persistence slice implemented (DATA-001, 2026-10-27: FORCE RLS, transaction-local principal, SECURITY DEFINER auth lookups, membership/participation hardening; HMAC-verified identity handed to BE-001). Amended 2026-10-27 (FND-002, accepted by integrator) with the authentication decisions below.

One persistent human, one active ordinary employer, many people per company. Preferences to buy/sell/participate are independent of roles and entitlements. Projects have exactly one person/company owner and distinct creator/leader. Transactions involve multiple parties, each with private fields and an explicitly shared agreement view; public projections are separately allowlisted.

Use in-process relationship/attribute policy at every application command/query, with optional RLS as defense in depth. No global `company_id=current_company` shortcut and no separate buyer/seller identities. Runtime role differs from schema owner; never rely on RLS under a superuser/BYPASSRLS role. Review views/security-definer functions too. An external authorization service is not justified yet.

Terminate employment by revoking company-derived authority and queued mandates, not deleting the human or automatically copying private history. Explicit residual scoped read-only access is an unresolved policy option. Verify recovery/email rebinding; corporate mailbox persistence is not assumed.

Classic email/password remains primary. Google and Apple alternatives must use verified account linking, safe session/CSRF handling and provider-specific checks. The auth adapter/library is a separate research gate; do not create a homegrown production identity system in a scaffold.

## Amendment 2026-10-27: authentication decisions (integrator, from BE-000 research)

- **Opaque PostgreSQL sessions**, not JWT: random token in `__Host-sr_session`, only its SHA-256 stored (`Session.tokenHash`), idle and absolute expiry, `authenticatedAt` for step-up (10 minutes), listed and revocable by the person (`SessionView` never exposes the hash). No permissions inside the session; the principal is resolved per request with the authorization epoch.
- **Single public origin**: web and `/v1/*` share one host so `__Host-` cookies work; mutations require `X-Trustwork-Request` plus `Sec-Fetch-Site`/`Origin` verification; `SameSite=Lax` is defence in depth; no CORS for first-party traffic.
- **Provider identity is `(provider, subject)`** for Google and Apple, never the e-mail; linking only from an authenticated, recently re-authenticated session or after mailbox proof in our own flow; no auto-link by e-mail; separate redirect URIs per provider.
- **No session before e-mail verification** at signup (enumeration-safe identical responses); the first session is issued by the verification POST. Pre-login state lives in `__Host-sr_flow`.
- **Assembled primitives** (`@node-rs/argon2`, `openid-client` 6, `node:crypto`, Fastify plugins) inside the Nest identity module; `better-auth`, Auth.js, Arctic, Lucia and Passport are rejected for v1 (see the auth ADR proposal (private repository record, not exported) section 10). These dependencies are added by BE-001 through the integrator, not by this amendment.
- Frozen contracts: `Person`, `EmailBinding`, `ProviderIdentity`, `Session`/`SessionView`, `Principal`, auth commands and the `auth.*`/`membership.*` error codes in `packages/contracts`; capability vocabulary, `ObjectParticipation` and the five projection layers in [ADR 008](008-contracts-and-validation.md).
- Still human decisions: password minimum length (default 15), session lifetimes, lockout thresholds, corporate-mailbox recovery hold, support-assisted rebinding (contract questions (private repository record, not exported) H01–H11).

Evidence: [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [PostgreSQL RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html), [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [Sign in with Apple](https://developer.apple.com/documentation/sign_in_with_apple) (ADR-009: neutral providers behind the identity adapter; the Russian provider planned in 2026-10 was removed). Required tests span cross-company, counterpart field access, personal ownership, revoked membership and public export.

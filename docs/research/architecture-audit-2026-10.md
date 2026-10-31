# Architecture, code and engineering audit (October 2026)

- **Examined:** `main` at `ca0333b` ("Make this repository the project's complete, native home"), 2026-10-30.
- **Method:** read the code (not only the documentation) of every app and package, the migrations, tests, CI and infrastructure; ran `npm ci`, `npm run check` (exit 0: 393 node tests with 392 passed and 1 skipped (the Playwright wrapper), 26 design-system unit tests, docs validation, all builds, loopback smoke) and `npm audit`; inspected the production web build output.
- **Status of this note:** findings and proposals. Nothing here is a decision. The owner decision of 2026-10-31 (open engine configured per country and city; United States reference/demo hub) is taken into account in section 6 and in the proposed packages.
- Severity scale: **critical** blocks any real use or creates a likely serious incident; **high** blocks production or a core journey; **medium** causes defects, cost or risk at moderate scale; **low** hygiene.

## 1. Executive summary

Trustwork today is two well-built halves that do not touch:

1. A **small, unusually careful backend slice** (about 2,900 lines in `apps/api`, 1,850 lines of SQL in 12 migrations, 23 tables): password and provider sign-in, sessions, companies' memberships and projects, with forced row-level security, a secret-keyed MAC binding the transaction identity, epoch-based revocation, idempotency records, admission leases and real-PostgreSQL negative-authorization tests. The engineering quality of this slice is high.
2. A **large demo web application** (about 23,000 lines in `apps/web`) that renders the whole public site and workspace in six languages from synthetic JSON fixtures, with a demo principal chosen by `?persona=`. It **never calls the API**: its auth forms post to fake Next route handlers that always fail, and its data boundary is a synchronous fixture module.

Between and around them, the parts a running product needs are missing: no worker (the outbox is written but never read; `apps/worker` is four lines), no e-mail transport (verification and recovery work only against an in-memory fake), no way to create a company, edit a profile or list anything through the API, no object storage, no deployment artefact for the API, no structured logging, readiness or metrics, and no security headers. Of the roughly 20 planned backend modules, 2 exist; of the more than 80 entities in the data dictionary (`docs/data/model.md`), 23 tables exist.

The documentation is mostly honest about this (`docs/engine/status.md` says the web app does not call the API), but a few statements overstate or contradict the code (section 4), and **no work package covers the integration and platform work** that sits between "identity API" and "first real user". The highest-leverage next step is therefore not another domain module but a short **platform phase**: worker and outbox relay, transactional mail, production configuration and observability, API container and same-origin routing, account and directory completeness, and wiring the web to the live API. Section 7 orders the full path; section 8 proposes 16 new and 3 amended work packages in the `work-packages.json` shape.

On the owner decision of 2026-10-31: the engine is **data-driven in intent but code-bound in practice**. Adding a country requires a TypeScript import and a rebuild; adding a language touches at least four source files; the default country `UZ`, the brand overlay and the base path are compiled into the build; English is formatted as `en-GB`; the country-pack schema cannot express US states, several time zones, multiple identifiers (EIN, state registrations, contractor licences, SAM.gov UEI), sales tax or state privacy regimes. A United States demo hub needs a runtime configuration layer, the pack v2 facets, a US pack, `es-US`, and a synthetic US demo dataset (section 6).

## 2. What is solid

- **Authorization design.** Two layers that agree: a pure in-process policy evaluator with deny-by-default and disclosure rules (`apps/api/src/modules/identity/policy/policy.ts`) and forced RLS on every party table (`packages/data/migrations/*`, `FORCE ROW LEVEL SECURITY` on 13 tables). The API refuses to start with a superuser or `BYPASSRLS` role (`apps/api/src/app.ts:44-48`).
- **Transaction identity that cannot be forged by the runtime role.** `set_principal` binds person, company and epoch to the backend pid and transaction start with an owner-only secret (`packages/data/migrations/20261027120700_principal_mac.sql`); a stale epoch fails closed and is retried once (`principal.service.ts:50-71`). Tests prove replay across transactions and backends is rejected (`tests/backend/hmac-identity.test.ts`).
- **Migration runner.** Checksum ledger, advisory lock, forward-only and out-of-order detection, owner/runtime role bootstrap with race tolerance, expected-row directives, non-transactional files for concurrent indexes (`packages/data/src/migrate/runner.ts`).
- **Reliability primitives already in the schema.** Outbox, leased jobs with `FOR UPDATE SKIP LOCKED` and fencing tokens, `outcome_unknown` parking instead of blind re-lease, idempotency records, inbound receipts, append-only audit enforced by trigger (`20261027120400_reliability.sql`). The repository functions exist and are tested (`tests/data/reliability.test.ts`).
- **Auth hygiene.** Argon2id with rehash-on-login, `__Host-` cookies, idle and absolute session expiry, step-up for sensitive actions, enumeration-safe signup and recovery, PKCE + nonce + signed flow cookie for providers, no auto-link by e-mail, CSRF via custom header plus fetch metadata or origin (`common/csrf.guard.ts`).
- **Contracts first.** Zod strict objects for identity, company, projects, access, procurement, sales, transactions, execution, billing, assistant, content, admin and retrieval (`packages/contracts/src`, 2,565 lines), with a browser-safe entry and digests (`trustwork-digest-1`).
- **Tests that hit real PostgreSQL** (Docker, embedded or CI service) under the restricted runtime role, including concurrency cases for admission and revocation (`tests/backend/admission.test.ts:55-90`).
- **Localization discipline in the web app.** Six locale dictionaries with key-parity tests, demo content overrides per locale, locale-leak Playwright tests, axe checks in the browser suite.
- **Supply chain basics.** Exact-pinned dependencies (`.npmrc save-exact`), pinned GitHub Actions by SHA, DCO and gitleaks jobs; `npm audit` reports 0 runtime vulnerabilities (13 moderate, all in dev tooling: eslint/minimatch/storybook).
- **Honest status vocabulary** (Live / Demo / Contract / Designed / Proposed) and a docs validator that checks links, work packages and requirement traceability.

## 3. Findings by area

Each finding: **ID · severity · title**, then evidence, impact and recommendation.

### 3.1 Integration between web and API

**A1 · critical · The web application does not use the backend at all.**
Evidence: the data boundary is a fixture module (`apps/web/app/_lib/data/index.ts:8`); the principal comes from `?persona=` or `TRUSTWORK_DEMO_PERSONA` (`apps/web/app/_lib/persona.ts:5`, `principal.ts:8-13`); auth forms post to fake handlers that always return `auth.invalid_credentials` or `auth.email_unverified` (`apps/web/app/_lib/auth-fake.ts:68-87`, `app/api/auth/login/route.ts`). No `/v1` rewrite exists in `apps/web/next.config.ts` and no reverse-proxy configuration exists anywhere.
Impact: nothing a visitor does is stored; the live identity/projects API has no user interface. Status correctly says "Demo", but there is no plan to close the gap (see A3).
Recommendation: work package WEB-004 (section 8): async HTTP adapter behind the same boundary, session-based principal, same-origin `/v1/*` routing, error-code-to-locale mapping, an explicit `TRUSTWORK_DEMO_MODE` that keeps the persona switch only in demo deployments.

**A2 · high · The data boundary cannot be swapped "without touching pages" as documented.**
Evidence: all 30 exported adapter functions are synchronous (`fixture-adapter.ts:425-1123`, e.g. `export function listCompanies(): CompanyCard[]`), while `data/index.ts:5-6` promises an HTTP adapter swap without page changes. Pages and the demo address entities by slug (`app/(public)/companies/[slug]`, `people/[slug]`, `projects/[slug]`); neither the contracts nor the schema have slugs or handles (no match for `slug` in `packages/contracts/src` or `packages/data/migrations`).
Impact: the swap touches every page and needs a URL identity decision and new columns.
Recommendation: make the boundary `async` now (mechanical change, still on fixtures), add `handle`/`slug` to person, company and project contracts and schema (BE-003), decide URL identity (open question Q4).

**A3 · high · No work package owns the platform and integration work.**
Evidence: `docs/engine/status.md` says "connecting them is part of the next web work packages", but WEB-002 is commerce, WEB-003 is search, and no package covers wiring identity/companies/projects, the worker, mail, deployment, observability or company creation (`docs/engine/work-packages.json`).
Impact: domain packages (COM-001, CNT-001, BILL-001) would each reinvent pieces of the platform or ship more backend that no screen uses.
Recommendation: adopt the platform packages in section 8 before or in parallel with F2.

### 3.2 API (`apps/api`)

**B1 · high · Production configuration is not enforced.**
Evidence: `AUTH_FLOW_SECRET` falls back to a random per-process key (`config.ts:50`); `PUBLIC_ORIGIN` defaults to `http://127.0.0.1:3001` (`config.ts:62`); `API_INSECURE_COOKIES=1` is accepted with `NODE_ENV=production` (`config.ts:49`); the only production guard is "no fake providers" (`config.ts:55`). The pool size is hard-coded to 10 (`app.ts:56`); there is no `statement_timeout` or `idle_in_transaction_session_timeout`.
Impact: with two API replicas, a provider callback that lands on the other replica fails with `auth.provider.state_mismatch`; a misconfigured origin silently breaks CSRF checks; a hung transaction pins a connection forever.
Recommendation: OPS-001: a production config schema (Zod) that refuses to boot without a flow secret, an `https` public origin and secure cookies; configurable pool; per-transaction timeouts.

**B2 · high · No operability: no request logs, stack traces dropped, liveness only.**
Evidence: Fastify's logger is off and Nest logs only `error`/`warn` (`app.ts:88`); the default logger prints `error.message` only, losing stacks (`app.ts:53`); `GET /health` never touches the database (`app.module.ts:13`, and `docs/operations/runbook.md` says readiness is future work); no metrics endpoint or tracing.
Impact: a 500 in production leaves a request id and a one-line message; load balancers cannot detect a lost database; none of the runbook's metrics (outbox age, lease expirations, unknown outcomes) can be observed.
Recommendation: OPS-001: structured JSON logs (request id, principal pseudonym, route, status, latency, error stack) with redaction; `/health/live` and `/health/ready` (database reachable, migration ledger verified, expected schema version); OpenTelemetry metrics and traces exported to an OTLP endpoint when configured, no-op otherwise.

**B3 · medium · Idempotency bookkeeping is outside the handler's transaction.**
Evidence: the record is begun and completed in separate transactions from the handler (`common/idempotency.interceptor.ts:47-54`, `68-70`); a failure to store the result is only logged (`:69`); an unfinished record answers `validation.idempotency_in_progress` until it expires after 24 hours (`:60`, `config.ts:93`); expiry uses `Date.now()` instead of the injected clock (`:43`).
Impact: a crash between the handler's commit and the bookkeeping write leaves the user unable to retry for a day; a recorded 5xx is re-executed, which repeats effects that ran after the commit (mail sends in `membership.service.ts` and `auth.service.ts`).
Recommendation: write the record inside the handler's transaction (pass the `Transaction` through `runAs`), or give `in_progress` a short lease with a takeover rule; keep external effects out of request handlers (B4).

**B4 · high · Mail is sent synchronously from request handlers; only a fake exists.**
Evidence: `MailPort` has one implementation, `FakeMailbox` ("No live transport exists in this slice", `modules/identity/ports.ts:9-26`); handlers call `ctx.mail.send` after committing (`auth.service.ts:40`, `:155`, `:179`, `:223`, `:234-236`; `membership.service.ts` invite; `provider.service.ts:105`, `:129`).
Impact: sign-up with e-mail verification, recovery and invitations cannot work for a real person; when a transport is added, a slow or failing mail provider would turn into slow or failed HTTP requests, contradicting "provider effects go through outbox and worker" (`docs/engine/architecture.md`, Data and reliability).
Recommendation: MAIL-001: record mail intents in the outbox in the same transaction; deliver from the worker through a provider-neutral port (SMTP adapter plus fake), localized per recipient, with receipts in `inbox_receipt`.

**B5 · high · Accounts and directories are incomplete in the API.**
Evidence: there is no endpoint to create or claim a company (companies are inserted only by the dev seed, `apps/api/src/dev/seed.ts:52`); no profile edit (`/v1/me` is read-only apart from password, e-mail and sessions, `controllers/me.controller.ts`); no list endpoints at all (no "my projects", no people or company directories); `PaginationSchema` exists in contracts (`packages/contracts/src/common/pagination.ts`) but no route uses it.
Impact: a new user cannot reach the state the web demo shows (a company page, "My page", a projects list).
Recommendation: BE-003 (section 8), contracts first.

**B6 · medium · Rate limiting and IP lockout depend on proxy trust that is all-or-nothing.**
Evidence: `trustProxy: env.API_TRUST_PROXY === '1'` trusts every hop (`app.ts:85`); rate limits use the in-memory store keyed by `request.ip` (`app.ts:91-98`) and apply only to `/v1/auth/*`.
Impact: behind a proxy without the flag, every user shares one IP and one lockout bucket; with the flag and a directly reachable API, `X-Forwarded-For` spoofing bypasses IP limits; limits are per replica.
Recommendation: configure trusted proxy CIDRs or hop count; move limits to a shared store (PostgreSQL is enough at foundation scale) or the edge; add limits to non-auth mutations.

**B7 · medium · Account lockout can be weaponized against a victim.**
Evidence: five failures in 15 minutes lock the account (`config.ts:86`, `auth.service.ts:87-99`); 100 failures in 24 hours disable the password credential (`auth.service.ts:105-109`, `auth_disable_password` in `20261027120900_identity_commands.sql:17-27`).
Impact: anyone who knows an e-mail address can keep the account locked and, within a few hours of paced attempts, force the owner through recovery.
Recommendation: progressive delays and a challenge instead of hard disable; notify the owner; let a verified session or recovery clear the counter. Add to BE-002.

**B8 · low · Smaller API defects.**
- The health response violates its own contract when providers are configured: `HealthSchema` fixes `externalProviders: 'disabled'` (`packages/contracts/src/api.ts:29-31`) but the controller returns `fake` or `live` (`app.module.ts:13`); the smoke test only checks the disabled case (`scripts/smoke.mjs`).
- A hard-coded Russian fallback display name (the Russian word for "participant") for provider sign-ups (`modules/identity/providers/provider.service.ts:87`) breaks the "every visible string from locale files" rule; store `null` and render a localized placeholder.
- Generic unique violations return the constraint name to the client (`common/errors.ts:84`).
- `mutation()` and `MutationEnvelopeSchema` put the idempotency key in the body (`packages/contracts/src/api.ts:34-37`) while the API requires the `Idempotency-Key` header; the helper is unused. Remove or align.
- Several codes are "local, not yet in the frozen contract" (`common/errors.ts:16-30`, `controllers/auth.controller.ts:15-17`, `projects.controller.ts:12-16`); fold them into contracts.
- `npm run dev:api` rebuilds then runs with no watch mode (`apps/api/package.json`).

### 3.3 Data (`packages/data`)

**C1 · high · The outbox is write-only; nothing consumes it or the job table.**
Evidence: domain code appends outbox events in every mutation (`projects.service.ts:86`, `membership.service.ts`, `auth.service.ts:80`), and `outbox.claimUnpublished`/`jobs.lease` exist (`packages/data/src/repositories/reliability.ts:17-92`), but no process calls them; `apps/worker/src/main.ts` is a 4-line fixture demo printing `durableQueue: 'not_implemented'`.
Impact: unbounded growth of `outbox_event` (partial index on unpublished rows only); no notifications, no search projection, no scheduled sweeps (BE-002), no provider effects.
Recommendation: REL-001.

**C2 · medium · Runtime role privileges are wider than the code needs.**
Evidence: `trustwork_app` has `SELECT` on all of `audit_event` and `outbox_event` with no RLS (`20261027120400_reliability.sql:106-107`); it may execute `sweep_expired` with caller-chosen intervals, which deletes sessions and never-verified persons (`20261027121100_sweeper_and_review_fixes.sql:27-70`), and `auth_disable_password(email)` for any address without an identity (`20261027120900_identity_commands.sql:17-27,128`).
Impact: a single SQL-injection or logic bug in the API exposes every audit row (actors, request ids, `basis` JSON) and lets an attacker purge evidence or disable passwords.
Recommendation: revoke `SELECT` on audit and outbox from the API role (the worker gets its own role); fix sweeper intervals inside the definer function; require an identity or a maintenance role for `auth_disable_password`. Add to BE-002 with a reviewed migration.

**C3 · medium · DATA-002's declared path would be silently ignored by the runner.**
Evidence: `loadMigrations` reads one flat directory (`packages/data/src/migrate/runner.ts:47`); DATA-002 declares `packages/data/migrations/admin` (`docs/engine/work-packages.json`).
Impact: migrations placed there would never run and checks would stay green.
Recommendation: amend DATA-002 to the flat directory (or make the runner fail on subdirectories). Similar path drift: CNT-001 declares `apps/web/content` and WEB-002 `apps/web/features`, which do not match the App Router layout (`apps/web/app/(public)`, `apps/web/app/app`).

**C4 · medium · Growth and retention are undesigned for append-only tables.**
Evidence: `audit_event` and `outbox_event` have no partitioning or retention; audit is append-only for every role including the owner (`20261027120400_reliability.sql:25`), so even a lawful retention purge needs a new mechanism.
Impact: storage growth and slow scans; conflicts with erasure duties in some hubs.
Recommendation: monthly range partitions created by the worker, retention per hub configuration, detach-and-archive instead of `DELETE`. Decide before real traffic (Q6).

**C5 · low · Transaction MAC uses `sha256(secret || message)` instead of HMAC.**
Evidence: `20261027120700_principal_mac.sql` (setter and verifier). Not exploitable as structured (fields are fixed-order, and the verifier recomputes pid and timestamp), but it is a non-standard construction.
Recommendation: switch to `hmac()` (pgcrypto) in a future migration.

**C6 · medium · Per-request database round trips.**
Evidence: every request with a session cookie does a session lookup plus a transaction with `set_principal`, session read, optional touch, person, bindings, membership and company reads (`principal.service.ts:41-104`); handlers then open their own `runAs` transaction; idempotent mutations add two or three more transactions (`idempotency.interceptor.ts`). A count over 2,000 participation rows under RLS took about 99 ms in the test run (`[hmac-cost]` line from `tests/backend/hmac-identity.test.ts`).
Impact: roughly 12-20 round trips per authenticated mutation with a pool of 10; list endpoints (B5) will need keyset pagination and indexes that match the policies.
Recommendation: resolve the principal in the same transaction as the handler where possible; cache nothing across requests (keep the invariant) but batch the principal reads into one query; add `EXPLAIN`-based tests for list queries under the runtime role.

### 3.4 Contracts (`packages/contracts`)

**D1 · medium · Coverage stops at the designed F0 domains.**
Evidence: schemas exist for identity, company, projects, access, procurement, sales, transactions, execution, billing, assistant, content, admin and retrieval; there are none for events, learning, matching, hubs and hub configuration, verification, federation, notifications and communications, files and attachments, or measurement units (the unit catalogue O11 is referenced but absent, `common/quantity.ts:8`).
Impact: EVT-001, LRN-001, MATCH-001, HUB-001, FED-* and the US pack (units, files for evidence) start without frozen shapes.
Recommendation: each package starts with its contracts PR; add a `files` and a `units` contract in FILE-001 and CTRY-002.

**D2 · low · OpenAPI is generated but not checked for drift.**
Evidence: `apps/api/openapi/openapi.json` is written by `src/openapi/generate.ts:98-100`; no test compares it with a fresh generation.
Recommendation: CI-001 adds `generate && git diff --exit-code`.

### 3.5 Web (`apps/web`) and design system (`packages/ui`)

**E1 · high · Every application dictionary ships to every browser.**
Evidence: `app/_lib/i18n.ts:4` imports `appLayers` and evaluates `appLayers('en')` at module scope (`:43`); `locale-data.ts` statically imports all six dictionaries; `i18n.ts` is imported by 41 client components. The production build has a 939 KB client chunk (234 KB gzip) containing the full English, Russian, Uzbek, Georgian and Armenian dictionaries, referenced by 45 routes.
Impact: about a quarter megabyte of compressed JavaScript per first visit that a reader never uses; it grows linearly with each language (es-US would add more).
Recommendation: INTL-003: pass only the active locale's layers to the client through the provider (already the stated design), remove module-level `DEFAULT_LAYERS`, add a bundle-size budget to CI.

**E2 · high · Client-component SSR reads the locale from a process-global store.**
Evidence: `packages/i18n-runtime/src/client.ts` keeps one module-level store; the server build also writes it on every request (`server.ts:32-35`); the limitation is accepted in ADR-009.
Impact: under concurrent traffic in several languages, client components can render in another request's language. This is a correctness bug that load will expose, not a theoretical one.
Recommendation: INTL-003: request-scoped React context for client components; a concurrency test that renders two locales in parallel and asserts no mixing.

**E3 · medium · Russian plural rule duplicated in seven files and used for every language.**
Evidence: identical `plural(n, one, few, many)` with Russian CLDR logic in `app/(public)/{articles,events,companies,projects,people,search}/page.tsx` and `components/public/magazine/rubric.tsx:46`, while `@trustwork/ui/i18n` already formats ICU plurals with `Intl.PluralRules` (`packages/ui/src/i18n/index.ts:65-72`).
Impact: English and other languages show the wrong form for 21, 31, … ("21 result").
Recommendation: replace with the ICU formatter; add a lint rule against local plural helpers.

**E4 · medium · No HTTP caching and one 13,000-line stylesheet for public pages.**
Evidence: `export const dynamic = 'force-dynamic'` in the root layout (`app/layout.tsx:61`); the build marks every page route as dynamic; `app/(public)/public.css` has 13,210 lines (largest emitted CSS 178 KB, 28 KB gzip); locale lives in cookies, so URLs cannot be cached per language.
Impact: every public page view is a full server render; no CDN offload for news and magazine traffic; SEO has no per-language URLs (`hreflang`).
Recommendation: WEB-005 after the URL decision (Q4): locale (and possibly country) in the path for public pages, static or revalidated rendering for published content, CSS split per route.

**E5 · medium · No security headers on web or API.**
Evidence: no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy` or `Permissions-Policy` anywhere in `apps/web/next.config.ts`, `apps/web/proxy.ts` or `apps/api/src`. The media route serves SVG from the same origin (`app/media/[...path]/route.ts`, files are repository-controlled).
Recommendation: OPS-001: headers in the web proxy and the API hook; nonce-based CSP for scripts.

**E6 · medium · Hard-coded build-time deployment settings.**
Evidence: brand overlay, base path and site URL are `NEXT_PUBLIC_*` build arguments (`infra/Dockerfile:13-16`); default country `UZ` is a constant (`packages/country-packs/src/index.ts:108`) also baked into `EMPTY_STORE` (`packages/i18n-runtime/src/types.ts:11`).
Impact: one image cannot serve two hubs; changing the default country or brand means a rebuild. See sections 5 and 6.
Recommendation: CFG-001.

**E7 · low · Maintainability.**
Three near-duplicate 600-line public "assistant" components (`components/public/{Company,Person,Project}Assistant.tsx`); pages of 800-1,000 lines (`app/(public)/projects/[slug]/page.tsx` 1,029 lines); stale comments promising work that BE-001 did not do (`auth-fake.ts:18`, `app/api/auth/login/route.ts:6-9`, `data/index.ts:5-6`); a hard-coded Russian "Online" in the calendar export (`app/(public)/events/[slug]/calendar.ics/route.ts:17`); `npm run check` rewrites the tracked `apps/web/next-env.d.ts` (observed in this audit). Product question on the per-project agent surface is listed as Q8.

**E8 · medium · The design system's accessibility suite is not part of any gate.**
Evidence: `packages/ui` `test:a11y` (Storybook build + Playwright + axe) is not called by `npm run check` (only `test:ui` = unit tests) nor by `.github/workflows/check.yml`; status lists the design system as "Live" with axe tests.
Recommendation: CI-001 runs it in the browser job.

### 3.6 Worker, jobs and providers

See C1 and B4. In addition: **F1 · medium** no scheduler exists for the sweeper (`apps/api/src/dev/sweep.ts` is a manual script; BE-002 step 2), partition maintenance (C4) or retries; the worker imports contracts by relative source path (`apps/worker/src/main.ts:1`), which bypasses package exports.

### 3.7 Tests

**G1 · medium · Database tests can silently skip.**
Evidence: without PostgreSQL the suites skip with a message (`tests/data/helpers/postgres.ts:15,165`); a skip counts as success. CI forces an external database, so CI is safe today; a contributor without Docker sees green.
Recommendation: `TRUSTWORK_REQUIRE_PG=1` in CI and in `npm run check` when a variable is set; print a loud summary of skipped suites.

**G2 · medium · No test covers the web and API together, crash recovery or load.**
Evidence: browser tests run against fixtures only (`apps/web/playwright.config.ts`); no test kills the API between commit and idempotency completion (B3); no load or soak test; the only "smoke" checks `/health` and the home page title (`scripts/smoke.mjs`).
Recommendation: WEB-004 adds an end-to-end suite against a seeded API; REL-001 adds fault-injection tests; QA-001 adds a basic load profile.

**G3 · low · Coverage is not measured.** No coverage report exists; add `--experimental-test-coverage` output as an artefact, without a hard threshold at first.

### 3.8 CI (`.github/workflows/check.yml`)

**H1 · medium · Gaps in the pipeline.**
- No dependency update automation (no Dependabot or Renovate configuration in `.github/`).
- No `npm audit` or license check step; no SBOM.
- gitleaks is downloaded with `curl | tar` without checksum verification (`check.yml:86`).
- No Docker image build, so the Dockerfile can rot unnoticed.
- No OpenAPI drift check (D2), no design-system axe suite (E8), no bundle-size budget (E1).
- `npm run worker:demo` runs a fixture print, not a worker test.
Recommendation: CI-001.

### 3.9 Infrastructure (`infra/`)

**I1 · high · Only the web app is containerized, and not for production.**
Evidence: `infra/Dockerfile` builds only `@trustwork/web`, copies the whole build tree including dev dependencies into the runtime image (`:27`), runs as root (no `USER`), has no `HEALTHCHECK`, and does not use Next's standalone output. No image or process definition exists for the API, the worker or migrations; `infra/compose.yaml` contains only PostgreSQL.
Impact: the API cannot be deployed from the repository; the "single public origin with `/v1/*` proxied" design (`docs/architecture/api.md`) has no implementation.
Recommendation: OPS-002: multi-stage images for web (standalone), API and worker, non-root, health checks, a one-shot migration job, and a full local stack (PostgreSQL, API, worker, web, reverse proxy routing `/v1/*`) in compose.

**I2 · medium · No backup, restore or secret management tooling.** The runbook describes a drill (`docs/operations/runbook.md`) but nothing automates it. OPS-003 after the hosting decision (Q1).

### 3.10 Security posture summary

Strong: session handling, CSRF, password storage, RLS, identity binding, enumeration safety, provider flows, secret scanning. Weak: production config enforcement (B1), proxy trust (B6), lockout abuse (B7), runtime-role privileges (C2), missing security headers (E5), root container (I1), no dependency automation (H1). No secrets were found in the tree; `.env.example` lists four variables no code reads (`ASSISTANT_PROVIDER`, `CHANNEL_PROVIDER`, `BILLING_PROVIDER`, `STORAGE_PROVIDER`) and omits the ones the API needs (`API_DATABASE_URL`, `AUTH_FLOW_SECRET`, `PUBLIC_ORIGIN`).

### 3.11 Scalability limits (estimated, not measured under load)

- API: pool of 10 connections per process (B1), 12-20 round trips per authenticated mutation (C6), Argon2id at 19 MiB and t=2 per hash bounds login, signup, recovery and step-up throughput by CPU and memory per process; in-memory rate limits (B6).
- Database: unpartitioned append-only tables (C4); RLS scans cost tens of microseconds per row (C6); everything in one database per node by design (ADR 001), which is appropriate at foundation scale.
- Web: no caching (E4), per-request SSR of large pages, 234 KB gzip of dictionaries per first visit (E1), global locale store (E2).
- Worker: absent (C1). PostgreSQL `SKIP LOCKED` queues are adequate for thousands of jobs per minute; reconsider a broker only on measured need, as ADR 001 says.

## 4. Documentation accuracy versus code

| Statement | Where | Reality |
|---|---|---|
| "BE-001 swaps `./fixture-adapter` for an HTTP adapter against `/v1/*` without touching pages" | `apps/web/app/_lib/data/index.ts:5-6` | BE-001 is done; the swap did not happen and is not possible without touching pages (A2) |
| "BE-001 replaces the handlers with the real `/v1/auth/*` proxy" | `apps/web/app/_lib/auth-fake.ts:18`, `app/api/auth/login/route.ts:6-9` | Not done; no package owns it (A3) |
| "connecting them is part of the next web work packages" | `docs/engine/status.md`, What this means if you try it | No such package exists (A3) |
| "Aggregate change, audit event and outbox intent in one transaction" | `docs/engine/architecture.md`, Data and reliability | Signup, login, failures and provider events audit in separate transactions (`auth.service.ts:26-28`, `:41`; `provider.service.ts:132-134`); mail is sent from the request, not via outbox (B4) |
| Architecture diagram shows outbox feeding the worker and provider ports | `docs/engine/architecture.md`, Shape | The worker consumes nothing (C1); the text below the diagram is accurate ("today a fake policy demonstration") |
| "Sign-up with e-mail verification" listed as Live | `docs/engine/status.md` | Live only with the in-memory fake mailbox; no transport exists (B4). Suggest the footnote "verification delivered through a fake mailbox until MAIL-001" |
| Design system "Live" with axe tests | `docs/engine/status.md` | The axe suite exists but no gate runs it (E8) |
| "Routes are not implemented" after a list of implemented routes | `docs/architecture/api.md:3` | Internal contradiction; reword to "routes not listed above are contract only" |
| Health is the bootstrap contract with providers `disabled` | `packages/contracts/src/api.ts:29-31` | Returns `fake`/`live` when configured (B8) |
| `.env.example` provider variables | `.env.example` | Four unused variables, three required ones missing (3.10) |
| Statuses "reflect that file on 2026-10-31" | `docs/engine/roadmap.md` | Dated one day ahead of this commit; harmless but should follow the edit date |

Everything else checked in `status.md` (live identity, memberships, projects; demo-only content, events, commerce, agents; contracts-only commerce and retrieval; no production) matches the code.

## 5. How configurable is the engine today

| To add | Steps today | Code changes |
|---|---|---|
| A country with a pack | Write `packs/<code>.json`; import it and add it to `RAW_PACKS` (`packages/country-packs/src/index.ts:2-5,66`); dictionaries if a new language; rebuild and redeploy | Yes (TypeScript import + rebuild) |
| A language | Two dictionaries, plus registration in `packages/ui/src/i18n/index.ts:39` and `:60`, `apps/web/app/_lib/locale-data.ts` (`DICTIONARIES`), `LOCALE_NAMES` in `components/locale/LocaleSwitcher.tsx:15`, fixture overrides in `app/_lib/data/fixtures.ts:12-31`, fonts for new scripts (`docs/country-packs/how-to-add-a-country.md`, section 3) | Yes, in at least four files |
| A city or hub | Not possible: hubs are designed only (HUB-001 open); regions are a flat list per pack | Not available |
| Change the default country, brand or base path | `DEFAULT_COUNTRY` constant; `NEXT_PUBLIC_*` build arguments | Yes (constant or rebuild) |
| Change formats for English | `INTL_TAGS` maps `en` to `en-GB` for every country (`packages/ui/src/i18n/index.ts:60`) | Yes |

Country *facts* are data (good), but *registration* of packs, languages, brand and defaults is code. The owner's "configuration over code" goal needs a runtime configuration layer: packs and dictionaries loaded from a data directory or the database and validated at start, hub configuration versions (HUB-001) holding default country, languages, currency, brand and legal templates, and a first-run setup flow for operators.

## 6. Distance to a United States demo hub (owner decision 2026-10-31)

**What already helps.** Any non-restricted country, including the US, is selectable with a generic profile (ISO name, currency, no regions) (`packages/country-packs/src/index.ts`, "Every country"); money is integer minor units with ISO currency (USD works); English is the engine fallback; the compliance package already has a US Consolidated Screening List adapter (`packages/compliance/src/index.ts:82-98`), which matches OFAC-style obligations of a US-hosted hub; the legal-template mechanism exists.

**J1 · high · The pack schema cannot express the United States.**
Evidence (`packages/country-packs/src/index.ts`): region `kind` allows only `city, region, republic, autonomous-republic, rayon, municipality` (`:21`), so no `state`, `district` (DC) or `territory`/outlying area; one `timeZone` per country (`:34`), while the US spans several; exactly one `registrationIdentifier` (`:38`), so EIN cannot sit next to state entity numbers, state contractor licence numbers and the SAM.gov Unique Entity ID; one `dataResidency` block (`:51`) and no privacy regime per subdivision (CCPA/CPRA in California and the other state comprehensive privacy laws); no facets for tax, licensing, procurement registers, e-signature, payments or holidays (these are CTRY-002, still open and scoped to UZ/GE/AM/AZ).
Recommendation: amend CTRY-002 (section 8) to cover subdivision-level facets, multiple time zones and multiple identifier kinds, then add INTL-US.

**J2 · high · Defaults are Uzbekistan and formats are British.**
Evidence: `DEFAULT_COUNTRY = 'UZ'` (`packages/country-packs/src/index.ts:108`); `EMPTY_STORE.country = 'UZ'` (`packages/i18n-runtime/src/types.ts:11`); the smoke test asserts the `uz-Latn` default (`scripts/smoke.mjs`); Playwright pins the UZ country cookie (`apps/web/playwright.config.ts`); English formats as `en-GB` (`packages/ui/src/i18n/index.ts:60`), so a US visitor would see day-month dates; all demo fixtures are Uzbek (UZS amounts in `apps/web/fixtures/events.json` and `projects.json`, Uzbek cities and companies).
Recommendation: CFG-001 makes the default a deployment setting; INTL-003 derives the `Intl` tag from language + country (`en` + `US` = `en-US`); DEMO-001 builds a synthetic US dataset.

**J3 · medium · US-specific domain needs that touch contracts.**
- Measurement units: construction in the US is largely imperial (ft, ft², yd³, lb, gal); quantities use free unit codes and same-unit arithmetic only (`packages/contracts/src/common/quantity.ts:8-49`), the unit catalogue (O11) does not exist. Needed for catalogue and quotes.
- Addresses: ZIP and ZIP+4 fit the postal pattern field, but there is no second address line (unit/suite) in `address.lines`.
- Payments: cards and ACH need a payment port with webhooks into `inbox_receipt` (BILL-001 is provider-neutral and stops at "no actual charge"); see PAY-001. Payment never changes ranking (unchanged rule).
- E-signature: ESIGN (federal) and UETA (adopted by most states; New York has its own statute) make simple electronic acceptance enforceable for most commercial terms; the existing digest-bound acceptance is a good base, but consent-to-electronic-records and record-retention disclosures need legal templates for the US hub.
- Public procurement: SAM.gov entity registration and the UEI are relevant for companies that sell to the federal government; treat them as verification sources (HUB-003), not as identity.
- Sales tax is state and local; the engine should store tax treatment as data and delegate calculation to an adapter (no tax engine in core).
- Holidays: US federal holidays affect milestone and event calendars; a calendar facet with observed-date rules is needed.
- Language: Spanish for the US (`es-US`, or `es` with US formats) as the likely second language; today adding it costs four code registrations (section 5) and about 2,700 strings (2,371 application and 324 design-system leaves in the English reference), plus demo overrides.
All US facts above must be sourced in the pack with verification levels; this audit did not verify them against primary sources.

**J4 · medium · A US demo hub needs synthetic, honest demo content.**
The current demo dataset (people, companies, projects, events, publications, magazine issues) is set in Uzbekistan (base text in Russian with per-locale overrides). A US demo needs its own synthetic dataset, labelled as such, with no real company names, licences or EINs (obviously fictitious identifiers marked synthetic, `example.invalid` domains), and a persona set that exercises a US company, a sole proprietor, and a buyer. See DEMO-001.

## 7. Path from "demo web + identity/projects API" to a fully working product

The order below minimizes rework: first make what exists real and deployable, then add the domains that bring traffic and trust, then money and agents, then the gathering-point features and federation. Phases may overlap where dependencies allow.

**P0: Platform (new packages).**
1. OPS-001 production runtime baseline (config guard, logs, readiness, metrics/traces, headers, timeouts).
2. REL-001 worker: outbox relay, job runner, scheduler (sweeper, partitions), fault injection.
3. MAIL-001 transactional mail via outbox (SMTP port + fake, localized templates).
4. BE-003 account and directory completeness (company create, profile, lists, handles, pagination).
5. BE-002 amended (identity hardening plus findings B7, C2).
6. OPS-002 images and full local stack with same-origin routing; CI-001 pipeline hardening.
7. WEB-004 web on the live API for identity, companies and projects (demo mode stays available).
8. INTL-003 locale correctness and bundle size; CFG-001 runtime configuration (packs, languages, defaults, brand without rebuild).
Outcome: a person can sign up, verify by e-mail, create a company, invite a colleague, create and publish a project, and see it on the public site, on a deployable stack (deployment itself still needs owner authorization).

**P1: Content, files, moderation (traffic and trust).**
FILE-001 object storage port; CNT-001 publications and magazine (needs FILE-001 for images and PDF); DATA-002 and ADM-001 administration and moderation **before** user-generated content goes public; a notifications store (designed in `docs/engine/communications.md`) on top of REL-001 and MAIL-001; WEB-005 cacheable public pages.

**P2: Commerce and money.**
COM-001 RFQ, catalogue, quotes, agreements (needs the unit catalogue from CTRY-002); BILL-001 offers and two budget kinds; PAY-001 payment port with fake and webhook inbox; EXE-001 execution and reputation; WEB-002 commerce screens.

**P3: Knowledge and agents.**
RAG-201 ingestion (pgvector, ADR 007) fed by REL-001; RAG-301 governed retrieval; WEB-003 search; AST-001 durable mandates and runs; RAG-401 verification.

**P4: Gathering point and hubs.**
EVT-001, LRN-001, MATCH-001, AGT-001; HUB-001 (hub configuration versions absorb CFG-001 settings), HUB-002 console, HUB-003 verification; CTRY-002 facets, INTL-US, INTL-ES, DEMO-001 can run in parallel from P0 because they are data-heavy.

**P5: Federation and release.**
FED-000…FED-005; QA-001 release candidate; OPS-003 backup/restore drill.

**Infrastructure to provision when authorized (all behind adapters with fakes; providers chosen per hub, no Russian providers or rails):**

| Need | Recommendation | Notes |
|---|---|---|
| Queue / outbox worker | PostgreSQL outbox + `job` table with `SKIP LOCKED` (already designed) | No broker until measured need (ADR 001) |
| Object storage | S3-compatible API behind a `BlobStore` port; filesystem fake | Signed URLs with short TTL; classification inherited from parent; checksums; hub-local region |
| Search | PostgreSQL full-text + `pg_trgm` for directories now; `pgvector` for RAG later (ADR 007) | Projections built from published fields only |
| E-mail | SMTP adapter (any provider), DKIM/SPF/DMARC on the hub domain | Bounce and complaint webhooks into `inbox_receipt` |
| Payments | `PaymentPort` with fake; one adapter per hub (for the US hub: cards and ACH) | Webhooks idempotent; unknown outcomes reconciled |
| Observability | JSON logs, OpenTelemetry traces and metrics to OTLP | Vendor-neutral; redaction of private fields |
| Backups | WAL archiving with point-in-time recovery, encrypted off-host copies, restore drill | RPO/RTO set by the owner (Q1) |
| Edge | Reverse proxy or CDN routing `/v1/*` to the API, TLS, security headers | Same-origin design of ADR 002 |

## 8. Proposed new and amended work packages

**Merged on 2026-10-31** into [work-packages.json](../engine/work-packages.json) by [ADR 012](../adr/012-integrator-decisions-2026-10-31.md), which also answers Q1–Q9 where the integrator could (INTL-ES and DEMO-001 became LANG-ES and DEMO-US; PAY-001 kept its identifier as the provider port; CTRY-002 was split into CTRY-002 and CTRY-003). The block below is kept as the original proposal.

Shape identical to `docs/engine/work-packages.json` entries. **New** packages have new ids; **amended** packages (BE-002, DATA-002, CTRY-002) repeat the full entry with changes. This block is a proposal; the conductor or a maintainer decides what to merge into `work-packages.json`. The block was checked with `validate()` from `scripts/work-packages.mjs` after merging it into the current list in memory (no errors).

```json
[
  {
    "id": "OPS-001",
    "title": "Production runtime baseline: configuration guard, structured logs, readiness, telemetry, security headers",
    "area": "platform",
    "status": "open",
    "dependsOn": ["BE-001"],
    "handbook": "docs/operations/runbook.md",
    "goal": "Make the API and web processes safe and observable to run outside a laptop without changing domain behaviour.",
    "read": [
      "docs/research/architecture-audit-2026-10.md",
      "docs/operations/runbook.md",
      "docs/quality/security.md",
      "docs/adr/002-identity-and-access.md"
    ],
    "steps": [
      "Validate production configuration with a Zod schema: refuse to boot without AUTH_FLOW_SECRET, an https PUBLIC_ORIGIN and secure cookies; make the pool size, statement_timeout and idle_in_transaction_session_timeout configurable.",
      "Replace console logging with structured JSON logs (request id, pseudonymous principal, route, status, latency, error stack) with redaction of secrets and private fields.",
      "Add /health/live and /health/ready (database reachable, migration ledger verified, expected schema version) and align HealthSchema with the provider mode.",
      "Add OpenTelemetry traces and metrics exported to an OTLP endpoint when configured, no-op otherwise; include the runbook metrics that exist today.",
      "Add security headers on web and API (CSP with nonces, HSTS, frame-ancestors, Referrer-Policy, Permissions-Policy) and configurable trusted proxies instead of trust-all."
    ],
    "acceptance": [
      "The API refuses to start in production with a missing flow secret, an http origin or insecure cookies (tested).",
      "A forced 500 produces one JSON log line with the stack and request id and no secret or private field.",
      "Readiness fails when the database is unreachable or the ledger has a checksum mismatch.",
      "Spoofed X-Forwarded-For from an untrusted hop does not change the client IP used for limits."
    ],
    "paths": ["apps/api/src/common", "apps/api/src/config.ts", "apps/api/src/main.ts", "apps/api/src/app.ts", "apps/web/proxy.ts", "tests/backend/ops"]
  },
  {
    "id": "REL-001",
    "title": "Outbox relay, durable job runner and scheduler in apps/worker",
    "area": "platform",
    "status": "open",
    "dependsOn": ["BE-001"],
    "handbook": "docs/engine/architecture.md",
    "goal": "Turn the existing outbox and job tables into a running worker so provider effects and maintenance leave the request path.",
    "read": [
      "docs/research/architecture-audit-2026-10.md",
      "docs/data/lifecycles.md",
      "docs/adr/004-delivery-and-providers.md",
      "docs/operations/runbook.md"
    ],
    "steps": [
      "Give the worker its own restricted database role with only the grants it needs (outbox, job, inbox, sweeper) through a reviewed migration.",
      "Implement the outbox relay (claim unpublished with SKIP LOCKED, dispatch to typed handlers, mark published) and a handler registry keyed by event type.",
      "Implement the job loop with lease, heartbeat, fencing-checked completion and failure, backoff, dead letters and outcome_unknown parking, plus an explicit reconciliation command.",
      "Schedule maintenance: sweep_expired with fixed intervals, idempotency cleanup, audit and outbox partition creation; graceful shutdown that stops leasing and finishes or releases work.",
      "Add fault-injection tests: kill between lease and completion, duplicate delivery, stale fencing token, clock skew."
    ],
    "acceptance": [
      "No provider call happens inside an API request transaction for the migrated flows.",
      "A worker killed mid-job never causes a second effect without reconciliation; tests prove it on real PostgreSQL.",
      "Outbox age, queue depth, lease expirations and unknown outcomes are exported as metrics.",
      "The worker role cannot read party tables."
    ],
    "paths": ["apps/worker", "packages/data/src/repositories/reliability.ts", "packages/data/migrations", "tests/worker"]
  },
  {
    "id": "MAIL-001",
    "title": "Transactional mail through the outbox with localized templates and an SMTP adapter",
    "area": "communications",
    "status": "open",
    "dependsOn": ["REL-001"],
    "handbook": "docs/engine/communications.md",
    "goal": "Deliver verification, recovery, invitation and security notices for real, asynchronously, in the recipient's language.",
    "read": [
      "docs/engine/communications.md",
      "docs/adr/004-delivery-and-providers.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Record mail intents as outbox events in the same transaction as the identity change instead of calling MailPort from handlers.",
      "Render templates from locale dictionaries in all engine languages (subject, text and HTML), with the hub brand from configuration and no hard-coded brand.",
      "Implement a provider-neutral SMTP adapter and keep the fake; configuration chooses one; no provider account is registered by this package.",
      "Record delivery, bounce and complaint receipts idempotently in inbox_receipt; suppress sending to hard-bounced addresses.",
      "Keep enumeration safety: identical HTTP timing and responses whether or not an address exists."
    ],
    "acceptance": [
      "Signup, recovery and invitation work end to end against a local SMTP sink in tests.",
      "A failing mail provider never fails or slows the HTTP request.",
      "Every template exists in every engine language; tests fail on a missing key.",
      "Duplicate outbox delivery sends at most one message per intent."
    ],
    "paths": ["apps/worker/src/mail", "apps/api/src/modules/identity", "packages/ui/locales", "tests/worker/mail"]
  },
  {
    "id": "BE-003",
    "title": "Account and directory completeness: companies, profiles, handles, lists with pagination",
    "area": "backend",
    "status": "open",
    "dependsOn": ["BE-001"],
    "handbook": "docs/engine/people-and-companies.md",
    "goal": "Let a real user reach the states the web shows: create a company, edit a public profile, list own projects, browse public directories.",
    "read": [
      "docs/engine/people-and-companies.md",
      "docs/product/access-and-journeys.md",
      "docs/architecture/api.md",
      "docs/data/model.md"
    ],
    "steps": [
      "Contracts first: company creation (unclaimed, creator becomes administrator), profile update with visibility, handle/slug rules for person, company and project, list queries with cursor pagination.",
      "Migrations through the data integrator: handle columns with uniqueness, indexes that serve the RLS policies and keyset pagination.",
      "Implement POST /v1/companies, PATCH /v1/me/profile, GET /v1/me/projects, GET /v1/people, GET /v1/companies and GET /v1/projects (public projections only for anonymous callers).",
      "Add public lookups by handle and keep UUIDs as the stable identifiers.",
      "Test negative authorization, pagination stability under concurrent inserts and query plans under the runtime role."
    ],
    "acceptance": [
      "A company created through the API has exactly one administrator and no verified status (claim and verification stay separate).",
      "Directories never return private fields or unpublished objects; tests prove it per projection.",
      "List queries use index scans on 100,000 synthetic rows under the runtime role.",
      "No sourced, claimed or verified label is implied by creation."
    ],
    "paths": ["packages/contracts/src/identity.ts", "packages/contracts/src/company.ts", "packages/contracts/src/projects.ts", "apps/api/src/modules/identity", "apps/api/src/modules/projects", "packages/data/migrations", "tests/backend"]
  },
  {
    "id": "WEB-004",
    "title": "Run the web app on the live API for identity, companies and projects",
    "area": "frontend",
    "status": "open",
    "dependsOn": ["BE-003", "OPS-001"],
    "handbook": "docs/engine/architecture.md",
    "goal": "Replace fixtures and the persona switch with the real API wherever the API exists, keeping an explicit demo mode for demo deployments.",
    "read": [
      "docs/architecture/api.md",
      "docs/design/screen-contracts",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Make the data boundary asynchronous and update every call site while still on fixtures; then add an HTTP adapter for the implemented endpoints.",
      "Route /v1/* to the API on the same origin (Next rewrite for development, reverse proxy in OPS-002) and forward cookies and the CSRF header.",
      "Replace the fake auth handlers with the real sign-up, verification, login, recovery, step-up, sessions, memberships and projects flows; map every error code to locale keys.",
      "Introduce TRUSTWORK_DEMO_MODE: persona switch and fixtures only when it is on; production builds refuse ?persona=.",
      "Add an end-to-end Playwright suite against a seeded API and database in CI."
    ],
    "acceptance": [
      "With demo mode off, no fixture data or persona parameter influences any page.",
      "Sign-up to verified session to company creation to published project works in the browser against the real API.",
      "Every API error renders localized copy in all engine languages; no raw code reaches the user.",
      "Keyboard, screen reader and narrow-screen checks pass on the changed screens."
    ],
    "paths": ["apps/web/app/_lib", "apps/web/app/(auth)", "apps/web/app/api", "apps/web/app/app", "apps/web/components/auth", "tests/web"]
  },
  {
    "id": "OPS-002",
    "title": "Container images and a full local stack with same-origin routing",
    "area": "platform",
    "status": "open",
    "dependsOn": ["OPS-001", "REL-001"],
    "handbook": "docs/operations/runbook.md",
    "goal": "Produce deployable, non-root images for web, API, worker and migrations and a compose stack that mirrors the production topology.",
    "read": [
      "docs/operations/runbook.md",
      "docs/adr/001-independent-modular-monolith.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Multi-stage images: web with Next standalone output, API and worker without dev dependencies, all non-root with health checks.",
      "A one-shot migration image or command that runs as the migrator role and never as the runtime role.",
      "Extend infra/compose.yaml with API, worker, web and a reverse proxy that serves one origin and routes /v1/* to the API.",
      "Document runtime configuration (no secrets in images) and produce an SBOM per image.",
      "Do not deploy anywhere; deployment needs the owner's authorization."
    ],
    "acceptance": [
      "docker compose up brings a working stack where sign-up and login work through the proxy on one origin.",
      "Images run as a non-root user and contain no devDependencies, tests or docs.",
      "Images build in CI for every pull request that touches apps, packages or infra."
    ],
    "paths": ["infra", "apps/api/package.json", "apps/worker/package.json", "docs/operations/runbook.md"]
  },
  {
    "id": "CI-001",
    "title": "Harden the pipeline: required database tests, audits, drift and size checks",
    "area": "quality",
    "status": "open",
    "dependsOn": [],
    "handbook": "docs/quality/validation.md",
    "goal": "Make CI fail on the gaps found in the audit instead of passing silently.",
    "read": [
      "docs/quality/validation.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Fail when database suites skip in CI (TRUSTWORK_REQUIRE_PG=1) and print a summary of skipped suites locally.",
      "Run the design-system axe suite and add a client bundle-size budget to the browser job.",
      "Add npm audit for runtime dependencies (fail on high), a license allowlist check and Dependabot or Renovate configuration for npm and actions.",
      "Verify the gitleaks download checksum; add an OpenAPI regeneration drift check.",
      "Stop npm run check from rewriting tracked files (apps/web/next-env.d.ts)."
    ],
    "acceptance": [
      "Removing the database service from CI makes the check job fail.",
      "An accessibility violation in a Storybook story fails CI.",
      "A changed contract without regenerated OpenAPI fails CI.",
      "A clean checkout stays clean after npm run check."
    ],
    "paths": [".github", "scripts", "tests/data/helpers", "packages/ui/playwright.config.ts"]
  },
  {
    "id": "INTL-003",
    "title": "Locale correctness and weight: request-scoped client locale, one dictionary per page, CLDR plurals, country-aware formats",
    "area": "international",
    "status": "open",
    "dependsOn": ["INTL-002"],
    "handbook": "docs/engine/localization.md",
    "goal": "Fix cross-request locale mixing, ship only the active dictionary and format numbers and dates for language plus country.",
    "read": [
      "docs/engine/localization.md",
      "docs/adr/009-international-engine-and-open-source.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Replace the module-level client store with a request-scoped React context for server rendering of client components; add a concurrent two-locale rendering test.",
      "Remove module-level dictionary evaluation from client code so only the active locale's layers reach the browser; add a size budget.",
      "Replace the seven local plural helpers with the ICU formatter based on Intl.PluralRules.",
      "Derive the Intl tag from language and country (en with US gives en-US, en with GB gives en-GB) instead of a fixed map.",
      "Move remaining hard-coded visible strings (calendar export location, provider default name) to locale keys."
    ],
    "acceptance": [
      "Parallel requests in different languages never mix strings in tests.",
      "The largest client chunk no longer contains more than one language's dictionary.",
      "English shows correct forms for 1, 2, 21 and 101; US visitors see month-day dates.",
      "Locale parity and leak tests still pass."
    ],
    "paths": ["packages/i18n-runtime", "packages/ui/src/i18n", "apps/web/app/_lib", "apps/web/app/(public)", "apps/web/components", "tests/web"]
  },
  {
    "id": "CFG-001",
    "title": "Configuration over code: runtime country packs, languages, defaults and brand",
    "area": "international",
    "status": "open",
    "dependsOn": ["INTL-003"],
    "handbook": "docs/engine/hubs.md",
    "goal": "Let an operator add a country, a language or change the default country, languages and brand by configuration, without editing TypeScript or rebuilding.",
    "read": [
      "docs/engine/hubs.md",
      "docs/engine/localization.md",
      "docs/country-packs/how-to-add-a-country.md",
      "docs/adr/009-international-engine-and-open-source.md"
    ],
    "steps": [
      "Load country packs and locale dictionaries from a configured data directory at start, validated with the existing schemas; refuse to start on invalid or restricted packs.",
      "Replace DEFAULT_COUNTRY and fixed locale lists with deployment configuration (default country, enabled countries, enabled languages, default language per country).",
      "Move the brand overlay, site URL and base path from build arguments to runtime configuration where Next allows it, and document the remainder.",
      "Define the configuration file format so HUB-001 can later version it per hub with second-person activation.",
      "Update the add-a-country guide so the happy path needs no code change."
    ],
    "acceptance": [
      "A new pack and a new language dropped into the data directory appear after a restart with no code change.",
      "One image serves two deployments with different default countries and brands.",
      "Restricted places are refused at load.",
      "Engine code contains no country-specific branches or defaults."
    ],
    "paths": ["packages/country-packs", "packages/ui/src/i18n", "apps/web/app/_lib", "apps/web/brand", "docs/country-packs", "tests/country-packs"]
  },
  {
    "id": "WEB-005",
    "title": "Cacheable, indexable and lighter public pages",
    "area": "frontend",
    "status": "open",
    "dependsOn": ["INTL-003", "WEB-004"],
    "handbook": "docs/engine/architecture.md",
    "goal": "Serve published content from caches with per-language URLs and route-level CSS once the URL scheme is decided.",
    "read": [
      "docs/product/information-architecture.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Implement the owner's URL decision for language (and country) in public paths with hreflang alternates.",
      "Remove the global force-dynamic; render published content statically or with revalidation; keep personalized parts dynamic.",
      "Split the 13,000-line public stylesheet into route-level CSS modules.",
      "Add Lighthouse or Web Vitals budgets for the main public templates on a mobile profile."
    ],
    "acceptance": [
      "Anonymous news, article, magazine and directory pages are served from cache with correct language variants.",
      "Mobile performance budgets pass in CI for the home, news and company templates.",
      "No private or personalized data is ever cached for another visitor (tested)."
    ],
    "paths": ["apps/web/app/(public)", "apps/web/app/layout.tsx", "apps/web/components/public", "tests/web"]
  },
  {
    "id": "FILE-001",
    "title": "Object storage port and attachment model",
    "area": "platform",
    "status": "open",
    "dependsOn": ["REL-001", "BE-003"],
    "handbook": "docs/engine/trust-safety-privacy.md",
    "goal": "Store files (avatars, publication images, magazine PDFs, project and evidence attachments) with classification inherited from their parent.",
    "read": [
      "docs/data/model.md",
      "docs/quality/security.md",
      "docs/engine/trust-safety-privacy.md"
    ],
    "steps": [
      "Contracts for attachment metadata, classification and upload/download commands.",
      "A BlobStore port with an S3-compatible adapter and a filesystem fake; content hashes, size and type limits.",
      "Upload through short-lived signed URLs; download only through an authorized parent check with bounded TTL.",
      "A scanning port (fake) and quarantine state before a file becomes visible.",
      "Deletion and erasure through the worker with tombstones for restore replay."
    ],
    "acceptance": [
      "A participant without access to the parent cannot obtain a URL for its attachment (negative tests).",
      "Copy or move preserves owner and classification and is audited.",
      "No external storage account is created by this package."
    ],
    "paths": ["packages/contracts/src/files.ts", "apps/api/src/modules/files", "apps/worker/src/files", "packages/data/migrations", "tests/files"]
  },
  {
    "id": "PAY-001",
    "title": "Payment provider port with fake, webhook inbox and reconciliation",
    "area": "billing",
    "status": "open",
    "dependsOn": ["BILL-001", "REL-001"],
    "handbook": "docs/engine/billing.md",
    "goal": "Connect platform charges to a provider-neutral payment port that a hub configures (cards and ACH for the US demo hub), without changing ranking or matching.",
    "read": [
      "docs/engine/billing.md",
      "docs/adr/004-delivery-and-providers.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Define the payment port (create intent, confirm, refund, lookup outcome) and a deterministic fake.",
      "Process provider webhooks idempotently through inbox_receipt; reconcile unknown outcomes instead of retrying.",
      "Tie payments to BILL-001 reservations and ledger entries in integer minor units.",
      "Keep rails configurable per hub; no Russian providers or rails; no account registration or real charge in this package."
    ],
    "acceptance": [
      "Duplicate and out-of-order webhooks never double-settle (tests).",
      "A timeout leaves the payment in outcome_unknown until reconciliation.",
      "Ranking, matching and reputation code paths have no dependency on payment state (tested)."
    ],
    "paths": ["apps/api/src/modules/billing/payments", "apps/worker/src/payments", "tests/billing/payments"]
  },
  {
    "id": "OPS-003",
    "title": "Backup, restore drill and retention automation",
    "area": "platform",
    "status": "open",
    "dependsOn": ["OPS-002", "FILE-001"],
    "handbook": "docs/operations/runbook.md",
    "goal": "Turn the runbook's restore drill into scripts and evidence on synthetic data.",
    "read": [
      "docs/operations/runbook.md",
      "docs/operations/retrieval.md"
    ],
    "steps": [
      "Script base backups and WAL archiving for the compose stack with encrypted off-host targets as configuration.",
      "Script a point-in-time restore into an isolated network with providers disabled.",
      "Replay erasure tombstones recorded after the backup and reconcile queued jobs without re-sending effects.",
      "Implement audit and outbox partition retention per hub configuration."
    ],
    "acceptance": [
      "A recorded drill on synthetic data restores, replays erasures and measures recovery time and data-loss window.",
      "Restored workers do not contact providers before reconciliation."
    ],
    "paths": ["infra/backup", "scripts/restore", "docs/operations"]
  },
  {
    "id": "INTL-US",
    "title": "United States country pack",
    "area": "international",
    "status": "open",
    "dependsOn": ["CTRY-002"],
    "handbook": "docs/engine/country-specifics.md",
    "goal": "Add a sourced US pack for the reference/demo hub: states and territories, time zones, EIN and state identifiers, entity forms, licensing, sales tax treatment, e-signature, payments, privacy and holidays.",
    "read": [
      "docs/country-packs/how-to-add-a-country.md",
      "docs/engine/country-specifics.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Regions: 50 states, the District of Columbia and the outlying areas with ISO 3166-2 codes and correct kinds; several IANA time zones.",
      "Identifiers: EIN as the company identifier; state entity numbers, state contractor licence references and SAM.gov UEI as additional identifier kinds with verification recipes (no live register calls).",
      "Entity forms (sole proprietorship, partnership, LLC, corporation and others), address with second line and ZIP or ZIP+4, phone +1.",
      "Facets: state sales tax treatment as data with a tax adapter reference, ESIGN/UETA acceptance notes, card and ACH rails, CCPA/CPRA and other state privacy regimes, federal holidays with observed-date rules, imperial units in the unit catalogue.",
      "Every fact with a primary source and verification level; English default, es-US as second language when INTL-ES lands."
    ],
    "acceptance": [
      "The pack validates; no fact without a source; unverified facts are labelled.",
      "A US visitor sees en-US formats, USD and the correct state list.",
      "No engine code branches on US."
    ],
    "paths": ["packages/country-packs/packs/us.json", "tests/country-packs"]
  },
  {
    "id": "INTL-ES",
    "title": "Spanish for the United States (es-US)",
    "area": "international",
    "status": "open",
    "dependsOn": ["CFG-001"],
    "handbook": "docs/engine/localization.md",
    "goal": "Add Spanish as the second language of the US hub through configuration only.",
    "read": [
      "docs/engine/localization.md",
      "docs/country-packs/how-to-add-a-country.md"
    ],
    "steps": [
      "Add design-system and application dictionaries for es-US with CLDR plural forms.",
      "Add demo content overrides for the US demo dataset.",
      "Mark the translation as machine-assisted until reviewed by a native speaker."
    ],
    "acceptance": [
      "Key parity and leak tests pass for es-US.",
      "The language appears through configuration with no TypeScript change.",
      "Status labels the translation review state honestly."
    ],
    "paths": ["packages/ui/locales/es-US.json", "apps/web/app/_lib/locales/es-US.json", "apps/web/fixtures/i18n/es-US.json"]
  },
  {
    "id": "DEMO-001",
    "title": "United States demo hub dataset and defaults",
    "area": "frontend",
    "status": "open",
    "dependsOn": ["INTL-US", "CFG-001"],
    "handbook": "docs/engine/hubs.md",
    "goal": "Make the reference/demo deployment a US hub with synthetic, clearly labelled data while keeping the other countries as examples.",
    "read": [
      "docs/engine/hubs.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Create a synthetic US dataset (people, companies, projects, events, publications, magazine issues) with no real names, licences or EINs; use obviously fictitious identifiers marked synthetic and example.invalid domains.",
      "Personas for a US general contractor, a sole proprietor subcontractor and a buyer.",
      "Configure the demo deployment default to US and English through CFG-001; keep UZ, GE, AM and AZ selectable.",
      "Update smoke and browser tests so they do not assume Uzbekistan as the default."
    ],
    "acceptance": [
      "A first visit to the demo shows the US hub in English with USD and month-day dates.",
      "Every demo record is labelled synthetic; no real company or person appears.",
      "Tests pass with US and with UZ as the configured default."
    ],
    "paths": ["apps/web/fixtures", "scripts/smoke.mjs", "apps/web/playwright.config.ts", "tests/web"]
  },
  {
    "id": "BE-002",
    "title": "Identity hardening follow-ups",
    "area": "backend",
    "status": "open",
    "dependsOn": ["BE-001"],
    "handbook": "docs/engine/people-and-companies.md",
    "goal": "Close review and audit follow-ups: e-mail squatting, admission revoke scoping, disabled-provider 404, lockout abuse, runtime-role privileges and idempotency crash recovery.",
    "read": [
      "docs/research/architecture-audit-2026-10.md",
      "docs/quality/security.md"
    ],
    "steps": [
      "Mailbox proof revokes a squatting unverified binding.",
      "Scope admission_revoke to the caller's own scopes or maintenance.",
      "Provider callback answers 404 when providers are disabled.",
      "Replace permanent password disable with progressive delay and owner notification; let recovery or a verified session clear the counter.",
      "Revoke API-role SELECT on audit_event and outbox_event, fix sweep_expired intervals inside the definer and require identity or maintenance for auth_disable_password (reviewed migration).",
      "Make idempotency completion atomic with the handler transaction or give in_progress records a short takeover lease; use the injected clock."
    ],
    "acceptance": [
      "Squatting scenario resolved by victim verification; tests pass on real PostgreSQL.",
      "An attacker cannot disable another person's password by failed attempts (tested).",
      "The API role cannot read audit rows (tested).",
      "A crash between handler commit and bookkeeping does not block the user's retry for more than the takeover lease (tested)."
    ],
    "paths": ["apps/api/src/modules/identity", "apps/api/src/common", "packages/data/migrations", "tests/backend"]
  },
  {
    "id": "DATA-002",
    "title": "Administration persistence",
    "area": "data",
    "status": "open",
    "dependsOn": ["DATA-001"],
    "handbook": "docs/engine/architecture.md",
    "goal": "Add platform-admin-owned tables as reviewed migrations with append-only grants.",
    "read": [
      "docs/data/model.md"
    ],
    "steps": [
      "Reuse the DATA-001 runner and runtime-role conventions; migrations go in the flat packages/data/migrations directory because the runner does not read subdirectories (or extend the runner to reject subdirectories first).",
      "Create audit/access tables with INSERT-only grants and raising triggers.",
      "Create staff, case, moderation, claim, flag, config and incident tables."
    ],
    "acceptance": [
      "Runtime role cannot update or delete audit rows.",
      "No columns added to other modules tables.",
      "Every new migration file is applied by npm run db:migrate in a test."
    ],
    "paths": ["packages/data/migrations", "tests/data"]
  },
  {
    "id": "CTRY-002",
    "title": "Country pack v2 facets with sourced facts for the launch countries and the United States",
    "area": "country-packs",
    "status": "open",
    "dependsOn": ["INTL-UZ", "INTL-GE", "INTL-AM", "INTL-AZ"],
    "handbook": "docs/engine/country-specifics.md",
    "goal": "Extend packs with facets (registers, licensing, standards, procurement, tax and e-invoicing, e-signature, payments, calendar, units, scripts, privacy, content law, national sanctions lists), each sourced and honestly verified, at country and subdivision level.",
    "read": [
      "docs/product/specification.md",
      "docs/adr/010-gathering-point-hubs-agents-and-mesh.md",
      "docs/engine/country-specifics.md",
      "docs/country-packs/how-to-add-a-country.md",
      "docs/research/architecture-audit-2026-10.md"
    ],
    "steps": [
      "Extend the Zod schema with facets and verification levels; keep v1 fields compatible.",
      "Allow subdivision-level facets (licensing, tax, privacy) and region kinds state, district and territory; allow several time zones and several identifier kinds per pack.",
      "Add a measurement-unit catalogue with explicit conversion rules (metric and imperial) referenced by packs.",
      "Extend the validator: sources required, rates as decimal strings, adapters referenced must exist.",
      "Research and add facets for UZ, GE, AM and AZ starting with registers, tax and e-invoicing; update the country guide with facet instructions."
    ],
    "acceptance": [
      "Every fact has a source and a verification level.",
      "No pack can enable a restricted place.",
      "Engine code contains no country-specific branches.",
      "The schema can express a federal country with per-state facts (tested with a fixture, not real facts)."
    ],
    "paths": ["packages/country-packs", "packages/contracts/src/common/quantity.ts", "tests/country-packs"]
  }
]
```

Notes on the proposal:

- Ids follow the validator pattern; handbook chapters exist. New areas used: `platform`, `communications`, `quality`.
- CI-001 has no dependency and can start at once; OPS-001, REL-001, BE-003 depend only on done work; INTL-003 depends only on done work.
- The step "Schedule sweep_expired from the worker" moves from BE-002 to REL-001.
- CNT-001 and WEB-002 path declarations (`apps/web/content`, `apps/web/features`) should be corrected when those packages are claimed; not repeated here.
- A notifications store package (in-app notifications and preferences) is intentionally not proposed yet; it should be written against `docs/engine/communications.md` after MAIL-001.

## 9. Open questions for the owner

- **Q1 Hosting and jurisdiction of the US demo hub.** Which hosting region, and who is the accountable operator entity? This decides backup targets (OPS-003), mail and payment providers, privacy notices and the RPO/RTO targets the runbook leaves as unknown.
- **Q2 Demo versus real data on the US hub.** Is the reference deployment demo-only (synthetic data, persona switch, no sign-up), or does it accept real sign-ups? Real sign-ups need MAIL-001, OPS-001, moderation (DATA-002/ADM-001) and US privacy notices first.
- **Q3 Order of phases.** Do you accept a platform phase (P0) before COM-001, CNT-001 and BILL-001, or should one domain package run in parallel?
- **Q4 Public URL identity.** Language (and country) in the path (`/en-us/companies/acme-builders`) for caching and search engines, or cookies as today? Handles for people, companies and projects, or opaque ids in URLs?
- **Q5 Second language for the US hub.** `es-US` as proposed, or plain `es` with US formats? Is machine-assisted translation acceptable until native review?
- **Q6 Retention.** Audit and outbox retention per hub, and how erasure requests interact with append-only audit (C4).
- **Q7 Tax and payments in the US hub.** Should the demo show sales tax and card/ACH flows at all (with fakes), or stay with free basic participation only until BILL-001 and PAY-001 are accepted?
- **Q8 Per-object assistants on public pages.** The demo shows an assistant on person, company and project pages (`components/public/*Assistant.tsx`). The rules allow one agent per person and one standing representative per company; is a per-project public assistant intended, and is it the company representative or the visitor's own agent?
- **Q9 Default country of the engine itself.** With CFG-001 the default becomes deployment configuration; what should the engine default be when nothing is configured (US, a neutral "choose your country" screen, or the visitor's request locale)?

# Platform release candidate: the US demo hub on a deployable stack (QA-002)

Status: **release candidate on synthetic data, demo-only.** No deployment happens in QA-002: nothing was deployed, pushed, tagged or registered, no provider account was created and only local throwaway credentials were used. The reference hub stays demo-only until this release candidate passes, counsel has reviewed the open US questions and the owner switches real sign-ups on ([ADR 012](../../adr/012-integrator-decisions-2026-10-31.md) decisions 26 to 29).

## What the release candidate proves

The platform phase outcome, end to end on the compose stack that mirrors the production topology ([images and stack](../../operations/images.md)), with demo mode off:

1. A person signs up in the browser (no session before verification).
2. The verification mail leaves through the outbox and the worker over **real SMTP** (the MAIL-001 adapter) to an in-memory sink; its link, in the visitor's language and on the public origin, verifies the address.
3. The person creates a company page and, from its People tab, invites a colleague who already has a verified account (step-up applies).
4. The invitation mail arrives over SMTP; the colleague accepts it with the mailed one-time token (a second use is refused) and both are active members.
5. The person creates a company project, which stays private (anonymous 404) until it is published.
6. An anonymous visitor of the US hub sees the project, the project list, the company page and the company directory; no record of either demo dataset (the example hub or the San Diego hub of DEMO-US) appears on any page, public or signed in, and demo personas in the address are ignored.

Each step runs in English and in Spanish, at desktop width (1280 px) and phone width (375 px); pages are checked for horizontal overflow on the phone and with axe (WCAG 2.2 A/AA tags) on the public project and company pages.

## How to run it

| Where | Command | What it does |
|---|---|---|
| Workstation or CI | `node tests/release/platform/run.mjs suites` | Negative authorization, readiness and worker fault suites (below) at the checked-out commit with `TRUSTWORK_REQUIRE_PG=1`; fails when a gate reports no tests, a failure or a skip |
| Workstation or CI | `node tests/release/platform/run.mjs stack` | Builds every image, starts the stack with the [release overlay](../../../tests/release/platform/compose.release.yaml) under its own project name (`trustwork-release`, never the shared `trustwork-local` development database) on free ports, checks readiness, the screening baseline and the mail path, runs the [journey](../../../tests/release/platform/journey.e2e.ts) and the [HTTP gates](../../../tests/release/platform/gates.e2e.ts) from `apps/web` with Playwright (Chromium), then stops and removes exactly its own containers and volumes. `--no-build` reuses images, `--keep` leaves the stack up |
| CI | [`release-platform`](../../../.github/workflows/release-platform.yml) | Both modes as two jobs (`release suites ...` and `release stack journey ...`) on pull requests that change the release harness, on `main` and on demand; counts go to the job summary and `tests/release/platform/dist/` is kept as an artifact for 30 days |
| `npm test` | [`release.test.ts`](../../../tests/release/platform/release.test.ts) | Without Docker: the SMTP sink against the worker's real SMTP client and templates, the overlay's settings, the suite list and this document's required sections |

The release overlay changes three things against the plain local stack: the worker submits mail over SMTP to the sink (`MAIL_TRANSPORT=smtp`, `MAIL_SMTP_SECURITY=none` on the compose network only), the API and the web run the jurisdiction gate in `edge_header` mode, and the web states `TRUSTWORK_DEMO_MODE=0`.

## Suites at the exact head commit

| Gate | Files |
|---|---|
| negative authorization | `tests/backend/authorization.test.ts`, `tests/backend/hardening/privileges.test.ts`, `tests/backend/hardening/squatting.test.ts`, `tests/data/access.test.ts`, `tests/admin/boundaries.test.ts`, `tests/jurisdiction/gate-api.test.ts` |
| readiness | `tests/ops/health.test.ts`, `tests/ops/config.test.ts` |
| worker faults | `tests/worker/faults.test.ts`, `tests/worker/concurrency.test.ts`, `tests/worker/mail/reliability.test.ts` |

The same files also run inside `npm run check`; the release job runs them on their own so the release evidence names each gate with its own counts.

## Release checklist

Status values: **pass** (observed), **CI** (runs in the named workflow at the pull request head; results are in the pull request), **open** (needs the owner or another package). Local evidence: `node tests/release/platform/run.mjs stack` on 2026-10-31 at base `d3555e4` with this harness, exit 0, 8 of 8 stack checks and 11 of 11 Playwright tests passed (4 journeys, 4 demo-persona checks, 3 HTTP gates), then the containers and volumes were removed.

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | Named, non-empty CI run at the exact head commit with test counts | `release-platform` workflow: job `release suites ...` (counts per gate, fails on zero tests or any skip) and job `release stack journey ...` (Playwright counts per project); both write the job summary | CI |
| 2 | Journey with demo mode off, English and Spanish, desktop and phone | 4 of 4 journeys passed; mail over SMTP in the visitor language, links on the public origin | pass |
| 3 | No fixture data | Every page of the journey, `/`, `/projects`, `/companies`, `/people`, `/news`, `/events`, search and five workspace pages with `?persona=owner&scenario=error`: no name of either demo dataset, no demo strip | pass |
| 4 | Readiness | Every long-running service healthy, migrate exited 0, `/health/ready` 200 with database and ledger `ok` at schema `20261102124000_screening.sql`; readiness suites in CI | pass, CI |
| 5 | Negative authorization | Forged mutations through the proxy refused (foreign origin, missing header); an unpublished project answers 404 to an anonymous visitor and a spent invitation token is refused; negative authorization suites in CI | pass, CI |
| 6 | Worker faults | Worker fault, concurrency and mail reliability suites in CI | CI |
| 7 | Security headers and strict nonce CSP on every page | 15 public and 11 signed-in pages: `script-src 'self' 'nonce-...' 'strict-dynamic'` without `unsafe-inline` or `unsafe-eval`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`; every executable script carries the response's nonce; a fresh nonce per response; `X-Frame-Options`, `nosniff`, referrer, permissions and opener policies; no `Server`, `X-Powered-By`, `x-nonce` or `x-middleware-*` header | pass |
| 8 | Jurisdiction gate mode set | `edge_header` on the API and the web: CU, IR, KP, RU, UA-43 and UA-14 get 451 `jurisdiction.restricted` at the API and for media, and the noindex refusal page instead of the home page; UA-30, US and no header are served | pass (local mode); production mode open |
| 9 | Sanctions baseline missing, money gates closed | `screening_available()` is false on a fresh hub; no payment route or provider exists | pass (fail closed, expected on the demo) |
| 10 | One-time links never in logs | With the SMTP transport the worker and API logs (530 lines) contain no verification or invitation link and no printed message | pass |
| 11 | Images, image policy, SBOM, stack smoke | `images` workflow (on `main` at `d3555e4`: success) | CI |
| 12 | Backup and point-in-time restore drill | `restore-drill` workflow, dispatched for the pull request branch; evidence JSON kept as an artifact | CI |
| 13 | Dependency audit, licences, secret scan, DCO | `check` workflow | CI |
| 14 | Automated accessibility | axe (WCAG 2.2 A/AA tags) on the public project and company pages in both languages at both widths; no horizontal overflow on the phone | pass |
| 15 | Manual accessibility and screen reader | Not done in this package | open |
| 16 | Deployment | None, by design | not applicable |

## Provider modes

| Capability | Release candidate (local and CI) | Production state | Decision needed |
|---|---|---|---|
| Mail | `smtp` to the in-memory sink (release overlay); `log` on the plain local stack | No relay chosen: without `MAIL_TRANSPORT=smtp` and its settings the worker records mail with the fake transport and sends nothing | Mail provider and sender domain (ADR 012 row 12) |
| Sign-in providers | `AUTH_PROVIDER_MODE=fake` (local only; refused in production) | `disabled`: e-mail and password only | Which identity providers, their client registration |
| Payments and money | No route, no provider: nothing contacts a payment provider and no money moves (billing module) | Same | Payment provider (row 12), prices and commissions (row 7) |
| Sanctions screening lists | `file` mode with no exports: the OFAC baseline is missing, `screening_available()` is false | Same until the official exports are mounted and refreshed weekly | Who refreshes the exports, or KEYS-001 for `live` mode |
| Jurisdiction gate | `edge_header` with a header the test sets itself (stands in for the edge) | Must be explicit: the API refuses to start in production without a mode | `upstream_gate`, `ranges_file` (a DB-IP table under CC BY 4.0, refreshed monthly) or `edge_header` behind an edge that strips client copies |
| Model, retrieval, channels (agent) | Unavailable model and fake ports; the agent answers that it is unavailable | Same; live models arrive with LLM-001 | Model provider and egress policy (row 12) |
| Object storage | SeaweedFS container, unused (no adapter yet) | None | Storage provider with its adapter package |
| Geolocation dataset | None | None | Only with `ranges_file` |

## Known limitations

- **Demo-only.** The reference hub runs synthetic data until counsel review and the owner's switch (decision 28). The hub cannot go public while demo data is loaded: that is the launch gate of HUB-001, which is still open, so the sign-up switch of decision 28 does not exist yet as a hub setting.
- **Sanctions baseline missing, money gates closed.** A fresh hub has no OFAC exports, so screening is unavailable and every gate that reads it must refuse (fail closed). This is expected on the demo. The gates themselves (SANC-004) are not built yet; today no money moves at all because no payment route or provider exists.
- **Jurisdiction gate in the release overlay.** `edge_header` here trusts a header the client could send, which is acceptable only because the test plays the edge. The hosted reference hub needs its own mode (owner gate list, item 4).
- **Spanish by preference, not by address.** Spanish is chosen with the language cookie; the `/es/` addresses with `hreflang` (decision 27) arrive with WEB-005.
- **Invitations in the hub language.** The invitation mail uses the hub default language (English), because the inviter caused it; a Spanish-speaking invitee receives English.
- **Drafts of legal text.** Sign-up accepts the terms version `draft-2026-10`; there is no reviewed terms or privacy notice version yet.
- **What this run does not prove.** Manual keyboard and screen-reader passes, load and performance, the hosted edge (TLS, HSTS, client addresses), a production backup schedule and the real provider adapters are outside this release candidate.

## Defects found

Severity: **high** blocks real users, **medium** visible wrong behaviour or a missing guarantee, **low** cosmetic, documentation or operations hazard. None was fixed here: every one lies outside this package's paths.

| ID | Severity | Defect | Where | Follow-up |
|---|---|---|---|---|
| D1 | high | The invitation mail links to `/invitations/<membershipId>/<token>`, but the web app has no page there (404 in all four journeys) and the accept route `POST /v1/companies/:id/memberships/accept` needs the company id, which the link does not carry. An invitee cannot accept from the mail. The journey accepts through the same-origin API to continue and records the link status | `apps/worker/src/mail/templates.ts` (`DEFAULT_LINK_PATHS.invitation`), `apps/web/app`, identity module | A web page for the invitation link and an accept call that resolves the company from the membership (or a link that names it); must land before any real invitation |
| D2 | medium | The public projection of a published project has no owner: a company project shows "Owner" with a question mark, and the company page shows 0 projects and "No projects published yet" | `GET /v1/projects` projection, public project and company pages | Project the owner (company handle and name, or a person only with their consent) and count published projects on the company page |
| D3 | low | The web jurisdiction door skips paths outside the proxy matcher (`_next/` static chunks and the icon files); repository media and every page and API call are refused. The module page says media are refused, which is true, but app assets are still served to a restricted place | `apps/web/proxy.ts` matcher, jurisdiction module page | Decide whether static assets must be refused too, then align the matcher or the documentation |
| D4 | low | The sign-up terms and privacy links point to `/#legal` and no legal page exists; the accepted terms version is `draft-2026-10` | `apps/web/components/auth/SignupForm.tsx` | Real terms and privacy notice versions after counsel review (owner gate list, item 2) |
| D5 | low | Invitation mail always uses the hub default language, even when the invitee has an account with a language preference | identity module, mail intents | Record the invitee's preferred language and use it |
| D6 | low | `infra/compose.yaml` fixes the project name `trustwork-local`, which is also the shared development database; the full-stack command run on such a machine joins that project, and `down -v` removes the shared database volume. The release runner uses its own project name | `infra/compose.yaml`, [images and stack](../../operations/images.md) | Recommend `-p <name>` in the stack instructions, or give the stack profile its own project |

## Versioning and tagging plan

- The repository is at `0.1.0` (root `package.json`) and has no tags or releases yet.
- Proposed first tag: **`v0.1.0-rc.1`**, an annotated tag on the `main` merge commit of QA-002 once `check`, `images`, `restore-drill` and `release-platform` are green at that exact commit. Only the conductor creates and pushes tags; no agent pushes one.
- Release candidates increase the suffix (`-rc.2`, ...) for fixes found before the owner's switch; `v0.1.0` is cut only after the owner gate list is closed. Before 1.0, a minor version for new capabilities and a patch version for fixes; migrations stay expand/migrate/contract so a previous API keeps working against a newer schema.
- Images are not published: no registry exists. When the owner chooses hosting publication, images are built from the tag, carry the tag and the commit as labels, and keep their SBOMs (the `images` workflow already writes one per image).
- Release notes come from the merged pull requests between tags and the status page ([status](../../engine/status.md)); the release names the commit, the CI runs and this checklist.

## Owner gate list

Nothing below is done in QA-002. Each item needs the owner (or counsel through the owner) before the reference hub takes real people.

1. **Real sign-ups switch** (decision 28): after this release candidate, counsel review and the hub setting from HUB-001; until then the hub stays demo-only.
2. **Operator entity and privacy notices**: Contribuda as operator (decision 26) with a reviewed privacy notice, terms version and US state privacy wording (CCPA/CPRA and others), retention periods and legal bases (row 4), agent disclosure and liability wording (row 5), the data-broker question for imported people data (row 10) and electronic agreement validity (row 11).
3. **Providers** (row 12): mail relay and sender domain, sign-in providers, later payments, models and storage; each starts with its adapter's fake and a second-person activation.
4. **Jurisdiction gate mode for the hosted hub**: `upstream_gate` (the hosting landing's place check, as the preview), `ranges_file` (download and reduce the DB-IP table monthly, attribution shown) or `edge_header` behind an edge that strips client copies. The API refuses to start in production without one.
5. **Sanctions baseline**: who downloads `SDN.XML` and `CONSOLIDATED.XML` at least weekly into the lists directory, or approval of KEYS-001 for `live` mode. Until then the money and commitment gates stay closed, which is correct for the demo.
6. **Hosting execution** (decision 26 answered: Railway, US region, operated by Contribuda): creating the services follows the runbook below; the conductor or the owner does it, not an agent.
7. **Secrets and roles**: generated `AUTH_FLOW_SECRET`, `MAIL_SECRET_KEY`, `SECOND_FACTOR_SECRET_KEY` and database login passwords in sealed hosting variables; the role step run once by the database superuser.
8. **Domain and HSTS**: the hub's domain, then `TRUSTWORK_HSTS` once the hub owns the whole host.
9. **Backups**: RPO 24 hours and RTO 8 hours (decision 26) need the hosted database's backup and point-in-time restore configured and one restore rehearsed on the hosted copy; the CI drill proves the tooling on synthetic data only.
10. **Fix the release blockers** in the defects table (D1 before any real invitation).
11. **Tag** `v0.1.0-rc.1` (conductor), then publish the release notes.
12. **Manual accessibility and screen-reader pass** on the journey screens, and counsel's reading of the jurisdiction refusal text.

## Hosted deployment runbook (for the conductor and the owner; not executed)

The service layout, variables, health checks, routing, client addresses, roles and release order are in [images and stack, "Railway"](../../operations/images.md). On top of that page, a hosted copy of this release candidate needs:

1. The owner gate list items 2 to 9 decided.
2. On the API and the web: `TRUSTWORK_JURISDICTION_GATE` set to the chosen mode; on the worker the same gate variables for the range-table age check.
3. On the worker: `MAIL_TRANSPORT=smtp`, `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY=starttls` (or `tls`), credentials, `MAIL_FROM_ADDRESS` and `MAIL_PUBLIC_ORIGIN`; never `none` outside a private network.
4. On the web: `TRUSTWORK_DEFAULT_COUNTRY=US`, `TRUSTWORK_API_ORIGIN` on the private network and **no** `TRUSTWORK_DEMO_MODE` once real sign-ups open (the existing preview keeps `TRUSTWORK_DEMO_MODE=1`).
5. Release order: migrate (exit 0), API (ready on `/health/ready`), worker, web, proxy.
6. After the deployment: run this journey against the hosted origin with a mail sink of the operator's own (or a real mailbox the operator controls) and the HTTP gates; record the version, the commit and the results here.

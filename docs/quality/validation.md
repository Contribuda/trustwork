# Verification contract

## Foundation checks

`npm ci` uses the exact lockfile. `npm run check` performs ESLint, strict TypeScript checks, recursive discovery of `.test.ts`, `.test.mjs` and `.test.js` under `tests/`, with meaningful policy tests, local documentation link/image checksum/task DAG validation, production compilation of contracts/API/worker/web, and loopback API/web smoke checks. `tests/worker` runs the worker against real PostgreSQL: it consumes outbox rows appended by the API role, runs two workers concurrently, and injects faults (SIGKILL between lease and completion, duplicate delivery, stale fencing tokens, clock skew, shutdown). API and web smoke checks verify their honest bootstrap responses. `npm audit` is recorded separately; never use blind force-fix.

Additional negative tests prove a nested failing test fails the gate, unknown graph states and unsupported acceptance evidence are rejected, and repeatable integration bookkeeping remains usable after foundation acceptance. These prove the Git mechanism under cooperative clients; GitHub branch policy/account access is a separate check.

## Continuous integration gates

`.github/workflows/check.yml` runs on every pull request and on `main` (CI-001):

- **npm run check** against a PostgreSQL service with `TRUSTWORK_REQUIRE_PG=1`: a database suite that cannot reach PostgreSQL fails instead of skipping. Locally the same variable turns skips into failures; without it, `scripts/run-tests.mjs` ends with a summary of every skipped test. Then the OpenAPI drift check (`scripts/ci/openapi-drift.mjs`) and a clean-tree check (`scripts/ci/assert-clean-tree.mjs`): a clean checkout must stay clean after `npm run check`.
- **browser tests**: the web build, the client bundle-size budget (`scripts/ci/bundle-budget.mjs`, budgets in `scripts/ci/bundle-budget.json`), the Playwright suite with axe checks, and the clean-tree check.
- **design-system accessibility**: Storybook build, then axe-core over every story plus keyboard, contrast and mobile specs (`npm run test:a11y -w @trustwork/ui`).
- **dependency audit and licences**: `npm audit --omit=dev --audit-level=high` (runtime dependencies; development tooling advisories stay a separate record) and the licence allowlist (`scripts/ci/licenses.mjs`, policy in `scripts/ci/license-policy.json`).
- **DCO sign-off** and **secret scan** (gitleaks, download verified against the release checksum).

Dependabot (`.github/dependabot.yml`) proposes weekly npm and GitHub Actions updates as pull requests that pass the same gates.

Database test files share a PostgreSQL cluster safely: each file uses its own database and login role and first takes one of a bounded number of cluster-wide test slots (advisory locks sized from `max_connections`; override with `TRUSTWORK_TEST_PG_SLOTS`), so several checkouts running suites at once queue instead of exhausting connections; files that open several worker pools take two slots. Leaked test databases and roles older than six hours are dropped by later runs. Tests that compare a time computed in the test process with the database's `now()` wait for the database clock (`untilDatabaseTimePasses`) or measure from a database timestamp, because a Docker VM clock runs tens of milliseconds apart from the host.

## Product testing as slices arrive

- Pure domain tests: money rounding/units, snapshot immutability, state transitions, causal reputation attribution, evidence corrections and mandate limits.
- PostgreSQL integration: actual constraints and runtime RLS role, cross-party joins, concurrent reservation/revision conflicts, migration from prior schema, outbox/receipt deduplication.
- Provider contract/fault tests: deterministic fake before any live integration, duplicate/out-of-order events, crash after external effect before saving result followed by second-worker takeover, stale in-flight worker, key-retention expiry, acknowledgement-then-rejection, unknown outcome and revoked credential.
- API/browser journeys: reader without employer, combined buyer/seller, personal project, employment end, quote versions/partial fulfillment, assistant approval/revoke, magazine mobile, admin denied paths.
- Accessibility/privacy: manual keyboard/screen reader and public/private export/search/notification projection checks.
- Operations: dependency readiness, performance thresholds based on measured baselines, backup/restore with erasure replay, incident rehearsal and detach test.

Do not add tests that only mirror markup or assert mocks call themselves. Select meaningful acceptance risks. No invented coverage target replaces these cases.

## Exact-head acceptance

Every result reports base SHA, candidate SHA, branch/PR, files, commands+exit codes+counts, evidence URLs/hashes, skipped tests and risks. The named check is `local-check`: `npm run check` on a clean checkout of the reviewed candidate/merge head, recorded with commands, exit codes, test counts, tree hash and environment, and repeated independently by the reviewer; hosted GitHub Actions is disabled by human decision 2026-10-27. “No checks”, a worker exit, merged PR alone, an upstream report acceptance or a reason tests were not run is not accepted implementation evidence. After merging, record `local-check` for the new main head; after deployment, separately verify service version and user journeys. Bootstrap does not authorize deployment.

Current execution evidence is recorded in bootstrap validation (kept in the project archive, not in this repository). Update it only with observed results; do not prefill PASS for future tests.

[RAG evaluation](retrieval-evaluation.md) separates deterministic fake-vector contract tests from required real-model Russian relevance, PostgreSQL authorization/ANN recall, concurrency/egress and restore tests. RAG-401 must supply actual evidence before QA-001; zero fixture leaks do not establish production security.

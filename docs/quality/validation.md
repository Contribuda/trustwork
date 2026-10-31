# Verification contract

## Foundation checks

`npm ci` uses the exact lockfile. `npm run check` performs ESLint, strict TypeScript checks, recursive discovery of `.test.ts`, `.test.mjs` and `.test.js` under `tests/`, with meaningful policy tests, local documentation link/image checksum/task DAG validation, production compilation of contracts/API/worker/web, and loopback API/web smoke checks. `npm run worker:demo` must show a denied unauthorized action and zero external effects. API and web smoke checks verify their honest bootstrap responses. `npm audit` is recorded separately; never use blind force-fix.

Additional negative tests prove a nested failing test fails the gate, unknown graph states and unsupported acceptance evidence are rejected, and repeatable integration bookkeeping remains usable after foundation acceptance. These prove the Git mechanism under cooperative clients; GitHub branch policy/account access is a separate check.

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

Current execution evidence is recorded in bootstrap validation (private repository record, not exported). Update it only with observed results; do not prefill PASS for future tests.

[RAG evaluation](retrieval-evaluation.md) separates deterministic fake-vector contract tests from required real-model Russian relevance, PostgreSQL authorization/ANN recall, concurrency/egress and restore tests. RAG-401 must supply actual evidence before QA-001; zero fixture leaks do not establish production security.

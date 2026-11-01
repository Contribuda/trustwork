# SANC-006 screening console: implementation and evidence

Status: **Partial; work package remains in progress.** No deployment or production acceptance is claimed.

## Implemented boundary

Outside demo mode, `/admin/hubs/:hub/trust/screening` reads the API under the visitor's own session. The screening-specific adapter reads the node anchor and the caller's node roles, verifies the hub belongs to that node, and then reads screening cases, jurisdiction holds and re-screen runs. An elevated node compliance officer may act; an auditor can read. Existing API guards, row-level security, conflict checks, command authorization and audit remain authoritative. The screen explicitly describes its node-wide scope. It never uses a query persona or fixture fallback. Staff must already have an elevated session; this slice does not build the general console sign-in/elevation surface.

The queue has one row per subject and the API's lateness flag. Cases show the screened and list-entry names side by side, decision history, and confirm, proposal, independent approval/rejection and appeal-review forms. `/trust/screening?view=approvals` is the screening-specific inbox: the existing screening proposal endpoint binds the displayed digest and requires another person. It must not be substituted with the generic approvals API, whose frozen action enum does not contain screening decisions. An expired or own proposal cannot be approved in the UI; the API independently enforces separation of duties.

Holds show place, source, dataset, time and retained clearing evidence. Every write requires a reason; ambiguous outcomes retain the original payload and idempotency key. The manual-run adapter uses the existing SANC-005 command, its serialized unfinished-run semantics, audit and bounded operator window. The adapter adds no migration or policy. Baseline and additional lists now read actual list rows, active immutable versions, publication dates, entry counts and database freshness. Missing and stale baseline lists show the gate-unavailable banner. The latest 50 versions per list are available in the read-only history. No baseline switch, matching control or activation bypass exists.

`/admin/hubs/:hub/participants/compliance/:stateId` retains its subject-state route. `/participants/people/:id` and `/participants/companies/:id` now embed the shared `CompliancePanel` after an exact, authorized subject lookup. These targeted pages show only screening data; they explicitly say the rest of the participant card is not connected. They never attach a fixture card or read private participant data. The existing node-compliance/auditor RLS audience applies; broader private data still needs its existing case grant. No case-grant bypass was added. Seven `screening.console` dictionaries supply the visible copy. The explicit demo branch retains the existing labelled synthetic console.

## Read APIs and privacy

- `GET /v1/admin/screening/lists`: actual lists, active versions and freshness, with no entries, source URLs, arbitrary sanity JSON or credential metadata.
- `GET /v1/admin/screening/lists/:id/versions`: latest 50 immutable version summaries.
- `GET /v1/admin/jurisdiction/geolocation`: description of the exact adapter installed in the API request hook at startup; dataset age is derived only from its recorded month. Upstream, edge and fake modes without a month remain unknown. A historical hold is never current metadata.
- `GET /v1/admin/screening/subjects/lookup/:kind/:id`: exact lookup in the forced-RLS screening state table for `person` or `company`; the same screening projection as the state-id route, without a participant/profile join.
- `GET /v1/admin/screening/metrics?hubId=...`: explicit unknowns for unavailable hub cohorts, plus separately labelled node-wide operational durations of completed re-screen runs. A run appears only when its actual recorded items prove at least ten distinct person principals. Companies and event counts do not stand in for people. Suppressed rows never leave the repository.
- Re-screen GET and POST responses use `ScreeningConsoleRunSchema`: only operational state/time and nullable progress. Both suppress participant counters until the recorded run cohort proves ten distinct people; raw outcomes and counters are never included. The underlying SANC-005 command, transactional idempotency and authority are unchanged.

Every new read requires authentication, elevation and the existing database `jurisdiction_staff_reader()` authority (node compliance officer or auditor); lookup failures remain not found. The list freshness function is SECURITY DEFINER, so the explicit staff check runs before it. Tables still use their existing forced RLS. No new permission, schema migration, provider or list-writing command was introduced.

## Remaining dependencies and concrete data proposal

The nine hub cohort metrics remain unknown, with a machine-readable reason per metric:

| Metric | Missing datum |
|---|---|
| Refusals per place/day | `jurisdiction_refusal_count` records events by day/place/door, without distinct principals or a hub cohort; an event total cannot prove the minimum cohort |
| Open/cleared holds and median clearance time | `jurisdiction_hold` has no hub attribution |
| Opened/decided/late matches and not-same-person share | `screening_match` and `screening_decision` have no hub attribution; no accepted hub cohort or period for the ratio is recorded |
| Gate refusals by kind | No persisted gate-refusal counter with a hub and qualifying cohort exists |

A future reviewed change must define the hub attribution and reporting window, and persist privacy-preserving aggregate cohort evidence sufficient to prove ten distinct principals. It must specify the not-same-person ratio population and period. It must not add raw visitor addresses or a per-person refusal history. The concrete technical definition is proposed in [ADR 023](../../../../docs/adr/023-screening-operational-cohorts.md), awaiting explicit acceptance before any metrics migration; node totals are not relabelled as hub metrics. No invented denominator or raw suppressed row is returned.

Additional-list creation/configuration now uses a maintenance-installed fact catalog and a dedicated immutable proposal/decision record. The existing node authority remains unchanged. The continuation adds the bounded list authority commands below; provider activation is not included. Actual notification delivery belongs to SANC-007. Staff elevation UI, human screen-reader review and native-language review remain outside this bounded implementation.

SANC-006 stays **in progress**, even though the four explicit safeguards have end-to-end tests. All metadata that now has a real source is displayed; only the concrete gaps above remain unknown.

## Focused verification

All input records are synthetic. `world.ts` uses embedded PostgreSQL, the real runtime role and assignment resolver, worker screening over fake local list input, and password/TOTP/elevation API flows. No provider or external service is called. The loopback browser stack uses the existing development-only insecure-cookie option; production cookie rules are unchanged. Its control endpoint exposes only disposable local test sessions, binds to loopback, and is not product code.

Run one test process at a time:

```sh
TRUSTWORK_TEST_PG_BACKEND=embedded TRUSTWORK_REQUIRE_PG=1 node --import tsx --test --test-concurrency=1 tests/web/admin/screening/api.test.ts tests/web/admin/screening/reads.test.ts
NEXT_DIST_DIR=.next-sanc006 NEXT_TELEMETRY_DISABLED=1 TRUSTWORK_DEMO_MODE=0 TRUSTWORK_API_ORIGIN=http://127.0.0.1:3581 npm run build -w @trustwork/web
SANC006_EVIDENCE_DIR=/absolute/path/to/evidence TRUSTWORK_TEST_PG_BACKEND=embedded TRUSTWORK_REQUIRE_PG=1 NEXT_DIST_DIR=.next-sanc006 node_modules/.bin/playwright test -c tests/web/admin/screening/playwright.config.ts
```

The API tests cover every new read for anonymous/subject/ordinary/non-elevated accounts and elevated non-screening staff, foreign-node session and foreign subject-id denial, auditor reads with write refusal, missing/warning/stale freshness from real repository input, current/stale/unknown geolocation, exact person/company lookup, privacy projection and the nine-versus-ten distinct-person boundary (a company cannot satisfy the tenth person), as well as required reason, rejected client window/CSRF, concurrent manual requests, replay and a crash before transaction commit. The new mutation is also registered in the existing per-module idempotency cases, without changing the shared crash-suite list.

The browser test uses two independently elevated officers and the subject's actual session. It verifies console refusal for the subject, no baseline controls, required clearing/proposal reasons, hold history, rejection of self-approval through the API, successful second-person approval with the exact digest, the resulting money hold, an approval from the embedded person panel, both person/company panel routes and their subject/elevated non-screening staff denial, manual run requests, Russian desktop/mobile screenshots, keyboard focus, overflow and an axe scan. Automated axe checks do not substitute for a human screen-reader review.

Next may add its custom output directory to `apps/web/tsconfig.json` during the isolated build; remove only those generated entries before committing. Keep screenshots and command logs in the handoff evidence directory. The PR result report records the actual command outcomes and limitations; this document does not assert that an unrun full suite passed.

## Continuation: list authority

Maintenance runs `node --import tsx apps/worker/src/screening-lists/sync-sources.ts --dry-run` to inspect eligible installed facts, then runs it without `--dry-run` under the migrator connection to synchronize authority. The loader uses the existing deployment pack registry. Only official facts naming an implemented export adapter and its exact HTTPS origin are eligible. Facts do not select an operational list. Built-in facts currently yield no eligible additional source: the US CSL fact names a query adapter; the OFAC fact does not name an additional export adapter. Tests alone install explicitly synthetic fixtures.

The console reads `GET /v1/admin/screening/list-authority?hubId=...`. `POST /v1/admin/screening/list-proposals` accepts source/hub IDs, bounded cadence/warning/stale intervals, reason and evidence. It cannot accept a URL, path, adapter, live mode, matching threshold or baseline identity. `POST /v1/admin/screening/list-proposals/:id/decision` binds the reviewed digest, current source, current staff authority, another person, expiry and the prior configuration. Only an approval creates or reconfigures a file list; it never performs ingestion or activates a provider. Concurrency is serialized and every write/audit completes with the idempotency result.

Additional lists expose the existing pause/resume command; staged versions expose the existing reason-required confirmation command. Baseline lists never expose a status control and the API independently refuses it. Worker source absence, revoked authority, fake mode restrictions and unavailable live activation remain explicit failures. The raw worker stage/activation path also refuses retired registered source authority. Historical versions and source/proposal snapshots remain immutable.

Ownership: SANC-002 (#322) list contracts, adapters, migration, schema, repositories and worker; SANC-003 (#323) narrow screening controller/module integration; SANC-005 (#325) existing run projections; SANC-001 (#321) existing node staff authority; SANC-006 (#326) UI/locales and focused real API/browser tests; BE-005 per-module crash registration. Active AGT, PRV and BILL implementations are untouched. Applied migrations and shared package/status objects are preserved.

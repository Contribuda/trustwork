# Jurisdiction gate and holds (SANC-001)

The first slice of the sanctions compliance engine ([ADR 014](../../../../../docs/adr/014-sanctions-compliance-engine.md), module page [Sanctions compliance](../../../../../docs/engine/modules/sanctions-compliance.md)). Restricted places (the authoritative list in `packages/country-packs/packs/restricted.json`) are refused at every door, and a signed-in person seen in one is held until a compliance officer clears the hold. Not legal advice: the refusal text and the operator's obligations are for counsel to confirm.

## What happens

| Where | Behaviour |
|---|---|
| Web proxy (`apps/web/proxy.ts`, `app/_lib/jurisdiction.ts`) | Before anything else: a page request (GET or HEAD, HTML, not a server action) from a restricted place renders `/restricted` in place, in the visitor's language (`jurisdiction` namespace, every engine language), with `X-Robots-Tag: noindex`; any other request, `/v1/*` and media included, is answered 451 `jurisdiction.restricted`. Only the refusal page stays open. A refused request that carries the session cookie is relayed to the API (`GET /v1/jurisdiction/sighting`, the session cookie and `X-Forwarded-For` only) beside the response, so the API can hold the person. |
| API (`gate.ts`, an `onRequest` hook after the identity hook) | Every request except `/health`, `/health/live` and `/health/ready`: from a restricted place → 451 `jurisdiction.restricted`, and the person of a live session is held first; a live session of a held person → 403 `auth.jurisdiction_hold`, from anywhere. If the hold check cannot be made the request gets 503: the gate never opens because the database is unavailable. |
| Sign-in (`PrincipalService.createSession`) | Every path that issues a session (password, provider, second factor, e-mail verification, recovery) refuses a held person with 403 `auth.jurisdiction_hold`; a provider callback returns to the sign-in page with `?auth=jurisdiction_hold`, where the reason is shown. |
| Staff (`jurisdiction.controller.ts`) | `GET /v1/admin/jurisdiction/holds?open=true&personId=` and `POST /v1/admin/jurisdiction/holds/:id/clear { reason, evidence }` behind an elevated session. The database decides: a compliance officer of the node (`staff_role_assignment` role `compliance-officer`, node scope), never the subject, no declared conflict of interest with the subject, a reason and an evidence category (`document`, `call`, `travel_record`, `other`); concurrent reviewers serialise on the row and exactly one clears; the clear is audited (`admin_audit_event`, action `jurisdiction.hold_cleared`, permission `admin.screening.holds.clear`). Compliance officers and auditors read holds and refusal counters; nobody else does, the subject included. |

A hold names the place, the source, the geolocation dataset and the time; there is at most one open hold per person (a second sighting keeps the first); a cleared hold stays as it was cleared and a new sighting holds again. Rows are never deleted (sanctions records, kept through erasure for the pack's record-keeping period). No table, log line or outbox payload of this module contains a network address: logs and records name the place and the dataset.

## Configuration

The same variables for the API and the web.

| Variable | Meaning |
|---|---|
| `TRUSTWORK_JURISDICTION_GATE` | `ranges_file`, `edge_header`, `upstream_gate` or `fake`. Unset: unconfigured, accepted only outside production. With a database, the API refuses to start in production without a mode, and refuses `fake` there (exit 78, `config.invalid`). A web process without a mode serves and logs `jurisdiction.gate_unconfigured`; a mode that cannot be built makes the web answer 503 to everything but the refusal page. |
| `TRUSTWORK_JURISDICTION_RANGES_FILE` | The reduced range table for `ranges_file` (default `<TRUSTWORK_DATA_DIR>/jurisdiction/restricted-ranges.json`). Refused at start when it is malformed, unsorted, overlapping or names a code that is not a listed restricted place. |
| `TRUSTWORK_JURISDICTION_COUNTRY_HEADER`, `TRUSTWORK_JURISDICTION_REGION_HEADER` | For `edge_header`: the country (ISO 3166-1 alpha-2) and optional region header written by an edge or CDN that strips client-supplied copies. Ukraine is refused only when the region is known to be a listed one. |
| `API_TRUSTED_PROXY_HOPS`, `API_TRUSTED_PROXIES` | The client address the API geolocates comes only from Fastify's trusted-proxy rules; behind the web's `/v1` rewrite set `API_TRUSTED_PROXY_HOPS=1` (already required for rate limits), otherwise relayed sightings hold nobody. |

The web reads the client address from `X-Real-IP`, else the last `X-Forwarded-For` entry (the hop the edge appended).

### Building the range table

The engine ships no geolocation dataset and makes no network call. The operator downloads a city-level CSV under its own licence and reduces it:

```sh
node packages/compliance/bin/restricted-ranges.mjs --input dbip-city-lite-2026-10.csv --month 2026-10 \
  --output "$TRUSTWORK_DATA_DIR/jurisdiction/restricted-ranges.json"
```

DB-IP "IP to City Lite" (CC BY 4.0, no account or key) is the recommended source; its attribution is written into the table and shown on the refusal page. Other datasets work with `--dataset`, `--attribution` and `--columns start,end,country,region`; `--region-map` overrides the Ukrainian region names. Refresh it monthly; a table older than two months is due (`rangeTableAgeInMonths`; the worker check arrives with SANC-002).

### Deployment notes

- The hosted preview sits behind the hosting landing's place check: set `TRUSTWORK_JURISDICTION_GATE=upstream_gate` on its API before deploying a build that contains SANC-001 (the API would otherwise refuse to start in production).
- The restricted places come from the synced kernel table (`packages/data/bin/kernel-sync.mjs`); without it the API falls back to the country-pack file in a source checkout and refuses to start when neither exists.
- `ElevationGuard` admits sessions whose principal has a staff role; until ADM-001 resolves the scoped roles of `staff_role_assignment` into the principal, a deployment's staff role resolver must list the officers (the database still decides with the node assignment).

## Not in this slice

Self-declared places and the payout-country check (SANC-004), list screening (SANC-002, SANC-003), console screens (SANC-006), mail notices to the person when a hold is placed or cleared (SANC-007), our own services (SANC-008). The deployment-location attestation (SANC-009) lives in [`attestation/`](attestation/README.md).

## Tests

`tests/contracts/sanctions.test.ts` (addresses, range tables, adapters, configuration, records), `tests/jurisdiction/ranges-generator.test.ts` (offline generator), `tests/jurisdiction/holds-data.test.ts` (PostgreSQL under the runtime role: one open hold under concurrent sightings, no direct writes, staff-only reads, clearing refused for other staff, missing elevation, the subject and a conflicted reviewer, racing reviewers, audit, re-hold), `tests/jurisdiction/gate-api.test.ts` (the API end to end: 451 before any route, holds, refusal at password and provider sign-in, staff clearing, production configuration, edge header and trusted proxies), `tests/jurisdiction/web-gate.test.ts` (the web door and relay).

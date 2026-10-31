# Deployment-location attestation (SANC-009)

The operator's statement of where its legal entity and its hosting are ([ADR 014](../../../../../../docs/adr/014-sanctions-compliance-engine.md) decisions 3 to 5, module page [Sanctions compliance](../../../../../../docs/engine/modules/sanctions-compliance.md), data [section 24a](../../../../../../docs/data/model.md#24a-sanctions-compliance)). The engine never geolocates the server it runs on, never phones home and never disables itself by location (decision 3); instead a node or platform administrator **attests** the place in the setup wizard, a restricted place is refused, and the statement is recorded, audited and renewed. Not legal advice.

Status: **Live** as an API and storage (not deployed). The setup-wizard step and the console screen are not built here: the wizard UI is ADM-002 / HUB-004 (`/admin/setup`, screen SW-4), which call the routes below.

## Evidence, not a guarantee

An operator can state something untrue (decision 5). The attestation complements, and never replaces, the refusals in configuration, country packs, the database kernel (`kernel_place_restricted`) and the jurisdiction gate (SANC-001). Every view carries `basis: "operator_statement"`; no reader may present it as a verification of where the server is.

## What is attested

| Field | Rule |
|---|---|
| `operatorEntityCountry`, `operatorEntityRegion` | Country of the operator's legal entity (ISO 3166-1 alpha-2) and, where the restricted list names regions of that country (today Ukraine: `UA-43`, `UA-40`, `UA-14`, `UA-09`), its region (ISO 3166-2); otherwise the region is optional |
| `hostingCountry`, `hostingRegion` | The same for the hosting |
| `gateMode` | The jurisdiction-gate mode the deployment runs: `ranges_file`, `edge_header` or `upstream_gate` (`fake` is a test adapter, never attested) |
| `confirmed: true`, `statementVersion: "deployment-location-1"`, `reason` | The attesting person confirms the statement; there is no implicit attestation |
| `supersedes` | `null` for the first attestation, else the id of the current one (renewal) |

A place covered by the authoritative restricted list (`packages/country-packs/packs/restricted.json`, synced into `restricted_place`) is refused, at country and region level (`RU`, `RU-MOW`, `IR`, `CU`, `KP`, `UA-43`, ...). A country whose regions the list distinguishes needs its region (`UA` alone is refused with `region_required`). An unsynced list refuses everything (fail closed).

## Routes

All behind a signed-in session with a staff role covering this API's hub and a live elevation (`ElevationGuard`); the database re-checks everything.

| Route | Who | Result |
|---|---|---|
| `GET /v1/admin/jurisdiction/attestation` | staff | `DeploymentAttestationStatusSchema`: `state` (`missing`, `valid`, `renewal_due`, `expired`, `contradicted`, `restricted`), `problems`, the current attestation **without** the attesting person, `renewalDueAt`, the reminder and this attestation's share of the `sanctions_screening_configured` launch gate (`open`, `satisfied`, `invalidated`) |
| `GET /v1/admin/jurisdiction/attestation/history` | node or platform staff holding an attesting permission or `admin.audit.read` at the node, and the node's compliance officers and auditors (row-level security; others get an empty list) | The chain of `DeploymentLocationAttestationSchema` records, newest first, with the attesting person, role, permission and elevation |
| `POST /v1/admin/jurisdiction/attestation` (`Idempotency-Key`, BE-005 `in_transaction`) | `admin.node.hubs.manage` or `admin.hub.jurisdiction.edit` resolved **at the node**: node-scoped staff (the setup wizard's first administrator receives `node-operator` for the node) or platform-scoped staff (`platform-owner`); a hub-scoped role never covers it | 201 `{ attestation, status }`. Refusals: `403 access.forbidden` (`details.reason` `admin.forbidden`, `admin.elevation_required`), `422 validation.schema` with `details.reason` `restricted_place` or `region_required` and `details.refusals` (`[{ field, place, reason }]`), `409 validation.revision_conflict` with `details.reason = "stale"` when `supersedes` is not the current attestation |

No second person is required: neither ADR 014 nor the hub administration rules require one for the attestation, and the setup wizard must complete with a single first administrator (reduced separation-of-duties mode). If the owner decides otherwise, the attestation can bind a second-person approval like other console actions (open question below).

## Rules the database enforces (`packages/data/migrations/attestation`)

- `deployment_location_attestation` is append-only (no update, delete or truncate, for any role) and written only by `attestation_attest` (SECURITY DEFINER), which runs `admin_authorize` (caller, live elevation of the caller, permission at the node), refuses restricted places and missing regions, and writes `admin_audit_event` (`jurisdiction.location_attested` or `jurisdiction.location_renewed`, actor, role, permission, elevation, before and after digests) in the same transaction.
- Each row stores `attested_by`, `attester_role`, `permission`, `session_elevation_id` and a `statement_digest` (trustwork-digest-1 over the statement, the person, the elevation, the times and the predecessor; `deploymentAttestationStatement` recomputes it). A cryptographic signature with the node key follows when FED-001 provides node keys; until then "signed" means bound to the attesting person's elevated session by this digest and the audit row.
- `expires_at = attested_at + 365 days`. Renewal is a new row superseding the current one; every row is superseded at most once and a node has one first row, so the chain has one head. Concurrent attestations serialise on a per-node lock and the loser is told `attestation.stale`.
- A refused attempt rolls back; the API then writes a `denied` audit row (`jurisdiction.location_refused`, reason code `denied_restricted_place` or `denied_region_required`, the refused fields and places in the reason text) through `attestation_record_refusal`, which re-checks the authority and that the statement is in fact refused.
- `attestation_current()` returns the current attestation without the attesting person to any caller (launch gate, node manifest, our own services); `attestation_in_force(at)` answers for SQL callers whether it is unexpired and names no place restricted now.

## Status, renewal and the launch gate

`deploymentAttestationStatus` (`packages/contracts/src/sanctions-attestation.ts`, exported by the client entry) judges the current attestation at the application clock against the current restricted list and the process configuration:

- `renewal_due` from 30 days before expiry (still in force; reminder `renew` with the expiry date);
- `expired` from `expiresAt`;
- `contradicted` when the configured jurisdiction gate differs from the attested mode (an unconfigured gate included), when another configuration states a different entity or hosting place (`AttestationModuleOptions.configuration`, for HUB-004's operator and residency steps), or when the list now needs a region it lacks;
- `restricted` when a stated place is restricted by the list as it is now.

Anything but `valid` and `renewal_due` reports the launch-gate share as `invalidated` (or `open` before the first attestation): the hub's `sanctions_screening_configured` gate reopens until a new attestation is made. `AttestationService.currentStatus()` (exported by `AttestationModule`) gives the same without a session to the launch gate (HUB-004), the node manifest (FED-001) and our own services (SANC-008).

## Follow-ups

- HUB-004 / ADM-002: the setup-wizard step (SW-4) and the console view calling these routes, with every string in every locale; HUB-004's launch-gate evaluation reads `currentStatus().launchGate`.
- FED-001: the node manifest declares the jurisdiction from `attestation_current()` and signs it with the node key; SANC-008 refuses nodes whose attestation is missing, expired or restricted.
- MAIL / SANC-007: a renewal reminder notice to the node staff from `renewalDueAt` (a worker schedule); this slice exposes the date and the reminder in the status only.
- The released capability map must give `node-operator` and `platform-owner` an attesting permission (`admin.node.hubs.manage` or `admin.hub.jurisdiction.edit`); the test definitions do.

## Tests

`tests/attestation/contract.test.ts` (refusal rule, command shape, clock-driven status, contradictions, list growth), `tests/attestation/attestation-data.test.ts` (PostgreSQL under the runtime role: fail-closed list, negative authorization for participants, hub-scoped staff, staff without the permission, missing, foreign and expired elevations; restricted entity and hosting places at country and region level; denied audit rows; the digest; append-only for every role; row-level security; renewal and stale predecessors; simultaneous renewals and simultaneous first attestations held at the node lock; revoked roles; list growth), `tests/attestation/attestation-api.test.ts` (HTTP with real sessions, TOTP and elevations: refusals, restricted places with denied audit, attest and replay, reads, two staff renewing at once, clock to renewal and expiry through the service and HTTP, contradicted gate mode), and the SANC-009 block of `tests/backend/idempotency/crash.test.ts`.

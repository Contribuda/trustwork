# Hubs module (HUB-001)

Hubs as first-class objects ([Hubs](../../../../../docs/engine/hubs.md), [Hub administration](../../../../../docs/engine/hub-administration.md), [hub console data model](../../../../../docs/engine/hub-console/data-model.md)): a hub on this node with its territories and profile, immutable configuration versions per domain with a current pointer, launch gates and the lifecycle, legal document versions with counsel approvals and acceptances, and provider credential references. Storage, row-level security and every rule are in [`packages/data/migrations/hubs`](../../../../../packages/data/migrations/hubs) and [`repositories/hubs.ts`](../../../../../packages/data/src/repositories/hubs.ts); contracts are the frozen console contract `hub.ts` (HUBC-000, 1.0.0) and the additive `hub-core.ts`. The console screens are ADM-002 and the HUBC packages; the setup wizard backend is HUB-004.

Status: **Live** as an API (no console wiring yet, not deployed). Tests: `tests/hubs/*` and `tests/backend/idempotency/cases/hubs.ts`, on real PostgreSQL under the runtime role.

## Guard rails

- **Staff routes** (`/v1/admin/hubs/*`) need a signed-in session, a staff role and a live elevation (`ElevationGuard`). The database authorizes every command at the hub (a hub assignment covers that hub only; node and platform assignments cover every hub) and writes the `admin_audit_event` row in the same transaction; creating a hub needs `admin.node.hubs.manage` at the node. Refusals of authority leave a `denied` audit row.
- **Second person.** Sensitive configuration domains (`SENSITIVE_CONFIG_DOMAINS`), legal document activation, non-fake provider credentials and the transitions to `soft_launch` and `public` consume an approval of the exact action digest. The activator is the requester; the approver is someone else; a sensitive version is never activated by its drafter. Called without `approvalId`, these routes create the approval request in the same transaction and answer `outcome: "pending_second_person"`; the second person decides it at `POST /v1/admin/approvals/:id/approve` (ADM-001) restating the digest the version view shows; the same person then calls again with `approvalId`.
- **Launch gates.** A hub moves to `soft_launch` or `public` only when every required gate is `passed` and its precondition still holds (for example two staff with distinct roles and second factors, active counsel-approved terms, privacy notice and sanctions section in every hub language, live data mode), for every writer including maintenance sessions. A later change re-opens the gate it rests on. Demo data never leaves preparation, so the reference hub stays demo-only until its modes say `live`.
- **Restricted places.** A territory or a configuration payload naming a restricted place (the synced kernel list, or a place the hub added through its `jurisdiction` domain) is refused; hub additions need a cited legal basis and a second person and can never be removed. A payload stating a location that contradicts the current deployment-location attestation (SANC-009) is refused.
- **No hub setting widens data access.** Payload keys that would grant, bypass, expose or rank are refused at any depth, and no policy or access function of the engine reads this module's tables (tested).
- **No secret values.** A credential reference names a secret in the store; values shaped like credentials are refused by the contract and the database.

## Routes

All mutations: CSRF header, `Idempotency-Key`, and a console command body (`contractVersion: "1.0.0"`, `idempotencyKey` equal to the header, `reason`). Results carry the console envelope (`result`: outcome, object, revision, approval request, audit event) and the changed object. Errors use the contract envelope with the database reason in `details.reason` and refused items (gates, places, keys) in `details.items`.

| Route | Who | Result |
|---|---|---|
| `GET /v1/admin/hubs`, `GET /v1/admin/hubs/:hubId` | staff covering the hub | Hubs as `HubSchema`, territory ids, profile revision |
| `POST /v1/admin/hubs` | `admin.node.hubs.manage` at the node | A `draft` hub with territories and every launch gate open |
| `POST /v1/admin/hubs/:hubId/profile` | `admin.hub.identity.edit` | Name, languages, time zone, currency, brand overlay (revision checked) |
| `POST /v1/admin/hubs/:hubId/territories`, `POST .../territories/:territoryId/remove` | `admin.hub.identity.edit` | Add or remove a territory (at least one stays) |
| `GET /v1/admin/hubs/:hubId/config` (query `domain`), `GET .../config/current`, `GET .../config/:versionId` | staff covering the hub | Versions with payload, digest and, for sensitive domains, the approval action and digest; current versions and the derived retention policy |
| `POST /v1/admin/hubs/:hubId/config` | the domain's permission or `admin.config.edit` | A draft version (numbered per domain) |
| `POST /v1/admin/hubs/:hubId/config/:versionId/activate` | non-sensitive: the domain's permission; sensitive: the action's permission, not the drafter | Applied, or `pending_second_person` |
| `POST /v1/admin/hubs/:hubId/config/:versionId/cancel` | the domain's permission | Cancels a draft |
| `POST /v1/admin/hubs/:hubId/config/import-deployment` | `admin.hub.identity.edit` and `admin.hub.country.edit` (or `admin.config.edit`) | CFG-001's deployment document becomes version 1 of `identity` and `country` (once) |
| `GET /v1/admin/hubs/:hubId/launch` | staff covering the hub | The checklist: gate states, what the engine confirms, blockers per target |
| `POST /v1/admin/hubs/:hubId/launch/check`, `.../launch/invalidate` | `admin.hub.launch.check` | Pass a gate with evidence (its precondition must hold), or invalidate it |
| `POST /v1/admin/hubs/:hubId/lifecycle` | `admin.hub.lifecycle.request` | Transition; `soft_launch` and `public` refuse open gates before asking a second person |
| `GET /v1/admin/hubs/:hubId/legal`, `POST .../legal`, `POST .../legal/counsel-approvals`, `POST .../legal/:documentId/activate` | `admin.hub.legal.edit`; activation `admin.hub.legal.activate` and a second person | Legal document versions per kind and language, counsel approvals, activation |
| `GET /v1/admin/hubs/:hubId/credentials`, `POST .../credentials`, `POST .../credentials/:id/activate`, `POST .../credentials/:id/retire` | `admin.providers.secret.write`; `admin.providers.toggle` | References to secrets; a non-fake provider needs a second person; activation rotates the previous reference |
| `GET /v1/hubs/:hubId/legal`, `POST /v1/hubs/:hubId/legal/:documentId/accept` | any signed-in person | Active texts of a launched hub; the proof that the person accepted the exact text |
| `GET /v1/legal` | everyone, no session (an open door of the jurisdiction gate) | `{ hubConfigured, documents }`: the active texts of the hub this API serves (`TRUSTWORK_HUB_ID`, read per request), never a draft and nothing before the hub is visible to everyone; the web's terms and privacy pages and the terms version sign-up records (QA-002 D4) |

`HubsService.deploymentSettings(hubId)` returns the active `identity` and `country` payloads without a principal; `joinDeploymentConfig` in `hub-core.ts` turns them back into a CFG-001 document for the runtime loader.

## Known limits

- Scheduled activation (`effectiveFrom` in the future) is refused; activation takes effect immediately.
- The `privacy` domain is bound to the `privacy.execute_erasure` action because the console vocabulary has no retention action yet (a contract follow-up).
- Territory references to Wikidata and OpenStreetMap are not stored yet (the views return `null`).
- Operator screening for the `operator_recorded_and_screened` gate rests on recorded evidence until the screening engine screens the operator (SANC-003 follow-up); the engine confirms only that the operator entity is recorded.

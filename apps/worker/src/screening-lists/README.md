# Screening lists in the worker (SANC-002)

Status: **Live** (not deployed). Design: [ADR 014](../../../../docs/adr/014-sanctions-compliance-engine.md) decisions 10 and 11, handbook [Sanctions compliance](../../../../docs/engine/modules/sanctions-compliance.md), data [section 24a](../../../../docs/data/model.md#24a-sanctions-compliance). Storage: `packages/data/migrations/screening-lists`; parsers and name keys: `packages/compliance/src/lists` and `packages/compliance/src/names`.

## Lists

Every hub screens against the **baseline**, seeded by the migration and impossible to pause, delete or rescope (a trigger refuses it for every role, the owner included; the console command refuses it with `screening.baseline_list`):

| Code | List | Default source (`live` mode) | Minimum entries | Drop share |
|---|---|---|---|---|
| `ofac-sdn` | OFAC SDN list | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` | 1000 | 10% |
| `ofac-cons` | OFAC consolidated non-SDN lists | `.../exports/CONSOLIDATED.XML` | 10 | 25% |

Both start in `file` mode with a cadence of one day, a warning age of three days and a stale age of seven days (the engine bound for the baseline is 14 days). A hub adds lists (`hub_id` set) whose adapter a country-pack `sanctions` fact names; the adapters are `LIST_ADAPTERS` in `packages/compliance/src/lists` and `ENGINE_ADAPTERS` in `packages/country-packs` (today `ofac-sls-xml`, the OFAC classic XML schema).

## Modes

| Mode | Where the export comes from | Network |
|---|---|---|
| `file` (default) | `<SCREENING_LISTS_DIR>/<code>.xml` (a hub's list under `<hub id>/`); the default directory is `<TRUSTWORK_DATA_DIR>/screening-lists`. The file's modification time is when the content was obtained, so re-reading an unchanged file never makes a list look fresher | none |
| `live` | The list's source URL through the egress fetcher, only with a provider activated by two different people (KEYS-001). Until KEYS-001 exists the worker has neither, so `live` refuses with `live_not_activated` before any call | only through KEYS-001 |
| `fake` | The synthetic list of `packages/compliance` rendered in the OFAC schema; refused with `NODE_ENV=production` | none |

To feed the baseline in `file` mode, download `SDN.XML` and `CONSOLIDATED.XML` from the [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service) and save them as `ofac-sdn.xml` and `ofac-cons.xml` in the lists directory at least once a week (the stale age). Until the first versions are active, screening is unavailable and the money and commitment gates refuse.

## Jobs and tasks

| Name | Kind | What it does |
|---|---|---|
| `screening.list_ingest` (`{ listId }`) | transactional job | Locks the list, obtains the export, parses it, then: same digest as the active version, the attempt confirms it (`unchanged`); otherwise stages a version with its sanity check and asks the database to activate it. The database recounts the entries and recomputes the digest, supersedes the previous version and appends `screening.list_version_activated` to the outbox in the same transaction. Outcomes are recorded on the list (`last_outcome`, `last_error`) |
| `screening.lists_due` | task, 15 minutes | One ingestion job per active list whose cadence elapsed and that has no ingestion job queued or running |
| `screening.lists_freshness` | task, hourly | Freshness gauges; a warning per list past its warning age; an error while a baseline list is missing or stale |
| `jurisdiction.ranges_age` | task, daily | With `TRUSTWORK_JURISDICTION_GATE=ranges_file`, reads the header of the range table and warns when its month is more than two months old. Give the worker the same gate variables as the API (`TRUSTWORK_JURISDICTION_GATE` and `TRUSTWORK_JURISDICTION_RANGES_FILE` or `TRUSTWORK_DATA_DIR`); without them the check has nothing to read |

Every step of an ingestion shares the job's transaction, so a crash or a lost lease rolls it back and the job runs again; there is no external effect to reconcile (a `live` download is a read). Two workers ingesting the same list serialise on the list row: the second finds the first one's version (`unchanged`).

## What never activates

| Export | Outcome | Active version |
|---|---|---|
| Missing file, unreadable or larger than `SCREENING_LIST_MAX_BYTES` | `source_missing` or `refused` | unchanged |
| Truncated or malformed XML, an entry without a uid, name or known type, duplicate uids, a document type declaration | `malformed`, nothing staged | unchanged |
| A complete document whose entry count differs from its own `Record_Count`, an empty export, fewer entries than the list's minimum | `rejected` (the staged version stays as evidence) | unchanged |
| Entry count dropped by more than the list's share | `needs_confirmation`: staged until a compliance officer of the node confirms it under an elevation (`screening_list_confirm_version`, audited); repeating the export stages nothing new | unchanged until confirmed |
| Written entries disagree with the staged count or digest | `rejected` (`entries_mismatch`) | unchanged |

## Freshness

The age of a list counts from `last_checked_at`, when its active content was last confirmed from its source (activation, or an attempt that found the same digest), never from the export's publication date: OFAC publishes irregularly. `screening_list_freshness()` and `screening_available()` (both roles) evaluate it at a time no earlier than now; `screeningFreshness.availability()` in `packages/data` is what the money and commitment gates read (SANC-004): `available` is false while any baseline list is missing or stale.

## Metrics

`trustwork_screening_list_ingestions_total{list,outcome}`, `trustwork_screening_available`, `trustwork_screening_list_age_seconds{list}`, `trustwork_screening_list_state{list,state}`, `trustwork_geolocation_table_age_months`. Logs carry list codes, outcomes and list-level reasons; the lists are published government data and no screened person appears here.

## Database role

The worker has no grant on the three tables. It uses only the owner-run entry points `screening_list_due`, `screening_list_lock`, `screening_list_record_attempt`, `screening_list_stage`, `screening_list_add_entries`, `screening_list_activate`, `screening_list_reject`, `screening_list_freshness` and `screening_available`.

## Registered additional sources (SANC-006)

Run the maintenance command `node --import tsx apps/worker/src/screening-lists/sync-sources.ts --dry-run` to inspect sources derived from the installed, validated country packs. Without `--dry-run`, it uses the migrator connection to synchronize immutable source snapshots and retire absent facts. It does not choose a list for a hub. Runtime and worker roles cannot install source authority.

Only official `sanctions` facts naming both a registered engine adapter and an implemented list export parser are eligible, with a bounded HTTPS URL on the adapter's exact official origin. No built-in additional export fact currently qualifies: the CSL is a keyed query adapter, not an export parser. Do not invent a reviewed fact or change that adapter into an export importer. Supply a reviewed country-pack contribution through the existing contribution process; synthetic configured facts belong only in tests.

Two elevated node compliance officers propose and approve a source-bound file-list configuration in the screening console. The worker reads the export from the established `<lists directory>/<hub UUID>/<generated code>.xml` path. No browser chooses paths, URLs or adapters. A retired source refuses ingestion and raw version activation; missing files remain `source_missing`. Live mode still needs KEYS-001 activation and egress authority; this continuation neither supplies a fetcher nor enables live providers.

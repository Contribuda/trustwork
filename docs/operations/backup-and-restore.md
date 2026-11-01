# Backup, restore and retention

**Status: Live in the tooling, not deployed (OPS-003, 2026-10-31).** The scripts below back up and restore the compose stack and are rehearsed by an automated drill on synthetic data, locally and in CI. No production backup target, key or schedule is configured anywhere, and the reference hub on Railway does not run them yet (see [Reference hub](#reference-hub-on-railway)). Nothing here is a contractual guarantee.

Targets for the demo reference hub (ADR 012 decision 26): **recovery point objective 24 hours, recovery time objective 8 hours.** The recorded drill ([evidence](../../tests/restore/evidence/drill-2026-10-31.json)) restored in seconds with a data-loss window of seconds, far inside both; real data volumes, network transfer and human reaction time dominate a real recovery, so the targets stay as decided until a production rehearsal.

## What is backed up

| What | How | Where in the target |
|---|---|---|
| PostgreSQL, physical | `pg_basebackup` tar stream with the WAL needed for consistency and its `backup_manifest`, cut into 32 MiB parts | `base/<id>/part-*`, `base/<id>/manifest.json` |
| PostgreSQL, continuous | WAL archiving: `archive_command` copies each completed segment into a spool inside the database volume; the shipper seals and uploads it, then removes it from the spool | `wal/<segment>` |
| PostgreSQL, logical | `pg_dump -Fc` of the hub database (portable copy for inspection and partial recovery) | `logical/<id>/...` |
| Stored files (FILE-001) | Content-addressed copies of every object in the files bucket | `objects/blob/<sha256>`, `objects/<id>/manifest.json` |
| Removed audit and outbox partitions | JSON Lines of every row, written before the partition is dropped | `archive/<table>/<partition>/<time>.jsonl` |

Not in any snapshot, on purpose: the **tombstone ledger** of deleted and erased files lives in its own bucket (`FILES_TOMBSTONE_BUCKET`, with versioning or object lock where the provider offers it) and is replayed after every restore; the **provider receipt journal** is the provider's own record of effects. Credentials and keys are never backed up by this tooling; they live in the operator's secret store.

## Encryption and keys

Every object is compressed and encrypted before it leaves the host (AES-256-GCM, a fresh nonce per object, the object's key in the target as authenticated data, so a part cannot be swapped or renamed without failing authentication). The data key is derived with HKDF from `BACKUP_ENCRYPTION_KEY` (64 hex characters or base64 of at least 32 bytes) and named by `BACKUP_KEY_ID`. Rotation: set a new key and id; keep older keys readable as `BACKUP_ENCRYPTION_KEY_<ID>` until every backup written with them has aged out. Losing the key loses the backups: keep it in the operator's secret store with its own recovery procedure, never next to the backups.

## Configuration

| Variable | Meaning |
|---|---|
| `BACKUP_TARGET` | `s3` (any S3-compatible bucket the operator provisions; recorded as off-host) or `filesystem` (the local fake for drills and tests; refused with `NODE_ENV=production`) |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_VIRTUAL_HOSTED` | The off-host bucket: another provider, account or region than the database; a write-only key for the shipper is recommended |
| `BACKUP_FS_ROOT` | Directory of the filesystem target |
| `BACKUP_ENCRYPTION_KEY`, `BACKUP_KEY_ID`, `BACKUP_ENCRYPTION_KEY_<ID>` | Keys (above) |
| `BACKUP_PG_EXEC` | How to reach the database tools: a JSON argv array such as `["docker","compose","-p","trustwork-stack","-f","infra/compose.yaml","-f","infra/backup/compose.backup.yaml","exec","-T","postgres"]` (the project the stack runs in, see [images](images.md#the-local-stack)); empty when the tools run locally |
| `BACKUP_PG_USER`, `BACKUP_PG_DATABASE` | Role for `pg_basebackup` and `pg_dump` over the local socket (superuser or a role with `REPLICATION`), default `trustwork_dev`; database, default `trustwork_stack` |
| `BACKUP_NODE_ID` | Node identifier recorded in backup records |
| `TRUSTWORK_BACKUP_ARCHIVE_TIMEOUT` | Seconds after which a quiet database closes and archives a partly filled segment (default 60); with the shipper interval it bounds the data-loss window |
| `RETENTION_DATABASE_URL` | Login for partition retention that may `SET ROLE trustwork_owner` (the migrator) |
| `RESTORE_DATABASE_URL` | Operator login on a restored server (the migrator) |

The compose override `infra/backup/compose.backup.yaml` turns on WAL archiving for the `postgres` service:

```sh
docker compose -p trustwork-stack -f infra/compose.yaml -f infra/backup/compose.backup.yaml --profile stack up -d --wait
```

## Routine operation

All commands print one JSON document; errors are one JSON line without secrets.

```sh
node --import tsx infra/backup/cli.ts base                    # daily, and before irreversible migrations
node --import tsx infra/backup/cli.ts ship-wal --loop 30      # continuously (a sidecar or service next to the database)
node --import tsx infra/backup/cli.ts logical                 # daily
node --import tsx infra/backup/cli.ts objects                 # daily (FILES_* storage configuration)
node --import tsx infra/backup/cli.ts list
node --import tsx infra/backup/cli.ts prune --keep-days 35            # plan
node --import tsx infra/backup/cli.ts prune --keep-days 35 --apply    # delete
```

`prune` keeps everything that finished inside the window, always the newest physical, logical and object backup, the WAL from the start of the oldest kept base backup onward and every timeline history file. A WAL file already in the target with different content stops the shipper (two clusters writing to one target) and stays in the spool for the operator.

## Partition retention (audit and outbox)

REL-001 partitions `audit_event` and `outbox_event` by month. Retention removes whole months, never rows, within the hub's policy:

```json
{ "v": 1, "hubId": "us-demo", "version": 1,
  "auditEvent": { "retainDays": 2555 }, "outboxEvent": { "retainDays": 90 },
  "legalHolds": [{ "id": "matter-1", "tables": ["audit_event"], "from": "2026-01-01T00:00:00Z", "to": null, "reference": "matter 1" }] }
```

```sh
RETENTION_DATABASE_URL=... node --import tsx infra/backup/cli.ts retention --policy policy.json             # dry run
RETENTION_DATABASE_URL=... node --import tsx infra/backup/cli.ts retention --policy policy.json --apply --operator ops-1
```

A month is removed only when its whole range ended more than `retainDays` ago, no legal hold overlaps it, no audit row in it refers to an evidence artifact under legal hold, every outbox event in it is published, and it is neither the DEFAULT partition nor the current or a future month. Engine floors (365 days audit, 30 days outbox) refuse a lower policy instead of clamping it. Each removal detaches the partition, re-checks those conditions on the detached table, archives its rows sealed to the backup target, reads the archive back and counts it, drops the table and appends a `retention.partition_removed` audit row, all in one transaction under the partition advisory lock; any failure rolls back and the month stays. Runtime logins cannot run it. Until the policy is a versioned hub setting in the console, the operator exports it as the file above (follow-up below).

## Point-in-time restore

Never restore over the live stack. Each restore is a new compose project and a new volume (`infra/backup/compose.restore.yaml`); runtime services of a restored stack join only an internal network without egress, and providers are disabled (log mail transport, no file storage).

```sh
node --import tsx scripts/restore/cli.ts plan --target-time 2026-10-31T09:41:00Z
node --import tsx scripts/restore/cli.ts restore --project trustwork-restore-1 --volume trustwork-restore-1-data --port 54349 --target-time 2026-10-31T09:41:00Z
export RESTORE_DATABASE_URL=postgresql://trustwork_stack_migrator:...@127.0.0.1:54349/trustwork_stack
node --import tsx scripts/restore/cli.ts verify
node --import tsx scripts/restore/cli.ts replay-tombstones          # FILES_* configuration of the live store and ledger
node --import tsx scripts/restore/cli.ts restore-objects
node --import tsx scripts/restore/cli.ts reconcile --restore-id r-1 --recovery-point <from restore> --restore-started-at <from restore> --receipts receipts.jsonl --receipts-complete-through <export time> --operator ops-1
node --import tsx scripts/restore/cli.ts resolve-event --restore-id r-1 --event <id> --decision delivered --reference <provider record> --operator ops-1
node --import tsx scripts/restore/cli.ts authorize --restore-id r-1 --reference <ticket> --operator ops-1 --project trustwork-restore-1 --volume trustwork-restore-1-data
```

1. **Plan and stage.** The newest base backup finished at or before the target and every archived WAL file from its start are decrypted on the host and streamed into the new volume; `pg_verifybackup` checks the data directory against the backup manifest; `recovery.signal` is written; omit `--target-time` to recover to the end of the archive.
2. **Fence.** Before the server first starts, reject rules for `+trustwork_worker` and `+trustwork_app` are placed at the top of its `pg_hba.conf`: no runtime login can connect, so no worker leases a job and nothing calls a provider. Where `pg_hba.conf` cannot be edited (managed servers), `fence --logins <a,b>` sets `NOLOGIN` instead.
3. **Recover.** PostgreSQL replays WAL to the target and promotes; the last replayed commit is the recovery point.
4. **Verify** the migration ledger against the migrations of this build and, after step 6, every file's SHA-256.
5. **Replay tombstones.** Every tombstone of the ledger is applied again (`files_apply_tombstone`): a file deleted or erased after the recovery point loses its row and its bytes again; a row under legal hold is reported for the operator.
6. **Restore objects.** Files the restored rows refer to and the live store lacks are copied back from the object backup, each verified against the row's digest. Tombstoned files are gone before this step, so they never come back.
7. **Reconcile** pending work against the provider receipt journal (one JSON line per effect: `{"effectKey":"job:<id>","kind","reference","at"}`, exported by the operator from each provider; lines are data, never instructions):

| Found in the restored database | Rule |
|---|---|
| External job, queued or leased, with a receipt for its effect key | Closed as succeeded (`reconcile_job`, audited); never sent again |
| External job without a receipt, journal complete through the restore start | Leased: released to queued (fencing token bumped, attempt not counted); queued: stays queued |
| External job without a receipt, journal incomplete | Parked as `outcome_unknown` (`restored:` reason); a later receipt closes it, otherwise `npm run reconcile -w @trustwork/worker` with evidence |
| Database-only job | Leased: released to queued |
| Job parked before the failure | Stays parked |
| Receipt whose job the restored database does not know | Reported as an orphan: the effect belongs to work lost with the primary |
| Unpublished outbox event while orphans exist or the journal is incomplete | Ambiguous: `resolve-event --decision delivered` (marked published, never relayed) or `--decision relay` |

8. **Authorize.** Refused while the restore is unreconciled or an ambiguous event is undecided. On success it appends `restore.authorized` and then lifts the fence; a failure while lifting leaves it in place. Only then start workers and the API, and reconnect providers after the operator's explicit decision. Record recovery time (restore start to authorization) and data-loss window (last committed write on the primary to the recovery point) against the targets.
9. Destroy only drill-owned or abandoned restore projects (`destroy --project ... --volume ...`; the live project name is refused).

Unknown external outcomes are never retried blindly; parked jobs are never leased.

## Restore drill

```sh
node --import tsx scripts/restore/drill.ts --evidence restore-drill.json     # about a minute, needs Docker
TRUSTWORK_RESTORE_DRILL=1 node --import tsx --test tests/restore/drill.test.ts
```

The drill creates its own projects (`trustwork-drill-*`) on ports 54339 to 54350, random passwords and a random backup key, and removes everything at the end (`--keep` keeps it for inspection). Steps: source PostgreSQL with WAL archiving, migrations, synthetic seed (three people, six files); object, base and logical backups; continuous WAL shipping while a writer commits a marker every 200 ms; work before the recovery point (a provider call, a relayed event, a job leased by a worker that will be lost, a deletion, a pending event); WAL shipping stops (the unarchived tail of a real failure); work after the recovery point (a provider call for a queued job, a relay and its call, a deletion and an erasure in the tombstone ledger); `docker kill` of the primary and loss of the live object store; then the full restore above with a real worker that is refused while fenced, and after authorization executes the two approved jobs exactly once and nothing else. It also restores to an explicit target time and checks the exact stop: PostgreSQL compares `recovery_target_time` with commit timestamps, while `occurred_at` is the transaction start, so the target is bracketed on the server clock by two boundary commits (one acknowledged before the target is read, one started only after the server clock has passed it); the restore must hold the first and not the second, every writer marker acknowledged before the boundary, no marker that started after the target, and a last replayed commit not after the target. It then loads the logical dump into a scratch database. The evidence JSON holds the contract records (`RestoreDrill`, `BackupRecord` from `packages/contracts`), every check, phase timings, the reconciliation report and provider call counts. CI runs it in `.github/workflows/restore-drill.yml` on changes to this tooling, the migrations or the worker, weekly and on demand.

Recorded run (macOS, Docker 29, PostgreSQL 18.3): [tests/restore/evidence/drill-2026-10-31.json](../../tests/restore/evidence/drill-2026-10-31.json).

## Reference hub on Railway

Designed, not implemented. Railway volumes belong to one service, so the spool cannot be shared with a separate shipper service: the options are a custom PostgreSQL image that runs the shipper next to the server, or Railway's own volume backups plus scheduled `base`, `logical` and `objects` runs from a cron service with `BACKUP_PG_EXEC` empty and network access to the database. The target must be an off-host bucket outside Railway. Choosing between them, provisioning the bucket and key, and a first production rehearsal are owner actions; nothing is configured today.

## Limitations and follow-ups

- The retention policy shape lives next to the tooling (`infra/backup/src/retention.ts`); it should become a versioned hub setting with second-person activation in `packages/contracts` and the hub console, together with `BackupRecord` and `RestoreDrill` screens (`admin.ops.backups.read`, `admin.ops.restore.drill`).
- Retention and backups run from the command line or a scheduler the operator provides; a worker-scheduled task needs a worker change outside this package.
- Provider receipt exports exist only as the journal format and the drill's fake; each provider adapter needs an export or lookup.
- Retrieval generations and federation tombstones (RAG, FED packages) join the replay step when they exist.
- Manual restore exercises with a witness, and restore of production-sized data, remain separate evidence.

# Files in the worker (FILE-001)

Status: **Live** (not deployed). The API side and the routes are described in [`apps/api/src/modules/files`](../../../api/src/modules/files/README.md).

## Intents and jobs

| Outbox event (identifiers only) | Job | Mode | What it does |
|---|---|---|---|
| `file.uploaded`, `file.copy_requested` | `files.scan` | external | Copies the bytes of a copy; reads the stored object bounded by the declared size; checks size, SHA-256, magic numbers and (for `public` images) GPS or location metadata; asks the malware scanner; records `clean` or `quarantined` with a reason, once, audited |
| `file.deletion_requested` | `files.delete` | external | Writes the tombstone to the ledger, removes the bytes, then the row (`file.deleted` or `file.erased` audit) |
| `file.moved` | none | | Kept for later consumers (search projections) |

One job per artifact and intent (inbox receipt). Every storage effect is idempotent (a copy of identical bytes to a fixed key, a delete of a fixed key), so an unreachable store or scanner is a `RetryableJobError` with backoff, never an `outcome_unknown`. A legal hold set after a deletion request stops the deletion: the job dead-letters for the privacy officer, the file stays hidden, the bytes stay.

The worker role has no grant on `evidence_artifact` or `file_artifact_state`; it uses only the owner-run entry points `files_scan_target`, `files_record_scan`, `files_deletion_target`, `files_request_erasure`, `files_finish_deletion`, `files_apply_tombstone`, `files_expired_uploads` and `files_discard_upload`.

## Scanner

`MalwareScanner` is a port. `FILES_SCANNER=fake` (refused with `NODE_ENV=production`) flags the EICAR test string. Without a scanner the `files.scan` kind is not registered: scan jobs wait queued and no upload becomes visible (fail closed) until an operator plugs in an engine adapter.

## Tombstones and restore

Tombstones live in object storage (`TombstoneLedger`, ideally its own bucket `FILES_TOMBSTONE_BUCKET` with versioning or object lock), outside the restorable database snapshot. After every database restore, before files are served again:

```sh
WORKER_DATABASE_URL=... FILES_STORAGE=s3 FILES_S3_...=... npx tsx apps/worker/src/files/cli.ts replay-tombstones
```

It removes every row a restore brought back (by id or by storage key, which a move keeps) and the bytes again; it is idempotent. Exit code 1 when a tombstone is unreadable or a row is under legal hold (an operator decides).

## Erasure

Privacy operations call `requestFileErasure` (or `cli.ts erase <privacy-request-id> <executed-by> <second-approver> <artifact-id>...`): two different people, one privacy request; each artifact is marked and its deletion job queued in one transaction; an artifact under legal hold is reported, never erased. The tombstone reason is `erased`.

## Housekeeping

`files.expire_uploads` (every 15 minutes): uploads whose signed PUT window passed more than an hour ago without a completion report lose their bytes and row (`file.upload_abandoned` audit). They were never visible to anyone but the uploader.

## Metrics

`trustwork_files_scans_total{result}`, `trustwork_files_deletions_total{mode,result}`, `trustwork_files_uploads_discarded_total`. Logs carry artifact ids and scanner signature names, never file content.

# Files module (FILE-001)

Status: **Live** in the API and worker on real PostgreSQL with the storage fake and any S3-compatible service; no user interface yet; off unless storage is configured. Handbook: [Security, trust and privacy](../../../../../docs/engine/trust-safety-privacy.md). Contract: `packages/contracts/src/files.ts`. Storage: `packages/data/src/files/`. Database: `packages/data/migrations/files/` over the kernel table `evidence_artifact` (DATA-003). Worker side: [`apps/worker/src/files`](../../../../worker/src/files/README.md).

## Routes

| Route | Idempotent action | What it does |
|---|---|---|
| `POST /v1/files/uploads` | `file.upload_start` | Declares owner, parent, class, type, exact size and SHA-256; returns the pending file and a signed PUT (default 5 minutes, at most 15) |
| `POST /v1/files/:id/complete` | `file.upload_complete` | The uploader reports the bytes as sent; records the `file.uploaded` intent for the worker once |
| `GET /v1/files/:id` | | Metadata (`FileRefSchema`); never the storage key, a URL or the legal-hold flag |
| `GET /v1/files?parentKind=&parentId=` | | Files of a parent the caller may see; an inaccessible parent lists like an empty one |
| `GET /v1/files/:id/download` | | A signed GET (default 60 seconds, at most 5 minutes), only for a clean file, only after the read decision |
| `POST /v1/files/:id/copy` | `file.copy` | New pending artifact, same owner, class and content, under another parent of the same owner; the worker copies and verifies the bytes |
| `POST /v1/files/:id/move` | `file.move` | New artifact under another parent with the same owner, class, bytes and storage key; the old id is gone |
| `POST /v1/files/:id/delete` | `file.delete` | Deletion request: hidden for every reader at once; the worker removes the bytes and the row and writes a tombstone |

Every mutating route completes its idempotency record inside its one request transaction (`in_transaction`, BE-005); signed URLs are computed locally, never a provider call inside the request. Agents act only under a mandate (`FileMandatePort`; the default refuses every agent request).

## Who may do what

- **Read** (database policy, then the in-process rule): the owner person; members of the owner company with `company.deals.manage` (any member for `public`); for anyone else only a `clean` file: `public` when the parent is visible to them, `shared` when they hold a live participation with `read.shared` on the parent (in person, or through the employer with `company.deals.manage`). `party_private` and `owner_private` stay with the owner party; `restricted` has no participant path. Anything else is "not found".
- **Upload** to a parent the caller may attach to (self, the active employer, or owner or participant of the resource), for a party the caller acts for. The database refuses a foreign uploader or owner, a non-pending scan state and a legal hold whatever the API does.
- **Copy, move, delete**: the owner party only (company: `company.deals.manage`); never under legal hold; copy and move keep owner and classification (the commands have no field to change them) and are audited (`file.copied`, `file.moved` with the source id).

Classification is inherited from the parent kind (`CLASSIFICATION_POLICY`): projects, RFQs, quotes, agreements, orders and threads default to `shared`; persons and companies to `owner_private` (a `public` avatar or logo may be chosen); publications to `public`. A request may only pick a stricter class or one of the listed public ones; the database repeats the rule (`files_classification_allowed`, compared with the contract by a test).

## Configuration

| Variable | Meaning |
|---|---|
| `FILES_STORAGE` | `disabled` (default: the module is not mounted), `filesystem` (test fake, refused with `NODE_ENV=production`) or `s3` |
| `FILES_S3_*`, `FILES_TOMBSTONE_BUCKET`, `FILES_FS_ROOT` | See `packages/data/src/files/config.ts`; credentials are created by the operator, never by this code |
| `FILES_UPLOAD_URL_TTL_SECONDS` / `FILES_DOWNLOAD_URL_TTL_SECONDS` | Clamped to 30..900 and 10..300 seconds |

For the local compose stack the S3 endpoint is the `storage` service (SeaweedFS); browsers use `FILES_S3_PUBLIC_ENDPOINT`.

## Limits

Accepted types and sizes (`MEDIA_TYPE_LIMITS`): JPEG, PNG and WebP images up to 15 MB; PDF up to 50 MB; DOCX and XLSX up to 25 MB; plain text and CSV up to 5 MB. SVG, HTML, archives and executables are refused. A declared size above the limit answers 413 `validation.payload_too_large`; the worker checks the stored bytes again (size, SHA-256, magic numbers, location metadata of public images, malware scanner) before a file becomes visible.

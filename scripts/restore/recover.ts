import type pg from 'pg';
import { createPool, type DataPool } from '@trustwork/data';
import { DEFAULT_MIGRATIONS_DIR, statusProblems, verifyMigrations } from '@trustwork/data/migrate';
import type { BlobStore } from '../../packages/data/src/files/blob-store.js';
import type { TombstoneLedger } from '../../packages/data/src/files/tombstones.js';
import { replayFileTombstones } from '../../apps/worker/src/files/handlers.js';
import { silentLogger, type Logger } from '../../apps/worker/src/log.js';
import { sha256Hex, type Keyring } from '../../infra/backup/src/crypto.js';
import { getSealed, type BackupTarget } from '../../infra/backup/src/target.js';
import { listManifests } from '../../infra/backup/src/backup.js';
import { inOwnerTransaction } from '../../infra/backup/src/retention.js';

/**
 * Steps between "the restored server is up" and "the restore may be authorized" (OPS-003), all run by the operator's
 * login while the restore fence keeps runtime logins out:
 *   1. verifySchema      the migration ledger equals the migrations this build ships (checksums);
 *   2. replayTombstones  every tombstone of the FILE-001 ledger (outside the snapshot) is applied again, so a file
 *                        deleted or erased after the recovery point stays gone (rows and bytes);
 *   3. restoreObjects    stored files the restored rows refer to and the live store lacks are copied back from the
 *                        object backup, each verified against the row's SHA-256 (tombstoned files are gone by then);
 *   4. verifyDigests     every remaining file's bytes match its recorded digest.
 */
export async function verifySchema(admin: Pick<pg.Pool, 'connect'>): Promise<{ ok: boolean; problems: string[]; applied: number }> {
  const client = await admin.connect();
  try {
    const status = await verifyMigrations(client as pg.PoolClient, DEFAULT_MIGRATIONS_DIR).catch((error: Error) => ({ error }));
    if ('error' in status) return { ok: false, problems: [status.error.message], applied: 0 };
    const problems = [...statusProblems(status), ...status.pending.map((file) => `migration ${file.filename} is not applied in the restored database`)];
    return { ok: problems.length === 0, problems, applied: status.applied.length };
  } finally {
    client.release();
  }
}

export async function replayTombstones(input: { adminUrl: string; store: BlobStore; tombstones: TombstoneLedger; log?: Logger }) {
  // The operator login runs the owner's replay entry point (files_apply_tombstone); the worker login is fenced.
  const pool: DataPool = createPool({ connectionString: input.adminUrl, max: 2, application_name: 'trustwork-restore' });
  try {
    return await replayFileTombstones({ pool, store: input.store, tombstones: input.tombstones, log: input.log ?? silentLogger });
  } finally {
    await pool.end();
  }
}

interface ArtifactRow { id: string; storage_key: string; sha256: string; bytes: string }

async function artifacts(admin: pg.Pool): Promise<ArtifactRow[]> {
  const client = await admin.connect();
  try {
    return await inOwnerTransaction(client, async () => (await client.query<ArtifactRow>('SELECT id::text AS id, storage_key, sha256, bytes::text AS bytes FROM trustwork.evidence_artifact ORDER BY id')).rows);
  } finally {
    client.release();
  }
}

export interface ObjectRestoreReport { present: number; restored: number; missing: string[] }

export async function restoreObjects(input: { admin: pg.Pool; store: BlobStore; target: BackupTarget; ring: Keyring }): Promise<ObjectRestoreReport> {
  const manifests = await listManifests(input.target, input.ring, 'objects');
  const byKey = new Map<string, string>();
  for (const m of manifests) for (const o of m.objects ?? []) byKey.set(`${o.storageKey}\n${o.sha256}`, `objects/blob/${o.sha256}`);
  const report: ObjectRestoreReport = { present: 0, restored: 0, missing: [] };
  for (const row of await artifacts(input.admin)) {
    if (await input.store.head(row.storage_key)) {
      report.present += 1;
      continue;
    }
    const blobKey = byKey.get(`${row.storage_key}\n${row.sha256}`);
    const body = blobKey ? await getSealed(input.target, input.ring, blobKey, row.sha256) : null;
    if (!body) {
      report.missing.push(row.id);
      continue;
    }
    await input.store.put(row.storage_key, body, 'application/octet-stream');
    report.restored += 1;
  }
  return report;
}

export async function verifyDigests(input: { admin: pg.Pool; store: BlobStore }): Promise<{ checked: number; mismatched: string[] }> {
  const out = { checked: 0, mismatched: [] as string[] };
  for (const row of await artifacts(input.admin)) {
    const body = await input.store.read(row.storage_key, Number(row.bytes) + 1);
    out.checked += 1;
    if (!body || sha256Hex(body) !== row.sha256 || body.length !== Number(row.bytes)) out.mismatched.push(row.id);
  }
  return out;
}

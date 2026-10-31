import { randomBytes } from 'node:crypto';
import { BackupRecordSchema, type BackupRecord } from '@trustwork/contracts';
import type { BlobStore } from '../../../packages/data/src/files/blob-store.js';
import { sha256Hex, type BackupKey, type Keyring } from './crypto.js';
import { assertWalName, type PgExec } from './pg.js';
import { getSealed, putSealed, type BackupTarget } from './target.js';

/**
 * Backups of the compose stack (OPS-003): physical base backups plus WAL archiving (point-in-time recovery), logical
 * dumps, copies of stored objects, and pruning by age. Layout in the target (every object sealed, crypto.ts):
 *
 *   base/<id>/manifest.json, base/<id>/part-00000 ...   physical base backup (pg_basebackup tar, WAL included)
 *   wal/<segment or history file>                         archived WAL, shipped from the spool
 *   logical/<id>/manifest.json, logical/<id>/part-...     pg_dump custom format
 *   objects/<id>/manifest.json, objects/blob/<sha256>     stored files, content-addressed
 *   archive/<table>/<partition>/...                       partitions removed by retention (retention.ts)
 *
 * The tombstone ledger of deleted files is not copied here on purpose: it lives in its own bucket outside every
 * restorable snapshot (FILE-001) and is replayed after each restore.
 */
export const PART_BYTES = 32 * 1024 * 1024;

export interface PartRef { key: string; bytes: number; sha256: string; sealedBytes: number; sealedSha256: string }

export interface BackupManifest {
  v: 1;
  id: string;
  format: 'physical' | 'logical' | 'objects';
  nodeId: string;
  startedAt: string;
  finishedAt: string;
  keyId: string;
  target: { kind: BackupTarget['kind']; offHost: boolean };
  parts: PartRef[];
  totalBytes: number;
  /** Physical: where WAL replay starts and the timeline; the backup is consistent at endLsn. */
  pg?: { serverVersion: string; timeline: number; startWal: string; startLsn: string; endLsn: string; endWal: string };
  database?: string;
  /** Objects: storage key -> content digest (bytes under objects/blob/<sha256>). */
  objects?: { storageKey: string; sha256: string; bytes: number }[];
}

export interface BackupContext {
  exec: PgExec;
  target: BackupTarget;
  key: BackupKey;
  /** Node identifier recorded in manifests and BackupRecords (IdSchema). */
  nodeId: string;
  now?: () => Date;
}

const PREFIX: Record<BackupManifest['format'], string> = { physical: 'base', logical: 'logical', objects: 'objects' };

export function newBackupId(format: BackupManifest['format'], at: Date): string {
  return `${PREFIX[format]}-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
}

export function manifestKey(format: BackupManifest['format'], id: string): string {
  return `${PREFIX[format]}/${id}/manifest.json`;
}

async function writeManifest(ctx: Pick<BackupContext, 'target' | 'key'>, manifest: BackupManifest): Promise<string> {
  const key = manifestKey(manifest.format, manifest.id);
  const put = await putSealed(ctx.target, ctx.key, key, Buffer.from(JSON.stringify(manifest), 'utf8'), 'application/json');
  return put.sealedSha256;
}

/** The contract record of a finished backup (packages/contracts BackupRecordSchema). */
export function backupRecord(manifest: BackupManifest, manifestDigest: string | null, kind: BackupRecord['kind'] = 'database_full'): BackupRecord {
  return BackupRecordSchema.parse({
    id: manifest.id,
    nodeId: manifest.nodeId,
    kind: manifest.format === 'objects' ? 'object_store' : kind,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    sizeBytes: manifest.totalBytes,
    encrypted: true,
    offHost: manifest.target.offHost,
    manifestDigest,
    state: 'completed',
  });
}

/**
 * Physical base backup: pg_basebackup streams a tar of the data directory (with the WAL needed for consistency, `-X fetch`,
 * and its backup_manifest, which the restore checks with pg_verifybackup)
 * to stdout; it is cut into parts, each sealed and uploaded before the next is read. Afterwards the
 * current WAL segment is closed, so the archive covers the end of the backup without waiting for archive_timeout.
 */
export async function takeBaseBackup(ctx: BackupContext): Promise<{ manifest: BackupManifest; record: BackupRecord }> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();
  const id = newBackupId('physical', startedAt);
  const [startWal, startLsn, serverVersion, timeline] = (await ctx.exec.psql(
    "SELECT pg_walfile_name(pg_current_wal_lsn()) || '|' || pg_current_wal_lsn() || '|' || current_setting('server_version_num') || '|' || (SELECT timeline_id FROM pg_control_checkpoint())",
  )).split('|') as [string, string, string, string];
  const parts: PartRef[] = [];
  await ctx.exec.streamParts(['pg_basebackup', '-U', ctx.exec.options.user, '-D', '-', '-Ft', '-X', 'fetch', '-c', 'fast'], PART_BYTES, async (part, index) => {
    const key = `base/${id}/part-${String(index).padStart(5, '0')}`;
    parts.push({ key, ...(await putSealed(ctx.target, ctx.key, key, part)) });
  });
  const [endLsn, endWal] = (await ctx.exec.psql("SELECT pg_current_wal_lsn() || '|' || pg_walfile_name(pg_current_wal_lsn()) FROM (SELECT pg_switch_wal()) s")).split('|') as [string, string];
  const manifest: BackupManifest = {
    v: 1, id, format: 'physical', nodeId: ctx.nodeId, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), keyId: ctx.key.id,
    target: { kind: ctx.target.kind, offHost: ctx.target.offHost }, parts, totalBytes: parts.reduce((n, p) => n + p.bytes, 0),
    pg: { serverVersion, timeline: Number(timeline), startWal, startLsn, endLsn, endWal },
  };
  const digest = await writeManifest(ctx, manifest);
  return { manifest, record: backupRecord(manifest, digest) };
}

export interface ShipReport { shipped: string[]; alreadyPresent: string[]; bytes: number }

/**
 * Ships every spooled WAL file: seal, upload, verify the stored size, then remove it from the spool. A file already in
 * the target is removed from the spool only when its content is identical (an archive_command retry); a different
 * file under the same name stops the shipper (two clusters writing to one target) and stays in the spool.
 */
export async function shipWal(ctx: Pick<BackupContext, 'exec' | 'target' | 'key'> & { ring?: Keyring }): Promise<ShipReport> {
  const report: ShipReport = { shipped: [], alreadyPresent: [], bytes: 0 };
  for (const name of await ctx.exec.spooled()) {
    assertWalName(name);
    const data = await ctx.exec.readSpooled(name);
    const key = `wal/${name}`;
    if (await ctx.target.store.head(key)) {
      const existing = await getSealed(ctx.target, ctx.ring ?? ctx.key, key);
      if (!existing || sha256Hex(existing) !== sha256Hex(data)) throw new Error(`WAL file ${name} already in the target with different content; refusing to overwrite`);
      report.alreadyPresent.push(name);
    } else {
      await putSealed(ctx.target, ctx.key, key, data);
      report.shipped.push(name);
      report.bytes += data.length;
    }
    await ctx.exec.removeSpooled(name);
  }
  return report;
}

/**
 * Closes the current WAL segment and waits until archive_command has put it into the spool, so the next shipWal call
 * covers every transaction committed before this call (used before planned maintenance and by the drill).
 */
export async function closeSegment(exec: PgExec, timeoutMs = 60_000): Promise<string> {
  const segment = await exec.psql('SELECT pg_walfile_name(pg_switch_wal())');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const archived = await exec.psql("SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver");
    if (archived >= segment) return segment;
    if (Date.now() > deadline) throw new Error(`WAL segment ${segment} was not archived within ${timeoutMs} ms (check archive_command)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Logical dump (pg_dump custom format) of the configured database, cut into sealed parts. */
export async function takeLogicalBackup(ctx: BackupContext): Promise<{ manifest: BackupManifest; record: BackupRecord }> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();
  const id = newBackupId('logical', startedAt);
  const parts: PartRef[] = [];
  await ctx.exec.streamParts(['pg_dump', '-Fc', '-U', ctx.exec.options.user, '-d', ctx.exec.options.database], PART_BYTES, async (part, index) => {
    const key = `logical/${id}/part-${String(index).padStart(5, '0')}`;
    parts.push({ key, ...(await putSealed(ctx.target, ctx.key, key, part)) });
  });
  const manifest: BackupManifest = {
    v: 1, id, format: 'logical', nodeId: ctx.nodeId, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), keyId: ctx.key.id,
    target: { kind: ctx.target.kind, offHost: ctx.target.offHost }, parts, totalBytes: parts.reduce((n, p) => n + p.bytes, 0), database: ctx.exec.options.database,
  };
  const digest = await writeManifest(ctx, manifest);
  return { manifest, record: backupRecord(manifest, digest) };
}

/**
 * Copies of stored files (FILE-001 object store), content-addressed so unchanged files are stored once across
 * backups. Keys under `excludePrefixes` (for example the tombstone ledger when it shares a bucket) are skipped.
 */
export async function backupObjects(ctx: Omit<BackupContext, 'exec'> & { source: Pick<BlobStore, 'list' | 'read'>; excludePrefixes?: string[]; maxObjectBytes?: number }): Promise<{ manifest: BackupManifest; record: BackupRecord }> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();
  const id = newBackupId('objects', startedAt);
  const objects: NonNullable<BackupManifest['objects']> = [];
  let total = 0;
  for (const storageKey of await ctx.source.list('')) {
    if ((ctx.excludePrefixes ?? []).some((prefix) => storageKey.startsWith(prefix))) continue;
    const body = await ctx.source.read(storageKey, ctx.maxObjectBytes ?? 64 * 1024 * 1024);
    if (!body) continue;
    const sha256 = sha256Hex(body);
    const blobKey = `objects/blob/${sha256}`;
    if (!(await ctx.target.store.head(blobKey))) await putSealed(ctx.target, ctx.key, blobKey, body);
    objects.push({ storageKey, sha256, bytes: body.length });
    total += body.length;
  }
  const manifest: BackupManifest = {
    v: 1, id, format: 'objects', nodeId: ctx.nodeId, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), keyId: ctx.key.id,
    target: { kind: ctx.target.kind, offHost: ctx.target.offHost }, parts: [], totalBytes: total, objects,
  };
  const digest = await writeManifest(ctx, manifest);
  return { manifest, record: backupRecord(manifest, digest, 'object_store') };
}

/** Every manifest of one format, oldest first (by finishedAt). */
export async function listManifests(target: BackupTarget, ring: Keyring | BackupKey, format: BackupManifest['format']): Promise<BackupManifest[]> {
  const keys = (await target.store.list(`${PREFIX[format]}/`)).filter((k) => k.endsWith('/manifest.json'));
  const out: BackupManifest[] = [];
  for (const key of keys) {
    const body = await getSealed(target, ring, key);
    if (body) out.push(JSON.parse(body.toString('utf8')) as BackupManifest);
  }
  return out.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

/** Reads every part of a backup in order, verifying each digest, and hands it to `sink`. */
export async function readParts(target: BackupTarget, ring: Keyring | BackupKey, manifest: BackupManifest, sink: (part: Buffer) => Promise<void> | void): Promise<number> {
  let bytes = 0;
  for (const part of manifest.parts) {
    const body = await getSealed(target, ring, part.key, part.sha256);
    if (!body) throw new Error(`backup part missing: ${part.key}`);
    bytes += body.length;
    await sink(body);
  }
  return bytes;
}

/** WAL files in the target, in replay order (history files first, then segments by name). */
export async function listWal(target: BackupTarget): Promise<string[]> {
  return (await target.store.list('wal/')).map((k) => k.slice(4)).filter((n) => /^[0-9A-F]{24}$|^[0-9A-F]{8}\.history$/.test(n)).sort();
}

export interface PruneDecision { key: string; reason: string }
export interface PrunePlan { keep: string[]; remove: PruneDecision[] }

/**
 * Backup retention: keeps every backup that finished within `keepDays`, and always the newest physical backup and
 * the WAL from its start onward (so the newest restore point never disappears); removes older base, logical and object
 * backups and the WAL segments before the oldest kept base backup. Timeline history files are always kept. Planning is
 * pure; `applyPrune` deletes. Nothing inside the window is ever removed.
 */
export function planPrune(input: { now: Date; keepDays: number; physical: BackupManifest[]; logical: BackupManifest[]; objects: BackupManifest[]; wal: string[] }): PrunePlan {
  if (!Number.isInteger(input.keepDays) || input.keepDays < 1) throw new Error('keepDays must be a positive integer');
  const cutoff = input.now.getTime() - input.keepDays * 86_400_000;
  const keep: string[] = [];
  const remove: PruneDecision[] = [];
  const newestPhysical = input.physical.at(-1);
  const keptPhysical: BackupManifest[] = [];
  const decide = (manifests: BackupManifest[], alwaysKeep: BackupManifest | undefined, kept?: BackupManifest[]) => {
    for (const m of manifests) {
      if (m === alwaysKeep || Date.parse(m.finishedAt) >= cutoff) {
        keep.push(manifestKey(m.format, m.id));
        kept?.push(m);
      } else {
        for (const part of m.parts) remove.push({ key: part.key, reason: `${m.id} finished before the ${input.keepDays}-day window` });
        remove.push({ key: manifestKey(m.format, m.id), reason: `${m.id} finished before the ${input.keepDays}-day window` });
      }
    }
  };
  decide(input.physical, newestPhysical, keptPhysical);
  decide(input.logical, input.logical.at(-1));
  decide(input.objects, input.objects.at(-1));
  const oldestStart = keptPhysical.map((m) => m.pg?.startWal).filter((s): s is string => Boolean(s)).sort()[0];
  for (const name of input.wal) {
    if (name.endsWith('.history') || oldestStart === undefined || name >= oldestStart) keep.push(`wal/${name}`);
    else remove.push({ key: `wal/${name}`, reason: `before ${oldestStart}, the start of the oldest kept base backup` });
  }
  return { keep, remove };
}

/** Deletes what planPrune decided; objects/blob entries no kept object manifest references are removed too. */
export async function applyPrune(target: BackupTarget, plan: PrunePlan, keptObjectManifests: BackupManifest[]): Promise<number> {
  for (const decision of plan.remove) await target.store.delete(decision.key);
  const referenced = new Set(keptObjectManifests.flatMap((m) => (m.objects ?? []).map((o) => `objects/blob/${o.sha256}`)));
  let blobs = 0;
  for (const key of await target.store.list('objects/blob/')) {
    if (!referenced.has(key)) {
      await target.store.delete(key);
      blobs += 1;
    }
  }
  return plan.remove.length + blobs;
}

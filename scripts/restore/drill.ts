import { PrivacyErasureLedger } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { RestoreDrillSchema, type BackupRecord, type RestoreDrill } from '@trustwork/contracts';
import { createPool, type DataPool } from '@trustwork/data';
import { migrateWithConfig } from '@trustwork/data/migrate';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';
import { TombstoneLedger } from '../../packages/data/src/files/tombstones.js';
import { HandlerRegistry, RetryableJobError, Worker } from '../../apps/worker/src/index.js';
import { backupObjects, closeSegment, readParts, shipWal, takeBaseBackup, takeLogicalBackup } from '../../infra/backup/src/backup.js';
import { deriveBackupKey, Keyring, sha256Hex } from '../../infra/backup/src/crypto.js';
import { composeExecPrefix, PgExec } from '../../infra/backup/src/pg.js';
import { inOwnerTransaction } from '../../infra/backup/src/retention.js';
import { filesystemTarget } from '../../infra/backup/src/target.js';
import { HbaFence } from './fence.js';
import { FakeProvider } from './provider.js';
import { authorizeRestore, AuthorizationRefused, readReceiptJournal, reconcileRestore, resolveOutboxEvent, type ReconcileReport } from './reconcile.js';
import { replayTombstones, restoreObjects, verifyDigests, verifySchema } from './recover.js';
import { destroyRestore, planRestore, restoreExec, stageRestore, startRestored, PGDATA, type RestoreProject } from './stage.js';

/**
 * Restore drill on synthetic data (OPS-003). Runs entirely on this machine with Docker: a source PostgreSQL with WAL
 * archiving (infra/compose.yaml + infra/backup/compose.backup.yaml), the backup tooling against a filesystem target,
 * synthetic work on both sides of the recovery point, a hard failure, and a point-in-time restore into an isolated
 * compose project with the restore fence, tombstone replay, object restore, reconciliation against the provider fake,
 * authorization, and a check that the restored worker never re-sends an effect. Writes evidence JSON and exits 0 only
 * when every check passed and the measured recovery time and data-loss window are within the targets.
 *
 *   node --import tsx scripts/restore/drill.ts [--evidence <file>] [--keep] [--no-pitr] [--no-logical]
 *
 * Every resource it creates is drill-owned (compose projects and volumes named trustwork-drill-*, a temporary
 * directory) and removed at the end unless --keep. It never touches the development database or another project.
 */
export interface DrillOptions {
  evidencePath: string | null;
  keep: boolean;
  pitrCheck: boolean;
  logicalCheck: boolean;
  sourcePort: number;
  restorePort: number;
  /** Seconds (ADR 012 decision 26: demo RPO 24 h, RTO 8 h). */
  rpoTargetSeconds: number;
  rtoTargetSeconds: number;
  archiveTimeoutSeconds: number;
  shipIntervalMs: number;
  log: (line: string) => void;
}

export const DEFAULT_DRILL: DrillOptions = {
  evidencePath: null, keep: false, pitrCheck: true, logicalCheck: true, sourcePort: 54339, restorePort: 54349,
  rpoTargetSeconds: 24 * 3600, rtoTargetSeconds: 8 * 3600, archiveTimeoutSeconds: 10, shipIntervalMs: 1000, log: (l) => process.stdout.write(`${l}\n`),
};

const SOURCE_FILES = [resolve('infra/compose.yaml'), resolve('infra/backup/compose.backup.yaml')];
const DRILL_KIND = 'drill.provider_call';
const DRILL_EVENT = 'drill.requested';
const OPERATOR = 'drill-operator';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sh(command: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 4).join(' ')} failed: ${(result.stderr || result.stdout || String(result.error)).slice(-800)}`);
  return result.stdout;
}

interface Marker { seq: number; at: Date }
interface Check { name: string; ok: boolean; detail: unknown }

export interface DrillEvidence {
  v: 1;
  drill: RestoreDrill;
  backups: BackupRecord[];
  measurements: {
    recoverySeconds: number;
    dataLossWindowSeconds: number;
    lostMarkers: number;
    walShippingStoppedBeforeFailureSeconds: number;
    targets: { rpoSeconds: number; rtoSeconds: number };
    withinTargets: boolean;
    phases: Record<string, number>;
  };
  timeline: Record<string, string>;
  checks: Check[];
  reconciliation: ReconcileReport;
  providerCalls: { total: number; beforeFailure: number; duringFence: number; afterAuthorization: number; duplicatesAfterRestore: number };
  environment: { postgresImage: string; node: string; platform: string; commit: string | null; synthetic: true };
}

export async function runDrill(options: DrillOptions = DEFAULT_DRILL): Promise<DrillEvidence> {
  const log = options.log;
  const id = `drill-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(2).toString('hex')}`.toLowerCase();
  const sourceProject = `trustwork-drill-src-${id.slice(-4)}`;
  const restore: RestoreProject = { project: `trustwork-drill-rst-${id.slice(-4)}`, volume: `trustwork-drill-rst-${id.slice(-4)}-data`, port: options.restorePort };
  const pitrProject: RestoreProject = { project: `trustwork-drill-pitr-${id.slice(-4)}`, volume: `trustwork-drill-pitr-${id.slice(-4)}-data`, port: options.restorePort + 1 };
  const work = mkdtempSync(join(tmpdir(), 'trustwork-drill-'));
  for (const d of ['target', 'objects', 'ledger', 'provider']) mkdirSync(join(work, d), { recursive: true });
  const passwords = { migrator: randomBytes(12).toString('hex'), api: randomBytes(12).toString('hex'), worker: randomBytes(12).toString('hex') };
  const target = filesystemTarget(join(work, 'target'));
  const key = deriveBackupKey('drill', randomBytes(32));
  const ring = new Keyring(key);
  const liveStore = new FilesystemBlobStore({ root: join(work, 'objects') });
  const privacyLedger = new PrivacyErasureLedger(new FilesystemBlobStore({ root: join(work, 'privacy-ledger'), bucket: 'trustwork-privacy-ledger' }));
  const ledger = new TombstoneLedger(new FilesystemBlobStore({ root: join(work, 'ledger'), bucket: 'trustwork-tombstones' }));
  const provider = new FakeProvider(join(work, 'provider'));
  const timeline: Record<string, string> = {};
  const mark = (name: string) => { timeline[name] = new Date().toISOString(); };
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === null ? '' : ` ${JSON.stringify(detail)}`}`);
  };
  const backups: BackupRecord[] = [];
  const pools: { end(): Promise<void> }[] = [];
  const sourceEnv = { TRUSTWORK_PG_PORT: String(options.sourcePort), TRUSTWORK_BACKUP_ARCHIVE_TIMEOUT: String(options.archiveTimeoutSeconds) };
  const compose = (args: string[]) => sh('docker', ['compose', '-p', sourceProject, ...SOURCE_FILES.flatMap((f) => ['-f', f]), ...args], sourceEnv);
  const exec = new PgExec({ prefix: ['env', ...Object.entries(sourceEnv).map(([k, v]) => `${k}=${v}`), ...composeExecPrefix(sourceProject, SOURCE_FILES)], user: 'trustwork_dev', database: 'trustwork_stack', walSpool: '/var/lib/postgresql/wal-spool' });
  const url = (port: number, login: string, password: string) => `postgresql://${login}:${password}@127.0.0.1:${port}/trustwork_stack`;
  const pool = (connectionString: string, max = 4): pg.Pool => {
    const p = new pg.Pool({ connectionString, max, application_name: 'trustwork-drill' });
    p.on('error', () => undefined);
    pools.push(p);
    return p;
  };
  const dataPool = (connectionString: string, max = 4): DataPool => {
    const p = createPool({ connectionString, max, application_name: 'trustwork-drill' });
    p.on('error', () => undefined);
    pools.push(p);
    return p;
  };
  const owner = async <T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await p.connect();
    try {
      return await inOwnerTransaction(c, () => fn(c));
    } finally {
      c.release();
    }
  };

  let shipping = true;
  let shipper: Promise<void> | null = null;
  let writing = true;
  let writer: Promise<void> | null = null;
  const markers: { last: Marker | null } = { last: null };
  let walStoppedAt: Date | null = null;

  try {
    // ---------------------------------------------------------------------------------------------------------- 1
    log(`drill ${id}: source ${sourceProject} on 127.0.0.1:${options.sourcePort}, work directory ${work}`);
    if (sh('docker', ['volume', 'ls', '-q', '--filter', `name=^${sourceProject}_`]).trim()) throw new Error(`volumes of ${sourceProject} already exist`);
    compose(['up', '-d', '--wait', 'postgres']);
    mark('sourceUp');
    const roles = readFileSync(resolve('infra/images/stack-roles.sql'), 'utf8');
    const execEnv = ['-e', `TRUSTWORK_STACK_MIGRATOR_PASSWORD=${passwords.migrator}`, '-e', `TRUSTWORK_STACK_API_PASSWORD=${passwords.api}`, '-e', `TRUSTWORK_STACK_WORKER_PASSWORD=${passwords.worker}`];
    sh('docker', ['compose', '-p', sourceProject, ...SOURCE_FILES.flatMap((f) => ['-f', f]), 'exec', '-T', ...execEnv, 'postgres', 'psql', '-X', '-q', '-U', 'trustwork_dev', '-d', 'trustwork_dev', '-f', '-'], sourceEnv, roles);
    const migratorUrl = url(options.sourcePort, 'trustwork_stack_migrator', passwords.migrator);
    const applied = await migrateWithConfig({ connectionString: migratorUrl });
    log(`migrations applied: ${applied.length}`);
    const src = pool(migratorUrl);

    // Synthetic seed: three people, six stored files (bytes in the live object store).
    const seed = await owner(src, async (c) => {
      const people: string[] = [];
      for (let i = 1; i <= 3; i++) people.push((await c.query<{ id: string }>('INSERT INTO trustwork.person (display_name) VALUES ($1) RETURNING id', [`Drill synthetic person ${i}`])).rows[0]!.id);
      const files: { id: string; key: string }[] = [];
      for (let i = 1; i <= 6; i++) {
        const body = Buffer.from(`Drill synthetic file ${i} ${randomBytes(16).toString('hex')}\n`, 'utf8');
        const storageKey = `drill/${randomUUID()}`;
        await liveStore.put(storageKey, body);
        const owner = people[i % 3] as string;
        const row = await c.query<{ id: string }>(`INSERT INTO trustwork.evidence_artifact (owner_person_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, scan_state, uploaded_by)
          VALUES ($1, 'person', $1, 'owner_private', $2, $3, $4, 'text/plain', 'clean', $1) RETURNING id`, [owner, storageKey, sha256Hex(body), body.length]);
        files.push({ id: row.rows[0]!.id, key: storageKey });
      }
      return { people, files };
    });
    const [a1, a2, a3] = seed.files as [{ id: string; key: string }, { id: string; key: string }, { id: string; key: string }];

    // ---------------------------------------------------------------------------------------------------------- 2
    const objects = await backupObjects({ target, key, nodeId: 'drill-node', source: liveStore });
    backups.push(objects.record);
    const base = await takeBaseBackup({ exec, target, key, nodeId: 'drill-node' });
    backups.push(base.record);
    mark('baseBackupFinished');
    log(`base backup ${base.manifest.id}: ${base.manifest.totalBytes} bytes in ${base.manifest.parts.length} parts, WAL from ${base.manifest.pg?.startWal}`);
    const logical = options.logicalCheck ? await takeLogicalBackup({ exec, target, key, nodeId: 'drill-node' }) : null;
    if (logical) backups.push(logical.record);
    let shippedSegments = 0;
    shipper = (async () => {
      while (shipping) {
        const report = await shipWal({ exec, target, key }).catch((error: Error) => { log(`ship error: ${error.message}`); return null; });
        shippedSegments += report?.shipped.length ?? 0;
        await sleep(options.shipIntervalMs);
      }
    })();
    let seq = 0;
    writer = (async () => {
      const p = pool(migratorUrl, 1);
      while (writing) {
        seq += 1;
        try {
          const at = await owner(p, async (c) => (await c.query<{ at: Date }>("INSERT INTO trustwork.audit_event (action, object_kind, object_id) VALUES ('drill.marker', 'drill', $1) RETURNING occurred_at AS at", [String(seq)])).rows[0]!.at);
          markers.last = { seq, at };
        } catch {
          // the source is gone (failure injected); the last acknowledged marker is the last committed write
        }
        await sleep(200);
      }
    })();

    // ---------------------------------------------------------------------------------------------------------- 3
    // Phase B: work before the recovery point (shipped).
    const workerPool = dataPool(url(options.sourcePort, 'trustwork_stack_worker', passwords.worker));
    let allow: (jobId: string, payload: { eventId?: string }) => boolean = () => true;
    const registry = () => new HandlerRegistry()
      .onJob<{ eventId?: string }>({ kind: DRILL_KIND, mode: 'external', run: async (ctx) => {
        if (!allow(ctx.job.id, ctx.payload ?? {})) throw new RetryableJobError('drill: held back in this phase');
        provider.call(ctx.effectKey, DRILL_KIND);
      } })
      .onOutbox({ name: 'drill.request', type: DRILL_EVENT, handle: async (event, ctx) => void (await ctx.enqueue({ kind: DRILL_KIND, payload: { eventId: event.id } })) });
    const sourceWorker = new Worker({ pool: workerPool, registry: registry(), config: { workerId: 'drill-source', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
    const enqueue = (payload: object = {}) => owner(src, async (c) => (await c.query<{ id: string }>('INSERT INTO trustwork.job (kind, payload) VALUES ($1, $2) RETURNING id', [DRILL_KIND, JSON.stringify(payload)])).rows[0]!.id);
    const event = (n: number) => owner(src, async (c) => (await c.query<{ id: string }>("INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('drill', $1, 1, $2, '{}') RETURNING id::text AS id", [`drill-${n}`, DRILL_EVENT])).rows[0]!.id);
    const jobState = (p: pg.Pool, jobId: string) => owner(p, async (c) => (await c.query<{ state: string }>('SELECT state FROM trustwork.job WHERE id = $1', [jobId])).rows[0]?.state ?? 'missing');
    const drain = async (w: Worker, rounds = 3) => {
      for (let i = 0; i < rounds; i++) {
        await w.runOnce();
        await w.idle();
      }
    };
    const deleteFile = async (file: { id: string; key: string }, mode: 'delete' | 'erase') => {
      // What the worker's files.delete job does: tombstone first (outside the snapshot), then bytes, then the row.
      await ledger.record({ v: 1, artifactId: file.id, storageKey: file.key, reason: mode === 'erase' ? 'erased' : 'deleted', privacyRequestId: mode === 'erase' ? 'drill-privacy-request-1' : null, recordedAt: new Date().toISOString() });
      await liveStore.delete(file.key);
      await owner(src, async (c) => {
        await c.query(`INSERT INTO trustwork.file_artifact_state (artifact_id, origin, deletion_requested_at, deletion_requested_by, deletion_mode, privacy_request_id, erasure_approvers)
          VALUES ($1, 'upload', now(), $2, $3, $4, $5)`, [file.id, seed.people[0], mode, mode === 'erase' ? 'drill-privacy-request-1' : null, mode === 'erase' ? [seed.people[0], seed.people[1]] : null]);
        await c.query('SELECT trustwork.files_finish_deletion($1)', [file.id]);
      });
    };

    // A boundary marker; 'later' compares its start (now()) with the given time on the server, at full precision.
    const boundaryMarker = (side: 'before' | 'after', than: Date) => owner(src, async (c) => (await c.query<{ at: Date; later: boolean }>("INSERT INTO trustwork.audit_event (action, object_kind, object_id) VALUES ('drill.pitr_boundary', 'drill', $1) RETURNING occurred_at AS at, occurred_at > $2::timestamptz AS later", [side, than.toISOString()])).rows[0]!);
    const serverClockPassed = async (t: Date) => (await src.query<{ passed: boolean }>('SELECT clock_timestamp() > $1::timestamptz AS passed', [t.toISOString()])).rows[0]!.passed;
    const pitrBoundary = async (): Promise<{ target: Date; afterStartedAt: Date }> => {
      await boundaryMarker('before', new Date(0));
      const target = (await src.query<{ t: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t")).rows[0]!.t;
      while (!(await serverClockPassed(target))) await sleep(5);
      const after = await boundaryMarker('after', target);
      if (!after.later) throw new Error(`PITR boundary: 'after' started at ${after.at.toISOString()}, not after the target ${target.toISOString()}`);
      return { target, afterStartedAt: after.at };
    };

    const j1 = await enqueue();
    allow = (jobId) => jobId === j1;
    await drain(sourceWorker);
    const j2 = await enqueue();
    const e1 = await event(1);
    allow = () => false;
    await sourceWorker.relay.relayOnce();
    const j3 = (await owner(src, async (c) => (await c.query<{ id: string }>("SELECT id FROM trustwork.job WHERE payload->>'eventId' = $1", [e1])).rows[0]!.id));
    const j7 = await enqueue();
    // A job leased by a worker of the primary when it is lost (no effect yet).
    await owner(src, (c) => c.query("UPDATE trustwork.job SET state = 'leased', leased_by = 'drill-lost-worker', leased_until = now() + interval '10 minutes', attempt = attempt + 1, fencing_token = fencing_token + 1 WHERE id = $1", [j7]));
    await deleteFile(a1, 'delete');
    await sleep(600);
    // Point-in-time target. recovery_target_time is compared with commit timestamps, which the drill cannot read
    // (track_commit_timestamp is off), and occurred_at is the transaction start (now()): on a loaded machine the commit
    // of a marker can land well after its occurred_at, so a target derived from it may fall before that commit. The
    // target is therefore bracketed on the server clock by two commits: 'before' is acknowledged, then the target is
    // read (at or after that commit, rounded up to whole milliseconds because the restore takes millisecond precision);
    // 'after' starts only once the server clock has passed the target, so it commits strictly later. Every writer
    // marker acknowledged before 'before' started committed before the target and must be restored.
    const pitrMarker = markers.last;
    const pitr = await pitrBoundary();
    await sleep(600);
    const e3 = await event(3);
    // Close the current segment and ship everything: this is the last point the archive covers.
    // Every marker acknowledged before the switch is in the closed segment, so it must survive the restore.
    const lastShippedMarker = markers.last;
    const lastSegment = await closeSegment(exec);
    shipping = false;
    await shipper;
    shippedSegments += (await shipWal({ exec, target, key })).shipped.length;
    walStoppedAt = new Date();
    mark('walShippingStopped');
    log(`WAL shipped through ${lastSegment} (${shippedSegments} files); shipping stops now so the next phase falls after the recovery point`);

    // ---------------------------------------------------------------------------------------------------------- 4
    // Phase C: work after the recovery point (never archived): an effect for a queued job, a relay and its effect, a
    // deletion and an erasure recorded in the tombstone ledger.
    allow = (jobId, payload) => jobId === j2 || payload.eventId === e3;
    await drain(sourceWorker, 4);
    const j5 = (await owner(src, async (c) => (await c.query<{ id: string }>("SELECT id FROM trustwork.job WHERE payload->>'eventId' = $1", [e3])).rows[0]!.id));
    await deleteFile(a2, 'delete');
    await deleteFile(a3, 'erase');
    check('source: phase C effects happened on the primary', (await jobState(src, j2)) === 'succeeded' && (await jobState(src, j5)) === 'succeeded', { j2: await jobState(src, j2), j5: await jobState(src, j5) });
    await sleep(1500);

    // ---------------------------------------------------------------------------------------------------------- 5
    // Failure: the primary disappears; the live object store is discarded too (to exercise object restore).
    sh('docker', ['kill', '--signal', 'KILL', `${sourceProject}-postgres-1`]);
    const failureAt = new Date();
    mark('failure');
    writing = false;
    await writer;
    const committed = markers.last;
    if (!committed) throw new Error('no marker was committed on the source');
    rmSync(join(work, 'objects'), { recursive: true, force: true });
    mkdirSync(join(work, 'objects'));
    const callsBeforeFailure = provider.calls().length;
    log(`failure injected at ${failureAt.toISOString()}; last committed marker ${committed.seq} at ${committed.at.toISOString()}`);

    // ---------------------------------------------------------------------------------------------------------- 6
    // Point-in-time restore (to the end of the archive) into the isolated project, fenced from the first start.
    const restoreStartedAt = new Date();
    mark('restoreStarted');
    const phases: Record<string, number> = {};
    let phaseStart = Date.now();
    const phase = (name: string) => { phases[name] = (Date.now() - phaseStart) / 1000; phaseStart = Date.now(); };
    const plan = await planRestore(target, ring, null);
    const staged = await stageRestore({ target, ring, plan, volume: restore.volume, fence: true });
    phase('stage');
    check('base backup verified against its manifest (pg_verifybackup)', staged.verified === 'verified', { baseBytes: staged.baseBytes, walFiles: staged.walFiles });
    const recovered = await startRestored(restore, null);
    phase('recovery');
    const rexec = restoreExec(restore);
    const fence = new HbaFence(rexec, `${PGDATA}/pg_hba.conf`);
    check('restore fence in place before the first start', await fence.isApplied());
    const restoredMigrator = url(restore.port, 'trustwork_stack_migrator', passwords.migrator);
    const restoredWorkerUrl = url(restore.port, 'trustwork_stack_worker', passwords.worker);
    const rst = pool(restoredMigrator);
    const refused = await new pg.Client({ connectionString: restoredWorkerUrl }).connect().then(() => false, (error: { code?: string }) => error.code === '28000');
    const fencedWorker = new Worker({ pool: dataPool(restoredWorkerUrl, 2), registry: registry(), config: { workerId: 'drill-restored-fenced', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
    const fencedRun = await fencedWorker.runOnce();
    const callsDuringFence = provider.calls().length - callsBeforeFailure;
    check('restored worker cannot log in before authorization and contacts no provider', refused && fencedRun.leased === 0 && fencedRun.errors > 0 && callsDuringFence === 0, { loginRefused: refused, leased: fencedRun.leased, errors: fencedRun.errors, providerCalls: callsDuringFence });

    const schema = await verifySchema(rst);
    check('schema: migration ledger matches the shipped migrations', schema.ok, { applied: schema.applied, problems: schema.problems });
    const restoredMarker = await owner(rst, async (c) => (await c.query<{ seq: string; at: Date }>("SELECT object_id AS seq, occurred_at AS at FROM trustwork.audit_event WHERE action = 'drill.marker' ORDER BY id DESC LIMIT 1")).rows[0]);
    const lastRestored: Marker = { seq: Number(restoredMarker?.seq ?? 0), at: restoredMarker?.at ?? new Date(0) };
    const dataLossWindowSeconds = Math.max(0, (committed.at.getTime() - lastRestored.at.getTime()) / 1000);
    check('data up to the last archived write is present', lastShippedMarker !== null && lastRestored.seq >= lastShippedMarker.seq, { lastShipped: lastShippedMarker?.seq, lastRestored: lastRestored.seq, recoveryPoint: recovered.recoveryPoint?.toISOString() });
    const restoredJobs = await owner(rst, async (c) => Object.fromEntries((await c.query<{ id: string; state: string }>('SELECT id, state FROM trustwork.job WHERE id = ANY ($1)', [[j1, j2, j3, j7]])).rows.map((r) => [r.id, r.state])));
    check('restored job states are those of the recovery point', restoredJobs[j1] === 'succeeded' && restoredJobs[j2] === 'queued' && restoredJobs[j3] === 'queued' && restoredJobs[j7] === 'leased', restoredJobs);
    phase('verify');

    const replay = await replayTombstones({ adminUrl: restoredMigrator, store: liveStore, tombstones: ledger });
    const remaining = await owner(rst, async (c) => (await c.query<{ id: string }>('SELECT id FROM trustwork.evidence_artifact WHERE id = ANY ($1)', [[a1.id, a2.id, a3.id]])).rows.map((r) => r.id));
    check('tombstones recorded after the backup replayed (deleted and erased files stay gone)', replay.tombstones === 3 && replay.rowsRemoved === 2 && remaining.length === 0 && replay.invalid.length === 0 && replay.held.length === 0, replay);
    const objectsRestored = await restoreObjects({ admin: rst, store: liveStore, target, ring });
    check('stored files restored from the object backup (none of the tombstoned ones)', objectsRestored.restored === 3 && objectsRestored.missing.length === 0 && !(await liveStore.head(a2.key)) && !(await liveStore.head(a3.key)), objectsRestored);
    const digests = await verifyDigests({ admin: rst, store: liveStore });
    check('every stored file matches its recorded SHA-256', digests.checked === 3 && digests.mismatched.length === 0, digests);
    phase('replay_and_objects');

    const journal = await readReceiptJournal(provider.receiptsPath, new Date());
    const report = await reconcileRestore({ admin: rst, restoreId: id, recoveryPoint: recovered.recoveryPoint ?? lastRestored.at, restoreStartedAt, journal, operator: OPERATOR });
    check('reconciliation: effect after the recovery point closed by its receipt, never re-sent', report.jobs.closedByReceipt.map((j) => j.id).join() === j2, report.jobs.closedByReceipt);
    check('reconciliation: lost lease released, untouched queue kept', report.jobs.releasedToQueue.map((j) => j.id).join() === j7 && report.jobs.keptQueued.map((j) => j.id).join() === j3, { released: report.jobs.releasedToQueue, kept: report.jobs.keptQueued });
    check('reconciliation: receipt of lost work reported, pending event marked ambiguous', report.orphanReceipts.length === 1 && report.orphanReceipts[0]?.effectKey === `job:${j5}` && report.ambiguousOutbox.join() === e3, { orphans: report.orphanReceipts.length, ambiguous: report.ambiguousOutbox });
    const early = await authorizeRestore({ admin: rst, fence, restoreId: id, reference: `drill:${id}`, operator: OPERATOR, privacyLedger }).then(() => null, (error: unknown) => error);
    check('authorization refused while an outbox event is undecided', early instanceof AuthorizationRefused && (await fence.isApplied()), early instanceof Error ? early.message : early);
    await resolveOutboxEvent({ admin: rst, restoreId: id, eventId: e3, decision: 'delivered', reference: report.orphanReceipts[0]?.reference ?? 'unknown', operator: OPERATOR });
    const { authorizedAt } = await authorizeRestore({ admin: rst, fence, restoreId: id, reference: `drill:${id}`, operator: OPERATOR, privacyLedger });
    phase('reconcile_and_authorize');
    const recoverySeconds = (Date.parse(authorizedAt) - restoreStartedAt.getTime()) / 1000;
    mark('authorized');
    check('fence lifted only after authorization', !(await fence.isApplied()));

    // ---------------------------------------------------------------------------------------------------------- 7
    // The restored worker runs: approved work executes once; nothing that already reached the provider is sent again.
    const permissions = await new pg.Client({ connectionString: restoredWorkerUrl }).connect().then(async (c) => {
      const denied = await c.query('SELECT 1 FROM trustwork.person LIMIT 1').then(() => false, (error: { code?: string }) => error.code === '42501');
      await c.end();
      return denied;
    }, () => false);
    check('permissions: worker login connects after authorization and still cannot read party data', permissions);
    provider.phase = 'restored';
    const restoredWorker = new Worker({ pool: dataPool(restoredWorkerUrl, 4), registry: registry(), config: { workerId: 'drill-restored', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
    allow = () => true;
    await drain(restoredWorker, 4);
    const after = provider.calls().filter((c) => c.phase === 'restored');
    const duplicates = after.filter((c) => [j1, j2, j5].some((j) => c.effectKey === `job:${j}`)).length;
    const executed = new Set(after.map((c) => c.effectKey));
    check('restored worker executed approved work exactly once and re-sent nothing', duplicates === 0 && after.length === 2 && executed.has(`job:${j3}`) && executed.has(`job:${j7}`), { calls: after.map((c) => c.effectKey) });
    const e3Jobs = await owner(rst, async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.job WHERE payload->>'eventId' = $1", [e3])).rows[0]!.n);
    check('the event already delivered before the failure was not relayed again', e3Jobs === 0, { jobsForEvent: e3Jobs });

    // ---------------------------------------------------------------------------------------------------------- 8
    if (logical) {
      const db = 'drill_logical_check';
      await rexec.psql(`CREATE DATABASE ${db}`, 'postgres');
      const logicalExec = new PgExec({ ...rexec.options, database: db });
      await new Promise<void>((resolveRestore, reject) => {
        const [command, ...args] = [...logicalExec.options.prefix, 'pg_restore', '--no-owner', '--no-privileges', '-U', 'trustwork_dev', '-d', db];
        const child = spawn(command as string, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        child.once('close', (code) => (code === 0 ? resolveRestore() : reject(new Error(`pg_restore exited ${code}: ${err.slice(-500)}`))));
        readParts(target, ring, logical.manifest, (part) => new Promise<void>((ok) => (child.stdin.write(part) ? ok() : child.stdin.once('drain', ok)))).then(() => child.stdin.end(), reject);
      });
      const counts = (await logicalExec.psql('SELECT (SELECT count(*) FROM trustwork.person) || \'|\' || (SELECT count(*) FROM trustwork.evidence_artifact)')).split('|').map(Number);
      check('logical dump restores into a scratch database with the seed counts', counts[0] === 3 && counts[1] === 6, { persons: counts[0], artifacts: counts[1] });
    }
    if (options.pitrCheck) {
      const pitrTarget = pitr.target;
      const pitrPlan = await planRestore(target, ring, pitrTarget);
      await stageRestore({ target, ring, plan: pitrPlan, volume: pitrProject.volume, fence: true });
      const pitrRecovered = await startRestored(pitrProject, pitrTarget);
      const pexec = restoreExec(pitrProject);
      const [maxSeq, later, boundary, j1State] = (await pexec.psql(`SELECT
          (SELECT coalesce(max(object_id::int), 0) FROM trustwork.audit_event WHERE action = 'drill.marker')
          || '|' || (SELECT count(*) FROM trustwork.audit_event WHERE action = 'drill.marker' AND occurred_at > '${pitrTarget.toISOString()}')
          || '|' || (SELECT coalesce(string_agg(object_id, ',' ORDER BY object_id DESC), '') FROM trustwork.audit_event WHERE action = 'drill.pitr_boundary')
          || '|' || (SELECT state FROM trustwork.job WHERE id = '${j1}')`)).split('|');
      // 'before' committed at or before the target and 'after' strictly after it: recovery must stop between them.
      // Writer markers: every one acknowledged before the boundary is there; none that started after the target is.
      // The last replayed commit (pg_last_xact_replay_timestamp) is not after the target.
      const recoveryPoint = pitrRecovered.recoveryPoint;
      const ok = boundary === 'before' && (pitrMarker === null || Number(maxSeq) >= pitrMarker.seq) && Number(later) === 0 && j1State === 'succeeded'
        && recoveryPoint !== null && recoveryPoint.getTime() <= pitrTarget.getTime();
      check('point-in-time restore stops exactly at the target time', ok, {
        target: pitrTarget.toISOString(), boundaryCommits: boundary, afterStartedAt: pitr.afterStartedAt.toISOString(),
        markerAcknowledgedBefore: pitrMarker?.seq ?? null, lastMarker: Number(maxSeq), markersStartedAfterTarget: Number(later), j1: j1State, recoveryPoint: recoveryPoint?.toISOString() ?? null,
      });
      await destroyRestore(pitrProject);
    }

    // ---------------------------------------------------------------------------------------------------------- 9
    const withinTargets = recoverySeconds <= options.rtoTargetSeconds && dataLossWindowSeconds <= options.rpoTargetSeconds;
    check('measured recovery time and data-loss window within the targets', withinTargets, { recoverySeconds, dataLossWindowSeconds, rtoTargetSeconds: options.rtoTargetSeconds, rpoTargetSeconds: options.rpoTargetSeconds });
    const passed = checks.every((c) => c.ok);
    const drill = RestoreDrillSchema.parse({
      id, nodeId: 'drill-node', backupIds: backups.map((b) => b.id), isolatedEnvironment: true, externalAdaptersDisabled: true,
      checks: {
        schemaChecksums: schema.ok && staged.verified === 'verified',
        digestsVerified: digests.mismatched.length === 0,
        tombstonesReplayed: replay.rowsRemoved === 2,
        objectsRestored: objectsRestored.missing.length === 0,
        permissionsVerified: permissions && refused,
      },
      measuredRecoveryMinutes: Math.ceil(recoverySeconds / 60),
      dataLossWindowMinutes: Math.ceil(dataLossWindowSeconds / 60),
      performedBy: OPERATOR, witnessedBy: null, performedAt: restoreStartedAt.toISOString(), outcome: passed ? 'passed' : 'failed',
    } satisfies RestoreDrill);
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null;
    const evidence: DrillEvidence = {
      v: 1, drill, backups,
      measurements: {
        recoverySeconds, dataLossWindowSeconds, lostMarkers: committed.seq - lastRestored.seq,
        walShippingStoppedBeforeFailureSeconds: walStoppedAt ? (failureAt.getTime() - walStoppedAt.getTime()) / 1000 : 0,
        targets: { rpoSeconds: options.rpoTargetSeconds, rtoSeconds: options.rtoTargetSeconds }, withinTargets, phases,
      },
      timeline, checks, reconciliation: report,
      providerCalls: { total: provider.calls().length, beforeFailure: callsBeforeFailure, duringFence: callsDuringFence, afterAuthorization: after.length, duplicatesAfterRestore: duplicates },
      environment: { postgresImage: 'postgres:18.3', node: process.version, platform: `${process.platform}-${process.arch}`, commit, synthetic: true },
    };
    if (options.evidencePath) {
      mkdirSync(dirname(resolve(options.evidencePath)), { recursive: true });
      writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    log(`drill ${passed ? 'PASSED' : 'FAILED'}: recovery ${recoverySeconds.toFixed(1)} s (target ${options.rtoTargetSeconds} s), data-loss window ${dataLossWindowSeconds.toFixed(1)} s (target ${options.rpoTargetSeconds} s)`);
    return evidence;
  } finally {
    shipping = false;
    writing = false;
    await Promise.allSettled([shipper, writer].filter(Boolean) as Promise<void>[]);
    await Promise.allSettled(pools.map((p) => p.end()));
    if (!options.keep) {
      await destroyRestore(restore);
      await destroyRestore(pitrProject);
      try {
        compose(['down', '-v', '--remove-orphans']);
      } catch (error) {
        log(`cleanup: ${(error as Error).message}`);
      }
      rmSync(work, { recursive: true, force: true });
    } else log(`kept: compose projects ${sourceProject}, ${restore.project}; directory ${work}`);
  }
}

export function parseDrillArgs(argv: string[], base: DrillOptions = DEFAULT_DRILL): DrillOptions {
  const options = { ...base };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--evidence') options.evidencePath = argv[++i] ?? null;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-pitr') options.pitrCheck = false;
    else if (arg === '--no-logical') options.logicalCheck = false;
    else if (arg === '--source-port') options.sourcePort = Number(argv[++i]);
    else if (arg === '--restore-port') options.restorePort = Number(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  runDrill(parseDrillArgs(process.argv.slice(2))).then(
    (evidence) => { process.exitCode = evidence.drill.outcome === 'passed' ? 0 : 1; },
    (error: unknown) => {
      process.stderr.write(`drill failed: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

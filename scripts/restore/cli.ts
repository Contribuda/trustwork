import { privacyLedgerFromEnv } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import pg from 'pg';
import { blobStoreFromEnv } from '../../packages/data/src/files/config.js';
import { keyringFromEnv } from '../../infra/backup/src/crypto.js';
import { backupTargetFromEnv } from '../../infra/backup/src/target.js';
import { HbaFence, RoleFence, type RestoreFence } from './fence.js';
import { authorizeRestore, readReceiptJournal, reconcileRestore, resolveOutboxEvent } from './reconcile.js';
import { replayTombstones, restoreObjects, verifyDigests, verifySchema } from './recover.js';
import { destroyRestore, planRestore, restoreExec, stageRestore, startRestored, PGDATA, type RestoreProject } from './stage.js';

/**
 * Point-in-time restore runbook as commands (OPS-003; docs/operations/backup-and-restore.md). Run in this order:
 *
 *   plan -> restore -> verify -> replay-tombstones -> restore-objects -> reconcile -> (resolve-event)* -> authorize
 *
 * Backup target and keys come from the environment like infra/backup/cli.ts. RESTORE_DATABASE_URL is the operator's
 * login on the restored server (the migrator; never a runtime login, which the fence keeps out anyway).
 */
const USAGE = `Usage: node --import tsx scripts/restore/cli.ts <command> [options]
  plan [--target-time <iso>]
  restore --project <name> --volume <name> --port <n> [--target-time <iso>]   stage, fence and start (isolated project)
  verify                                     migration ledger vs shipped migrations, file digests
  replay-tombstones                          FILE-001 tombstone ledger (FILES_* configuration)
  restore-objects                            copy missing stored files back from the object backup
  reconcile --restore-id <id> --recovery-point <iso> --restore-started-at <iso> --receipts <jsonl>
            [--receipts-complete-through <iso>] --operator <label>
  resolve-event --restore-id <id> --event <id> --decision <delivered|relay> --reference <ref> --operator <label>
  fence --logins <a,b>                       NOLOGIN fence where pg_hba.conf cannot be edited (managed servers)
  authorize --restore-id <id> --reference <ref> --operator <label> (--project <name> --volume <name> | --logins <a,b>)
  destroy --project <name> --volume <name>   remove a drill or abandoned restore (never the live stack)`;

export interface CliIo { out(line: string): void; err(line: string): void }

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function required(argv: string[], name: string): string {
  const value = option(argv, name);
  if (!value) throw new UsageError(`${name} is required`);
  return value;
}
function date(value: string | undefined, name: string): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new UsageError(`${name} must be an ISO timestamp`);
  return parsed;
}
class UsageError extends Error {}

function project(argv: string[]): RestoreProject {
  const name = required(argv, '--project');
  const volume = required(argv, '--volume');
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(name)) throw new UsageError('invalid --project');
  // The development database (`trustwork-local`) and the documented full-stack project (`trustwork-stack`) are live.
  if (/^trustwork-(local|stack)$/.test(name)) throw new UsageError('refusing to use the live stack project');
  return { project: name, volume, port: Number(option(argv, '--port') ?? 54349) };
}

export async function runRestoreCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const admin = () => {
    if (!env.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL is required (operator login on the restored server)');
    return new pg.Pool({ connectionString: env.RESTORE_DATABASE_URL, max: 2, application_name: 'trustwork-restore' });
  };
  let pool: pg.Pool | null = null;
  try {
    switch (command) {
      case 'plan': {
        const plan = await planRestore(backupTargetFromEnv(env), keyringFromEnv(env), date(option(rest, '--target-time'), '--target-time'));
        io.out(JSON.stringify({ base: plan.base.id, finishedAt: plan.base.finishedAt, startWal: plan.base.pg?.startWal, walFiles: plan.wal.length, targetTime: plan.targetTime?.toISOString() ?? 'latest' }));
        return 0;
      }
      case 'restore': {
        const p = project(rest);
        const targetTime = date(option(rest, '--target-time'), '--target-time');
        const target = backupTargetFromEnv(env);
        const ring = keyringFromEnv(env);
        const startedAt = new Date();
        const plan = await planRestore(target, ring, targetTime);
        const staged = await stageRestore({ target, ring, plan, volume: p.volume, fence: true });
        const recovered = await startRestored(p, targetTime);
        io.out(JSON.stringify({ restoreStartedAt: startedAt.toISOString(), base: plan.base.id, staged, recoveryPoint: recovered.recoveryPoint?.toISOString() ?? null, fenced: true }));
        return 0;
      }
      case 'verify': {
        pool = admin();
        const schema = await verifySchema(pool);
        const storage = blobStoreFromEnv(env);
        const digests = storage ? await verifyDigests({ admin: pool, store: storage.store }) : null;
        io.out(JSON.stringify({ schema, digests }));
        return schema.ok && (!digests || digests.mismatched.length === 0) ? 0 : 1;
      }
      case 'replay-tombstones': {
        const storage = blobStoreFromEnv(env);
        if (!storage) throw new Error('FILES_STORAGE is not configured');
        if (!env.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL is required');
        const report = await replayTombstones({ adminUrl: env.RESTORE_DATABASE_URL, store: storage.store, tombstones: storage.tombstones });
        io.out(JSON.stringify(report));
        return report.invalid.length || report.held.length ? 1 : 0;
      }
      case 'restore-objects': {
        const storage = blobStoreFromEnv(env);
        if (!storage) throw new Error('FILES_STORAGE is not configured');
        pool = admin();
        const report = await restoreObjects({ admin: pool, store: storage.store, target: backupTargetFromEnv(env), ring: keyringFromEnv(env) });
        io.out(JSON.stringify(report));
        return report.missing.length ? 1 : 0;
      }
      case 'reconcile': {
        pool = admin();
        const journal = await readReceiptJournal(required(rest, '--receipts'), date(option(rest, '--receipts-complete-through'), '--receipts-complete-through'));
        const report = await reconcileRestore({
          admin: pool, restoreId: required(rest, '--restore-id'), operator: required(rest, '--operator'), journal,
          recoveryPoint: date(required(rest, '--recovery-point'), '--recovery-point') as Date,
          restoreStartedAt: date(required(rest, '--restore-started-at'), '--restore-started-at') as Date,
        });
        io.out(JSON.stringify(report));
        return 0;
      }
      case 'resolve-event': {
        pool = admin();
        const decision = required(rest, '--decision');
        if (decision !== 'delivered' && decision !== 'relay') throw new UsageError('--decision must be delivered or relay');
        await resolveOutboxEvent({ admin: pool, restoreId: required(rest, '--restore-id'), eventId: required(rest, '--event'), decision, reference: required(rest, '--reference'), operator: required(rest, '--operator') });
        io.out(JSON.stringify({ ok: true }));
        return 0;
      }
      case 'authorize': {
        pool = admin();
        let fence: RestoreFence;
        const logins = option(rest, '--logins');
        if (logins) fence = new RoleFence(pool, logins.split(','));
        else fence = new HbaFence(restoreExec(project(rest)), `${PGDATA}/pg_hba.conf`);
        const result = await authorizeRestore({ admin: pool, fence, restoreId: required(rest, '--restore-id'), reference: required(rest, '--reference'), operator: required(rest, '--operator'), privacyLedger: privacyLedgerFromEnv(env) });
        io.out(JSON.stringify(result));
        return 0;
      }
      case 'fence': {
        pool = admin();
        const fence = new RoleFence(pool, required(rest, '--logins').split(','));
        await fence.apply();
        io.out(JSON.stringify({ fenced: fence.describe() }));
        return 0;
      }
      case 'destroy': {
        await destroyRestore(project(rest));
        io.out(JSON.stringify({ ok: true }));
        return 0;
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    io.err(JSON.stringify({ error: (error as Error).message }));
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  runRestoreCli(process.argv.slice(2), process.env, { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then((code) => {
    process.exitCode = code;
  });
}

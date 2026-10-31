import { readFileSync } from 'node:fs';
import pg from 'pg';
import { blobStoreFromEnv } from '../../packages/data/src/files/config.js';
import { applyPrune, backupObjects, listManifests, listWal, planPrune, shipWal, takeBaseBackup, takeLogicalBackup } from './src/backup.js';
import { backupKeyFromEnv, keyringFromEnv } from './src/crypto.js';
import { pgExecFromEnv } from './src/pg.js';
import { parseRetentionPolicy, runRetention } from './src/retention.js';
import { backupTargetFromEnv } from './src/target.js';

/**
 * Backup operations (OPS-003). Configuration comes only from the environment (docs/operations/backup-and-restore.md):
 * BACKUP_TARGET and BACKUP_S3_* or BACKUP_FS_ROOT, BACKUP_ENCRYPTION_KEY (+ BACKUP_KEY_ID), BACKUP_PG_EXEC,
 * BACKUP_PG_USER, BACKUP_PG_DATABASE, BACKUP_NODE_ID; FILES_* for `objects`; RETENTION_DATABASE_URL for `retention`.
 * Output is one JSON document on stdout; errors are one JSON line on stderr without secrets.
 */
const USAGE = `Usage: node --import tsx infra/backup/cli.ts <command> [options]
  base                                 physical base backup (pg_basebackup), sealed into the target
  ship-wal [--loop <seconds>]          ship archived WAL from the spool (once, or every N seconds until stopped)
  logical                              logical dump (pg_dump -Fc), sealed into the target
  objects                              copy stored files (FILES_* storage) into the target, content-addressed
  list                                 manifests and WAL in the target
  prune --keep-days <n> [--apply]      backup retention: plan (default) or delete backups older than the window
  retention --policy <file> [--apply] [--operator <label>]
                                       audit/outbox partition retention within the hub policy (dry run by default)`;

export interface CliIo { out(line: string): void; err(line: string): void }

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Exit codes: 0 ok, 1 failure, 2 usage. */
export async function runBackupCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const nodeId = env.BACKUP_NODE_ID?.trim() || 'node';
  try {
    switch (command) {
      case 'base': {
        const result = await takeBaseBackup({ exec: pgExecFromEnv(env), target: backupTargetFromEnv(env), key: backupKeyFromEnv(env), nodeId });
        io.out(JSON.stringify(result.record));
        return 0;
      }
      case 'ship-wal': {
        const loop = option(rest, '--loop');
        const ctx = { exec: pgExecFromEnv(env), target: backupTargetFromEnv(env), key: backupKeyFromEnv(env), ring: keyringFromEnv(env) };
        if (!loop) {
          io.out(JSON.stringify(await shipWal(ctx)));
          return 0;
        }
        const seconds = Number(loop);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('--loop takes 1-3600 seconds');
        let stop = false;
        process.once('SIGTERM', () => { stop = true; });
        process.once('SIGINT', () => { stop = true; });
        while (!stop) {
          const report = await shipWal(ctx).catch((error: Error) => ({ error: error.message }));
          if ('error' in report || report.shipped.length) io.out(JSON.stringify({ at: new Date().toISOString(), ...report }));
          await new Promise((r) => setTimeout(r, seconds * 1000));
        }
        return 0;
      }
      case 'logical': {
        const result = await takeLogicalBackup({ exec: pgExecFromEnv(env), target: backupTargetFromEnv(env), key: backupKeyFromEnv(env), nodeId });
        io.out(JSON.stringify(result.record));
        return 0;
      }
      case 'objects': {
        const storage = blobStoreFromEnv(env);
        if (!storage) throw new Error('FILES_STORAGE is not configured');
        const result = await backupObjects({ target: backupTargetFromEnv(env), key: backupKeyFromEnv(env), nodeId, source: storage.store, excludePrefixes: ['tombstones/'] });
        io.out(JSON.stringify(result.record));
        return 0;
      }
      case 'list': {
        const target = backupTargetFromEnv(env);
        const ring = keyringFromEnv(env);
        const summary = async (format: 'physical' | 'logical' | 'objects') => (await listManifests(target, ring, format)).map((m) => ({ id: m.id, finishedAt: m.finishedAt, bytes: m.totalBytes, keyId: m.keyId, startWal: m.pg?.startWal }));
        io.out(JSON.stringify({ physical: await summary('physical'), logical: await summary('logical'), objects: await summary('objects'), wal: await listWal(target) }));
        return 0;
      }
      case 'prune': {
        const keepDays = Number(option(rest, '--keep-days'));
        if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error('--keep-days must be a positive integer');
        const target = backupTargetFromEnv(env);
        const ring = keyringFromEnv(env);
        const [physical, logical, objects, wal] = await Promise.all([listManifests(target, ring, 'physical'), listManifests(target, ring, 'logical'), listManifests(target, ring, 'objects'), listWal(target)]);
        const plan = planPrune({ now: new Date(), keepDays, physical, logical, objects, wal });
        const keptObjects = objects.filter((m) => plan.keep.includes(`objects/${m.id}/manifest.json`));
        const removed = rest.includes('--apply') ? await applyPrune(target, plan, keptObjects) : 0;
        io.out(JSON.stringify({ applied: rest.includes('--apply'), keep: plan.keep.length, remove: plan.remove, removed }));
        return 0;
      }
      case 'retention': {
        const file = option(rest, '--policy');
        if (!file) {
          io.err(USAGE);
          return 2;
        }
        if (!env.RETENTION_DATABASE_URL) throw new Error('RETENTION_DATABASE_URL is required (a login that may SET ROLE trustwork_owner, for example the migrator)');
        const policy = parseRetentionPolicy(JSON.parse(readFileSync(file, 'utf8')));
        const apply = rest.includes('--apply');
        const client = new pg.Client({ connectionString: env.RETENTION_DATABASE_URL, application_name: 'trustwork-retention' });
        await client.connect();
        try {
          const result = await runRetention({ client, policy, now: new Date(), apply, operator: option(rest, '--operator') ?? 'retention-cli', ...(apply ? { target: backupTargetFromEnv(env), key: backupKeyFromEnv(env) } : {}) });
          io.out(JSON.stringify({ applied: apply, removed: result.removed, kept: result.kept, decisions: result.plan.decisions.map((d) => ({ partition: d.partition.name, action: d.action, ...(d.action === 'keep' ? { reason: d.reason } : { rows: d.rows }) })) }));
        } finally {
          await client.end();
        }
        return 0;
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(JSON.stringify({ error: (error as Error).message }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  runBackupCli(process.argv.slice(2), process.env, { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then((code) => {
    process.exitCode = code;
  });
}

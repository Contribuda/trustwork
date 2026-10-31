import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { listManifests, listWal, readParts, type BackupManifest } from '../../infra/backup/src/backup.js';
import { getSealed, type BackupTarget } from '../../infra/backup/src/target.js';
import { PgExec, composeExecPrefix } from '../../infra/backup/src/pg.js';
import type { Keyring } from '../../infra/backup/src/crypto.js';
import { hbaFenceBlock } from './fence.js';

/**
 * Point-in-time restore into an isolated compose project (OPS-003): choose the base backup, stage the data directory
 * and the WAL to replay into a fresh Docker volume (decrypting on the host, never writing plaintext to disk outside
 * the volume), verify the base backup against its manifest (pg_verifybackup), write recovery.signal and the restore
 * fence, then start PostgreSQL with infra/backup/compose.restore.yaml and wait until recovery has promoted.
 */
export const RESTORE_COMPOSE = resolve('infra/backup/compose.restore.yaml');
export const PG_IMAGE = 'postgres:18.3';
export const PGDATA = '/var/lib/postgresql/18/docker';
export const WAL_RESTORE = '/var/lib/postgresql/wal-restore';

export interface RestorePlan {
  base: BackupManifest;
  wal: string[];
  targetTime: Date | null;
}

/**
 * The newest physical backup that finished at or before the target (or the newest at all for "latest"), and every
 * archived WAL file from its start onward (plus timeline history files).
 */
export async function planRestore(target: BackupTarget, ring: Keyring, targetTime: Date | null): Promise<RestorePlan> {
  const bases = (await listManifests(target, ring, 'physical')).filter((m) => targetTime === null || Date.parse(m.finishedAt) <= targetTime.getTime());
  const base = bases.at(-1);
  if (!base?.pg) throw new Error(targetTime ? `no base backup finished before ${targetTime.toISOString()}` : 'no base backup in the target');
  const startWal = base.pg.startWal;
  const wal = (await listWal(target)).filter((name) => name.endsWith('.history') || name >= startWal);
  return { base, wal, targetTime };
}

function run(command: string, args: string[], options: { input?: (stdin: Writable) => Promise<void>; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...options.env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out = (out + c.toString()).slice(-20_000); });
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-8000); });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolveRun(out) : reject(new Error(`${command} ${args.slice(0, 3).join(' ')} exited with ${code}: ${err.trim().slice(-800)}`))));
    child.stdin.on('error', () => undefined);
    if (options.input) options.input(child.stdin).then(() => child.stdin.end(), (error: unknown) => { child.kill(); reject(error as Error); });
    else child.stdin.end();
  });
}

function write(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    if (stream.write(chunk)) return resolveWrite();
    stream.once('drain', resolveWrite);
    stream.once('error', reject);
  });
}

/** Minimal ustar header for one regular file (names up to 100 bytes; WAL names are 24). */
export function tarHeader(name: string, size: number, mode = 0o600): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error('tar entry name too long');
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

export interface StageReport { volume: string; baseBytes: number; walFiles: number; verified: string }

/** Creates the volume and fills it; refuses an existing volume (a restore never overwrites anything). */
export async function stageRestore(input: { target: BackupTarget; ring: Keyring; plan: RestorePlan; volume: string; fence: boolean; image?: string }): Promise<StageReport> {
  const image = input.image ?? PG_IMAGE;
  if (!/^[a-z0-9][a-z0-9_.-]{1,62}$/.test(input.volume)) throw new Error('invalid volume name');
  const existing = await run('docker', ['volume', 'ls', '-q', '--filter', `name=^${input.volume}$`]);
  if (existing.trim()) throw new Error(`volume ${input.volume} already exists; a restore never reuses a volume`);
  await run('docker', ['volume', 'create', '--label', 'org.trustwork.purpose=restore', input.volume]);
  const mount = `${input.volume}:/var/lib/postgresql`;
  // 1. The base backup tar, decrypted part by part straight into tar -x inside the volume.
  let baseBytes = 0;
  await run('docker', ['run', '--rm', '-i', '--network', 'none', '-v', mount, image, 'sh', '-c', `set -e; mkdir -p ${PGDATA}; tar -x -C ${PGDATA}`], {
    input: async (stdin) => {
      baseBytes = await readParts(input.target, input.ring, input.plan.base, (part) => write(stdin, part));
    },
  });
  // 2. The WAL to replay, as a tar stream of decrypted files.
  await run('docker', ['run', '--rm', '-i', '--network', 'none', '-v', mount, image, 'sh', '-c', `set -e; mkdir -p ${WAL_RESTORE}; tar -x -C ${WAL_RESTORE}`], {
    input: async (stdin) => {
      for (const name of input.plan.wal) {
        const body = await getSealed(input.target, input.ring, `wal/${name}`);
        if (!body) throw new Error(`WAL file missing from the target: ${name}`);
        await write(stdin, tarHeader(name, body.length));
        await write(stdin, body);
        const pad = (512 - (body.length % 512)) % 512;
        if (pad) await write(stdin, Buffer.alloc(pad));
      }
      await write(stdin, Buffer.alloc(1024));
    },
  });
  // 3. Verify, then recovery.signal, the fence, ownership. pg_verifybackup checks every file against backup_manifest
  //    (sizes and checksums); WAL parsing is skipped (-n) because replay verifies WAL records itself.
  const fence = input.fence ? hbaFenceBlock() : '';
  const script = [
    'set -e',
    `chown -R postgres:postgres /var/lib/postgresql && chmod 700 ${PGDATA}`,
    `gosu postgres pg_verifybackup -n -q -m ${PGDATA}/backup_manifest ${PGDATA}`,
    `rm -f ${PGDATA}/backup_manifest ${PGDATA}/postmaster.pid`,
    `touch ${PGDATA}/recovery.signal`,
    `if [ -n "$FENCE" ]; then printf '%s' "$FENCE" | cat - ${PGDATA}/pg_hba.conf > ${PGDATA}/pg_hba.conf.new && mv ${PGDATA}/pg_hba.conf.new ${PGDATA}/pg_hba.conf; fi`,
    `chown -R postgres:postgres /var/lib/postgresql && chmod 600 ${PGDATA}/pg_hba.conf`,
    'echo verified',
  ].join('\n');
  const verified = (await run('docker', ['run', '--rm', '--network', 'none', '-e', `FENCE=${fence}`, '-v', mount, image, 'sh', '-c', script])).trim();
  return { volume: input.volume, baseBytes, walFiles: input.plan.wal.length, verified };
}

export interface RestoreProject { project: string; volume: string; port: number }

function composeEnv(p: RestoreProject, targetTime: Date | null): NodeJS.ProcessEnv {
  return {
    TRUSTWORK_RESTORE_VOLUME: p.volume,
    TRUSTWORK_RESTORE_PG_PORT: String(p.port),
    TRUSTWORK_RESTORE_TARGET_TIME: targetTime ? targetTime.toISOString().replace('T', ' ').replace('Z', '+00') : '',
  };
}

/** Exec into the restored database container as the postgres OS user (file edits keep their ownership). */
export function restoreExec(p: RestoreProject, user = 'trustwork_dev', database = 'trustwork_stack'): PgExec {
  const prefix = composeExecPrefix(p.project, [RESTORE_COMPOSE]);
  prefix.splice(prefix.length - 1, 0, '-u', 'postgres');
  return new PgExec({ prefix: ['env', `TRUSTWORK_RESTORE_VOLUME=${p.volume}`, ...prefix], user, database, walSpool: '/var/lib/postgresql/wal-spool' });
}

/** Starts the restored server and waits until recovery has finished and the server is promoted. */
export async function startRestored(p: RestoreProject, targetTime: Date | null, timeoutMs = 600_000): Promise<{ recoveryPoint: Date | null }> {
  await run('docker', ['compose', '-p', p.project, '-f', RESTORE_COMPOSE, 'up', '-d', '--wait', 'postgres'], { env: composeEnv(p, targetTime) });
  const exec = restoreExec(p, 'trustwork_dev', 'postgres');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await exec.psql("SELECT pg_is_in_recovery()::text || '|' || coalesce(pg_last_xact_replay_timestamp()::text, '')").catch(() => 'error|');
    const [inRecovery, replayed] = state.split('|') as [string, string];
    if (inRecovery === 'false') return { recoveryPoint: replayed ? new Date(replayed.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : null };
    if (Date.now() > deadline) throw new Error('restored server did not finish recovery in time');
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function composeRestore(p: RestoreProject, args: string[], targetTime: Date | null = null): Promise<string> {
  return run('docker', ['compose', '-p', p.project, '-f', RESTORE_COMPOSE, ...args], { env: composeEnv(p, targetTime) });
}

/** Removes the restore project and its volume (drill-owned resources only). */
export async function destroyRestore(p: RestoreProject): Promise<void> {
  await composeRestore(p, ['--profile', 'worker', 'down', '--remove-orphans']).catch(() => undefined);
  await run('docker', ['volume', 'rm', '-f', p.volume]).catch(() => undefined);
}

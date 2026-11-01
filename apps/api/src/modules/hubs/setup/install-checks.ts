import { randomUUID } from 'node:crypto';
import type { BlobStore } from '../../../../../../packages/data/src/files/blob-store.js';
import type { DataPool } from '../../../deps/data.js';
import { DEVELOPMENT_SECOND_FACTOR_KEY } from '../../identity/second-factor/secrets.js';
import { CLOCK_SKEW_WARN_MS, type InstallCheck } from './deps.js';

/** What the install check needs to know about this process (setup-wizard.md, step 1). */
export interface InstallCheckOptions {
  publicOrigin: string;
  production: boolean;
  /** FILE-001's blob store, or null when no object storage is configured. */
  objectStore: BlobStore | null;
  secondFactorKey: Buffer;
  /**
   * The last worker heartbeat, or null when none was seen. Until the worker publishes one (an operations follow-up)
   * the check reports a warning it cannot confirm instead of a pass.
   */
  workerHeartbeat?: () => Promise<Date | null>;
}

const check = (id: InstallCheck['id'], state: InstallCheck['state'], reason: string | null = null): InstallCheck => ({ id, state, reason });

/**
 * The six install checks. Blocking (`fail`): a public address that is neither HTTPS nor localhost, a runtime role that
 * can bypass row-level security, a failing object-storage probe, the public development secret key in production.
 * Warnings: no object storage configured, no worker heartbeat source, clock skew above 30 seconds, the development key
 * outside production. Nothing here contacts anything outside the node.
 */
export async function runInstallChecks(pool: DataPool, options: InstallCheckOptions, now: Date, clientTime: Date | null): Promise<InstallCheck[]> {
  const out: InstallCheck[] = [];

  let origin: URL | null = null;
  try {
    origin = new URL(options.publicOrigin);
  } catch {
    origin = null;
  }
  const local = origin !== null && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  out.push(origin && (origin.protocol === 'https:' || local) ? check('address', 'pass', local && origin.protocol !== 'https:' ? 'localhost_trial' : null) : check('address', 'fail', 'https_required'));

  try {
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    const role = rows[0];
    out.push(!role ? check('database', 'fail', 'role_unknown') : role.rolsuper || role.rolbypassrls ? check('database', 'fail', 'runtime_role_bypasses_rls') : check('database', 'pass'));
  } catch {
    out.push(check('database', 'fail', 'unreachable'));
  }

  if (!options.objectStore) out.push(check('object_storage', 'warn', 'not_configured'));
  else {
    const key = `setup-check/${randomUUID()}.txt`;
    try {
      const body = new TextEncoder().encode('trustwork setup check');
      await options.objectStore.put(key, body, 'text/plain');
      const read = await options.objectStore.read(key, 1024);
      await options.objectStore.delete(key);
      out.push(read && read.length === body.length ? check('object_storage', 'pass') : check('object_storage', 'fail', 'probe_failed'));
    } catch {
      await options.objectStore.delete(key).catch(() => undefined);
      out.push(check('object_storage', 'fail', 'probe_failed'));
    }
  }

  const heartbeat = options.workerHeartbeat ? await options.workerHeartbeat().catch(() => null) : undefined;
  if (heartbeat === undefined) out.push(check('worker', 'warn', 'no_heartbeat_source'));
  else out.push(heartbeat && now.getTime() - heartbeat.getTime() <= 60_000 ? check('worker', 'pass') : check('worker', 'warn', 'no_recent_heartbeat'));

  if (clientTime === null) out.push(check('clock', 'warn', 'not_measured'));
  else out.push(Math.abs(now.getTime() - clientTime.getTime()) > CLOCK_SKEW_WARN_MS ? check('clock', 'warn', 'clock_skew') : check('clock', 'pass'));

  const development = options.secondFactorKey.equals(DEVELOPMENT_SECOND_FACTOR_KEY);
  out.push(development ? check('secret_store', options.production ? 'fail' : 'warn', 'development_key') : check('secret_store', 'pass'));
  return out;
}

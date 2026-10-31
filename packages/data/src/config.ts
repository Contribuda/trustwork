import type { PoolConfig } from 'pg';

/** Schema that holds every table, function and policy of this package. */
export const SCHEMA = 'trustwork';
/** Owner of every object; migrations run as this role through SET ROLE. NOLOGIN. */
export const OWNER_ROLE = 'trustwork_owner';
/** Restricted runtime role (no superuser, no BYPASSRLS, not an owner). Login roles are members of it. */
export const APP_ROLE = 'trustwork_app';
/**
 * Restricted worker role (REL-001): outbox relay, job runner and scheduler. NOLOGIN; the worker logs in with a
 * member role. Not a member of trustwork_app, so it has no grant on any party table.
 */
export const WORKER_ROLE = 'trustwork_worker';

export interface DatabaseEnv {
  DATABASE_URL?: string | undefined;
  TRUSTWORK_DATABASE_HOST?: string | undefined;
  TRUSTWORK_DATABASE_PORT?: string | undefined;
  TRUSTWORK_DATABASE_NAME?: string | undefined;
  TRUSTWORK_DATABASE_USER?: string | undefined;
  TRUSTWORK_DATABASE_PASSWORD?: string | undefined;
}

/**
 * Builds the pg connection options from explicit environment values. Nothing is read from `.env`;
 * callers pass `process.env` (or a test object) on purpose. Both the URL form and the split
 * `TRUSTWORK_DATABASE_*` form are accepted; the split form wins when both are present.
 */
export function databaseConfigFromEnv(env: DatabaseEnv, applicationName = 'trustwork'): PoolConfig {
  const base: PoolConfig = { application_name: applicationName, options: `-c search_path=${SCHEMA},pg_temp` };
  if (env.TRUSTWORK_DATABASE_HOST) {
    const port = env.TRUSTWORK_DATABASE_PORT ? Number(env.TRUSTWORK_DATABASE_PORT) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TRUSTWORK_DATABASE_PORT must be an integer port');
    if (!env.TRUSTWORK_DATABASE_NAME || !env.TRUSTWORK_DATABASE_USER) throw new Error('TRUSTWORK_DATABASE_NAME and TRUSTWORK_DATABASE_USER are required with TRUSTWORK_DATABASE_HOST');
    return { ...base, host: env.TRUSTWORK_DATABASE_HOST, port, database: env.TRUSTWORK_DATABASE_NAME, user: env.TRUSTWORK_DATABASE_USER, ...(env.TRUSTWORK_DATABASE_PASSWORD === undefined ? {} : { password: env.TRUSTWORK_DATABASE_PASSWORD }) };
  }
  if (env.DATABASE_URL) return { ...base, connectionString: env.DATABASE_URL };
  throw new Error('No database configured: set DATABASE_URL or TRUSTWORK_DATABASE_HOST/PORT/NAME/USER/PASSWORD (the .env file is never loaded implicitly)');
}

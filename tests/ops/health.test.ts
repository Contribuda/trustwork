import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createPool, type DataPool } from '@trustwork/data';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from '@trustwork/data/migrate';
import { HealthSchema, ReadinessSchema } from '@trustwork/contracts';
import { createApp } from '../../apps/api/src/app.js';
import { createReadinessProbe, discoverMigrationsDir } from '../../apps/api/src/observability/health.js';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { failingPool } from './helpers.js';

const FILES = loadMigrations(DEFAULT_MIGRATIONS_DIR);
const LATEST = FILES.at(-1)!.filename;
/** Path of a shipped migration inside a copy of the directory (root files and module directories). */
const inCopy = (dir: string, index: number) => join(dir, relative(DEFAULT_MIGRATIONS_DIR, FILES.at(index)!.path));

function migrationsCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-ready-'));
  cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

test('the migrations directory is discovered next to the sources', () => {
  assert.equal(discoverMigrationsDir(), DEFAULT_MIGRATIONS_DIR);
});

test('liveness never touches the database; readiness fails without a configured database', async () => {
  const created = await createApp({ env: { AUTH_PROVIDER_MODE: 'fake' }, logSink: () => undefined });
  try {
    const live = await created.fastify.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok', mode: 'bootstrap', externalProviders: 'fake' });
    assert.ok(HealthSchema.safeParse(live.json()).success, 'the provider mode is part of the contract');
    const legacy = await created.fastify.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(legacy.json(), live.json());
    const ready = await created.fastify.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.headers['cache-control'], 'no-store');
    assert.deepEqual(ready.json(), { status: 'not_ready', checks: { database: 'not_configured', ledger: 'not_checked' }, schemaVersion: null, expectedSchemaVersion: LATEST });
    assert.ok(ReadinessSchema.safeParse(ready.json()).success);
  } finally {
    await created.close();
  }
});

test('readiness fails when the database is unreachable (closed port) and liveness stays green', async () => {
  const unreachable = createPool({ host: '127.0.0.1', port: 1, database: 'none', user: 'none', password: 'x', connectionTimeoutMillis: 1_000 });
  const created = await createApp({ pool: unreachable, logSink: () => undefined });
  try {
    const ready = await created.fastify.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json().checks, { database: 'unreachable', ledger: 'not_checked' });
    assert.ok(!ready.body.includes('ECONNREFUSED'), 'no error text in the body');
    assert.equal((await created.fastify.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
  } finally {
    await created.close();
    await unreachable.end();
  }
});

test('a hanging database fails readiness within the timeout; concurrent probes share one check', async () => {
  let connects = 0;
  const hanging = { connect: () => { connects += 1; return new Promise(() => undefined); }, query: () => new Promise(() => undefined), on() { return this; }, end: async () => undefined } as unknown as DataPool;
  const probe = createReadinessProbe({ pool: hanging, migrationsDir: DEFAULT_MIGRATIONS_DIR, timeoutMs: 150 });
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 25 }, () => probe()));
  assert.ok(Date.now() - started < 2_000, 'bounded by the readiness timeout');
  assert.equal(connects, 1, 'one in-flight check for 25 concurrent probes');
  for (const r of results) {
    assert.equal(r.ready, false);
    assert.deepEqual(r.body.checks, { database: 'timeout', ledger: 'not_checked' });
  }
  const failing = createReadinessProbe({ pool: failingPool(), migrationsDir: DEFAULT_MIGRATIONS_DIR, timeoutMs: 1_000 });
  assert.equal((await failing()).body.checks.database, 'unreachable');
});

const h = await startHarness('ops_health');
test('readiness against real PostgreSQL with the restricted runtime role', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const dirs: string[] = [];
  t.after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const probeFor = (dir: string) => createReadinessProbe({ pool: h.pool, migrationsDir: dir, timeoutMs: 5_000 });

  await t.test('ready: database answers and every applied checksum matches this build', async () => {
    const r = await h.client().get('/health/ready');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: 'ready', checks: { database: 'ok', ledger: 'ok' }, schemaVersion: LATEST, expectedSchemaVersion: LATEST });
    const role = await h.pool.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    assert.equal(role.rows[0]!.rolsuper, false, 'probed with the runtime login, not a superuser');
  });

  await t.test('not ready: the ledger has a checksum mismatch', async () => {
    const dir = migrationsCopy();
    dirs.push(dir);
    appendFileSync(inCopy(dir, -1), '\n-- edited after it was applied\n');
    const r = await probeFor(dir)();
    assert.equal(r.ready, false);
    assert.equal(r.body.status, 'not_ready');
    assert.equal(r.body.checks.ledger, 'checksum_mismatch');
    // Through HTTP with the app configured to verify against the edited directory.
    const created = await createApp({ env: { PUBLIC_ORIGIN: 'https://trustwork.test' }, pool: h.pool, config: { readiness: { timeoutMs: 5_000, migrationsDir: dir } }, logSink: () => undefined });
    try {
      const http = await created.fastify.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(http.statusCode, 503);
      assert.equal(http.json().checks.ledger, 'checksum_mismatch');
    } finally {
      await created.close();
    }
  });

  await t.test('not ready: this build expects a migration that is not applied (schema behind)', async () => {
    const dir = migrationsCopy();
    dirs.push(dir);
    writeFileSync(join(dir, '20991231000000_future_change.sql'), 'SELECT 1;\n');
    const r = await probeFor(dir)();
    assert.equal(r.ready, false);
    assert.equal(r.body.checks.ledger, 'pending');
    assert.equal(r.body.expectedSchemaVersion, '20991231000000_future_change.sql');
    assert.equal(r.body.schemaVersion, LATEST);
  });

  await t.test('not ready: an applied migration is missing from this build (not a newer release)', async () => {
    const dir = migrationsCopy();
    dirs.push(dir);
    unlinkSync(inCopy(dir, 0));
    assert.equal((await probeFor(dir)()).body.checks.ledger, 'missing');
  });

  await t.test('ready: the ledger is ahead of this build (rolling deploy, expand/contract)', async () => {
    const dir = migrationsCopy();
    dirs.push(dir);
    unlinkSync(inCopy(dir, -1));
    const r = await probeFor(dir)();
    assert.equal(r.ready, true);
    assert.equal(r.body.checks.ledger, 'schema_ahead');
  });

  await t.test('the runtime role can read but never change the ledger', async () => {
    await assert.rejects(h.pool.query("DELETE FROM trustwork.migration_ledger WHERE filename = 'x'"), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(h.pool.query("UPDATE trustwork.migration_ledger SET checksum = checksum"), (e: { code?: string }) => e.code === '42501');
  });
});

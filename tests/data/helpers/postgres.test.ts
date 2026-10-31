import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import {
  acquireTestSlot, CONNECTION_HEADROOM, CONNECTIONS_PER_FILE, connectWithRetry, databaseLabel, postgresRequired, provisionTestDatabase,
  SKIP_REASON, slotCount, sqlState, STALE_AFTER_MS, staleNames, stamp, untilDatabaseTimePasses,
} from './postgres.js';

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('TRUSTWORK_REQUIRE_PG=1 turns a missing database into a failure instead of a skip', async () => {
  assert.equal(postgresRequired({ TRUSTWORK_REQUIRE_PG: '1' }), true);
  assert.equal(postgresRequired({ TRUSTWORK_REQUIRE_PG: 'true' }), false, 'only the documented value enables the gate');
  assert.equal(postgresRequired({}), false);
  await withEnv({ TRUSTWORK_TEST_PG_BACKEND: 'none', TRUSTWORK_REQUIRE_PG: undefined }, async () => {
    assert.equal(await provisionTestDatabase('required'), null, 'without the gate the caller skips');
  });
  await withEnv({ TRUSTWORK_TEST_PG_BACKEND: 'none', TRUSTWORK_REQUIRE_PG: '1' }, async () => {
    await assert.rejects(provisionTestDatabase('required'), /TRUSTWORK_REQUIRE_PG=1 but no PostgreSQL/);
  });
  // CI forces the external backend; losing the URL must not fall back to Docker or an embedded server.
  await withEnv({ TRUSTWORK_TEST_PG_BACKEND: 'external', TRUSTWORK_TEST_DATABASE_URL: undefined, TRUSTWORK_REQUIRE_PG: '1' }, async () => {
    await assert.rejects(provisionTestDatabase('required'), /TRUSTWORK_REQUIRE_PG=1/);
  });
  assert.match(SKIP_REASON, /^SKIPPED: no PostgreSQL/);
});

test('an unreachable database server fails at once instead of being retried as "busy"', async () => {
  const port = await new Promise<number>((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
  const started = Date.now();
  await assert.rejects(connectWithRetry(`postgresql://nobody:nothing@127.0.0.1:${port}/none`), (error: Error & { code?: string }) => error.code === 'ECONNREFUSED');
  assert.ok(Date.now() - started < 2_000, 'no backoff for a refused connection');
  await withEnv({ TRUSTWORK_TEST_PG_BACKEND: 'external', TRUSTWORK_TEST_DATABASE_URL: `postgresql://nobody:nothing@127.0.0.1:${port}/none`, TRUSTWORK_REQUIRE_PG: '1' }, async () => {
    await assert.rejects(provisionTestDatabase('removed'), /ECONNREFUSED/, 'a removed CI database service fails the suite');
  });
});

test('slot count derives from max_connections with headroom, or from TRUSTWORK_TEST_PG_SLOTS', () => {
  assert.equal(slotCount(97, undefined), Math.floor((97 - CONNECTION_HEADROOM) / CONNECTIONS_PER_FILE));
  assert.equal(slotCount(5, undefined), 1, 'a tiny cluster still runs one file at a time');
  assert.equal(slotCount(97, '3'), 3);
  assert.equal(slotCount(97, ''), slotCount(97, undefined));
  assert.throws(() => slotCount(97, '0'), /positive integer/);
  assert.throws(() => slotCount(97, 'many'), /positive integer/);
});

test('only stamped names older than the stale window are reaped; unstamped names are never touched', () => {
  const now = Date.UTC(2026, 9, 31, 12);
  const old = stamp(now - STALE_AFTER_MS - 60_000);
  const fresh = stamp(now - 60_000);
  const pattern = /^trustwork_test_[a-z0-9_]+_([0-9a-z]{6,8})_[0-9a-f]{8}$/;
  const names = [`trustwork_test_access_${old}_0a1b2c3d`, `trustwork_test_access_${fresh}_0a1b2c3d`, 'trustwork_test_access_0a1b2c3d', `trustwork_test_two_part_${old}_ffffffff`, 'trustwork_dev'];
  assert.deepEqual(staleNames(names, pattern, now), [`trustwork_test_access_${old}_0a1b2c3d`, `trustwork_test_two_part_${old}_ffffffff`]);
  assert.equal(databaseLabel('Auth-Z'), 'auth_z');
  assert.throws(() => databaseLabel('--'), /letters or digits/);
});

const db = await provisionTestDatabase('helpers');

test('cluster test slots, busy-connection retry and stale reaping against real PostgreSQL', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  // Advisory locks are per database: using the per-file database keeps these slots apart from the real ones.
  const url = db.adminConfig.connectionString as string;

  await t.test('two slots admit two holders; a third waits and times out with an explicit message', async () => {
    const a = await acquireTestSlot(url, 'a', { slots: 2 });
    const b = await acquireTestSlot(url, 'b', { slots: 2 });
    try {
      assert.notEqual(a.slot, b.slot);
      await assert.rejects(acquireTestSlot(url, 'c', { slots: 2, timeoutMs: 400 }), /no free test slot among 2/);
    } finally {
      await a.release();
      await b.release();
    }
  });

  await t.test('a waiting file starts as soon as a holder releases', async () => {
    const a = await acquireTestSlot(url, 'a', { slots: 1 });
    const waiting = acquireTestSlot(url, 'b', { slots: 1, timeoutMs: 10_000 });
    let settled = false;
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, 'the second file waits while the only slot is held');
    await a.release();
    const b = await waiting;
    assert.equal(b.slot, 0);
    await b.release();
    await a.release();
  });

  await t.test('a killed holder (connection gone) frees its slot without cleanup code running', async () => {
    const a = await acquireTestSlot(url, 'a', { slots: 1 });
    const killed = await db.admin.query<{ n: number }>(
      "SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND pid <> pg_backend_pid()",
    );
    assert.equal(killed.rows[0]?.n, 1);
    const b = await acquireTestSlot(url, 'b', { slots: 1, timeoutMs: 10_000 });
    await b.release();
    await a.release();
  });

  await t.test('"too many connections" is retried until a connection frees up', async () => {
    const role = `trustwork_conn_limit_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(8).toString('hex');
    await db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' CONNECTION LIMIT 1`);
    const parsed = new URL(url);
    const config: pg.ClientConfig = { host: parsed.hostname, port: Number(parsed.port || 5432), database: db.databaseName, user: role, password };
    try {
      const first = new pg.Client(config);
      await first.connect();
      const direct = new pg.Client(config);
      await assert.rejects(direct.connect(), (error) => sqlState(error) === '53300');
      await direct.end().catch(() => undefined);
      const retried = connectWithRetry(config);
      setTimeout(() => void first.end(), 400);
      const second = await retried;
      assert.equal((await second.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u, role);
      await second.end();
    } finally {
      await db.admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  await t.test('waiting for the database clock: returns once now() passed the instant, fails after the timeout', async () => {
    const at = new Date(Date.now() + 150);
    await untilDatabaseTimePasses(db.admin, at);
    const { rows } = await db.admin.query<{ passed: boolean }>('SELECT now() > $1::timestamptz AS passed', [at.toISOString()]);
    assert.equal(rows[0]?.passed, true, 'a transaction started afterwards sees the instant as past');
    await assert.rejects(untilDatabaseTimePasses(db.admin, new Date(Date.now() + 3_600_000), 50), /did not pass/);
  });

  await t.test('stamped test databases older than the stale window are dropped by the next file; fresh ones stay', async () => {
    const maintenance = await connectWithRetry(db.clusterUrl);
    const hex = randomBytes(4).toString('hex');
    const stale = `trustwork_test_reaper_${stamp(Date.now() - STALE_AFTER_MS - 60_000)}_${hex}`;
    const fresh = `trustwork_test_reaper_${stamp()}_${hex}`;
    try {
      await maintenance.query(`CREATE DATABASE ${stale}`);
      await maintenance.query(`CREATE DATABASE ${fresh}`);
      const next = await provisionTestDatabase('reaper');
      assert.ok(next);
      await next.close();
      const left = (await maintenance.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [[stale, fresh]])).rows.map((r) => r.datname);
      assert.deepEqual(left, [fresh]);
    } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS ${stale}`).catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS ${fresh}`).catch(() => undefined);
      await maintenance.end();
    }
  });
});

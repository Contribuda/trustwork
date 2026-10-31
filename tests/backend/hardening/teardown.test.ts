import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { endPool, isConnectionTermination, provisionTestDatabase, SKIP_REASON, TeardownGuard } from '../../data/helpers/postgres.js';

const db = await provisionTestDatabase('hardening_teardown');

/**
 * Test teardown on real PostgreSQL (CI failure on PR #282, lockout burst; once on PR #183, privileges). pg-pool's
 * end() resolves while its clients are still closing their sockets; the database drop that follows terminated them
 * ("terminating connection due to administrator command"), and the idle client's error became an uncaughtException
 * after the test had ended. endPool waits for every connection to close, TestDatabase.close waits until no session is
 * left before dropping, and TeardownGuard tolerates terminations only once teardown has begun.
 */
test('teardown closes every pooled connection before the drop and tolerates terminations only during teardown', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  const sessions = async (applicationName: string) =>
    (await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1', [applicationName])).rows[0]?.n ?? 0;
  const until = async (predicate: () => boolean | Promise<boolean>, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** A pool with `size` open idle connections, as a parallel burst leaves it. */
  const burstPool = async (applicationName: string, size: number, guard?: TeardownGuard) => {
    const pool = new pg.Pool({ ...db.adminConfig, application_name: applicationName, max: size });
    guard?.watch(pool);
    const clients = await Promise.all(Array.from({ length: size }, () => pool.connect()));
    await Promise.all(clients.map((client) => client.query('SELECT 1')));
    for (const client of clients) client.release();
    assert.equal(await sessions(applicationName), size);
    return pool;
  };

  await t.test('endPool resolves only after every connection of a burst-sized pool is closed', async () => {
    for (let round = 0; round < 5; round++) {
      const name = `teardown-burst-${round}`;
      const pool = await burstPool(name, 8);
      await endPool(pool);
      assert.equal(await sessions(name), 0, 'no session of the pool is left for the drop to terminate');
      await endPool(pool); // a second call is a no-op
    }
  });

  await t.test('during the test a terminated idle connection still surfaces as an error', async () => {
    const surfaced: Error[] = [];
    const guard = new TeardownGuard((error) => surfaced.push(error));
    const pool = await burstPool('teardown-during-test', 2, guard);
    await db.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'teardown-during-test'");
    await until(() => surfaced.length >= 1, 'the termination to surface');
    assert.ok(surfaced.every(isConnectionTermination), surfaced.map((e) => e.message).join('; '));
    await endPool(pool);
  });

  await t.test('after teardown began terminations are ignored, other pool errors still surface', async () => {
    const surfaced: Error[] = [];
    const guard = new TeardownGuard((error) => surfaced.push(error));
    const pool = await burstPool('teardown-closing', 2, guard);
    guard.begin();
    await db.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'teardown-closing'");
    await until(async () => (await sessions('teardown-closing')) === 0 && pool.totalCount === 0, 'the terminated clients to leave the pool');
    assert.deepEqual(surfaced, [], 'terminations during teardown are tolerated');
    pool.emit('error', new Error('unrelated failure'));
    assert.equal(surfaced.length, 1, 'only terminations are tolerated');
    await endPool(pool);
  });
});

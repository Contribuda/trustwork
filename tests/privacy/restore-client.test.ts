import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { withDrillOwnerTransaction } from '../../scripts/restore/drill.js';
import { provisionWorkerDatabase, gate, waitFor } from '../worker/helpers/worker-db.js';

test('OPS-003 intentional primary loss stays an awaited transaction failure, never an uncaught client error', async (t) => {
  const available = await provisionWorkerDatabase('privacy_restore_client');
  assert.ok(available);
  const env = available;
  const url = new URL(env.db.clusterUrl); url.pathname = `/${env.db.databaseName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  t.after(async () => { await pool.end(); await env.close(); });
  const marker = async (client: pg.PoolClient, id: string) => client.query("INSERT INTO trustwork.audit_event(action,object_kind,object_id) VALUES('drill.marker','synthetic',$1)", [id]);
  const count = async (id: string) => (await env.db.admin.query("SELECT 1 FROM trustwork.audit_event WHERE action='drill.marker' AND object_id=$1", [id])).rowCount;
  await t.test('healthy marker commits and does not leave per-transaction listeners on a reusable client', async () => {
    const id = randomUUID();
    await withDrillOwnerTransaction(pool, (client) => marker(client, id));
    assert.equal(await count(id), 1);
    const client = await pool.connect(); assert.equal(client.listenerCount('error'), 0); client.release();
  });
  await t.test('primary loss between statements rejects and rolls back the unacknowledged marker', async () => {
    const id = randomUUID(); const entered = gate(); const finish = gate(); let pid = 0;
    const transaction = withDrillOwnerTransaction(pool, async (client) => {
      await marker(client, id); pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const socketError = once(client, 'error'); entered.open();
      await finish.promise; await socketError;
    });
    const rejected = assert.rejects(transaction, /not queryable|terminated|connection|closed/i);
    await entered.promise;
    await env.db.admin.query('SELECT pg_terminate_backend($1)', [pid]); finish.open(); await rejected;
    assert.equal(await count(id), 0);
    assert.equal(pool.totalCount, 0, 'the broken connection was discarded');
  });
  await t.test('primary loss during an active query rejects without publishing the marker', async () => {
    const id = randomUUID(); const entered = gate(); let pid = 0;
    const transaction = withDrillOwnerTransaction(pool, async (client) => {
      await marker(client, id); pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      entered.open(); await client.query('SELECT pg_sleep(10)');
    });
    const rejected = assert.rejects(transaction, /terminating|connection|closed/i);
    await entered.promise;
    await waitFor(async () => (await env.db.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid])).rowCount === 1, 5000, 'owned client sleeping');
    await env.db.admin.query('SELECT pg_terminate_backend($1)', [pid]); await rejected;
    assert.equal(await count(id), 0);
    assert.equal(await withDrillOwnerTransaction(pool, async (client) => (await client.query('SELECT 1 AS n')).rows[0].n), 1, 'next transaction uses a healthy connection');
  });
  await t.test('ordinary transaction failures are propagated, not hidden as expected injection', async () => {
    const id = randomUUID();
    await assert.rejects(withDrillOwnerTransaction(pool, async (client) => { await marker(client, id); throw new Error('synthetic unexpected failure'); }), /synthetic unexpected failure/);
    assert.equal(await count(id), 0);
  });
});

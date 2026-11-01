import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { inTransaction } from '@trustwork/worker';
import { budgets, reservations } from '../../packages/data/src/repositories/billing.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas } from '../backend/helpers/personas.js';
import { as, workerLogin } from '../assistant/helpers.js';
import { untilDatabaseTimePasses } from '../data/helpers/postgres.js';
import { rejects } from './helpers.js';

const h = await startHarness('bill_effect_authority');
test('internal BILL callback fence preserves original holds and current locked authority', { skip: h ? false : SKIP_REASON, timeout: 60_000 }, async t => {
  if (!h) return;
  const seed = await seedPersonas(h);
  const worker = await workerLogin(h);
  t.after(async () => { await worker.close(); await h.close(); });
  const person = seed.people.petr;
  const prepare = async (budgetSeconds = 3600, reservationSeconds = 1800) => {
    const end = (await h.db.admin.query<{ at: Date }>("SELECT clock_timestamp()+make_interval(secs=>$1) AS at", [budgetSeconds])).rows[0]!.at;
    const budget = await as(h, person, trx => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null,
      periodFrom: new Date(Date.now() - 60_000), periodTo: end, limitMinor: '100', currency: 'USD' }));
    const reservation = await as(h, person, trx => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '10', currency: 'USD',
      actionIntentId: randomUUID(), correlationKey: randomUUID(), projectId: null, ttlSeconds: reservationSeconds }));
    return { budget, reservation, end };
  };
  const gate = (reservation: string | null, budget: string | null = null) => withMaintenance(h.db.admin, async trx =>
    (await sql<{ allowed: boolean }>`SELECT trustwork.billing_lock_effect_authority(${reservation}::uuid,${budget}::uuid) AS allowed`.execute(trx)).rows[0]!.allowed);
  const waitForLock = async () => {
    for (let n = 0; n < 300; n++) {
      const row = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!;
      if (row.n) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('expected a PostgreSQL lock waiter');
  };
  await t.test('raw app and worker cannot invoke the internal port', async () => {
    const p = await prepare();
    await rejects(as(h, person, trx => sql`SELECT trustwork.billing_lock_effect_authority(${p.reservation.id}::uuid)`.execute(trx)), '42501');
    await rejects(inTransaction(worker.pool(2), trx => sql`SELECT trustwork.billing_lock_effect_authority(${p.reservation.id}::uuid)`.execute(trx)), '42501');
  });
  await t.test('missing or mismatched binding refuses; closed reservation and closed budget refuse', async () => {
    const p = await prepare();
    assert.equal(await gate(null), false);
    assert.equal(await gate(randomUUID()), false);
    assert.equal(await gate(p.reservation.id, randomUUID()), false);
    assert.equal(await gate(p.reservation.id, p.budget), true);
    assert.equal(await gate(null, p.budget), true, 'zero-cost operation can lock its original budget');
    await as(h, person, trx => reservations.release(trx, p.reservation.id, 'synthetic definitive cancellation'));
    assert.equal(await gate(p.reservation.id), false);
    await as(h, person, trx => budgets.close(trx, p.budget));
    assert.equal(await gate(null, p.budget), false);
  });
  for (const order of ['callback first', 'revoker first'] as const) await t.test(`owning budget close: ${order}`, async () => {
    const p = await prepare();
    if (order === 'revoker first') {
      await as(h, person, trx => budgets.close(trx, p.budget));
      assert.equal(await gate(p.reservation.id), false);
      return;
    }
    const connection = await h.db.admin.connect();
    let closing: Promise<unknown> | undefined;
    try {
      await connection.query('BEGIN');
      assert.equal((await connection.query('SELECT trustwork.billing_lock_effect_authority($1) AS allowed', [p.reservation.id])).rows[0].allowed, true);
      closing = as(h, person, trx => budgets.close(trx, p.budget));
      await waitForLock();
      await connection.query('COMMIT');
      await closing;
      assert.equal(await gate(p.reservation.id), false);
    } finally { await connection.query('ROLLBACK'); connection.release(); await closing; }
  });
  for (const expiry of ['budget', 'reservation'] as const) await t.test(`${expiry} expiry crossed while waiting for reservation is refused after the wait`, async () => {
    const p = await prepare(expiry === 'budget' ? 2 : 3600, expiry === 'reservation' ? 2 : 1800);
    const connection = await h.db.admin.connect();
    let waiting: Promise<boolean> | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM trustwork.reservation WHERE id=$1 FOR UPDATE', [p.reservation.id]);
      waiting = gate(p.reservation.id);
      await waitForLock();
      await untilDatabaseTimePasses(h.db.admin, expiry === 'budget' ? p.end : p.reservation.expires_at);
      await connection.query('COMMIT');
      assert.equal(await waiting, false);
    } finally { await connection.query('ROLLBACK'); connection.release(); await waiting; }
    const held = (await h.db.admin.query('SELECT state FROM trustwork.reservation WHERE id=$1', [p.reservation.id])).rows[0];
    assert.equal(held.state, 'reserved', 'refusal is read-only and never releases a hold');
  });
  await t.test('unknown effect remains held past reservation expiry; missing authority never releases it', async () => {
    const p = await prepare(3600, 1);
    // Synthetic original admission: same owning hold bit, with immutable reservation terms untouched.
    await withMaintenance(h.db.admin, trx => trx.updateTable('reservation').set({ effect_pending: true }).where('id', '=', p.reservation.id).execute());
    await untilDatabaseTimePasses(h.db.admin, p.reservation.expires_at);
    assert.equal(await gate(p.reservation.id), true);
    await as(h, person, trx => budgets.close(trx, p.budget));
    assert.equal(await gate(p.reservation.id), false);
    const held = (await h.db.admin.query('SELECT state,effect_pending FROM trustwork.reservation WHERE id=$1', [p.reservation.id])).rows[0];
    assert.deepEqual(held, { state: 'reserved', effect_pending: true });
  });
});

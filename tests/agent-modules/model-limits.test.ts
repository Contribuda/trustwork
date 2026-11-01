import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { runs } from '../../packages/data/src/repositories/assistant.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { withPrincipal } from '@trustwork/data';
import { modelCalls } from '../../packages/data/src/repositories/models.js';
import { PostgresModelCallStore, PostgresModelReceiptStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { durableWorld } from '../models/durable-helpers.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';

const db = await provisionTestDatabase('agt_model_limits');
test('actual model admission serializes free protection capacity and preserves unknown holds across cancellation', { skip: db ? false : SKIP_REASON }, async t => {
  if (!db) return;
  const w = await durableWorld(db, { runsPerDay: 10, actionsPerDay: 3, concurrentRuns: 2 });
  t.after(async () => { await w.pool.end(); await db.close(); });
  const budget = await w.budget('1000');
  const mandate = await w.mandate(budget, '1000');
  const store = new PostgresModelCallStore(w.pool, w.principal, w.binding);
  const routes = new KeysRouteResolver(w.pool);
  const prepare = async () => {
    const call = await w.call(mandate.id);
    const route = await routes.resolve(call);
    const begun = await store.begin(call, route, route.candidates[0]!);
    assert.equal(begun.kind, 'dispatch');
    if (begun.kind !== 'dispatch') throw new Error('expected prepared model call');
    return { call, begun };
  };
  const a = await prepare();
  const b = await prepare();
  const c = await prepare();
  const usage = async () => (await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.agent_runtime_usage')).rows[0]!.n;
  await t.test('a crash before admission commit rolls back both usage measures and the invocation fence', async () => {
    await assert.rejects(withPrincipal(w.pool, w.principal, async trx => {
      assert.equal(await modelCalls.admit(trx, a.begun.call.operationId, a.begun.call.dispatchToken), true);
      throw new Error('synthetic admission crash');
    }), /synthetic admission crash/);
    assert.equal(await usage(), 0);
    assert.equal((await db.admin.query<{ invoked: boolean }>('SELECT invoked FROM trustwork.model_call WHERE operation_id=$1', [a.call.operationId])).rows[0]!.invoked, false);
    await assert.rejects(withPrincipal(w.pool, w.principal, trx => sql`SELECT trustwork.agent_modules_reserve_quota(NULL,NULL,NULL,NULL,NULL,NULL)`.execute(trx)),
      (error: unknown) => (error as { code?: string }).code === '42501');
  });
  await t.test('concurrent actual admissions never exceed two; denial rolls back both measures and the invocation fence', async () => {
    assert.equal(await store.admit(a.begun.call), true);
    const admitted = await Promise.all([store.admit(b.begun.call), store.admit(c.begun.call)]);
    assert.deepEqual([...admitted].sort(), [false, true]);
    assert.equal(await usage(), 4);
    const denied = admitted[0] ? c : b;
    assert.equal((await db.admin.query<{ invoked: boolean }>('SELECT invoked FROM trustwork.model_call WHERE operation_id=$1', [denied.call.operationId])).rows[0]!.invoked, false);
    // An outer cancellation changes no receipt proof and creates no new capacity.
    await withPrincipal(w.pool, w.principal, trx => runs.cancel(trx, a.call.runId, 'Synthetic cancellation'));
    assert.equal(await store.admit(denied.begun.call), false);
    assert.equal(await usage(), 4);
    const receipt = new PostgresModelReceiptStore(w.pool, w.principal, w.binding);
    assert.equal((await receipt.recover(a.call.operationId, w.personId)).kind, 'unknown');
    assert.equal((await withPrincipal(w.pool, w.principal, trx => budgets.balance(trx, budget)))?.heldMinor, '21');
    const o = a.begun.call;
    await receipt.finish(o, { operationId: o.operationId, routeId: o.route.routeId, routeVersion: o.route.routeVersion, model: o.candidate, stage: o.route.stage, fallbackUsed: false, latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: { minorUnits: '0', currency: 'USD' }, outcome: 'failed' });
    assert.equal(await store.admit(denied.begun.call), true, 'only exact terminal receipt evidence frees occupied capacity');
    assert.equal(await usage(), 6);
    assert.equal(await store.admit(denied.begun.call), false, 'the one-use fence still prevents duplicate admission');
    assert.equal(await usage(), 6);
    const other = admitted[0] ? b : c;
    const settled = other.begun.call;
    await receipt.finish(settled, { operationId: settled.operationId, routeId: settled.route.routeId, routeVersion: settled.route.routeVersion, model: settled.candidate, stage: settled.route.stage, fallbackUsed: false, latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: { minorUnits: '0', currency: 'USD' }, outcome: 'failed' });
    const dailyDenied = await prepare();
    assert.equal(await store.admit(dailyDenied.begun.call), false, 'daily action denial rolls back the already reserved run measure');
    assert.equal(await usage(), 6);
    assert.equal((await db.admin.query<{ invoked: boolean }>('SELECT invoked FROM trustwork.model_call WHERE operation_id=$1', [dailyDenied.call.operationId])).rows[0]!.invoked, false);
  });
});

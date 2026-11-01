import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withPrincipal } from '@trustwork/data';
import { AgentModelGovernance } from '../../apps/api/src/modules/agent-modules/model-governance.js';
import { PostgresModelCallStore, PostgresModelReceiptStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { modelCalls } from '../../packages/data/src/repositories/models.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { durableWorld, syntheticGovernance } from '../models/durable-helpers.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';

const db = await provisionTestDatabase('agt_model_authority');
test('real model admission uses stored AGT authority while original receipt recovery stays independent', { skip: db ? false : SKIP_REASON }, async t => {
  if (!db) return;
  const w = await durableWorld(db);
  t.after(async () => { await w.pool.end(); await db.close(); });
  const budget = await w.budget();
  const mandate = await w.mandate(budget);
  const call = await w.call(mandate.id);
  const routes = new KeysRouteResolver(w.pool);
  const route = await routes.resolve(call);
  const candidate = route.candidates[0]!;
  const store = new PostgresModelCallStore(w.pool, w.principal, w.binding);
  const governance = new AgentModelGovernance(w.pool, w.principal, syntheticGovernance);
  const hint = (expected: string) => (error: unknown) => (error as { hint?: string }).hint === expected;

  await t.test('real capability proof does not supply absent model/source/retention/residency policy', async () => {
    await assert.rejects(new AgentModelGovernance(w.pool, w.principal).check(call, candidate, w.binding),
      (error: unknown) => (error as { reason?: string }).reason === 'governance_unavailable');
    assert.equal((await governance.check(call, candidate, w.binding)).principalId, w.personId);
    await assert.rejects(governance.check(call, candidate, w.binding, 'reconcile'));
  });
  await t.test('another hub, unbound run, unknown capability and wrong action/context cannot reserve a model effect', async () => {
    await assert.rejects(store.begin({ ...call, hubId: randomUUID() }, route, candidate), hint('agents.hub_provenance_unavailable'));
    await assert.rejects(store.begin({ ...call, runId: randomUUID() }, route, candidate), hint('agents.hub_provenance_unavailable'));
    await assert.rejects(store.begin({ ...call, capabilityId: 'research.unregistered' }, route, candidate), hint('models.capability_binding'));
    await assert.rejects(new PostgresModelCallStore(w.pool, w.principal, { ...w.binding, action: 'prepare' }).begin(call, route, candidate), hint('models.capability_binding'));
    await assert.rejects(withPrincipal(w.pool, w.principal, trx => modelCalls.checkAuthority(trx, call, { ...w.binding, context: { kind: 'goal', id: randomUUID() } })), hint('models.capability_binding'));
    assert.equal((await db.admin.query('SELECT * FROM trustwork.model_call')).rowCount, 0);
  });
  await t.test('admission first holds the hub epoch; withdrawal first denies the next dispatch but cannot erase an unknown hold', async () => {
    const begun = await store.begin(call, route, candidate);
    assert.equal(begun.kind, 'dispatch');
    if (begun.kind !== 'dispatch') throw new Error('expected original dispatch');
    let finish!: () => void;
    let admitted!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const admission = withPrincipal(w.pool, w.principal, async trx => {
      assert.equal(await modelCalls.admit(trx, begun.call.operationId, begun.call.dispatchToken), true);
      admitted();
      await release;
    });
    let withdrawal: Promise<unknown> | undefined;
    try {
      await ready;
      let withdrawn = false;
      withdrawal = db.admin.query('UPDATE trustwork.agent_serving_hub SET active=false WHERE hub_id=$1', [w.hubId]).then(result => { withdrawn = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(withdrawn, false, 'the routing revoker waits for admitted execution');
      finish();
      await admission;
      await withdrawal;
      await assert.rejects(store.admit(begun.call), hint('agents.hub_provenance_unavailable'));
      await assert.rejects(governance.check(call, candidate, w.binding), hint('agents.hub_provenance_unavailable'));
      const receipt = new PostgresModelReceiptStore(w.pool, w.principal, w.binding);
      assert.equal((await receipt.recover(call.operationId, w.personId)).kind, 'unknown');
      const balance = await withPrincipal(w.pool, w.principal, trx => budgets.balance(trx, budget));
      assert.equal(balance?.heldMinor, '7', 'unknown effects retain the original financial hold');
    } finally {
      finish();
      await admission;
      await withdrawal;
    }
  });
});

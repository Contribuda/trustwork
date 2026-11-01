import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jobs, withMaintenance } from '@trustwork/data';
import { sql } from 'kysely';
import { inTransaction, silentLogger } from '@trustwork/worker';
import { assistantWorker } from '../../packages/data/src/repositories/assistant.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { defineEffectImplementation, dispatchHandler, FakeEffectProvider, type AssistantRuntime } from '../../apps/worker/src/assistant/index.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, assistantService, draft, ok, personalBudget, stateOf, usd, workerLogin, type MandateView } from '../assistant/helpers.js';
import { installSyntheticOrderManifest, syntheticEffectDeclaration } from '../assistant/manifest-fixture.js';
import { buildAgentWorld, engage, release } from './helpers.js';

const h = await startHarness('agt_effect_authority');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('code-owned effect callback, current revokers and exact original-operation recovery', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async t => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => { await worker.close(); await h.close(); });
  const world = await buildAgentWorld(h);
  await installSyntheticOrderManifest(h);
  h.clock.reset();
  const seed = await seedPersonas(h);
  const pool = worker.pool(8);
  const declaration = syntheticEffectDeclaration('deal_desk.place_order', 'fake_orders', 'order.place');
  const prepare = async () => {
    const client = h.client();
    await login(client, 'petr');
    const project = ok<{ id: string }>(await client.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Synthetic effect authority', summary: null, leaderPersonId: null }), 201);
    const state = await stateOf(h, client, randomUUID());
    const budget = await personalBudget(h, seed.people.petr, 'transaction', '1000');
    const mandate = ok<MandateView>(await client.post('/v1/assistant/mandates', { draft: draft({ moduleKeys: ['deal_desk'], actions: ['place_order'],
      contexts: [{ kind: 'project', id: project.id }], limits: { ceiling: usd('1000'), perActionCeiling: null, transactionBudgetId: budget, platformBudgetId: null, perWindow: null } }) }), 201);
    const { service, model } = assistantService(h);
    model.push({ text: 'Synthetic local action', messageKey: null, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ kind: 'propose_action', mandateId: mandate.id,
      capabilityId: 'deal_desk.place_order', moduleKey: 'deal_desk', action: 'place_order', context: { kind: 'project', id: project.id }, amount: usd('10'), projectId: null,
      effect: { provider: 'fake_orders', operation: 'order.place', payload: { item: 'synthetic' } } }] });
    const turn = await service.converse({ text: 'Synthetic request' }, state);
    const action = turn.actions[0]!;
    assert.equal(action.state, 'queued', JSON.stringify(action));
    const intentId = (action as { intentId: string }).intentId;
    const leased = await inTransaction(pool, trx => jobs.lease(trx, ['assistant.dispatch'], randomUUID(), 120, 100));
    const job = leased.find(j => (j.payload as { intentId?: string }).intentId === intentId)!;
    assert.ok(job);
    const context = { job, payload: { intentId }, attemptId: randomUUID(), effectKey: `job:${job.id}`, signal: new AbortController().signal };
    const read = async () => (await h.db.admin.query<{ state: string; hold: string; attempt_count: number; effect_correlation_key: string }>(
      'SELECT i.state,q.state AS hold,i.attempt_count,i.effect_correlation_key FROM trustwork.action_intent i JOIN trustwork.reservation q ON q.id=i.reservation_id WHERE i.id=$1', [intentId])).rows[0]!;
    return { client, state, budget, mandate, project, runId: turn.run.id, intentId, job, context, read };
  };
  const runtime = (provider: FakeEffectProvider, implementation = defineEffectImplementation(declaration, provider, input => structuredClone(input))): AssistantRuntime =>
    ({ pool, providers: [provider], implementations: [implementation], hubId: null, log: silentLogger });

  await t.test('equal provider and operation names cannot replace a different code declaration', async () => {
    const p = await prepare();
    const provider = new FakeEffectProvider('fake_orders');
    const replacement = defineEffectImplementation({ ...declaration, payloadContract: 'different-contract@2' }, provider, input => input);
    await dispatchHandler(runtime(provider, replacement)).run(p.context);
    assert.equal(provider.submissions.length, 0);
    assert.equal((await p.read()).state, 'failed');
    assert.equal((await p.read()).hold, 'released', 'definitive refusal happened before any effect');
  });
  await t.test('code-owned payload refusal happens before the callback and preserves private constraints', async () => {
    const p = await prepare();
    const provider = new FakeEffectProvider('fake_orders');
    const implementation = defineEffectImplementation(declaration, provider, () => { throw new Error('synthetic invalid payload'); });
    await dispatchHandler(runtime(provider, implementation)).run(p.context);
    assert.equal(provider.submissions.length, 0);
    assert.equal((await p.read()).state, 'failed');
  });
  const cases = ['serving', 'kill switch', 'session', 'mandate', 'run', 'resource authority', 'budget'] as const;
  for (const kind of cases) for (const order of ['dispatch first', 'revoker first'] as const) {
    await t.test(`${kind}: ${order} at the actual handler callback`, async () => {
      const p = await prepare();
      const provider = new FakeEffectProvider('fake_orders');
      const entered = deferred(); const finish = deferred();
      const originalSubmit = provider.submit.bind(provider);
      provider.submit = async (request, signal) => { entered.resolve(); await finish.promise; return originalSubmit(request, signal); };
      const handler = dispatchHandler(runtime(provider));
      let switchId: string | undefined;
      const revoke = async () => {
        switch (kind) {
          case 'serving': await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=false WHERE hub_id=${world.hubId}::uuid`.execute(trx)); break;
          case 'kill switch': switchId = await engage(world, 'agent_module', { moduleKey: 'deal_desk' }); break;
          case 'session': await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=${p.state.session!.id}::uuid`.execute(trx)); break;
          case 'mandate': ok(await p.client.post(`/v1/assistant/mandates/${p.mandate.id}/revoke`, { expectedRevision: p.mandate.revision, reason: 'Synthetic revoke' })); break;
          case 'run': ok(await p.client.post(`/v1/assistant/runs/${p.runId}/cancel`, { reason: 'Synthetic cancellation' })); break;
          // Real participation mutation runs the owning epoch trigger; no session identity is fabricated.
          case 'resource authority': await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.object_participation SET revoked_at=clock_timestamp(),revoked_reason='Synthetic withdrawal' WHERE resource_kind='project' AND resource_id=${p.project.id}::uuid AND party_person_id=${seed.people.petr}::uuid`.execute(trx)); break;
          case 'budget': await as(h, seed.people.petr, trx => budgets.close(trx, p.budget)); break;
        }
      };
      let dispatch: Promise<void> | undefined; let revoker: Promise<void> | undefined;
      try {
        if (order === 'dispatch first') {
          dispatch = handler.run(p.context);
          await Promise.race([entered.promise, dispatch.then(() => { throw new Error('callback was not reached'); })]);
          let ended = false;
          revoker = revoke().then(() => { ended = true; });
          // Observe a real PostgreSQL lock waiter, not merely an unresolved JS promise.
          let blocked = false;
          for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
            blocked = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!.n > 0;
            if (!blocked) await new Promise(r => setTimeout(r, 5));
          }
          assert.ok(blocked, 'current revoker waits for the admitted code-owned callback');
          assert.equal(ended, false);
          finish.resolve(); await dispatch; await revoker;
          assert.equal(provider.submissions.length, 1);
          assert.equal((await p.read()).state, 'succeeded');
        } else {
          await revoke(); finish.resolve(); await handler.run(p.context);
          assert.equal(provider.submissions.length, 0);
          assert.equal((await p.read()).state, 'revoked');
          assert.equal((await p.read()).attempt_count, 0);
        }
      } finally {
        finish.resolve(); await dispatch; await revoker;
        if (switchId) await release(world, switchId);
        if (kind === 'serving') await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=true WHERE hub_id=${world.hubId}::uuid`.execute(trx));
      }
    });
  }
  await t.test('withdrawal after committed admission prevents callback, keeps the original hold and pins receipt-only recovery', async () => {
    const p = await prepare();
    const target = await inTransaction(pool, trx => assistantWorker.beginAttempt(trx, p.intentId, p.job.id, null, p.job.fencing_token));
    assert.equal(target.status, 'dispatch');
    if (target.status !== 'dispatch') throw new Error('expected attempt');
    await assert.rejects(h.pool.query('SELECT trustwork.agent_modules_enter_effect($1,$2,$3)', [target.attemptId,p.job.id,p.job.fencing_token]), (e: unknown) => (e as { code?: string }).code === '42501');
    const stop = await engage(world, 'agent_module', { moduleKey: 'deal_desk' });
    assert.equal(await inTransaction(pool, trx => assistantWorker.enterEffect(trx, target.attemptId,p.job.id,p.job.fencing_token)), false);
    assert.equal((await p.read()).hold, 'reserved');
    const original = await inTransaction(pool, trx => assistantWorker.beginReconciliation(trx,p.intentId));
    assert.equal(original.status, 'reconcile');
    if (original.status !== 'reconcile') throw new Error('expected recovery');
    assert.deepEqual(original.implementation, target.implementation);
    assert.equal(original.correlationKey, target.correlationKey);
    assert.equal((await p.read()).attempt_count, 1);
    assert.equal((await p.read()).hold, 'reserved');
    await inTransaction(pool, trx => assistantWorker.recordReconciliation(trx,p.intentId,`synthetic-original:${target.correlationKey}`,{ kind: 'final', result: 'failed', providerReference: null, evidence: 'Original local fake callback was never entered; exact correlation key absent' }));
    assert.equal((await p.read()).hold, 'released');
    await release(world, stop);
  });
});

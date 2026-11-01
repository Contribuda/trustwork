import { createRuntimeAssistantModel } from '../../apps/api/src/modules/models/runtime-assistant.js';
import type { ModelAdapterResult } from '../../apps/api/src/modules/models/ports.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { sql } from 'kysely';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { budgets, reservations } from '../../packages/data/src/repositories/billing.js';
import { mandates } from '../../packages/data/src/repositories/assistant.js';
import { modelCalls } from '../../packages/data/src/repositories/models.js';
import { durableWorld, syntheticGovernance } from './durable-helpers.js';
import { PostgresModelCallStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { RuntimeModelAuthority } from '../../apps/api/src/modules/models/runtime-authority.js';
import { ModelGateway } from '../../apps/api/src/modules/models/gateway.js';
import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
import { FakeModelRegistry, ModelRefusal, type ReservedModelCall } from '../../apps/api/src/modules/models/ports.js';
import type { ModelCall, ModelCallMetadata } from '../../packages/contracts/src/models.js';

const db = await provisionTestDatabase('models_durable');
test('durable fake-only model intent, owning BILL/AST commands and cross-process caps', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  const w = await durableWorld(db);
  t.after(async () => {
    await w.pool.end();
    await db.close();
  });
  const store = new PostgresModelCallStore(w.pool, w.principal, w.binding, 1);
  const routes = new KeysRouteResolver(w.pool);
  const adapter = new DeterministicModel();
  const registry = new FakeModelRegistry();
  registry.register(w.connection.id, adapter);
  const gateway = (authority = new RuntimeModelAuthority(w.pool, w.principal, w.binding, syntheticGovernance)) =>
    new ModelGateway(routes, authority, store, registry);
  const as = <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(w.pool, w.principal, fn);
  const start = async (call: ModelCall) => {
    const route = await routes.resolve(call);
    const r = await store.begin(call, route, route.candidates[0]!);
    assert.equal(r.kind, 'dispatch');
    if (r.kind !== 'dispatch') throw new Error('expected dispatch');
    return r.call;
  };
  const metadata = (o: ReservedModelCall, outcome: ModelCallMetadata['outcome'], cost = '0'): ModelCallMetadata => ({
    operationId: o.operationId,
    routeId: o.route.routeId,
    routeVersion: o.route.routeVersion,
    model: o.candidate,
    stage: o.route.stage,
    fallbackUsed: false,
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    cost: { minorUnits: cost, currency: 'USD' },
    outcome,
  });
  const child = (call: ModelCall, mode: 'call' | 'begin' | 'before_commit' | 'after_admit' | 'after_effect' = 'begin') =>
    new Promise<{ kind?: string; error?: string; calls?: number; effect?: string; receipt?: ModelAdapterResult; exit: number | null }>((resolve, reject) => {
      const p = fork(new URL('./process-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let data: Record<string, unknown> = {};
      let stderr = '';
      p.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      p.on('message', (m) => {
        data = { ...data, ...(m as object) };
      });
      p.on('error', reject);
      p.on('exit', (exit) => {
        if (stderr) reject(new Error(stderr));
        else resolve({ ...data, exit });
      });
      p.send({ db: db.appConfig, call, binding: w.binding, mode });
    });
  await t.test('unresolved hold survives TTL in balance, admission and sweep; finite ordinary reservations still expire', async () => {
    const b = await w.budget('10');
    const m = await w.mandate(b);
    const call = await w.call(m.id);
    const o = await start(call);
    await db.admin.query('SELECT pg_sleep(1.1)');
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '7');
    await withMaintenance(db.admin, (trx) => reservations.expireDue(trx));
    assert.equal((await as((trx) => reservations.get(trx, o.reservationId!)))!.state, 'reserved');
    assert.equal(
      (
        await withMaintenance(db.admin, (trx) =>
          sql<{ open: boolean }>`SELECT trustwork.billing_reservation_open(${o.reservationId}::uuid) AS open`.execute(trx),
        )
      ).rows[0]!.open,
      true,
    );
    await assert.rejects(start(await w.call(m.id)), (e: unknown) => (e as { hint?: string }).hint === 'commercial.budget_insufficient');
    await assert.rejects(
      as((trx) => reservations.release(trx, o.reservationId!, 'Synthetic attempt')),
      (e: unknown) => (e as { hint?: string }).hint === 'billing.effect_unresolved',
    );
    await store.finish(o, metadata(o, 'outcome_unknown', '7'));
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '7');
    await store.finish(o, metadata(o, 'succeeded', '5'));
    await store.finish(o, metadata(o, 'succeeded', '5'));
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '0');
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.consumedMinor, '5');
    await assert.rejects(store.finish(o, metadata(o, 'failed')));
    const plain = await as((trx) =>
      reservations.reserve(trx, {
        budgetId: b,
        kind: 'platform',
        amountMinor: '2',
        currency: 'USD',
        actionIntentId: call.runId,
        correlationKey: 'ordinary',
        projectId: null,
        ttlSeconds: 1,
      }),
    );
    await db.admin.query('SELECT pg_sleep(1.1)');
    await withMaintenance(db.admin, (trx) => reservations.expireDue(trx));
    assert.equal((await as((trx) => reservations.get(trx, plain.id)))!.state, 'expired');
  });
  await t.test('real session/run/mandate/owner/budget and missing governance refusals invoke no adapter', async () => {
    const b = await w.budget();
    const m = await w.mandate(b);
    const call = await w.call(m.id);
    const before = adapter.calls.length;
    await assert.rejects(gateway(new RuntimeModelAuthority(w.pool, w.principal, w.binding)).call(call), ModelRefusal);
    await assert.rejects(
      gateway(new RuntimeModelAuthority(w.pool, w.principal, { ...w.binding, sessionId: w.world.sessions.officer }, syntheticGovernance)).call(call),
    );
    await assert.rejects(gateway().call({ ...call, principalId: w.world.people.officer }));
    await assert.rejects(gateway().call({ ...call, runId: w.world.sessions.officer }));
    await assert.rejects(gateway().call({ ...call, mandateRevision: 99 }));
    await assert.rejects(
      gateway(new RuntimeModelAuthority(w.pool, { ...w.principal, authzEpoch: 2 }, { ...w.binding, authzEpoch: 2 }, syntheticGovernance)).call(call),
    );
    await assert.rejects(
      gateway(
        new RuntimeModelAuthority(w.pool, w.principal, { ...w.binding, context: { kind: 'profile', id: w.world.people.officer } }, syntheticGovernance),
      ).call(call),
    );
    await w.a.as(w.personId, (trx) => mandates.narrow(trx, m.id, 1, 'revoked', 'Synthetic revoke'));
    await assert.rejects(gateway().call(call));
    assert.equal(adapter.calls.length, before);
    assert.equal(await as((trx) => modelCalls.get(trx, call.operationId)), undefined);
  });
  await t.test('current egress revoked after durable begin refuses without invoking; releases no-effect hold', async () => {
    const b = await w.budget();
    const m = await w.mandate(b);
    const call = await w.call(m.id);
    const before = adapter.calls.length;
    const authority = new RuntimeModelAuthority(w.pool, w.principal, w.binding, syntheticGovernance);
    const hooked: typeof store = Object.create(store) as typeof store;
    hooked.begin = async (...args) => {
      const result = await store.begin(...args);
      await w.egress('deny');
      return result;
    };
    const result = await new ModelGateway(routes, authority, hooked, registry).call(call);
    await w.egress('allow');
    assert.equal(result.outcome, 'refused');
    assert.equal(adapter.calls.length, before);
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '0');
    await w.egress('allow');
  });
  await t.test('two OS processes cannot overspend either the same mandate or the same platform budget', async () => {
    for (const sharedMandate of [true, false]) {
      const b = await w.budget(sharedMandate ? '100' : '10');
      const m = await w.mandate(b, '10');
      const other = sharedMandate ? m : await w.mandate(b, '10');
      const results = await Promise.all([child(await w.call(m.id), 'call'), child(await w.call(other.id), 'call')]);
      assert.equal(
        results.reduce((sum, r) => sum + (r.calls ?? 0), 0),
        1,
        JSON.stringify(results),
      );
      assert.equal(results.find((r) => r.error)?.calls, 0);
      assert.equal(results.filter((r) => r.kind === 'dispatch').length, 1, JSON.stringify(results));
      assert.equal(results.filter((r) => r.error === (sharedMandate ? 'mandate.limit' : 'commercial.budget_insufficient')).length, 1, JSON.stringify(results));
      assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '7');
    }
  });
  await t.test('cross-process duplicate gets no dispatch ownership, body-free pins and receipt are immutable', async () => {
    const b = await w.budget();
    const m = await w.mandate(b);
    const call = await w.call(m.id);
    const results = await Promise.all([child(call), child(call)]);
    assert.deepEqual(results.map((r) => r.kind).sort(), ['dispatch', 'replay']);
    const row = await as((trx) => modelCalls.get(trx, call.operationId));
    assert.ok(row);
    assert.equal(JSON.stringify(row).includes(call.prompt), false);
    await assert.rejects(start({ ...call, prompt: 'different' }));
    await assert.rejects(start({ ...call, operationId: 'same-run-other-operation' }));
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '7');
    await assert.rejects(as((trx) => sql`UPDATE trustwork.model_call SET state = 'failed' WHERE operation_id = ${call.operationId}`.execute(trx)));
    const foreign = new PostgresModelCallStore(
      w.pool,
      { personId: w.world.people.officer, authzEpoch: 1 },
      { ...w.binding, sessionId: w.world.sessions.officer },
    );
    assert.equal(await foreign.unknown(call.operationId, w.world.people.officer), null);
  });
  await t.test('process death before commit rolls back; after intent/admission/effect never resends and retains hold', async () => {
    for (const mode of ['before_commit', 'begin', 'after_admit', 'after_effect'] as const) {
      const b = await w.budget('10');
      const m = await w.mandate(b);
      const call = await w.call(m.id);
      const result = await child(call, mode);
      if (mode === 'before_commit') {
        assert.equal(result.exit, 70);
        assert.equal(await as((trx) => modelCalls.get(trx, call.operationId)), undefined);
        assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '0');
        continue;
      }
      if (mode === 'after_effect') assert.equal(result.effect, call.operationId);
      const before = adapter.calls.length;
      const replay = await gateway().call(call);
      assert.equal(replay.outcome, 'outcome_unknown');
      assert.equal(adapter.calls.length, before);
      const reconciled = await gateway().reconcile(call.operationId, w.personId);
      assert.equal(reconciled.outcome, 'outcome_unknown');
      assert.equal(adapter.calls.length, before);
      assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '7');
      const o = await store.unknown(call.operationId, w.personId);
      assert.ok(o);
      if (mode === 'after_effect') {
        assert.ok(result.receipt);
        const previous = adapter.reconcile.bind(adapter);
        adapter.reconcile = async () => result.receipt!;
        try {
          assert.equal((await gateway().reconcile(call.operationId, w.personId)).outcome, 'succeeded');
        } finally {
          adapter.reconcile = previous;
        }
      } else {
        await store.finish(o, metadata(o, 'failed')); // Explicit authoritative terminal no-effect evidence, never absence.
      }
      assert.equal(await store.admit(o), false);
      assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '0');
    }
  });
  await t.test('AST composition invokes the exact fake pin, persists final receipt and recovers settlement without a resend', async () => {
    const b = await w.budget();
    const m = await w.mandate(b);
    const call = await w.call(m.id);
    call.dataClasses = ['person_private'];
    const model = createRuntimeAssistantModel(w.pool, registry, {
      ...syntheticGovernance,
      async select() {
        return { call, action: w.binding.action, context: w.binding.context };
      },
    });
    const input = {
      personId: w.personId,
      history: [],
      text: 'Synthetic private input marker',
      evidence: [],
      execution: {
        operationId: call.operationId,
        runId: call.runId,
        hubId: w.hubId,
        principal: { ...w.principal, emailVerified: false, authenticatedAt: new Date().toISOString(), membership: null, staff: [], delegation: null },
        sessionId: w.binding.sessionId,
      },
    };
    const before = adapter.calls.length;
    const denied = await model.respond(input);
    assert.equal(denied.messageKey, 'assistant.overlay.stateUnavailable');
    assert.equal(adapter.calls.length, before);
    assert.equal(await as((trx) => modelCalls.get(trx, call.operationId)), undefined);
    await w.allowPrivate();
    const publicMisclassification = createRuntimeAssistantModel(w.pool, registry, {
      ...syntheticGovernance,
      async select() {
        return { call: { ...call, dataClasses: ['public'] }, action: w.binding.action, context: w.binding.context };
      },
    });
    assert.equal((await publicMisclassification.respond(input)).messageKey, 'assistant.overlay.stateUnavailable');
    assert.equal(adapter.calls.length, before);
    const response = await model.respond(input);
    assert.equal(response.text, 'Synthetic model response.');
    assert.equal(adapter.calls.length, before + 1);
    assert.equal(adapter.calls.at(-1)!.modelRevision, 'synthetic-rev-1');
    const row = await as((trx) => modelCalls.get(trx, call.operationId));
    assert.equal(row!.state, 'succeeded');
    assert.equal(JSON.stringify(row).includes(input.text), false);
    const receipt = await as((trx) => trx.selectFrom('model_attempt_receipt').selectAll().where('operation_id', '=', call.operationId).executeTakeFirst());
    assert.ok(receipt);
    await assert.rejects(
      withMaintenance(db.admin, (trx) =>
        sql`UPDATE trustwork.model_attempt_receipt SET receipt = '{}'::jsonb WHERE operation_id = ${call.operationId}`.execute(trx),
      ),
    );
    assert.equal((await model.recover(input))!.text, null);
    assert.equal(adapter.calls.length, before + 1);
    assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '0');
    const unconfigured = createRuntimeAssistantModel(w.pool, registry);
    assert.equal((await unconfigured.respond(input)).messageKey, 'assistant.overlay.stateUnavailable');
    assert.equal(adapter.calls.length, before + 1);
  });

  await t.test('durable fallback records immutable no-effect evidence and rechecks its exact pin', async () => {
    const b = await w.budget();
    const m = await w.mandate(b);
    const call = await w.call(m.id);
    const secondary = new DeterministicModel();
    registry.register(w.secondary.id, secondary);
    const original = adapter.invoke.bind(adapter);
    adapter.invoke = async () => ({ kind: 'not_sent', reason: 'unreachable' });
    try {
      const result = await gateway().call(call);
      assert.equal(result.outcome, 'succeeded');
      assert.equal(result.metadata!.fallbackUsed, true);
      assert.equal(secondary.calls[0]!.modelRevision, 'synthetic-rev-2');
      const receipts = await as((trx) => trx.selectFrom('model_attempt_receipt').selectAll().where('operation_id', '=', call.operationId).execute());
      assert.equal(receipts.length, 2);
      assert.ok(receipts.some((r) => (r.receipt as { kind?: string }).kind === 'not_sent'));
      assert.equal((await as((trx) => budgets.balance(trx, b)))!.heldMinor, '0');
    } finally {
      adapter.invoke = original;
    }
  });
  await t.test(
    'revocation after reservation stops invocation; existing unknown can settle an authoritative receipt without new mandate authority',
    async () => {
      const b = await w.budget();
      const m = await w.mandate(b);
      const call = await w.call(m.id);
      const o = await start(call);
      await store.admit(o);
      await store.finish(o, metadata(o, 'outcome_unknown', '7'));
      await w.a.as(w.personId, (trx) => mandates.narrow(trx, m.id, 1, 'revoked', 'Synthetic revocation after dispatch'));
      const before = adapter.calls.length;
      await assert.rejects(gateway().call({ ...call, operationId: 'new-revoked-call' }));
      assert.equal(adapter.calls.length, before);
      const original = adapter.reconcile.bind(adapter);
      adapter.reconcile = async () => ({ kind: 'succeeded', text: 'Synthetic receipt', costMinorUnits: '5', inputTokens: 1, outputTokens: 1 });
      try {
        assert.equal((await gateway().reconcile(call.operationId, w.personId)).outcome, 'succeeded');
      } finally {
        adapter.reconcile = original;
      }
      assert.equal(adapter.calls.length, before);
      assert.equal((await as((trx) => budgets.balance(trx, b)))!.consumedMinor, '5');
      const otherRun = await w.a.as(w.world.people.officer, (trx) =>
        import('../../packages/data/src/repositories/assistant.js').then(({ runs }) =>
          runs.start(trx, { principal_person_id: w.world.people.officer, kind: 'conversation' }),
        ),
      );
      const live = await w.mandate(b);
      const foreignCall = await w.call(live.id);
      await assert.rejects(gateway().call({ ...foreignCall, runId: otherRun.id }));
      assert.equal(adapter.calls.length, before);
    },
  );
});

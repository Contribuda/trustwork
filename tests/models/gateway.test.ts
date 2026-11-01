import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../../apps/api/src/modules/models/gateway.js';
import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
import { FakeModelRegistry, ModelRefusal, type ModelAdapterResult } from '../../apps/api/src/modules/models/ports.js';
import { MODEL_KILL_SCOPES, type ModelCallMetadata } from '../../packages/contracts/src/models.js';
import { candidate, MemoryStore, request, SyntheticAuthority, SyntheticRoutes } from './fixtures.js';

function harness() {
  const routes = new SyntheticRoutes();
  const authority = new SyntheticAuthority();
  const store = new MemoryStore();
  const registry = new FakeModelRegistry();
  const adapter = new DeterministicModel();
  registry.register(candidate.connectionId, adapter);
  const logs: ModelCallMetadata[] = [];
  const gateway = new ModelGateway(routes, authority, store, registry, (m) => logs.push(m));
  return { routes, authority, store, registry, adapter, logs, gateway };
}

test('check-only authority or route ports never authorize a callback', async () => {
  const h=harness();
  const checkOnlyAuthority={check:h.authority.check.bind(h.authority)};
  const checkOnlyRoutes={resolve:h.routes.resolve.bind(h.routes),recheck:h.routes.recheck.bind(h.routes)};
  await assert.rejects(new ModelGateway(h.routes,checkOnlyAuthority,h.store,h.registry).call(request),ModelRefusal);
  await assert.rejects(new ModelGateway(checkOnlyRoutes,h.authority,h.store,h.registry).call(request),ModelRefusal);
  assert.equal(h.adapter.calls.length,0);assert.equal(h.store.begins,0);
});

test('missing or caller-substituted source versions cannot enlarge the owning source policy', async () => {
  const h=harness();const {sourceBindings:_sourceBindings,...unbound}=request;void _sourceBindings;
  for(const input of [unbound,{...request,sourceBindings:[{sourceId:'different-source',version:'synthetic-1',digest:'a'.repeat(64)}]},
    {...request,sourceBindings:[{...request.sourceBindings![0]!,version:'different-version'}]},
    {...request,sourceBindings:[{...request.sourceBindings![0]!,digest:'b'.repeat(64)}]}]) {
    await assert.rejects(h.gateway.call(input),ModelRefusal);
  }
  assert.equal(h.adapter.calls.length,0);assert.equal(h.store.begins,0);
});

test('gateway forwards the exact pin and returns a synthetic response without logging bodies', async () => {
  const h = harness();
  const result = await h.gateway.call(request);
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.text, 'Synthetic model response.');
  assert.deepEqual(h.adapter.calls, [{ operationId: request.operationId, modelRevision: candidate.modelRevision }]);
  assert.equal(h.logs.length, 1);
  assert.ok(!JSON.stringify(h.logs).includes(request.prompt));
  assert.ok(!JSON.stringify(h.logs).includes('Synthetic model response.'));
  assert.ok(!JSON.stringify([...h.store.rows.values()]).includes(request.prompt));
  assert.equal(h.routes.checks.length, 5, 'the final check runs inside callback authority');
});

test('all mandatory kill scopes, including unknown, refuse before adapter invocation', async (t) => {
  for (const scope of MODEL_KILL_SCOPES) for (const value of [true, 'unknown'] as const) {
    await t.test(`${scope}: ${value}`, async () => {
      const h = harness();
      h.authority.answer.killed[scope] = value;
      await assert.rejects(h.gateway.call(request), ModelRefusal);
      assert.equal(h.adapter.calls.length, 0);
      assert.equal(h.store.begins, 0);
    });
  }
});

test('current authority, source, processing/storage residency, retention and restrictions fail closed', async (t) => {
  const patches = [
    { principalId: 'other' }, { mandateId: 'other' }, { mandateRevision: 2 }, { runId: 'other' }, { sourceAllowsModelUse: false },
    { processingCountry: 'DE' }, { storageCountry: 'DE' }, { zeroRetention: false }, { restricted: true },
  ];
  for (const patch of patches) await t.test(Object.keys(patch)[0]!, async () => {
    const h = harness();
    Object.assign(h.authority.answer, patch);
    await assert.rejects(h.gateway.call(request), ModelRefusal);
    assert.equal(h.adapter.calls.length, 0);
  });
});

test('unknown adapter, live mode, disallowed connection and token limits invoke no adapter', async () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => { h.routes.current.candidates[0]!.mode = 'live'; },
    (h: ReturnType<typeof harness>) => { h.routes.current.candidates[0]!.connectionId = 'other'; },
    (h: ReturnType<typeof harness>) => { h.routes.current.limits.maxInputTokens = 1; },
    (h: ReturnType<typeof harness>) => { h.routes.deny = candidate.connectionId; },
  ]) {
    const h = harness(); mutate(h);
    await assert.rejects(h.gateway.call(request), ModelRefusal);
    assert.equal(h.adapter.calls.length, 0);
  }
});

test('policy is checked again after waiting for the reservation', async () => {
  const h = harness();
  h.store.beforeReturn = () => { h.authority.answer.killed.capability = true; };
  const result = await h.gateway.call(request);
  assert.equal(result.outcome, 'refused');
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(h.store.rows.get(request.operationId)!.metadata!.outcome, 'refused');
});

function fallbackHarness() {
  const h = harness();
  const fallback = { ...candidate, connectionId: 'fallback-synthetic', modelRevision: 'rev-fallback-1' };
  h.routes.current.candidates.push(fallback);
  const adapter = new DeterministicModel();
  h.registry.register(fallback.connectionId, adapter);
  h.adapter.invoke = async () => ({ kind: 'not_sent', reason: 'unreachable' });
  return { ...h, fallback, fallbackAdapter: adapter, input: { ...request, allowedConnections: [candidate.connectionId, fallback.connectionId] } };
}

test('fallback is separately rechecked and pins its own revision', async () => {
  const h = fallbackHarness();
  const result = await h.gateway.call(h.input);
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.metadata!.fallbackUsed, true);
  assert.equal(h.fallbackAdapter.calls[0]!.modelRevision, h.fallback.modelRevision);
});
test('egress denial after primary unavailability never invokes the fallback', async () => {
  const h = fallbackHarness();
  h.routes.deny = h.fallback.connectionId;
  assert.equal((await h.gateway.call(h.input)).outcome, 'refused');
  assert.equal(h.fallbackAdapter.calls.length, 0);
});
test('canary uses the same egress check and cannot escape a denial', async () => {
  const h = harness();
  h.routes.current.stage = 'canary';
  h.routes.deny = candidate.connectionId;
  await assert.rejects(h.gateway.call(request), ModelRefusal);
  assert.equal(h.adapter.calls.length, 0);
});
test('embeddings and rerank cannot mix models or canary versions', async () => {
  for (const job of ['embeddings', 'rerank'] as const) {
    const h = harness(); h.routes.current.stage = 'canary';
    await assert.rejects(h.gateway.call({ ...request, job }), ModelRefusal);
    assert.equal(h.adapter.calls.length, 0);
  }
});

test('timeout retains the operation and never invokes a fallback', async () => {
  const h = fallbackHarness();
  h.adapter.invoke = async () => new Promise<ModelAdapterResult>(() => {});
  const result = await h.gateway.call(h.input);
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.metadata!.cost.minorUnits, request.estimatedCost.minorUnits);
  assert.equal(h.fallbackAdapter.calls.length, 0);
  assert.equal((await h.gateway.call(h.input)).outcome, 'outcome_unknown');
});
test('provider exceptions and over-cap receipts become unknown without exposing exception text', async () => {
  for (const invoke of [
    async (): Promise<ModelAdapterResult> => { throw new Error(request.prompt); },
    async (): Promise<ModelAdapterResult> => ({ kind: 'succeeded', text: 'PRIVATE_OUTPUT', costMinorUnits: '11', inputTokens: 1, outputTokens: 1 }),
  ]) {
    const h = harness(); h.adapter.invoke = invoke;
    assert.equal((await h.gateway.call(request)).outcome, 'outcome_unknown');
    assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
  }
});
test('replay and concurrent same-operation calls never invoke twice (test-double behavior only)', async () => {
  const h = harness();
  await Promise.all([h.gateway.call(request), h.gateway.call(request)]);
  assert.equal(h.adapter.calls.length, 1);
  await assert.rejects(h.gateway.call({ ...request, prompt: 'changed' }), ModelRefusal);
  assert.equal(h.adapter.calls.length, 1);
});
test('failed settlement does not claim success or retry the adapter', async () => {
  const h = harness(); h.store.failFinish = true;
  assert.equal((await h.gateway.call(request)).outcome, 'outcome_unknown');
  assert.equal((await h.gateway.call(request)).outcome, 'outcome_unknown');
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.logs.length, 0);
});
test('reconciliation uses only lookup of the original operation, and rejects another principal', async () => {
  const h = harness();
  h.adapter.invoke = async () => ({ kind: 'unknown' });
  await h.gateway.call(request);
  await assert.rejects(h.gateway.reconcile(request.operationId, 'other'), ModelRefusal);
  assert.equal(h.adapter.lookups.length, 0);
  assert.equal((await h.gateway.reconcile(request.operationId, request.principalId)).outcome, 'outcome_unknown');
  assert.deepEqual(h.adapter.lookups, [request.operationId]);
  h.adapter.reconcile = async () => ({ kind: 'succeeded', text: 'PRIVATE_OUTPUT', costMinorUnits: '2', inputTokens: 1, outputTokens: 1 });
  const result = await h.gateway.reconcile(request.operationId, request.principalId);
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.text, null);
  assert.equal(result.metadata!.model.modelRevision, candidate.modelRevision);
});


test('malformed adapter results retain unknown outcome and cannot trigger fallback', async () => {
  const h = fallbackHarness();
  // Runtime boundary intentionally violates the static interface.
  h.adapter.invoke = async () => null as never;
  assert.equal((await h.gateway.call(h.input)).outcome, 'outcome_unknown');
  assert.equal(h.fallbackAdapter.calls.length, 0);
});

test('an ambiguous fallback hold transfer never settles or releases the old hold', async () => {
  const h = fallbackHarness();
  h.store.fallback = async () => { throw new Error('PRIVATE_STORAGE_ERROR_CANARY'); };
  const result = await h.gateway.call(h.input);
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.metadata, null);
  assert.equal(h.store.rows.get(request.operationId)!.metadata, null);
  assert.equal(h.fallbackAdapter.calls.length, 0);
  assert.deepEqual(h.logs, []);
});

test('a hung reconciliation is bounded and never invokes again', async () => {
  const h = harness();
  h.adapter.invoke = async () => ({ kind: 'unknown' });
  await h.gateway.call(request);
  h.adapter.reconcile = async () => new Promise(() => {});
  const result = await h.gateway.reconcile(request.operationId, request.principalId);
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(h.adapter.calls.length, 0);
});


test('lost or ambiguous durable admission never invokes an adapter or releases the hold', async () => {
  for (const ambiguous of [false, true]) {
    const h = harness();
    h.store.admit = async () => { if (ambiguous) throw new Error('Synthetic ambiguous commit'); return false; };
    assert.equal((await h.gateway.call(request)).outcome, 'outcome_unknown');
    assert.equal(h.adapter.calls.length, 0);
    assert.equal(h.store.rows.get(request.operationId)!.metadata, null);
  }
});

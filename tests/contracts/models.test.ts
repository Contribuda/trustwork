import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCallMetadataSchema, ModelCallSchema, ResolvedModelRouteSchema } from '../../packages/contracts/src/models.js';
import { request, route } from '../models/fixtures.js';

test('model call: strict shape, typed authority context, private zero retention', () => {
  assert.ok(ModelCallSchema.safeParse(request).success);
  for (const patch of [{ mandateId: undefined }, { runId: undefined }, { prompt: 10 }, { requireZeroRetention: false }, { approval: 'go ahead' }, { allowedConnections: [] }, { residencyCountries: [] }, { dataClasses: ['public', 'public'] }]) {
    assert.equal(ModelCallSchema.safeParse({ ...request, ...patch }).success, false);
  }
});
test('model routes: exact revision, bounded candidate list and limits', () => {
  assert.ok(ResolvedModelRouteSchema.safeParse(route).success);
  for (const modelRevision of ['latest', 'model-latest', 'current', '', '   ', null]) {
    assert.equal(ResolvedModelRouteSchema.safeParse({ ...route, candidates: [{ ...route.candidates[0], modelRevision }] }).success, false);
  }
  assert.equal(ResolvedModelRouteSchema.safeParse({ ...route, candidates: [] }).success, false);
});
test('model metadata rejects bodies, person fields and unpinned revisions', () => {
  const metadata = { operationId: request.operationId, routeId: route.routeId, routeVersion: 1, model: route.candidates[0], stage: 'current', fallbackUsed: false,
    latencyMs: 1, inputTokens: 1, outputTokens: 1, cost: { minorUnits: '0', currency: 'USD' }, outcome: 'succeeded' };
  assert.ok(ModelCallMetadataSchema.safeParse(metadata).success);
  for (const field of ['prompt', 'response', 'text', 'principalId', 'reasoning', 'exception']) {
    assert.equal(ModelCallMetadataSchema.safeParse({ ...metadata, [field]: 'PRIVATE' }).success, false);
  }
});

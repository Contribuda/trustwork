import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateModelUsage, type PrivateUsageRow } from '../../apps/api/src/modules/models/usage.js';
import { ModelUsageAggregateSchema } from '../../packages/contracts/src/models.js';
import { candidate, request, route } from './fixtures.js';

function row(index: number, principalId = `synthetic-person-${index}`): PrivateUsageRow {
  return { principalId, participantType: 'professional', plan: 'basic', moduleKey: 'research', metadata: {
    operationId: `synthetic-operation-${index}`, routeId: route.routeId, routeVersion: 1, model: candidate, stage: 'current', fallbackUsed: index === 0,
    latencyMs: index, inputTokens: 1, outputTokens: 2, cost: request.estimatedCost, outcome: index === 0 ? 'failed' : 'succeeded',
  } };
}
test('cohorts suppress nine distinct principals and ten thousand calls from one person', () => {
  assert.deepEqual(aggregateModelUsage(Array.from({ length: 9 }, (_, i) => row(i))), []);
  assert.deepEqual(aggregateModelUsage(Array.from({ length: 10_000 }, (_, i) => row(i, 'one-person'))), []);
});
test('ten distinct principals produce only a strict aggregate with exact integer costs', () => {
  const result = aggregateModelUsage(Array.from({ length: 10 }, (_, i) => row(i)));
  assert.equal(result.length, 1);
  assert.ok(ModelUsageAggregateSchema.safeParse(result[0]).success);
  assert.equal(result[0]!.participants, 10);
  assert.equal(result[0]!.costMinorUnits, '100');
  assert.equal(result[0]!.latencyP50Ms, 4);
  assert.equal(result[0]!.latencyP95Ms, 9);
  assert.ok(!JSON.stringify(result).includes('person'));
  assert.ok(!JSON.stringify(result).includes('operation'));
});
test('pins, currencies, rollout stages and cohorts are never combined to reach the privacy threshold', () => {
  const changes: ((r: PrivateUsageRow) => void)[] = [
    (r) => { r.metadata.model = { ...candidate, modelRevision: 'different-revision' }; },
    (r) => { r.metadata.routeVersion = 2; },
    (r) => { r.metadata.stage = 'canary'; },
    (r) => { r.metadata.cost = { ...request.estimatedCost, currency: 'EUR' }; },
    (r) => { r.participantType = 'company'; },
    (r) => { r.plan = 'different-plan'; },
    (r) => { r.moduleKey = 'procurement'; },
  ];
  for (const change of changes) {
    const rows = Array.from({ length: 10 }, (_, i) => row(i));
    change(rows[0]!);
    assert.deepEqual(aggregateModelUsage(rows), []);
  }
});
test('duplicate operations cannot inflate billing or participant counts', () => {
  assert.throws(() => aggregateModelUsage([row(1), row(1)]), /Duplicate operation/);
});

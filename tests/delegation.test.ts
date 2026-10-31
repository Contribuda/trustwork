import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDelegation, type Delegation, type PlannedAction } from '../packages/contracts/src/index.js';
const now = new Date('2026-10-26T12:00:00Z');
const grant: Delegation = { actions: ['place_order'], contextId: 'project-a', expiresAt: '2026-10-27T12:00:00Z', revoked: false, ceiling: { currency: 'UZS', minorUnits: '10000' } };
const request: PlannedAction = { action: 'place_order', contextId: 'project-a', amount: { currency: 'UZS', minorUnits: '10000' } };
test('permits an exact authorized ceiling', () => assert.equal(evaluateDelegation(grant, request, now), 'allow'));
for (const [name, override] of Object.entries({
  revoked: { revoked: true },
  expired: { expiresAt: now.toISOString() },
  invalidExpiry: { expiresAt: 'invalid' },
  otherContext: { contextId: 'project-b' },
  noAuthority: { actions: [] },
})) {
  test(`denies ${name}`, () => assert.equal(evaluateDelegation({ ...grant, ...override } as Delegation, request, now), 'deny'));
}
for (const amount of [
  { currency: 'UZS', minorUnits: '10001' },
  { currency: 'USD', minorUnits: '1' },
  { currency: 'UZS', minorUnits: '-1' },
  { currency: 'UZS', minorUnits: '1.2' },
]) {
  test(`denies invalid or excess amount ${JSON.stringify(amount)}`, () => assert.equal(evaluateDelegation(grant, { ...request, amount }, now), 'deny'));
}

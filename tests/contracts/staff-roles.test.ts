import test from 'node:test';
import assert from 'node:assert/strict';
import { PrincipalSchema } from '../../packages/contracts/src/access.js';
import { HUB_STAFF_ROLES } from '../../packages/contracts/src/hub.js';

test('the principal carries the console staff vocabulary (platform roles plus hub roles)', () => {
  const staff = PrincipalSchema.shape.staff.element.options;
  assert.deepEqual([...staff].sort(), [...HUB_STAFF_ROLES].sort());
  const base = { personId: 'p1', emailVerified: true, authenticatedAt: '2026-11-01T10:00:00.000Z', authzEpoch: 1, membership: null, delegation: null };
  assert.ok(PrincipalSchema.safeParse({ ...base, staff: ['hub-owner', 'node-operator'] }).success);
  assert.ok(!PrincipalSchema.safeParse({ ...base, staff: ['root'] }).success);
});

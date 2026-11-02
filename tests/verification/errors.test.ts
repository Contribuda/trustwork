import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorityRefusal, verificationRefusal } from '../../apps/api/src/modules/verification/errors.js';

/** HUB-003: database refusals become contract errors; authority refusals stay 403 and leave a denied audit row. */
test('authority refusals are access.forbidden; conflicts are revision conflicts; existence never leaks', () => {
  const as = (code: string, hint: string) => verificationRefusal({ code, hint });
  for (const hint of ['verification.original_reviewer', 'verification.own_appeal', 'admin.forbidden', 'admin.elevation_required']) {
    const r = as('42501', hint);
    assert.equal(r?.code, 'access.forbidden', hint);
    assert.ok(r && isAuthorityRefusal(r), hint);
  }
  assert.equal(as('42501', 'admin.approval_required')?.code, 'access.second_approver_required');
  for (const hint of ['verification.appeal_open', 'verification.invalid_transition', 'verification.revision_conflict']) assert.equal(as('23505', hint)?.code, 'validation.revision_conflict', hint);
  assert.equal(as('P0002', 'admin.not_found')?.code, 'access.not_found');
  assert.equal(as('23514', 'verification.sanctions_required')?.code, 'validation.schema');
  assert.equal(verificationRefusal(new Error('not a database error')), null);
});

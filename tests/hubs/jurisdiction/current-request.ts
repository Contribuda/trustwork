import assert from 'node:assert/strict';
import type { Harness, Response } from '../../backend/helpers/app.js';

/** Interpose after real API authentication, before the real command transaction establishes its principal. */
export async function staleRequest(h: Harness, request: () => Promise<Response>): Promise<void> {
  const principals = h.services().principals;
  const original = principals.runAs;
  let calls = 0;
  let executions = 0;
  principals.runAs = async function (state, fn, options) {
    calls++;
    const principal = state.principal;
    const snapshot = structuredClone(state);
    assert.ok(principal);
    await h.db.admin.query('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [principal.personId]);
    try {
      return await original.call(principals, state, async (trx, p) => { executions++; return fn(trx, p); }, options);
    } finally {
      assert.equal(state.principal, principal);
      assert.deepEqual(state, snapshot);
    }
  } as typeof original;
  try {
    const response = await request();
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal((response.body as { code: string }).code, 'validation.revision_conflict');
    assert.equal(calls, 1);
    assert.equal(executions, 0);
  } finally {
    principals.runAs = original;
  }
}

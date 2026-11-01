import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { installCrashPoints, recordState } from '../../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../../apps/api/src/common/idempotency/index.js';
import type { CrashContext, CrashRoute } from '../../backend/idempotency/cases.js';
import feeCase from '../../backend/idempotency/cases/billing-fees.js';
import { feeWorld } from './helpers.js';

const h = await startHarness('fee_crash');
test('BILL-003 bounded real PostgreSQL crash suite', { skip:h?false:SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(()=>h.close());
  await feeWorld(h.db.admin,h.pool);
  const crash = await installCrashPoints(h.db.admin);
  const exactlyOnce = async (route: CrashRoute) => {
    const key = 'crash-'+route.action;
    const before = await route.effects();
    const send = () => route.client.post(route.url,route.body,{idempotencyKey:key});
    try {
      await crash.arm('handler','bookkeeping');
      assert.equal((await send()).status,500);
      assert.equal(await route.effects(),before);
      assert.equal((await recordState(h.db.admin,key))?.state,'in_progress');
      await crash.disarm('handler');
      assert.equal((await send()).status,409);
      h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS+1000);
      const done=await send();
      assert.ok(done.status>=200&&done.status<300,JSON.stringify(done.body));
      assert.equal((await recordState(h.db.admin,key))?.state,'completed');
      assert.equal(await route.effects(),before+1);
      h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS+1000);
      const retry=await send();assert.deepEqual(retry.body,done.body);
      assert.equal(await route.effects(),before+1);
      return done;
    } finally {await crash.clear();h.clock.reset();}
  };
  await feeCase.run({h,exactlyOnce} as CrashContext);
});

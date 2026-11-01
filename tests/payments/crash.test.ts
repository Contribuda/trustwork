import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, SKIP_REASON, type Response } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { installCrashPoints, recordState } from '../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../apps/api/src/common/idempotency/index.js';
import paymentCases from '../backend/idempotency/cases/payments.js';

const h = await startHarness('payments_crash');
test('PAY-001: all fourteen HTTP commands survive crashes before/after commit without repeating effects', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const crash = await installCrashPoints(h.db.admin);
  const covered: string[] = [];
  await paymentCases.run({ h, seed, as: async (key) => { const c = h.client(); await login(c, key); return c; },
    exactlyOnce: async (route): Promise<Response> => {
      const key = `payments-crash-${route.action}`;
      const before = await route.effects();
      const send = () => route.client.post(route.url, route.body, { idempotencyKey: key });
      try {
        await crash.arm('handler', 'bookkeeping');
        assert.equal((await send()).status, 500, route.action);
        assert.equal(await route.effects(), before);
        assert.equal((await recordState(h.db.admin, key))?.state, 'in_progress');
        await crash.disarm('handler');
        assert.equal((await send()).status, 409);
        h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
        const done = await send();
        assert.ok(done.status >= 200 && done.status < 300, JSON.stringify(done.body));
        assert.equal((await recordState(h.db.admin, key))?.state, 'completed');
        assert.equal(await route.effects(), before + 1);
        h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
        const replay = await send();
        assert.deepEqual(replay.body, done.body);
        assert.equal(replay.status, done.status);
        assert.equal(await route.effects(), before + 1);
        covered.push(route.action); return done;
      } finally { await crash.clear(); h.clock.reset(); }
    },
  });
  assert.deepEqual(covered.sort(), ['payments.authorization_accept', 'payments.authorization_draft', 'payments.confirm', 'payments.connected_account', 'payments.create', 'payments.outside_accept', 'payments.outside_draft', 'payments.payout', 'payments.refund', 'payments.source_challenge', 'payments.source_review_activate', 'payments.source_review_material', 'payments.source_revoke', 'payments.source_staff_revoke']);
});

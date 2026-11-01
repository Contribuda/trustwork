import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError } from '../../../backend/helpers/app.js';
import { screeningWorld } from './world.js';
import { installCrashPoints, recordState } from '../../../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../../../apps/api/src/common/idempotency/index.js';
import { manualRescreenWindow } from '../../../../apps/api/src/modules/screening/rescreen.controller.js';

test('SANC-006 manual run uses the worker bounds', () => {
  assert.equal(manualRescreenWindow({}), 21600);
  assert.equal(manualRescreenWindow({ RESCREEN_WINDOW_HOURS: '168' }), 604800);
  for (const value of ['0', '169', '1.5', 'no']) assert.throws(() => manualRescreenWindow({ RESCREEN_WINDOW_HOURS: value }));
});

test('SANC-006 real API authorization, required reason and serialized manual requests', { timeout: 240_000 }, async (t) => {
  const w = await screeningWorld('sanc006_api');
  t.after(() => w.close());
  const route = '/v1/admin/screening/rescreen-runs';
  await t.test('anonymous, subject and non-elevated staff cannot request or read runs', async () => {
    expectError(await w.h.client().get(route), 401, 'auth.session_invalid');
    expectError(await w.subject.get(route), 403, 'access.forbidden');
    expectError(await w.subject.post(route, { reason: 'Synthetic' }), 403, 'access.forbidden');
    expectError(await w.unelevated.get(route), 403, 'access.forbidden');
    expectError(await w.unelevated.post(route, { reason: 'Synthetic' }), 403, 'access.forbidden');
    expectError(await w.first.post(route, { reason: '  ' }), 422, 'validation.schema');
    expectError(await w.first.post(route, { reason: 'Synthetic', windowSeconds: 1 }), 422, 'validation.unknown_field');
    expectError(await w.first.post(route, { reason: 'Synthetic' }, { csrf: 'cross-site' }), 403, 'auth.csrf_rejected');
  });
  await t.test('racing officers receive one unfinished full run; retry replays the committed response and audit', async () => {
    const [one, two] = await Promise.all([
      w.first.post(route, { reason: 'Synthetic first review' }, { idempotencyKey: 'sanc006-first' }),
      w.second.post(route, { reason: 'Synthetic second review' }, { idempotencyKey: 'sanc006-second' }),
    ]);
    assert.equal(one.status, 200, JSON.stringify(one.body)); assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.equal((one.body as { id: string }).id, (two.body as { id: string }).id);
    assert.equal((one.body as { progress: unknown }).progress, null);
    assert.ok(!('subjectsDone' in (one.body as object)), 'raw counters are absent even from command responses');
    const retry = await w.first.post(route, { reason: 'Synthetic first review' }, { idempotencyKey: 'sanc006-first' });
    assert.deepEqual(retry.body, one.body);
    const counts = await w.h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.screening_rescreen_run WHERE mode = 'full'");
    assert.equal(counts.rows[0]?.n, 1);
    const audits = await w.h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action = 'screening.rescreen_requested'");
    assert.equal(audits.rows[0]?.n, 2);
    assert.equal((await w.first.get(route)).status, 200);
  });
  await t.test('crash before commit rolls back the audit; takeover and replay complete exactly once', async () => {
    const crash = await installCrashPoints(w.h.db.admin);
    const auditCount = async () => (await w.h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action = 'screening.rescreen_requested'")).rows[0]!.n;
    const before = await auditCount();
    const key = 'sanc006-crash';
    const send = () => w.first.post(route, { reason: 'Synthetic crash request' }, { idempotencyKey: key });
    try {
      await crash.arm('handler', 'bookkeeping');
      assert.equal((await send()).status, 500);
      assert.equal(await auditCount(), before);
      expectError(await send(), 409, 'validation.idempotency_in_progress');
      await crash.disarm('handler');
      w.h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
      const done = await send(); assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal((await recordState(w.h.db.admin, key))?.state, 'completed');
      assert.equal(await auditCount(), before + 1);
      w.h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
      assert.deepEqual((await send()).body, done.body);
      assert.equal(await auditCount(), before + 1);
    } finally { await crash.clear(); w.h.clock.reset(); }
  });

});

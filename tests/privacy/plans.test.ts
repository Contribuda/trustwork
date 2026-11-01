import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { privacyWorld } from './helpers.js';
import { privacyPlanFixture } from './plan-fixture.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { caseGrants } from '../../packages/data/src/repositories/admin.js';
import { PRIVACY_MODULE_INVENTORY } from '../../apps/api/src/modules/platform-admin/privacy/inventory.js';
import { gate } from '../worker/helpers/worker-db.js';

test('PRV human subject plans: digest, authority and same-transaction admission', async (t) => {
  const h = await startHarness('privacy_plan');
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(() => h.close());
  const w = await privacyWorld(h);
  const prepare = async (country = 'US') => {
    const f = await privacyPlanFixture(h, w, country);
    const plan = await w.as(w.people.officer, (trx) => privacy.proposePlan(trx, f.ctx, f.request.id, f.first.id));
    return { ...f, plan };
  };
  const approve = (f: Awaited<ReturnType<typeof prepare>>) => w.as(w.people.reviewer, (trx) => privacy.approvePlan(trx, f.reviewCtx, f.plan.id, f.second.id, f.plan.digest));
  const execute = (f: Awaited<ReturnType<typeof prepare>>) => w.as(w.people.officer, (trx) => privacy.executePlan(trx, f.ctx, f.plan.id, f.plan.digest));
  await t.test('only current humans with exact case grants can propose, approve and execute; no self-approval', async () => {
    const f = await prepare();
    assert.deepEqual(f.plan.snapshot.inventory, [...PRIVACY_MODULE_INVENTORY]);
    await assert.rejects(w.as(w.people.subject, (trx) => privacy.proposePlan(trx, f.ctx, f.request.id, f.first.id)));
    await assert.rejects(w.as(w.people.officer, (trx) => privacy.approvePlan(trx, f.ctx, f.plan.id, f.first.id, f.plan.digest)), (e: { hint?: string }) => e.hint === 'admin.self_approval');
    await assert.rejects(w.as(w.people.reviewer, (trx) => privacy.approvePlan(trx, f.reviewCtx, f.plan.id, f.second.id, '0'.repeat(64))), (e: { hint?: string }) => e.hint === 'privacy.plan_changed');
    await approve(f);
    await assert.rejects(w.as(w.people.reviewer, (trx) => privacy.executePlan(trx, f.reviewCtx, f.plan.id, f.plan.digest)));
    const result = await execute(f);
    assert.equal(result.reason, 'country_policy_UNKNOWN'); assert.equal(result.complete, false);
    assert.equal((await h.db.admin.query('SELECT status FROM trustwork.second_person_approval WHERE id=$1', [f.plan.approvalId])).rows[0].status, 'approved');
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_replay_receipt')).rows[0].n, 0);
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.privacy_subject_plan'), /permission denied/);
  });
  await t.test('reviewed synthetic policy cannot manufacture missing owning-module capabilities', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('privacy_country_policy').values({ country: 'ZZ', version: 'synthetic-plan-1', review: 'verified', sources: JSON.stringify(['https://example.invalid/synthetic-policy']),
      deadline_days: 3, retention_days: 0, registry_poll_hours: null, registry_deadline_days: null }).execute());
    const f = await prepare('ZZ'); await approve(f);
    const result = await execute(f);
    assert.equal(result.reason, 'owning_module_capabilities_unavailable');
    assert.deepEqual(result.gaps.map((r) => r.module), [...PRIVACY_MODULE_INVENTORY]);
    assert.ok(result.gaps.every((r) => r.action === 'unavailable' && r.gap.endsWith('.authorized_subject_retention_and_erasure')));
  });
  await t.test('a hold winning the race invalidates the approved subject digest', async () => {
    const f = await prepare(); await approve(f);
    const locked = gate(); const release = gate();
    const hold = w.as(w.people.officer, async (trx) => { await privacy.hold(trx, f.ctx, f.request.id, 'litigation', randomUUID()); locked.open(); await release.promise; });
    await locked.promise; const execution = execute(f); release.open(); await hold;
    assert.equal((await execution).status, 'invalidated');
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_replay_receipt')).rows[0].n, 0);
  });
  await t.test('a concurrent reviewer grant revoker blocks execution', async () => {
    const f = await prepare(); await approve(f);
    const locked = gate(); const release = gate();
    const revocation = w.as(w.people.officer, async (trx) => { await caseGrants.revoke(trx, f.ctx, f.second.id); locked.open(); await release.promise; });
    await locked.promise; const execution = assert.rejects(execute(f), (e: { hint?: string }) => e.hint === 'privacy.case_grant_required');
    release.open(); await revocation; await execution;
  });
  await t.test('a changed retention policy invalidates a previously approved digest', async () => {
    const f = await prepare('ZZ'); await approve(f);
    await h.db.admin.query("UPDATE trustwork.privacy_country_policy SET version='synthetic-plan-2', retention_days=1 WHERE country='ZZ'");
    assert.equal((await execute(f)).status, 'invalidated');
  });
});

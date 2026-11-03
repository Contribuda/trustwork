import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { PublicPricingSchema, StaffReferralSchema, type PublicReferral } from '../../../packages/contracts/src/billing-fees.js';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { feeHttpWorld } from './http-helpers.js';

const h = await startHarness('fee_referral_api');
test('BILL-003 referral commands over HTTP use actual authentication, scope and elevation', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w = await feeHttpWorld(h);
  t.after(async () => { await w.app.close(); await h.close(); });
  const url = '/v1/admin/billing/referrals';
  const terms = {
    programmeKey: 'synthetic_invite', eligibleParties: 'person', rewardKind: 'platform_credit', currency: 'USD', referrerRewardMinor: '500', refereeRewardMinor: '0', maxRewardsPerReferrer: null,
    effectiveFrom: new Date(Date.now() + 60000).toISOString(), effectiveTo: new Date(Date.now() + 3600000).toISOString(), acceptanceTextVersion: 'synthetic-referral-1',
    publicTerms: { en: 'Synthetic referral terms', es: 'Condiciones sintéticas' },
  };
  const body = { reason: 'Synthetic referral API test', terms, legalReviewRef: 'synthetic-counsel-review-1' };
  await t.test('anonymous and un-elevated staff can neither draft nor read staff versions', async () => {
    assert.equal((await w.anonymous.post(url, body)).status, 401);
    assert.equal((await w.anonymous.get(url)).status, 401);
    assert.equal((await w.clients.owner.post(url, body)).status, 403);
    assert.equal((await w.clients.owner.get(url)).status, 403);
  });
  await w.elevate();
  await t.test('participants and staff of another hub are refused', async () => {
    assert.equal((await w.clients.outsider.post(url, body)).status, 403);
    assert.equal((await w.clients.otherOwner.post(url, body)).status, 403);
    assert.equal((await w.clients.outsider.get(url)).status, 403);
  });
  await t.test('the body cannot name a hub, an authority, cash or a discovery control', async () => {
    for (const extra of [{ hubId: w.hubB }, { activatedBy: w.p.officer }, { permissions: ['admin.growth.referrals.activate'] }]) {
      assert.equal((await w.clients.owner.post(url, { ...body, ...extra })).status, 422);
    }
    for (const change of [{ rewardKind: 'cash' }, { ranking: 1 }, { matching: true }, { reputation: 1 }, { personId: w.p.outsider }]) {
      assert.equal((await w.clients.owner.post(url, { ...body, terms: { ...terms, ...change } })).status, 422, JSON.stringify(change));
    }
    assert.equal((await w.clients.owner.post(url, { ...body, legalReviewRef: '' })).status, 422, 'terms without a counsel review reference are refused');
  });
  const drafted = await w.clients.owner.post(url, body, { idempotencyKey: 'synthetic-referral-create' });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  const r = drafted.body as PublicReferral;
  await t.test('a retried draft returns the exact original and nothing is public yet', async () => {
    assert.deepEqual((await w.clients.owner.post(url, body, { idempotencyKey: 'synthetic-referral-create' })).body, r);
    assert.deepEqual(PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body).referrals, []);
  });
  await t.test('activation refuses a missing approval and the drafter', async () => {
    const action = { reason: body.reason, digest: r.digest, approvalId: randomUUID() };
    assert.equal((await w.clients.officer.post(`${url}/${r.id}/activate`, action)).status, 403);
    assert.equal((await w.clients.owner.post(`${url}/${r.id}/activate`, action)).status, 403);
  });
  const request = await w.a.cmd(w.p.officer, (trx, ctx) => approvals.request(trx, ctx, { action: 'growth.activate_referral_terms', scope: { kind: 'hub', hubId: w.hubA }, actionDigest: r.digest }));
  await w.a.cmd(w.p.owner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', r.digest));
  await t.test('the exact approval activates; anonymous and signed-in readers see the same disclosure without private fields', async () => {
    const action = { reason: body.reason, digest: r.digest, approvalId: request.id };
    const activated = await w.clients.officer.post(`${url}/${r.id}/activate`, action, { idempotencyKey: 'synthetic-referral-activate' });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.deepEqual((await w.clients.officer.post(`${url}/${r.id}/activate`, action, { idempotencyKey: 'synthetic-referral-activate' })).body, activated.body);
    const anonymous = PublicPricingSchema.parse((await w.anonymous.get(`/v1/pricing?hubId=${w.hubB}`)).body);
    assert.deepEqual(anonymous.referrals, [r]);
    assert.equal(anonymous.coverage?.sections.referrals, 'available');
    assert.deepEqual(PublicPricingSchema.parse((await w.clients.outsider.get('/v1/pricing')).body).referrals, [r]);
    for (const secret of [body.legalReviewRef, w.p.owner, w.p.officer, request.id]) assert.ok(!JSON.stringify(anonymous).includes(secret), secret);
  });
  await t.test('staff read the version with its lifecycle at their own hub', async () => {
    const list = StaffReferralSchema.array().parse((await w.clients.owner.get(url)).body);
    assert.equal(list.length, 1); assert.equal(list[0]?.status, 'active'); assert.equal(list[0]?.legalReviewRef, body.legalReviewRef);
  });
  await t.test('a reader failure is an explicit error and keeps the sibling sections', async () => {
    await h.db.admin.query('REVOKE EXECUTE ON FUNCTION trustwork.billing_referral_list(uuid) FROM trustwork_app');
    try {
      const view = PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
      assert.equal(view.coverage?.sections.referrals, 'error'); assert.deepEqual(view.referrals, []);
      assert.ok(view.unavailable.includes('referrals'));
      assert.equal(view.coverage?.sections.fees, 'available');
    } finally { await h.db.admin.query('GRANT EXECUTE ON FUNCTION trustwork.billing_referral_list(uuid) TO trustwork_app'); }
  });
  await t.test('withdrawal removes the terms from the public page', async () => {
    const stopped = await w.clients.officer.post(`${url}/${r.id}/withdraw`, { reason: 'Synthetic stop', digest: r.digest });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.deepEqual(PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body).referrals, []);
  });
  await t.test('a closed hub publishes no referral terms', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('hub').set({ lifecycle: 'closed' }).where('id', '=', w.hubA).execute());
    const closed = PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
    assert.deepEqual(closed.referrals, []); assert.equal(closed.coverage?.sections.referrals, 'unavailable');
  });
});

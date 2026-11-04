import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { PublicPricingSchema, StaffFeeSchema, StaffSalePriceSchema, type SalePriceVersion } from '../../../packages/contracts/src/billing-fees.js';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { feeHttpWorld } from './http-helpers.js';

const h = await startHarness('fee_sale_api');
test('BILL-003 sale price commands and console reads over HTTP', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w = await feeHttpWorld(h);
  t.after(async () => { await w.app.close(); await h.close(); });
  const url = '/v1/admin/billing/sale-prices';
  const terms = {
    kind: 'credit_pack', code: 'synthetic_pack', name: 'Synthetic pack', currency: 'USD', amountMinor: '9223372036854775807', creditMinor: '1000', validityDays: 90, expiryNoticeDays: 14,
    refundPolicyVersion: 'synthetic-refund-1', effectiveFrom: new Date(Date.now() + 60000).toISOString(), effectiveTo: null, acceptanceTextVersion: 'synthetic-sale-1',
  };
  const body = { reason: 'Synthetic sale API test', terms };
  await t.test('anonymous and un-elevated staff can neither draft nor read staff versions', async () => {
    assert.equal((await w.anonymous.post(url, body)).status, 401);
    for (const path of [url, '/v1/admin/billing/fees']) {
      assert.equal((await w.anonymous.get(path)).status, 401);
      assert.equal((await w.clients.owner.get(path)).status, 403);
    }
    assert.equal((await w.clients.owner.post(url, body)).status, 403);
  });
  await w.elevate();
  await t.test('participants and staff of another hub are refused', async () => {
    assert.equal((await w.clients.outsider.post(url, body)).status, 403);
    assert.equal((await w.clients.otherOwner.post(url, body)).status, 403);
    for (const path of [url, '/v1/admin/billing/fees']) assert.equal((await w.clients.outsider.get(path)).status, 403);
  });
  await t.test('the body cannot name a hub, an authority, a cost or a discovery control', async () => {
    for (const extra of [{ hubId: w.hubB }, { activatedBy: w.p.officer }]) assert.equal((await w.clients.owner.post(url, { ...body, ...extra })).status, 422);
    assert.equal((await w.clients.officer.post(`${url}/${randomUUID()}/activate`, { reason: 'Synthetic', digest: 'a'.repeat(64), approvalId: randomUUID(), supersedePrevious: true })).status, 422, 'a bare flag is no longer accepted');
    for (const change of [{ ranking: 1 }, { reputation: 1 }, { providerCost: '1' }, { personId: w.p.outsider }, { expiryNoticeDays: null }, { kind: 'plan' }]) {
      assert.equal((await w.clients.owner.post(url, { ...body, terms: { ...terms, ...change } })).status, 422, JSON.stringify(change));
    }
  });
  const drafted = await w.clients.owner.post(url, body, { idempotencyKey: 'synthetic-sale-create' });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  const v = drafted.body as SalePriceVersion;
  await t.test('a retried draft returns the exact original and nothing is public yet', async () => {
    assert.deepEqual((await w.clients.owner.post(url, body, { idempotencyKey: 'synthetic-sale-create' })).body, v);
    assert.deepEqual(PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body).prices, []);
  });
  await t.test('activation refuses a missing approval and the drafter', async () => {
    const action = { reason: body.reason, digest: v.digest, approvalId: randomUUID() };
    assert.equal((await w.clients.officer.post(`${url}/${v.id}/activate`, action)).status, 403);
    assert.equal((await w.clients.owner.post(`${url}/${v.id}/activate`, action)).status, 403);
  });
  const request = await w.a.cmd(w.p.officer, (trx, ctx) => approvals.request(trx, ctx, { action: 'commerce.activate_price_version', scope: { kind: 'hub', hubId: w.hubA }, actionDigest: v.activationDigest }));
  await w.a.cmd(w.p.owner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', v.activationDigest));
  await t.test('the exact approval publishes the pack with its validity; every reader sees the same version', async () => {
    const action = { reason: body.reason, digest: v.digest, approvalId: request.id };
    const activated = await w.clients.officer.post(`${url}/${v.id}/activate`, action, { idempotencyKey: 'synthetic-sale-activate' });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.deepEqual((await w.clients.officer.post(`${url}/${v.id}/activate`, action, { idempotencyKey: 'synthetic-sale-activate' })).body, activated.body);
    const anonymous = PublicPricingSchema.parse((await w.anonymous.get(`/v1/pricing?hubId=${w.hubB}`)).body);
    assert.equal(anonymous.prices.length, 1);
    assert.equal(anonymous.prices[0]?.kind, 'credit_pack'); assert.equal(anonymous.prices[0]?.validity, 'P90D');
    assert.equal(anonymous.prices[0]?.amountMinor, '9223372036854775807', 'exact minor units survive the projection');
    assert.deepEqual(PublicPricingSchema.parse((await w.clients.outsider.get('/v1/pricing')).body).prices, anonymous.prices);
    for (const secret of [w.p.owner, w.p.officer, request.id]) assert.ok(!JSON.stringify(anonymous).includes(secret), secret);
  });
  await t.test('with every reader working the catalogue reports complete coverage', async () => {
    const view = PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
    assert.ok(Object.values(view.coverage!.sections).every((s) => s === 'available'));
    assert.deepEqual(view.unavailable, []);
  });
  await t.test('console reads return every version with its lifecycle', async () => {
    const prices = StaffSalePriceSchema.array().parse((await w.clients.owner.get(url)).body);
    assert.equal(prices[0]?.status, 'active'); assert.equal(prices[0]?.activatedBy, w.p.officer);
    assert.deepEqual(StaffFeeSchema.array().parse((await w.clients.owner.get('/v1/admin/billing/fees')).body), []);
  });
  await t.test('one failed reader marks its section only and hides none of the others', async () => {
    await h.db.admin.query('REVOKE EXECUTE ON FUNCTION trustwork.billing_sale_price_list(uuid,text) FROM trustwork_app');
    try {
      const view = PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
      assert.equal(view.coverage?.sections.credit_packs, 'error'); assert.equal(view.coverage?.sections.models, 'error');
      assert.equal(view.coverage?.sections.fees, 'available');
      assert.ok(view.unavailable.includes('credit_packs'));
      assert.deepEqual(view.prices, []);
    } finally { await h.db.admin.query('GRANT EXECUTE ON FUNCTION trustwork.billing_sale_price_list(uuid,text) TO trustwork_app'); }
  });
});

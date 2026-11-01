import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { PublicPricingSchema, type PublicFee } from '../../../packages/contracts/src/billing-fees.js';
import { catalogue } from '../../../packages/data/src/repositories/billing.js';
import { SubscriptionPlanVersionSchema } from '../../../packages/contracts/src/agent-catalog.js';
import { feeHttpWorld } from './http-helpers.js';
import { syntheticTerms } from './helpers.js';

const h = await startHarness('fee_api');
test('BILL-003 public pricing and commands use actual authentication, scope and elevation', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w = await feeHttpWorld(h);
  t.after(async () => { await w.app.close(); await h.close(); });
  const url = '/v1/admin/billing/fees';
  const body = { reason: 'Synthetic API governance test', terms: syntheticTerms() };
  await t.test('public empty catalogue does not invent rates or require a login', async () => {
    const r = await w.anonymous.get('/v1/pricing');
    assert.equal(r.status, 200);
    const p = PublicPricingSchema.parse(r.body);
    assert.deepEqual(p.fees, []); assert.deepEqual(p.prices, []);
    assert.deepEqual(new Set(p.unavailable), new Set(['fees', 'plans', 'models', 'capabilities', 'credit_packs']));
  });
  await t.test('anonymous and un-elevated staff cannot draft', async () => {
    assert.equal((await w.anonymous.post(url, body)).status, 401);
    assert.equal((await w.clients.owner.post(url, body)).status, 403);
  });
  await w.elevate();
  await t.test('participants and staff of another hub cannot elevate or draft', async () => {
    assert.equal((await w.clients.outsider.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: '000000' } })).status, 403);
    assert.equal((await w.clients.outsider.post(url, body)).status, 403);
    assert.equal((await w.clients.otherOwner.post(url, body)).status, 403);
  });
  await t.test('caller cannot supply hub, staff authority or ranking controls', async () => {
    for (const extra of [{ hubId: w.hubB }, { activatedBy: w.p.officer }, { permissions: ['admin.billing.fees.activate'] }]) {
      assert.equal((await w.clients.owner.post(url, { ...body, ...extra })).status, 422);
    }
    assert.equal((await w.clients.owner.post(url, { ...body, terms: { ...body.terms, ranking: 1 } })).status, 422);
  });
  const r = await w.clients.owner.post(url, body, { idempotencyKey: 'synthetic-fee-create' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); const f = r.body as PublicFee;
  await t.test('draft retry returns the exact original version', async () => {
    const retry = await w.clients.owner.post(url, body, { idempotencyKey: 'synthetic-fee-create' });
    assert.deepEqual(retry.body, f);
    assert.equal((await w.anonymous.get('/v1/pricing')).status, 200);
    assert.deepEqual(PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body).fees, []);
  });
  await t.test('activation refuses missing real approval and self-activation', async () => {
    const action = { reason: body.reason, digest: f.digest, approvalId: randomUUID() };
    assert.equal((await w.clients.officer.post(`${url}/${f.id}/activate`, action)).status, 403);
    assert.equal((await w.clients.owner.post(`${url}/${f.id}/activate`, action)).status, 403);
  });
  const approvalId = await w.approve(f);
  await t.test('exact scoped approval activates; public API has no private staff fields or cross-hub override', async () => {
    const action = { reason: body.reason, digest: f.digest, approvalId };
    const activated = await w.clients.officer.post(`${url}/${f.id}/activate`, action, { idempotencyKey: 'synthetic-fee-activate' });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const retry = await w.clients.officer.post(`${url}/${f.id}/activate`, action, { idempotencyKey: 'synthetic-fee-activate' });
    assert.deepEqual(retry.body, activated.body);
    const publicResponse = await w.anonymous.get(`/v1/pricing?hubId=${w.hubB}`);
    const p = PublicPricingSchema.parse(publicResponse.body);
    assert.deepEqual(p.fees, [f]); assert.equal(p.hubId, w.hubA);
    for (const privateValue of [w.p.owner, w.p.officer, approvalId, 'drafted_by', 'approval_id']) assert.ok(!JSON.stringify(p).includes(privateValue));
  });
  await t.test('public catalogue projects actual active plan and service versions, hides draft, other hub and unimplemented credit validity',async()=>{
    const versions=await withMaintenance(h.db.admin,async(trx)=>{
      const create=async(code:string,kind:'plan'|'deliverable'|'credit_pack',hubId=w.hubA,active=true)=>{
        const offer=await catalogue.createOffer(trx,{hubId,code,name:'Synthetic '+code,kind,createdBy:w.p.owner,status:'active'});
        const price=await catalogue.draftPriceVersion(trx,{offerId:offer.id,amountMinor:'12345',currency:'USD',
          effectiveFrom:new Date(Date.now()+3600000),effectiveTo:new Date(Date.now()+7200000),acceptanceTextVersion:'synthetic-prices-1',draftedBy:w.p.owner});
        if(active)await catalogue.activatePriceVersion(trx,price.id,w.p.officer);
        return {offer,price};
      };
      const plan=await create('synthetic_plan','plan');
      const planId=randomUUID();
      const payload=SubscriptionPlanVersionSchema.parse({id:planId,offerId:plan.offer.id,version:1,payerKind:'person',moduleKeys:['consultation'],includedQuota:[],
        connections:1,channels:0,representativeIncluded:false,priceVersionId:plan.price.id,status:'draft'});
      await trx.insertInto('subscription_plan_version').values({id:planId,offer_id:plan.offer.id,version:1,payer_kind:'person',payload:JSON.stringify(payload),price_version_id:plan.price.id,drafted_by:w.p.owner}).execute();
      await catalogue.activatePlanVersion(trx,planId,w.p.officer);
      const service=await create('synthetic_service','deliverable');
      await create('synthetic_draft','deliverable',w.hubA,false);await create('synthetic_other_hub','deliverable',w.hubB);
      await create('synthetic_credit_without_validity','credit_pack');
      return {plan,planId,service};
    });
    const view=PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
    assert.deepEqual(view.prices.map(p=>p.code),['synthetic_plan','synthetic_service']);
    assert.deepEqual(view.prices[0]?.planVersion,{id:versions.planId,version:1});
    assert.equal(view.prices[0]?.id,versions.plan.price.id);
    assert.equal(view.prices[1]?.id,versions.service.price.id);
    assert.equal(view.prices[0]?.effectiveTo,versions.plan.price.effective_to?.toISOString());
    assert.ok(view.unavailable.includes('credit_packs'));assert.ok(view.unavailable.includes('models'));assert.ok(view.unavailable.includes('capabilities'));
    assert.ok(!view.unavailable.includes('plans'));
    assert.ok(!JSON.stringify(view).includes(w.p.owner));
  });
  await t.test('closed served hub never publishes its fees', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('hub').set({ lifecycle: 'closed' }).where('id', '=', w.hubA).execute());
    const closed=PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
    assert.deepEqual(closed.fees, []);assert.deepEqual(closed.prices, []);
  });
});

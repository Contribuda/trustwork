import { VersionedTaskFees } from '../../../apps/api/src/modules/billing/fees/task-adapter.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { addLogins } from '../../admin/helpers.js';
import { feeWorld, syntheticTerms } from './helpers.js';
import { taskFixture, taskOk, taskConsent, taskPerson } from './task-fixture.js';
import { computeAgreementDigest } from '../../../packages/contracts/src/server/commercial.js';
import type { FeeDisclosure } from '../../../packages/contracts/src/billing-fees.js';
import type { OwnerTaskRequestView, TaskAssignmentView } from '../../../packages/contracts/src/tasks.js';
const h=await startHarness('fee_tasks');
test('BILL-003 actual task confirmations pin both hubs fees separately from immutable task terms',{skip:h?false:SKIP_REASON},async t=>{
  if(!h)return;
  const w=await feeWorld(h.db.admin,h.pool);
  const buyerEmail='synthetic-task-fee-buyer@example.invalid',sellerEmail='synthetic-task-fee-seller@example.invalid';
  await addLogins(h,[[w.p.outsider,buyerEmail],[w.p.operator,sellerEmail]]);
  const f=await taskFixture(h,{buyerId:w.p.outsider,sellerId:w.p.operator,buyerEmail,sellerEmail,hubA:w.hubA,hubB:w.hubB});
  t.after(async()=>{await f.close();await h.close();});
  const task=await f.prepare();
  await t.test('missing fees and missing confirmation cannot silently create an unpriced acceptance',async()=>{
    assert.equal((await f.buyer.post(task.disclose,{})).status,409);
    assert.equal((await f.buyer.post(task.url,task.accept)).status,409);
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agreement WHERE offer_ref_id=$1',[task.offer.id])).rowCount,0);
  });
  const start=new Date(Date.now()+1500),end=new Date(start.getTime()+16000);
  const b=await w.draft(syntheticTerms({kind:'task',categoryKey:null,effectiveFrom:start.toISOString(),effectiveTo:end.toISOString()}));
  const s=await w.draft(syntheticTerms({kind:'task',categoryKey:null,payer:'seller',effectiveFrom:start.toISOString(),effectiveTo:null}),w.hubB,w.p.otherOwner);
  await w.activate(b,await w.approve(b));await w.activate(s,await w.approve(s,s.digest,w.p.moderator,w.p.otherOwner),w.p.moderator);
  const next=await w.draft(syntheticTerms({kind:'task',categoryKey:null,basisPoints:300,effectiveFrom:end.toISOString(),effectiveTo:null}));await w.activate(next,await w.approve(next));
  await delay(Math.max(0,start.getTime()-Date.now()+10));
  await t.test('anonymous, other hub and caller authority are refused',async()=>{
    assert.equal((await f.anonymous.post(task.disclose,{})).status,401);
    assert.equal((await f.wrongHub.post(task.disclose,{})).status,404);
    assert.equal((await f.buyer.post(task.disclose,{hubId:w.hubB})).status,422);
  });
  const bd=taskOk<FeeDisclosure>(await f.buyer.post(task.disclose,{}),201),sd=taskOk<FeeDisclosure>(await f.seller.post(task.disclose,{}),201);
  const confirmation=(d:FeeDisclosure)=>({disclosureId:d.id,digest:d.digest});
  const digest=computeAgreementDigest(task.accept.offer,task.accept.requestVersion,'task');
  await t.test('mandate amount includes the buyer fee and private seller floors use net proceeds',async()=>{
    const price={minorUnits:'10000',currency:'USD'};
    const buyerAmount=await w.a.as(w.p.outsider,trx=>new VersionedTaskFees(w.hubA).amount(trx,'buyer',price,confirmation(bd)));
    const sellerAmount=await w.a.as(w.p.operator,trx=>new VersionedTaskFees(w.hubB).amount(trx,'seller',price,confirmation(sd)));
    assert.deepEqual(buyerAmount,{minorUnits:'10100',currency:'USD'});assert.deepEqual(sellerAmount,{minorUnits:'9900',currency:'USD'});
  });

  await t.test('both public snapshots reproduce the original agreement digest without private limits',async()=>{
    assert.equal(bd.snapshot.sourceDigest,digest.value);assert.equal(sd.snapshot.sourceDigest,digest.value);
    assert.deepEqual(bd.snapshot.buyerFee,b);assert.deepEqual(bd.snapshot.sellerFee,s);
    assert.ok(!JSON.stringify(bd).includes('PRIVATE'));assert.ok(!JSON.stringify(bd).includes('budgetCeiling'));
  });
  await t.test('wrong owner or exact digest is refused without committing acceptance',async()=>{
    assert.equal((await f.buyer.post(task.url,{...task.accept,feeConfirmation:confirmation(sd)})).status,404);
    assert.equal((await f.buyer.post(task.url,{...task.accept,feeConfirmation:{...confirmation(bd),digest:'f'.repeat(64)}})).status,403);
  });
  const accepted=taskOk<OwnerTaskRequestView>(await f.buyer.post(task.url,{...task.accept,feeConfirmation:confirmation(bd)}),201);
  const a=accepted.agreements[0]!;
  await t.test('concurrent real assignments have one winner and both local fee bindings',async()=>{
    const body={expectedRevision:a.revision,acceptedTermsDigest:a.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson,feeConfirmation:confirmation(sd)};
    const results=await Promise.all([f.seller.post(`/v1/task-agreements/${a.id}/confirm`,body),f.seller.post(`/v1/task-agreements/${a.id}/confirm`,body)]);
    assert.equal(results.filter(r=>r.status===201).length,1,JSON.stringify(results));
    const assigned=taskOk<TaskAssignmentView>(results.find(r=>r.status===201)!,201);assert.equal(assigned.assignment.agreement.acceptedTermsDigest.value,digest.value);
    const rows=(await h.db.admin.query('SELECT person_id,source_hub_id,local_fee_id,counterparty_fee_id FROM trustwork.billing_fee_binding WHERE booking_id=$1',[a.id])).rows;
    assert.equal(rows.length,2);assert.deepEqual(rows.find(r=>r.person_id===w.p.outsider),{person_id:w.p.outsider,source_hub_id:w.hubA,local_fee_id:b.id,counterparty_fee_id:s.id});
    assert.deepEqual(rows.find(r=>r.person_id===w.p.operator),{person_id:w.p.operator,source_hub_id:w.hubB,local_fee_id:s.id,counterparty_fee_id:b.id});
  });
  const stale=await f.prepare();const old=taskOk<FeeDisclosure>(await f.buyer.post(stale.disclose,{}),201);
  await delay(Math.max(0,end.getTime()-Date.now()+10));
  await t.test('expired shown version refuses acceptance even with an active successor',async()=>{
    const result=await f.buyer.post(stale.url,{...stale.accept,feeConfirmation:confirmation(old)});assert.equal(result.status,409,JSON.stringify(result.body));
    assert.equal((result.body as {details:{reason:string}}).details.reason,'billing.fee_outdated');
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agreement WHERE offer_ref_id=$1',[stale.offer.id])).rowCount,0);
  });
});

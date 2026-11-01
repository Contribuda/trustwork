import { BookingTermsSchema, bookingTermsDigestInput, pricingSummary } from '../../../packages/contracts/src/consultations.js';
import { sql } from 'kysely';
import { computeDigest, computeAgreementDigest } from '@trustwork/contracts';
import { rawBindingChecks, mustRefuseFinal, recordAcceptance } from './raw-binding.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../../apps/api/src/app.js';
import { Client, startHarness, SKIP_REASON, type Response } from '../../backend/helpers/app.js';
import { addLogins, signIn } from '../../admin/helpers.js';
import { screenClear } from '../../consultations/helpers.js';
import { feeWorld, syntheticTerms } from './helpers.js';
import type { ExpertRequestView, RequesterRequestView, BookingView } from '../../../packages/contracts/src/consultations.js';

const h = await startHarness('fee_consultation');
const person = {via:'person'} as const;
const consent = {consented:true,disclosureKey:'trustwork.electronic-records.v1'} as const;
function ok<T>(r:Response,status=200):T {assert.equal(r.status,status,JSON.stringify(r.body));return r.body as T;}
test('BILL-003 actual cross-hub consultation acceptance binds both exact fees without changing private terms', {skip:h?false:SKIP_REASON},async(t)=>{
  if(!h)return;
  const w=await feeWorld(h.db.admin,h.pool);
  const buyerId=w.p.outsider, sellerId=w.p.operator;
  await addLogins(h,[[buyerId,'synthetic-fee-buyer@example.invalid'],[sellerId,'synthetic-fee-seller@example.invalid']]);
  await screenClear(h,[{kind:'person',id:buyerId},{kind:'person',id:sellerId}]);
  const makeApp=(hub:string)=>createApp({env:{API_HOST:'127.0.0.1',API_PORT:'0',PUBLIC_ORIGIN:`https://${hub}.test`,
    TRUSTWORK_HUB_ID:hub,MAIL_SECRET_KEY:randomBytes(32).toString('hex')},pool:h.pool,clock:h.clock,logSink:line=>{if(line.includes('"level":"error"'))console.error(line);}});
  const buyerApp=await makeApp(w.hubA),sellerApp=await makeApp(w.hubB);
  t.after(async()=>{await buyerApp.close();await sellerApp.close();await h.close();});
  const buyer=new Client(buyerApp),seller=new Client(sellerApp),wrongBuyerHub=new Client(sellerApp),wrongSellerHub=new Client(buyerApp);
  for(const c of [buyer,wrongBuyerHub])await signIn(c,'synthetic-fee-buyer@example.invalid');
  for(const c of [seller,wrongSellerHub])await signIn(c,'synthetic-fee-seller@example.invalid');
  const catalogue=ok<{offering:{id:string;revision:number};versions:{id:string}[]}>(await seller.post('/v1/catalogue',{
    owner:{kind:'person',id:sellerId},kind:'services',actor:person,draft:{
      payload:{title:'Synthetic fee-bound drawing review',description:null,specification:{},unit:'ls',listPrice:{minorUnits:'10000',currency:'USD'},options:[],
        availability:{state:'available',capacity:null,observedAt:new Date().toISOString()},components:[]},
      publicFields:['title','listPrice','unit'],privateKnowledge:{costBasis:null,marginTarget:null,notes:'Synthetic private cost'},
    },
  }),201);
  ok(await seller.post(`/v1/catalogue/${catalogue.offering.id}/versions/${catalogue.versions[0]!.id}/publish`,{expectedRevision:catalogue.offering.revision,actor:person}));
  ok(await seller.post('/v1/consultation-offerings',{offeringId:catalogue.offering.id,actor:person,terms:{
    kind:'drawing_review',modes:['async'],topics:['work.design.structural'],regions:['US-CA'],languages:['en'],durationMinutes:60,deliverableKind:'marked_up_document',
    pricing:'fixed',cancellation:{freeUntilHours:24,lateShareBps:5000,noShowShareBps:10000},licence:{required:false,credentialId:null},recordingOffered:false,
  }}),201);
  const request=async()=>ok<RequesterRequestView>(await buyer.post('/v1/consultation-requests',{
    source:{kind:'direct'},offeringId:catalogue.offering.id,actor:person,mentoringRelationshipId:null,
    terms:{kind:'drawing_review',question:'Synthetic drawing review question',fields:[],preferredModes:['async'],preferredTimes:[],sharedMaterials:[],licenceRequired:false,languages:['en']},
    privateConstraint:{budgetCeiling:{minorUnits:'50000',currency:'USD'},requesterNotes:'Synthetic PRIVATE buyer notes'},
  }),201);
  const propose=(r:RequesterRequestView)=>seller.post(`/v1/consultation-requests/${r.request.id}/proposals`,{
    expectedRevision:r.request.revision,mode:'async',slot:null,deliverableDue:'2029-12-01',validUntil:'2029-11-01T00:00:00Z',note:'Synthetic proposal',actor:person,
  });
  const r=await request();
  await t.test('absence of actual published fees is unavailable, never a zero-price fallback',async()=>{
    const denied=await propose(r);assert.equal(denied.status,409,JSON.stringify(denied.body));assert.equal((denied.body as {details:{reason:string}}).details.reason,'billing.unavailable');
  });
  const starts=new Date(Date.now()+1500); const ends=new Date(starts.getTime()+30000);
  const feeBuyer=await w.draft(syntheticTerms({categoryKey:'drawing_review',basisPoints:100,effectiveFrom:starts.toISOString(),effectiveTo:ends.toISOString()}));
  const feeSeller=await w.draft(syntheticTerms({categoryKey:'drawing_review',payer:'seller',basisPoints:200,effectiveFrom:starts.toISOString(),effectiveTo:null}),w.hubB,w.p.otherOwner);
  await w.activate(feeBuyer,await w.approve(feeBuyer));
  await w.activate(feeSeller,await w.approve(feeSeller,feeSeller.digest,w.p.moderator,w.p.otherOwner),w.p.moderator);
  const successor=await w.draft(syntheticTerms({categoryKey:'drawing_review',basisPoints:300,effectiveFrom:ends.toISOString(),effectiveTo:null}));
  await w.activate(successor,await w.approve(successor));
  await delay(Math.max(0,starts.getTime()-Date.now()+10));
  const offered=ok<ExpertRequestView>(await propose(r),201);
  const booking=offered.bookings[0]!;
  await t.test('both fee snapshots and resulting totals are in the unchanged immutable proposal digest; private fields stay private',async()=>{
    const commission=booking.terms.pricing.commission;assert.equal(commission.status,'versioned_fees');
    if(commission.status!=='versioned_fees')return;
    assert.deepEqual(commission.buyerFee,feeBuyer);assert.deepEqual(commission.sellerFee,feeSeller);
    assert.equal(booking.terms.pricing.clientTotal?.minorUnits,'10100');assert.equal(booking.terms.pricing.expertAmount?.minorUnits,'9800');
    assert.ok(!JSON.stringify(offered).includes('PRIVATE buyer notes'));
    const own=ok<RequesterRequestView>(await buyer.get(`/v1/consultation-requests/${r.request.id}`));
    assert.deepEqual(own.bookings[0]?.digest,booking.digest);
  });
  const otherRequest=await request();
  const otherBooking=ok<ExpertRequestView>(await propose(otherRequest),201).bookings[0]!;
  const scope=(await h.db.admin.query("SELECT id FROM trustwork.billing_fee_scope WHERE source_kind='consultation' AND source_id=$1",[otherBooking.id])).rows[0].id as string;
  await rawBindingChecks(t,h.db.admin,w,scope,otherBooking.id,booking.id,otherBooking.digest.value);
  await t.test('new legacy-labelled proposal without origin cannot take the raw final booking path',async()=>{
    const req=await request();
    const original=(await h.db.admin.query('SELECT * FROM trustwork.consultation_booking WHERE id=$1',[booking.id])).rows[0];
    const terms=BookingTermsSchema.parse({...original.terms,request:{id:req.request.id,version:1,digest:req.request.digest},pricing:pricingSummary(original.terms.pricing.price,{status:'none_published'})});
    const id=randomUUID(), termsDigest=computeDigest(bookingTermsDigestInput({bookingId:id,terms})).value;
    await w.a.as(sellerId,trx=>trx.insertInto('consultation_booking').values({...original,id,created_at:new Date('2020-01-01T00:00:00Z'),request_id:req.request.id,terms:JSON.stringify(terms),terms_digest:termsDigest}).execute());
    const agreement=await w.a.as(buyerId,async trx=>{
      const a=await trx.insertInto('agreement').values({terms_kind:'consultation',buyer_person_id:buyerId,seller_person_id:sellerId,
        offer_ref_id:id,request_ref_id:req.request.id,offer_version:1,offer_digest:termsDigest,request_version:1,request_digest:req.request.digest.value,
        accepted_terms_digest:computeAgreementDigest({id,version:1,digest:{algorithm:'trustwork-digest-1',value:termsDigest}},{id:req.request.id,version:1,digest:req.request.digest},'consultation').value,
        status:'accepted_by_buyer',created_by_person_id:buyerId}).returningAll().executeTakeFirstOrThrow();
      await recordAcceptance(trx,a.id,'buyer');
      await trx.updateTable('consultation_booking').set({agreement_id:a.id}).where('id','=',id).execute();return a;
    });
    await mustRefuseFinal(fn=>w.a.as(sellerId,fn),async trx=>{
      await recordAcceptance(trx,agreement.id,'seller');
      await sql`UPDATE trustwork.agreement SET status='accepted_by_both' WHERE id=${agreement.id}::uuid`.execute(trx);
      await sql`UPDATE trustwork.consultation_booking SET status='booked',booked_at=now() WHERE id=${id}::uuid`.execute(trx);
    });
  });
  const fresh=ok<RequesterRequestView>(await buyer.get(`/v1/consultation-requests/${r.request.id}`));
  const accept={booking:{id:booking.id,version:1,digest:booking.digest},request:{id:r.request.id,version:1,digest:r.request.digest},
    expectedRevision:fresh.request.revision,recordingConsent:false,electronicRecords:consent,actor:person};
  await t.test('caller hub override and accepting on the other home hub are refused',async()=>{
    assert.equal((await buyer.post(`/v1/consultation-requests/${r.request.id}/acceptances`,{...accept,sourceHubId:w.hubB})).status,422);
    assert.equal((await wrongBuyerHub.post(`/v1/consultation-requests/${r.request.id}/acceptances`,accept)).status,404);
  });
  const accepted=ok<RequesterRequestView>(await buyer.post(`/v1/consultation-requests/${r.request.id}/acceptances`,accept),201);
  const agreement=accepted.agreements[0]!;
  const confirm={expectedRevision:agreement.revision,acceptedTermsDigest:agreement.acceptedTermsDigest,electronicRecords:consent,actor:person};
  await t.test('different hub cannot confirm; concurrent correct confirmations have exactly one winner and immutable terms',async()=>{
    assert.equal((await wrongSellerHub.post(`/v1/consultation-agreements/${agreement.id}/confirm`,confirm)).status,404);
    const results=await Promise.all([seller.post(`/v1/consultation-agreements/${agreement.id}/confirm`,confirm),seller.post(`/v1/consultation-agreements/${agreement.id}/confirm`,confirm)]);
    assert.equal(results.filter(x=>x.status===201).length,1);
    const booked=ok<BookingView>(results.find(x=>x.status===201)!,201);
    assert.equal(booked.booking.status,'booked');assert.deepEqual(booked.booking.digest,booking.digest);
    assert.deepEqual(booked.agreement?.acceptedTermsDigest,agreement.acceptedTermsDigest);
    const bindings=(await h.db.admin.query('SELECT person_id,source_hub_id,local_fee_id,counterparty_fee_id FROM trustwork.billing_fee_binding WHERE booking_id=$1 ORDER BY person_id',[booking.id])).rows;
    assert.equal(bindings.length,2);
    assert.deepEqual(bindings.find(x=>x.person_id===buyerId),{person_id:buyerId,source_hub_id:w.hubA,local_fee_id:feeBuyer.id,counterparty_fee_id:feeSeller.id});
    assert.deepEqual(bindings.find(x=>x.person_id===sellerId),{person_id:sellerId,source_hub_id:w.hubB,local_fee_id:feeSeller.id,counterparty_fee_id:feeBuyer.id});
  });
  await t.test('real acceptance and final booking refuse an outdated shown fee even when its successor is active',async()=>{
    const makePending=async(acceptNow:boolean)=>{
      const req=await request();const prop=ok<ExpertRequestView>(await propose(req),201);const b=prop.bookings[0]!;
      const own=ok<RequesterRequestView>(await buyer.get(`/v1/consultation-requests/${req.request.id}`));
      const body={booking:{id:b.id,version:1,digest:b.digest},request:{id:req.request.id,version:1,digest:req.request.digest},expectedRevision:own.request.revision,
        recordingConsent:false,electronicRecords:consent,actor:person};
      const accepted=acceptNow?ok<RequesterRequestView>(await buyer.post(`/v1/consultation-requests/${req.request.id}/acceptances`,body),201):null;
      return {req,body,b,agreement:accepted?.agreements[0]};
    };
    const pending=await makePending(true),unaccepted=await makePending(false);
    await delay(Math.max(0,ends.getTime()-Date.now()+10));
    const agreement=pending.agreement!;
    const denied=await seller.post(`/v1/consultation-agreements/${agreement.id}/confirm`,{expectedRevision:agreement.revision,
      acceptedTermsDigest:agreement.acceptedTermsDigest,electronicRecords:consent,actor:person});
    assert.equal(denied.status,409,JSON.stringify(denied.body));
    assert.equal((denied.body as {details:{reason:string}}).details.reason,'billing.fee_outdated');
    const refused=await buyer.post(`/v1/consultation-requests/${unaccepted.req.request.id}/acceptances`,unaccepted.body);
    assert.equal(refused.status,409,JSON.stringify(refused.body));
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.billing_fee_binding WHERE booking_id=$1 AND person_id=$2',[pending.b.id,sellerId])).rowCount,0);
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.billing_fee_binding WHERE booking_id=$1',[unaccepted.b.id])).rowCount,0);
  });
});

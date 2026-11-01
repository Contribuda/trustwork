import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { loadMigrations } from '../../../packages/data/src/migrate/runner.js';
import { PreUpgradeClient } from './pre-upgrade.js';
import { taskAgreements } from '../../../packages/data/src/repositories/tasks.js';
import { computeDigest, computeAgreementDigest } from '@trustwork/contracts';
import { BookingTermsSchema, bookingTermsDigestInput } from '../../../packages/contracts/src/consultations.js';
import { type Client, startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { seedPersonas, login } from '../../backend/helpers/personas.js';
import { VersionedTaskFees } from '../../../apps/api/src/modules/billing/fees/task-adapter.js';
import { addLogins, signIn } from '../../admin/helpers.js';
import { screenClear } from '../../consultations/helpers.js';
import { feeWorld, registerFeeServingHubs } from './helpers.js';
import { taskFixture, taskOk, taskConsent, taskPerson } from './task-fixture.js';
import { mustRefuseFinal, recordAcceptance } from './raw-binding.js';
import { rejects } from '../../hubs/helpers.js';
import type { ExpertRequestView, RequesterRequestView, BookingView } from '../../../packages/contracts/src/consultations.js';
import type { OwnerTaskRequestView, TaskAssignmentView } from '../../../packages/contracts/src/tasks.js';

const directory=mkdtempSync(join(tmpdir(),'bill003-before-cutoff-'));
// The historical database must be a prefix: later migrations cannot precede the withheld fee migrations.
for(const f of loadMigrations().filter(f=>f.filename < '20261111100000_fee_authority.sql')) writeFileSync(join(directory,f.filename),f.script);
const h=await startHarness('fee_legacy_cutoff',{},directory);
rmSync(directory,{recursive:true,force:true});
test('migration captures exact historical sources once; newly backdated or origin-less records cannot declare themselves legacy',{skip:h?false:SKIP_REASON},async t=>{
  if(!h)return;
  t.after(()=>h.close());
  const w=await feeWorld(h.db.admin,h.pool,'before-fee11');
  const buyerEmail='synthetic-legacy-buyer@example.invalid',sellerEmail='synthetic-legacy-seller@example.invalid';
  await addLogins(h,[[w.p.outsider,buyerEmail],[w.p.operator,sellerEmail]]);
  let buyer:Client=new PreUpgradeClient(h),seller:Client=new PreUpgradeClient(h);await signIn(buyer,buyerEmail);await signIn(seller,sellerEmail);
  const f=await taskFixture(h,{buyerId:w.p.outsider,sellerId:w.p.operator,buyerEmail,sellerEmail,hubA:w.hubA,hubB:w.hubB,buyerClient:buyer,sellerClient:seller});
  t.after(()=>f.close());
  const prepareTask=async()=>{const source=await f.prepare();return taskOk<OwnerTaskRequestView>(await buyer.post(source.url,source.accept),201).agreements[0]!;};
  const oldTask=await prepareTask();
  const originlessTaskSource=await f.prepare();
  await screenClear(h,[{kind:'person',id:w.p.outsider},{kind:'person',id:w.p.operator}]);
  const catalogue=taskOk<{offering:{id:string;revision:number};versions:{id:string}[]}>(await seller.post('/v1/catalogue',{
    owner:{kind:'person',id:w.p.operator},kind:'services',actor:taskPerson,draft:{payload:{title:'Synthetic historical review',description:null,specification:{},unit:'ls',listPrice:{minorUnits:'10000',currency:'USD'},options:[],availability:{state:'available',capacity:null,observedAt:new Date().toISOString()},components:[]},publicFields:['title','listPrice','unit'],privateKnowledge:{costBasis:null,marginTarget:null,notes:null}},
  }),201);
  taskOk(await seller.post(`/v1/catalogue/${catalogue.offering.id}/versions/${catalogue.versions[0]!.id}/publish`,{expectedRevision:catalogue.offering.revision,actor:taskPerson}));
  taskOk(await seller.post('/v1/consultation-offerings',{offeringId:catalogue.offering.id,actor:taskPerson,terms:{kind:'drawing_review',modes:['async'],topics:['work.design.structural'],regions:['US-CA'],languages:['en'],durationMinutes:60,deliverableKind:'marked_up_document',pricing:'fixed',cancellation:{freeUntilHours:24,lateShareBps:5000,noShowShareBps:10000},licence:{required:false,credentialId:null},recordingOffered:false}}),201);
  const prepareConsultationRequest=async()=>taskOk<RequesterRequestView>(await buyer.post('/v1/consultation-requests',{source:{kind:'direct'},offeringId:catalogue.offering.id,actor:taskPerson,mentoringRelationshipId:null,
      terms:{kind:'drawing_review',question:'Synthetic historical question',fields:[],preferredModes:['async'],preferredTimes:[],sharedMaterials:[],licenceRequired:false,languages:['en']},privateConstraint:{budgetCeiling:{minorUnits:'50000',currency:'USD'},requesterNotes:null}}),201);
  const prepareConsultation=async()=>{
    const r=await prepareConsultationRequest();
    const offered=taskOk<ExpertRequestView>(await seller.post(`/v1/consultation-requests/${r.request.id}/proposals`,{expectedRevision:r.request.revision,mode:'async',slot:null,deliverableDue:'2029-12-01',validUntil:'2029-11-01T00:00:00Z',note:null,actor:taskPerson}),201);
    const b=offered.bookings[0]!;
    const own=taskOk<RequesterRequestView>(await buyer.get(`/v1/consultation-requests/${r.request.id}`));
    const accepted=taskOk<RequesterRequestView>(await buyer.post(`/v1/consultation-requests/${r.request.id}/acceptances`,{booking:{id:b.id,version:1,digest:b.digest},request:{id:r.request.id,version:1,digest:r.request.digest},expectedRevision:own.request.revision,recordingConsent:false,electronicRecords:taskConsent,actor:taskPerson}),201);
    return {booking:b,agreement:accepted.agreements[0]!};
  };
  const oldConsultation=await prepareConsultation();
  const originlessConsultationRequest=await prepareConsultationRequest();
  const originalBooking=(await h.db.admin.query('SELECT * FROM trustwork.consultation_booking WHERE id=$1',[oldConsultation.booking.id])).rows[0];
  const historicalBuyer=buyer;
  await h.db.migrate();
  await registerFeeServingHubs(h.db.admin,w.hubA,w.hubB);
  await assert.rejects(historicalBuyer.get(`/v1/task-requests/${originlessTaskSource.request.request.id}`),/historical construction must stop/);
  // Reconstruct CURRENT real factories: no historical fee adapters or ungoverned services survive the upgrade.
  const current=await taskFixture(h,{buyerId:w.p.outsider,sellerId:w.p.operator,buyerEmail,sellerEmail,hubA:w.hubA,hubB:w.hubB});
  t.after(()=>current.close());buyer=current.buyer;seller=current.seller;

  const captured=(await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows;
  assert.deepEqual(captured,[{source_kind:'consultation',source_id:oldConsultation.booking.id,source_digest:oldConsultation.booking.digest.value},{source_kind:'task',source_id:oldTask.id,source_digest:oldTask.acceptedTermsDigest.value}]);
  await t.test('current owning APIs refuse wrong actor, digest and explicit mismatched fee confirmation',async()=>{
    const taskBody={expectedRevision:oldTask.revision,acceptedTermsDigest:oldTask.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson};
    const consultationBody={expectedRevision:oldConsultation.agreement.revision,acceptedTermsDigest:oldConsultation.agreement.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson};
    for(const [url,body] of [[`/v1/task-agreements/${oldTask.id}/confirm`,taskBody],[`/v1/consultation-agreements/${oldConsultation.agreement.id}/confirm`,consultationBody]] as const){
      assert.equal((await buyer.post(url,body)).status,404);
      assert.equal((await seller.post(url,{...body,acceptedTermsDigest:{algorithm:'trustwork-digest-1',value:'f'.repeat(64)}})).status,409);
    }
    assert.equal((await seller.post(`/v1/task-agreements/${oldTask.id}/confirm`,{...taskBody,feeConfirmation:{disclosureId:randomUUID(),digest:'f'.repeat(64)}})).status,404);
    await rejects(w.a.as(w.p.outsider,trx=>sql`SELECT trustwork.billing_task_legacy_proceeds(${oldTask.id}::uuid,${oldTask.acceptedTermsDigest.value})`.execute(trx)),'P0002','admin.not_found');
    await rejects(w.a.as(w.p.operator,trx=>sql`SELECT trustwork.billing_task_legacy_proceeds(${oldTask.id}::uuid,${'f'.repeat(64)})`.execute(trx)),'23514','billing.source_outdated');
    await rejects(w.a.as(w.p.operator,trx=>sql`SELECT trustwork.billing_task_legacy_proceeds(${oldConsultation.booking.id}::uuid,${oldConsultation.booking.digest.value})`.execute(trx)),'P0002','admin.not_found');
    await rejects(w.a.as(w.p.operator,trx=>sql`SELECT trustwork.billing_consultation_confirm(${w.hubB}::uuid,${oldTask.id}::uuid,'seller')`.execute(trx)),'P0002','admin.not_found');
    assert.deepEqual((await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows,captured);
  });
  await t.test('a real foreign company member cannot use either captured historical source',async()=>{
    const seed=await seedPersonas(h);await login(seller,'boris');
    for(const [kind,a] of [['task',oldTask],['consultation',oldConsultation.agreement]] as const){
      const result=await seller.post(`/v1/${kind}-agreements/${a.id}/confirm`,{expectedRevision:a.revision,acceptedTermsDigest:a.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson});
      assert.equal(result.status,404,JSON.stringify(result.body));
    }
    await rejects(w.a.as(seed.people.boris,trx=>sql`SELECT trustwork.billing_task_legacy_proceeds(${oldTask.id}::uuid,${oldTask.acceptedTermsDigest.value})`.execute(trx)),'P0002','admin.not_found');
    await rejects(w.a.as(seed.people.boris,trx=>sql`SELECT trustwork.billing_consultation_confirm(${w.hubB}::uuid,${oldConsultation.booking.id}::uuid,'seller')`.execute(trx)),'P0002','admin.not_found');
    await signIn(seller,sellerEmail);
    assert.deepEqual((await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows,captured);
  });
  await t.test('legacy proceeds come from locked original terms, never a supplied price or hub',async()=>{
    const proceeds=await w.a.as(w.p.operator,trx=>new VersionedTaskFees(w.hubA).amount(trx,'seller',{minorUnits:'999999999',currency:'EUR'},undefined,oldTask.id));
    assert.deepEqual(proceeds,{minorUnits:'10000',currency:'USD'});
    await assert.rejects(w.a.as(w.p.outsider,trx=>new VersionedTaskFees(w.hubA).amount(trx,'buyer',{minorUnits:'1',currency:'USD'},undefined,oldTask.id)),(e:unknown)=>(e as {details?:{reason?:string}}).details?.reason==='billing.confirmation_required');
  });
  await t.test('actual pre-migration records retain their old final acceptance',async()=>{
    const body={expectedRevision:oldTask.revision,acceptedTermsDigest:oldTask.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson};
    const attempts=await Promise.all([seller.post(`/v1/task-agreements/${oldTask.id}/confirm`,body),seller.post(`/v1/task-agreements/${oldTask.id}/confirm`,body)]);
    assert.equal(attempts.filter(r=>r.status===201).length,1,JSON.stringify(attempts));
    const task=taskOk<TaskAssignmentView>(attempts.find(r=>r.status===201)!,201);
    assert.equal(task.assignment.agreement.acceptedTermsDigest.value,oldTask.acceptedTermsDigest.value);
    const a=oldConsultation.agreement;
    const booking=taskOk<BookingView>(await seller.post(`/v1/consultation-agreements/${a.id}/confirm`,{expectedRevision:a.revision,acceptedTermsDigest:a.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson}),201);
    assert.equal(booking.booking.status,'booked');
    assert.deepEqual(booking.booking.terms.pricing,oldConsultation.booking.terms.pricing);
    assert.equal(booking.booking.terms.pricing.commission.status,'published');
    assert.equal(booking.booking.terms.pricing.expertAmount?.minorUnits,'9750');
    assert.notEqual((await seller.post(`/v1/consultation-agreements/${a.id}/confirm`,{expectedRevision:a.revision,acceptedTermsDigest:a.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson})).status,201);
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.billing_fee_binding')).rowCount,0);
    assert.deepEqual((await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows,captured);
  });
  // Raw owning repository construction exercises the final SQL guard, never a permissive post-upgrade service.
  const source=originlessTaskSource;
  assert.equal((await buyer.post(source.url,source.accept)).status,409);
  const freshTask=await w.a.as(w.p.outsider,async trx=>{
    const row={buyer_person_id:w.p.outsider,seller_person_id:w.p.operator,seller_company_id:null,offer_ref_id:source.offer.id,request_ref_id:source.accept.requestVersion.id,
      offer_version:source.offer.version,offer_digest:source.accept.offer.digest.value,request_version:source.accept.requestVersion.version,request_digest:source.accept.requestVersion.digest.value,
      accepted_terms_digest:computeAgreementDigest(source.accept.offer,source.accept.requestVersion,'task').value,created_by_person_id:w.p.outsider,created_at:new Date('2020-01-01T00:00:00Z')};
    const a=await taskAgreements.insert(trx,row);await recordAcceptance(trx,a.id,'buyer');return a;
  });
  const req=originlessConsultationRequest;
  const terms=BookingTermsSchema.parse({...originalBooking.terms,request:{id:req.request.id,version:1,digest:req.request.digest}});
  const id=randomUUID(),termsDigest=computeDigest(bookingTermsDigestInput({bookingId:id,terms})).value;
  await w.a.as(w.p.operator,trx=>trx.insertInto('consultation_booking').values({...originalBooking,id,request_id:req.request.id,agreement_id:null,
    revision:1,terms:JSON.stringify(terms),terms_digest:termsDigest,created_at:new Date('2020-01-01T00:00:00Z')}).execute());
  const freshConsultation=await w.a.as(w.p.outsider,async trx=>{
    const a=await trx.insertInto('agreement').values({terms_kind:'consultation',buyer_person_id:w.p.outsider,seller_person_id:w.p.operator,
      offer_ref_id:id,request_ref_id:req.request.id,offer_version:1,offer_digest:termsDigest,request_version:1,request_digest:req.request.digest.value,
      accepted_terms_digest:computeAgreementDigest({id,version:1,digest:{algorithm:'trustwork-digest-1',value:termsDigest}},{id:req.request.id,version:1,digest:req.request.digest},'consultation').value,
      status:'accepted_by_buyer',created_by_person_id:w.p.outsider,created_at:new Date('2020-01-01T00:00:00Z')}).returningAll().executeTakeFirstOrThrow();
    await recordAcceptance(trx,a.id,'buyer');await trx.updateTable('consultation_booking').set({agreement_id:a.id}).where('id','=',id).execute();return a;
  });
  for(const [kind,a] of [['task',freshTask],['consultation',freshConsultation]] as const){
    const result=await seller.post(`/v1/${kind}-agreements/${a.id}/confirm`,{expectedRevision:a.revision,acceptedTermsDigest:{algorithm:'trustwork-digest-1',value:a.accepted_terms_digest},electronicRecords:taskConsent,actor:taskPerson});
    assert.equal(result.status,409,JSON.stringify(result.body));
  }

  await t.test('new unbound records fail at the stored agreement transition for both kinds',async()=>{
    for(const id of [freshTask.id,freshConsultation.id]) await mustRefuseFinal(fn=>w.a.as(w.p.operator,fn),async trx=>{
      await recordAcceptance(trx,id,'seller');await sql`UPDATE trustwork.agreement SET status='accepted_by_both' WHERE id=${id}::uuid`.execute(trx);
    });
    assert.deepEqual((await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows,captured);
  });
  await t.test('the restricted role cannot write, forge or mutate the historical snapshot',async()=>{
    await rejects(w.a.as(w.p.outsider,trx=>sql`INSERT INTO trustwork.billing_fee_legacy_source(source_kind,source_id,source_digest) VALUES('task',${freshTask.id}::uuid,${freshTask.accepted_terms_digest})`.execute(trx)),'42501');
    await rejects(w.a.as(w.p.outsider,trx=>sql`UPDATE trustwork.billing_fee_legacy_source SET source_id=${randomUUID()}::uuid`.execute(trx)),'42501');
    await rejects(w.a.as(w.p.outsider,trx=>sql`DELETE FROM trustwork.billing_fee_legacy_source`.execute(trx)),'42501');
    await rejects(w.a.as(w.p.outsider,trx=>sql`SELECT * FROM trustwork.billing_fee_legacy_source`.execute(trx)),'42501');
    const worker=await h.db.admin.connect();try{await worker.query('BEGIN');await worker.query('SET LOCAL ROLE trustwork_worker');await rejects(worker.query("SELECT trustwork.billing_task_legacy_proceeds($1,$2)",[oldTask.id,oldTask.acceptedTermsDigest.value]),'42501');}finally{await worker.query('ROLLBACK');worker.release();}
    await rejects(h.db.admin.query("UPDATE trustwork.billing_fee_legacy_source SET source_digest=$1 WHERE source_id=$2",['f'.repeat(64),oldTask.id]),'23000');
  });
});

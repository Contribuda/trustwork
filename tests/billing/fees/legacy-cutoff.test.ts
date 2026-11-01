import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { loadMigrations } from '../../../packages/data/src/migrate/runner.js';
import { NoPublishedCommission } from '../../../apps/api/src/modules/consultations/ports.js';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { addLogins, signIn } from '../../admin/helpers.js';
import { screenClear } from '../../consultations/helpers.js';
import { feeWorld } from './helpers.js';
import { taskFixture, taskOk, taskConsent, taskPerson } from './task-fixture.js';
import { mustRefuseFinal, recordAcceptance } from './raw-binding.js';
import { rejects } from '../../hubs/helpers.js';
import type { ExpertRequestView, RequesterRequestView, BookingView } from '../../../packages/contracts/src/consultations.js';
import type { OwnerTaskRequestView, TaskAssignmentView } from '../../../packages/contracts/src/tasks.js';

const directory=mkdtempSync(join(tmpdir(),'bill003-before-cutoff-'));
// The historical database must be a prefix: later migrations cannot precede the withheld fee migrations.
for(const f of loadMigrations().filter(f=>f.filename < '20261111100000_fee_authority.sql')) writeFileSync(join(directory,f.filename),f.script);
// Deliberately historical code running before the fee migrations; never a production adapter.
const h=await startHarness('fee_legacy_cutoff',{
  consultationCommission:new NoPublishedCommission(),
  taskFees:{amount:async(_trx,_side,price)=>price,origin:async()=>{},confirm:async()=>{}},
},directory);
rmSync(directory,{recursive:true,force:true});
test('migration captures exact historical sources once; newly backdated or origin-less records cannot declare themselves legacy',{skip:h?false:SKIP_REASON},async t=>{
  if(!h)return;
  const w=await feeWorld(h.db.admin,h.pool);
  const buyerEmail='synthetic-legacy-buyer@example.invalid',sellerEmail='synthetic-legacy-seller@example.invalid';
  await addLogins(h,[[w.p.outsider,buyerEmail],[w.p.operator,sellerEmail]]);
  const buyer=h.client(),seller=h.client();await signIn(buyer,buyerEmail);await signIn(seller,sellerEmail);
  const f=await taskFixture(h,{buyerId:w.p.outsider,sellerId:w.p.operator,buyerEmail,sellerEmail,hubA:w.hubA,hubB:w.hubB,buyerClient:buyer,sellerClient:seller});
  t.after(async()=>{await f.close();await h.close();});
  const prepareTask=async()=>{const source=await f.prepare();return taskOk<OwnerTaskRequestView>(await buyer.post(source.url,source.accept),201).agreements[0]!;};
  const oldTask=await prepareTask();
  await screenClear(h,[{kind:'person',id:w.p.outsider},{kind:'person',id:w.p.operator}]);
  const catalogue=taskOk<{offering:{id:string;revision:number};versions:{id:string}[]}>(await seller.post('/v1/catalogue',{
    owner:{kind:'person',id:w.p.operator},kind:'services',actor:taskPerson,draft:{payload:{title:'Synthetic historical review',description:null,specification:{},unit:'ls',listPrice:{minorUnits:'10000',currency:'USD'},options:[],availability:{state:'available',capacity:null,observedAt:new Date().toISOString()},components:[]},publicFields:['title','listPrice','unit'],privateKnowledge:{costBasis:null,marginTarget:null,notes:null}},
  }),201);
  taskOk(await seller.post(`/v1/catalogue/${catalogue.offering.id}/versions/${catalogue.versions[0]!.id}/publish`,{expectedRevision:catalogue.offering.revision,actor:taskPerson}));
  taskOk(await seller.post('/v1/consultation-offerings',{offeringId:catalogue.offering.id,actor:taskPerson,terms:{kind:'drawing_review',modes:['async'],topics:['work.design.structural'],regions:['US-CA'],languages:['en'],durationMinutes:60,deliverableKind:'marked_up_document',pricing:'fixed',cancellation:{freeUntilHours:24,lateShareBps:5000,noShowShareBps:10000},licence:{required:false,credentialId:null},recordingOffered:false}}),201);
  const prepareConsultation=async()=>{
    const r=taskOk<RequesterRequestView>(await buyer.post('/v1/consultation-requests',{source:{kind:'direct'},offeringId:catalogue.offering.id,actor:taskPerson,mentoringRelationshipId:null,
      terms:{kind:'drawing_review',question:'Synthetic historical question',fields:[],preferredModes:['async'],preferredTimes:[],sharedMaterials:[],licenceRequired:false,languages:['en']},privateConstraint:{budgetCeiling:{minorUnits:'50000',currency:'USD'},requesterNotes:null}}),201);
    const offered=taskOk<ExpertRequestView>(await seller.post(`/v1/consultation-requests/${r.request.id}/proposals`,{expectedRevision:r.request.revision,mode:'async',slot:null,deliverableDue:'2029-12-01',validUntil:'2029-11-01T00:00:00Z',note:null,actor:taskPerson}),201);
    const b=offered.bookings[0]!;
    const own=taskOk<RequesterRequestView>(await buyer.get(`/v1/consultation-requests/${r.request.id}`));
    const accepted=taskOk<RequesterRequestView>(await buyer.post(`/v1/consultation-requests/${r.request.id}/acceptances`,{booking:{id:b.id,version:1,digest:b.digest},request:{id:r.request.id,version:1,digest:r.request.digest},expectedRevision:own.request.revision,recordingConsent:false,electronicRecords:taskConsent,actor:taskPerson}),201);
    return {booking:b,agreement:accepted.agreements[0]!};
  };
  const oldConsultation=await prepareConsultation();
  // This historical-data fixture intentionally hosts the current AGT service schema before the fee cutover.
  // Execute the exact fee scripts as a transactional SQL fixture; never lie to the forward-only migration ledger.
  // The production runner and its ordering refusal remain covered by tests/data/migrations.test.ts.
  const cutover = await h.db.admin.connect();
  try {
    await cutover.query('BEGIN');
    await cutover.query('SET LOCAL ROLE trustwork_owner');
    await cutover.query('SET LOCAL search_path = trustwork, pg_temp');
    await cutover.query("SELECT set_config('trustwork.maintenance', 'on', true)");
    for (const file of loadMigrations().filter(file => file.filename.startsWith('202611111000'))) await cutover.query(file.script);
    await cutover.query('COMMIT');
  } catch (error) { await cutover.query('ROLLBACK'); throw error; }
  finally { cutover.release(); }
  const captured=(await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows;
  assert.deepEqual(captured,[{source_kind:'consultation',source_id:oldConsultation.booking.id,source_digest:oldConsultation.booking.digest.value},{source_kind:'task',source_id:oldTask.id,source_digest:oldTask.acceptedTermsDigest.value}]);
  await t.test('actual pre-migration records retain their old final acceptance',async()=>{
    const task=taskOk<TaskAssignmentView>(await seller.post(`/v1/task-agreements/${oldTask.id}/confirm`,{expectedRevision:oldTask.revision,acceptedTermsDigest:oldTask.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson}),201);
    assert.equal(task.assignment.agreement.acceptedTermsDigest.value,oldTask.acceptedTermsDigest.value);
    const a=oldConsultation.agreement;
    const booking=taskOk<BookingView>(await seller.post(`/v1/consultation-agreements/${a.id}/confirm`,{expectedRevision:a.revision,acceptedTermsDigest:a.acceptedTermsDigest,electronicRecords:taskConsent,actor:taskPerson}),201);
    assert.equal(booking.booking.status,'booked');
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.billing_fee_binding')).rowCount,0);
  });
  const freshTask=await prepareTask(),freshConsultation=await prepareConsultation();
  await t.test('new unbound records fail at the stored agreement transition for both kinds',async()=>{
    for(const id of [freshTask.id,freshConsultation.agreement.id]) await mustRefuseFinal(fn=>w.a.as(w.p.operator,fn),async trx=>{
      await recordAcceptance(trx,id,'seller');await sql`UPDATE trustwork.agreement SET status='accepted_by_both' WHERE id=${id}::uuid`.execute(trx);
    });
    assert.deepEqual((await h.db.admin.query('SELECT source_kind,source_id,source_digest FROM trustwork.billing_fee_legacy_source ORDER BY source_kind')).rows,captured);
  });
  await t.test('the restricted role cannot write, forge or mutate the historical snapshot',async()=>{
    await rejects(w.a.as(w.p.outsider,trx=>sql`INSERT INTO trustwork.billing_fee_legacy_source(source_kind,source_id,source_digest) VALUES('task',${freshTask.id}::uuid,${freshTask.acceptedTermsDigest.value})`.execute(trx)),'42501');
    await rejects(w.a.as(w.p.outsider,trx=>sql`UPDATE trustwork.billing_fee_legacy_source SET source_id=${randomUUID()}::uuid`.execute(trx)),'42501');
    await rejects(h.db.admin.query("UPDATE trustwork.billing_fee_legacy_source SET source_digest=$1 WHERE source_id=$2",['f'.repeat(64),oldTask.id]),'23000');
  });
});

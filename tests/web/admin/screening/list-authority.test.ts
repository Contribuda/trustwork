import { listCrashCases } from './list-crashes.js';
import { installCrashPoints, recordState } from '../../../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../../../apps/api/src/common/idempotency/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { screeningWorld } from './world.js';
import { installSyntheticListSources, syntheticListSources } from './list-fixtures.js';
import { expectError } from '../../../backend/helpers/app.js';
import { registeredListSources, officialListOrigin } from '../../../../packages/compliance/src/lists/catalog.js';
import { syncScreeningListSources } from '../../../../packages/data/src/repositories/screening-list-authority.js';
import { ScreeningListAuthoritySchema } from '../../../../packages/contracts/src/sanctions.js';
import { ingestList } from '../../../../apps/worker/src/screening-lists/ingest.js';
import { fakeListSource, fileListSource, liveListSource } from '../../../../apps/worker/src/screening-lists/sources.js';
import { tx as withWorker } from '../../../worker/helpers/worker-db.js';

test('installed source catalog never treats a query adapter or unsourced endpoint as a list export',()=>{
  assert.deepEqual(registeredListSources(),[], 'built-in facts have no additional export adapter; do not invent a reviewed list');
  assert.equal(syntheticListSources().length,1);
  for(const url of ['http://ofac.treasury.gov/x','https://ofac.treasury.gov.evil.invalid/x','https://user:pass@ofac.treasury.gov/x','https://ofac.treasury.gov:8443/x','https://ofac.treasury.gov/x#fragment'])
    assert.equal(officialListOrigin(url,['https://ofac.treasury.gov']),false);
});

test('file list registration is current-authority, digest-bound, independently approved and immutable', {timeout:240000},async(t)=>{
 const w=await screeningWorld('sanc006_lists');t.after(()=>w.close());
 await installSyntheticListSources(w.h.db.admin);
 const url=`/v1/admin/screening/list-authority?hubId=${w.hubId}`;
 const read=async()=>ScreeningListAuthoritySchema.parse((await w.first.get(url)).body);
 const source=(await read()).sources[0]!;
 const body={hubId:w.hubId,sourceId:source.id,cadenceSeconds:86400,warnAfterSeconds:259200,staleAfterSeconds:604800,reason:'Synthetic source configuration',evidence:'source_review'};
 await t.test('read/write denials and no arbitrary URL/path/adapter/mode authority',async()=>{
  expectError(await w.h.client().get(url),401,'auth.session_invalid');
  for(const c of [w.subject,w.unelevated]) expectError(await c.get(url),403,'access.forbidden');
  expectError(await w.otherStaff.get(url),404,'access.not_found');
  for(const c of [w.subject,w.unelevated,w.otherStaff]) expectError(await c.post('/v1/admin/screening/list-proposals',body),403,'access.forbidden');
  for(const extra of [{sourceUrl:'https://evil.invalid'},{path:'/tmp/x'},{adapter:'fake'},{mode:'live'}]) expectError(await w.first.post('/v1/admin/screening/list-proposals',{...body,...extra}),422,'validation.unknown_field');
  expectError(await w.first.post('/v1/admin/screening/list-proposals',{...body,hubId:randomUUID()}),404,'access.not_found');
  expectError(await w.first.post('/v1/admin/screening/list-proposals',{...body,reason:''}),422,'validation.schema');
  await assert.rejects(w.h.pool.query('INSERT INTO trustwork.screening_list_source DEFAULT VALUES'),/permission denied/);
  await assert.rejects(w.worker.query('SELECT * FROM trustwork.screening_list_source'),/permission denied/);
 });
 const proposed=await w.first.post('/v1/admin/screening/list-proposals',body);assert.equal(proposed.status,200,JSON.stringify(proposed.body));
 const id=(proposed.body as {id:string}).id;
 const proposal=(await read()).proposals.find(p=>p.id===id)!;
 const decision={decision:'approve',actionDigest:proposal.actionDigest,reason:'Synthetic independent source review'};
 await t.test('self and mismatched digest denied; concurrent second approval applies exactly once',async()=>{
  expectError(await w.first.post(`/v1/admin/screening/list-proposals/${id}/decision`,decision),403,'access.second_approver_required');
  expectError(await w.second.post(`/v1/admin/screening/list-proposals/${id}/decision`,{...decision,actionDigest:'0'.repeat(64)}),409,'access.approval_digest_mismatch');
  const responses=await Promise.all([w.second.post(`/v1/admin/screening/list-proposals/${id}/decision`,decision),w.second.post(`/v1/admin/screening/list-proposals/${id}/decision`,decision)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 });
 const list=(await w.h.db.admin.query<{id:string;source_id:string;mode:string}>('SELECT id,source_id,mode FROM trustwork.screening_list WHERE hub_id=$1',[w.hubId])).rows[0]!;
 assert.equal(list.source_id,source.id);assert.equal(list.mode,'file');
 await t.test('stale configuration and withdrawn source cannot be approved; raw roles cannot bypass staff elevation',async()=>{
  const next=await w.first.post('/v1/admin/screening/list-proposals',{...body,reason:'Synthetic subsequent configuration'});
  assert.equal(next.status,200);
  const nextId=(next.body as {id:string}).id;
  const nextProposal=(await read()).proposals.find(p=>p.id===nextId)!;
  assert.equal((await w.first.post(`/v1/admin/screening/lists/${list.id}/status`,{status:'paused',reason:'Synthetic concurrent pause'})).status,200);
  expectError(await w.second.post(`/v1/admin/screening/list-proposals/${nextId}/decision`,{...decision,actionDigest:nextProposal.actionDigest}),409,'validation.revision_conflict');
  assert.equal((await w.first.post(`/v1/admin/screening/lists/${list.id}/status`,{status:'active',reason:'Synthetic resume'})).status,200);
  await withMaintenance(w.h.db.admin,trx=>syncScreeningListSources(trx,[]));
  expectError(await w.second.post(`/v1/admin/screening/list-proposals/${nextId}/decision`,{...decision,actionDigest:nextProposal.actionDigest}),409,'validation.revision_conflict');
  assert.equal((await w.second.post(`/v1/admin/screening/list-proposals/${nextId}/decision`,{...decision,decision:'reject',actionDigest:nextProposal.actionDigest})).status,200);
  await assert.rejects(w.h.pool.query('SELECT trustwork.screening_list_propose($1::jsonb,$2::jsonb)',[JSON.stringify({}),JSON.stringify(body)]));
  await installSyntheticListSources(w.h.db.admin);
 });
 await t.test('file missing and live unavailable stay honest; local fake ingestion is test-only',async()=>{
  const deps={sources:{file:fileListSource({dir:null,maxBytes:1048576}),fake:fakeListSource({production:false}),live:liveListSource({fetcher:null,activation:()=>null,maxBytes:1048576})}};
  const missing=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(missing.outcome,'source_missing');
  await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({mode:'live'}).where('id','=',list.id).execute());
  const live=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(live.outcome,'refused');assert.match(live.error!,/live_not_activated/);
  await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({mode:'fake'}).where('id','=',list.id).execute());
  const fake=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(fake.outcome,'activated');
  const versionSource=(await w.h.db.admin.query<{registered_source_id:string}>('SELECT registered_source_id FROM trustwork.screening_list_version WHERE id=$1',[fake.versionId])).rows[0]!.registered_source_id;
  assert.equal(versionSource,source.id,'immutable version preserves its registered source snapshot');
  await withMaintenance(w.h.db.admin,trx=>syncScreeningListSources(trx,[]));
  const retired=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(retired.error,'source_authority_retired');
 });
 await t.test('baseline cannot be paused, additional controls require reasons, history cannot be rewritten',async()=>{
  const baseline=(await w.h.db.admin.query<{id:string}>('SELECT id FROM trustwork.screening_list WHERE baseline LIMIT 1')).rows[0]!.id;
  expectError(await w.first.post(`/v1/admin/screening/lists/${baseline}/status`,{status:'paused',reason:'Synthetic forbidden baseline change'}),403,'access.forbidden');
  expectError(await w.first.post(`/v1/admin/screening/lists/${list.id}/status`,{status:'paused',reason:''}),422,'validation.schema');
  assert.equal((await w.first.post(`/v1/admin/screening/lists/${list.id}/status`,{status:'paused',reason:'Synthetic pause'})).status,200);
  await assert.rejects(w.h.db.admin.query("UPDATE trustwork.screening_list_proposal SET reason='rewritten' WHERE id=$1",[id]),/immutable/);
 });
 await t.test('approval requires an unexpired proposal and a requester with current staff authority',async()=>{
  await installSyntheticListSources(w.h.db.admin);
  const next=await w.first.post('/v1/admin/screening/list-proposals',{...body,reason:'Synthetic current-authority boundary'});
  assert.equal(next.status,200);
  const nextId=(next.body as {id:string}).id;
  const row=(await w.h.db.admin.query<{action_digest:string;requested_by:string}>('SELECT action_digest,requested_by FROM trustwork.screening_list_proposal WHERE id=$1',[nextId])).rows[0]!;
  const expired=randomUUID();
  await w.h.db.admin.query(`INSERT INTO trustwork.screening_list_proposal(id,hub_id,source_id,requested_by,cadence_seconds,warn_after_seconds,stale_after_seconds,reason,evidence,before_digest,action_digest,expires_at)
    SELECT $1,hub_id,source_id,requested_by,cadence_seconds,warn_after_seconds,stale_after_seconds,reason,evidence,before_digest,action_digest,now()-interval '1 second' FROM trustwork.screening_list_proposal WHERE id=$2`,[expired,nextId]);
  expectError(await w.second.post(`/v1/admin/screening/list-proposals/${expired}/decision`,{...decision,actionDigest:row.action_digest}),409,'validation.revision_conflict');
  await withMaintenance(w.h.db.admin,trx=>trx.updateTable('staff_role_assignment').set({revoked_at:new Date(),revoked_by:w.seed.people.boris}).where('person_id','=',row.requested_by).where('role','=','compliance-officer').execute());
  expectError(await w.second.post(`/v1/admin/screening/list-proposals/${nextId}/decision`,{...decision,actionDigest:row.action_digest}),403,'access.forbidden');
 });
});


test('all list command crash boundaries roll back and replay the exact response once', {timeout:240000},async(t)=>{
 const w=await screeningWorld('sanc006_list_crashes');t.after(()=>w.close());
 const crash=await installCrashPoints(w.h.db.admin);
 await listCrashCases(w.h,w.first,w.second,w.worker,async(route)=>{
  const key=`sanc006-crash-${route.action}`;
  const send=()=>route.client.post(route.url,route.body,{idempotencyKey:key});
  const before=await route.effects();
  try {
   await crash.arm('handler','bookkeeping');assert.equal((await send()).status,500,route.action);assert.equal(await route.effects(),before);
   await crash.disarm('handler');expectError(await send(),409,'validation.idempotency_in_progress');
   w.h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS+1000);
   const done=await send();assert.equal(done.status,200,JSON.stringify(done.body));
   assert.equal((await recordState(w.h.db.admin,key))?.state,'completed');assert.equal(await route.effects(),before+1);
   w.h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS+1000);assert.deepEqual((await send()).body,done.body);assert.equal(await route.effects(),before+1);
   return done;
  } finally {await crash.clear();w.h.clock.reset();}
 });
});

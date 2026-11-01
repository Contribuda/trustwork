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
 await t.test('file missing and live unavailable stay honest; local fake ingestion is test-only',async()=>{
  const deps={sources:{file:fileListSource({dir:null,maxBytes:1048576}),fake:fakeListSource({production:false}),live:liveListSource({fetcher:null,activation:()=>null,maxBytes:1048576})}};
  const missing=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(missing.outcome,'source_missing');
  await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({mode:'live'}).where('id','=',list.id).execute());
  const live=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(live.outcome,'refused');assert.match(live.error!,/live_not_activated/);
  await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({mode:'fake'}).where('id','=',list.id).execute());
  const fake=await withWorker(w.worker,trx=>ingestList(trx,list.id,deps,new AbortController().signal));assert.equal(fake.outcome,'activated');
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
});

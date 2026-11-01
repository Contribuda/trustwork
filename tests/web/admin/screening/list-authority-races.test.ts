import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { bindTransaction, withMaintenance } from '@trustwork/data';
import { screeningWorld } from './world.js';
import { installSyntheticListSources } from './list-fixtures.js';
import { ingestList } from '../../../../apps/worker/src/screening-lists/ingest.js';
import { fakeListSource, type ListSource } from '../../../../apps/worker/src/screening-lists/sources.js';
import { screeningListWorker } from '../../../../packages/data/src/repositories/screening-lists.js';
import { findListAdapter, listDigest, renderOfacSlsXml, FAKE_LIST_ENTRIES } from '../../../../packages/compliance/src/lists/index.js';
import { checkListSanity } from '../../../../packages/contracts/src/sanctions.js';
import { fixture } from '../../../screening-lists/helpers.js';
import { gate, tx, waitFor } from '../../../worker/helpers/worker-db.js';

type World = Awaited<ReturnType<typeof screeningWorld>>;
async function proposal(w: World) {
 const source=(await w.h.db.admin.query<{id:string}>('SELECT id FROM trustwork.screening_list_source WHERE current')).rows[0]!;
 const response=await w.first.post('/v1/admin/screening/list-proposals',{hubId:w.hubId,sourceId:source.id,cadenceSeconds:86400,warnAfterSeconds:259200,staleAfterSeconds:604800,reason:'Synthetic concurrency evidence',evidence:'source_review'});
 assert.equal(response.status,200,JSON.stringify(response.body));
 const id=(response.body as {id:string}).id;
 return (await w.h.db.admin.query<{id:string;action_digest:string;requested_elevation_id:string;authority_node_id:string}>('SELECT * FROM trustwork.screening_list_proposal WHERE id=$1',[id])).rows[0]!;
}
async function context(w: World, person: string) {
 const row=(await w.h.db.admin.query<{id:string;session_id:string}>('SELECT id,session_id FROM trustwork.session_elevation WHERE person_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',[person])).rows[0]!;
 return {elevationId:row.id,sessionId:row.session_id,requestId:'synthetic-race',reasonCode:'synthetic_test',reasonText:'Synthetic concurrency review'};
}
async function beginActor(w: World) {
 const c=await w.h.pool.connect(); await c.query('BEGIN');
 await c.query("SET LOCAL statement_timeout='15s'");
 const epoch=(await w.h.db.admin.query<{authz_epoch:number}>('SELECT authz_epoch FROM trustwork.person WHERE id=$1',[w.seed.people.boris])).rows[0]!.authz_epoch;
 try {await c.query('SELECT trustwork.set_principal($1,$2)',[w.seed.people.boris,epoch]);} catch(error) {await c.query('ROLLBACK');c.release();throw error;}
 return c;
}
async function blocked(w: World, c: pg.PoolClient) {
 const pid=(c as pg.PoolClient & {processID:number}).processID;
 await waitFor(async()=> (await w.h.db.admin.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0]?.waiting,5000,'competing SQL is blocked');
}
async function retire(c: pg.PoolClient) {await c.query('UPDATE trustwork.screening_list_source SET current=false WHERE current');}
const decide=(c: pg.PoolClient, ctx: object, p:{id:string;action_digest:string})=>c.query('SELECT trustwork.screening_list_decide($1,$2,\'approve\',$3,\'Synthetic review\')',[JSON.stringify(ctx),p.id,p.action_digest]);
const denied=(promise:Promise<unknown>)=>assert.rejects(promise,(e:unknown)=>['42501','23514'].includes((e as {code:string}).code));
async function configured(w: World) {
 await installSyntheticListSources(w.h.db.admin);
 const p=await proposal(w); const ctx=await context(w,w.seed.people.boris); const c=await beginActor(w);
 try {await decide(c,ctx,p);await c.query('COMMIT');} finally {await c.query('ROLLBACK');c.release();}
 const list=(await w.h.db.admin.query<{id:string}>('SELECT id FROM trustwork.screening_list WHERE hub_id=$1',[w.hubId])).rows[0]!;
 await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({mode:'fake',min_entries:1}).where('id','=',list.id).execute());
 return list.id;
}

test('actual ingestion and raw SQL serialize source retirement in both orders', {timeout:240000},async(t)=>{
 const w=await screeningWorld('sanc006_source_races');t.after(()=>w.close());
 const id=await configured(w);
 const fake=fakeListSource({production:false});
 const deps=(source:ListSource)=>({sources:{fake:source,file:source,live:source}});
 await tx(w.worker,trx=>ingestList(trx,id,deps(fake),new AbortController().signal));
 for(const outcome of ['unchanged','needs_confirmation','activated'] as const) await t.test(`ingestion first: ${outcome} holds authority while obtain awaits`,async()=>{
  await installSyntheticListSources(w.h.db.admin);
  // Distinct exports exercise the unchanged, reduced staged and ordinary activation branches.
  const text=outcome==='unchanged'?null:outcome==='needs_confirmation'?renderOfacSlsXml({publishedOn:'2026-10-31',entries:FAKE_LIST_ENTRIES.slice(0,1)}):fixture('ofac-cons-synthetic.xml');
  if(outcome==='needs_confirmation') await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({max_drop_share:'0.01'}).where('id','=',id).execute());
  if(outcome==='activated') await withMaintenance(w.h.db.admin,trx=>trx.updateTable('screening_list').set({max_drop_share:'0.99'}).where('id','=',id).execute());
  const entered=gate(),release=gate();
  const source:ListSource={mode:'fake',async obtain(...args){entered.open();await release.promise;return text?{text,obtainedAt:new Date(),sourceDigest:'a'.repeat(64)}:fake.obtain(...args);}};
  const ingest=tx(w.worker,trx=>ingestList(trx,id,deps(source),new AbortController().signal));
  const c=await w.h.db.admin.connect();
  try {
   await entered.promise;await c.query('BEGIN');const retiring=retire(c);await blocked(w,c);
   release.open();const result=await ingest;assert.equal(result.outcome,outcome);
   await retiring;await c.query('COMMIT');
   const after=(await w.h.db.admin.query('SELECT last_checked_at,last_outcome FROM trustwork.screening_list WHERE id=$1',[id])).rows[0];
   const refused=await tx(w.worker,trx=>ingestList(trx,id,deps({mode:'fake',async obtain(){throw new Error('retired source must not be obtained');}}),new AbortController().signal));
   assert.equal(refused.error,'source_authority_retired');
   assert.equal((await w.h.db.admin.query('SELECT last_checked_at FROM trustwork.screening_list WHERE id=$1',[id])).rows[0].last_checked_at?.toISOString(),after.last_checked_at?.toISOString());
  } finally {release.open();await c.query('ROLLBACK');c.release();}
 });
 for(const path of ['worker','raw unchanged','raw stage','raw activation'] as const) await t.test(`retirement first refuses ${path} after waiting, without stale snapshot`,async()=>{
  await installSyntheticListSources(w.h.db.admin);
  const parsed=findListAdapter('ofac-sls-xml')!.parse(fixture('ofac-sdn-synthetic.xml'));
  const version=await tx(w.worker,trx=>screeningListWorker.stage(trx,{listId:id,publishedOn:parsed.publishedOn,fetchedAt:new Date(),mode:'fake',sourceDigest:'b'.repeat(64),digest:listDigest(parsed.entries),sanity:checkListSanity({parsedCount:parsed.entries.length,declaredCount:parsed.declaredCount,previousCount:null,maxDropShare:0.99,minEntries:1}),entries:parsed.entries}));
  const retirement=await w.h.db.admin.connect(),worker=await w.worker.connect();
  try {
   await retirement.query('BEGIN');await retire(retirement);await worker.query('BEGIN');
   const action=path==='worker'?ingestList(bindTransaction(worker),id,deps({mode:'fake',async obtain(){throw new Error('retired source obtained');}}),new AbortController().signal):path==='raw unchanged'?worker.query("SELECT trustwork.screening_list_record_attempt($1,'unchanged',NULL,now())",[id]):path==='raw stage'?worker.query("SELECT trustwork.screening_list_stage($1,current_date,now(),'fake',repeat('a',64),1,repeat('b',64),'{}')",[id]):worker.query('SELECT trustwork.screening_list_activate($1)',[version]);
   const checked=path==='worker'?action.then(r=>assert.equal((r as {error:string}).error,'source_authority_retired')):denied(action);
   await blocked(w,worker);await retirement.query('COMMIT');await checked;
   await worker.query(path==='worker'?'COMMIT':'ROLLBACK');
   assert.equal((await w.h.db.admin.query('SELECT state FROM trustwork.screening_list_version WHERE id=$1',[version])).rows[0].state,'staged');
  } finally {await retirement.query('ROLLBACK');await worker.query('ROLLBACK');retirement.release();worker.release();}
 });
 await t.test('raw staging, freshness and activation first hold the same gate through commit',async()=>{
  for(const path of ['stage','unchanged','activation']) {
   await installSyntheticListSources(w.h.db.admin);
   const worker=await w.worker.connect(),retirement=await w.h.db.admin.connect();
   try {
    await worker.query('BEGIN');
    if(path==='stage') await worker.query("SELECT trustwork.screening_list_stage($1,current_date,now(),'fake',repeat('a',64),1,repeat('b',64),'{}')",[id]);
    if(path==='unchanged') await worker.query("SELECT trustwork.screening_list_record_attempt($1,'unchanged',NULL,now())",[id]);
    if(path==='activation') {
     const p=findListAdapter('ofac-sls-xml')!.parse(fixture('ofac-cons-synthetic.xml'));
     const v=await screeningListWorker.stage(bindTransaction(worker),{listId:id,publishedOn:p.publishedOn,fetchedAt:new Date(),mode:'fake',sourceDigest:'c'.repeat(64),digest:listDigest(p.entries),sanity:checkListSanity({parsedCount:p.entries.length,declaredCount:p.declaredCount,previousCount:null,maxDropShare:0.99,minEntries:1}),entries:p.entries});
     assert.equal(await screeningListWorker.activate(bindTransaction(worker),v),'activated');
    }
    await retirement.query('BEGIN');const pending=retire(retirement);await blocked(w,retirement);
    await worker.query('COMMIT');await pending;await retirement.query('COMMIT');
   } finally {await worker.query('ROLLBACK');await retirement.query('ROLLBACK');worker.release();retirement.release();}
  }
 });
 await t.test('new unregistered additions and repeatable-read snapshots never acquire authority',async()=>{
  const unregistered=(await w.h.db.admin.query("INSERT INTO trustwork.screening_list(hub_id,code,name,authority,source_url,adapter,mode,cadence,warn_after,stale_after) VALUES($1,'synthetic-unregistered','Synthetic','Synthetic','https://example.invalid','ofac-sls-xml','fake','1 day','2 days','3 days') RETURNING id",[w.hubId])).rows[0].id;
  assert.equal((await w.worker.query('SELECT trustwork.screening_list_source_current($1) AS current',[unregistered])).rows[0].current,false);
  await denied(w.worker.query("SELECT trustwork.screening_list_stage($1,current_date,now(),'fake',repeat('a',64),1,repeat('b',64),'{}')",[unregistered]));
  const c=await w.worker.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await assert.rejects(c.query('SELECT trustwork.screening_list_lock($1)',[id]),(e:unknown)=>(e as {code:string}).code==='40001');}finally{await c.query('ROLLBACK');c.release();}
 });
});

for(const who of ['requester','reviewer'] as const) for(const kind of ['role','session','elevation','epoch'] as const) test(`current ${who} ${kind}: approval wins and revocation wins on competing connections`,{timeout:120000},async()=>{
 const w=await screeningWorld(`sanc006_${who}_${kind}`);
 try {
  await installSyntheticListSources(w.h.db.admin);
  const first=await proposal(w),next=await proposal(w);
  const reviewer=await context(w,w.seed.people.boris),requester=await context(w,w.seed.people.anna);
  const person=who==='requester'?w.seed.people.anna:w.seed.people.boris;
  const actorContext=who==='requester'?requester:reviewer;
  const actor=await beginActor(w),revoker=await w.h.db.admin.connect(),waiter=await beginActor(w),barrier=await w.h.db.admin.connect();
  try {
   await decide(actor,reviewer,first);
   await barrier.query('BEGIN');await barrier.query('SELECT id FROM trustwork.screening_list_proposal WHERE id=$1 FOR UPDATE',[next.id]);
   await revoker.query('BEGIN');await revoker.query('SET LOCAL ROLE trustwork_owner');await revoker.query("SET LOCAL trustwork.maintenance='on'");
   const revoke=kind==='role'?revoker.query("UPDATE trustwork.staff_role_assignment SET revoked_at=now(),revoked_by=$1,revoke_reason='Synthetic race' WHERE person_id=$2 AND role='compliance-officer' AND revoked_at IS NULL",[w.seed.people.boris,person]):kind==='session'?revoker.query("UPDATE trustwork.session SET revoked_at=now(),revoked_reason='admin' WHERE id=$1",[actorContext.sessionId]):kind==='elevation'?revoker.query("UPDATE trustwork.session_elevation SET revoked_at=now(),revoked_reason='ended' WHERE id=$1",[actorContext.elevationId]):revoker.query('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1',[person]);
   await blocked(w,revoker);
   // The second decision starts with a valid principal before the competing revocation commits.
   const pending=assert.rejects(decide(waiter,reviewer,next),(e:unknown)=>(e as {hint:string}).hint==='admin.forbidden');await blocked(w,waiter);
   await actor.query('COMMIT');await revoke;await revoker.query('COMMIT');await blocked(w,waiter);await barrier.query('COMMIT');await pending;
   assert.equal((await w.h.db.admin.query('SELECT state FROM trustwork.screening_list_proposal WHERE id=$1',[first.id])).rows[0].state,'approved');
   assert.equal((await w.h.db.admin.query('SELECT state FROM trustwork.screening_list_proposal WHERE id=$1',[next.id])).rows[0].state,'pending');
  } finally {for(const c of [actor,revoker,waiter,barrier]){await c.query('ROLLBACK');c.release();}}
 } finally {await w.close();}
});

test('scope and proposal authority provenance cannot be rewritten, and elapsed elevation cannot authorize a waiting decision',{timeout:120000},async()=>{
 const w=await screeningWorld('sanc006_scope_expiry');
 try {
  await installSyntheticListSources(w.h.db.admin);const p=await proposal(w);
  const reviewer=await context(w,w.seed.people.boris);
  await assert.rejects(w.h.db.admin.query("UPDATE trustwork.staff_role_assignment SET scope_kind='hub',node_id=NULL,hub_id=$1 WHERE person_id=$2 AND role='compliance-officer'",[w.hubId,w.seed.people.anna]),/immutable|only changes by revocation/);
  await assert.rejects(w.h.db.admin.query('UPDATE trustwork.hub_profile SET node_id=gen_random_uuid() WHERE hub_id=$1',[w.hubId]),/a hub keeps its node and creator/);
  for(const column of ['requested_elevation_id','authority_node_id','requested_authz_epoch']) await assert.rejects(w.h.db.admin.query(`UPDATE trustwork.screening_list_proposal SET ${column}=NULL WHERE id=$1`,[p.id]),/immutable/);
  const short=(await w.h.db.admin.query<{id:string}>("INSERT INTO trustwork.session_elevation(person_id,session_id,factor_kind,created_at,expires_at) VALUES($1,$2,'totp',clock_timestamp(),clock_timestamp()+interval '500 milliseconds') RETURNING id",[w.seed.people.boris,reviewer.sessionId])).rows[0]!;
  const barrier=await w.h.db.admin.connect(),actor=await beginActor(w);
  try {
   await barrier.query('BEGIN');await barrier.query('SELECT id FROM trustwork.screening_list_proposal WHERE id=$1 FOR UPDATE',[p.id]);
   const pending=assert.rejects(decide(actor,{...reviewer,elevationId:short.id},p),(e:unknown)=>(e as {hint:string}).hint==='admin.forbidden');
   await blocked(w,actor);await barrier.query('SELECT pg_sleep(0.55)');await barrier.query('COMMIT');await pending;
   assert.equal((await w.h.db.admin.query('SELECT state FROM trustwork.screening_list_proposal WHERE id=$1',[p.id])).rows[0].state,'pending');
  } finally {await actor.query('ROLLBACK');await barrier.query('ROLLBACK');actor.release();barrier.release();}
 } finally {await w.close();}
});

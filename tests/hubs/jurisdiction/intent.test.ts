import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance } from '@trustwork/data';
import { computeDigest, MandateV2Schema } from '@trustwork/contracts';
import { mandates, runs, actionIntents, assistantWorker } from '../../../packages/data/src/repositories/assistant.js';
import { AgentModuleManifestSchema } from '../../../packages/contracts/src/agent-catalog.js';
import { engineDefaultPolicy } from '../../../packages/contracts/src/agent-modules.js';
import { SYNTHETIC_ORDER_MANIFEST } from '../../assistant/manifest-fixture.js';
import { untilDatabaseTimePasses } from '../../data/helpers/postgres.js';
import { jobs } from '../../../packages/data/src/repositories/reliability.js';
import { jurisdictionEvidence, jurisdictionAuthority, jurisdictionWorker } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { hubConfig } from '../../../packages/data/src/repositories/hubs.js';
import { prepareJurisdictionIntent, recordJurisdictionIntent, requireCurrentJurisdiction } from '../../../apps/api/src/modules/hubs/jurisdiction/intent-adapter.js';
import { inTransaction } from '../../../apps/worker/src/db.js';
import { silentLogger } from '@trustwork/worker';
import { defineEffectImplementation, dispatchHandler, FakeEffectProvider } from '../../../apps/worker/src/assistant/index.js';
import type { EffectImplementationDeclaration } from '../../../packages/contracts/src/agent-modules.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';
import { rejects } from '../helpers.js';

const db=await provisionTestDatabase('jurisdiction_intents',{weight:2});
test('jurisdiction adapter composes actual mandate, intent, approval and worker authority',{skip:db?false:'PostgreSQL unavailable'},async t=>{
 if(!db)return;t.after(()=>db.close());await db.migrate();await db.createAppLogin();
 const f=await authorityFixture(db.admin,db.app);const {a,p}=f;
 const deal=await createQuote(a.as,p.outsider,p.moderator);
 await f.attest('person',p.outsider);await f.attest('person',p.moderator);await f.attest('project',deal.projectId);
 // Explicit reviewed absence in a SYNTHETIC source only. No existing country fact is changed or inferred.
 const doc=sourceDocument('US','synthetic-no-consent');doc.policy.consentRequirements=[];
 const src=await withMaintenance(db.admin,trx=>jurisdictionEvidence.importSource(trx,doc));
 const s=f.payload.agentSettings.jurisdictions[0]!;s.sourceId=src.id;f.payload.agentSettings.jurisdictions[0]!.sourceRevision=src.revision;s.sourceDigest=src.digest;s.policy=doc.policy;
 await f.activate(await f.draft());
 const manifest=AgentModuleManifestSchema.parse({...SYNTHETIC_ORDER_MANIFEST,actions:['send_quote'],capabilities:[{
   ...SYNTHETIC_ORDER_MANIFEST.capabilities[0],id:'deal_desk.send_quote',mandateAction:'send_quote',contextKinds:['quote'],budgetKind:null,
 }]});
 const implementation={id:'synthetic-jurisdiction-quote@1',moduleKey:'deal_desk',moduleVersion:'1.0.0',capabilityId:'deal_desk.send_quote',
   provider:'synthetic',operation:'quote',mandateAction:'send_quote',contextKinds:['quote'],privateDataClasses:manifest.capabilities[0]!.privateDataClasses,egress:'none',payloadContract:'synthetic-quote@1'};
 const control=engineDefaultPolicy(f.hubId,{manifests:[manifest],extensions:[]}).modules[0]!;
 control.limits={...control.limits,concurrentRuns:100};
 const bindings=await withMaintenance(db.admin,async trx=>{
   await sql`INSERT INTO trustwork.agent_engine_manifest(module_key,module_version,document,default_control) VALUES('deal_desk','1.0.0',${JSON.stringify(manifest)}::jsonb,${JSON.stringify(control)}::jsonb)`.execute(trx);
   await sql`INSERT INTO trustwork.agent_effect_handler(module_key,module_version,capability_id,provider,operation,implementation) VALUES('deal_desk','1.0.0','deal_desk.send_quote','synthetic','quote',${JSON.stringify(implementation)}::jsonb)`.execute(trx);
   const session=await trx.insertInto('session').values({person_id:p.moderator,token_hash:randomBytes(32),idle_expires_at:new Date(Date.now()+3600000),absolute_expires_at:new Date(Date.now()+3600000),auth_method:'password'}).returning('id').executeTakeFirstOrThrow();
   const serving=await sql<{id:string}>`INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES('https://synthetic-jurisdiction.invalid',${f.hubId}::uuid) RETURNING id`.execute(trx);
   const foreign=await sql<{id:string}>`INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES('https://synthetic-jurisdiction-other.invalid',${f.otherHubId}::uuid) RETURNING id`.execute(trx);
   return {session:session.id,serving:serving.rows[0]!.id,foreign:foreign.rows[0]!.id};
 });
 const snapshot=MandateV2Schema.parse({id:randomUUID(),schemaVersion:2,principal:{personId:p.moderator,onBehalfOf:null},grantee:{kind:'own_agent'},moduleKeys:['deal_desk'],actions:['send_quote'],contexts:[{kind:'quote',id:deal.quoteId}],limits:{ceiling:null,perActionCeiling:null,transactionBudgetId:null,platformBudgetId:null,perWindow:null},conditions:[],approvalPolicy:{mode:'pre_authorized'},approvers:[],escalation:{kind:'ask_principal'},confirmation:{via:'first_party_form',personId:p.moderator,at:new Date().toISOString(),stepUp:true},validUntil:'2099-01-01T00:00:00.000Z',status:'active',revision:1,revokedAt:null});
 await a.as(p.moderator,trx=>mandates.confirm(trx,{snapshot,contexts:snapshot.contexts,digest:computeDigest(snapshot).value,expectedRevision:null,stepUp:true,proposalId:null}));
 const request={personId:p.moderator,mandateId:snapshot.id,moduleKeys:['deal_desk'],action:'send_quote' as const,context:{kind:'quote' as const,id:deal.quoteId},amount:{minorUnits:'10001',currency:'USD'},projectId:deal.projectId,at:new Date()};
 const settings={hubId:f.otherHubId,forbiddenPreAuthorization:[],isRestricted:()=>false};
 const record=async(minorUnits:string,serving=bindings.serving)=>a.as(p.moderator,async trx=>{
   const run=await runs.start(trx,{principal_person_id:p.moderator,kind:'conversation',mandate_id:snapshot.id});
   await sql`SELECT trustwork.agent_modules_bind_run(${run.id}::uuid,${serving}::uuid,${bindings.session}::uuid)`.execute(trx);
   return recordJurisdictionIntent(trx,{request:{...request,amount:{minorUnits,currency:'USD'}},settings,runId:run.id,capabilityId:'deal_desk.send_quote',effect:{provider:'synthetic',operation:'quote',payload:{synthetic:true}}});
 });
 await t.test('permissive confirmed mandate becomes a real proposed intent above the jurisdiction threshold',async()=>{
   const decision=await a.as(p.moderator,trx=>prepareJurisdictionIntent(trx,request,settings));
   assert.equal(decision.mandate.outcome.effect,'allow');assert.equal(decision.effect,'ask');assert.equal(decision.limits.hubId,f.hubId);
   const intent=await record('10001');assert.equal(intent.state,'proposed');assert.ok(intent.intentId);
   await rejects(a.as(p.moderator,trx=>actionIntents.queue(trx,intent.intentId!,300,null)),'23514');
   await a.as(p.moderator,trx=>actionIntents.approve(trx,intent.intentId!,intent.actionDigest,300,true));
   await a.as(p.moderator,trx=>requireCurrentJurisdiction(trx,intent.intentId!));
   await rejects(a.as(p.outsider,trx=>jurisdictionAuthority.bind(trx,intent.intentId!,intent.limits.bindingDigest!)),'42501');
 });
 const workerRole=`hub005_worker_${randomBytes(4).toString('hex')}`;const password=randomBytes(12).toString('hex');
 await db.admin.query(`CREATE ROLE ${workerRole} LOGIN PASSWORD '${password}' INHERIT IN ROLE trustwork_worker`);
 const worker=createPool({...db.appConfig,user:workerRole,password,max:2});t.after(()=>worker.end());
 const queue=async()=>{const intent=await record('1');await a.as(p.moderator,trx=>actionIntents.queue(trx,intent.intentId!,300,null));return intent;};
 const lease=()=>inTransaction(worker,trx=>jobs.lease(trx,['assistant.dispatch'],'synthetic-jurisdiction-worker',300,10));
 let original:{intentId:string;attemptId:string;correlationKey:string;jobId:string;fence:string};
 await t.test('worker composes the real attempt command; API role and stale fencing token cannot dispatch',async()=>{
   const intent=await queue();const job=(await lease()).find(j=>(j.payload as {intentId:string}).intentId===intent.intentId)!;assert.ok(job);
   await rejects(a.as(p.moderator,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token))),'42501');
   await rejects(inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(BigInt(job.fencing_token)+1n))),'55P03');
   const result=await inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token)));
   assert.equal(result.status,'dispatch'); // No provider is called by this test.
   original={intentId:intent.intentId!,attemptId:String(result.attemptId),correlationKey:String(result.correlationKey),jobId:job.id,fence:String(job.fencing_token)};
   await inTransaction(worker,trx=>assistantWorker.recordOutcome(trx,original.attemptId,{kind:'unknown',reason:'crash'}));
 });
 const attempts=async(id:string)=>(await db.admin.query('SELECT count(*)::int n FROM trustwork.action_attempt WHERE action_intent_id=$1',[id])).rows[0].n as number;
 const stateOf=async(id:string)=>(await db.admin.query('SELECT state FROM trustwork.action_intent WHERE id=$1',[id])).rows[0].state as string;
 /** The real dispatch handler, under the worker login, with a code-owned fake effect. */
 const dispatch=async(intentId:string,leased?:Awaited<ReturnType<typeof lease>>)=>{
   const job=(leased??await lease()).find(j=>(j.payload as {intentId:string}).intentId===intentId)!;assert.ok(job);
   const provider=new FakeEffectProvider('synthetic');
   const handler=dispatchHandler({pool:worker,providers:[provider],implementations:[defineEffectImplementation(implementation as EffectImplementationDeclaration,provider,input=>structuredClone(input))],hubId:null,log:silentLogger});
   await handler.run({job,payload:{intentId},attemptId:randomUUID(),effectKey:`job:${job.id}`,signal:new AbortController().signal});
   return provider;
 };
 await t.test('the dispatch handler enters through jurisdiction: a bound quote intent reaches its effect',async()=>{
   const intent=await queue();
   assert.equal((await dispatch(intent.intentId!)).submissions.length,1);
   assert.equal(await stateOf(intent.intentId!),'succeeded');
 });
 await t.test('the dispatch handler refuses a quote intent that carries no binding, and calls nothing',async()=>{
   const unbound=await a.as(p.moderator,async trx=>{
     const run=await runs.start(trx,{principal_person_id:p.moderator,kind:'conversation',mandate_id:snapshot.id});
     await sql`SELECT trustwork.agent_modules_bind_run(${run.id}::uuid,${bindings.serving}::uuid,${bindings.session}::uuid)`.execute(trx);
     const prepared=await prepareJurisdictionIntent(trx,{...request,amount:{minorUnits:'1',currency:'USD'}},settings);if(prepared.effect==='deny')throw new Error('synthetic intent refused');
     const mandate=prepared.mandate.outcome;if(mandate.effect==='deny')throw new Error('synthetic mandate refused');
     const effect={provider:'synthetic',operation:'quote',payload:{synthetic:true}};
     return actionIntents.record(trx,{runId:run.id,mandateId:mandate.mandate.id,mandateRevision:mandate.mandate.revision,capabilityId:'deal_desk.send_quote',moduleKey:mandate.moduleKey,action:'send_quote',context:mandate.context,
       resolvedFromSelector:mandate.resolvedFromSelector,amount:{minorUnits:'1',currency:'USD'},digest:computeDigest({synthetic:'unbound quote intent',at:run.id}).value,effect,decision:prepared.effect,askReasons:prepared.reasons});
   });
   await a.as(p.moderator,trx=>actionIntents.queue(trx,unbound.intentId!,300,null));
   assert.equal((await dispatch(unbound.intentId!)).submissions.length,0);
   assert.equal(await stateOf(unbound.intentId!),'revoked');assert.equal(await attempts(unbound.intentId!),0);
 });
 const hold=(person:string)=>withMaintenance(db.admin,trx=>trx.insertInto('jurisdiction_hold').values({person_id:person,place:'ZZ',source:'staff_report',dataset:'synthetic'}).execute());
 const clear=(person:string)=>withMaintenance(db.admin,trx=>trx.updateTable('jurisdiction_hold').set({cleared_at:new Date(),cleared_by:p.officer,clear_reason:'Synthetic clearance',clear_evidence:'other'}).where('person_id','=',person).where('cleared_at','is',null).execute());
 for(const [label,party] of [['the principal',p.moderator],['the other side of the quote',p.outsider]] as const)await t.test(`a hold on ${label} placed after queueing stops the attempt`,async()=>{
   const direct=await queue(),handled=await queue();
   const leased=await lease();const job=leased.find(j=>(j.payload as {intentId:string}).intentId===direct.intentId)!;
   await hold(party);
   try{
     assert.deepEqual(await inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,direct.intentId!,job.id,String(job.fencing_token))),{status:'refused',reason:'party_held'});
     assert.equal((await dispatch(handled.intentId!,leased)).submissions.length,0);
     for(const id of [direct.intentId!,handled.intentId!]){assert.equal(await stateOf(id),'revoked');assert.equal(await attempts(id),0);}
   }finally{await clear(party);}
   const after=await queue();
   assert.equal((await dispatch(after.intentId!)).submissions.length,1,'a cleared hold stops nothing');
 });
 await t.test('an immutable foreign serving origin cannot be replaced by jurisdiction or process hub',async()=>{
   const intent=await record('1',bindings.foreign);await a.as(p.moderator,trx=>actionIntents.queue(trx,intent.intentId!,300,null));
   const job=(await lease()).find(j=>(j.payload as {intentId:string}).intentId===intent.intentId)!;
   assert.deepEqual(await inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token))),{status:'refused',reason:'jurisdiction_policy_changed'});
   assert.equal((await db.admin.query('SELECT count(*)::int n FROM trustwork.action_attempt WHERE action_intent_id=$1',[intent.intentId])).rows[0].n,0);
 });
 const waitForLock=async()=>{
   for(let n=0;n<300;n++){
     if((await db.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n>0)return;
     await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert.fail('expected current authority lock waiter');
 };
 await t.test('lease expiry while waiting for jurisdiction is rechecked before any attempt',async()=>{
   const intent=await queue();const job=(await lease()).find(j=>(j.payload as {intentId:string}).intentId===intent.intentId)!;
   const blocker=await db.admin.connect();let pending:Promise<unknown>|undefined;
   try{
     await blocker.query('BEGIN');await blocker.query('SELECT trustwork.jurisdiction_lock()');
     const end=(await db.admin.query("UPDATE trustwork.job SET leased_until=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING leased_until",[job.id])).rows[0].leased_until as Date;
     pending=rejects(inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token))),'55P03');
     await waitForLock();await untilDatabaseTimePasses(db.admin,end);await blocker.query('COMMIT');await pending;
   }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
   assert.equal((await db.admin.query('SELECT count(*)::int n FROM trustwork.action_attempt WHERE action_intent_id=$1',[intent.intentId])).rows[0].n,0);
 });
 for(const order of ['attempt first','policy first'] as const)await t.test(`current policy serialization: ${order}`,async()=>{
   const intent=await queue();const job=(await lease()).find(j=>(j.payload as {intentId:string}).intentId===intent.intentId)!;
   const version=await f.draft();const approval=await f.approvalFor(version);
   let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
   let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
   const activate=(held:boolean)=>a.cmd(p.officer,async(trx,ctx)=>{await hubConfig.activate(trx,ctx,version.id,version.revision,approval);if(held){enter();await hold;}});
   const attempt=(held:boolean)=>inTransaction(worker,async trx=>{const result=await jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token));if(held){enter();await hold;}return result;});
   if(order==='attempt first'){
     const running=attempt(true);await entered;const changing=activate(false);
     try{await waitForLock();}finally{release();}
     assert.equal((await running).status,'dispatch');await changing;
   }else{
     const changing=activate(true);await entered;const running=attempt(false);
     try{await waitForLock();}finally{release();}
     await changing;assert.deepEqual(await running,{status:'refused',reason:'jurisdiction_policy_changed'});
   }
 });
 await t.test('new active policy invalidates earlier approval and worker intent before an attempt exists',async()=>{
   const intent=await record('10001');await a.as(p.moderator,trx=>actionIntents.approve(trx,intent.intentId!,intent.actionDigest,300,true));
   await a.as(p.moderator,trx=>actionIntents.queue(trx,intent.intentId!,300,null));
   const job=(await lease()).find(j=>(j.payload as {intentId:string}).intentId===intent.intentId)!;
   const next=structuredClone(f.payload);next.agentSettings.jurisdictions[0]!.policy.actionLimits[0]!.approvalAbove!.minorUnits='0';
   await f.activate(await f.draft(next));
   await assert.rejects(a.as(p.moderator,trx=>requireCurrentJurisdiction(trx,intent.intentId!)),{message:'jurisdiction.policy_changed'});
   const refused=await inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token)));
   assert.deepEqual(refused,{status:'refused',reason:'jurisdiction_policy_changed'});
   const attempts=await db.admin.query('SELECT count(*)::int n FROM trustwork.action_attempt WHERE action_intent_id=$1',[intent.intentId]);assert.equal(attempts.rows[0].n,0);
 });
 await t.test('withdrawn policy never redispatches an unknown operation; only the original receipt settles it',async()=>{
   const skipped=await inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,original.intentId,original.jobId,original.fence));
   assert.equal(skipped.status,'skip');
   const recovery=await inTransaction(worker,trx=>assistantWorker.beginReconciliation(trx,original.intentId));
   assert.equal(recovery.status,'reconcile');if(recovery.status!=='reconcile')throw new Error('missing original recovery');
   assert.equal(recovery.attemptId,original.attemptId);assert.equal(recovery.correlationKey,original.correlationKey);assert.deepEqual(recovery.implementation,implementation);
   await inTransaction(worker,trx=>assistantWorker.recordReconciliation(trx,original.intentId,'synthetic-original-receipt',{kind:'final',result:'succeeded',providerReference:'synthetic-receipt',evidence:'Exact original operation receipt'}));
   const row=(await db.admin.query('SELECT state,attempt_count FROM trustwork.action_intent WHERE id=$1',[original.intentId])).rows[0];
   assert.equal(row.state,'succeeded');assert.equal(row.attempt_count,1);
 });
 await t.test('a human approval is not consent evidence',async()=>{
   const consent=sourceDocument('US','synthetic-consent-required');
   const src=await withMaintenance(db.admin,trx=>jurisdictionEvidence.importSource(trx,consent));
   s.sourceId=src.id;s.sourceRevision=src.revision;s.sourceDigest=src.digest;s.policy=consent.policy;
   await f.activate(await f.draft());
   const result=await a.as(p.moderator,trx=>prepareJurisdictionIntent(trx,request,settings));
   assert.equal(result.effect,'deny');assert.ok(result.reasons.includes('jurisdiction_consent_evidence_unavailable'));
   await assert.rejects(record('1'),{message:'jurisdiction.execution_refused'});
 });
 await t.test('unknown counterparty applicability cannot be replaced by the process hub or a human approval',async()=>{
   await f.attest('person',p.outsider,['GB']);
   const result=await a.as(p.moderator,trx=>prepareJurisdictionIntent(trx,request,settings));assert.equal(result.effect,'deny');
   await assert.rejects(record('1'),{message:'jurisdiction.execution_refused'});
 });
});

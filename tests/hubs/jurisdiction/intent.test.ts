import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPool, withMaintenance } from '@trustwork/data';
import { computeDigest, MandateV2Schema } from '@trustwork/contracts';
import { mandates, runs, actionIntents } from '../../../packages/data/src/repositories/assistant.js';
import { jobs } from '../../../packages/data/src/repositories/reliability.js';
import { jurisdictionEvidence, jurisdictionAuthority, jurisdictionWorker } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { prepareJurisdictionIntent, recordJurisdictionIntent, requireCurrentJurisdiction } from '../../../apps/api/src/modules/hubs/jurisdiction/intent-adapter.js';
import { inTransaction } from '../../../apps/worker/src/db.js';
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
 const snapshot=MandateV2Schema.parse({id:randomUUID(),schemaVersion:2,principal:{personId:p.moderator,onBehalfOf:null},grantee:{kind:'own_agent'},moduleKeys:['deal_desk'],actions:['send_quote'],contexts:[{kind:'quote',id:deal.quoteId}],limits:{ceiling:null,perActionCeiling:null,transactionBudgetId:null,platformBudgetId:null,perWindow:null},conditions:[],approvalPolicy:{mode:'pre_authorized'},approvers:[],escalation:{kind:'ask_principal'},confirmation:{via:'first_party_form',personId:p.moderator,at:new Date().toISOString(),stepUp:true},validUntil:'2099-01-01T00:00:00.000Z',status:'active',revision:1,revokedAt:null});
 await a.as(p.moderator,trx=>mandates.confirm(trx,{snapshot,contexts:snapshot.contexts,digest:computeDigest(snapshot).value,expectedRevision:null,stepUp:true,proposalId:null}));
 const request={personId:p.moderator,mandateId:snapshot.id,moduleKeys:['deal_desk'],action:'send_quote' as const,context:{kind:'quote' as const,id:deal.quoteId},amount:{minorUnits:'10001',currency:'USD'},projectId:deal.projectId,at:new Date()};
 const settings={hubId:f.otherHubId,forbiddenPreAuthorization:[],isRestricted:()=>false};
 const record=async(minorUnits:string)=>a.as(p.moderator,async trx=>{
   const run=await runs.start(trx,{principal_person_id:p.moderator,kind:'conversation',mandate_id:snapshot.id});
   return recordJurisdictionIntent(trx,{request:{...request,amount:{minorUnits,currency:'USD'}},settings,runId:run.id,capabilityId:'synthetic.send_quote',effect:{provider:'synthetic',operation:'quote',payload:{synthetic:true}}});
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
 await t.test('worker composes the real attempt command; API role and stale fencing token cannot dispatch',async()=>{
   const intent=await queue();const job=(await lease()).find(j=>(j.payload as {intentId:string}).intentId===intent.intentId)!;assert.ok(job);
   await rejects(a.as(p.moderator,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token))),'42501');
   await rejects(inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(BigInt(job.fencing_token)+1n))),'55P03');
   const result=await inTransaction(worker,trx=>jurisdictionWorker.beginAttempt(trx,intent.intentId!,job.id,String(job.fencing_token)));
   assert.equal(result.status,'dispatch'); // No provider is called by this test.
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

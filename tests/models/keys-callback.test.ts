import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDigest } from '@trustwork/contracts';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { modelRoutes, providerConnections, providerKills } from '../../packages/data/src/repositories/providers.js';
import { providerKillReleaseDigestInput } from '../../packages/contracts/src/providers.js';
import { PostgresModelCallStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { type ModelGovernancePort, RuntimeModelAuthority } from '../../apps/api/src/modules/models/runtime-authority.js';
import { ModelGateway } from '../../apps/api/src/modules/models/gateway.js';
import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
import { FakeModelRegistry, type ReservedModelCall } from '../../apps/api/src/modules/models/ports.js';
import { durableWorld, syntheticGovernance } from './durable-helpers.js';
import { activateResidency, SELF_US } from '../providers/helpers.js';
import { provisionTestDatabase, SKIP_REASON, untilDatabaseTimePasses } from '../data/helpers/postgres.js';

const db=await provisionTestDatabase('keys_callback',{weight:2});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('actual KEYS owning writers serialize with original-operation fake callbacks', {skip:db?false:SKIP_REASON,timeout:120_000},async t=>{
  if(!db)return;
  const w=await durableWorld(db,{runsPerDay:100,actionsPerDay:200,concurrentRuns:100});
  t.after(async()=>{await w.pool.end();await db.close();});
  const prepare=async(governance:ModelGovernancePort=syntheticGovernance)=>{
    const call=await w.call((await w.mandate(await w.budget())).id);
    const store=new PostgresModelCallStore(w.pool,w.principal,w.binding);
    const adapter=new DeterministicModel();const registry=new FakeModelRegistry();registry.register(w.connection.id,adapter);
    const gateway=new ModelGateway(new KeysRouteResolver(w.pool),new RuntimeModelAuthority(w.pool,w.principal,w.binding,governance),store,registry);
    return {call,store,adapter,gateway};
  };
  const waitForLock=async()=>{
    for(let n=0;n<200;n++){
      if((await db.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n>0)return;
      await new Promise(r=>setTimeout(r,2));
    }
    assert.fail('expected an actual owning writer waiting on the callback fence');
  };
  const approve=async(action:string,digest:string)=>{
    const row=await w.a.cmd(w.personId,(trx,ctx)=>approvals.request(trx,ctx,{action,scope:{kind:'hub',hubId:w.hubId},actionDigest:digest}));
    await w.a.cmd(w.world.people.officer,(trx,ctx)=>approvals.decide(trx,ctx,row.id,'approve',digest));return row.id;
  };
  await t.test('raw app/worker roles cannot invoke internal callback ports or unfenced owning implementations',async()=>{
    for(const role of ['trustwork_app','trustwork_worker'])for(const command of [
      'SELECT trustwork.providers_callback_lock()',
      "SELECT trustwork.providers_model_callback_allowed('unknown',NULL)",
      "SELECT trustwork.callback_unfenced_providers_authorize_call('{}'::jsonb,true)",
    ]){
      const c=await db.admin.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(c.query(command),(e:unknown)=>(e as {code?:string}).code==='42501');
      }finally{await c.query('ROLLBACK');c.release();}
    }
  });
  for(const kind of ['egress','connection','connection revision','specific route','route kill','connection kill','residency'] as const)for(const order of ['callback first','revoker first'] as const){
    await t.test(`${kind}: ${order}`,async()=>{
      const p=await prepare();const entered=deferred(),finish=deferred();
      const original=p.adapter.invoke.bind(p.adapter);p.adapter.invoke=async input=>{entered.resolve();await finish.promise;return original(input);};
      let changedRoute:string|undefined,killId:string|undefined;
      const revoke=async()=>{
        if(kind==='egress'){await w.egress('deny');return;}
        if(kind==='connection'){await w.a.cmd(w.personId,async(trx,ctx)=>providerConnections.disable(trx,ctx,w.connection.id,(await providerConnections.get(trx,w.connection.id))!.revision));return;}
        if(kind==='connection revision'){await w.a.cmd(w.personId,async(trx,ctx)=>providerConnections.update(trx,ctx,w.connection.id,(await providerConnections.get(trx,w.connection.id))!.revision,{label:'Synthetic moved connection',capabilities:['llm'],endpoint:null,hosting:{...SELF_US,country:'CA'},storageCountry:null,region:null,credentialRefId:null}));return;}
        if(kind==='residency'){await activateResidency(w.a,w.personId,w.world.people.officer,w.hubId,['CA']);return;}
        if(kind==='specific route'){
          const route=await w.a.cmd(w.personId,(trx,ctx)=>modelRoutes.draft(trx,ctx,w.hubId,{job:'agent_drafting',scope:{kind:'module',moduleKey:'research'},
            primary:{connectionId:w.connection.id,modelId:'synthetic-model',modelRevision:'synthetic-new-revision'},fallbacks:[],allowedDataClasses:['public'],
            limits:{maxInputTokens:1000,maxOutputTokens:100,maxFileBytes:null,timeoutMs:500},budgetId:null}));
          changedRoute=route.id;await w.a.cmd(w.personId,(trx,ctx)=>modelRoutes.activate(trx,ctx,route.id,route.revision,null));return;
        }
        const kill=await w.a.cmd(w.personId,(trx,ctx)=>providerKills.engage(trx,ctx,w.hubId,kind==='route kill'
          ?{kind:'route',job:'agent_drafting',scope:{kind:'job'}}:{kind:'connection',connectionId:w.connection.id}));killId=kill.id;
      };
      const restore=async()=>{
        if(kind==='egress')await w.egress('allow');
        if(kind==='connection')await w.a.cmd(w.personId,async(trx,ctx)=>providerConnections.enable(trx,ctx,w.connection.id,(await providerConnections.get(trx,w.connection.id))!.revision,null));
        if(kind==='connection revision'){
          await w.a.cmd(w.personId,async(trx,ctx)=>providerConnections.update(trx,ctx,w.connection.id,(await providerConnections.get(trx,w.connection.id))!.revision,{label:'Synthetic restored connection',capabilities:['llm'],endpoint:null,hosting:SELF_US,storageCountry:null,region:null,credentialRefId:null}));
          const material=await w.a.cmd(w.personId,(trx,ctx)=>providerConnections.testMaterial(trx,ctx,w.connection.id));
          await w.a.cmd(w.personId,(trx,ctx)=>providerConnections.recordTest(trx,ctx,w.connection.id,{configDigest:material.config_digest,outcome:'ok',latencyMs:1,modelsListed:1,cost:null,probeDigest:'a'.repeat(64),secretRefId:null}));
          await w.a.cmd(w.personId,async(trx,ctx)=>providerConnections.enable(trx,ctx,w.connection.id,(await providerConnections.get(trx,w.connection.id))!.revision,null));
        }
        if(kind==='residency')await activateResidency(w.a,w.personId,w.world.people.officer,w.hubId,['US']);
        if(changedRoute)await w.a.cmd(w.personId,async(trx,ctx)=>modelRoutes.disable(trx,ctx,changedRoute!,(await modelRoutes.get(trx,changedRoute!))!.revision));
        if(killId){const note='Synthetic callback matrix recovery';const approval=await approve('kill_switch.release',computeDigest(providerKillReleaseDigestInput({killSwitchId:killId,incidentNote:note})).value);
          await w.a.cmd(w.personId,(trx,ctx)=>providerKills.release(trx,ctx,w.hubId,killId!,approval,note));}
      };
      let invocation:ReturnType<ModelGateway['call']>|undefined,revoker:Promise<void>|undefined;
      try{
        if(order==='callback first'){
          invocation=p.gateway.call(p.call);await Promise.race([entered.promise,invocation.then(()=>{throw new Error('callback not entered');})]);
          revoker=revoke();try{await waitForLock();}finally{finish.resolve();}
          assert.equal((await invocation).outcome,'succeeded');await revoker;assert.equal(p.adapter.calls.length,1);
        }else{
          const guarded=p.store.withDispatchAuthority.bind(p.store);
          p.store.withDispatchAuthority=async<T>(operation:ReservedModelCall,invoke:()=>Promise<T>)=>{await revoke();return guarded(operation,invoke);};
          finish.resolve();assert.equal((await p.gateway.call(p.call)).outcome,'outcome_unknown');assert.equal(p.adapter.calls.length,0);
          const row=(await db.admin.query('SELECT q.state FROM trustwork.model_call m JOIN trustwork.reservation q ON q.id=m.reservation_id WHERE m.operation_id=$1',[p.call.operationId])).rows[0];
          assert.equal(row.state,'reserved');
          // Explicit local fake no-effect receipt, fenced to the original operation; ordinary absence is still unknown.
          p.adapter.reconcile=async id=>id===p.call.operationId?{kind:'not_sent',reason:'unreachable'}:{kind:'unknown'};
          assert.equal((await p.gateway.reconcile(p.call.operationId,w.personId)).outcome,'failed');assert.equal(p.adapter.calls.length,0);
        }
      }finally{finish.resolve();await invocation;await revoker;await restore();}
    });
  }
  // Test-only owning source policy. Its mutex models the mandatory callback contract;
  // no production source/model authority is supplied by these synthetic facts.
  for(const kind of ['source permission','source version','retention','model authority'] as const)for(const order of ['callback first','revoker first'] as const){
    await t.test(`synthetic ${kind}: ${order}`,async()=>{
      let revoked=false,tail=Promise.resolve();
      const serial=async<T>(fn:()=>Promise<T>)=>{const prior=tail,done=deferred();tail=done.promise;await prior;try{return await fn();}finally{done.resolve();}};
      const governance:ModelGovernancePort={
        async check(call,candidate,binding){
          const facts=await syntheticGovernance.check(call,candidate,binding);
          if(revoked){
            if(kind==='source permission')facts.sourceAllowsModelUse=false;
            if(kind==='source version')facts.sourceBindings=[{...facts.sourceBindings![0]!,version:'synthetic-revoked'}];
            if(kind==='retention')facts.zeroRetention=false;
            if(kind==='model authority')facts.killed.model=true;
          }
          return facts;
        },
        withAuthority(call,candidate,binding,invoke){return serial(async()=>invoke(await this.check(call,candidate,binding)));},
      };
      const p=await prepare(governance),entered=deferred(),finish=deferred();
      const original=p.adapter.invoke.bind(p.adapter);p.adapter.invoke=async input=>{entered.resolve();await finish.promise;return original(input);};
      const revoke=()=>serial(async()=>{revoked=true;});
      if(order==='callback first'){
        const invocation=p.gateway.call(p.call);await Promise.race([entered.promise,invocation.then(()=>{throw new Error('callback not entered');})]);
        const revoker=revoke();await new Promise(r=>setImmediate(r));assert.equal(revoked,false);finish.resolve();
        assert.equal((await invocation).outcome,'succeeded');await revoker;assert.equal(revoked,true);assert.equal(p.adapter.calls.length,1);
      }else{
        const guarded=governance.withAuthority!.bind(governance);
        governance.withAuthority=async(call,candidate,binding,invoke)=>{await revoke();return guarded(call,candidate,binding,invoke);};
        finish.resolve();assert.equal((await p.gateway.call(p.call)).outcome,'outcome_unknown');assert.equal(p.adapter.calls.length,0);
        assert.equal((await db.admin.query('SELECT q.state FROM trustwork.model_call m JOIN trustwork.reservation q ON q.id=m.reservation_id WHERE m.operation_id=$1',[p.call.operationId])).rows[0].state,'reserved');
        // Recovery requires only the original receipt, even while source/model policy refuses fresh use.
        p.adapter.reconcile=async id=>id===p.call.operationId?{kind:'not_sent',reason:'unreachable'}:{kind:'unknown'};
        assert.equal((await p.gateway.reconcile(p.call.operationId,w.personId)).outcome,'failed');assert.equal(p.adapter.calls.length,0);
      }
    });
  }
  await t.test('real session expiry crossed during a KEYS fence wait refuses the callback and retains the hold',async()=>{
    const p=await prepare();const guarded=p.store.withDispatchAuthority.bind(p.store);
    p.store.withDispatchAuthority=async<T>(operation:ReservedModelCall,invoke:()=>Promise<T>)=>{
      const blocker=await db.admin.connect();let pending:Promise<T>|undefined;
      try{await blocker.query('BEGIN');await blocker.query('SELECT trustwork.providers_callback_lock()');
        const end=(await db.admin.query("UPDATE trustwork.session SET idle_expires_at=clock_timestamp()+interval '0.15 seconds' WHERE id=$1 RETURNING idle_expires_at",[w.binding.sessionId])).rows[0].idle_expires_at as Date;
        pending=guarded(operation,invoke);pending.catch(()=>undefined);await waitForLock();await untilDatabaseTimePasses(db.admin,end);
        await blocker.query('COMMIT');return await pending;
      }finally{await blocker.query('ROLLBACK');blocker.release();}
    };
    assert.equal((await p.gateway.call(p.call)).outcome,'outcome_unknown');assert.equal(p.adapter.calls.length,0);
    await db.admin.query("UPDATE trustwork.session SET idle_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[w.binding.sessionId]);
  });
});

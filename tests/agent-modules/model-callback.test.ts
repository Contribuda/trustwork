import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { sql } from 'kysely';
import { mandates, runs } from '../../packages/data/src/repositories/assistant.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { PostgresModelCallStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { RuntimeModelAuthority } from '../../apps/api/src/modules/models/runtime-authority.js';
import { AgentModelGovernance } from '../../apps/api/src/modules/agent-modules/model-governance.js';
import { ModelGateway } from '../../apps/api/src/modules/models/gateway.js';
import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
import { FakeModelRegistry, type ReservedModelCall } from '../../apps/api/src/modules/models/ports.js';
import { durableWorld, syntheticGovernance } from '../models/durable-helpers.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';

const db = await provisionTestDatabase('agt_model_callback');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('actual fake model callback retains AGT and owning invocation authority after committed admission', { skip: db ? false : SKIP_REASON, timeout: 300_000 }, async t => {
  if (!db) return;
  const w = await durableWorld(db,{ runsPerDay:100,actionsPerDay:100,concurrentRuns:100 });
  t.after(async()=>{ await w.pool.end(); await db.close(); });
  const routes = new KeysRouteResolver(w.pool);
  const authority = new RuntimeModelAuthority(w.pool,w.principal,w.binding,new AgentModelGovernance(w.pool,w.principal,syntheticGovernance));
  const prepare = async () => {
    const budget = await w.budget(); const mandate = await w.mandate(budget); const call = await w.call(mandate.id);
    const store = new PostgresModelCallStore(w.pool,w.principal,w.binding);
    const adapter = new DeterministicModel(); const registry = new FakeModelRegistry(); registry.register(w.connection.id,adapter);
    return { budget,mandate,call,store,adapter,registry,gateway:new ModelGateway(routes,authority,store,registry) };
  };
  for (const kind of ['serving','mandate','run','budget'] as const) for (const order of ['callback first','revoker first'] as const) {
    await t.test(`${kind}: ${order} at the actual model adapter`,async()=>{
      const p = await prepare(); const entered=deferred(); const finish=deferred();
      const original=p.adapter.invoke.bind(p.adapter);
      p.adapter.invoke=async input=>{ entered.resolve(); await finish.promise; return original(input); };
      const revoke = async()=>{
        switch(kind) {
          case 'serving': await db.admin.query('UPDATE trustwork.agent_serving_hub SET active=false WHERE hub_id=$1',[w.hubId]); break;
          case 'mandate': await w.a.as(w.personId,trx=>mandates.narrow(trx,p.mandate.id,p.mandate.revision,'revoked','Synthetic revoke')); break;
          case 'run': await w.a.as(w.personId,trx=>runs.cancel(trx,p.call.runId,'Synthetic cancellation')); break;
          case 'budget': await w.a.as(w.personId,trx=>budgets.close(trx,p.budget)); break;
        }
      };
      let invocation: ReturnType<ModelGateway['call']> | undefined; let revoker: Promise<void> | undefined;
      try {
        if(order==='callback first') {
          invocation=p.gateway.call(p.call);
          await Promise.race([entered.promise,invocation.then(()=>{throw new Error('adapter was not entered');})]);
          let ended=false; revoker=revoke().then(()=>{ended=true;});
          let waiting=false;
          for(let attempt=0;attempt<200&&!waiting;attempt++) {
            waiting=(await db.admin.query<{n:number}>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!.n>0;
            if(!waiting) await new Promise(r=>setTimeout(r,5));
          }
          assert.ok(waiting); assert.equal(ended,false);
          finish.resolve(); const result=await invocation; await revoker;
          assert.equal(result.outcome,'succeeded'); assert.equal(p.adapter.calls.length,1);
        } else {
          // Withdraw after durable admit and the gateway's final check, exactly at the callback seam.
          const guarded=p.store.withDispatchAuthority.bind(p.store);
          p.store.withDispatchAuthority=async <T>(operation:ReservedModelCall,invoke:()=>Promise<T>)=>{ await revoke(); return guarded(operation,invoke); };
          finish.resolve(); const result=await p.gateway.call(p.call);
          assert.equal(result.outcome,'outcome_unknown'); assert.equal(p.adapter.calls.length,0);
          const hold=(await db.admin.query<{state:string}>('SELECT q.state FROM trustwork.model_call m JOIN trustwork.reservation q ON q.id=m.reservation_id WHERE m.operation_id=$1',[p.call.operationId])).rows[0]!;
          assert.equal(hold.state,'reserved','ambiguous dispatch ownership never releases the original hold');
        }
      } finally { finish.resolve(); await invocation; await revoker; if(kind==='serving') await db.admin.query('UPDATE trustwork.agent_serving_hub SET active=true WHERE hub_id=$1',[w.hubId]); }
    });
  }
  await t.test('callback transaction crash preserves committed admission and accepts only the exact original receipt',async()=>{
    const p=await prepare();
    const guarded=p.store.withDispatchAuthority.bind(p.store);
    p.store.withDispatchAuthority=async <T>(operation:ReservedModelCall,invoke:()=>Promise<T>):Promise<T>=>guarded(operation,async()=>{ await invoke(); throw new Error('synthetic crash after callback'); });
    assert.equal((await p.gateway.call(p.call)).outcome,'outcome_unknown');
    assert.equal(p.adapter.calls.length,1);
    const original=p.adapter.calls[0]!;
    p.adapter.reconcile=async operationId=>operationId===original.operationId?{kind:'succeeded',text:'Synthetic receipt',costMinorUnits:'0',inputTokens:1,outputTokens:1}:{kind:'unknown'};
    await w.a.as(w.personId,trx=>mandates.narrow(trx,p.mandate.id,p.mandate.revision,'revoked','Synthetic revoke'));
    assert.equal((await p.gateway.reconcile(p.call.operationId,w.personId)).outcome,'succeeded');
    assert.equal(p.adapter.calls.length,1,'receipt recovery cannot invoke again');
  });
  await t.test('session revocation waits for a current callback and refuses the next original admitted operation',async()=>{
    const a=await prepare(); const b=await prepare();
    const route=await routes.resolve(b.call); const begun=await b.store.begin(b.call,route,route.candidates[0]!);
    assert.equal(begun.kind,'dispatch'); if(begun.kind!=='dispatch') throw new Error('expected prepared operation');
    assert.equal(await b.store.admit(begun.call),true);
    const entered=deferred(); const finish=deferred(); const original=a.adapter.invoke.bind(a.adapter);
    a.adapter.invoke=async input=>{ entered.resolve(); await finish.promise; return original(input); };
    const invocation=a.gateway.call(a.call);
    await Promise.race([entered.promise,invocation.then(()=>{throw new Error('adapter was not entered');})]);
    let ended=false;
    const revoker=withMaintenance(db.admin,trx=>sql`UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=${w.binding.sessionId}::uuid`.execute(trx)).then(()=>{ended=true;});
    try { await new Promise(r=>setTimeout(r,50)); assert.equal(ended,false); } finally { finish.resolve(); }
    await invocation; await revoker; assert.equal(a.adapter.calls.length,1);
    let called=false;
    await assert.rejects(b.store.withDispatchAuthority(begun.call,async()=>{called=true;}));
    assert.equal(called,false);
    assert.equal((await db.admin.query<{allowed:boolean}>("SELECT has_function_privilege('trustwork_worker','trustwork.agent_modules_enter_model_effect(text,uuid)','EXECUTE') AS allowed")).rows[0]!.allowed,false);
  });
});

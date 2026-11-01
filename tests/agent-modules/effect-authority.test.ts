import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jobs, withMaintenance } from '@trustwork/data';
import { sql } from 'kysely';
import { inTransaction, silentLogger } from '@trustwork/worker';
import { assistantWorker } from '../../packages/data/src/repositories/assistant.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { defineEffectImplementation, dispatchHandler, FakeEffectProvider, type AssistantRuntime } from '../../apps/worker/src/assistant/index.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, assistantService, draft, ok, personalBudget, stateOf, usd, workerLogin, type MandateView } from '../assistant/helpers.js';
import { installSyntheticHandler, installSyntheticOrderManifest, syntheticEffectDeclaration } from '../assistant/manifest-fixture.js';
import { activatePolicy, buildAgentWorld, engage, engageNode, release } from './helpers.js';

import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import { installSyntheticMcpConnection } from './mcp-token-fixture.js';
import { REGISTRY, PLANNER_COMMIT } from './fixtures.js';

const h = await startHarness('agt_effect_authority');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('code-owned effect callback, current revokers and exact original-operation recovery', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async t => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => { await worker.close(); await h.close(); });
  const world = await buildAgentWorld(h);
  await installSyntheticOrderManifest(h);
  h.clock.reset();
  const seed = await seedPersonas(h);
  const pool = worker.pool(8);
  const declaration = syntheticEffectDeclaration('deal_desk.place_order', 'fake_orders', 'order.place');
  const prepare = async (capabilityId = 'deal_desk.place_order', actor: 'petr' | 'boris' = 'petr', existingProject?: { id: string }, ask = false) => {
    const personId = seed.people[actor];
    const actionVerb = capabilityId === PLANNER_COMMIT ? 'publish' : 'place_order';
    const client = h.client();
    await login(client, actor);
    const project = existingProject ?? ok<{ id: string }>(await client.post('/v1/projects', { owner: { kind: 'person', id: personId }, name: 'Synthetic effect authority', summary: null, leaderPersonId: null }), 201);
    const state = await stateOf(h, client, randomUUID());
    const budget = await personalBudget(h, personId, 'transaction', '1000');
    const mandate = ok<MandateView>(await client.post('/v1/assistant/mandates', { draft: draft({ moduleKeys: [capabilityId.split('.')[0]!], actions: [actionVerb],
      contexts: [{ kind: 'project', id: project.id }], approvalPolicy: { mode: ask ? 'ask_each' : 'pre_authorized' }, limits: { ceiling: usd('1000'), perActionCeiling: null, transactionBudgetId: budget, platformBudgetId: null, perWindow: null } }) }), 201);
    const { service, model } = assistantService(h);
    model.push({ text: 'Synthetic local action', messageKey: null, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ kind: 'propose_action', mandateId: mandate.id,
      capabilityId, moduleKey: capabilityId.split('.')[0]!, action: actionVerb, context: { kind: 'project', id: project.id }, amount: usd('10'), projectId: null,
      effect: { provider: 'fake_orders', operation: 'order.place', payload: { item: 'synthetic' } } }] });
    const turn = await service.converse({ text: 'Synthetic request' }, state);
    const action = turn.actions[0]!;
    assert.equal(action.state, ask ? 'proposed' : 'queued', JSON.stringify(action));
    const intentId = (action as { intentId: string }).intentId;
    if (ask) {
      const decision=ok<{ decisions:{ id:string;actionDigest:unknown }[] }>(await client.get('/v1/assistant/decisions')).decisions.find(d=>d.id===intentId)!;
      assert.ok(decision);
      const approved=ok<{state:string}>(await client.post(`/v1/assistant/decisions/${intentId}/approve`,{digest:decision.actionDigest}));
      assert.equal(approved.state,'queued');
    }
    const leased = await inTransaction(pool, trx => jobs.lease(trx, ['assistant.dispatch'], randomUUID(), 120, 100));
    const job = leased.find(j => (j.payload as { intentId?: string }).intentId === intentId)!;
    assert.ok(job);
    const context = { job, payload: { intentId }, attemptId: randomUUID(), effectKey: `job:${job.id}`, signal: new AbortController().signal };
    const read = async () => (await h.db.admin.query<{ state: string; hold: string; attempt_count: number; effect_correlation_key: string }>(
      'SELECT i.state,q.state AS hold,i.attempt_count,i.effect_correlation_key FROM trustwork.action_intent i LEFT JOIN trustwork.reservation q ON q.id=i.reservation_id WHERE i.id=$1', [intentId])).rows[0]!;
    return { client, state, budget, mandate, project, runId: turn.run.id, intentId, job, context, read };
  };
  const runtime = (provider: FakeEffectProvider, implementation = defineEffectImplementation(declaration, provider, input => structuredClone(input))): AssistantRuntime =>
    ({ pool, providers: [provider], implementations: [implementation], hubId: null, log: silentLogger });

  await t.test('equal provider and operation names cannot replace a different code declaration', async () => {
    const p = await prepare();
    const provider = new FakeEffectProvider('fake_orders');
    const replacement = defineEffectImplementation({ ...declaration, payloadContract: 'different-contract@2' }, provider, input => input);
    await dispatchHandler(runtime(provider, replacement)).run(p.context);
    assert.equal(provider.submissions.length, 0);
    assert.equal((await p.read()).state, 'failed');
    assert.equal((await p.read()).hold, 'released', 'definitive refusal happened before any effect');
  });
  await t.test('code-owned payload refusal happens before the callback and preserves private constraints', async () => {
    const p = await prepare();
    const provider = new FakeEffectProvider('fake_orders');
    const implementation = defineEffectImplementation(declaration, provider, () => { throw new Error('synthetic invalid payload'); });
    await dispatchHandler(runtime(provider, implementation)).run(p.context);
    assert.equal(provider.submissions.length, 0);
    assert.equal((await p.read()).state, 'failed');
  });
  const cases = ['serving', 'kill switch', 'session', 'mandate', 'run', 'resource authority', 'budget'] as const;
  for (const kind of cases) for (const order of ['dispatch first', 'revoker first'] as const) {
    await t.test(`${kind}: ${order} at the actual handler callback`, async () => {
      const p = await prepare();
      const provider = new FakeEffectProvider('fake_orders');
      const entered = deferred(); const finish = deferred();
      const originalSubmit = provider.submit.bind(provider);
      provider.submit = async (request, signal) => { entered.resolve(); await finish.promise; return originalSubmit(request, signal); };
      const handler = dispatchHandler(runtime(provider));
      let switchId: string | undefined;
      const revoke = async () => {
        switch (kind) {
          case 'serving': await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=false WHERE hub_id=${world.hubId}::uuid`.execute(trx)); break;
          case 'kill switch': switchId = await engage(world, 'agent_module', { moduleKey: 'deal_desk' }); break;
          case 'session': await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.session SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE id=${p.state.session!.id}::uuid`.execute(trx)); break;
          case 'mandate': ok(await p.client.post(`/v1/assistant/mandates/${p.mandate.id}/revoke`, { expectedRevision: p.mandate.revision, reason: 'Synthetic revoke' })); break;
          case 'run': ok(await p.client.post(`/v1/assistant/runs/${p.runId}/cancel`, { reason: 'Synthetic cancellation' })); break;
          // Real participation mutation runs the owning epoch trigger; no session identity is fabricated.
          case 'resource authority': await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.object_participation SET revoked_at=clock_timestamp(),revoked_reason='Synthetic withdrawal' WHERE resource_kind='project' AND resource_id=${p.project.id}::uuid AND party_person_id=${seed.people.petr}::uuid`.execute(trx)); break;
          case 'budget': await as(h, seed.people.petr, trx => budgets.close(trx, p.budget)); break;
        }
      };
      let dispatch: Promise<void> | undefined; let revoker: Promise<void> | undefined;
      try {
        if (order === 'dispatch first') {
          dispatch = handler.run(p.context);
          await Promise.race([entered.promise, dispatch.then(() => { throw new Error('callback was not reached'); })]);
          let ended = false;
          revoker = revoke().then(() => { ended = true; });
          // Observe a real PostgreSQL lock waiter, not merely an unresolved JS promise.
          let blocked = false;
          for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
            blocked = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!.n > 0;
            if (!blocked) await new Promise(r => setTimeout(r, 5));
          }
          assert.ok(blocked, 'current revoker waits for the admitted code-owned callback');
          assert.equal(ended, false);
          finish.resolve(); await dispatch; await revoker;
          assert.equal(provider.submissions.length, 1);
          assert.equal((await p.read()).state, 'succeeded');
        } else {
          await revoke(); finish.resolve(); await handler.run(p.context);
          assert.equal(provider.submissions.length, 0);
          assert.equal((await p.read()).state, 'revoked');
          assert.equal((await p.read()).attempt_count, 0);
        }
      } finally {
        finish.resolve(); await dispatch; await revoker;
        if (switchId) await release(world, switchId);
        if (kind === 'serving') await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=true WHERE hub_id=${world.hubId}::uuid`.execute(trx));
      }
    });
  }
  await t.test('withdrawal after committed admission prevents callback, keeps the original hold and pins receipt-only recovery', async () => {
    const p = await prepare();
    const target = await inTransaction(pool, trx => assistantWorker.beginAttempt(trx, p.intentId, p.job.id, null, p.job.fencing_token));
    assert.equal(target.status, 'dispatch');
    if (target.status !== 'dispatch') throw new Error('expected attempt');
    await assert.rejects(h.pool.query('SELECT trustwork.agent_modules_enter_effect($1,$2,$3)', [target.attemptId,p.job.id,p.job.fencing_token]), (e: unknown) => (e as { code?: string }).code === '42501');
    const stop = await engage(world, 'agent_module', { moduleKey: 'deal_desk' });
    assert.equal(await inTransaction(pool, trx => assistantWorker.enterEffect(trx, target.attemptId,p.job.id,p.job.fencing_token)), false);
    assert.equal((await p.read()).hold, 'reserved');
    const original = await inTransaction(pool, trx => assistantWorker.beginReconciliation(trx,p.intentId));
    assert.equal(original.status, 'reconcile');
    if (original.status !== 'reconcile') throw new Error('expected recovery');
    assert.deepEqual(original.implementation, target.implementation);
    assert.equal(original.correlationKey, target.correlationKey);
    assert.equal((await p.read()).attempt_count, 1);
    assert.equal((await p.read()).hold, 'reserved');
    await inTransaction(pool, trx => assistantWorker.recordReconciliation(trx,p.intentId,`synthetic-original:${target.correlationKey}`,{ kind: 'final', result: 'failed', providerReference: null, evidence: 'Original local fake callback was never entered; exact correlation key absent' }));
    assert.equal((await p.read()).hold, 'released');
    await release(world, stop);
  });

  for(const order of ['callback first','revoker first'] as const) await t.test(`original human approval withdrawal: ${order}`,async()=>{
    const p=await prepare('deal_desk.place_order','petr',undefined,true);
    const provider=new FakeEffectProvider('fake_orders');const entered=deferred();const finish=deferred();
    const submit=provider.submit.bind(provider);provider.submit=async(request,signal)=>{entered.resolve();await finish.promise;return submit(request,signal);};
    const handler=dispatchHandler(runtime(provider));
    const revoke=()=>withMaintenance(h.db.admin,trx=>sql`UPDATE trustwork.approval SET revoked_at=clock_timestamp() WHERE action_intent_id=${p.intentId}::uuid`.execute(trx));
    if(order==='callback first') {
      const invocation=handler.run(p.context);
      await Promise.race([entered.promise,invocation.then(()=>{throw new Error('callback not reached');})]);
      let ended=false;const revoker=revoke().then(()=>{ended=true;});
      try{await new Promise(r=>setTimeout(r,50));assert.equal(ended,false);}finally{finish.resolve();}
      await invocation;await revoker;assert.equal(provider.submissions.length,1);
    } else {await revoke();finish.resolve();await handler.run(p.context);assert.equal(provider.submissions.length,0);assert.equal((await p.read()).state,'revoked');}
  });
  await t.test('a connection-call family cannot substitute for original token authority in a deferred effect',async()=>{
    const p=await prepare();const mcp=await installSyntheticMcpConnection(h,seed.people.petr,world.hubId);
    await withMaintenance(h.db.admin,async trx=>{
      const token=await trx.selectFrom('connection_token').select('family_id').where('token_hash','=',mcp.token.accessTokenHash).executeTakeFirstOrThrow();
      await trx.insertInto('connection_call').values({connection_id:mcp.connection.id,token_family_id:token.family_id,capability_id:'deal_desk.place_order',args_digest:`sha256:${'0'.repeat(64)}`,result_code:'synthetic.queued',mandate_ref:null,action_intent_id:p.intentId}).execute();
    });
    const provider=new FakeEffectProvider('fake_orders');await dispatchHandler(runtime(provider)).run(p.context);
    assert.equal(provider.submissions.length,0);assert.equal((await p.read()).state,'revoked');
    assert.equal((await h.db.admin.query<{state_reason:string}>('SELECT state_reason FROM trustwork.action_intent WHERE id=$1',[p.intentId])).rows[0]!.state_reason,'recheck: connection_dispatch_authority_unavailable');
  });
  await installSyntheticHandler(h,PLANNER_COMMIT,'fake_orders','order.place');
  const plannerDeclaration=syntheticEffectDeclaration(PLANNER_COMMIT,'fake_orders','order.place');
  const base=()=>engineDefaultPolicy(world.hubId,REGISTRY);
  await activatePolicy(h,world,base());
  for(const kind of ['module policy','capability policy','participant policy','plan policy','hub kill','capability kill','action kill','personal stop','company role'] as const) {
    for(const order of ['callback first','revoker first'] as const) await t.test(`${kind}: ${order} for a shipped capability`,async()=>{
      const p=await prepare(PLANNER_COMMIT,kind==='company role'?'boris':'petr');
      const provider=new FakeEffectProvider('fake_orders'); const entered=deferred(); const finish=deferred();
      const submit=provider.submit.bind(provider); provider.submit=async(request,signal)=>{entered.resolve();await finish.promise;return submit(request,signal);};
      const handler=dispatchHandler(runtime(provider,defineEffectImplementation(plannerDeclaration,provider,input=>structuredClone(input))));
      let switchId: string|undefined;
      const revoke=async()=>{
        if(kind==='personal stop') { ok(await p.client.post('/v1/assistant/stop')); return; }
        if(kind==='company role') { await withMaintenance(h.db.admin,trx=>sql`UPDATE trustwork.membership SET permissions=ARRAY['company.members.manage']::text[] WHERE id=${seed.memberships.boris}::uuid`.execute(trx)); return; }
        if(kind==='hub kill') { switchId=await engage(world,'hub_agent_dispatch'); return; }
        if(kind==='capability kill') { switchId=await engage(world,'agent_capability',{capabilityId:PLANNER_COMMIT}); return; }
        if(kind==='action kill') { switchId=await engage(world,'agent_action',{action:'publish'}); return; }
        const policy=base();
        if(kind==='module policy') policy.policy.enabledModules=policy.policy.enabledModules.filter(m=>m.moduleKey!=='project_planner');
        else policy.capabilities=[{capabilityId:PLANNER_COMMIT,offForHub:kind==='capability policy',offForPrincipalKinds:kind==='participant policy'?['person']:[],offForPlans:kind==='plan policy'?['free']:[]}];
        await activatePolicy(h,world,policy);
      };
      let invocation: Promise<void>|undefined; let revoker: Promise<void>|undefined;
      try {
        if(order==='callback first') {
          invocation=handler.run(p.context);
          await Promise.race([entered.promise,invocation.then(()=>{throw new Error('callback not reached');})]);
          let ended=false; revoker=revoke().then(()=>{ended=true;});
          let waiting=false;
          for(let attempt=0;attempt<300&&!waiting;attempt++) {
            waiting=(await h.db.admin.query<{n:number}>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!.n>0;
            if(!waiting) await new Promise(r=>setTimeout(r,5));
          }
          assert.ok(waiting);assert.equal(ended,false);
          finish.resolve();await invocation;await revoker;
          assert.equal(provider.submissions.length,1);assert.equal((await p.read()).state,'succeeded');
        } else {
          await revoke();finish.resolve();await handler.run(p.context);
          assert.equal(provider.submissions.length,0);assert.equal((await p.read()).state,'revoked');
        }
      } finally {
        finish.resolve();await invocation;await revoker;
        if(switchId) await release(world,switchId);
        if(kind==='personal stop') ok(await p.client.post('/v1/assistant/stop/release'));
        if(kind==='company role') await withMaintenance(h.db.admin,trx=>sql`UPDATE trustwork.membership SET permissions=ARRAY['company.deals.manage','company.members.manage']::text[] WHERE id=${seed.memberships.boris}::uuid`.execute(trx));
        if(kind.endsWith('policy')) await activatePolicy(h,world,base());
      }
    });
  }

  await t.test('actual AST admission rolls back denied quota measures and retains unknown capacity after cancellation',async()=>{
    const counts=async()=> (await h.db.admin.query<{runs:number;actions:number}>("SELECT count(*) FILTER(WHERE measure='run')::int AS runs,count(*) FILTER(WHERE measure='action')::int AS actions FROM trustwork.agent_runtime_usage WHERE principal_person_id=$1 AND module_key='project_planner'",[seed.people.petr])).rows[0]!;
    const before=await counts();const policy=base();const control=policy.modules.find(m=>m.moduleKey==='project_planner')!;
    control.limits.concurrentRuns=1;control.limits.actionsPerDay=before.actions+1;
    await activatePolicy(h,world,policy);
    const a=await prepare(PLANNER_COMMIT);const b=await prepare(PLANNER_COMMIT,'petr',a.project);
    const target=await inTransaction(pool,trx=>assistantWorker.beginAttempt(trx,a.intentId,a.job.id,null,a.job.fencing_token));
    assert.equal(target.status,'dispatch');if(target.status!=='dispatch')throw new Error('expected admitted attempt');
    assert.deepEqual(await inTransaction(pool,trx=>assistantWorker.beginAttempt(trx,b.intentId,b.job.id,null,b.job.fencing_token)),{status:'refused',reason:'quota_concurrent'});
    await inTransaction(pool,trx=>assistantWorker.recordOutcome(trx,target.attemptId,{kind:'unknown',reason:'ambiguous_response'}));
    ok(await a.client.post(`/v1/assistant/runs/${a.runId}/cancel`,{reason:'Synthetic cancellation'}));
    const c=await prepare(PLANNER_COMMIT,'petr',a.project);
    assert.deepEqual(await inTransaction(pool,trx=>assistantWorker.beginAttempt(trx,c.intentId,c.job.id,null,c.job.fencing_token)),{status:'refused',reason:'quota_concurrent'});
    assert.deepEqual(await counts(),{runs:before.runs+1,actions:before.actions+1});
    await inTransaction(pool,async trx=>{await assistantWorker.beginReconciliation(trx,a.intentId);await assistantWorker.recordReconciliation(trx,a.intentId,`synthetic:${target.correlationKey}`,{kind:'final',result:'failed',providerReference:null,evidence:'Exact original local fake key has no submitted effect'});});
    const d=await prepare(PLANNER_COMMIT,'petr',a.project);
    assert.deepEqual(await inTransaction(pool,trx=>assistantWorker.beginAttempt(trx,d.intentId,d.job.id,null,d.job.fencing_token)),{status:'refused',reason:'quota_action_daily'});
    assert.deepEqual(await counts(),{runs:before.runs+1,actions:before.actions+1},'daily action denial rolled back run admission too');
    await activatePolicy(h,world,base());
  });
  await t.test('node withdrawal waits for a callback and then prevents the other queued original intent',async()=>{
    const a=await prepare(PLANNER_COMMIT);const b=await prepare(PLANNER_COMMIT,'petr',a.project);
    const provider=new FakeEffectProvider('fake_orders');const entered=deferred();const finish=deferred();
    const submit=provider.submit.bind(provider);provider.submit=async(request,signal)=>{entered.resolve();await finish.promise;return submit(request,signal);};
    const handler=dispatchHandler(runtime(provider,defineEffectImplementation(plannerDeclaration,provider,input=>structuredClone(input))));
    const invocation=handler.run(a.context);
    await Promise.race([entered.promise,invocation.then(()=>{throw new Error('callback not reached');})]);
    let ended=false;const stop=engageNode(h,world).then(()=>{ended=true;});
    try {await new Promise(r=>setTimeout(r,50));assert.equal(ended,false);} finally {finish.resolve();}
    await invocation;await stop;await handler.run(b.context);
    assert.equal(provider.submissions.length,1);assert.equal((await b.read()).state,'revoked');
  });

});

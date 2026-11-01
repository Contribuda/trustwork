import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { budgets, reservations } from '../../packages/data/src/repositories/billing.js';
import { actor, buildWorld, days } from '../billing/helpers.js';
import { computeDigest } from '@trustwork/contracts';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { egressRules, modelRoutes, providerConnections } from '../../packages/data/src/repositories/providers.js';
import { egressAllowDigestInput } from '../../packages/contracts/src/providers.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { ModelGateway } from '../../apps/api/src/modules/models/gateway.js';
import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
import { FakeModelRegistry, ModelRefusal } from '../../apps/api/src/modules/models/ports.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { durableWorld, syntheticGovernance } from './durable-helpers.js';
import { PostgresModelCallStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { RuntimeModelAuthority } from '../../apps/api/src/modules/models/runtime-authority.js';

const db = await provisionTestDatabase('models_keys');
test('gateway route resolution against real KEYS-001 PostgreSQL; synthetic source policy and original-operation store', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  const w = await durableWorld(db);
  const runtime=w.pool, world=w.world, a=w.a, hubA=w.hubId;
  const {owner,officer}=world.people;
  const primary=w.connection, secondary=w.secondary;
  t.after(async()=>{await runtime.end();await db.close();});
  const ref = (id: string, revision = 'synthetic-revision-1') => ({ connectionId: id, modelId: 'synthetic-model', modelRevision: revision });
  const draft = async (revision = 'synthetic-revision-1') => a.cmd(owner, (trx, ctx) => modelRoutes.draft(trx, ctx, hubA, {
    job: 'agent_drafting', scope: { kind: 'job' }, primary: ref(primary.id, revision), fallbacks: [ref(secondary.id)],
    allowedDataClasses: ['public', 'person_private'], limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxFileBytes: null, timeoutMs: 100 }, budgetId: null,
  }));
  const activate = async (r: Awaited<ReturnType<typeof draft>>) => {
    const { rows } = await db.admin.query<{ d: string }>('SELECT trustwork.providers_route_digest($1) AS d', [r.id]);
    const approval = await a.cmd(officer, (trx, ctx) => approvals.request(trx, ctx, { action: 'models.activate_private_route', scope: { kind: 'hub', hubId: hubA }, actionDigest: rows[0]!.d }));
    await a.cmd(owner, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', rows[0]!.d));
    return a.cmd(officer, (trx, ctx) => modelRoutes.activate(trx, ctx, r.id, r.revision, approval.id));
  };
  const allow = async (id: string, dataClass: 'public' | 'person_private') => {
    const privateClass = dataClass !== 'public';
    let approvalId: string | null = null;
    if (privateClass) {
      const version = await a.as(owner, (trx) => egressRules.nextVersion(trx, id, dataClass));
      const digest = computeDigest(egressAllowDigestInput({ hubId: hubA, connectionId: id, dataClass, requireInResidency: true, requireZeroRetention: true, version })).value;
      const approval = await a.cmd(owner, (trx, ctx) => approvals.request(trx, ctx, { action: 'egress.allow_private_class', scope: { kind: 'hub', hubId: hubA }, actionDigest: digest }));
      await a.cmd(officer, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', digest));
      approvalId = approval.id;
    }
    return a.cmd(owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: id, dataClass, decision: 'allow', requireInResidency: privateClass, requireZeroRetention: privateClass, approvalId }));
  };
  await activate(await draft());
  const routes = new KeysRouteResolver(runtime);
  const registry = new FakeModelRegistry();
  const primaryAdapter = new DeterministicModel();
  const fallbackAdapter = new DeterministicModel();
  registry.register(primary.id, primaryAdapter); registry.register(secondary.id, fallbackAdapter);
  const authority = new RuntimeModelAuthority(runtime,w.principal,w.binding,syntheticGovernance);
  const freshInput=async()=>({...await w.call((await w.mandate(await w.budget())).id),dataClasses:['person_private'] as const});
  const input={...await freshInput(),dataClasses:['person_private'] as ('person_private')[]};
  const make = (store = new PostgresModelCallStore(runtime,w.principal,w.binding)) => new ModelGateway(routes,authority,store,registry);

  await t.test('private data without an allow cell is refused before any adapter', async () => {
    await assert.rejects(make().call(input), (e: unknown) => e instanceof ModelRefusal && e.reason === 'egress_denied');
    assert.equal(primaryAdapter.calls.length + fallbackAdapter.calls.length, 0);
  });
  await allow(primary.id, 'person_private');
  await t.test('allowed private primary is pinned; denied fallback is excluded by the real gate', async () => {
    const resolved = await routes.resolve(input);
    assert.equal(resolved.candidates.length, 1);
    const result = await make().call(input);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(primaryAdapter.calls[0]!.modelRevision, 'synthetic-revision-1');
    assert.equal(fallbackAdapter.calls.length, 0);
  });
  await allow(secondary.id, 'person_private');
  await t.test('a fallback revoked after resolution receives no private input', async () => {
    let revocation:Promise<unknown>|undefined;
    primaryAdapter.invoke = async () => {
      // The owning writer waits for this held callback; do not await a revoker from inside its lock.
      revocation=a.cmd(owner,(trx,ctx)=>egressRules.set(trx,ctx,{connectionId:secondary.id,dataClass:'person_private',decision:'deny',requireInResidency:true,requireZeroRetention:true,approvalId:null}));
      return {kind:'not_sent',reason:'unreachable'};
    };
    const check=authority.check.bind(authority);
    authority.check=async(call,candidate,purpose)=>{
      if(candidate.connectionId===secondary.id)await revocation;
      return check(call,candidate,purpose);
    };
    const next=await freshInput();
    try { assert.equal((await make().call({...next,dataClasses:['person_private']})).outcome,'refused'); }
    finally { await revocation; authority.check=check; }
    assert.equal(fallbackAdapter.calls.length, 0);
  });
  await t.test('a different active route never silently substitutes a newer provider revision', async () => {
    const oldRoute = await routes.resolve(input);
    await activate(await draft('synthetic-revision-2'));
    await assert.rejects(routes.recheck(input, oldRoute, oldRoute.candidates[0]!), (e: unknown) => e instanceof ModelRefusal && e.reason === 'route_changed');
  });
  await t.test('current resolver refuses a canary rather than fabricate MODEL-001 activation', async () => {
    const current = await routes.resolve(input);
    await assert.rejects(routes.recheck(input, { ...current, stage: 'canary' }, current.candidates[0]!), ModelRefusal);
  });
  await t.test('restricted provider configuration is refused by the real owning service', async () => {
    await assert.rejects(a.cmd(owner, (trx, ctx) => providerConnections.create(trx, ctx, hubA, {
      adapterId: 'fake', mode: 'fake', label: 'Synthetic restricted model', capabilities: ['llm'], endpoint: null,
      hosting: { kind: 'self_hosted', country: 'RU' }, storageCountry: null, region: null, credentialRefId: null,
    })), (e: unknown) => (e as { hint?: string }).hint === 'providers.restricted_place');
  });
  await t.test('ordinary unheld BILL-001 reservations retain their finite-TTL behavior', async () => {
    const billing = await buildWorld(db.admin);
    const b = actor(db.admin, runtime);
    const principal = billing.people.solo;
    const budgetId = await b.as(principal, (trx) => budgets.grant(trx, {
      kind: 'platform', owner: 'person', projectId: null, employeePersonId: null,
      periodFrom: days(-1), periodTo: days(1), limitMinor: '10', currency: 'USD',
    }));
    const reserve = (key: string, ttlSeconds: number) => b.as(principal, (trx) => reservations.reserve(trx, {
      budgetId, kind: 'platform', amountMinor: '7', currency: 'USD', actionIntentId: randomUUID(), correlationKey: key, projectId: null, ttlSeconds,
    }));
    const first = await reserve('synthetic-finite-reservation', 1);
    assert.equal((await b.as(principal, (trx) => budgets.balance(trx, budgetId)))!.heldMinor, '7');
    // Local database clock only. Durable effect holds have separate coverage in durable.test.ts.
    await db.admin.query('SELECT pg_sleep(1.1)');
    const second = await reserve('synthetic-after-expiry', 60);
    assert.notEqual(first.id, second.id);
    assert.equal((await b.as(principal, (trx) => budgets.balance(trx, budgetId)))!.heldMinor, '7');
    assert.equal((await b.as(principal, (trx) => reservations.get(trx, first.id)))!.state, 'reserved');
    await b.owner((trx) => reservations.expireDue(trx));
    assert.equal((await b.as(principal, (trx) => reservations.get(trx, first.id)))!.state, 'expired');
  });

});

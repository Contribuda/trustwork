import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { EnvelopesService } from '../../apps/api/src/modules/assistant-goals/envelopes.service.js';
import { RepresentativeService } from '../../apps/api/src/modules/assistant-goals/representative.service.js';
import { NEGOTIATION_SERVICE_BINDINGS } from '../../apps/api/src/modules/agent-modules/negotiation-bindings.js';
import { REPRESENTATIVE_SERVICE_BINDINGS } from '../../apps/api/src/modules/agent-modules/representative-bindings.js';
import { CapabilityAuthority, agentRuntimeGate, mcpGate, type AuthorityDecision, type McpDecision } from '../../apps/api/src/modules/agent-modules/authority.js';
import { SendEnvelopeCommandSchema, GrantCompanyMandateCommandSchema, AGENT_CAPABILITIES } from '../../packages/contracts/src/agents.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { as, stateOf } from '../assistant/helpers.js';
import { buildWorld, envelope, terms } from '../assistant-goals/helpers.js';
import { activatePolicy, buildAgentWorld, engage, release, ok } from './helpers.js';
import { REGISTRY, negotiationPolicy } from './fixtures.js';
import { installSyntheticMcpConnection } from './mcp-token-fixture.js';

const h = await startHarness('agent_negotiation_parity');
test('all existing negotiation and representative methods keep current owning authority and shared adapter refusals', { skip: h ? false : SKIP_REASON, timeout: 120_000 }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const world = await buildAgentWorld(h);
  const w = await buildWorld(h);
  const company = w.seed.companies.supplier;
  const boris = w.clients.boris;
  const personId = w.seed.people.boris;
  const state = await stateOf(h, boris, 'negotiation-parity');
  const service = h.created.app.get(EnvelopesService);
  const representatives = h.created.app.get(RepresentativeService);
  const authority = new CapabilityAuthority({ hubId: world.hubId });
  const mcp = await installSyntheticMcpConnection(h, personId, world.hubId);
  const capability = (id: string) => AGENT_CAPABILITIES.find(c => c.capability.id === id)!.capability;
  ok(await boris.post(`/v1/companies/${company}/representative`, { accountablePersonId: personId, expectedRevision: null }));
  const cm = ok<{ id: string; mandateId: string; revision: number }>(await boris.post(`/v1/companies/${company}/agent-mandates`, { executor: { kind: 'company_representative' }, terms: terms(w.rfq.rfq.id, ['communicate', 'negotiate', 'schedule', 'introduce']) }), 201);
  const body = SendEnvelopeCommandSchema.parse(envelope({ actingAs: { kind: 'company_representative', companyMandateId: cm.id }, to: w.petrParty, context: { kind: 'rfq', id: w.rfq.rfq.id }, intent: 'clarify' }));
  const actor = { personId, onBehalfCompanyId: company, representativeOf: company, connectionId: null };
  const raw = (hubId: string | null = world.hubId) => as(h, personId, trx => sql`SELECT * FROM trustwork.agents_deliver_envelope(${JSON.stringify(body.actingAs)}::jsonb,
    ${JSON.stringify({ ...body, context: body.context, proof: {}, homeNode: 'synthetic-local' })}::jsonb,${JSON.stringify({ hubId, moduleKeys: ['negotiation'] })}::jsonb)`.execute(trx));

  await t.test('complete method inventory and explicit default unavailability; non-purchasable first-party controls still work', async () => {
    assert.equal(Object.keys(NEGOTIATION_SERVICE_BINDINGS).length, 4);
    assert.equal(Object.keys(REPRESENTATIVE_SERVICE_BINDINGS).length, 11);
    await assert.rejects(service.send(body, state), (e: unknown) => (e as { details?: { reason?: string } }).details?.reason === 'module.not_enabled');
    assert.equal((await boris.get('/v1/assistant/envelopes')).status, 403);
    const sqlDefault = await h.db.admin.query<{ refusal: string }>("SELECT trustwork.agent_modules_policy_refusal($1::uuid,'negotiation.message','company_representative',true,'free') AS refusal", [world.hubId]);
    await assert.rejects(as(h, personId, trx => sql<{ refusal: string }>`SELECT trustwork.agent_modules_policy_refusal(${world.hubId}::uuid,'negotiation.message','company_representative',true,'free') AS refusal`.execute(trx)));
    assert.equal(sqlDefault.rows[0]?.refusal, 'module.not_enabled');
    await assert.rejects(raw());
    const firstParty = await representatives.view(company, state);
    assert.ok(firstParty.representative);
    assert.ok(firstParty.companyMandates.length > 0);
    await representatives.myCompanyMandates(state);
    await representatives.listCompanyMandates(company, state);
  });
  await activatePolicy(h, world, negotiationPolicy(world.hubId));
  let sessionId: string;
  await t.test('actual local delivery, session and envelope projections retain owning private boundaries', async () => {
    const result = ok<{ status: string; session: { id: string } }>(await boris.post('/v1/assistant/envelopes', { ...body, intent: 'propose', refs: [w.supplierQuote] }));
    assert.equal(result.status, 'delivered'); sessionId = result.session.id;
    for (const intent of ['clarify', 'schedule_meeting', 'introduce'] as const) assert.equal((await service.send({ ...body, intent }, state)).status, 'delivered');
    await service.listEnvelopes(state); await service.listNegotiations(state); await service.getNegotiation(sessionId, state);
    const inbox = await w.clients.petr.get('/v1/assistant/envelopes');
    assert.equal(inbox.status, 200);
    assert.doesNotMatch(JSON.stringify(inbox.body), /PRIVATE-|termsDigest|mandateId|costBasis|budgetCeiling/);
    assert.equal((await w.clients.anna.get(`/v1/assistant/negotiations/${sessionId}`)).status, 404);
  });
  for (const mode of ['module', 'capability', 'participant', 'plan'] as const) await t.test(`${mode} disable intersects actual service operations, agent and stored-token adapter`, async () => {
    const policy = negotiationPolicy(world.hubId);
    const ids = ['negotiation.list_envelopes', 'negotiation.list_sessions', 'negotiation.get_session', 'negotiation.message', 'negotiation.negotiate', 'negotiation.schedule', 'negotiation.introduce'];
    if (mode === 'module') {
      policy.policy.enabledModules = policy.policy.enabledModules.filter(m => m.moduleKey !== 'negotiation');
      policy.modules = policy.modules.filter(m => m.moduleKey !== 'negotiation');
    } else policy.capabilities = ids.map(capabilityId => ({ capabilityId, offForHub: mode === 'capability', offForPrincipalKinds: mode === 'participant' ? ['company_member', 'company_representative', 'person'] : [], offForPlans: mode === 'plan' ? ['free'] : [] }));
    await activatePolicy(h, world, policy);
    const ops = [() => service.listEnvelopes(state), () => service.listNegotiations(state), () => service.getNegotiation(sessionId, state), () => service.send(body, state),
      () => service.send({ ...body, intent: 'counter', refs: [w.supplierQuote], negotiationSessionId: sessionId }, state),
      () => service.send({ ...body, intent: 'schedule_meeting' }, state), () => service.send({ ...body, intent: 'introduce' }, state)];
    for (const [i, invoke] of ops.entries()) {
      let reason: string | undefined;
      await assert.rejects(invoke(), (e: unknown) => { reason = (e as { details?: { reason?: string } }).details?.reason; return !!reason; });
      const c = capability(ids[i]!);
      const d: AuthorityDecision = await as(h, personId, trx => authority.check(trx, actor, c.id));
      assert.equal(d.allowed ? null : d.reason, reason);
      const adapter: McpDecision = await as(h, personId, trx => mcpGate(authority, trx, mcp.connection, c, company, mcp.token));
      assert.equal('reason' in adapter ? adapter.reason : null, reason);
      if (c.mandateAction) {
        const agent: { reason: string; messageKey: string } | null = await as(h, personId, trx => agentRuntimeGate(authority)(trx, { hubId: world.hubId, personId, mandate: { onBehalfCompanyId: company, granteeKind: 'company_representative', granteeCompanyId: company }, capabilityId: c.id, action: c.mandateAction! }));
        assert.equal(agent?.reason, reason);
      }
    }
    await assert.rejects(raw());
    assert.equal((await boris.get('/v1/assistant/envelopes')).status, 403);
    await representatives.view(company, state);
  });
  await activatePolicy(h, world, negotiationPolicy(world.hubId));
  await t.test('kill refusal and foreign hub cannot deliver; raw internal implementation is inaccessible', async () => {
    const stop = await engage(world, 'agent_capability', { capabilityId: 'negotiation.message' });
    await assert.rejects(service.send(body, state)); await assert.rejects(raw());
    const adapter: McpDecision = await as(h, personId, trx => mcpGate(authority, trx, mcp.connection, capability('negotiation.message'), company, mcp.token));
    assert.equal('reason' in adapter ? adapter.reason : null, 'kill_switch');
    await release(world, stop);
    await assert.rejects(raw(null)); await assert.rejects(raw(w.seed.companies.unrelated));
    await assert.rejects(as(h, personId, trx => sql`SELECT * FROM trustwork.agent_modules_deliver_envelope_owned('{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`.execute(trx)));
    // Production provenance is immutable; runtime callers cannot remove a proof.
    await assert.rejects(as(h, personId, trx => sql`DELETE FROM trustwork.agent_mandate_provenance WHERE mandate_id=${cm.mandateId}::uuid`.execute(trx)));
  });
  await t.test('representative MCP reads never inherit private page projection; governance is handoff-only', async () => {
    for (const c of AGENT_CAPABILITIES.map(x => x.capability).filter(c => c.id.startsWith('representative.'))) {
      const decision: McpDecision = await as(h, personId, trx => mcpGate(authority, trx, mcp.connection, c, company, mcp.token));
      assert.equal(decision.decision, 'deny', c.id);
      assert.doesNotMatch(JSON.stringify(decision), /accountability|companyMandates|termsDigest|PRIVATE-/);
    }
    const forged = { ...mcp.connection, owner: { kind: 'person' as const, personId: w.seed.people.anna } };
    assert.equal((await as(h, personId, trx => mcpGate(authority, trx, forged, capability('representative.get'), company, mcp.token))).decision, 'deny');

  });  await t.test('actual delivery and current representative withdrawal serialize in both orders; crashes roll back local effects', async () => {
    const resume = async () => {
      const view = await representatives.view(company, state);
      await representatives.resume(company, { expectedRevision: view.representative!.revision }, state);
    };
    // Delivery first: pause the actual INSERT after its current gate, not an availability endpoint.
    const blocker = await h.db.admin.connect();
    let delivery: ReturnType<typeof service.send> | undefined;
    let withdraw: ReturnType<typeof representatives.suspend> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK trustwork.agent_envelope IN ACCESS EXCLUSIVE MODE');
      delivery = service.send(body, state);
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        blocked = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%agents_deliver_envelope%'")).rows[0]!.n > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, 'owning delivery reached its real insert');
      let stopped = false;
      withdraw = representatives.suspend(company, state).then(value => { stopped = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(stopped, false);
      await blocker.query('COMMIT');
      assert.equal((await delivery).status, 'delivered');
      await withdraw;
      await assert.rejects(service.send(body, state));
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await delivery; await withdraw;
    }
    await resume();
    // Revoker first holds the actual owning suspension transaction across the competing service invocation.
    let entered!: () => void; const atRevocation = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void; const releaseRevocation = new Promise<void>(resolve => { finish = resolve; });
    const revoker = as(h, personId, async trx => {
      await sql`SELECT trustwork.agents_suspend_representative(${company}::uuid)`.execute(trx);
      entered(); await releaseRevocation;
    });
    await atRevocation;
    let ended = false;
    const refused = service.send(body, state).then(() => { ended = true; return false; }, () => { ended = true; return true; });
    try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(ended, false); } finally { finish(); }
    await revoker; assert.equal(await refused, true);
    await resume();
    // A crashed withdrawal cannot become committed authority. A crashed local delivery cannot leave an envelope.
    await assert.rejects(as(h, personId, async trx => {
      await sql`SELECT trustwork.agents_suspend_representative(${company}::uuid)`.execute(trx);
      throw new Error('synthetic crash before withdrawal commit');
    }));
    assert.equal((await service.send(body, state)).status, 'delivered');
    const before = (await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_envelope')).rows[0].n;
    await assert.rejects(as(h, personId, async trx => {
      await sql`SELECT * FROM trustwork.agents_deliver_envelope(${JSON.stringify(body.actingAs)}::jsonb,
        ${JSON.stringify({ ...body, proof: {}, homeNode: 'synthetic-local' })}::jsonb,${JSON.stringify({ hubId: world.hubId, moduleKeys: ['negotiation'] })}::jsonb)`.execute(trx);
      throw new Error('synthetic crash before local delivery commit');
    }), /synthetic crash before local delivery commit/);
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_envelope')).rows[0].n, before);
  });
  for (const order of ['delivery_first', 'revoker_first'] as const) await t.test(`company mandate withdrawal serializes: ${order}`, async () => {
    const fresh = await representatives.grant(company, GrantCompanyMandateCommandSchema.parse({ executor: { kind: 'company_representative' }, terms: terms(w.rfq.rfq.id, ['communicate']) }), state);
    const message = { ...body, actingAs: { kind: 'company_representative' as const, companyMandateId: fresh.id } };
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
    if (order === 'revoker_first') {
      const revoker = as(h, personId, async trx => {
        await sql`SELECT trustwork.agents_revoke_company_mandate(${fresh.id}::uuid,${fresh.revision}::integer)`.execute(trx);
        entered(); await barrier;
      });
      await enteredPromise;
      let ended = false;
      const refused = service.send(message, state).then(() => { ended = true; return false; }, () => { ended = true; return true; });
      try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(ended, false); } finally { finish(); }
      await revoker; assert.equal(await refused, true);
    } else {
      const delivery = as(h, personId, async trx => {
        const result = await sql<{ outcome: string }>`SELECT * FROM trustwork.agents_deliver_envelope(${JSON.stringify(message.actingAs)}::jsonb,
          ${JSON.stringify({ ...message, proof: {}, homeNode: 'synthetic-local' })}::jsonb,${JSON.stringify({ hubId: world.hubId, moduleKeys: ['negotiation'] })}::jsonb)`.execute(trx);
        entered(); await barrier; return result;
      });
      await enteredPromise;
      let ended = false;
      const revoke = representatives.revoke(company, fresh.id, { expectedRevision: fresh.revision }, state).then(value => { ended = true; return value; });
      try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(ended, false); } finally { finish(); }
      assert.equal((await delivery).rows[0]?.outcome, 'delivered'); await revoke;
      await assert.rejects(service.send(message, state));
    }
  });
  await t.test('stored connection withdrawal orders the negotiation read adapter without expanding a snapshot', async () => {
    const c = capability('negotiation.list_envelopes');
    let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
    const call = as(h, personId, async trx => {
      const result = await mcpGate(authority, trx, mcp.connection, c, company, mcp.token);
      entered(); await barrier; return result;
    });
    await admitted;
    let ended = false;
    const revoke = h.pool.query('SELECT trustwork.oauth_token_revoke($1,$2)', [mcp.token.accessTokenHash, mcp.connection.clientId]).then(value => { ended = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(ended, false); } finally { finish(); }
    assert.equal((await call).decision, 'execute'); await revoke;
    assert.equal((await as(h, personId, trx => mcpGate(authority, trx, mcp.connection, c, company, mcp.token))).decision, 'deny');
  });

  await t.test('first-party suspension and revocation remain available with all commercial modules disabled', async () => {
    await activatePolicy(h, world, { ...engineDefaultPolicy(world.hubId, REGISTRY), policy: { ...engineDefaultPolicy(world.hubId, REGISTRY).policy, enabledModules: [] }, modules: [] });
    await representatives.suspend(company, state);
    await representatives.view(company, state);
    await representatives.revoke(company, cm.id, { expectedRevision: cm.revision }, state);
  });
  await t.test('legacy unknown provenance never becomes a fresh envelope authority', async () => {
    const unbound = new RepresentativeService({ ...h.created.ctx!, config: { ...h.created.config, publicOrigin: 'https://synthetic-unregistered.example.invalid' } }, h.services().principals);
    const legacy = await unbound.grant(company, GrantCompanyMandateCommandSchema.parse({ executor: { kind: 'colleague_agent', personId: w.seed.people.pure }, terms: terms(w.rfq.rfq.id, ['communicate']) }), state);
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.agent_mandate_provenance WHERE mandate_id=$1', [legacy.mandateId])).rowCount, 0);
    await assert.rejects(as(h, w.seed.people.pure, trx => sql`SELECT * FROM trustwork.agents_deliver_envelope(
      ${JSON.stringify({ kind: 'colleague_agent', companyMandateId: legacy.id })}::jsonb,
      ${JSON.stringify({ ...body, proof: {}, homeNode: 'synthetic-local' })}::jsonb,${JSON.stringify({ hubId: world.hubId, moduleKeys: ['negotiation'] })}::jsonb)`.execute(trx)),
    (e: unknown) => (e as { hint?: string }).hint === 'agents.hub_provenance_unavailable');
  });

});

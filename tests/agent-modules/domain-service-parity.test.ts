import { TasksService } from '../../apps/api/src/modules/tasks/tasks.service.js';
import { ConsultationsService } from '../../apps/api/src/modules/consultations/consultations.service.js';
import { CreateTaskRequestCommandSchema } from '../../packages/contracts/src/tasks.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { sql } from 'kysely';
import { ProfilesService } from '../../apps/api/src/modules/profiles/profiles.service.js';
import { ReputationService } from '../../apps/api/src/modules/reputation/reputation.service.js';
import { GoalsService } from '../../apps/api/src/modules/assistant-goals/goals.service.js';
import { CapabilityAuthority, agentRuntimeGate, mcpGate, type McpDecision } from '../../apps/api/src/modules/agent-modules/authority.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, stateOf } from '../assistant/helpers.js';
import { REGISTRY } from './fixtures.js';
import { activatePolicy, buildAgentWorld, ok } from './helpers.js';
import { installSyntheticMcpConnection } from './mcp-token-fixture.js';

const h = await startHarness('agent_domain_parity');
test('actual Profile, Reputation, Core, Task and Consultation operations preserve owning authority under shared policy', { skip: h ? false : SKIP_REASON }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  const client = h.client();
  await login(client, 'petr');
  const outsider = h.client();
  await login(outsider, 'carl');
  const anonymous = h.client();
  const profiles = h.created.app.get(ProfilesService);
  const reputation = h.created.app.get(ReputationService);
  const goals = h.created.app.get(GoalsService);
  const tasks = h.created.app.get(TasksService);
  const consultations = h.created.app.get(ConsultationsService);
  const person = { kind: 'person' as const, id: seed.people.petr };
  const state = await stateOf(h, client, 'domain-parity');
  const authority = new CapabilityAuthority({ hubId: world.hubId });
  const mcp = await installSyntheticMcpConnection(h, person.id, world.hubId);
  const base = () => engineDefaultPolicy(world.hubId, REGISTRY);
  await activatePolicy(h, world, base());
  const project = ok<{ id: string }>(await client.post('/v1/projects', { owner: person, name: 'Synthetic task parity', summary: null, leaderPersonId: null }), 201);
  const content = { summary: null, assumptions: [], budget: null, timeline: null, dependencies: [], items: [{ key: 'synthetic-task', kind: 'task', parentKey: null, title: 'Synthetic task', description: null,
    stepTerms: ['work.envelope.roofing'], requiredSkills: [], quantity: null, estimate: null, duration: null, window: null, riskLevel: null, decisionQuestion: null, sources: [], attachments: [], privateNotes: null }] };
  const plan = ok<{ draft: { id: string; revision: number } }>(await client.post(`/v1/projects/${project.id}/plan`, { timeZone: 'UTC', actor: { via: 'person' }, content }), 201);
  const proposed = ok<{ revision: number; digest: unknown }>(await client.post(`/v1/projects/${project.id}/plan/versions/${plan.draft.id}/propose`, { expectedRevision: plan.draft.revision, actor: { via: 'person' } }));
  ok(await client.post(`/v1/projects/${project.id}/plan/versions/${plan.draft.id}/approve`, { expectedRevision: proposed.revision, digest: proposed.digest }));
  const taskInput = CreateTaskRequestCommandSchema.parse({ source: { projectId: project.id, itemKey: 'synthetic-task' }, audience: 'invited', actor: { via: 'person' }, privateConstraint: null,
    terms: { title: 'Synthetic task', fields: ['scope'], scopeNote: null, milestoneItemKeys: ['synthetic-task'], acceptanceCriteria: ['Synthetic evidence'], responseDeadline: '2027-06-01T00:00:00Z', currency: 'USD' } });
  const operations = [
    { capability: 'task_marketplace.list_requests', call: () => tasks.listRequests(state) },
    { capability: 'task_marketplace.draft_request', call: () => tasks.createRequest(taskInput, state) },
    { capability: 'consultation.list_availability', call: () => consultations.listWindows(state) },
    { capability: 'consultation.open_window', call: () => consultations.openWindow({ startsAt: '2027-05-01T10:00:00Z', endsAt: '2027-05-01T11:00:00Z', timeZone: 'UTC', capacity: 1, actor: { via: 'person' } }, state) },
    { capability: 'profile_keeper.get_my_profile', call: () => profiles.myProfile(state) },
    { capability: 'profile_keeper.add_experience', call: () => profiles.addExperience({ organisation: { companyId: null, name: 'Synthetic experience' }, role: 'Builder', summary: null, from: '2026-01-01', to: null, visibility: 'private' }, state) },
    { capability: 'reputation_builder.explain_my_reputation', call: () => reputation.own(person, state) },
    { capability: 'reputation_builder.publish_portfolio_entry', call: () => reputation.addPortfolioEntry({ holder: person, context: null, externalDescription: 'Synthetic completed work', title: 'Synthetic patio', role: 'Builder', period: { from: null, to: null }, scopeSummary: 'Synthetic private evidence', visibility: 'private', supersedesId: null }, state) },
    { capability: 'core.list_goals', call: () => goals.listGoals(state) },
    { capability: 'core.create_goal', call: () => goals.createGoal({ onBehalfOf: null, text: 'Synthetic goal', successCriteria: ['Synthetic completion'], needs: [], budgetRange: null, horizon: '2027-01-01T00:00:00.000Z', reportCadence: 'weekly' }, state) },
  ];
  await t.test('real reads and mutations have positive owning-service paths', async () => {
    for (const operation of operations) await operation.call();
    assert.equal((await outsider.get(`/v1/reputation-builder/people/${person.id}/own`)).status, 404);
  });
  for (const mode of ['module', 'capability', 'participant', 'plan'] as const) {
    await t.test(`${mode} disable refuses actual reads and mutations identically to the agent adapter`, async () => {
      const policy = base();
      if (mode === 'module') policy.policy.enabledModules = policy.policy.enabledModules.filter(m => !['profile_keeper', 'reputation_builder', 'core', 'task_marketplace', 'consultation'].includes(m.moduleKey));
      else policy.capabilities = operations.map(({ capability }) => ({ capabilityId: capability, offForHub: mode === 'capability', offForPrincipalKinds: mode === 'participant' ? ['person'] : [], offForPlans: mode === 'plan' ? ['free'] : [] }));
      await activatePolicy(h, world, policy);
      for (const operation of operations) {
        let reason: string | undefined;
        await assert.rejects(operation.call(), (e: unknown) => { reason = (e as { details?: { reason?: string } }).details?.reason; return !!reason; });
        const capability = REGISTRY.manifests.flatMap(m => m.capabilities).find(c => c.id === operation.capability)!;
        // Null-action reads use the same shared check; model proposals only carry actual mandate verbs.
        const result: { reason: string; messageKey: string } | null = await as(h, person.id, async trx => {
          if (capability.mandateAction !== null) return agentRuntimeGate(authority)(trx, { hubId: world.hubId, personId: person.id, mandate: { onBehalfCompanyId: null, granteeKind: 'own_agent', granteeCompanyId: null }, capabilityId: capability.id, action: capability.mandateAction });
          const decision = await authority.check(trx, { personId: person.id, onBehalfCompanyId: null, representativeOf: null, connectionId: null }, capability.id);
          return decision.allowed ? null : { reason: decision.reason, messageKey: decision.messageKey };
        });
        assert.ok(result);
        assert.equal(result.reason, reason);
        const adapter: McpDecision = await as(h, person.id, trx => mcpGate(authority, trx, mcp.connection, capability, null, mcp.token));
        assert.equal(adapter.decision, 'deny');
        assert.equal('reason' in adapter ? adapter.reason : null, reason);
      }
      assert.equal((await client.get('/v1/me/profile')).status, 403);
      assert.equal((await client.get('/v1/assistant/goals')).status, 403);
    });
  }
  await t.test('consent, subscription stops and public projections survive disabled modules without invented participants', async () => {
    const visibility = ok<{ person: { profileVisibility: string } }>(await client.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: 'profile_public.v1' }));
    assert.equal(visibility.person.profileVisibility, 'public');
    assert.equal((await anonymous.get(`/v1/people/${person.id}/profile`)).status, 200);
    assert.equal((await anonymous.get(`/v1/reputation-builder/people/${person.id}`)).status, 200);
    assert.equal((await anonymous.get(`/v1/consultation-offerings/public?ownerKind=person&ownerId=${person.id}`)).status, 200);
    assert.equal((await client.get('/v1/me/consents')).status, 200);
    assert.equal((await client.get('/v1/assistant/job-subscriptions')).status, 200);
    const withdrawn = await client.post('/v1/me/profile/visibility', { visibility: 'private', reason: 'Synthetic withdrawal' });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal((await anonymous.get(`/v1/people/${person.id}/profile`)).status, 404);
    const publicCapability = await as(h, person.id, trx => authority.check(trx, { personId: person.id, onBehalfCompanyId: null, representativeOf: null, connectionId: null }, 'profile_keeper.get_public_profile'));
    assert.equal(publicCapability.allowed, true);
  });
  await t.test('public read and serving withdrawal serialize in both orders without a participant session', async () => {
    const blocker = await h.db.admin.connect();
    let read: ReturnType<typeof anonymous.get> | undefined;
    let withdraw: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE trustwork.professional_credential IN ACCESS EXCLUSIVE MODE');
      read = anonymous.get(`/v1/reputation-builder/people/${person.id}`);
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        blocked = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reputation_public%'")).rows[0]!.n > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, 'the owning public projection reached its query after the serving gate');
      let ended = false;
      withdraw = withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=false WHERE hub_id=${world.hubId}::uuid`.execute(trx)).then(result => { ended = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(ended, false);
      await blocker.query('COMMIT');
      assert.equal((await read).status, 200);
      await withdraw;
      assert.equal((await anonymous.get(`/v1/reputation-builder/people/${person.id}`)).status, 403);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await read; await withdraw;
      await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=true WHERE hub_id=${world.hubId}::uuid`.execute(trx));
    }
  });
  await t.test('public serving authority is unavailable after withdrawal and cannot expose private rows', async () => {
    await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=false WHERE hub_id=${world.hubId}::uuid`.execute(trx));
    assert.equal((await anonymous.get(`/v1/reputation-builder/people/${person.id}`)).status, 403);
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.agent_authz_epoch FOR UPDATE'));
    const raw = await h.pool.query('SELECT * FROM trustwork.person_profile');
    assert.equal(raw.rowCount, 0);
    await withMaintenance(h.db.admin, trx => sql`UPDATE trustwork.agent_serving_hub SET active=true WHERE hub_id=${world.hubId}::uuid`.execute(trx));
  });
  await t.test('stored token revocation serializes with adapter admission, and raw other-person scope lookup fails closed', async () => {
    await activatePolicy(h, world, base());
    const capability = REGISTRY.manifests.flatMap(m => m.capabilities).find(c => c.id === 'core.list_goals')!;
    const alien = await as(h, seed.people.carl, trx => sql<{ scopes: string[] | null }>`SELECT trustwork.agent_modules_mcp_token_scopes(${mcp.connection.id}::uuid,${mcp.token.accessTokenHash}::bytea,${mcp.token.audience},NULL) AS scopes`.execute(trx));
    assert.equal(alien.rows[0]?.scopes, null);
    let admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const invocation = as(h, person.id, async trx => {
      const decision = await mcpGate(authority, trx, mcp.connection, capability, null, mcp.token);
      admit();
      await barrier;
      return decision;
    });
    await admitted;
    let revoked = false;
    const revoker = h.pool.query('SELECT trustwork.oauth_token_revoke($1,$2)', [mcp.token.accessTokenHash, mcp.connection.clientId]).then(value => { revoked = true; return value; });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(revoked, false, 'the admitted adapter transaction retains the original token authority');
    } finally { finish(); }
    assert.equal((await invocation).decision, 'execute');
    await revoker;
    assert.equal((await as(h, person.id, trx => mcpGate(authority, trx, mcp.connection, capability, null, mcp.token))).decision, 'deny');
  });
});

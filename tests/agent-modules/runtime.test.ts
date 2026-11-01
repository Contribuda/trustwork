import { installSyntheticMcpToken } from './mcp-token-fixture.js';
import { installSyntheticHandler } from '../assistant/manifest-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { jobs, withMaintenance, withPrincipal } from '@trustwork/data';
import { inTransaction } from '@trustwork/worker';
import type { ExternalConnection } from '../../packages/contracts/src/agent-catalog.js';
import { assistantWorker } from '../../packages/data/src/repositories/assistant.js';
import { agentAuthority, agentJobWorker } from '../../packages/data/src/repositories/agent-modules.js';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS } from '../../apps/api/src/modules/assistant/assistant.service.js';
import { assistantPolicySettings } from '../../apps/api/src/modules/assistant/assistant.module.js';
import { FakeRetrieval, ScriptedModel } from '../../apps/api/src/modules/assistant/ports.js';
import { agentRuntimeGate, CapabilityAuthority, mcpGate, type AgentActor } from '../../apps/api/src/modules/agent-modules/authority.js';
import { runDueJobs } from '../../apps/api/src/modules/agent-modules/scheduler.js';
import { FixedEntitlements } from '../../apps/api/src/modules/agent-modules/ports.js';
import { US_HUB } from '../hubs/helpers.js';
import { principalFor } from '../data/helpers/seed.js';
import { SKIP_REASON, startHarness, type Client } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { expectRefusal } from '../admin/helpers.js';
import { stateOf, workerLogin } from '../assistant/helpers.js';
import { PLANNER, PLANNER_COMMIT, PLANNER_READ, usHubPolicy as baseHubPolicy, withSwitch } from './fixtures.js';
import { activatePolicy, buildAgentWorld, engage, engageNode, ok, release, type AgentWorld } from './helpers.js';

/**
 * AGT-003 at runtime on real PostgreSQL: turning a job on creates only a mandate proposal and nothing fires until the person
 * confirms it on the first-party form; the scheduler fires in the principal's time zone and rechecks everything at fire
 * time; every kill-switch level blocks the next action check and sends executing actions to reconciliation, serialized
 * with dispatch through authorization epochs; and a capability switched off for the hub, a participant type or a plan is
 * refused identically by the interface, the agent runtime and MCP.
 */
// This revoker matrix deliberately retains several unresolved operations. Give only this synthetic
// policy enough capacity to exercise every revoker; focused admission tests verify the small limits.
const usHubPolicy: typeof baseHubPolicy = (hubId, over = {}) => {
  const policy = baseHubPolicy(hubId, over);
  for (const module of policy.modules) module.limits.concurrentRuns = 20;
  return policy;
};

const h = await startHarness('agent_modules_runtime');

interface JobBody { request: { executionAvailability: string; executionMessageKey: string | null; id: string; status: string; mandateProposalId: string; jobSubscriptionId: string | null; nextDueAt: string | null }; confirmation: { proposalId: string; digest: { algorithm: string; value: string }; mandate: { approvalPolicy: unknown; actions: string[] } } }
const until = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const turnOn = (client: Client, over: Record<string, unknown> = {}) => client.post('/v1/assistant/jobs', { actingFor: 'self', moduleKey: 'project_planner', templateKey: 'weekly_plan_review', trigger: null, validUntil: until(90), ...over });

test('jobs, kill switches, reconciliation and parity', { skip: h ? false : SKIP_REASON, timeout: 600_000 }, async (t) => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => {
    await worker.close();
    await h.close();
  });
  const world: AgentWorld = await buildAgentWorld(h);
  for (const cap of ['share_item', 'revoke_share', 'record_change', 'add_diary_entry']) await installSyntheticHandler(h, `project_planner.${cap}`, 'fake_publications', 'plan.share');
  const { hubId } = world;
  const seed = await seedPersonas(h);
  const petrId = seed.people.petr;
  const petr = h.client();
  await login(petr, 'petr');
  await activatePolicy(h, world, usHubPolicy(hubId));
  const pool = worker.pool(6);
  const count = async (q: string, params: unknown[] = []) => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${q}) q`, params)).rows[0]!.n;

  await t.test('turning a job on creates only a mandate proposal; nothing can fire until it is confirmed', async () => {
    const body = ok<JobBody>(await turnOn(petr), 201);
    assert.equal(body.request.status, 'pending');
    assert.equal(body.request.executionAvailability, 'implementation_unavailable');
    assert.equal(body.request.executionMessageKey, 'agentModules.refusal.moduleNotServing');
    assert.equal(body.request.jobSubscriptionId, null);
    assert.equal(body.confirmation.proposalId, body.request.mandateProposalId);
    assert.deepEqual(body.confirmation.mandate.approvalPolicy, { mode: 'ask_each' }, 'the hub default, never looser than the verb default');
    assert.equal(await count("SELECT 1 FROM trustwork.mandate_proposal WHERE id = $1 AND status = 'pending' AND origin_kind = 'module_template'", [body.request.mandateProposalId]), 1);
    assert.equal(await count('SELECT 1 FROM trustwork.job_subscription WHERE principal_person_id = $1', [petrId]), 0);
    assert.equal(await count("SELECT 1 FROM trustwork.mandate WHERE principal_person_id = $1 AND 'project_planner' = ANY (module_keys)", [petrId]), 0);
    assert.equal(await count('SELECT 1 FROM trustwork.agent_job_schedule'), 0);
    const firstDue = (await h.db.admin.query<{ first_due_at: Date }>('SELECT first_due_at FROM trustwork.agent_job_request WHERE id = $1', [body.request.id])).rows[0]!.first_due_at;
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(firstDue);
    assert.equal(local.find((p) => p.type === 'weekday')?.value, 'Mon');
    assert.equal(local.find((p) => p.type === 'hour')?.value, '09');
    // Even long past the first due time, the scheduler has nothing to fire.
    h.clock.advance(1000);
    assert.deepEqual(await inTransaction(pool, (trx) => runDueJobs(trx)), { claimed: 0, outcomes: {} });
    // Nobody but the person can turn the proposal into a job: the request cannot be moved directly.
    await assert.rejects(withPrincipal(h.pool, await principalFor(h.db.admin, petrId), (trx) => trx.updateTable('agent_job_request').set({ status: 'active' }).where('id', '=', body.request.id).execute()));
  });

  await t.test('jobs the hub does not offer, triggers outside the template and over-long validity are refused', async () => {
    expectRefusal(await turnOn(petr, { templateKey: 'daily_everything' }), 404, 'access.not_found', 'template_not_offered');
    expectRefusal(await turnOn(petr, { trigger: { kind: 'event', eventType: 'rfq.published' } }), 422, 'validation.schema', 'trigger_invalid');
    expectRefusal(await turnOn(petr, { trigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=9,10', timeZone: 'America/Chicago' } }), 422, 'validation.schema', 'trigger_invalid');
    expectRefusal(await turnOn(petr, { validUntil: until(400) }), 422, 'validation.schema', 'validity_invalid');
    expectRefusal(await turnOn(petr, { actingFor: 'employer' }), 404, 'access.not_found', 'no_employer');
  });

  await t.test('declining the proposal withdraws the job request', async () => {
    const body = ok<JobBody>(await turnOn(petr), 201);
    ok(await petr.post(`/v1/assistant/mandate-proposals/${body.request.mandateProposalId}/decline`, {}));
    const jobsView = ok<{ jobs: { id: string; status: string; reason: string | null }[] }>(await petr.get('/v1/assistant/jobs'));
    assert.deepEqual(jobsView.jobs.find((j) => j.id === body.request.id), { ...jobsView.jobs.find((j) => j.id === body.request.id)!, status: 'withdrawn', reason: 'proposal_declined' });
    assert.equal(await count('SELECT 1 FROM trustwork.job_subscription WHERE principal_person_id = $1', [petrId]), 0);
  });

  let requestId = '';
  let subscriptionId = '';
  let mandateId = '';
  await t.test('confirming on the first-party form creates the subscription with the confirmed mandate and its schedule', async () => {
    const body = ok<JobBody>(await turnOn(petr), 201);
    requestId = body.request.id;
    ok(await petr.post(`/v1/assistant/mandate-proposals/${body.request.mandateProposalId}/confirm`, { digest: body.confirmation.digest }));
    const view = ok<{ jobs: { id: string; status: string; jobSubscriptionId: string | null; nextDueAt: string | null }[] }>(await petr.get('/v1/assistant/jobs')).jobs.find((j) => j.id === requestId)!;
    assert.equal(view.status, 'active');
    expectRefusal(await world.staff.owner.post(`/v1/assistant/jobs/${requestId}/run`), 404, 'access.not_found');
    expectRefusal(await world.staff.owner.post(`/v1/assistant/mandate-proposals/${body.request.mandateProposalId}/confirm`, { digest: body.confirmation.digest }), 404, 'access.not_found');
    assert.ok(view.jobSubscriptionId && view.nextDueAt);
    subscriptionId = view.jobSubscriptionId;
    const sub = (await h.db.admin.query<{ status: string; mandate_id: string }>('SELECT status, mandate_id FROM trustwork.job_subscription WHERE id = $1', [subscriptionId])).rows[0]!;
    assert.equal(sub.status, 'active');
    mandateId = sub.mandate_id;
    assert.equal((await h.db.admin.query<{ status: string }>('SELECT status FROM trustwork.mandate WHERE id = $1', [mandateId])).rows[0]!.status, 'active');
  });

  const makeDue = (id: string) => withMaintenance(h.db.admin, (trx) => trx.updateTable('agent_job_schedule').set({ next_due_at: new Date(Date.now() - 60_000) }).where('job_subscription_id', '=', id).execute());
  await t.test('the scheduler fires a due job once, emits agents.job_due and moves to the next Monday 09:00 in New York', async () => {
    await makeDue(subscriptionId);
    const due = (await h.db.admin.query<{ next_due_at: Date }>('SELECT next_due_at FROM trustwork.agent_job_schedule WHERE job_subscription_id = $1', [subscriptionId])).rows[0]!.next_due_at;
    assert.deepEqual(await inTransaction(pool, (trx) => runDueJobs(trx)), { claimed: 1, outcomes: { due: 1 } });
    assert.equal(await count("SELECT 1 FROM trustwork.outbox_event WHERE type = 'agents.job_due' AND aggregate_id = $1", [subscriptionId]), 1);
    const next = (await h.db.admin.query<{ next_due_at: Date }>('SELECT next_due_at FROM trustwork.agent_job_schedule WHERE job_subscription_id = $1', [subscriptionId])).rows[0]!.next_due_at;
    assert.ok(next.getTime() > Date.now());
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(next);
    assert.deepEqual([parts.find((p) => p.type === 'weekday')?.value, parts.find((p) => p.type === 'hour')?.value], ['Mon', '09']);
    assert.deepEqual(await inTransaction(pool, (trx) => runDueJobs(trx)), { claimed: 0, outcomes: {} });
    // Recording the same due time again is idempotent.
    assert.equal(await inTransaction(pool, (trx) => agentJobWorker.recordFire(trx, { subscriptionId, cause: 'schedule', dueAt: due, nextDueAt: next, hubId })), 'due');
    assert.equal(await count("SELECT 1 FROM trustwork.outbox_event WHERE type = 'agents.job_due' AND aggregate_id = $1", [subscriptionId]), 1);
    // The runtime role cannot fire jobs or read the schedule of others.
    await assert.rejects(h.pool.query('SELECT trustwork.agent_modules_due_jobs(10)'));
  });

  await t.test('at fire time a kill switch blocks, a withdrawn template stops, and an inactive mandate never runs', async () => {
    const id = await engage(world, 'agent_module', { moduleKey: 'project_planner' });
    await makeDue(subscriptionId);
    assert.deepEqual((await inTransaction(pool, (trx) => runDueJobs(trx))).outcomes, { blocked: 1 });
    await release(world, id);
    await activatePolicy(h, world, { ...usHubPolicy(hubId), jobTemplates: [] });
    await makeDue(subscriptionId);
    assert.deepEqual((await inTransaction(pool, (trx) => runDueJobs(trx))).outcomes, { template_withdrawn: 1 });
    await activatePolicy(h, world, usHubPolicy(hubId));
    expectRefusal(await petr.post(`/v1/assistant/jobs/${requestId}/run`), 403, 'access.forbidden', 'template_unavailable');
    assert.equal(await count('SELECT 1 FROM trustwork.agent_job_occurrence WHERE job_subscription_id = $1', [subscriptionId]), 0, 'a legacy readiness template has no executable handler');
    const mandate = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.mandate WHERE id = $1', [mandateId])).rows[0]!;
    ok(await petr.post(`/v1/assistant/mandates/${mandateId}/revoke`, { expectedRevision: mandate.revision, reason: 'Synthetic: no more reviews' }));
    expectRefusal(await petr.post(`/v1/assistant/jobs/${requestId}/run`), 403, 'access.forbidden', 'template_unavailable');
    await makeDue(subscriptionId);
    assert.deepEqual((await inTransaction(pool, (trx) => runDueJobs(trx))).outcomes, { mandate_inactive: 1 });
  });

  // ---------- Kill switches and the agent runtime ----------
  const authority = new CapabilityAuthority({ hubId });
  const model = new ScriptedModel();
  const service = new AssistantService(h.created.ctx!, h.services().principals, assistantPolicySettings({ hubId }), DEFAULT_RUNTIME_SETTINGS, model, new FakeRetrieval([]), agentRuntimeGate(authority));
  const effectProject = ok<{ id: string }>(await petr.post('/v1/projects', { owner: { kind: 'person', id: petrId }, name: 'Synthetic effect context', summary: null, leaderPersonId: null }), 201);
  const newMandate = async () => {
    h.clock.advance(1000);
    const c = h.client();
    await login(c, 'petr');
    return ok<{ id: string }>(await c.post('/v1/assistant/mandates', { draft: {
      onBehalfOf: null, grantee: { kind: 'own_agent' }, moduleKeys: ['project_planner'], actions: ['publish', 'record_evidence'], contexts: [{ kind: 'project', id: effectProject.id }],
      limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [],
      escalation: { kind: 'ask_principal' }, validUntil: until(30),
    } }), 201).id;
  };
  let actionMandate = await newMandate();
  const ACTION_OF: Record<string, 'publish' | 'record_evidence'> = {
    'project_planner.share_item': 'publish', 'project_planner.revoke_share': 'publish', 'project_planner.record_change': 'record_evidence', 'project_planner.add_diary_entry': 'record_evidence',
  };
  let turns = 0;
  const propose = async (capabilityId: string, action = ACTION_OF[capabilityId] ?? 'publish', effectOverride: { provider: string; operation: string } | null = null) => {
    model.push({ text: 'Proposed.', messageKey: null, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{
      kind: 'propose_action', mandateId: actionMandate, capabilityId, moduleKey: 'project_planner', action, context: { kind: 'project', id: effectProject.id }, amount: null, projectId: null,
      effect: { provider: 'fake_publications', operation: 'plan.share', ...effectOverride, payload: { item: 'synthetic' } },
    }] });
    return (await service.converse({ text: 'Share the plan item' }, await stateOf(h, petr, `req-agt3-${++turns}`))).actions[0]!;
  };
  const leaseFor = async (intentId: string) => {
    const leased = await inTransaction(pool, (trx) => jobs.lease(trx, ['assistant.dispatch'], `agt3-${randomUUID()}`, 60, 50));
    const job = leased.find((j) => (j.payload as { intentId?: string }).intentId === intentId);
    assert.ok(job, 'the dispatch job of the intent');
    return job;
  };
  const intent = async (id: string) => (await h.db.admin.query<{ state: string; state_reason: string | null }>('SELECT state, state_reason FROM trustwork.action_intent WHERE id = $1', [id])).rows[0]!;
  const actor: AgentActor = { personId: petrId, onBehalfCompanyId: null, representativeOf: null, connectionId: null };
  const check = async (a: Partial<AgentActor> = {}, capabilityId = PLANNER_COMMIT, action: string | null = 'publish') =>
    withPrincipal(h.pool, await principalFor(h.db.admin, a.personId ?? petrId), (trx) => authority.check(trx, { ...actor, ...a }, capabilityId, action));

  // A real MCP connection of petr's (MCP-002 tables), for the external-agent and connection levels.
  const connectionId = await withMaintenance(h.db.admin, async (trx) => {
    const client = await trx.insertInto('oauth_client').values({ client_id: 'synthetic-client-agt3', registration: 'pre_registered', client_name: 'Synthetic desktop assistant', redirect_uris: ['https://client.example/cb'], application_type: 'web', token_endpoint_auth_method: 'none' }).returning('id').executeTakeFirstOrThrow();
    const consent = await trx.insertInto('connection_consent').values({ person_id: petrId, client_ref: client.id, client_id: 'synthetic-client-agt3', redirect_uri: 'https://client.example/cb', surface: 'participant', scopes: ['read.public', 'read.me', 'read.private', 'propose', 'act'], private_data_classes: ['private_projects', 'budgets'], toolsets: ['plans'], mandate_bindings: sql`${JSON.stringify([{ mandateId: actionMandate, revision: 1 }])}::jsonb` as never, consent_text_version: 1, step_up: true, locale: 'en', expires_at: new Date(Date.now() + 30 * 86_400_000) }).returning('id').executeTakeFirstOrThrow();
    return (await trx.insertInto('connection').values({ hub_id: hubId, person_id: petrId, surface: 'participant', client_ref: client.id, client_id: 'synthetic-client-agt3', resource: 'https://trustwork.test/mcp', redirect_uri: 'https://client.example/cb', consent_id: consent.id }).returning('id').executeTakeFirstOrThrow()).id;
  });

  await t.test('the runtime refuses a capability paired with another action even when the mandate grants both verbs', async () => {
    assert.deepEqual(await propose(PLANNER_COMMIT, 'record_evidence'), { state: 'denied', reason: 'capability.unknown' });
    assert.deepEqual(await propose(PLANNER_READ, 'publish'), { state: 'denied', reason: 'capability.unknown' });
  });

  await t.test('a model cannot pair a permitted capability with another provider or operation', async () => {
    assert.deepEqual(await propose(PLANNER_COMMIT, 'publish', { provider: 'fake_payments', operation: 'payment.release' }), { state: 'denied', reason: 'handler_unavailable' });
    assert.deepEqual(await propose(PLANNER_COMMIT, 'publish', { provider: 'fake_publications', operation: 'arbitrary.publish' }), { state: 'denied', reason: 'handler_unavailable' });
  });

  await t.test('trusted run provenance isolates hub switches for the same person and mandate', async () => {
    const otherHub = (await world.a.createHub(`synthetic-runtime-b-${randomUUID().slice(0, 8)}`, US_HUB)).hub_id;
    await world.a.assignSensitive({ personId: world.w.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId: otherHub } });
    await world.a.assignSensitive({ personId: world.w.people.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: otherHub } });
    const otherWorld = { ...world, hubId: otherHub };
    await activatePolicy(h, otherWorld, usHubPolicy(otherHub));
    const origin = 'https://synthetic-runtime-b.example.invalid';
    await withMaintenance(h.db.admin, (trx) => sql`INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES(${origin},${otherHub}::uuid)`.execute(trx));
    const otherModel = new ScriptedModel();
    const otherService = new AssistantService({ ...h.created.ctx!, config: { ...h.created.config, publicOrigin: origin } }, h.services().principals,
      assistantPolicySettings({ hubId }), DEFAULT_RUNTIME_SETTINGS, otherModel, new FakeRetrieval([]), agentRuntimeGate(authority));
    const a = await propose(PLANNER_COMMIT);
    assert.equal(a.state, 'queued');
    const aId = (a as { intentId: string }).intentId;
    const aJob = await leaseFor(aId);
    await assert.rejects(inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, aId, aJob.id, null, String(BigInt(aJob.fencing_token) + 1n))),
      (error: unknown) => (error as { hint?: string }).hint === 'assistant.fenced_out');
    assert.equal((await intent(aId)).state, 'queued', 'a stale lease cannot start an otherwise authorized effect');
    assert.equal((await inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, aId, aJob.id, null, aJob.fencing_token))).status, 'dispatch');
    otherModel.push({ text: 'Synthetic separate hub.', messageKey: null, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{
      kind: 'propose_action', mandateId: actionMandate, capabilityId: PLANNER_COMMIT, moduleKey: 'project_planner', action: 'publish',
      context: { kind: 'project', id: effectProject.id }, amount: null, projectId: null,
      effect: { provider: 'fake_publications', operation: 'plan.share', payload: { item: 'synthetic-b' } },
    }] });
    const b = (await otherService.converse({ text: 'Synthetic hub B request' }, await stateOf(h, petr, `hub-b-${randomUUID()}`))).actions[0]!;
    assert.equal(b.state, 'queued');
    const bId = (b as { intentId: string }).intentId;
    const bJob = await leaseFor(bId);
    const stored = (await h.db.admin.query<{ hub_id: string; same_digest: boolean }>(`SELECT p.hub_id,p.mandate_digest = m.digest AS same_digest
      FROM trustwork.agent_intent_provenance p JOIN trustwork.mandate m ON m.id = p.mandate_id WHERE p.action_intent_id = $1`, [bId])).rows[0];
    assert.deepEqual(stored, { hub_id: otherHub, same_digest: true });
    assert.equal((await inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, bId, bJob.id, null, bJob.fencing_token))).status, 'dispatch', 'stored hub wins over process default');
    const stopB = await engage(otherWorld, 'agent_capability', { capabilityId: PLANNER_COMMIT });
    assert.equal((await intent(aId)).state, 'executing');
    assert.equal((await intent(bId)).state, 'outcome_unknown');
    const stopA = await engage(world, 'agent_capability', { capabilityId: PLANNER_COMMIT });
    assert.equal((await intent(aId)).state, 'outcome_unknown');
    await release(otherWorld, stopB);
    await release(world, stopA);
  });

  await t.test('each kill switch blocks the next action check; releasing reactivates nothing it stopped', async () => {
    assert.equal((await check()).allowed, true);
    for (const [kind, target] of [
      ['hub_agent_dispatch', {}], ['agent_module', { moduleKey: 'project_planner' }], ['agent_capability', { capabilityId: PLANNER_COMMIT }], ['agent_action', { action: 'publish' }],
    ] as const) {
      const queued = await propose(PLANNER_COMMIT);
      assert.equal(queued.state, 'queued', `${kind}: ${JSON.stringify(queued)}`);
      const intentId = (queued as { intentId: string }).intentId;
      const job = await leaseFor(intentId);
      const id = await engage(world, kind, target);
      expectRefusal(await petr.get(`/v1/assistant/capabilities/${PLANNER_COMMIT}`), 403, 'access.forbidden', 'kill_switch');
      const d = await check();
      assert.deepEqual(d.allowed ? null : [d.reason, d.blockedBy?.kind, d.messageKey], ['kill_switch', kind, 'agentModules.refusal.paused'], kind);
      // The next check of the runtime itself: the dispatch recheck refuses and revokes before any call.
      assert.deepEqual(await inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, intentId, job.id, hubId, job.fencing_token)), { status: 'refused', reason: 'kill_switch' });
      assert.equal((await intent(intentId)).state, 'revoked');
      // A new proposal is refused by the agent runtime gate at once.
      const refused = await propose(PLANNER_COMMIT);
      assert.deepEqual(refused, { state: 'denied', reason: 'kill_switch' });
      await release(world, id);
      assert.equal((await check()).allowed, true, `${kind} released`);
      assert.equal((await intent(intentId)).state, 'revoked', 'releasing reactivates nothing');
    }
    // Outbound messages stop only verbs that message other parties.
    const outbound = await engage(world, 'outbound_messages');
    assert.equal((await check()).allowed, true);
    const outboundRefusal = await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), (trx) => agentAuthority.dispatchRefusal(trx, {
      hubId, moduleKey: 'project_planner', capabilityId: null, action: 'communicate', personId: petrId, connectionId: null, representativeOf: null,
    }));
    assert.equal(outboundRefusal?.kind, 'outbound_messages');
    await release(world, outbound);
    // External agents: only calls through a connection are stopped.
    const ext = await engage(world, 'external_agent_api');
    assert.equal((await check()).allowed, true);
    assert.deepEqual(await check({ connectionId }).then((d) => (d.allowed ? null : d.blockedBy?.kind)), 'external_agent_api');
    await release(world, ext);
    assert.equal((await check({ connectionId })).allowed, true);
    // The company representative: missing or suspended stops it; active lets it act.
    const supplier = seed.companies.supplier;
    await assert.rejects(check({ representativeOf: supplier }, PLANNER_READ, null), (error: unknown) => (error as { hint?: string }).hint === 'access.not_found');
    assert.deepEqual(await check({ personId: seed.people.boris, representativeOf: supplier, onBehalfCompanyId: null }, PLANNER_READ, null).then((d) => (d.allowed ? null : d.blockedBy?.kind)), 'company_representative');
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('company_representative').values({ company_id: supplier, accountable_person_id: seed.people.boris, status: 'active', enabled_by_person_id: seed.people.boris, accepted_at: new Date() }).execute());
    assert.equal((await check({ personId: seed.people.boris, representativeOf: supplier }, PLANNER_READ, null)).allowed, true);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('company_representative').set({ status: 'suspended', suspension_reason: 'admin_suspended' }).where('company_id', '=', supplier).execute());
    assert.deepEqual(await check({ personId: seed.people.boris, representativeOf: supplier }, PLANNER_READ, null).then((d) => (d.allowed ? null : d.blockedBy?.kind)), 'company_representative');
    assert.ok(Number((await h.db.admin.query("SELECT epoch FROM trustwork.agent_authz_epoch WHERE scope_kind = 'company' AND scope_id = $1", [supplier])).rows[0].epoch) >= 2, 'the suspension bumped the epoch');
  });

  await t.test('executing actions go to reconciliation when a switch engages: the dispatcher is fenced out, never retried', async () => {
    const queued = await propose(PLANNER_COMMIT);
    const intentId = (queued as { intentId: string }).intentId;
    const job = await leaseFor(intentId);
    const target = await inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, intentId, job.id, hubId, job.fencing_token));
    assert.equal(target.status, 'dispatch');
    assert.equal((await intent(intentId)).state, 'executing');
    const id = await engage(world, 'agent_capability', { capabilityId: PLANNER_COMMIT });
    const after = await intent(intentId);
    assert.equal(after.state, 'outcome_unknown');
    assert.match(after.state_reason ?? '', /kill switch/);
    assert.equal(await count("SELECT 1 FROM trustwork.action_attempt WHERE action_intent_id = $1 AND state = 'abandoned'", [intentId]), 1);
    assert.equal(await count("SELECT 1 FROM trustwork.job WHERE kind = 'assistant.reconcile' AND payload ->> 'intentId' = $1", [intentId]), 1);
    // The dispatcher's own result is refused: only a provider lookup (reconciliation) decides the outcome.
    const attemptId = (target as { attemptId: string }).attemptId;
    await assert.rejects(inTransaction(pool, (trx) => assistantWorker.recordOutcome(trx, attemptId, { kind: 'final', result: 'succeeded', providerReference: 'pub-1', evidence: 'Synthetic' })), (e: { hint?: string }) => e.hint === 'assistant.fenced_out');
    await release(world, id);
  });

  await t.test('concurrency: an engagement and a dispatch serialize on the epochs; nothing is left executing', async () => {
    const capabilities = ['project_planner.revoke_share', 'project_planner.record_change', 'project_planner.add_diary_entry'];
    const outcomes: string[] = [];
    for (const capabilityId of capabilities) {
      const queued = await propose(capabilityId);
      assert.equal(queued.state, 'queued', JSON.stringify(queued));
      const intentId = (queued as { intentId: string }).intentId;
      const job = await leaseFor(intentId);
      const [dispatch, engaged] = await Promise.all([
        inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, intentId, job.id, hubId, job.fencing_token)),
        engage(world, 'agent_capability', { capabilityId }),
      ]);
      const state = (await intent(intentId)).state;
      outcomes.push(`${dispatch.status}:${state}`);
      assert.ok((dispatch.status === 'refused' && state === 'revoked') || (dispatch.status === 'dispatch' && state === 'outcome_unknown'), `${dispatch.status} then ${state}`);
      await release(world, engaged);
    }
    assert.equal(outcomes.length, capabilities.length);
  });

  await t.test('parity: a capability off for the hub, a participant type or a plan, or paused, is refused alike by the interface, the agent runtime and MCP', async () => {
    const mandateRow = (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.mandate WHERE id = $1', [actionMandate])).rows[0]!;
    const connection: ExternalConnection = {
      id: connectionId, hubId, owner: { kind: 'person', personId: petrId }, protocol: 'mcp', clientId: 'synthetic-client-agt3', clientNameSelfAsserted: 'Synthetic desktop assistant', listedByHub: false,
      scopes: ['read.public', 'read.me', 'read.private', 'propose', 'act'], privateDataClasses: ['private_projects', 'budgets'], mandateBindings: [{ mandateId: actionMandate, revision: mandateRow.revision }],
      rateLimitProfile: 'standard', consent: { via: 'first_party_form', personId: petrId, at: new Date().toISOString(), stepUp: true }, status: 'active', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, revision: 1,
    };
    const token = await installSyntheticMcpToken(h, connectionId, connection.scopes);
    const capability = PLANNER.capabilities.find((c) => c.id === PLANNER_COMMIT)!;
    const narrowToken = await installSyntheticMcpToken(h, connectionId, ['read.public']);
    for (const proof of [null, narrowToken, { ...token, accessTokenHash: Buffer.alloc(32) }, { ...token, dpopJkt: 'a'.repeat(43) }]) {
      assert.equal((await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), trx => mcpGate(authority, trx, connection, capability, null, proof))).decision, 'deny',
        'a snapshot with broad consent cannot enlarge a missing, narrower, unknown or differently bound token');
    }
    assert.equal((await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), trx => mcpGate(authority, trx, { ...connection, mandateBindings: [] }, capability, null, token))).decision, 'deny');
    for (const forged of [
      { ...connection, hubId: randomUUID() },
      { ...connection, owner: { kind: 'person' as const, personId: seed.people.carl } },
      { ...connection, revision: connection.revision + 1 },
    ]) {
      const d: Awaited<ReturnType<typeof mcpGate>> = await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), trx => mcpGate(authority, trx, forged, capability, null, token));
      assert.equal(d.decision, 'deny', 'a forged connection field cannot choose authority');
    }
    assert.equal((await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), trx =>
      mcpGate(authority, trx, connection, capability, null, { ...token, audience: 'https://forged.example.invalid/mcp' }))).decision, 'deny');
    const surfaces = async () => {
      const ui = await petr.get(`/v1/assistant/capabilities/${PLANNER_COMMIT}`);
      const uiReason = ui.status === 200 ? null : [(ui.body as { details: { reason: string; messageKey: string } }).details.reason, (ui.body as { details: { messageKey: string } }).details.messageKey];
      const action = await propose(PLANNER_COMMIT);
      const gate = await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), (trx) => agentRuntimeGate(authority)(trx, {
        hubId, personId: petrId, mandate: { onBehalfCompanyId: null, granteeKind: 'own_agent', granteeCompanyId: null }, capabilityId: PLANNER_COMMIT, action: 'publish',
      }));
      const runtimeReason = action.state === 'denied' ? [action.reason, gate?.messageKey] : null;
      const mcp = await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), (trx) => mcpGate(authority, trx, connection, capability, null, token));
      const mcpReason = mcp.decision === 'deny' ? [mcp.reason, mcp.messageKey] : null;
      return { ui: uiReason, runtime: runtimeReason, mcp: mcpReason, mcpDecision: mcp.decision };
    };
    const allowed = await surfaces();
    assert.deepEqual([allowed.ui, allowed.runtime, allowed.mcp, allowed.mcpDecision], [null, null, null, 'execute_under_mandate']);
    for (const [label, s, reason, key] of [
      ['hub', { capabilityId: PLANNER_COMMIT, offForHub: true, offForPrincipalKinds: [], offForPlans: [] }, 'capability.off_for_hub', 'agentModules.refusal.offForHub'],
      ['participant type', { capabilityId: PLANNER_COMMIT, offForHub: false, offForPrincipalKinds: ['person' as const], offForPlans: [] }, 'capability.off_for_principal_kind', 'agentModules.refusal.offForPrincipalKind'],
      ['plan', { capabilityId: PLANNER_COMMIT, offForHub: false, offForPrincipalKinds: [], offForPlans: ['free'] }, 'capability.off_for_plan', 'agentModules.refusal.offForPlan'],
    ] as const) {
      await activatePolicy(h, world, usHubPolicy(hubId));
      const queued = await propose(PLANNER_COMMIT);
      assert.equal(queued.state, 'queued');
      const intentId = (queued as { intentId: string }).intentId;
      const job = await leaseFor(intentId);
      await activatePolicy(h, world, withSwitch(usHubPolicy(hubId), { ...s, offForPrincipalKinds: [...s.offForPrincipalKinds], offForPlans: [...s.offForPlans] }));
      assert.deepEqual(await inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, intentId, job.id, hubId, job.fencing_token)), { status: 'refused', reason: 'capability_off' }, `${label}: queued actions recheck the new policy`);
      const r = await surfaces();
      assert.deepEqual(r.ui, [reason, key], `${label}: interface`);
      assert.deepEqual(r.runtime, r.ui, `${label}: agent runtime`);
      assert.deepEqual(r.mcp, r.ui, `${label}: MCP`);
    }
    // A plan the entitlement port (AGT-004) resolves differently is not affected by a free-plan switch.
    const pro = new CapabilityAuthority({ hubId, entitlements: new FixedEntitlements(new Map([[petrId, 'pro']])) });
    assert.equal((await withPrincipal(h.pool, await principalFor(h.db.admin, petrId), (trx) => pro.check(trx, actor, PLANNER_COMMIT, 'publish'))).allowed, true);
    await activatePolicy(h, world, usHubPolicy(hubId));
    const id = await engage(world, 'agent_capability', { capabilityId: PLANNER_COMMIT });
    const paused = await surfaces();
    assert.deepEqual(paused.ui, ['kill_switch', 'agentModules.refusal.paused']);
    assert.deepEqual(paused.runtime, paused.ui);
    assert.deepEqual(paused.mcp, paused.ui);
    await release(world, id);
  });

  await t.test('the person\'s stop and a revoked connection stop dispatch and fence what executes; the node switch stops everything', async () => {
    actionMandate = await newMandate();
    const queued = await propose(PLANNER_COMMIT);
    const intentId = (queued as { intentId: string }).intentId;
    const job = await leaseFor(intentId);
    assert.equal((await inTransaction(pool, (trx) => assistantWorker.beginAttempt(trx, intentId, job.id, hubId, job.fencing_token))).status, 'dispatch');
    h.clock.advance(1000);
    ok(await petr.post('/v1/assistant/stop'));
    assert.equal((await intent(intentId)).state, 'outcome_unknown', 'the stop fences the executing action');
    assert.deepEqual(await check().then((d) => (d.allowed ? null : d.blockedBy?.kind)), 'person_stop');
    ok(await petr.post('/v1/assistant/stop/release'));
    assert.equal((await check()).allowed, true);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('connection').set({ status: 'revoked', status_reason: 'person_revocation', revoked_at: new Date() }).where('id', '=', connectionId).execute());
    assert.deepEqual(await check({ connectionId }).then((d) => (d.allowed ? null : d.blockedBy?.kind)), 'connection');
    await engageNode(h, world);
    assert.deepEqual(await check().then((d) => (d.allowed ? null : d.blockedBy?.kind)), 'node');
    assert.ok(Number((await h.db.admin.query("SELECT epoch FROM trustwork.agent_authz_epoch WHERE scope_kind = 'node' AND scope_id = $1", [world.w.nodeId])).rows[0].epoch) >= 2);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { randomUUID } from 'node:crypto';
import { ConsoleCommandResultSchema } from '@trustwork/contracts';
import { AgentPolicyDocumentSchema, type AgentPolicyDocument, type PolicyPreview } from '../../packages/contracts/src/agent-modules.js';
import { agentPolicies } from '../../packages/data/src/repositories/agent-modules.js';
import { agentProtectionLimits, CapabilityAuthority } from '../../apps/api/src/modules/agent-modules/authority.js';
import { principalFor } from '../data/helpers/seed.js';
import { Client, SKIP_REASON, startHarness, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { addLogins, expectRefusal, signIn } from '../admin/helpers.js';
import { rejects, US_HUB } from '../hubs/helpers.js';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS } from '../../apps/api/src/modules/assistant/assistant.service.js';
import { assistantPolicySettings } from '../../apps/api/src/modules/assistant/assistant.module.js';
import { UnavailableModel, UnavailableRetrieval } from '../../apps/api/src/modules/assistant/ports.js';
import { stateOf } from '../assistant/helpers.js';
import { PLANNER_COMMIT, PROFILE, usHubPolicy, withSwitch } from './fixtures.js';
import { buildAgentWorld, command, documentFor, ok, type AgentWorld } from './helpers.js';

/**
 * AGT-003 administration through the HTTP API on real PostgreSQL under the runtime role: the hub agent policy is drafted
 * with a stored preview, activated by a second person, refused when it widens a manifest or touches a guard rail, and
 * refused at activation when its preview went stale or AGT-003 never validated it; agent kill switches engage at once and
 * release through a second person; and no staff route or database path reads one participant's agent.
 */
const h = await startHarness('agent_modules_policy');

interface VersionView { versionId: string; version: number; status: string; revision: number; preview: PolicyPreview; document: AgentPolicyDocument; activation: { secondPersonAction: string; actionDigest: string } }
type CommandBody = { result: { outcome: string; approvalRequestId: string | null; objectId: string; revision: number } };

test('agent product administration: policy versions with previews, second person, guard rails, kill switches, no per-person access', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const world: AgentWorld = await buildAgentWorld(h);
  const { staff, hubId, w } = world;
  const seed = await seedPersonas(h);
  const petr = h.client();
  await login(petr, 'petr');
  const base = `/v1/admin/agent-modules/${hubId}`;
  const draft = async (doc = usHubPolicy(hubId), by: Client = staff.owner) => ok<CommandBody & { version: VersionView }>(await command(by, `${base}/policy`, { document: doc }), 201);
  /** Officer asks, owner approves the digest shown with the version, officer activates. */
  const activate = async (v: VersionView): Promise<Response> => {
    const pending = ok<CommandBody>(await command(staff.officer, `${base}/policy/${v.versionId}/activate`, { expectedRevision: v.revision, approvalId: null }));
    assert.equal(pending.result.outcome, 'pending_second_person');
    const approvalId = pending.result.approvalRequestId as string;
    ok(await command(staff.owner, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: v.activation.actionDigest }));
    return command(staff.officer, `${base}/policy/${v.versionId}/activate`, { expectedRevision: v.revision, approvalId });
  };

  await t.test('negative: anonymous, participants, unelevated staff and staff without agent permissions never reach the controls', async () => {
    expectRefusal(await new Client(h.created).get(`${base}/policy`), 401, 'auth.session_invalid');
    expectRefusal(await petr.get(`${base}/policy`), 403, 'access.forbidden', 'staff');
    expectRefusal(await command(petr, `${base}/policy`, { document: usHubPolicy(hubId) }), 403, 'access.forbidden', 'staff');
    expectRefusal(await staff.moderator.get(`${base}/policy`), 404, 'access.not_found');
    expectRefusal(await command(staff.moderator, `${base}/policy`, { document: usHubPolicy(hubId) }), 403, 'access.forbidden');
    expectRefusal(await command(staff.moderator, `${base}/kill-switches`, { scope: { kind: 'hub_agent_dispatch' } }), 403, 'access.forbidden');
  });

  await t.test('a policy that widens a manifest or touches a guard rail is refused, at the API and in the database', async () => {
    const doc = usHubPolicy(hubId);
    const widened = { ...doc, modules: [{ ...doc.modules[0]!, actions: [...doc.modules[0]!.actions, 'place_order' as const] }, doc.modules[1]!] };
    expectRefusal(await command(staff.owner, `${base}/policy`, { document: widened }), 422, 'validation.schema', 'widening');
    const guard = { ...doc, policy: { ...doc.policy, enabledModules: doc.policy.enabledModules.map((e) => ({ ...e, settings: { skipConfirmations: true } })) } };
    expectRefusal(await command(staff.owner, `${base}/policy`, { document: guard }), 422, 'validation.schema', 'guard_rail');
    expectRefusal(await command(staff.owner, `${base}/policy`, { document: { ...doc, sanctionsGate: 'off' } }), 422, 'validation.unknown_field');
    // The database repeats the guard rails for any writer that bypasses the API.
    const document = await documentFor(h, hubId, guard);
    await rejects(world.a.cmd(w.people.owner, (trx, ctx) => agentPolicies.recordDraft(trx, ctx, hubId, '00000000-0000-4000-8000-000000000001', document)), '23514', 'agents.guard_rail');
    const noFloor = await documentFor(h, hubId, { ...doc, policy: { ...doc.policy, forbiddenPreAuthorization: [] } });
    await rejects(world.a.cmd(w.people.owner, (trx, ctx) => agentPolicies.recordDraft(trx, ctx, hubId, '00000000-0000-4000-8000-000000000002', noFloor)), '23514', 'agents.guard_rail');
    // A preview the database does not recognise (wrong counts or base) is refused at draft time.
    const forged = { ...(await documentFor(h, hubId, doc)), preview: { ...(await documentFor(h, hubId, doc)).preview, baseVersionId: '00000000-0000-4000-8000-0000000000aa' } };
    await rejects(world.a.cmd(w.people.owner, (trx, ctx) => agentPolicies.recordDraft(trx, ctx, hubId, '00000000-0000-4000-8000-000000000003', forged)), '23514', 'agents.preview_stale');
  });

  let first: VersionView;
  await t.test('drafting stores the preview inside the payload; the version view shows the digest the second person approves', async () => {
    const before = await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_policy_version');
    const preview = ok<{ preview: PolicyPreview }>(await staff.owner.post(`${base}/policy/preview`, { document: usHubPolicy(hubId) }));
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.agent_policy_version')).rows[0].n, before.rows[0].n, 'a preview stores nothing');
    assert.ok(preview.preview.narrowedModuleKeys.includes('task_marketplace'), 'modules the hub leaves out are narrowed from the engine default');
    const drafted = await draft();
    ConsoleCommandResultSchema.parse(drafted.result);
    first = drafted.version;
    assert.equal(first.status, 'draft');
    assert.equal(first.preview.baseVersionId, null);
    assert.deepEqual(first.preview.affected, { mandates: null, jobSubscriptions: null, connections: null, openRuns: null }, 'fewer than 10 is never a number');
    assert.deepEqual(AgentPolicyDocumentSchema.parse(first.document).preview, first.preview);
    const view = ok<VersionView>(await staff.officer.get(`${base}/policy/${first.versionId}`));
    assert.equal(view.activation.secondPersonAction, 'agents.enable_commitment_module');
    assert.deepEqual(view.preview, first.preview, 'the approver sees the stored preview');
    const payload = (await h.db.admin.query<{ payload: AgentPolicyDocument }>('SELECT payload FROM trustwork.hub_config_version WHERE id = $1', [first.versionId])).rows[0]!.payload;
    assert.deepEqual(payload.preview, first.preview, 'the preview is part of the payload the approval digest covers');
    const audit = await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action = 'agents.policy_drafted' AND object_id = $1", [first.versionId]);
    assert.equal(audit.rows[0].n, 1);
  });

  await t.test('activation needs a second person and then changes what participants\' agents can do', async () => {
    expectRefusal(await command(staff.owner, `${base}/policy/${first.versionId}/activate`, { expectedRevision: first.revision, approvalId: null }), 403, 'access.second_approver_required', 'self_approval');
    const applied = ok<CommandBody>(await activate(first));
    assert.equal(applied.result.outcome, 'applied');
    const current = ok<{ current: { versionId: string } | null }>(await staff.owner.get(`${base}/policy`));
    assert.equal(current.current?.versionId, first.versionId);
    const caps = ok<{ capabilities: { capabilityId: string; labelKey: string; available: boolean; reason: string | null }[] }>(await petr.get('/v1/assistant/capabilities'));
    assert.equal(caps.capabilities.find((c) => c.capabilityId === PLANNER_COMMIT)?.available, true);
    assert.deepEqual(caps.capabilities.find((c) => c.capabilityId === 'task_marketplace.publish_request'), { capabilityId: 'task_marketplace.publish_request', moduleKey: 'task_marketplace', labelKey: caps.capabilities.find((c) => c.capabilityId === 'task_marketplace.publish_request')!.labelKey, available: false, reason: 'agentModules.refusal.moduleNotEnabled' });
    // AGT-001's agent-to-agent work takes its protection limits from the active policy.
    const limits = await withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => agentProtectionLimits(new CapabilityAuthority({ hubId }))(trx));
    assert.deepEqual(limits, { maxNegotiationRounds: 5, envelopesPerCounterpartyPerDay: 15 }, 'the hub policy, not the engine settings');
    assert.equal(await withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => agentProtectionLimits(new CapabilityAuthority({ hubId: null }))(trx)), null);
    const bounds = ok<{ versionId: string; participantSettings: { outreachPerWeek: { max: number } } }>(await petr.get('/v1/assistant/agent-settings/bounds'));
    assert.equal(bounds.versionId, first.versionId);
    assert.equal(bounds.participantSettings.outreachPerWeek.max, 10);
  });

  await t.test('activation with a stale preview fails: another version activated meanwhile, or the affected cohort changed', async () => {
    const a = (await draft(withSwitch(usHubPolicy(hubId), { capabilityId: PLANNER_COMMIT, offForHub: true, offForPrincipalKinds: [], offForPlans: [] }))).version;
    const b = (await draft(usHubPolicy(hubId, { participantSettings: { ...usHubPolicy(hubId).participantSettings, outreachPerWeek: { default: 3, max: 8 } } }))).version;
    assert.equal(a.preview.baseVersionId, first.versionId);
    ok(await activate(a));
    expectRefusal(await activate(b), 409, 'validation.revision_conflict', 'preview_stale');
    assert.equal((await h.db.admin.query<{ status: string }>('SELECT status FROM trustwork.hub_config_version WHERE id = $1', [b.versionId])).rows[0]!.status, 'draft', 'nothing changed');
    // Disabling the profile keeper with no affected mandates, then ten distinct principals gain mandates: the counts the
    // approver saw ("fewer than 10") no longer hold.
    const disable = usHubPolicy(hubId);
    const c = (await draft({ ...disable, policy: { ...disable.policy, enabledModules: disable.policy.enabledModules.filter((e) => e.moduleKey !== PROFILE.key) }, modules: [disable.modules[0]!] })).version;
    assert.ok(c.preview.narrowedModuleKeys.includes(PROFILE.key));
    assert.equal(c.preview.affected.mandates, null);
    h.clock.advance(1000);
    const pc = h.client();
    await login(pc, 'petr');
    for (let i = 0; i < 10; i++) {
      ok(await pc.post('/v1/assistant/mandates', { draft: {
        onBehalfOf: null, grantee: { kind: 'own_agent' }, moduleKeys: [PROFILE.key], actions: ['maintain_profile'], contexts: [{ kind: 'profile', id: seed.people.petr }],
        limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'ask_each' }, approvers: [],
        escalation: { kind: 'ask_principal' }, validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      } }), 201);
    }
    const small = ok<{ preview: PolicyPreview }>(await staff.owner.post(`${base}/policy/preview`, { document: disable }));
    assert.equal(small.preview.affected.mandates, null);
    const ownCounts = await world.a.cmd(w.people.owner, (trx) => agentPolicies.previewCounts(trx, hubId, [PROFILE.key]));
    assert.equal(ownCounts.mandates, null, 'ten mandates of one person never form a publishable cohort');
    // Counts remain suppressed, but changed proven attribution still invalidates the approved snapshot.
    expectRefusal(await activate(c), 409, 'validation.revision_conflict', 'preview_stale');
    const cohort = await withMaintenance(h.db.admin, async (trx) => {
      const people: [string, string][] = [];
      for (let i = 0; i < 9; i++) {
        const person = await trx.insertInto('person').values({ display_name: `Synthetic cohort ${i}` }).returning('id').executeTakeFirstOrThrow();
        people.push([person.id, `synthetic-cohort-${i}@example.invalid`]);
      }
      return people;
    });
    await addLogins(h, cohort);
    for (const [personId, email] of cohort) {
      const person = h.client();
      await signIn(person, email);
      ok(await person.post('/v1/assistant/mandates', { draft: {
        onBehalfOf: null, grantee: { kind: 'own_agent' }, moduleKeys: [PROFILE.key], actions: ['maintain_profile'], contexts: [{ kind: 'profile', id: personId }],
        limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'ask_each' }, approvers: [],
        escalation: { kind: 'ask_principal' }, validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      } }), 201);
    }
    // Drafted again, the preview shows the cohort and activates.
    const again = (await draft({ ...disable, policy: { ...disable.policy, enabledModules: disable.policy.enabledModules.filter((e) => e.moduleKey !== PROFILE.key) }, modules: [disable.modules[0]!] })).version;
    assert.equal(again.preview.affected.mandates, 19);
    ok(await activate(again));
    // Back to the reference policy for the rest of the suite.
    ok(await activate((await draft()).version));
  });

  await t.test('hub B previews exclude proven hub A mandates; unproven legacy authority is unavailable', async () => {
    const otherHub = (await world.a.createHub(`synthetic-preview-b-${randomUUID().slice(0, 8)}`, US_HUB)).hub_id;
    await world.a.assignSensitive({ personId: w.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId: otherHub } });
    const a = await world.a.cmd(w.people.owner, (trx) => agentPolicies.previewSnapshot(trx, hubId, [PROFILE.key]));
    const b = await world.a.cmd(w.people.owner, (trx) => agentPolicies.previewSnapshot(trx, otherHub, [PROFILE.key]));
    assert.equal(a.affected.mandates, 19);
    assert.deepEqual(b.affected, { mandates: null, jobSubscriptions: null, connections: null, openRuns: null });
    assert.notEqual(a.attributionDigest, b.attributionDigest);
    const unbound = new AssistantService({ ...h.created.ctx!, config: { ...h.created.config, publicOrigin: 'https://synthetic-unregistered.example.invalid' } },
      h.services().principals, assistantPolicySettings({ hubId: null }), DEFAULT_RUNTIME_SETTINGS, new UnavailableModel(), new UnavailableRetrieval());
    const legacy = await unbound.createMandate({ draft: {
      onBehalfOf: null, grantee: { kind: 'own_agent' }, moduleKeys: [PROFILE.key], actions: ['maintain_profile'], contexts: [{ kind: 'profile', id: seed.people.petr }],
      limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'ask_each' }, approvers: [],
      escalation: { kind: 'ask_principal' }, validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    } }, await stateOf(h, petr, `unbound-confirm-${randomUUID()}`));
    await assert.rejects(world.a.cmd(w.people.owner, (trx) => agentPolicies.previewSnapshot(trx, hubId, [PROFILE.key])),
      (error: unknown) => (error as { hint?: string }).hint === 'agents.attribution_unavailable');
    assert.equal((await h.db.admin.query('SELECT mandate_id FROM trustwork.agent_mandate_provenance WHERE mandate_id = $1', [legacy.id])).rowCount, 0);
    ok(await petr.post(`/v1/assistant/mandates/${legacy.id}/revoke`, { expectedRevision: legacy.revision, reason: 'Synthetic unknown attribution retired' }));
    assert.equal((await world.a.cmd(w.people.owner, (trx) => agentPolicies.previewSnapshot(trx, hubId, [PROFILE.key]))).affected.mandates, 19);
  });

  await t.test('an agents version drafted around AGT-003 (the generic configuration route) never activates', async () => {
    // A well-formed document with a preview copied from a validated draft: the generic route accepts the shape, but
    // AGT-003 never recorded it, so its activation is refused.
    const shaped = await documentFor(h, hubId, usHubPolicy(hubId));
    const generic = ok<{ version: { id: string; revision: number; activation: { actionDigest: string } } }>(await command(staff.owner, `/v1/admin/hubs/${hubId}/config`, { domain: 'agents', payload: shaped }), 201).version;
    expectRefusal(await command(staff.owner, `/v1/admin/hubs/${hubId}/config`, { domain: 'agents', payload: { allowAllClasses: true } }), 422, 'validation.schema', 'payload_invalid');
    const pending = ok<CommandBody>(await command(staff.officer, `/v1/admin/hubs/${hubId}/config/${generic.id}/activate`, { expectedRevision: generic.revision, approvalId: null }));
    ok(await command(staff.owner, `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: generic.activation.actionDigest }));
    expectRefusal(await command(staff.officer, `/v1/admin/hubs/${hubId}/config/${generic.id}/activate`, { expectedRevision: generic.revision, approvalId: pending.result.approvalRequestId }), 422, 'validation.schema', 'policy_unvalidated');
  });

  await t.test('agent kill switches: engaging is one person and immediate, releasing needs a second person and a note', async () => {
    const engaged = ok<CommandBody & { killSwitch: { id: string; scopeKind: string; capabilityId: string } }>(await command(staff.owner, `${base}/kill-switches`, { scope: { kind: 'agent_capability', capabilityId: PLANNER_COMMIT } }), 201);
    assert.equal(engaged.killSwitch.scopeKind, 'agent_capability');
    const refused = await petr.get(`/v1/assistant/capabilities/${PLANNER_COMMIT}`);
    expectRefusal(refused, 403, 'access.forbidden', 'kill_switch');
    assert.equal((refused.body as { details: { messageKey: string } }).details.messageKey, 'agentModules.refusal.paused');
    expectRefusal(await command(staff.owner, `${base}/kill-switches`, { scope: { kind: 'agent_capability', capabilityId: PLANNER_COMMIT } }), 409, 'validation.revision_conflict');
    const list = ok<{ killSwitches: { id: string }[] }>(await staff.officer.get(`${base}/kill-switches`));
    assert.ok(list.killSwitches.some((k) => k.id === engaged.killSwitch.id));
    const url = `${base}/kill-switches/${engaged.killSwitch.id}/release`;
    const pending = ok<CommandBody>(await command(staff.officer, url, { incidentNote: 'Synthetic incident resolved', approvalId: null }));
    assert.equal(pending.result.outcome, 'pending_second_person');
    expectRefusal(await command(staff.officer, `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: 'f'.repeat(64) }), 403, 'access.second_approver_required');
    const digest = (await h.db.admin.query<{ action_digest: string }>('SELECT action_digest FROM trustwork.second_person_approval WHERE id = $1', [pending.result.approvalRequestId])).rows[0]!.action_digest;
    ok(await command(staff.owner, `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: digest }));
    const released = ok<CommandBody & { killSwitch: { state: string } }>(await command(staff.officer, url, { incidentNote: 'Synthetic incident resolved', approvalId: pending.result.approvalRequestId }));
    assert.equal(released.killSwitch.state, 'released');
    ok(await petr.get(`/v1/assistant/capabilities/${PLANNER_COMMIT}`));
  });

  await t.test('no staff endpoint or database path reads or changes one participant\'s agent, mandates, settings, goals, job subscriptions or connections', async () => {
    // Routes: no admin route of the whole API names a participant's agent objects.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])).filter((p) => /controllers?\.ts$/.test(p));
    const adminRoutes: string[] = [];
    for (const file of files('apps/api/src')) {
      const text = readFileSync(file, 'utf8');
      for (const block of text.split(/@Controller\(/).slice(1)) {
        const prefix = /^'([^']*)'/.exec(block)?.[1] ?? '';
        const own = block.split(/\n@Controller/)[0] ?? block;
        if (!prefix.startsWith('v1/admin')) continue;
        for (const m of own.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)) adminRoutes.push(`${prefix}/${m[2]}`);
        adminRoutes.push(prefix);
      }
    }
    assert.ok(adminRoutes.length > 30, 'the inventory found the admin routes');
    // KEYS-001 owns hub provider connections, not a participant's external AI connection. Keep the exception exact;
    // a new participant-shaped route must still fail this inventory and the real RLS checks below.
    const providerConnections = new Set(['', '/:connectionId', '/:connectionId/update', '/:connectionId/secret', '/:connectionId/secret/revoke',
      '/:connectionId/test', '/:connectionId/enable', '/:connectionId/disable'].map((suffix) => `v1/admin/hubs/:hubId/providers/connections${suffix}`));
    for (const route of adminRoutes) if (!providerConnections.has(route)) assert.doesNotMatch(route, /mandate|goal|job|connection|agent-settings|conversation|assistant/i, route);
    // Staff with every agent product permission, elevated, see only their own agent objects through participant routes.
    for (const path of ['/v1/assistant/jobs', '/v1/assistant/mandates', '/v1/assistant/goals', '/v1/assistant/job-subscriptions', '/v1/assistant/mandate-proposals']) {
      const body = ok<Record<string, unknown[]>>(await staff.owner.get(path));
      for (const list of Object.values(body)) if (Array.isArray(list)) assert.equal(list.length, 0, `${path} shows nobody else's objects`);
    }
    // In the database, under the runtime role, staff read none of petr's rows; the preview function is staff-only and counts.
    const ownerPrincipal = await principalFor(h.db.admin, w.people.owner);
    for (const table of ['mandate', 'mandate_proposal', 'goal', 'job_subscription', 'agent_job_request', 'agent_job_schedule', 'agent_job_fire', 'agent_job_deadline', 'connection', 'action_intent', 'run', 'agent_authz_epoch']) {
      const visible: number = await withPrincipal(h.pool, ownerPrincipal, async (trx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(`trustwork.${table}`)}`.execute(trx)).rows[0]!.n))
        .catch((error: { code?: string }) => {
          assert.equal(error.code, '42501', `${table}: only a permission refusal may replace a count`);
          return 0;
        });
      assert.equal(visible, 0, `staff read no participant rows of ${table}`);
    }
    assert.ok(Number((await h.db.admin.query('SELECT count(*) AS n FROM trustwork.mandate WHERE principal_person_id = $1', [seed.people.petr])).rows[0].n) >= 10, 'the rows exist');
    await rejects(withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => sql`SELECT trustwork.agent_modules_preview_counts(${hubId}::uuid, ARRAY['profile_keeper']::text[])`.execute(trx)), '42501', 'admin.forbidden');
    await rejects(withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => sql`SELECT trustwork.agent_modules_affected(ARRAY['profile_keeper']::text[])`.execute(trx)), '42501');
    // Policy versions are staff-only; participants read the current product policy (it names nobody).
    const asPetr = await principalFor(h.db.admin, seed.people.petr);
    assert.equal((await withPrincipal(h.pool, asPetr, (trx) => agentPolicies.versions(trx, hubId))).length, 0);
    assert.ok(await withPrincipal(h.pool, asPetr, (trx) => agentPolicies.current(trx, hubId)));
  });
});

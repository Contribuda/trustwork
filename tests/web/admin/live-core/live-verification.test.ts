import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { createApp, type CreatedApp } from '../../../../apps/api/src/app.js';
import { VERIFICATION_CHECK_TYPES as API_CHECKS, VERIFICATION_LEGAL_BASES as API_BASES, VERIFICATION_TRIGGERS as API_TRIGGERS } from '../../../../apps/api/src/modules/verification/commands.js';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
import type { CommandInput } from '../../../../apps/web/app/admin/_data/commands.js';
import { verificationCommand } from '../../../../apps/web/app/admin/_data/live-verification.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { VERIFICATION_CHECK_TYPES, VERIFICATION_LEGAL_BASES, VERIFICATION_TRIGGERS } from '../../../../apps/web/app/admin/hubs/[hub]/participants/verification/_commands.js';
import { staffRoleDefinitions } from '../../../../packages/data/src/repositories/admin.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../../../backend/helpers/app.js';
import { codeNow } from '../../../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';
import { actors, buildHubWorld, syncKernel, type HubWorld } from '../../../hubs/helpers.js';

/**
 * HC-23 Verification through the console's live adapter on the real API and PostgreSQL: runtime role, real sessions, TOTP
 * and elevated sessions. Every negative case runs twice where it matters: the console's own check, and the API with the
 * console's check stepped over, because the page is never the authority. Every person, hub and company is synthetic.
 */
const h = await startHarness('console_live_verification');
const SLUG = 'synthetic-live-verification';
type Who = 'owner' | 'officer' | 'moderator' | 'otherOwner' | 'outsider';
const WHO: Who[] = ['owner', 'officer', 'moderator', 'otherOwner', 'outsider'];
const emailOf = (key: Who) => `live-verification-${key.toLowerCase()}@example.invalid`;

class Failure extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`API ${status} ${code ?? ''}`);
  }
}

function apiOf(client: Client): ConsoleApi {
  return {
    async get(path) {
      const r = await client.get(path);
      if (r.status >= 200 && r.status < 300) return r.body;
      const code = (r.body as { code?: string } | null)?.code ?? null;
      if (r.status === 404 && code === 'access.not_found') return null;
      throw new Failure(r.status, code);
    },
    async post(path, body, key) {
      const r = await client.post(path, body, { idempotencyKey: key });
      return { status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body };
    },
  };
}

function apiFor(harness: Harness, hubId: string): Promise<CreatedApp> {
  return createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: hubId,
      MAIL_SECRET_KEY: randomBytes(32).toString('hex'),
    },
    pool: harness.pool, clock: harness.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

test('the console vocabularies equal the API vocabularies', () => {
  assert.deepEqual([...VERIFICATION_CHECK_TYPES], [...API_CHECKS]);
  assert.deepEqual([...VERIFICATION_TRIGGERS], [...API_TRIGGERS]);
  assert.deepEqual([...VERIFICATION_LEGAL_BASES], [...API_BASES]);
});

test('HC-23 Verification through the live adapter', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w: HubWorld = await buildHubWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  await withMaintenance(h.db.admin, async (trx) => {
    const release = (role: 'trust-reviewer' | 'support-agent', permissions: string[]) => staffRoleDefinitions.release(trx, { version: 1, role, scopes: ['hub'], permissions: permissions as never,
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await release('trust-reviewer', ['admin.hub.read', 'admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.providers.toggle']);
    await release('support-agent', ['admin.hub.read', 'admin.claims.read']);
  });
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub(SLUG)).hub_id;
  const otherHubId = (await a.createHub('synthetic-live-verification-other')).hub_id;
  const scope = { kind: 'hub' as const, hubId };
  await a.assignSensitive({ personId: w.people.owner, role: 'hub-owner', scope });
  await a.assignSensitive({ personId: w.people.officer, role: 'compliance-officer', scope });
  await a.assign({ personId: w.people.owner, role: 'trust-reviewer', scope });
  await a.assign({ personId: w.people.officer, role: 'trust-reviewer', scope });
  await a.assign({ personId: w.people.moderator, role: 'support-agent', scope });
  await a.assign({ personId: w.people.otherOwner, role: 'trust-reviewer', scope: { kind: 'hub', hubId: otherHubId } });
  await addLogins(h, WHO.map((k) => [w.people[k], emailOf(k)]));
  const app = await apiFor(h, hubId);
  t.after(async () => { await app.close(); await h.close(); });

  // A second session of the owner, signed in before the second factor exists, that never elevates.
  const unelevated = new Client(app);
  await signIn(unelevated, emailOf('owner'));
  const clients = {} as Record<Who, Client>;
  const secrets = {} as Partial<Record<Who, Buffer>>;
  for (const key of WHO) {
    clients[key] = new Client(app);
    await signIn(clients[key], emailOf(key));
    if (key !== 'outsider') secrets[key] = await enrolNow(h, clients[key]);
  }
  const elevate = async (key: Who) => {
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]!) } }, { idempotencyKey: null });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const staffPost = (key: Who, url: string, body: Record<string, unknown> = {}): Promise<Response> => {
    const idempotencyKey = `live-${randomUUID()}`;
    return clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic verification check', ...body }, { idempotencyKey });
  };
  const portOf = (key: Who) => createApiConsolePort({ api: apiOf(clients[key]), siteHost: () => 'live-verification.example.org', engineVersion: '0.1.0', now: () => h.clock.now() });
  const live = { demo: false } as const;
  const run = (key: Who, command: CommandInput['command'], fields: Record<string, string> = {}, reason = 'Synthetic verification check') =>
    portOf(key).command(live, { command, hubSlug: SLUG, setupToken: null, reason, expectedRevision: null, fields });
  /** The API with the console's own checks stepped over: what a crafted request gets. */
  const direct = (key: Who, command: Parameters<typeof verificationCommand>[0], fields: Record<string, string>) => verificationCommand(command, fields, {
    hubId, viewerId: w.people[key],
    send: (path, rest) => staffPost(key, path, rest).then((r) => ({ status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body })),
    saveConfig: async () => ({ status: 'applied' }),
    read: () => portOf('owner').verification(hubId),
  });
  const recipeFields = { key: 'company-verified', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: '12', categories: 'register_record_matches, sanctions_screening_clear', 'step.register_match': 'required', 'step.officer_match': 'any', 'step.signed_authority': 'any' };
  const view = async (key: Who = 'owner') => {
    const v = await portOf(key).verification(hubId);
    assert.ok(v, 'the section reads');
    return v;
  };
  const gate = async () => {
    const checklist = (await clients.owner.get(`/v1/admin/hubs/${hubId}/launch`)).body as { gates: Array<{ gate: string; engineConfirms: boolean }> };
    return checklist.gates.find((g) => g.gate === 'verification_recipe_enabled')?.engineConfirms;
  };

  // A role at another hub makes nobody staff of this deployment, so that person cannot even elevate here.
  for (const key of ['owner', 'officer', 'moderator'] as const) await elevate(key);
  const modes = await staffPost('owner', `/v1/admin/hubs/${hubId}/config`, { domain: 'modes', payload: HUBS[0]!.modes });
  assert.equal(modes.status, 201, JSON.stringify(modes.body));
  const modesVersion = (modes.body as { version: { id: string; revision: number } }).version;
  assert.equal((await staffPost('owner', `/v1/admin/hubs/${hubId}/config/${modesVersion.id}/activate`, { expectedRevision: modesVersion.revision, approvalId: null })).status, 200);

  await t.test('who reads: staff of the hub with a claims permission; no one else', async () => {
    const empty = await view('moderator');
    assert.deepEqual([empty.recipes, empty.providers], [[], []]);
    assert.equal(empty.settings?.waitingDays, 7, 'the API default, read and not invented');
    assert.equal(await portOf('outsider').verification(hubId), null, 'a participant reads nothing');
    assert.equal(await portOf('otherOwner').verification(hubId), null, 'staff of another hub read nothing');
    const port = createApiConsolePort({ api: apiOf(unelevated), siteHost: () => 'x', engineVersion: '0', now: () => h.clock.now() });
    assert.deepEqual((await port.viewer(live))?.elevation, { state: 'required' });
    assert.equal(await port.verification(hubId), null, 'a staff session without an elevation reads nothing');
  });

  await t.test('a draft keeps sanctions screening required whatever the form says, and a malformed form never reaches the API', async () => {
    const drafted = await run('owner', 'verification.recipe_draft', { ...recipeFields, 'step.sanctions_screening': 'off' });
    assert.deepEqual(drafted, { status: 'applied' });
    const [recipe] = (await view()).recipes;
    assert.equal(recipe?.status, 'draft');
    assert.deepEqual(recipe?.steps, [{ check: 'register_match', required: true }, { anyOf: ['officer_match', 'signed_authority'] }, { check: 'sanctions_screening', required: true }]);
    assert.deepEqual(recipe?.badgeCategories, ['register_record_matches', 'sanctions_screening_clear']);
    const one = await run('owner', 'verification.recipe_draft', { ...recipeFields, 'step.signed_authority': 'off' });
    assert.equal(one.status === 'rejected' && one.field, 'step.officer_match', 'a group of one is no group');
    const key = await run('owner', 'verification.recipe_draft', { ...recipeFields, key: 'NO' });
    assert.equal(key.status === 'rejected' && key.field, 'key');
    assert.equal((await view()).recipes.length, 1, 'nothing else was stored');
  });

  await t.test('without the policy permission: refused by the console and, stepped over, by the API', async () => {
    const [recipe] = (await view()).recipes;
    const fields = { recipeId: recipe!.id, revision: String(recipe!.revision) };
    const denied = await run('moderator', 'verification.recipe_activate', fields);
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    const api = await direct('moderator', 'verification.recipe_activate', fields);
    assert.equal(api.status === 'rejected' && api.code, 'denied', 'the API refuses a reader');
    const audited = await h.db.admin.query("SELECT outcome FROM trustwork.admin_audit_event WHERE actor_person_id = $1 AND action = 'verification.recipe_activated'", [w.people.moderator]);
    assert.deepEqual(audited.rows.map((r) => r.outcome), ['denied'], 'the refusal is on the audit trail');
    const elsewhere = await direct('otherOwner', 'verification.recipe_activate', fields);
    assert.equal(elsewhere.status === 'rejected' && elsewhere.code, 'denied', 'a role of another hub counts for nothing here');
    assert.deepEqual(await run('outsider', 'verification.recipe_activate', fields), { status: 'not_found' }, 'a participant finds nothing');
    assert.equal((await view()).recipes[0]?.status, 'draft');
  });

  await t.test('activation binds the revision the page showed; a stale page and a race leave one winner', async () => {
    const [recipe] = (await view()).recipes;
    const stale = await run('owner', 'verification.recipe_activate', { recipeId: recipe!.id, revision: String(recipe!.revision + 1) });
    assert.equal(stale.status === 'rejected' && stale.code, 'stale');
    const fields = { recipeId: recipe!.id, revision: String(recipe!.revision) };
    const answers = await Promise.all([run('owner', 'verification.recipe_activate', fields), run('officer', 'verification.recipe_activate', fields)]);
    assert.deepEqual(answers.map((r) => r.status).sort(), ['applied', 'rejected'], JSON.stringify(answers));
    const [active] = (await view()).recipes;
    assert.equal(active?.status, 'active');
    assert.ok(active?.activatedBy && [w.people.owner, w.people.officer].includes(active.activatedBy));
  });

  await t.test('a recipe of another hub is not found through this hub', async () => {
    const foreign = await withMaintenance(h.db.admin, async (trx) => (await trx.insertInto('verification_recipe').values({
      hub_id: otherHubId, key: 'foreign-recipe', version: 1, subject_kind: 'company', trigger: 'claim_verified', steps: JSON.stringify([{ check: 'sanctions_screening', required: true }]), badge_categories: ['category'],
      recheck_months: 6, drafted_by: w.people.otherOwner,
    } as never).returning('id').executeTakeFirstOrThrow()).id);
    assert.deepEqual(await run('owner', 'verification.recipe_activate', { recipeId: foreign, revision: '1' }), { status: 'not_found' });
    assert.equal((await view()).recipes.some((r) => r.id === foreign), false);
  });

  await t.test('the launch checklist: recording the active recipes confirms the gate, and a new active version asks for a new record', async () => {
    assert.equal(await gate(), false, 'an active recipe alone does not move the gate');
    assert.equal((await view()).config, null);
    const denied = await run('moderator', 'verification.config_record');
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    assert.deepEqual(await run('owner', 'verification.config_record'), { status: 'applied' });
    assert.equal(await gate(), true);
    assert.deepEqual((await view()).config, { version: 1, current: true });
    assert.deepEqual(await run('owner', 'verification.recipe_draft', { ...recipeFields, recheckMonths: '6' }), { status: 'applied' });
    const next = (await view()).recipes.find((r) => r.status === 'draft')!;
    assert.equal(next.version, 2);
    assert.deepEqual(await run('officer', 'verification.recipe_activate', { recipeId: next.id, revision: String(next.revision) }), { status: 'applied' });
    const after = await view();
    assert.deepEqual(after.recipes.map((r) => [r.version, r.status]), [[2, 'active'], [1, 'superseded']]);
    assert.deepEqual(after.config, { version: 1, current: false });
    assert.deepEqual(await run('owner', 'verification.config_record'), { status: 'applied' });
    assert.deepEqual((await view()).config, { version: 2, current: true });
  });

  await t.test('a provider registers fake or manual only; a duplicate and a sanctions provider are refused', async () => {
    const fields = { checkType: 'register_match', adapter: 'synthetic_register', mode: 'manual', retentionDays: '365', legalBasis: 'statutory_public_register', costMinor: '250' };
    assert.deepEqual(await run('owner', 'verification.provider_register', fields), { status: 'applied' });
    const [provider] = (await view('moderator')).providers;
    assert.deepEqual([provider?.mode, provider?.costMinor, provider?.status], ['manual', '250', 'active']);
    const live = await run('owner', 'verification.provider_register', { ...fields, adapter: 'other_adapter', mode: 'live' });
    assert.equal(live.status === 'rejected' && live.field, 'mode', 'nobody registers a live provider');
    const sanctions = await run('owner', 'verification.provider_register', { ...fields, adapter: 'other_adapter', checkType: 'sanctions_screening' });
    assert.equal(sanctions.status === 'rejected' && sanctions.field, 'checkType');
    const duplicate = await run('owner', 'verification.provider_register', fields);
    assert.equal(duplicate.status === 'rejected' && duplicate.field, 'adapter');
    const denied = await direct('moderator', 'verification.provider_register', { ...fields, adapter: 'reader_adapter' });
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    assert.equal((await view()).providers.length, 1);
  });

  await t.test('a provider goes live only through a second person, with that credential, by the person who asked', async () => {
    const credential = async (provider: string) => {
      const registered = await staffPost('owner', `/v1/admin/hubs/${hubId}/credentials`, { provider, adapter: `${provider}_api`, mode: 'live', secret: { store: 'env', ref: `env:${provider.toUpperCase()}` } });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      const { credential: row } = registered.body as { credential: { id: string; activation: { actionDigest: string } } };
      const requested = await staffPost('owner', '/v1/admin/approvals', { subject: { action: 'providers.enable_non_fake', scope, actionDigest: row.activation.actionDigest } });
      assert.equal(requested.status, 201, JSON.stringify(requested.body));
      const { approval } = requested.body as { approval: { id: string } };
      assert.equal((await staffPost('officer', `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: row.activation.actionDigest })).status, 200);
      const activated = await staffPost('owner', `/v1/admin/hubs/${hubId}/credentials/${row.id}/activate`, { approvalId: approval.id });
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      return row.id;
    };
    const fake = await staffPost('owner', `/v1/admin/hubs/${hubId}/credentials`, { provider: 'synthetic_fake', adapter: 'synthetic_fake_api', mode: 'fake', secret: { store: 'env', ref: 'env:SYNTHETIC_FAKE' } });
    assert.equal(fake.status, 201, JSON.stringify(fake.body));
    const first = await credential('synthetic_first');
    const second = await credential('synthetic_second');
    const provider = (await view()).providers[0]!;
    assert.deepEqual((await view()).liveOptions[provider.id]?.map((o) => o.credentialId).sort(), [first, second].sort(), 'only active, non-fake credentials are offered');
    const fields = { providerId: provider.id, credentialRefId: first };

    const early = await run('owner', 'verification.provider_go_live', fields);
    assert.equal(early.status === 'rejected' && early.code, 'second_person_pending', 'nothing was approved yet');
    const reader = await run('moderator', 'verification.provider_request_live', fields);
    assert.equal(reader.status === 'rejected' && reader.code, 'denied');

    assert.deepEqual(await run('owner', 'verification.provider_request_live', fields), { status: 'pending_second_person', secondPerson: 'providers.enable_non_fake' });
    const again = await run('owner', 'verification.provider_request_live', fields);
    assert.equal(again.status === 'rejected' && again.code, 'second_person_pending', 'a waiting request is not doubled');
    const stage = (await view()).liveOptions[provider.id]!.find((o) => o.credentialId === first)!;
    assert.equal(stage.stage.stage, 'requested');
    const { requests } = await portOf('officer').approvals(hubId);
    const request = requests.find((r) => r.action === 'providers.enable_non_fake' && r.actionDigest.value === stage.digest)!;
    assert.ok(request, 'the second person sees the request in approvals');
    const decide = (key: Who) => run(key, 'approvals.decide', { requestId: request.id, decision: 'approve', digest: stage.digest });
    const own = await decide('owner');
    assert.equal(own.status === 'rejected' && own.code, 'own_request', 'nobody approves their own request');
    assert.deepEqual(await decide('officer'), { status: 'applied' });

    assert.equal((await view('owner')).liveOptions[provider.id]!.find((o) => o.credentialId === first)?.stage.stage, 'approved');
    assert.equal((await view('officer')).liveOptions[provider.id]!.find((o) => o.credentialId === first)?.stage.stage, 'requested', 'the approver cannot finish it');
    const other = await run('officer', 'verification.provider_go_live', fields);
    assert.equal(other.status === 'rejected' && other.code, 'second_person_pending', 'only the requester executes an approval');
    const wrongCredential = await run('owner', 'verification.provider_go_live', { ...fields, credentialRefId: second });
    assert.equal(wrongCredential.status === 'rejected' && wrongCredential.code, 'second_person_pending', 'the approval binds one credential');
    const unknown = await run('owner', 'verification.provider_go_live', { ...fields, credentialRefId: randomUUID() });
    assert.deepEqual(unknown, { status: 'not_found' });

    const answers = await Promise.all([run('owner', 'verification.provider_go_live', fields), run('owner', 'verification.provider_go_live', fields)]);
    assert.ok(answers.some((r) => r.status === 'applied'), JSON.stringify(answers));
    assert.equal(answers.filter((r) => r.status === 'applied').length, 1, `one approval, one switch: ${JSON.stringify(answers)}`);
    const after = (await view()).providers[0]!;
    assert.deepEqual([after.mode, after.credentialRefId], ['live', first]);
    assert.equal((await view()).liveOptions[provider.id], undefined, 'a live provider has nothing left to switch');
    assert.deepEqual(await run('owner', 'verification.provider_go_live', fields), { status: 'not_found' });
  });

  await t.test('claim periods: saved within bounds, read back, refused for a reader', async () => {
    assert.deepEqual(await run('owner', 'verification.claim_settings', { waitingDays: '10', coolingDays: '5' }), { status: 'applied' });
    assert.deepEqual([(await view('moderator')).settings?.waitingDays, (await view('moderator')).settings?.coolingDays], [10, 5]);
    const bound = await run('owner', 'verification.claim_settings', { waitingDays: '31', coolingDays: '5' });
    assert.equal(bound.status === 'rejected' && bound.field, 'waitingDays');
    const denied = await direct('moderator', 'verification.claim_settings', { waitingDays: '1', coolingDays: '1' });
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    assert.equal((await view()).settings?.waitingDays, 10);
  });

  await t.test('a command needs a reason and a live elevation', async () => {
    const reason = await run('owner', 'verification.claim_settings', { waitingDays: '9', coolingDays: '5' }, '  ');
    assert.equal(reason.status === 'rejected' && reason.code, 'reason_required');
    const port = createApiConsolePort({ api: apiOf(unelevated), siteHost: () => 'x', engineVersion: '0', now: () => h.clock.now() });
    const answer = await port.command(live, { command: 'verification.claim_settings', hubSlug: SLUG, setupToken: null, reason: 'Synthetic', expectedRevision: null, fields: { waitingDays: '9', coolingDays: '5' } });
    assert.deepEqual(answer, { status: 'not_found' }, 'an unelevated session does not even see the hub');
  });
});

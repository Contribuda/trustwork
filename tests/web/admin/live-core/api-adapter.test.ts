import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
import { invitationStage } from '../../../../apps/web/app/admin/_data/commands.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';

/**
 * HUBC-007 first slice: the console's live adapter reads the API with the visitor's session and never serves a fixture
 * or an invented value. A fake API stands in for `/v1/*` here (shapes of the HUB-001, ADM-001 and BE-004 views); the
 * browser plan against the live stack follows in this directory.
 */

const NOW = new Date('2026-11-01T12:00:00Z');
const HUB_ID = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';
const STAFF = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const fixture = HUBS[0]!;
const hub = { ...fixture.hub, id: HUB_ID, nodeId: NODE, slug: 'san-diego' };
const DIGEST = 'a'.repeat(64);

class Failure extends Error {
  constructor(readonly status: number) {
    super(`API ${status}`);
  }
}

type Routes = Record<string, unknown | (() => unknown)>;
function fakeApi(routes: Routes): ConsoleApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (!(path in routes)) return null;
      const value = routes[path];
      return typeof value === 'function' ? (value as () => unknown)() : value;
    },
  };
}

const approval = (overrides: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555555', action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId: HUB_ID }, actionDigest: DIGEST, reason: 'Enable the mail provider',
  requestedBy: OTHER, requestedAt: '2026-11-01T10:00:00.000Z', requestExpiresAt: '2026-11-02T10:00:00.000Z', status: 'pending', approvedBy: null, approvedAt: null, expiresAt: null,
  declinedBy: null, declineReason: null, revokedAt: null, consumedAt: null, revision: 1, ...overrides,
});

const staffRoutes = (extra: Routes = {}): Routes => ({
  '/v1/me': { person: { id: STAFF, displayName: 'Hub Owner' }, principal: { personId: STAFF, staff: ['hub-owner'] } },
  '/v1/admin/session': { elevationId: 'e1', factor: 'totp', expiresAt: '2026-11-01T12:10:00.000Z', staffRoles: ['hub-owner'] },
  '/v1/admin/node': { nodeId: NODE, label: 'San Diego node' },
  '/v1/admin/hubs': { items: [{ hub, territoryIds: {}, profileRevision: 1, createdAt: '2026-10-01T00:00:00.000Z' }] },
  [`/v1/admin/hubs/${HUB_ID}/config/current`]: { items: [{ id: 'c1', hubId: HUB_ID, domain: 'modes', version: 1, payload: { ...fixture.modes, dataMode: 'live' }, status: 'active' }], retention: [] },
  [`/v1/admin/hubs/${HUB_ID}/config`]: { items: [] },
  [`/v1/admin/hubs/${HUB_ID}/launch`]: { hubId: HUB_ID, lifecycle: hub.lifecycle, gates: [], blockers: { soft_launch: [], public: [] } },
  [`/v1/admin/staff/sod?hubId=${HUB_ID}`]: { target: { hubId: HUB_ID }, mode: 'full', staffCount: 4, minimumForFull: 3 },
  [`/v1/admin/access?hubId=${HUB_ID}`]: { personId: STAFF, roles: ['hub-owner'], permissions: ['admin.hub.identity.edit', 'admin.notifications.read'], breakglassOnly: [] },
  '/v1/admin/staff/definitions': { definitions: [{ role: 'hub-owner', permissions: ['admin.hub.read', 'admin.hub.identity.edit'] }, { role: 'editor', permissions: ['admin.notifications.read'] }] },
  ...extra,
});
const port = (routes: Routes) => {
  const api = fakeApi(routes);
  return { api, port: createApiConsolePort({ api, siteHost: async () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW }) };
};
const live = { demo: false } as const;

test('viewer: staff with a live elevation is elevated; an expired or refused elevation requires a new one', async () => {
  assert.deepEqual((await port(staffRoutes()).port.viewer(live))?.elevation, { state: 'elevated', until: '2026-11-01T12:10:00.000Z' });
  const expired = port(staffRoutes({ '/v1/admin/session': { elevationId: 'e1', factor: 'totp', expiresAt: '2026-11-01T11:59:00.000Z', staffRoles: [] } }));
  assert.deepEqual((await expired.port.viewer(live))?.elevation, { state: 'required' });
  const refused = port(staffRoutes({ '/v1/admin/session': () => { throw new Failure(403); } }));
  assert.deepEqual((await refused.port.viewer(live))?.elevation, { state: 'required' });
  const viewer = await port(staffRoutes()).port.viewer(live);
  assert.equal(viewer?.person.synthetic, false, 'a live person is never labelled synthetic');
});

test('negative authorization: no session, no staff role or a demo request finds no viewer and reads nothing else', async () => {
  const anonymous = port({});
  assert.equal(await anonymous.port.viewer(live), null);
  const participant = port(staffRoutes({ '/v1/me': { person: { id: OTHER, displayName: 'Participant' }, principal: { personId: OTHER, staff: [] } } }));
  assert.equal(await participant.port.viewer(live), null);
  assert.deepEqual(participant.api.calls, ['/v1/me'], 'a participant never reaches a staff route');
  const forged = port(staffRoutes());
  assert.equal(await forged.port.viewer({ demo: true, persona: 'hub-owner', scenario: 'default' }), null, 'a demo request never chooses a live viewer');
  assert.deepEqual(await forged.port.hubs({ demo: true, persona: 'hub-owner', scenario: 'default' }), []);
  assert.deepEqual(forged.api.calls, []);
  const other = port(staffRoutes());
  assert.deepEqual(await other.port.access((await other.port.viewer(live))!, { nodeId: NODE, hubId: OTHER }), { roles: [], permissions: [] }, 'another hub: nothing granted');
});

test('hubs: the contract hub with its active modes, gates and SoD mode; no worked example, no fixture, no invented caps', async () => {
  const { port: p } = port(staffRoutes());
  const [record] = await p.hubs(live);
  assert.ok(record);
  assert.equal(record.hub.id, HUB_ID);
  assert.equal(record.synthetic, false);
  assert.equal(record.example, null);
  assert.equal(record.domain, 'sandiego.example.org');
  assert.equal(record.modes.dataMode, 'live');
  assert.equal(record.sodMode, 'full');
  assert.deepEqual([record.budgets, record.killSwitches], [[], []]);
  assert.equal((await p.hub('san-diego', live))?.hub.id, HUB_ID);
  assert.equal(await p.hub('us-demo', live), null, 'a fixture slug finds nothing live');
});

test('a hub without an active modes configuration is not shown; reduced SoD without the staff directory', async () => {
  const noModes = port(staffRoutes({ [`/v1/admin/hubs/${HUB_ID}/config/current`]: { items: [], retention: [] } }));
  assert.deepEqual(await noModes.port.hubs(live), []);
  const noDirectory = port(staffRoutes({ [`/v1/admin/staff/sod?hubId=${HUB_ID}`]: () => { throw new Failure(403); } }));
  assert.equal((await noDirectory.port.hubs(live))[0]?.sodMode, 'reduced');
});

test('node, access and roles come from the API', async () => {
  const { port: p } = port(staffRoutes());
  assert.deepEqual(await p.node(), { id: NODE, name: 'San Diego node', domain: 'sandiego.example.org', engineVersion: '0.1.0', synthetic: false });
  const viewer = (await p.viewer(live))!;
  assert.deepEqual(await p.access(viewer, { nodeId: NODE, hubId: HUB_ID }), { roles: ['hub-owner'], permissions: ['admin.hub.identity.edit', 'admin.notifications.read'] });
  const identity = SECTIONS.find((s) => s.section.id === 'identity')!.section;
  assert.deepEqual(await p.rolesGranting(identity), ['hub-owner']);
});

test('approvals: pending requests and approvals of this hub only, bound to their digest; other hubs and unknown actions dropped', async () => {
  const { port: p } = port(staffRoutes({
    [`/v1/admin/approvals?hubId=${HUB_ID}`]: { mine: [], forMe: [approval()], decided: [

      approval({ id: '66666666-6666-4666-8666-666666666666', status: 'approved', approvedBy: STAFF, approvedAt: '2026-11-01T11:00:00.000Z', expiresAt: '2026-11-01T23:00:00.000Z' }),
      approval({ id: '77777777-7777-4777-8777-777777777777', scope: { kind: 'hub', hubId: OTHER } }),
      approval({ id: '88888888-8888-4888-8888-888888888888', action: 'unknown.action' }),
      approval({ id: '99999999-9999-4999-8999-999999999999', status: 'declined', declinedBy: STAFF }),
    ] },
  }));
  const { requests, decisions } = await p.approvals(HUB_ID);
  assert.deepEqual(requests.map((r) => [r.id, r.state, r.actionDigest.value, r.synthetic]), [['55555555-5555-4555-8555-555555555555', 'pending', DIGEST, false]]);
  assert.deepEqual(decisions.map((d) => [d.requestId, d.decision, d.approval?.approvedBy]), [['66666666-6666-4666-8666-666666666666', 'approve', STAFF]]);
});

test('live mode refuses every command and serves no fixture data for unwired sections', async () => {
  const { port: p } = port(staffRoutes());
  assert.deepEqual(await p.command(live, { command: 'taxonomy.add_term', reason: 'x', expectedRevision: 1, fields: {} } as never), { status: 'not_found' });
  const overview = await p.overview(HUB_ID);
  assert.deepEqual([overview?.queues, overview?.health, overview?.compliance], [[], [], { legalDocumentsDue: null, screeningListAgeDays: null, expiringSourceLicences: null, fakeProviders: null }], 'nothing readable: no number, no fixture');
  assert.equal(await p.product(HUB_ID), null);
  assert.equal(await p.setup('token'), null);
  assert.deepEqual(await p.legal(HUB_ID), { operator: null, documents: [] });
});

/* ---------- Live commands: approval decisions through the API ---------- */

type Sent = { path: string; body: Record<string, unknown>; key: string };
function commandPort(answer: { status: number; code: string | null }, extra: Routes = {}) {
  const api = fakeApi(staffRoutes({
    [`/v1/admin/access?hubId=${HUB_ID}`]: { personId: STAFF, roles: ['hub-owner'], permissions: ['admin.providers.toggle'], breakglassOnly: [] },
    [`/v1/admin/approvals?hubId=${HUB_ID}`]: { forMe: [approval()], mine: [approval({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestedBy: STAFF })], decided: [] },
    ...extra,
  }));
  const sent: Sent[] = [];
  const withPost: ConsoleApi = { get: api.get, async post(path, body, key) { sent.push({ path, body, key }); return answer; } };
  return { sent, port: createApiConsolePort({ api: withPost, siteHost: () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW, newKey: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) };
}
const decide = (fields: Record<string, string>, reason = 'Checked the provider contract') =>
  ({ command: 'approvals.decide', hubSlug: 'san-diego', setupToken: null, reason, expectedRevision: null, fields }) as const;
const REQUEST = '55555555-5555-4555-8555-555555555555';

test('approve: the console checks first, then posts the restated digest with the same key in header and body; the API answer decides', async () => {
  const { sent, port: p } = commandPort({ status: 200, code: null });
  assert.deepEqual(await p.command(live, decide({ requestId: REQUEST, decision: 'approve', digest: DIGEST })), { status: 'applied' });
  assert.deepEqual(sent, [{
    path: `/v1/admin/approvals/${REQUEST}/approve`,
    body: { contractVersion: '1.0.0', idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', reason: 'Checked the provider contract', actionDigest: DIGEST },
    key: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }]);
  const declined = commandPort({ status: 200, code: null });
  assert.deepEqual(await declined.port.command(live, decide({ requestId: REQUEST, decision: 'decline', digest: DIGEST })), { status: 'applied' });
  assert.equal(declined.sent[0]?.path, `/v1/admin/approvals/${REQUEST}/decline`);
  assert.equal('actionDigest' in declined.sent[0]!.body, false);
});

test('refused before any call: another digest, one\'s own request, no reason, no elevation, a demo request, an unwired command', async () => {
  const cases: Array<[unknown, ReturnType<typeof commandPort>]> = [];
  const digest = commandPort({ status: 200, code: null });
  assert.equal(((await digest.port.command(live, decide({ requestId: REQUEST, decision: 'approve', digest: 'b'.repeat(64) }))) as { code: string }).code, 'digest_mismatch');
  cases.push([null, digest]);
  const own = commandPort({ status: 200, code: null });
  assert.equal(((await own.port.command(live, decide({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', decision: 'approve', digest: DIGEST }))) as { code: string }).code, 'own_request');
  cases.push([null, own]);
  const reason = commandPort({ status: 200, code: null });
  assert.equal(((await reason.port.command(live, decide({ requestId: REQUEST, decision: 'approve', digest: DIGEST }, '  '))) as { code: string }).code, 'reason_required');
  cases.push([null, reason]);
  const elevation = commandPort({ status: 200, code: null }, { '/v1/admin/session': () => { throw new Failure(403); } });
  assert.equal(((await elevation.port.command(live, decide({ requestId: REQUEST, decision: 'approve', digest: DIGEST }))) as { code: string }).code, 'elevation_required');
  cases.push([null, elevation]);
  const demo = commandPort({ status: 200, code: null });
  assert.deepEqual(await demo.port.command({ demo: true, persona: 'hub-owner', scenario: 'default' }, decide({ requestId: REQUEST, decision: 'approve', digest: DIGEST })), { status: 'not_found' });
  cases.push([null, demo]);
  const unwired = commandPort({ status: 200, code: null });
  assert.deepEqual(await unwired.port.command(live, { command: 'taxonomy.add_term', hubSlug: 'san-diego', setupToken: null, reason: 'x', expectedRevision: 1, fields: { kind: 'x' } }), { status: 'not_found' });
  cases.push([null, unwired]);
  for (const [, c] of cases) assert.deepEqual(c.sent, [], 'nothing was sent');
});

test('API refusals become console refusals: forbidden, a second approver required, not found, conflict', async () => {
  const code = async (status: number, apiCode: string | null) => {
    const outcome = await commandPort({ status, code: apiCode }).port.command(live, decide({ requestId: REQUEST, decision: 'approve', digest: DIGEST }));
    return outcome.status === 'rejected' ? outcome.code : outcome.status;
  };
  assert.equal(await code(403, 'access.forbidden'), 'denied');
  assert.equal(await code(403, 'access.second_approver_required'), 'own_request');
  assert.equal(await code(404, 'access.not_found'), 'not_found');
  assert.equal(await code(409, 'validation.idempotency_conflict'), 'request_void');
  assert.equal(await code(503, null), 'invalid');
});

/* ---------- Live commands: hub settings through the API (HUBC-007 part 2) ---------- */

function settingsPort(answers: Array<{ status: number; code: string | null; body?: unknown }>, permissions: string[]) {
  const api = fakeApi(staffRoutes({ [`/v1/admin/access?hubId=${HUB_ID}`]: { personId: STAFF, roles: ['hub-owner'], permissions, breakglassOnly: [] } }));
  const sent: Sent[] = [];
  let i = 0;
  let k = 0;
  const withPost: ConsoleApi = { get: api.get, async post(path, body, key) { sent.push({ path, body, key }); return answers[i++] ?? { status: 500, code: null }; } };
  return { sent, port: createApiConsolePort({ api: withPost, siteHost: () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW, newKey: () => `key-${++k}` }) };
}
const settings = (command: string, fields: Record<string, string>, expectedRevision: number | null = hub.revision) =>
  ({ command, hubSlug: 'san-diego', setupToken: null, reason: 'Synthetic settings change', expectedRevision, fields }) as never;
const applied = (objectId: string, outcome = 'applied') => ({ result: { contractVersion: '1.0.0', outcome, objectId, revision: 2, approvalRequestId: outcome === 'pending_second_person' ? REQUEST : null, auditEventId: objectId } });
const VERSION = '66666666-6666-4666-8666-666666666666';

test('modes: a new modes version is drafted with the requested modes, then activated with its revision; each call has its own key', async () => {
  const { sent, port: p } = settingsPort([{ status: 201, code: null, body: { ...applied(VERSION), version: { id: VERSION, revision: 1 } } }, { status: 200, code: null, body: applied(VERSION) }],
    ['admin.hub.modes.edit']);
  const outcome = await p.command(live, settings('modes.save', { moderation: 'pre_moderate_all' }));
  assert.deepEqual(outcome, { status: 'applied' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.path, `/v1/admin/hubs/${HUB_ID}/config`);
  assert.equal(sent[0]!.body.domain, 'modes');
  assert.equal((sent[0]!.body.payload as { moderation: string }).moderation, 'pre_moderate_all');
  assert.deepEqual([sent[1]!.path, sent[1]!.body.expectedRevision, sent[1]!.body.approvalId], [`/v1/admin/hubs/${HUB_ID}/config/${VERSION}/activate`, 1, null]);
  assert.deepEqual(sent.map((c) => [c.key, c.body.idempotencyKey]), [['key-1', 'key-1'], ['key-2', 'key-2']]);
});

test('an activation the API sends to a second person is reported as such, never as applied', async () => {
  const { port: p } = settingsPort([{ status: 201, code: null, body: { ...applied(VERSION), version: { id: VERSION, revision: 1 } } }, { status: 200, code: null, body: applied(VERSION, 'pending_second_person') }],
    ['admin.hub.modes.edit']);
  assert.deepEqual(await p.command(live, settings('modes.save', { moderation: 'pre_moderate_all' })), { status: 'pending_second_person', secondPerson: null });
});

test('lifecycle and launch: the transition carries the hub revision; a gate check needs an evidence record id', async () => {
  const lifecycle = settingsPort([{ status: 200, code: null, body: applied(HUB_ID) }], ['admin.hub.lifecycle.request']);
  await lifecycle.port.command(live, settings('lifecycle.request', { to: 'pilot' }));
  if (lifecycle.sent.length) assert.deepEqual([lifecycle.sent[0]!.path, lifecycle.sent[0]!.body.to, lifecycle.sent[0]!.body.expectedRevision], [`/v1/admin/hubs/${HUB_ID}/lifecycle`, 'pilot', hub.revision]);
  const gate = fixture.gates.find((g) => g.state !== 'passed')?.gate;
  const launch = settingsPort([{ status: 200, code: null, body: applied(HUB_ID) }], ['admin.hub.launch.check']);
  if (gate) {
    const freeText = await launch.port.command(live, settings('launch.mark_passed', { gate, evidence: 'contract-SD-1' }, null));
    assert.ok(freeText.status === 'rejected', 'a free-text reference is not an evidence record');
  }
  assert.ok(launch.sent.every((c) => c.path.endsWith('/launch/check')));
});

test('identity: a new default language goes through the profile with the hub revision; a new territory through its own route', async () => {
  const other = hub.locales.find((l) => l !== hub.defaultLocale);
  const { sent, port: p } = settingsPort([{ status: 200, code: null, body: applied(HUB_ID) }, { status: 201, code: null, body: applied(HUB_ID) }], ['admin.hub.identity.edit']);
  const fields: Record<string, string> = { addTerritory: 'US-CA:san-diego' };
  if (other) fields.defaultLocale = other;
  assert.deepEqual(await p.command(live, settings('identity.save', fields)), { status: 'applied' });
  const paths = sent.map((c) => c.path);
  if (other) {
    assert.equal(paths[0], `/v1/admin/hubs/${HUB_ID}/profile`);
    assert.deepEqual([sent[0]!.body.defaultLocale, sent[0]!.body.expectedRevision, sent[0]!.body.locales], [other, hub.revision, hub.locales]);
  }
  assert.equal(paths.at(-1), `/v1/admin/hubs/${HUB_ID}/territories`);
  assert.deepEqual(sent.at(-1)!.body.territory, { level: 'place', code: 'US-CA:san-diego' });
  const nothing = settingsPort([], ['admin.hub.identity.edit']);
  assert.equal((await nothing.port.command(live, settings('identity.save', {}))).status, 'rejected', 'nothing to change is not a save');
  assert.deepEqual(nothing.sent, []);
});

test('residency: a residency draft for the named country, never activated by its drafter; a restricted place never leaves the console', async () => {
  const { sent, port: p } = settingsPort([{ status: 201, code: null, body: { ...applied(VERSION), version: { id: VERSION, revision: 1, activation: { secondPersonAction: 'hub.change_residency', actionDigest: 'e'.repeat(64) } } } }],
    ['admin.hub.residency.edit']);
  assert.deepEqual(await p.command(live, settings('residency.request_change', { country: 'us' }, null)), { status: 'draft_saved', secondPerson: 'hub.change_residency' });
  assert.equal(sent.length, 1, 'the drafter never activates a sensitive version');
  assert.deepEqual([sent[0]!.body.domain, sent[0]!.body.payload], ['residency', { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] }]);
  const restricted = settingsPort([], ['admin.hub.residency.edit']);
  assert.equal(((await restricted.port.command(live, settings('residency.request_change', { country: 'IR' }, null))) as { code: string }).code, 'territory_restricted');
  assert.deepEqual(restricted.sent, []);
});

test('legal: stored versions become console documents (counsel-approved drafts shown as such); a draft names its language and text', async () => {
  const COUNSEL = '77777777-7777-4777-8777-777777777777';
  const doc = (id: string, overrides: Record<string, unknown>) => ({ id, hubId: HUB_ID, kind: 'terms', locale: hub.defaultLocale, version: 1, body: 'Synthetic terms', bodyDigest: 'c'.repeat(64),
    status: 'draft', counselApprovalId: null, draftedBy: STAFF, draftedAt: '2026-11-01T09:00:00.000Z', activatedBy: null, activatedAt: null, approvalId: null, revision: 1, requiredForLaunch: true,
    activation: null, ...overrides });
  const { port: p } = port(staffRoutes({ [`/v1/admin/hubs/${HUB_ID}/legal`]: {
    documents: [doc('88888888-8888-4888-8888-888888888881', {}), doc('88888888-8888-4888-8888-888888888882', { counselApprovalId: COUNSEL, version: 2 })],
    counselApprovals: [{ id: COUNSEL, hubId: HUB_ID, documentVersionIds: ['88888888-8888-4888-8888-888888888882'], counselName: 'Synthetic Counsel', firm: 'Synthetic Law LLP',
      approvedOn: '2026-10-30', scopeNote: 'Synthetic review of the terms', recordedBy: STAFF, recordedAt: '2026-10-30T10:00:00.000Z' }],
  } }));
  const { operator, documents } = await p.legal(HUB_ID);
  assert.equal(operator, null, 'no operator read exists, so none is invented');
  assert.deepEqual(documents.map((d) => [d.version, d.status, d.locales, d.counselApproval?.firm ?? null]), [[1, 'draft', [hub.defaultLocale], null], [2, 'counsel_approved', [hub.defaultLocale], 'Synthetic Law LLP']]);

  const { sent, port: draft } = settingsPort([{ status: 201, code: null, body: applied(HUB_ID) }], ['admin.hub.legal.edit']);
  assert.deepEqual(await draft.command(live, settings('legal.draft', { kind: 'terms', locale: hub.defaultLocale, body: 'Synthetic terms of use, version 2.' }, null)), { status: 'applied' });
  assert.deepEqual([sent[0]!.path, sent[0]!.body.kind, sent[0]!.body.locale, sent[0]!.body.body], [`/v1/admin/hubs/${HUB_ID}/legal`, 'terms', hub.defaultLocale, 'Synthetic terms of use, version 2.']);
  const wrong = settingsPort([], ['admin.hub.legal.edit']);
  assert.equal(((await wrong.port.command(live, settings('legal.draft', { kind: 'terms', locale: 'xx', body: 'Text' }, null))) as { field: string }).field, 'locale');
  assert.equal(((await wrong.port.command(live, settings('legal.draft', { kind: 'terms', locale: hub.defaultLocale, body: '   ' }, null))) as { field: string }).field, 'body');
  assert.deepEqual(wrong.sent, []);
});

test('an unelevated staff session may not read the node: the node is absent, never an error', async () => {
  const { port: p } = port(staffRoutes({ '/v1/admin/node': () => { throw new Failure(403); } }));
  assert.equal(await p.node(), null);
});

test('identity: names, languages, time zone and currency travel together in one profile; each is checked before any call', async () => {
  const added = ['en', 'es', 'ka'].find((l) => !hub.locales.includes(l))!;
  const { sent, port: p } = settingsPort([{ status: 200, code: null, body: applied(HUB_ID) }], ['admin.hub.identity.edit']);
  const fields: Record<string, string> = Object.fromEntries([...hub.locales, added].map((l) => [`locale.${l}`, 'on']));
  fields[`name.${added}`] = 'Synthetic Hub Name';
  fields.timeZone = 'America/Los_Angeles';
  fields.currency = 'usd';
  assert.deepEqual(await p.command(live, settings('identity.save', fields)), { status: 'applied' });
  const body = sent[0]!.body as { locales: string[]; name: Record<string, string>; timeZone: string; currency: string; expectedRevision: number };
  assert.deepEqual([body.locales, body.name[added], body.timeZone, body.currency, body.expectedRevision], [[...hub.locales, added], 'Synthetic Hub Name', 'America/Los_Angeles', 'USD', hub.revision]);
  const check = async (extra: Record<string, string>) => {
    const r = settingsPort([], ['admin.hub.identity.edit']);
    const outcome = await r.port.command(live, settings('identity.save', extra));
    assert.deepEqual(r.sent, []);
    return outcome.status === 'rejected' ? outcome.field : outcome.status;
  };
  assert.equal(await check({ ...Object.fromEntries([...hub.locales, added].map((l) => [`locale.${l}`, 'on'])) }), `name.${added}`, 'a new language needs the hub name in it');
  assert.equal(await check({ timeZone: 'Mars/Olympus' }), 'timeZone');
  assert.equal(await check({ currency: 'dollars' }), 'currency');
  assert.equal(await check({ defaultLocale: 'xx' }), 'defaultLocale');
});

test('apply after approval: one\'s own approved request whose draft still matches its digest is offered and applied with the approval', async () => {
  const APPROVED = '99999999-9999-4999-8999-999999999991';
  const STALE = '99999999-9999-4999-8999-999999999992';
  const FOREIGN = '99999999-9999-4999-8999-999999999993';
  const RESIDENCY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const mineApproved = (id: string, digest: string, over: Record<string, unknown> = {}) => approval({ id, action: 'hub.change_residency', actionDigest: digest, requestedBy: STAFF,
    status: 'approved', approvedBy: OTHER, approvedAt: '2026-11-01T11:00:00.000Z', expiresAt: '2026-11-01T13:00:00.000Z', ...over });
  const api = fakeApi(staffRoutes({
    [`/v1/admin/approvals?hubId=${HUB_ID}`]: { forMe: [], mine: [], decided: [mineApproved(APPROVED, 'e'.repeat(64)), mineApproved(STALE, 'f'.repeat(64)), mineApproved(FOREIGN, 'e'.repeat(64), { requestedBy: OTHER })] },
    [`/v1/admin/hubs/${HUB_ID}/config`]: { items: [{ id: RESIDENCY, hubId: HUB_ID, domain: 'residency', version: 2, status: 'draft', revision: 3,
      activation: { secondPersonAction: 'hub.change_residency', actionDigest: 'e'.repeat(64) } }] },
  }));
  const sent: Sent[] = [];
  const p = createApiConsolePort({ api: { get: api.get, async post(path, body, key) { sent.push({ path, body, key }); return { status: 200, code: null, body: applied(RESIDENCY) }; } },
    siteHost: () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW, newKey: () => 'key-apply' });
  const { ready } = await p.approvals(HUB_ID);
  assert.deepEqual(ready?.map((r) => [r.requestId, r.target.kind, r.target.id, r.target.revision]), [[APPROVED, 'config', RESIDENCY, 3]], 'only the matching approval; a changed draft (another digest) never matches');
  assert.deepEqual(await p.command(live, settings('approvals.apply', { requestId: APPROVED }, null)), { status: 'applied' });
  assert.deepEqual([sent[0]!.path, sent[0]!.body.expectedRevision, sent[0]!.body.approvalId], [`/v1/admin/hubs/${HUB_ID}/config/${RESIDENCY}/activate`, 3, APPROVED]);
  assert.deepEqual(await p.command(live, settings('approvals.apply', { requestId: FOREIGN }, null)), { status: 'not_found' }, 'someone else\'s approval is not offered');
  assert.equal(sent.length, 1);
});

test('waiting for activation: another staff member\'s sensitive draft is offered once; requesting it activates without an approval, which opens the request', async () => {
  const OTHERS = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  const OWN = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
  const ASKED = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
  const PLAIN = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
  const draft = (id: string, by: string, digest: string | null) => ({ id, hubId: HUB_ID, domain: digest ? 'residency' : 'modes', version: 2, status: 'draft', revision: 4, draftedBy: by,
    draftedAt: '2026-11-01T10:00:00.000Z', activation: digest ? { secondPersonAction: 'hub.change_residency', actionDigest: digest } : null });
  const api = fakeApi(staffRoutes({
    [`/v1/admin/approvals?hubId=${HUB_ID}`]: { forMe: [], mine: [approval({ id: REQUEST, action: 'hub.change_residency', actionDigest: 'c'.repeat(64), requestedBy: OTHER, status: 'pending' })], decided: [] },
    [`/v1/admin/hubs/${HUB_ID}/config`]: { items: [draft(OTHERS, OTHER, 'a'.repeat(64)), draft(OWN, STAFF, 'b'.repeat(64)), draft(ASKED, OTHER, 'c'.repeat(64)), draft(PLAIN, OTHER, null)] },
  }));
  const sent: Sent[] = [];
  const p = createApiConsolePort({ api: { get: api.get, async post(path, body, key) { sent.push({ path, body, key }); return { status: 200, code: null, body: applied(OTHERS, 'pending_second_person') }; } },
    siteHost: () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW, newKey: () => 'key-request' });
  const { waiting } = await p.approvals(HUB_ID);
  assert.deepEqual(waiting?.map((w) => [w.target.id, w.draftedBy, w.action]), [[OTHERS, OTHER, 'hub.change_residency'], [OWN, STAFF, 'hub.change_residency']],
    'a draft with an open request and a draft that needs no second person are not waiting');
  assert.deepEqual(await p.command(live, settings('approvals.request_activation', { targetId: OTHERS }, null)), { status: 'pending_second_person', secondPerson: 'hub.change_residency' });
  assert.deepEqual([sent[0]!.path, sent[0]!.body.expectedRevision, sent[0]!.body.approvalId], [`/v1/admin/hubs/${HUB_ID}/config/${OTHERS}/activate`, 4, null]);
  assert.deepEqual(await p.command(live, settings('approvals.request_activation', { targetId: OWN }, null)), { status: 'rejected', code: 'own_request', field: null, detail: [] },
    'the drafter never starts the activation of their own sensitive draft');
  assert.deepEqual(await p.command(live, settings('approvals.request_activation', { targetId: ASKED }, null)), { status: 'not_found' }, 'an open request is not asked twice');
  assert.equal(sent.length, 1);
});

test('settings refusals: no permission or a stale revision sends nothing; an API refusal stays a refusal', async () => {
  const denied = settingsPort([], ['admin.notifications.read']);
  assert.equal(((await denied.port.command(live, settings('modes.save', { moderation: 'pre_moderate_all' }))) as { code: string }).code, 'denied');
  const stale = settingsPort([], ['admin.hub.modes.edit']);
  assert.equal(((await stale.port.command(live, settings('modes.save', { moderation: 'pre_moderate_all' }, hub.revision + 5))) as { code: string }).code, 'stale');
  assert.deepEqual([...denied.sent, ...stale.sent], []);
  const refused = settingsPort([{ status: 403, code: 'access.forbidden' }], ['admin.hub.modes.edit']);
  assert.deepEqual(await refused.port.command(live, settings('modes.save', { moderation: 'pre_moderate_all' })), { status: 'rejected', code: 'denied', field: null, detail: [] });
  assert.equal(refused.sent.length, 1, 'nothing is activated after a refused draft');
});

test('scan: the live adapter imports no fixture module', () => {
  const source = readFileSync(resolve('apps/web/app/admin/_data/api-adapter.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual(imports.filter((i) => /fixture|_fixtures/.test(i)), []);
});

/* ---------- Residency and the overview from the API ---------- */

const residencyRow = (payload: Record<string, unknown>) => ({ id: 'c2', hubId: HUB_ID, domain: 'residency', version: 4, payload, status: 'active' });
const withResidency = (payload: Record<string, unknown>) => ({ [`/v1/admin/hubs/${HUB_ID}/config/current`]: { items: [{ id: 'c1', hubId: HUB_ID, domain: 'modes', version: 1, payload: { ...fixture.modes, dataMode: 'live' }, status: 'active' }, residencyRow(payload)], retention: [] } });

test('residency: read from the active configuration version; what nothing records stays empty, never a fixture', async () => {
  const { port: p } = port(staffRoutes(withResidency({ hostingCountry: 'GE', hostingRegion: 'GE-TB', personalDataCountries: ['GE', 'DE'], note: 'Synthetic note' })));
  assert.deepEqual(await p.residency(HUB_ID), {
    hubId: HUB_ID, country: 'GE', regime: 'not_recorded', version: 4, hostingRegion: 'GE-TB', personalDataCountries: ['GE', 'DE'], note: 'Synthetic note', services: [], subProcessors: [], synthetic: false,
  });
});

test('residency: none configured, a payload that breaks the contract or a refused read is no residency at all', async () => {
  assert.equal(await port(staffRoutes()).port.residency(HUB_ID), null, 'no residency version yet');
  assert.equal(await port(staffRoutes(withResidency({ hostingCountry: 'GE' }))).port.residency(HUB_ID), null, 'an incomplete payload');
  assert.equal(await port(staffRoutes(withResidency({ hostingCountry: 'GE', hostingRegion: null, personalDataCountries: ['DE'] }))).port.residency(HUB_ID), null, 'personal data held where the hosting is not');
  assert.equal(await port(staffRoutes({ [`/v1/admin/hubs/${HUB_ID}/config/current`]: () => { throw new Failure(403); } })).port.residency(HUB_ID), null);
  await assert.rejects(port(staffRoutes({ [`/v1/admin/hubs/${HUB_ID}/config/current`]: () => { throw new Failure(500); } })).port.residency(HUB_ID), /API 500/);
});

const overviewRoutes = (): Routes => ({
  [`/v1/admin/moderation/cases?hubId=${HUB_ID}`]: { cases: [{ status: 'open' }, { status: 'in_review' }, { status: 'appealed' }, { status: 'decided' }, { status: 'closed' }] },
  '/v1/admin/support/cases': { cases: [
    { hubId: HUB_ID, status: 'open' }, { hubId: HUB_ID, status: 'triaged' }, { hubId: HUB_ID, status: 'waiting_on_requester' }, { hubId: HUB_ID, status: 'grant_requested' }, { hubId: HUB_ID, status: 'resolved' },
    { hubId: OTHER, status: 'open' }, { hubId: OTHER, status: 'grant_requested' }, { hubId: null, status: 'open' },
  ] },
  [`/v1/admin/hubs/${HUB_ID}/record-links?state=proposed`]: { items: [{ state: 'proposed' }, { state: 'proposed' }] },
  [`/v1/admin/hubs/${HUB_ID}/pipeline-alerts`]: { items: [{ state: 'open' }, { state: 'acknowledged' }, { state: 'resolved' }] },
  [`/v1/admin/hubs/${HUB_ID}/providers/connections`]: { items: [
    { mode: 'fake', status: 'enabled', capabilities: ['email', 'web_search'] }, { mode: 'fake', status: 'enabled', capabilities: ['email'] }, { mode: 'fake', status: 'draft', capabilities: ['object_storage'] },
    { mode: 'live', status: 'enabled', capabilities: ['maps_geocoding'] }, { mode: 'fake', status: 'enabled', capabilities: ['not_a_capability'] },
  ] },
  '/v1/admin/screening/lists': { checkedAt: '2026-11-01T12:00:00.000Z', available: true, items: [
    { hubId: null, status: 'active', freshness: { ageSeconds: 3 * 86_400 + 5 } }, { hubId: HUB_ID, status: 'active', freshness: { ageSeconds: 86_400 } },
    { hubId: OTHER, status: 'active', freshness: { ageSeconds: 90 * 86_400 } }, { hubId: null, status: 'paused', freshness: { ageSeconds: 60 * 86_400 } }, { hubId: null, status: 'active', freshness: { ageSeconds: null } },
  ] },
});

test('overview: counts what waits for staff at this hub, the oldest list that applies and what a fake provider still serves', async () => {
  const view = (await port(staffRoutes(overviewRoutes())).port.overview(HUB_ID))!;
  assert.deepEqual(Object.fromEntries(view.queues.map((q) => [q.id, q.count])), { reports: 3, support_cases: 2, grant_requests: 1, link_proposals: 2, alerts: 1 });
  assert.ok(view.queues.every((q) => q.nearestDeadline === null), 'no read gives a deadline, so none is shown');
  assert.deepEqual(view.uncounted, ['claims', 'review_items', 'privacy_requests', 'unknown_outcomes']);
  assert.deepEqual(view.compliance, { legalDocumentsDue: null, screeningListAgeDays: 3, expiringSourceLicences: null, fakeProviders: ['email', 'web_search'] });
  assert.deepEqual(view.health, [], 'nothing measures the health checks through this API yet');
  assert.equal(view.synthetic, false);
});

test('overview: a read the viewer may not make, or an answer of another shape, leaves its queue uncounted, never zero', async () => {
  const refused = port(staffRoutes({ ...overviewRoutes(),
    [`/v1/admin/moderation/cases?hubId=${HUB_ID}`]: () => { throw new Failure(403); }, '/v1/admin/support/cases': () => { throw new Failure(401); },
    [`/v1/admin/hubs/${HUB_ID}/record-links?state=proposed`]: { unexpected: true }, [`/v1/admin/hubs/${HUB_ID}/providers/connections`]: () => { throw new Failure(403); }, '/v1/admin/screening/lists': () => { throw new Failure(403); },
  }));
  const view = (await refused.port.overview(HUB_ID))!;
  assert.deepEqual(view.queues.map((q) => q.id), ['alerts']);
  assert.deepEqual(view.uncounted, ['claims', 'review_items', 'link_proposals', 'reports', 'support_cases', 'grant_requests', 'privacy_requests', 'unknown_outcomes']);
  assert.equal(view.compliance.fakeProviders, null, 'unread is not the same as none');
  assert.equal(view.compliance.screeningListAgeDays, null);
  const nothing = (await port(staffRoutes()).port.overview(HUB_ID))!;
  assert.deepEqual([nothing.queues, nothing.uncounted?.length], [[], 9], 'a hub hidden from the viewer counts nothing');
  await assert.rejects(port(staffRoutes({ ...overviewRoutes(), [`/v1/admin/hubs/${HUB_ID}/pipeline-alerts`]: () => { throw new Failure(500); } })).port.overview(HUB_ID), /API 500/, 'an outage is an outage, not an empty queue');
});

test('the reads with no API stay empty in live mode: local additions, taxonomy, brand checks and the agent product', async () => {
  const { api, port: p } = port(staffRoutes());
  assert.deepEqual([await p.localAdditions(HUB_ID), await p.taxonomy(HUB_ID), await p.brandChecks(HUB_ID), await p.product(HUB_ID)], [[], [], [], null]);
  assert.deepEqual(api.calls, [], 'none of them calls anything');
});

/* ---------- HC-150 staff (ADM-004 directory) ---------- */

const ASSIGNMENT = '77777777-7777-4777-8777-777777777771';
const NODE_ASSIGNMENT = '77777777-7777-4777-8777-777777777772';
const directory = {
  hubId: HUB_ID, detail: true,
  entries: [
    { personId: STAFF, displayName: 'Synthetic Hub Owner', roles: [{ assignmentId: '77777777-7777-4777-8777-777777777770', role: 'hub-owner', scope: { kind: 'hub', hubId: HUB_ID }, validUntil: null, breakglass: false }], secondFactor: 'enrolled' },
    { personId: OTHER, displayName: 'Synthetic Editor', roles: [
      { assignmentId: ASSIGNMENT, role: 'editor', scope: { kind: 'hub', hubId: HUB_ID }, validUntil: null, breakglass: false },
      { assignmentId: NODE_ASSIGNMENT, role: 'ops-engineer', scope: { kind: 'node', nodeId: NODE }, validUntil: null, breakglass: false },
    ], secondFactor: 'none' },
  ],
};
function staffPort(permissions: string[]) {
  const api = fakeApi(staffRoutes({
    [`/v1/admin/access?hubId=${HUB_ID}`]: { personId: STAFF, roles: ['hub-owner'], permissions, breakglassOnly: [] },
    [`/v1/admin/staff/directory?hubId=${HUB_ID}`]: directory,
    '/v1/admin/staff/definitions': { definitions: [
      { role: 'editor', version: 1, scopes: ['hub'], permissions: ['admin.notifications.read'] }, { role: 'editor', version: 3, scopes: ['hub'], permissions: ['admin.notifications.read'] },
      { role: 'moderator', version: 2, scopes: ['hub'], permissions: ['admin.moderation.read'] }, { role: 'compliance-officer', version: 1, scopes: ['hub'], permissions: ['admin.audit.read'] },
    ] },
    [`/v1/admin/staff/effective-access?hubId=${HUB_ID}&personId=${OTHER}`]: { personId: OTHER, hubId: HUB_ID, roles: ['editor', 'ops-engineer'], permissions: ['admin.notifications.read'], breakglassOnly: [] },
  }));
  const sent: Sent[] = [];
  let k = 0;
  const p = createApiConsolePort({ api: { get: api.get, async post(path, body, key) { sent.push({ path, body, key }); return { status: 201, code: null, body: applied(ASSIGNMENT) }; } },
    siteHost: () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW, newKey: () => `key-${++k}` });
  return { sent, port: p, api };
}

test('staff: the directory, effective access, the role catalogue (latest version per role) and names come from the API only', async () => {
  const { port: p } = staffPort(['admin.staff.read']);
  assert.deepEqual((await p.staff(HUB_ID, true))?.entries.map((e) => e.displayName), ['Synthetic Hub Owner', 'Synthetic Editor']);
  assert.deepEqual(await p.effectiveAccess(HUB_ID, OTHER), { roles: ['editor', 'ops-engineer'], permissions: ['admin.notifications.read'] });
  assert.equal(await p.effectiveAccess(HUB_ID, STAFF), null, 'a refused or missing read is absent, never invented');
  assert.deepEqual((await p.roleCatalogue()).map((d) => [d.role, d.version]), [['editor', 3], ['moderator', 2], ['compliance-officer', 1]]);
  assert.deepEqual(await p.people([OTHER, 'not-staff']), [{ id: OTHER, displayName: 'Synthetic Editor', nameLang: 'und', synthetic: false }], 'only staff are named');
  const unreadable = port(staffRoutes());
  assert.equal(await unreadable.port.staff(HUB_ID, true), null);
  assert.deepEqual(await unreadable.port.people([OTHER]), []);
});

test('staff.assign: a hub role from the latest definition for someone already on staff; self, sensitive and held roles never leave the console', async () => {
  const { sent, port: p } = staffPort(['admin.staff.assign', 'admin.staff.read']);
  assert.deepEqual(await p.command(live, settings('staff.assign', { personId: OTHER, role: 'moderator' }, null)), { status: 'applied' });
  assert.deepEqual([sent[0]!.path, sent[0]!.body.personId, sent[0]!.body.role, sent[0]!.body.scope, sent[0]!.body.definitionVersion],
    ['/v1/admin/staff/assignments', OTHER, 'moderator', { kind: 'hub', hubId: HUB_ID }, 2]);
  const code = async (fields: Record<string, string>, permissions = ['admin.staff.assign']) => {
    const r = staffPort(permissions);
    const outcome = await r.port.command(live, settings('staff.assign', fields, null));
    assert.deepEqual(r.sent, [], JSON.stringify(fields));
    return outcome.status === 'rejected' ? outcome.code : outcome.status;
  };
  assert.equal(await code({ personId: STAFF, role: 'moderator' }), 'self_grant');
  assert.equal(await code({ personId: OTHER, role: 'compliance-officer' }), 'sensitive_role', 'a sensitive role needs an invitation with a second person');
  assert.equal(await code({ personId: OTHER, role: 'editor' }), 'role_held');
  assert.equal(await code({ personId: 'someone-else', role: 'moderator' }), 'invalid', 'only people already on this hub\'s staff');
  assert.equal(await code({ personId: OTHER, role: 'moderator' }, ['admin.staff.read']), 'denied');
});

test('staff.revoke: only a role held at this hub, through its own route; node roles are not revoked here', async () => {
  const { sent, port: p } = staffPort(['admin.staff.revoke', 'admin.staff.read']);
  assert.deepEqual(await p.command(live, settings('staff.revoke', { assignmentId: ASSIGNMENT }, null)), { status: 'applied' });
  assert.equal(sent[0]!.path, `/v1/admin/staff/assignments/${ASSIGNMENT}/revoke`);
  assert.deepEqual(await p.command(live, settings('staff.revoke', { assignmentId: NODE_ASSIGNMENT }, null)), { status: 'not_found' });
  assert.deepEqual(await p.command(live, settings('staff.revoke', { assignmentId: 'unknown' }, null)), { status: 'not_found' });
  assert.equal(sent.length, 1);
  const denied = staffPort(['admin.staff.read']);
  assert.equal(((await denied.port.command(live, settings('staff.revoke', { assignmentId: ASSIGNMENT }, null))) as { code: string }).code, 'denied');
});

/* ---------- HC-150 staff invitations (ADM-004 part 2) ---------- */

const INVITATION = '99999999-9999-4999-8999-999999999991';
const SENSITIVE = '99999999-9999-4999-8999-999999999992';
const WAITING = '99999999-9999-4999-8999-999999999993';
const SOMEONE_ELSES = '99999999-9999-4999-8999-999999999994';
const NODE_INVITATION = '99999999-9999-4999-8999-999999999995';
const CLOSED = '99999999-9999-4999-8999-999999999996';
const LATE = '99999999-9999-4999-8999-999999999997';
const APPROVAL = '55555555-5555-4555-8555-555555555556';
const invitation = (overrides: Record<string, unknown> = {}) => ({
  id: INVITATION, email: 'new-editor@example.invalid', role: 'editor', scope: { kind: 'hub', hubId: HUB_ID }, definitionVersion: 3, validForSeconds: null, sensitive: false, status: 'accepted', expired: false,
  personId: OTHER, invitedBy: STAFF, reason: 'A second editor', expiresAt: '2026-11-05T09:00:00.000Z', respondedAt: '2026-11-01T09:00:00.000Z', approvalId: null, assignmentId: null,
  functionKey: null, functionTitle: null, revision: 2, ...overrides,
});
const invitationList = [
  invitation(),
  invitation({ id: SENSITIVE, email: 'second-compliance@example.invalid', role: 'compliance-officer', definitionVersion: 1, sensitive: true }),
  invitation({ id: WAITING, status: 'pending', personId: null, respondedAt: null, revision: 1 }),
  invitation({ id: SOMEONE_ELSES, email: 'other@example.invalid', invitedBy: OTHER, personId: STAFF }),
  invitation({ id: NODE_INVITATION, scope: { kind: 'node', nodeId: NODE } }),
  invitation({ id: CLOSED, email: 'closed@example.invalid', status: 'applied', assignmentId: ASSIGNMENT }),
  invitation({ id: LATE, email: 'late@example.invalid', expired: true }),
];
function invitationPort(permissions: string[], answers: Array<{ status: number; code: string | null; body?: unknown }> = [], extra: Routes = {}) {
  const api = fakeApi(staffRoutes({
    [`/v1/admin/access?hubId=${HUB_ID}`]: { personId: STAFF, roles: ['hub-owner'], permissions, breakglassOnly: [] },
    [`/v1/admin/staff/invitations?hubId=${HUB_ID}`]: { invitations: invitationList },
    '/v1/admin/staff/definitions': { definitions: [
      { role: 'editor', version: 1, scopes: ['hub'], permissions: ['admin.notifications.read'] }, { role: 'editor', version: 3, scopes: ['hub'], permissions: ['admin.notifications.read'] },
      { role: 'compliance-officer', version: 2, scopes: ['hub'], permissions: ['admin.audit.read'] }, { role: 'ops-engineer', version: 1, scopes: ['node'], permissions: ['admin.jobs.read'] },
    ] },
    ...extra,
  }));
  const sent: Sent[] = [];
  let i = 0;
  let k = 0;
  const withPost: ConsoleApi = { get: api.get, async post(path, body, key) { sent.push({ path, body, key }); return answers[i++] ?? { status: 200, code: null, body: { result: { outcome: 'applied' } } }; } };
  return { sent, port: createApiConsolePort({ api: withPost, siteHost: () => 'sandiego.example.org', engineVersion: '0.1.0', now: () => NOW, newKey: () => `key-${++k}` }) };
}
const refusedCode = (o: { status: string; code?: string }) => (o.status === 'rejected' ? o.code : o.status);
const invite = (fields: Record<string, string>) => settings('staff.invite', fields, null);

test('invitations: read from the API; a refused read is absent, never invented', async () => {
  const { port: p } = invitationPort(['admin.staff.read']);
  assert.deepEqual((await p.staffInvitations(HUB_ID))?.map((i) => i.email)[0], 'new-editor@example.invalid');
  const refused = port(staffRoutes({ [`/v1/admin/staff/invitations?hubId=${HUB_ID}`]: () => { throw new Failure(403); } }));
  assert.equal(await refused.port.staffInvitations(HUB_ID), null);
  const hidden = port(staffRoutes());
  assert.equal(await hidden.port.staffInvitations(HUB_ID), null, 'a not-found hub reads as nothing');
  await assert.rejects(port(staffRoutes({ [`/v1/admin/staff/invitations?hubId=${HUB_ID}`]: () => { throw new Failure(500); } })).port.staffInvitations(HUB_ID), /API 500/);
});

test('staff.invite: an address, a hub role from its latest definition and an optional length, through the invitation route', async () => {
  const { sent, port: p } = invitationPort(['admin.staff.assign', 'admin.staff.read'], [{ status: 201, code: null, body: { invitation: invitationList[0] } }, { status: 201, code: null, body: {} }]);
  assert.deepEqual(await p.command(live, invite({ email: ' New.Person@Example.invalid ', role: 'editor', validForDays: '' })), { status: 'applied' });
  assert.equal(sent[0]!.path, '/v1/admin/staff/invitations');
  assert.deepEqual([sent[0]!.body.email, sent[0]!.body.role, sent[0]!.body.scope, sent[0]!.body.definitionVersion, sent[0]!.body.validForSeconds, sent[0]!.body.reason],
    ['New.Person@Example.invalid', 'editor', { kind: 'hub', hubId: HUB_ID }, 3, null, 'Synthetic settings change']);
  assert.equal(sent[0]!.body.idempotencyKey, sent[0]!.key);
  // A sensitive role is offered through the invitation: the second person comes at apply.
  assert.deepEqual(await p.command(live, invite({ email: 'owner@example.invalid', role: 'compliance-officer', validForDays: '30' })), { status: 'applied' });
  assert.deepEqual([sent[1]!.body.role, sent[1]!.body.definitionVersion, sent[1]!.body.validForSeconds], ['compliance-officer', 2, 30 * 86_400]);
});

test('staff.invite: nothing leaves the console for a bad address, role, length, a duplicate or without the right to assign', async () => {
  const code = async (fields: Record<string, string>, permissions = ['admin.staff.assign', 'admin.staff.read']) => {
    const r = invitationPort(permissions);
    const outcome = await r.port.command(live, invite(fields));
    assert.deepEqual(r.sent, [], JSON.stringify(fields));
    return refusedCode(outcome as never);
  };
  assert.equal(await code({ email: 'not-an-address', role: 'editor' }), 'invalid');
  assert.equal(await code({ email: 'a@example.invalid', role: 'hub-owner' }), 'invalid', 'a role without a released definition');
  assert.equal(await code({ email: 'a@example.invalid', role: 'ops-engineer' }), 'invalid', 'a role not held at a hub');
  for (const validForDays of ['0', '367', '1.5', 'seven']) assert.equal(await code({ email: 'a@example.invalid', role: 'editor', validForDays }), 'invalid', validForDays);
  assert.equal(await code({ email: 'NEW-EDITOR@example.invalid', role: 'editor' }), 'invitation_open', 'one open invitation per address and role');
  assert.equal(await code({ email: 'a@example.invalid', role: 'editor' }, ['admin.staff.read']), 'denied');
  // An expired or closed invitation no longer blocks a new one.
  const again = invitationPort(['admin.staff.assign', 'admin.staff.read'], [{ status: 201, code: null, body: {} }, { status: 201, code: null, body: {} }]);
  assert.deepEqual(await again.port.command(live, invite({ email: 'late@example.invalid', role: 'editor' })), { status: 'applied' });
  assert.deepEqual(await again.port.command(live, invite({ email: 'closed@example.invalid', role: 'editor' })), { status: 'applied' });
});

test('staff.invite: the API has the last word; its reasons reach the person in their own words', async () => {
  const reason = (status: number, code: string, r: string) => ({ status, code, body: { code, details: { reason: r } } });
  const outcome = async (answer: { status: number; code: string | null; body?: unknown }) => {
    const { port: p } = invitationPort(['admin.staff.assign', 'admin.staff.read'], [answer]);
    return refusedCode(await p.command(live, invite({ email: 'a@example.invalid', role: 'editor' })) as never);
  };
  assert.equal(await outcome(reason(403, 'access.forbidden', 'self_grant')), 'self_grant', 'only the API knows the inviter\'s own addresses');
  assert.equal(await outcome(reason(409, 'validation.revision_conflict', 'invitation_open')), 'invitation_open', 'a concurrent invitation');
  assert.equal(await outcome({ status: 403, code: 'access.forbidden', body: { code: 'access.forbidden' } }), 'denied');
  assert.equal(await outcome({ status: 404, code: 'access.not_found', body: null }), 'not_found');
  assert.equal(await outcome({ status: 503, code: null, body: null }), 'invalid');
});

test('staff.invitation_apply: the inviter applies; a sensitive role answers pending_second_person first and the same call assigns once approved', async () => {
  const { sent, port: p } = invitationPort(['admin.staff.assign', 'admin.staff.read'], [{ status: 200, code: null, body: { result: { outcome: 'applied' }, invitation: invitationList[0] } }]);
  assert.deepEqual(await p.command(live, settings('staff.invitation_apply', { invitationId: INVITATION }, null)), { status: 'applied' });
  assert.equal(sent[0]!.path, `/v1/admin/staff/invitations/${INVITATION}/apply`);
  assert.deepEqual(Object.keys(sent[0]!.body).sort(), ['contractVersion', 'idempotencyKey', 'reason']);

  const first = invitationPort(['admin.staff.assign', 'admin.staff.read'], [{ status: 200, code: null, body: { result: { outcome: 'pending_second_person' }, invitation: invitationList[1] } }]);
  assert.deepEqual(await first.port.command(live, settings('staff.invitation_apply', { invitationId: SENSITIVE }, null)), { status: 'pending_second_person', secondPerson: 'staff.assign_sensitive_role' });

  const open = approval({ id: APPROVAL, action: 'staff.assign_sensitive_role', requestedBy: STAFF });
  const asked = invitation({ id: SENSITIVE, role: 'compliance-officer', sensitive: true, approvalId: APPROVAL });
  const waiting = invitationPort(['admin.staff.assign', 'admin.staff.read'], [], {
    [`/v1/admin/staff/invitations?hubId=${HUB_ID}`]: { invitations: [asked] }, [`/v1/admin/approvals?hubId=${HUB_ID}`]: { forMe: [], mine: [open], decided: [] },
  });
  assert.equal(refusedCode(await waiting.port.command(live, settings('staff.invitation_apply', { invitationId: SENSITIVE }, null)) as never), 'second_person_pending');
  assert.deepEqual(waiting.sent, [], 'no second call while a second person decides');

  const approved = invitationPort(['admin.staff.assign', 'admin.staff.read'], [{ status: 200, code: null, body: { result: { outcome: 'applied' } } }], {
    [`/v1/admin/staff/invitations?hubId=${HUB_ID}`]: { invitations: [asked] },
    [`/v1/admin/approvals?hubId=${HUB_ID}`]: { forMe: [], mine: [], decided: [approval({ id: APPROVAL, action: 'staff.assign_sensitive_role', requestedBy: STAFF, status: 'approved', approvedBy: OTHER, approvedAt: '2026-11-01T11:00:00.000Z', expiresAt: '2026-11-01T23:00:00.000Z' })] },
  });
  assert.deepEqual(await approved.port.command(live, settings('staff.invitation_apply', { invitationId: SENSITIVE }, null)), { status: 'applied' });
  assert.equal(approved.sent.length, 1);
});

test('staff.invitation_apply: refused before the API for anyone but the inviter, an unanswered, closed or expired invitation; node invitations are not found here', async () => {
  const code = async (invitationId: string, permissions = ['admin.staff.assign', 'admin.staff.read']) => {
    const r = invitationPort(permissions);
    const outcome = await r.port.command(live, settings('staff.invitation_apply', { invitationId }, null));
    assert.deepEqual(r.sent, [], invitationId);
    return refusedCode(outcome as never);
  };
  assert.equal(await code(SOMEONE_ELSES), 'not_inviter');
  assert.equal(await code(WAITING), 'invalid', 'nobody applies what the person has not accepted');
  assert.equal(await code(CLOSED), 'invitation_closed');
  assert.equal(await code(LATE), 'invitation_expired');
  assert.equal(await code(NODE_INVITATION), 'not_found');
  assert.equal(await code('99999999-9999-4999-8999-000000000000'), 'not_found');
  assert.equal(await code(INVITATION, ['admin.staff.read']), 'denied');
  const reason = (status: number, code: string, r: string) => ({ status, code, body: { code, details: { reason: r } } });
  const refused = async (answer: { status: number; code: string; body: unknown }) => {
    const { port: p } = invitationPort(['admin.staff.assign', 'admin.staff.read'], [answer]);
    return refusedCode(await p.command(live, settings('staff.invitation_apply', { invitationId: INVITATION }, null)) as never);
  };
  assert.equal(await refused(reason(403, 'access.approval_required', 'not_requester')), 'not_inviter');
  assert.equal(await refused(reason(403, 'access.approval_required', 'approval_not_approved')), 'second_person_pending');
  assert.equal(await refused(reason(409, 'validation.revision_conflict', 'invalid_transition')), 'invitation_closed', 'withdrawn in the meantime');
});

test('staff.invitation_withdraw: any open invitation at this hub through its route; closed ones and other scopes are not', async () => {
  const { sent, port: p } = invitationPort(['admin.staff.assign', 'admin.staff.read']);
  assert.deepEqual(await p.command(live, settings('staff.invitation_withdraw', { invitationId: SOMEONE_ELSES }, null)), { status: 'applied' }, 'not only the inviter');
  assert.equal(sent[0]!.path, `/v1/admin/staff/invitations/${SOMEONE_ELSES}/withdraw`);
  assert.equal(refusedCode(await p.command(live, settings('staff.invitation_withdraw', { invitationId: CLOSED }, null)) as never), 'invitation_closed');
  assert.equal(refusedCode(await p.command(live, settings('staff.invitation_withdraw', { invitationId: NODE_INVITATION }, null)) as never), 'not_found');
  assert.equal(sent.length, 1);
  const denied = invitationPort(['admin.staff.read']);
  assert.equal(refusedCode(await denied.port.command(live, settings('staff.invitation_withdraw', { invitationId: INVITATION }, null)) as never), 'denied');
  assert.deepEqual(denied.sent, []);
});

test('invitationStage: what the staff screen says about each invitation', () => {
  const stage = (overrides: Record<string, unknown>, requests: unknown[] = [], decisions: unknown[] = []) => invitationStage(invitation(overrides) as never, requests as never, decisions as never, NOW);
  assert.equal(stage({ status: 'pending' }), 'response');
  assert.equal(stage({ status: 'pending', expired: true }), 'expired');
  assert.equal(stage({ status: 'accepted' }), 'apply');
  assert.equal(stage({ status: 'accepted', expired: true }), 'expired');
  for (const status of ['declined', 'applied', 'withdrawn']) assert.equal(stage({ status }), status);
  const request = { id: APPROVAL, state: 'pending', expiresAt: '2026-11-02T00:00:00.000Z' };
  assert.equal(stage({ approvalId: APPROVAL }, [request]), 'second_person');
  assert.equal(stage({ approvalId: APPROVAL }, [{ ...request, expiresAt: '2026-11-01T00:00:00.000Z' }]), 'apply', 'an expired request is asked again');
  const decided = (expiresAt: string, revokedAt: string | null = null) => ({ requestId: APPROVAL, decision: 'approve', approval: { expiresAt, revokedAt } });
  assert.equal(stage({ approvalId: APPROVAL }, [], [decided('2026-11-02T00:00:00.000Z')]), 'approved');
  assert.equal(stage({ approvalId: APPROVAL }, [], [decided('2026-11-01T00:00:00.000Z')]), 'apply', 'an approval that lapsed asks again');
  assert.equal(stage({ approvalId: APPROVAL }, [], [decided('2026-11-02T00:00:00.000Z', '2026-11-01T01:00:00.000Z')]), 'apply');
  assert.equal(stage({ approvalId: APPROVAL }), 'apply', 'a declined request asks again');
});

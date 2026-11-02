import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
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
  assert.equal(await p.overview(HUB_ID), null);
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

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
  '/v1/admin/staff/definitions': { items: [{ role: 'hub-owner', permissions: ['admin.hub.read', 'admin.hub.identity.edit'] }, { role: 'editor', permissions: ['admin.notifications.read'] }] },
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
    [`/v1/admin/approvals?hubId=${HUB_ID}`]: { items: [
      approval(),
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
  assert.deepEqual(await p.command(live, { command: 'identity.save', reason: 'x', expectedRevision: 1, fields: {} } as never), { status: 'not_found' });
  assert.equal(await p.overview(HUB_ID), null);
  assert.equal(await p.product(HUB_ID), null);
  assert.equal(await p.setup('token'), null);
  assert.deepEqual(await p.legal(HUB_ID), { operator: null, documents: [] });
});

test('scan: the live adapter imports no fixture module', () => {
  const source = readFileSync(resolve('apps/web/app/admin/_data/api-adapter.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual(imports.filter((i) => /fixture|_fixtures/.test(i)), []);
});

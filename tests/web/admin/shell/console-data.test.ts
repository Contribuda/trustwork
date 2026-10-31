import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  consoleApprovalBinds,
  HUB_STAFF_ROLES,
  LAUNCH_GATES,
  modesViolations,
  staffAssignmentActive,
  type ConsolePermission,
} from '@trustwork/contracts/client';
import { isRestricted } from '@trustwork/country-packs';
import { canRead, permissionsFor, rolesFor, visibleGroups } from '../../../../apps/web/app/admin/_data/access.js';
import { APPROVER_PERMISSIONS, approvalBlocker, evaluateCommand, parseTerritory, type CommandContext, type CommandInput } from '../../../../apps/web/app/admin/_data/commands.js';
import { consolePort } from '../../../../apps/web/app/admin/_data/index.js';
import { elevationState } from '../../../../apps/web/app/admin/_data/elevation.js';
import { consoleHref, resolveConsoleRequest, STAFF_PERSONA_IDS } from '../../../../apps/web/app/admin/_data/personas.js';
import { GROUPS, SECTIONS, sectionByPath } from '../../../../apps/web/app/admin/_data/sections.js';
import { FIXTURE_NOW, HUB_SAMARKAND_ID, HUB_US_ID, NODE_ID } from '../../../../apps/web/app/admin/_fixtures/ids.js';
import { HUBS, OVERVIEWS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { DEMO_FRESH_SETUP_TOKEN, DEMO_SETUP_TOKEN } from '../../../../apps/web/app/admin/_fixtures/setup.js';
import { STAFF, STAFF_PERSONAS } from '../../../../apps/web/app/admin/_fixtures/staff.js';
import { APPROVAL_DECISIONS, APPROVAL_REQUESTS } from '../../../../apps/web/app/admin/hubs/[hub]/approvals/_fixtures.js';
import { LEGAL_DOCUMENTS, OPERATORS } from '../../../../apps/web/app/admin/hubs/[hub]/hub/legal/_fixtures.js';

/**
 * ADM-002: the console's fixtures parse with the frozen contract schemas (they are parsed at module load, so importing
 * them is already the check), the personas cover every role, authorization narrows navigation and commands, live mode
 * never reads the query, and the command evaluation enforces the contract invariants with negative cases.
 */

const now = new Date(FIXTURE_NOW);
const us = HUBS.find((h) => h.hub.id === HUB_US_ID)!;
const samarkand = HUBS.find((h) => h.hub.id === HUB_SAMARKAND_ID)!;
const usTarget = { nodeId: NODE_ID, hubId: HUB_US_ID };
const samTarget = { nodeId: NODE_ID, hubId: HUB_SAMARKAND_ID };
const person = (persona: keyof typeof STAFF_PERSONAS) => STAFF.people.find((p) => p.id === STAFF_PERSONAS[persona])!;

function ctx(persona: keyof typeof STAFF_PERSONAS, overrides: Partial<CommandContext> = {}, target = usTarget): CommandContext {
  const p = person(persona);
  return {
    viewer: { person: p, elevation: { state: 'elevated', until: '2026-10-31T12:30:00Z' } },
    access: { roles: rolesFor(STAFF, p.id, target, now), permissions: [...permissionsFor(STAFF, p.id, target, now)] },
    hub: target.hubId === HUB_US_ID ? us : samarkand,
    now,
    offline: false,
    requests: APPROVAL_REQUESTS,
    documents: LEGAL_DOCUMENTS,
    setup: null,
    isRestricted,
    ...overrides,
  };
}
const input = (command: CommandInput['command'], fields: Record<string, string> = {}, extra: Partial<CommandInput> = {}): CommandInput => ({
  command,
  hubSlug: 'us-demo',
  setupToken: null,
  reason: 'Synthetic test reason',
  expectedRevision: us.hub.revision,
  fields,
  ...extra,
});

test('fixtures are synthetic, cover both example hubs and use placeholder identifiers only', () => {
  assert.deepEqual(HUBS.map((h) => h.example).sort(), ['samarkand_example', 'us_reference']);
  for (const h of HUBS) {
    assert.equal(h.synthetic, true);
    assert.match(h.domain, /\.invalid$/);
    assert.equal(h.modes.dataMode, 'demo', 'the demo hubs carry demo data only');
    assert.deepEqual(modesViolations(h.hub.lifecycle, h.modes), [], `${h.hub.slug}: modes are consistent with the lifecycle`);
    assert.deepEqual(h.gates.map((g) => g.gate).sort(), [...LAUNCH_GATES].sort(), `${h.hub.slug}: every launch gate is present`);
    assert.ok(h.hub.territories.every((t) => !isRestricted(t.code.split(':')[0]!)), 'no restricted territory');
  }
  assert.ok(us.hub.territories.some((t) => t.code === 'US-CA:san-diego'), 'the US reference hub is San Diego (ADR 012 decision 31)');
  for (const o of OPERATORS) assert.match(o.identifier.value, /^0+[-0]*$/);
  assert.equal(OVERVIEWS.length, HUBS.length);
});

test('staff personas together hold every console role, and staff-none holds none', () => {
  const held = new Set(STAFF.assignments.filter((a) => staffAssignmentActive(a, now)).map((a) => a.role));
  assert.deepEqual([...HUB_STAFF_ROLES].filter((r) => !held.has(r)), []);
  assert.ok(STAFF_PERSONA_IDS.includes('staff-none'));
  const none = person('staff-none');
  assert.ok(STAFF.assignments.some((a) => a.personId === none.id), 'staff-none has a revoked assignment, to prove revocation ends access');
  assert.deepEqual(rolesFor(STAFF, none.id, usTarget, now), []);
  assert.equal(permissionsFor(STAFF, none.id, usTarget, now).size, 0);
});

test('scoped roles: a hub-scoped role covers only its hub; node and platform roles cover both', () => {
  assert.deepEqual(rolesFor(STAFF, person('hub-owner').id, usTarget, now), ['hub-owner']);
  assert.deepEqual(rolesFor(STAFF, person('hub-owner').id, samTarget, now), []);
  assert.deepEqual(rolesFor(STAFF, person('editor').id, samTarget, now), ['editor']);
  assert.deepEqual(rolesFor(STAFF, person('ops').id, samTarget, now), ['ops-engineer']);
  assert.ok(rolesFor(STAFF, person('auditor').id, samTarget, now).includes('auditor'));
  for (const persona of STAFF_PERSONA_IDS) {
    for (const permission of permissionsFor(STAFF, person(persona).id, usTarget, now)) {
      assert.ok(!['admin.node.hubs.manage', 'admin.node.keys.rotate'].includes(permission) || rolesFor(STAFF, person(persona).id, usTarget, now).includes('node-operator'), `${persona}: node-only ${permission}`);
    }
  }
});

test('navigation is filtered by read permission; every section has exactly one route', () => {
  const paths = SECTIONS.map((s) => s.section.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(sectionByPath('hub/identity')?.section.id, 'identity');
  assert.equal(sectionByPath('no/such'), null);
  const editor = permissionsFor(STAFF, person('editor').id, samTarget, now);
  const editorNav = visibleGroups(GROUPS, editor, true);
  assert.ok(editorNav.some((g) => g.id === 'home') && editorNav.some((g) => g.id === 'editorial'));
  assert.deepEqual(editorNav.find((g) => g.id === 'hub')?.sections.map((s) => s.id), ['taxonomy'], 'an editor at Samarkand sees taxonomy but not the other hub settings');
  assert.deepEqual(visibleGroups(GROUPS, new Set<ConsolePermission>(), false), [], 'no role, no navigation');
  for (const ref of SECTIONS) assert.equal(canRead(ref.section, new Set(), false), false);
  const auditorNav = visibleGroups(GROUPS, permissionsFor(STAFF, person('auditor').id, usTarget, now), true).flatMap((g) => g.sections.map((s) => s.id));
  assert.ok(auditorNav.includes('audit') && !auditorNav.includes('identity'));
});

test('live mode never reads the query; demo mode reads persona and scenario', () => {
  assert.deepEqual(resolveConsoleRequest({ persona: 'hub-owner', scenario: 'error' }, false), { demo: false });
  assert.deepEqual(resolveConsoleRequest(new URLSearchParams('persona=hub-owner'), true), { demo: true, persona: 'hub-owner', scenario: 'default' });
  assert.deepEqual(resolveConsoleRequest({ persona: 'mixed' }, true), { demo: true, persona: null, scenario: 'default' }, 'workspace personas are not staff');
  assert.equal(consoleHref('/admin/hubs/us-demo', { demo: false }), '/admin/hubs/us-demo');
  assert.equal(consoleHref('/admin/hubs/us-demo', { demo: true, persona: 'ops', scenario: 'offline' }), '/admin/hubs/us-demo?persona=ops&scenario=offline');
});

test('live mode: the unavailable adapter has no viewer, no hub, no setup run and answers every command with not_found', async () => {
  const live = consolePort(false);
  assert.equal(live.source, 'unavailable');
  assert.equal(await live.viewer({ demo: false }), null);
  assert.equal(await live.viewer({ demo: true, persona: 'hub-owner', scenario: 'default' }), null, 'even a forged demo request finds nobody');
  assert.equal(await live.hub('us-demo', { demo: false }), null);
  assert.equal(await live.setup(DEMO_SETUP_TOKEN), null);
  assert.deepEqual(await live.command({ demo: false }, input('identity.save')), { status: 'not_found' });
});

test('demo adapter: personas resolve, anonymous does not, setup runs open only with their token', async () => {
  const demo = consolePort(true);
  assert.equal(await demo.viewer({ demo: true, persona: null, scenario: 'default' }), null);
  assert.equal((await demo.viewer({ demo: true, persona: 'hub-owner', scenario: 'default' }))?.person.id, 'p-hub-owner');
  assert.equal((await demo.viewer({ demo: true, persona: 'hub-owner', scenario: 'elevation-required' }))?.elevation.state, 'required');
  assert.ok(await demo.setup(DEMO_SETUP_TOKEN));
  assert.ok(await demo.setup(DEMO_FRESH_SETUP_TOKEN));
  assert.equal(await demo.setup('wrong-token'), null);
  assert.equal(await demo.setup(''), null);
  assert.equal((await demo.hub('samarkand', { demo: true, persona: 'ops', scenario: 'maintenance' }))?.modes.maintenance, true);
  assert.equal((await demo.hub('us-demo', { demo: true, persona: 'ops', scenario: 'kill-switch-engaged' }))?.killSwitches[0]?.state, 'engaged');
});

test('negative authorization: commands without the permission, the role or an elevated session are refused', () => {
  assert.deepEqual(evaluateCommand(input('identity.save'), ctx('editor')), { status: 'rejected', code: 'denied', field: null, detail: [] });
  assert.equal((evaluateCommand(input('identity.save'), ctx('staff-none')) as { code: string }).code, 'denied');
  assert.equal((evaluateCommand(input('identity.save'), ctx('hub-owner', {}, samTarget)) as { code: string }).code, 'denied', 'a US hub owner cannot act on Samarkand');
  assert.equal((evaluateCommand(input('legal.request_activation', { documentId: 'ld-us-privacy-2' }), ctx('hub-owner')) as { code: string }).code, 'denied', 'activation needs admin.hub.legal.activate');
  const notElevated = ctx('hub-owner');
  notElevated.viewer = { ...notElevated.viewer!, elevation: { state: 'required' } };
  assert.equal((evaluateCommand(input('identity.save'), notElevated) as { code: string }).code, 'elevation_required');
  assert.equal((evaluateCommand(input('identity.save'), ctx('hub-owner', { offline: true })) as { code: string }).code, 'offline');
  assert.equal((evaluateCommand(input('identity.save', {}, { reason: '   ' }), ctx('hub-owner')) as { code: string }).code, 'reason_required');
  assert.deepEqual(evaluateCommand(input('identity.save'), ctx('hub-owner', { viewer: null })), { status: 'not_found' });
  assert.equal((evaluateCommand(input('killswitch.engage', { scope: 'hub_agent_dispatch' }), ctx('compliance')) as { code: string }).code, 'denied');
  assert.deepEqual(evaluateCommand(input('killswitch.engage', { scope: 'outbound_messages' }), ctx('ops')), { status: 'demo_not_saved', secondPerson: null });
});

test('optimistic concurrency: a command on an older revision is refused as stale', () => {
  assert.equal((evaluateCommand(input('identity.save', {}, { expectedRevision: us.hub.revision - 1 }), ctx('hub-owner')) as { code: string }).code, 'stale');
  assert.equal((evaluateCommand(input('identity.save', {}, { expectedRevision: null }), ctx('hub-owner')) as { code: string }).code, 'stale');
  assert.equal(evaluateCommand(input('identity.save'), ctx('hub-owner')).status, 'demo_not_saved');
});

test('restricted places are refused at country, region and place level, in the console and in the wizard', () => {
  for (const code of ['RU', 'UA-43', 'UA-43:sevastopol', 'KP']) {
    assert.equal((evaluateCommand(input('identity.save', { addTerritory: code }), ctx('hub-owner')) as { code: string }).code, 'territory_restricted', code);
  }
  assert.equal(evaluateCommand(input('identity.save', { addTerritory: 'US-TX:austin' }), ctx('hub-owner')).status, 'demo_not_saved');
  assert.equal((evaluateCommand(input('identity.save', { addTerritory: 'not a code' }), ctx('hub-owner')) as { code: string }).code, 'invalid');
  assert.equal(parseTerritory('US-TX')?.level, 'region');
  assert.equal((evaluateCommand(input('residency.request_change', { country: 'IR' }), ctx('compliance')) as { code: string }).code, 'territory_restricted');
});

test('lifecycle: transitions follow the contract, open gates block launch, and launch needs a second person', () => {
  assert.equal((evaluateCommand(input('lifecycle.request', { to: 'public' }), ctx('hub-owner')) as { code: string }).code, 'transition_not_allowed');
  const blocked = evaluateCommand(input('lifecycle.request', { to: 'soft_launch' }), ctx('hub-owner')) as { code: string; detail: string[] };
  assert.equal(blocked.code, 'gates_open');
  assert.ok(blocked.detail.includes('legal_documents_counsel_approved'), 'an invalidated gate blocks like an open one');
  const passedAll = { ...us, gates: us.gates.map((g) => ({ ...g, state: 'passed' as const, evidenceRef: 'ev', checkedBy: 'p-compliance', checkedAt: FIXTURE_NOW, invalidatedAt: null, invalidationReason: null })) };
  const demoData = evaluateCommand(input('lifecycle.request', { to: 'soft_launch' }), ctx('hub-owner', { hub: passedAll })) as { code: string; detail: string[] };
  assert.equal(demoData.code, 'modes_violation', 'demo data must be purged before soft launch');
  const live = { ...passedAll, modes: { ...passedAll.modes, dataMode: 'live' as const } };
  assert.deepEqual(evaluateCommand(input('lifecycle.request', { to: 'soft_launch' }), ctx('hub-owner', { hub: live })), { status: 'demo_not_saved', secondPerson: 'hub.transition_soft_launch' });
});

test('modes and modules keep the contract consistent', () => {
  assert.deepEqual((evaluateCommand(input('modes.save', { registration: 'open' }), ctx('hub-owner')) as { detail: string[] }).detail.sort(), ['open_registration_only_when_public', 'registration_closed_before_soft_launch']);
  assert.deepEqual(evaluateCommand(input('modes.save', { 'automation.editorial': 'supervised_autonomous' }), ctx('hub-owner')), { status: 'demo_not_saved', secondPerson: 'automation.raise_to_supervised_autonomous' });
  assert.deepEqual((evaluateCommand(input('modules.toggle', { module: 'expert_marketplace', enable: 'true' }), ctx('hub-owner')) as { detail: string[] }).detail, ['billing']);
  assert.deepEqual((evaluateCommand(input('modules.toggle', { module: 'publications', enable: 'false' }), ctx('hub-owner')) as { code: string; detail: string[] }).code, 'module_required_by');
  assert.deepEqual((evaluateCommand(input('modules.toggle', { module: 'federation', enable: 'true' }), ctx('hub-owner')) as { detail: string[] }).detail, ['demo_data_never_federated']);
});

test('legal activation needs counsel approval and every hub language, and a second person', () => {
  assert.equal((evaluateCommand(input('legal.request_activation', { documentId: 'ld-us-community-1' }), ctx('compliance')) as { code: string }).code, 'counsel_missing');
  const englishOnly = LEGAL_DOCUMENTS.map((d) => (d.id === 'ld-us-privacy-2' ? { ...d, locales: ['en'] } : d));
  assert.deepEqual((evaluateCommand(input('legal.request_activation', { documentId: 'ld-us-privacy-2' }), ctx('compliance', { documents: englishOnly })) as { detail: string[] }).detail, ['es']);
  assert.deepEqual(evaluateCommand(input('legal.request_activation', { documentId: 'ld-us-privacy-2' }), ctx('compliance')), { status: 'demo_not_saved', secondPerson: 'legal.activate_document_version' });
});

test('second-person approvals: never one\'s own, void when the action changed, expired after the deadline, bound to the digest', () => {
  const byId = (id: string) => APPROVAL_REQUESTS.find((r) => r.id === id)!;
  const owner = ctx('hub-owner');
  const legal = byId('rq-legal-privacy-2');
  assert.equal(approvalBlocker(legal, 'p-hub-owner', owner.access, now), null);
  assert.equal(approvalBlocker(legal, 'p-compliance', ctx('compliance').access, now), 'own_request');
  assert.equal(approvalBlocker(byId('rq-automation-editorial'), 'p-hub-owner', owner.access, now), 'request_void');
  assert.equal(approvalBlocker(byId('rq-fee-consultation'), 'p-hub-owner', owner.access, now), 'denied', 'the fee approval needs admin.billing.fees.activate');
  const commercialPeer = { roles: ['commercial-admin' as const], permissions: ['admin.billing.fees.activate' as const] };
  assert.equal(approvalBlocker(byId('rq-fee-consultation'), 'p-other', commercialPeer, now), 'request_expired');
  assert.equal((evaluateCommand(input('approvals.decide', { requestId: legal.id, decision: 'approve', digest: 'f'.repeat(64) }), owner) as { code: string }).code, 'digest_mismatch');
  assert.deepEqual(evaluateCommand(input('approvals.decide', { requestId: legal.id, decision: 'approve', digest: legal.actionDigest.value }), owner), { status: 'demo_not_saved', secondPerson: null });
  assert.equal((evaluateCommand(input('approvals.decide', { requestId: legal.id, decision: 'approve', digest: legal.actionDigest.value }), ctx('compliance')) as { code: string }).code, 'own_request');
  assert.equal((evaluateCommand(input('approvals.withdraw', { requestId: legal.id }), owner) as { code: string }).code, 'not_own_request');
  assert.equal(evaluateCommand(input('approvals.withdraw', { requestId: 'rq-role-compliance' }), owner).status, 'demo_not_saved');
  assert.deepEqual(evaluateCommand(input('approvals.decide', { requestId: 'rq-unknown', decision: 'approve', digest: 'x' }), owner), { status: 'not_found' });
  for (const action of Object.keys(APPROVER_PERMISSIONS)) assert.ok(APPROVER_PERMISSIONS[action as keyof typeof APPROVER_PERMISSIONS].length > 0);
});

test('recorded approvals bind their action, scope, digest and requester, never their approver', () => {
  const decided = APPROVAL_DECISIONS.find((d) => d.approval)!.approval!;
  const request = { action: decided.action, scope: decided.scope, actionDigest: decided.actionDigest, actorPersonId: decided.requestedBy };
  assert.equal(consoleApprovalBinds(decided, request, new Date('2026-10-12T15:00:00Z')), true);
  assert.equal(consoleApprovalBinds(decided, { ...request, actorPersonId: decided.approvedBy }, new Date('2026-10-12T15:00:00Z')), false);
  assert.equal(consoleApprovalBinds(decided, { ...request, actionDigest: { value: '0'.repeat(64) } }, new Date('2026-10-12T15:00:00Z')), false);
  assert.equal(consoleApprovalBinds(decided, request, now), false, 'expired');
});

test('setup wizard: token required, no skipping ahead, blocking install check, second factor, restricted places', () => {
  const demo = consolePort(true);
  return Promise.all([demo.setup(DEMO_SETUP_TOKEN), demo.setup(DEMO_FRESH_SETUP_TOKEN)]).then(([run, fresh]) => {
    const setupInput = (fields: Record<string, string>) => input('setup.save', fields, { hubSlug: null, reason: '', expectedRevision: null });
    const base = { ...ctx('staff-none'), viewer: null, hub: null };
    assert.deepEqual(evaluateCommand(setupInput({ step: 'install_check' }), { ...base, setup: null }), { status: 'not_found' });
    assert.equal((evaluateCommand(setupInput({ step: 'review' }), { ...base, setup: fresh }) as { code: string }).code, 'setup_blocked');
    assert.deepEqual((evaluateCommand(setupInput({ step: 'install_check' }), { ...base, setup: fresh }) as { detail: string[] }).detail, ['worker']);
    assert.equal((evaluateCommand(setupInput({ step: 'hub_identity', territory: 'UA-14' }), { ...base, setup: run }) as { code: string }).code, 'territory_restricted');
    assert.equal((evaluateCommand(setupInput({ step: 'node_identity', jurisdiction: 'CU' }), { ...base, setup: run }) as { code: string }).code, 'territory_restricted');
    assert.equal((evaluateCommand(setupInput({ step: 'first_admin', secondFactor: 'totp' }), { ...base, setup: run }) as { code: string }).code, 'second_factor_required');
    assert.equal(evaluateCommand(setupInput({ step: 'first_admin', secondFactor: 'webauthn', recoveryStored: 'on' }), { ...base, setup: run }).status, 'demo_not_saved');
    assert.equal(evaluateCommand(setupInput({ step: 'review' }), { ...base, setup: run }).status, 'demo_not_saved');
  });
});

test('every built section has its screen on the console route, and only built sections do', () => {
  const registry = readFileSync(resolve('apps/web/app/admin/_components/screens.ts'), 'utf8');
  for (const { group, section } of SECTIONS) {
    const folder = section.path ? `apps/web/app/admin/hubs/[hub]/${section.path}` : 'apps/web/app/admin/hubs/[hub]';
    const has = existsSync(resolve(folder, '_screen.tsx'));
    assert.equal(has, section.status === 'demo', `${group.id}.${section.id}: a screen exists exactly when the status is demo`);
    if (has) assert.ok(registry.includes(`'../hubs/[hub]${section.path ? `/${section.path}` : ''}/_screen'`), `${group.id}.${section.id} is registered in screens.ts`);
  }
});

test('the elevation gate follows BE-004 elevated sessions: own, unrevoked, started and unexpired only', () => {
  const at = new Date('2026-10-31T12:00:00Z');
  const record = { id: 'el-1', sessionId: 's-1', personId: 'p-hub-owner', factor: 'totp', createdAt: '2026-10-31T11:55:00Z', expiresAt: '2026-10-31T12:10:00Z', revokedAt: null };
  assert.deepEqual(elevationState(record, 'p-hub-owner', at), { state: 'elevated', until: '2026-10-31T12:10:00Z' });
  assert.equal(elevationState(record, 'p-editor', at).state, 'required', 'another person\'s elevation');
  assert.equal(elevationState({ ...record, revokedAt: '2026-10-31T11:58:00Z' }, 'p-hub-owner', at).state, 'required', 'revoked');
  assert.equal(elevationState(record, 'p-hub-owner', new Date('2026-10-31T12:10:00Z')).state, 'required', 'expired');
  assert.equal(elevationState({ ...record, expiresAt: '2026-10-31T14:00:00Z' }, 'p-hub-owner', at).state, 'required', 'longer than the contract allows');
  assert.equal(elevationState(null, 'p-hub-owner', at).state, 'required');
});

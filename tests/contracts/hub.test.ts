import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRestricted } from '@trustwork/country-packs';
import type { z } from 'zod';
import * as c from '../../packages/contracts/src/index.js';

/*
 * HUBC-000: every invariant of packages/contracts/src/hub.ts has a positive and a negative test. `ok` proves a valid
 * fixture parses; `bad` proves a single change breaks exactly the named invariant (by its message). The last tests
 * read hub.ts and fail if any refinement message or violation code was never produced by a negative test here.
 */

const hubSource = readFileSync(new URL('../../packages/contracts/src/hub.ts', import.meta.url), 'utf8');
const seenMessages = new Set<string>();
const seenCodes = new Set<string>();

function ok(schema: z.ZodType, value: unknown, label = 'valid fixture'): void {
  const r = schema.safeParse(value);
  assert.ok(r.success, `${label}: ${r.success ? '' : JSON.stringify(r.error.issues)}`);
}
function bad(schema: z.ZodType, value: unknown, message: string): void {
  const r = schema.safeParse(value);
  assert.equal(r.success, false, `expected failure: ${message}`);
  const messages = r.error!.issues.map((i) => i.message);
  assert.ok(messages.includes(message), `expected "${message}", got ${JSON.stringify(messages)}`);
  seenMessages.add(message);
}
/** Shape-level refusals (strict objects, enums, literals, regexes) where no refinement message is involved. */
function refused(schema: z.ZodType, value: unknown, label: string): void {
  assert.equal(schema.safeParse(value).success, false, label);
}
function codes(list: readonly string[]): readonly string[] {
  for (const code of list) seenCodes.add(code);
  return list;
}

const at = '2026-10-31T10:00:00Z';
const later = '2026-11-01T10:00:00Z';
const digest = { algorithm: 'trustwork-digest-1' as const, value: 'a'.repeat(64) };
const otherDigest = { algorithm: 'trustwork-digest-1' as const, value: 'c'.repeat(64) };
const sha = 'b'.repeat(64);
const V = c.HUB_CONSOLE_CONTRACT_VERSION;
const cmd = { contractVersion: V, idempotencyKey: 'idem-1', reason: 'Synthetic test reason' };

/* ---------- Hub, territory, lifecycle, launch gates, modes ---------- */

// US reference hub (owner decision 2026-10-31) with Spanish as the second language.
const usHub: c.Hub = {
  id: 'hub-us',
  nodeId: 'node-1',
  slug: 'us',
  name: { en: 'Trustwork United States', 'es-US': 'Trustwork Estados Unidos' },
  lifecycle: 'preparing',
  territories: [{ level: 'country', code: 'US' }, { level: 'region', code: 'US-TX' }, { level: 'place', code: 'US-TX:austin', wikidata: 'Q16559', osmRelation: null }],
  countryPack: null,
  defaultLocale: 'en',
  locales: ['en', 'es-US'],
  timeZone: 'America/Chicago',
  currency: 'USD',
  brandOverlay: null,
  revision: 1,
};

test('contract version: one frozen semantic version, carried by commands and results', () => {
  assert.match(c.HUB_CONSOLE_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  ok(c.HubConsoleContractVersionSchema, V);
  refused(c.HubConsoleContractVersionSchema, '0.9.0', 'another version is refused');
});

test('hub: locales, names and territory shapes; the US hub starts from the generic profile', () => {
  ok(c.HubSchema, usHub);
  bad(c.HubSchema, { ...usHub, defaultLocale: 'fr' }, 'default locale must be one of the hub locales');
  bad(c.HubSchema, { ...usHub, name: { en: 'Trustwork United States' } }, 'hub name is required in every hub locale');
  bad(c.HubSchema, { ...usHub, locales: ['en', 'en', 'es-US'] }, 'duplicate locale');
  bad(c.LocalizedNameSchema, {}, 'at least one locale');
  assert.ok(c.LocaleTagSchema.safeParse('uz-Latn').success && c.LocaleTagSchema.safeParse('es-419').success);
  refused(c.LocaleTagSchema, 'EN', 'upper-case language');
  const uz = { ...usHub, id: 'hub-uz', slug: 'uz-samarkand', name: { 'uz-Latn': 'Trustwork Samarqand', ru: 'Trustwork Samarkand' }, defaultLocale: 'uz-Latn', locales: ['uz-Latn', 'ru'], territories: [{ level: 'place', code: 'UZ-SA:samarkand', wikidata: null, osmRelation: null }], countryPack: { code: 'UZ', version: '1' }, timeZone: 'Asia/Samarkand', currency: 'UZS' };
  ok(c.HubSchema, uz, 'one non-US example proves the same shape');
});

test('restricted places are refused at country, region and place level and everywhere the console configures a place', () => {
  const t = (code: string): c.HubTerritory => (code.includes(':') ? { level: 'place', code, wikidata: null, osmRelation: null } : code.includes('-') ? { level: 'region', code } : { level: 'country', code });
  assert.equal(c.territoryRestricted(t('US-TX:austin'), isRestricted), false);
  assert.equal(c.territoryRestricted(t('RU'), isRestricted), true);
  assert.equal(c.territoryRestricted(t('UA-43'), isRestricted), true);
  assert.equal(c.territoryRestricted(t('UA-43:simferopol'), isRestricted), true, 'a place inside a restricted region is restricted');
  assert.equal(c.territoryRestricted(t('UA-30:kyiv'), isRestricted), false);
  assert.deepEqual(c.territoryCodes(t('US-TX:austin')), ['US', 'US-TX', 'US-TX:austin']);
  ok(c.JurisdictionCodeSchema, 'US-CA:los-angeles-county');
  refused(c.JurisdictionCodeSchema, 'us-ca', 'lower-case jurisdiction');
  assert.equal(c.jurisdictionRestricted('US-CA', isRestricted), false);
  for (const code of ['RU', 'UA-43', 'UA-40', 'UA-14', 'UA-09', 'CU', 'IR', 'KP', 'UA-14:mariupol']) assert.equal(c.jurisdictionRestricted(code, isRestricted), true, code);
  const clean = { territories: usHub.territories, jurisdictions: ['US-TX'], connections: [{ id: 'pc-1', hosting: { kind: 'vendor' as const, country: 'US', zeroRetention: true, trainsOnInputs: false, broker: false } }], extensions: [{ id: 'ext-1', endpoints: [{ host: 'api.example.org', country: 'US' }] }], paymentLicences: [{ connectionId: 'pc-pay', country: 'US' }] };
  assert.deepEqual(c.restrictedPlaceViolations(clean, isRestricted), []);
  assert.deepEqual(c.restrictedPlaceViolations({
    territories: [t('UA-43:simferopol')],
    jurisdictions: ['CU'],
    connections: [{ id: 'pc-ru', hosting: { kind: 'self_hosted', country: 'RU' } }],
    extensions: [{ id: 'ext-ir', endpoints: [{ host: 'api.example.org', country: 'US' }, { host: 'tools.example.net', country: 'IR' }] }],
    paymentLicences: [{ connectionId: 'pc-kp', country: 'KP' }],
  }, isRestricted), ['territory:UA-43:simferopol', 'jurisdiction:CU', 'connection:pc-ru', 'extension:ext-ir:tools.example.net', 'payment_provider:pc-kp']);
});

const passedGate = (gate: c.LaunchGateId): c.LaunchGate => ({ hubId: 'hub-us', gate, state: 'passed', evidenceRef: `ev-${gate}`, checkedBy: 'p-1', checkedAt: at, invalidatedAt: null, invalidationReason: null });
test('lifecycle transitions and launch gates: no waiver, invalidation blocks, public needs every gate', () => {
  assert.ok(c.hubTransitionAllowed('preparing', 'soft_launch'));
  assert.equal(c.hubTransitionAllowed('draft', 'public'), false);
  assert.equal(c.hubTransitionAllowed('closed', 'public'), false);
  ok(c.LaunchGateSchema, passedGate('i18n_complete'));
  ok(c.LaunchGateSchema, { ...passedGate('i18n_complete'), state: 'open', evidenceRef: null, checkedBy: null, checkedAt: null });
  bad(c.LaunchGateSchema, { ...passedGate('i18n_complete'), evidenceRef: null }, 'a passed gate records evidence, checker and time');
  refused(c.LaunchGateSchema, { ...passedGate('i18n_complete'), state: 'waived' }, 'no waiver state');
  const invalidated = { ...passedGate('legal_documents_counsel_approved'), state: 'invalidated' as const, invalidatedAt: later, invalidationReason: 'Privacy notice version expired' };
  ok(c.LaunchGateSchema, invalidated);
  bad(c.LaunchGateSchema, { ...invalidated, invalidationReason: null }, 'an invalidated gate records when and why, and only it does');
  bad(c.LaunchGateSchema, { ...passedGate('i18n_complete'), invalidatedAt: later, invalidationReason: 'x' }, 'an invalidated gate records when and why, and only it does');
  const soft = c.SOFT_LAUNCH_GATES.map(passedGate);
  assert.deepEqual(c.blockingGates('soft_launch', soft), []);
  assert.ok(c.blockingGates('public', soft).includes('backup_restore_exercised'));
  assert.deepEqual(c.blockingGates('public', c.LAUNCH_GATES.map(passedGate)), []);
  assert.deepEqual(c.blockingGates('public', [...c.LAUNCH_GATES.filter((g) => g !== 'legal_documents_counsel_approved').map(passedGate), invalidated]), ['legal_documents_counsel_approved'], 'invalidated blocks');
});

const modes: c.HubModes = {
  dataMode: 'demo',
  registration: 'closed',
  modules: ['publications', 'magazine', 'events', 'search'],
  moderation: 'pre_moderate_new_authors',
  automation: { editorial: 'assisted', translation: 'assisted', magazine_assembly: 'manual', data_mining: 'manual', entity_resolution: 'manual', verification_rechecks: 'assisted', moderation_triage: 'manual' },
  searchEngineIndexing: false,
  maintenance: false,
};
test('modes: demo data stays private and pre-launch; registration and indexing follow the lifecycle; module dependencies hold', () => {
  ok(c.HubModesSchema, modes);
  assert.deepEqual(c.modesViolations('preparing', modes), []);
  assert.deepEqual(c.modesViolations('public', { ...modes, dataMode: 'live', registration: 'open', searchEngineIndexing: true }), []);
  assert.ok(codes(c.modesViolations('soft_launch', modes)).includes('demo_data_only_before_soft_launch'));
  assert.ok(codes(c.modesViolations('preparing', { ...modes, searchEngineIndexing: true })).includes('demo_data_never_indexed'));
  assert.ok(codes(c.modesViolations('preparing', { ...modes, modules: [...modes.modules, 'federation'] })).includes('demo_data_never_federated'));
  assert.ok(codes(c.modesViolations('soft_launch', { ...modes, dataMode: 'live', registration: 'open' })).includes('open_registration_only_when_public'));
  assert.ok(codes(c.modesViolations('preparing', { ...modes, registration: 'invite_only' })).includes('registration_closed_before_soft_launch'));
  assert.ok(codes(c.modesViolations('draft', { ...modes, dataMode: 'live', searchEngineIndexing: true })).includes('indexing_only_after_launch'));
  assert.ok(c.modesViolations('public', { ...modes, dataMode: 'live', modules: ['sales'] }).includes('module_sales_requires_procurement'));
  assert.ok(c.modesViolations('public', { ...modes, dataMode: 'live', modules: ['expert_marketplace'] }).includes('module_expert_marketplace_requires_billing'));
  refused(c.HubModesSchema, { ...modes, automation: { ...modes.automation, editorial: 'autonomous' } }, 'no unsupervised level');
  assert.ok(c.HUMAN_GATES.includes('publication') && c.HUMAN_GATES.includes('dataset_activation') && c.HUMAN_GATES.includes('price_activation'));
});

/* ---------- One admin vocabulary, scoped staff and second-person approvals ---------- */

test('vocabulary: console permissions extend the frozen admin vocabulary; no permission sets a score, position, badge or weight', () => {
  const frozen = new Set<string>(c.ADMIN_PERMISSIONS);
  assert.ok(c.HUB_CONSOLE_PERMISSIONS.every((p) => !frozen.has(p) && /^admin\.[a-z_]+(\.[a-z_]+)+$/.test(p)));
  assert.equal(new Set(c.CONSOLE_PERMISSIONS).size, c.CONSOLE_PERMISSIONS.length, 'merged vocabulary has no duplicates');
  assert.equal(c.CONSOLE_PERMISSIONS.length, c.ADMIN_PERMISSIONS.length + c.HUB_CONSOLE_PERMISSIONS.length);
  ok(c.ConsolePermissionSchema, 'admin.audit.read');
  ok(c.ConsolePermissionSchema, 'admin.providers.secret.write');
  ok(c.ConsolePermissionSchema, 'admin.agents.extensions.activate');
  ok(c.ConsolePermissionSchema, 'admin.billing.fees.activate');
  ok(c.ConsolePermissionSchema, 'admin.hub.jurisdiction.activate');
  for (const p of c.CONSOLE_PERMISSIONS) assert.equal(c.FORBIDDEN_CONTROL_WORDS.test(p), false, p);
  for (const p of ['admin.ranking.edit', 'admin.reputation.score.set', 'admin.search.boost', 'admin.badges.grant', 'admin.matching.weight.edit', 'admin.directory.position.set']) refused(c.ConsolePermissionSchema, p, p);
});

test('vocabulary: second-person actions are the frozen A+2 set plus the console actions, including decisions 20-22', () => {
  assert.equal(new Set(c.CONSOLE_SECOND_PERSON_ACTIONS).size, c.CONSOLE_SECOND_PERSON_ACTIONS.length);
  for (const a of c.A_PLUS_2_ACTIONS) assert.ok(c.consoleActionNeedsSecondPerson(a), a);
  for (const a of ['hub.transition_public', 'billing.activate_fee_version', 'agents.activate_extension', 'jurisdiction.activate_settings', 'payments.change_settings', 'sponsored.enable', 'datasets.activate_court_or_debt', 'staff.grant_breakglass', 'kill_switch.release']) assert.ok(c.consoleActionNeedsSecondPerson(a), a);
  assert.equal(c.consoleActionNeedsSecondPerson('hub.edit_identity'), false);
  assert.equal(c.consoleActionNeedsSecondPerson('kill_switch.engage'), false, 'engaging a kill switch is one person');
});

test('staff scope: platform, node or hub; node-only permissions and roles stay at their scope', () => {
  ok(c.StaffScopeSchema, { kind: 'platform' });
  ok(c.StaffScopeSchema, { kind: 'node', nodeId: 'node-1' });
  refused(c.StaffScopeSchema, { kind: 'hub' }, 'a hub scope names its hub');
  refused(c.StaffScopeSchema, { kind: 'company', companyId: 'co-1' }, 'no company scope');
  assert.ok(c.permissionAllowedInScope('admin.node.keys.rotate', 'node'));
  assert.equal(c.permissionAllowedInScope('admin.node.keys.rotate', 'hub'), false);
  assert.ok(c.permissionAllowedInScope('admin.hub.read', 'hub'));
  assert.ok(c.roleAllowedInScope('editor', 'hub') && c.roleAllowedInScope('editor', 'platform'));
  assert.equal(c.roleAllowedInScope('node-operator', 'hub'), false);
  assert.equal(c.roleAllowedInScope('hub-owner', 'platform'), false);
  assert.ok(c.staffScopeCovers({ kind: 'platform' }, { nodeId: 'node-1', hubId: 'hub-us' }));
  assert.ok(c.staffScopeCovers({ kind: 'node', nodeId: 'node-1' }, { nodeId: 'node-1', hubId: 'hub-us' }));
  assert.equal(c.staffScopeCovers({ kind: 'node', nodeId: 'node-2' }, { nodeId: 'node-1', hubId: 'hub-us' }), false);
  assert.ok(c.staffScopeCovers({ kind: 'hub', hubId: 'hub-us' }, { nodeId: 'node-1', hubId: 'hub-us' }));
  assert.equal(c.staffScopeCovers({ kind: 'hub', hubId: 'hub-us' }, { nodeId: 'node-1', hubId: 'hub-uz' }), false, 'a hub role never reaches another hub');
  assert.equal(c.staffScopeCovers({ kind: 'hub', hubId: 'hub-us' }, { nodeId: 'node-1', hubId: null }), false, 'a hub role never acts on the node');
  assert.ok(c.sameStaffScope({ kind: 'hub', hubId: 'h' }, { kind: 'hub', hubId: 'h' }));
  assert.equal(c.sameStaffScope({ kind: 'hub', hubId: 'h' }, { kind: 'node', nodeId: 'h' }), false);
  assert.equal(c.sameStaffScope({ kind: 'platform' }, { kind: 'node', nodeId: 'n' }), false);
});

const roleDefinition: c.ScopedStaffRoleDefinition = {
  version: 1, role: 'editor', scopes: ['hub', 'node'], permissions: ['admin.publications.read', 'admin.editorial.items.review', 'admin.hub.read'],
  caps: { creditCapMinorUnits: null, grantMaxHours: 24 }, sodConflicts: ['trust-reviewer'], sodMode: 'reduced', releasedAt: at, releasedBy: 'p-1',
};
test('role definitions over the merged vocabulary', () => {
  ok(c.ScopedStaffRoleDefinitionSchema, roleDefinition);
  bad(c.ScopedStaffRoleDefinitionSchema, { ...roleDefinition, permissions: ['admin.hub.read', 'admin.hub.read'] }, 'each permission and scope once');
  bad(c.ScopedStaffRoleDefinitionSchema, { ...roleDefinition, role: 'node-operator', permissions: ['admin.node.keys.rotate'] }, 'the role definition names a scope the role cannot be held at');
  ok(c.ScopedStaffRoleDefinitionSchema, { ...roleDefinition, role: 'node-operator', scopes: ['node'], permissions: ['admin.node.keys.rotate'] });
  bad(c.ScopedStaffRoleDefinitionSchema, { ...roleDefinition, permissions: ['admin.ops.restore.execute'] }, 'node-only permissions are never granted inside a hub');
  bad(c.ScopedStaffRoleDefinitionSchema, { ...roleDefinition, sodConflicts: ['editor'] }, 'a role does not conflict with itself');
  refused(c.ScopedStaffRoleDefinitionSchema, { ...roleDefinition, permissions: ['admin.ranking.edit'] }, 'no ranking permission');
});

const assignment: c.ScopedStaffRoleAssignment = {
  id: 'a1', personId: 'p-2', role: 'editor', scope: { kind: 'hub', hubId: 'hub-us' }, definitionVersion: 1, grantedBy: 'p-1', approvedBy: null, reason: 'Editorial team',
  breakglass: false, incidentRef: null, validFrom: at, validUntil: null, revokedAt: null, revokedBy: null,
};
test('staff assignments: no self-grant; sensitive and break-glass roles need a distinct approver; scope fits the role; break-glass lasts hours', () => {
  ok(c.ScopedStaffRoleAssignmentSchema, assignment);
  ok(c.ScopedStaffRoleAssignmentSchema, { ...assignment, scope: { kind: 'platform' } }, 'ADR 012: the frozen platform scope remains');
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, grantedBy: 'p-2' }, 'nobody grants a staff role to themselves');
  const sensitive = 'sensitive and break-glass roles require a second approver distinct from the grantor and the holder';
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, role: 'hub-owner' }, sensitive);
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, role: 'compliance-officer', approvedBy: 'p-1' }, sensitive);
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, role: 'compliance-officer', approvedBy: 'p-2' }, sensitive);
  ok(c.ScopedStaffRoleAssignmentSchema, { ...assignment, role: 'compliance-officer', approvedBy: 'p-3' });
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, role: 'node-operator', approvedBy: 'p-3' }, 'the role cannot be held at this scope');
  ok(c.ScopedStaffRoleAssignmentSchema, { ...assignment, role: 'node-operator', approvedBy: 'p-3', scope: { kind: 'node', nodeId: 'node-1' } });
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, validUntil: at }, 'validUntil after validFrom');
  const glass = { ...assignment, role: 'ops-engineer' as const, breakglass: true, approvedBy: 'p-3', incidentRef: 'inc-7', validUntil: '2026-10-31T18:00:00Z' };
  ok(c.ScopedStaffRoleAssignmentSchema, glass);
  bad(c.ScopedStaffRoleAssignmentSchema, { ...glass, approvedBy: null }, sensitive);
  bad(c.ScopedStaffRoleAssignmentSchema, { ...glass, validUntil: later }, `break-glass names an incident and expires within ${c.BREAKGLASS_MAX_HOURS} hours`);
  bad(c.ScopedStaffRoleAssignmentSchema, { ...glass, incidentRef: null }, `break-glass names an incident and expires within ${c.BREAKGLASS_MAX_HOURS} hours`);
  bad(c.ScopedStaffRoleAssignmentSchema, { ...assignment, revokedAt: later }, 'revocation records who and when');
  assert.ok(c.staffAssignmentActive(assignment, new Date(later)));
  assert.equal(c.staffAssignmentActive(assignment, new Date('2026-10-30T00:00:00Z')), false, 'not before validFrom');
  assert.equal(c.staffAssignmentActive({ ...assignment, revokedAt: later, revokedBy: 'p-1' }, new Date(later)), false, 'revoked');
  assert.equal(c.staffAssignmentActive(glass, new Date('2026-10-31T19:00:00Z')), false, 'break-glass expired');
});

const approval: c.ConsoleSecondPersonApproval = {
  id: 'ap-1', action: 'billing.activate_fee_version', scope: { kind: 'hub', hubId: 'hub-us' }, actionDigest: digest, requestedBy: 'p-5', approvedBy: 'p-1', approvedAt: at, expiresAt: later, revokedAt: null,
};
test('second-person approvals bind one action, one scope, one digest, one requester; never self-approved, short-lived', () => {
  ok(c.ConsoleSecondPersonApprovalSchema, approval);
  bad(c.ConsoleSecondPersonApprovalSchema, { ...approval, approvedBy: 'p-5' }, 'actor must differ from approver');
  const window = `an approval expires within ${c.SECOND_PERSON_APPROVAL_MAX_HOURS} hours of approval`;
  bad(c.ConsoleSecondPersonApprovalSchema, { ...approval, expiresAt: '2026-11-10T10:00:00Z' }, window);
  bad(c.ConsoleSecondPersonApprovalSchema, { ...approval, expiresAt: at }, window);
  refused(c.ConsoleSecondPersonApprovalSchema, { ...approval, action: 'hub.edit_identity' }, 'only second-person actions are approved');
  const request = { action: approval.action, scope: approval.scope, actionDigest: digest, actorPersonId: 'p-5' };
  const now = new Date('2026-10-31T12:00:00Z');
  assert.ok(c.consoleApprovalBinds(approval, request, now));
  assert.equal(c.consoleApprovalBinds(approval, { ...request, actionDigest: otherDigest }, now), false, 'any change of the action invalidates it');
  assert.equal(c.consoleApprovalBinds(approval, { ...request, action: 'agents.activate_extension' }, now), false);
  assert.equal(c.consoleApprovalBinds(approval, { ...request, scope: { kind: 'hub', hubId: 'hub-uz' } }, now), false, 'never reused in another hub');
  assert.equal(c.consoleApprovalBinds(approval, { ...request, actorPersonId: 'p-1' }, now), false, 'the approver cannot execute what they approved');
  assert.equal(c.consoleApprovalBinds(approval, { ...request, actorPersonId: 'p-9' }, now), false, 'only the requester executes');
  assert.equal(c.consoleApprovalBinds(approval, request, new Date('2026-11-02T00:00:00Z')), false, 'expired');
  assert.equal(c.consoleApprovalBinds({ ...approval, revokedAt: at }, request, now), false, 'revoked');
  assert.equal(c.consoleApprovalBinds(approval, request, new Date('invalid')), false);
});

test('console audit events: merged vocabulary and scope; applied second-person actions record the approver', () => {
  const event: c.ConsoleAuditEvent = {
    id: 'ae-1', sequence: 7, occurredAt: at, actorPersonId: 'p-5', actorRole: 'commercial-admin', scope: { kind: 'hub', hubId: 'hub-us' }, permission: 'admin.billing.fees.activate',
    sessionElevationId: 'el-1', caseId: null, secondApproverPersonId: 'p-1', approvalDigest: digest, action: 'billing.activate_fee_version', objectType: 'marketplace_fee_version', objectId: 'fee-1',
    beforeDigest: null, afterDigest: digest, reasonCode: 'fee_change', reasonText: 'Consultation fee for electrical', outcome: 'applied', requestId: 'req-1', retentionClass: 'audit_long',
  };
  ok(c.ConsoleAuditEventSchema, event);
  ok(c.ConsoleAuditEventSchema, { ...event, outcome: 'denied', secondApproverPersonId: null, approvalDigest: null }, 'a denied attempt needs no approver');
  bad(c.ConsoleAuditEventSchema, { ...event, secondApproverPersonId: null }, 'applied second-person actions record the second approver and the approval digest');
  bad(c.ConsoleAuditEventSchema, { ...event, action: 'commerce.activate_price_version', approvalDigest: null }, 'applied second-person actions record the second approver and the approval digest');
  bad(c.ConsoleAuditEventSchema, { ...event, secondApproverPersonId: 'p-5' }, 'the actor is never their own second approver');
  bad(c.ConsoleAuditEventSchema, { ...event, permission: 'admin.node.keys.rotate' }, 'a node-only permission was used inside a hub');
  ok(c.ConsoleAuditEventSchema, { ...event, permission: 'admin.node.keys.rotate', scope: { kind: 'node', nodeId: 'node-1' }, actorRole: 'node-operator', action: 'ops.rotate_node_key' });
  refused(c.ConsoleAuditEventSchema, { ...event, before: { secret: 'x' } }, 'audit holds digests, never payloads');
});

/* ---------- Versioned configuration ---------- */

const configVersion: c.HubConfigVersion = { id: 'cv1', hubId: 'hub-us', domain: 'modes', version: 2, payloadDigest: digest, status: 'active', reason: 'Enable events', draftedBy: 'p-1', activatedBy: 'p-1', activatedAt: at, approvalId: null, effectiveFrom: at };
test('config versions: sensitive domains (now including jurisdiction, payments and extensions) need approval and a different activator; no back-dating', () => {
  ok(c.HubConfigVersionSchema, configVersion);
  ok(c.HubConfigVersionSchema, { ...configVersion, status: 'draft', activatedBy: null, activatedAt: null, effectiveFrom: null });
  bad(c.HubConfigVersionSchema, { ...configVersion, activatedAt: null }, 'activated versions record activator, time and effective date');
  bad(c.HubConfigVersionSchema, { ...configVersion, effectiveFrom: '2026-10-30T10:00:00Z' }, 'effectiveFrom cannot precede activation (no back-dating)');
  for (const domain of ['jurisdiction', 'payments', 'agent_extensions', 'residency', 'egress'] as const) {
    assert.ok(c.SENSITIVE_CONFIG_DOMAINS.includes(domain), domain);
    bad(c.HubConfigVersionSchema, { ...configVersion, domain }, 'sensitive domains are activated by a different person under a second-person approval');
    bad(c.HubConfigVersionSchema, { ...configVersion, domain, approvalId: 'ap-1' }, 'sensitive domains are activated by a different person under a second-person approval');
    ok(c.HubConfigVersionSchema, { ...configVersion, domain, activatedBy: 'p-2', approvalId: 'ap-1' });
  }
  for (const domain of ['tax', 'jurisdiction', 'payments', 'agent_extensions']) ok(c.HubConfigDomainSchema, domain);
});

/* ---------- Secrets ---------- */

const secretRef: c.SecretRef = { id: 's1', store: 'envelope_db', ref: 'hub-us/providers/openai/api-key', keyedFingerprint: '0123456789ab', version: 1, createdAt: at, createdBy: 'p-1', rotatedAt: null, lastUsedAt: null };
test('secrets: references only; the write-only submit command is the one place a value appears and its result is a reference', () => {
  ok(c.SecretRefSchema, secretRef);
  for (const value of ['sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'sk_live_51Habcdefghijklmnop', 'AKIAIOSFODNN7EXAMPLE', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Zx9vQ2mL8kP4nR7tY1wE5uI3oA6sD0fG2hJ']) {
    assert.ok(c.looksLikeSecretValue(value), value);
    bad(c.SecretRefSchema, { ...secretRef, ref: value }, 'ref must name a secret, not contain one');
  }
  assert.equal(c.looksLikeSecretValue('hub-us/providers/openai/api-key'), false);
  refused(c.SecretRefSchema, { ...secretRef, value: 'sk-123' }, 'strict: no value field');
  const submit = { ...cmd, connectionId: 'pc1', value: 'synthetic-test-only-value', expectedRevision: 1 };
  ok(c.SecretSubmitCommandSchema, submit);
  refused(c.SecretSubmitCommandSchema, { ...submit, contractVersion: '0.1.0' }, 'versioned');
  refused(c.SecretSubmitCommandSchema, { ...submit, idempotencyKey: undefined }, 'idempotent');
  refused(c.SecretSubmitCommandSchema, { ...submit, echo: true }, 'strict');
  ok(c.SecretSubmitResultSchema, { contractVersion: V, secretRef, connectionRevision: 4 });
  refused(c.SecretSubmitResultSchema, { contractVersion: V, secretRef, connectionRevision: 4, value: submit.value }, 'the result never echoes the value');
});

/* ---------- Providers, routing, egress, budgets, kill switches ---------- */

const openai: c.ProviderConnection = {
  id: 'pc-openai', scope: { kind: 'hub', hubId: 'hub-us' }, adapterId: 'openai', label: 'OpenAI', capabilities: ['llm', 'embeddings'], mode: 'live', endpoint: 'https://api.openai.com/v1',
  secretRef, hosting: { kind: 'vendor', country: 'US', zeroRetention: true, trainsOnInputs: false, broker: false }, status: 'enabled',
  lastTest: { at, by: 'p-1', outcome: 'ok', latencyMs: 420, modelsListed: 12, cost: { minorUnits: '1', currency: 'USD' }, syntheticInputOnly: true }, enabledBy: 'p-2', approvalId: 'ap-2', revision: 3,
};
const ollama: c.ProviderConnection = { ...openai, id: 'pc-local', adapterId: 'openai_compatible', label: 'Local models', endpoint: 'http://10.0.0.5:11434/v1', secretRef: null, hosting: { kind: 'self_hosted', country: 'US' } };
test('provider connections: live needs secret and second person, http only self-hosted, enable after a passing test', () => {
  ok(c.ProviderConnectionSchema, openai);
  ok(c.ProviderConnectionSchema, ollama, 'local endpoint without a key');
  ok(c.ProviderConnectionSchema, { ...openai, mode: 'fake', secretRef: null, enabledBy: null, approvalId: null }, 'fakes need no approval');
  bad(c.ProviderConnectionSchema, { ...openai, secretRef: null }, 'live vendor connections need a secret reference');
  bad(c.ProviderConnectionSchema, { ...openai, approvalId: null }, 'enabling a non-fake provider needs a second-person approval');
  bad(c.ProviderConnectionSchema, { ...openai, endpoint: 'http://api.example.com' }, 'plain http only for self-hosted endpoints');
  bad(c.ProviderConnectionSchema, { ...openai, lastTest: { ...openai.lastTest!, outcome: 'auth_failed' } }, 'enable only after a successful connection test');
  bad(c.ProviderConnectionSchema, { ...openai, mode: 'fake' }, 'fake adapters never hold secrets');
  refused(c.ConnectionTestResultSchema, { ...openai.lastTest, syntheticInputOnly: false }, 'tests use synthetic input only');
  ok(c.ModelPricingSchema, { connectionId: 'pc-openai', modelId: 'model-a', currency: 'USD', inputPerMillionTokens: '2.5', outputPerMillionTokens: '10', perImage: null, perAudioMinute: null, basis: 'provider_list', observedAt: at });
  refused(c.ModelPricingSchema, { connectionId: 'pc-openai', modelId: 'model-a', currency: 'USD', inputPerMillionTokens: 2.5, outputPerMillionTokens: null, perImage: null, perAudioMinute: null, basis: 'provider_list', observedAt: at }, 'prices are exact decimal strings');
});

const route: c.ModelRoute = {
  id: 'r1', hubId: 'hub-us', job: 'editorial_rewrite', version: 1, primary: { connectionId: 'pc-openai', modelId: 'model-a', modelRevision: null },
  fallbacks: [{ connectionId: 'pc-local', modelId: 'model-b', modelRevision: null }], allowedDataClasses: ['public'],
  limits: { maxInputTokens: 16000, maxOutputTokens: 2000, timeoutMs: 60000 }, budgetId: 'b1', status: 'active', draftedBy: 'p-1', activatedBy: 'p-1', approvalId: null,
};
test('model routes: no repeated fallbacks, embeddings never mix, images public only, private routes need two people', () => {
  ok(c.ModelRouteSchema, route);
  bad(c.ModelRouteSchema, { ...route, fallbacks: [route.primary] }, 'fallback repeats the primary');
  bad(c.ModelRouteSchema, { ...route, fallbacks: [route.fallbacks[0], route.fallbacks[0]] }, 'duplicate fallback');
  bad(c.ModelRouteSchema, { ...route, job: 'embeddings' }, 'embedding vectors never mix models: no fallbacks');
  ok(c.ModelRouteSchema, { ...route, job: 'embeddings', fallbacks: [] });
  bad(c.ModelRouteSchema, { ...route, job: 'image_generation', fallbacks: [], allowedDataClasses: ['public', 'person_private'] }, 'image prompts may contain public data only');
  bad(c.ModelRouteSchema, { ...route, activatedBy: null }, 'active routes record the activator');
  bad(c.ModelRouteSchema, { ...route, job: 'agent_reasoning', allowedDataClasses: ['public', 'deal_party_private'] }, 'routes that may carry non-public data need a second person');
  bad(c.ModelRouteSchema, { ...route, job: 'agent_reasoning', allowedDataClasses: ['public', 'deal_party_private'], approvalId: 'ap-3' }, 'routes that may carry non-public data need a second person');
  ok(c.ModelRouteSchema, { ...route, job: 'agent_reasoning', allowedDataClasses: ['public', 'deal_party_private'], activatedBy: 'p-2', approvalId: 'ap-3' });
});

const egressRule = (o: Partial<c.EgressRule>): c.EgressRule => ({ hubId: 'hub-us', connectionId: 'pc-openai', dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, version: 1, approvalId: null, ...o });
test('egress: private data is denied by default; allowing it needs two people, residency and zero retention; never to vendors that train', () => {
  const input = { connection: openai, dataClass: 'person_private' as const, residencyCountry: 'US' };
  for (const dataClass of ['person_private', 'company_private', 'project_restricted', 'deal_party_private'] as const) {
    assert.deepEqual(c.egressDecision([], { ...input, dataClass }), { allowed: false, reason: 'no_rule' }, `${dataClass} denied with no rule`);
    assert.deepEqual(c.egressDecision([egressRule({})], { ...input, dataClass }), { allowed: false, reason: 'no_rule' }, `a public rule does not cover ${dataClass}`);
  }
  assert.deepEqual(c.egressDecision([egressRule({})], { ...input, dataClass: 'public' }), { allowed: true, reason: 'allowed' });
  const allowPrivate = 'allowing non-public data needs a second person, in-residency processing and zero retention';
  bad(c.EgressRuleSchema, egressRule({ dataClass: 'person_private' }), allowPrivate);
  bad(c.EgressRuleSchema, egressRule({ dataClass: 'person_private', approvalId: 'ap-4', requireZeroRetention: true }), allowPrivate);
  ok(c.EgressRuleSchema, egressRule({ dataClass: 'person_private', decision: 'deny' }), 'an explicit deny needs nothing');
  const priv = egressRule({ dataClass: 'person_private', requireInResidency: true, requireZeroRetention: true, approvalId: 'ap-4' });
  ok(c.EgressRuleSchema, priv);
  assert.deepEqual(c.egressDecision([priv], input), { allowed: true, reason: 'allowed' });
  assert.deepEqual(c.egressDecision([priv], { ...input, residencyCountry: 'UZ' }), { allowed: false, reason: 'residency' });
  assert.deepEqual(c.egressDecision([priv], { ...input, connection: { ...openai, hosting: { kind: 'vendor', country: 'US', zeroRetention: false, trainsOnInputs: false, broker: true } } }), { allowed: false, reason: 'retention' });
  assert.deepEqual(c.egressDecision([priv], { ...input, connection: { ...openai, hosting: { kind: 'vendor', country: 'US', zeroRetention: true, trainsOnInputs: true, broker: false } } }), { allowed: false, reason: 'training' });
  assert.deepEqual(c.egressDecision([priv, { ...priv, version: 2, decision: 'deny' }], input), { allowed: false, reason: 'denied' }, 'latest version wins');
  assert.deepEqual(c.egressDecision([priv], { ...input, connection: { ...openai, status: 'killed' } }), { allowed: false, reason: 'connection_not_enabled' });
});

test('budgets, usage, kill switches and cohort suppression', () => {
  const b: c.ProviderBudget = { id: 'b1', hubId: 'hub-us', scope: { kind: 'job', job: 'translation' }, period: 'month', limit: { minorUnits: '50000', currency: 'USD' }, alertAtPercent: [50, 80], onExhausted: 'pause', revision: 1 };
  ok(c.ProviderBudgetSchema, b);
  assert.equal(c.providerBudgetState(b, '1000'), 'ok');
  assert.equal(c.providerBudgetState(b, '40000'), 'alert');
  assert.equal(c.providerBudgetState(b, '50000'), 'exhausted');
  assert.equal(c.providerBudgetState({ ...b, limit: { minorUnits: '0', currency: 'USD' } }, '0'), 'exhausted', 'a zero cap blocks everything');
  refused(c.ProviderBudgetSchema, { ...b, onExhausted: 'allow_overspend' }, 'no overspend state');
  const usage = { hubId: 'hub-us', from: at, to: later, job: 'translation', connectionId: 'pc-openai', modelId: 'model-a', pipelineId: null, moduleKey: null, calls: 3, inputTokens: 900, outputTokens: 300, images: 0, audioSeconds: 0, cost: { minorUnits: '4', currency: 'USD' } };
  ok(c.UsageAggregateSchema, usage);
  bad(c.UsageAggregateSchema, { ...usage, to: at }, 'to after from');
  const k: c.KillSwitch = { id: 'k1', scope: { kind: 'hub_agent_dispatch', hubId: 'hub-us' }, state: 'engaged', engagedBy: 'p-1', engagedAt: at, reason: 'Injection campaign', releasedBy: null, releasedAt: null, releaseApprovalId: null, incidentNote: null };
  ok(c.KillSwitchSchema, k);
  ok(c.KillSwitchSchema, { ...k, scope: { kind: 'agent_extension', hubId: 'hub-us', extensionId: 'ext-1' } }, 'an extension has its own switch');
  bad(c.KillSwitchSchema, { ...k, state: 'released', releasedBy: 'p-2', releasedAt: later, releaseApprovalId: 'ap-5' }, 'release records who, when, the approval and an incident note');
  ok(c.KillSwitchSchema, { ...k, state: 'released', releasedBy: 'p-2', releasedAt: later, releaseApprovalId: 'ap-5', incidentNote: 'INC-7 reviewed' });
  assert.equal(c.suppressSmallCount(9), null);
  assert.equal(c.suppressSmallCount(10), 10);
  assert.equal(c.suppressSmallCount(10.5), null);
});

/* ---------- Sources, datasets, links ---------- */

const source: c.HubSource = {
  id: 'src-sam', hubId: 'hub-us', kind: 'api', name: 'SAM.gov contract opportunities', url: 'https://sam.gov/', purposes: ['opportunities'],
  licence: { kind: 'statutory_public', name: 'US federal public data', url: null, agreementRef: null }, robots: null, terms: null,
  allowedUses: { displayHeadlineAndLink: true, displaySummary: true, storeFullText: true, indexForSearch: true, sendToModelProviders: true, translate: true, rewriteWithAttribution: true, reuseImages: false, syndicateToPeers: true },
  attributionTemplate: 'Source: SAM.gov', takedownContact: 'data steward', ownerPersonId: 'p-3', personalData: false, legalBasis: null,
  proposedBy: { kind: 'pipeline', pipelineId: 'pl-disc', runId: 'run-1' }, status: 'active', activatedBy: 'p-3', activatedAt: at, pauseReason: null, revision: 2,
};
test('sources: pipelines propose, people activate; crawling needs robots and terms; no licence means headline and link', () => {
  ok(c.HubSourceSchema, source);
  bad(c.HubSourceSchema, { ...source, activatedBy: null }, 'only a person activates a source');
  bad(c.HubSourceSchema, { ...source, kind: 'web_page' }, 'crawling needs robots permission and terms that permit automated access, both recorded');
  const robots = { checkedAt: at, robotsUrl: 'https://example.org/robots.txt', userAgent: 'TrustworkBot', allowed: true, crawlDelaySeconds: 10, robotsDigest: sha };
  const terms = { checkedAt: at, termsUrl: 'https://example.org/terms', termsDigest: sha, automatedAccess: 'permitted' as const, reviewedBy: 'p-3', notes: '' };
  ok(c.HubSourceSchema, { ...source, kind: 'web_page', robots, terms });
  bad(c.HubSourceSchema, { ...source, kind: 'web_page', robots, terms: { ...terms, automatedAccess: 'unclear' } }, 'crawling needs robots permission and terms that permit automated access, both recorded');
  bad(c.HubSourceSchema, { ...source, kind: 'sitemap', robots: { ...robots, allowed: false }, terms }, 'crawling needs robots permission and terms that permit automated access, both recorded');
  const unlicensed = { ...source, licence: { kind: 'unknown' as const, name: null, url: null, agreementRef: null } };
  bad(c.HubSourceSchema, unlicensed, 'without a licence only headline, link, short summary and search indexing are possible');
  ok(c.HubSourceSchema, { ...unlicensed, allowedUses: { ...source.allowedUses, storeFullText: false, sendToModelProviders: false, translate: false, rewriteWithAttribution: false, syndicateToPeers: false } });
  bad(c.HubSourceSchema, { ...source, allowedUses: { ...source.allowedUses, storeFullText: false } }, 'rewriting needs the stored text it is checked against');
  bad(c.HubSourceSchema, { ...source, personalData: true }, 'personal data needs a recorded legal basis');
  ok(c.HubSourceSchema, { ...source, personalData: true, legalBasis: 'statutory_public_register' });
  bad(c.HubSourceSchema, { ...source, status: 'paused' }, 'a paused source says why');
  ok(c.HubSourceSchema, { ...source, status: 'paused', pauseReason: 'robots_changed' });
});

const dataset: c.Dataset = {
  id: 'ds-lic', hubId: 'hub-us', subject: 'licences_permits', name: 'Texas TDLR licence holders (candidate)', sourceIds: ['src-tdlr'], purpose: 'Licence checks for verification and eligibility',
  legalBasis: 'statutory_public_register', personalData: { present: true, naturalPersons: true, categories: ['name', 'licence_number'] }, impactAssessmentRef: null,
  retention: { className: 'register_mirror', days: 400 }, outputs: ['verification_evidence', 'matching_eligibility'], publicDisplay: false, subjectNotice: true,
  refreshScheduleId: 'sch-1', status: 'active', activatedBy: 'p-3', approvalId: 'ap-6', version: 1,
};
test('datasets: legal flags per subject, no reputation output, personal data and court or debt data need two people', () => {
  ok(c.DatasetSchema, dataset);
  bad(c.DatasetSchema, { ...dataset, approvalId: null }, 'activation by a person; personal-data datasets need a second person');
  refused(c.DatasetSchema, { ...dataset, outputs: ['reputation'] }, 'reputation is not an output');
  const court = { ...dataset, subject: 'court_cases' as const, outputs: ['verification_evidence' as const], personalData: { present: true, naturalPersons: true, categories: ['court_party' as const] } };
  bad(c.DatasetSchema, court, 'court, debt and people datasets need a recorded impact assessment');
  ok(c.DatasetSchema, { ...court, impactAssessmentRef: 'dpia-1' });
  bad(c.DatasetSchema, { ...court, impactAssessmentRef: 'dpia-1', publicDisplay: true }, 'court and debt records about natural persons are never displayed and serve only as reviewed verification evidence');
  bad(c.DatasetSchema, { ...court, impactAssessmentRef: 'dpia-1', outputs: ['verification_evidence', 'knowledge_base'] }, 'court and debt records about natural persons are never displayed and serve only as reviewed verification evidence');
  bad(c.DatasetSchema, { ...dataset, subject: 'people', legalBasis: 'legitimate_interest_assessed', impactAssessmentRef: 'dpia-2', outputs: ['verification_evidence'] }, 'people data needs consent or public professional data and never creates public profiles');
  bad(c.DatasetSchema, { ...dataset, subject: 'court_cases', impactAssessmentRef: 'dpia-1', personalData: { present: false, naturalPersons: false, categories: [] }, outputs: ['matching_eligibility'] }, 'matching eligibility comes only from company status and licences');
  bad(c.DatasetSchema, { ...dataset, personalData: { present: true, naturalPersons: false, categories: [] } }, 'name the personal data categories');
  const companyDebts = { ...dataset, subject: 'debts_tax_arrears' as const, impactAssessmentRef: 'dpia-3', personalData: { present: false, naturalPersons: false, categories: [] }, outputs: ['verification_evidence' as const], approvalId: null };
  assert.deepEqual(c.OFF_BY_DEFAULT_DATASET_SUBJECTS, ['court_cases', 'debts_tax_arrears']);
  bad(c.DatasetSchema, companyDebts, 'court and debt datasets are off by default; turning one on needs a second person');
  ok(c.DatasetSchema, { ...companyDebts, approvalId: 'ap-12' });
  ok(c.DatasetSchema, { ...companyDebts, status: 'proposed', activatedBy: null }, 'proposed needs nothing yet');
});

test('entity links: always a link, decided by a person; people need their own confirmation; evidence carries similarity, not a score', () => {
  const l: c.LinkProposal = { id: 'l1', hubId: 'hub-us', left: { kind: 'company', id: 'co-1' }, right: { kind: 'sourced_record', id: 'sr-9' }, evidence: [{ kind: 'identifier_match', detail: 'EIN matches', similarity: '1' }], confidence: '0.98', proposedBy: { kind: 'pipeline', pipelineId: 'pl-er', runId: 'run-2' }, status: 'proposed', decidedBy: null, decidedAt: null, effect: 'link' };
  ok(c.LinkProposalSchema, l);
  refused(c.LinkProposalSchema, { ...l, effect: 'merge' }, 'never a merge');
  refused(c.LinkProposalSchema, { ...l, evidence: [{ kind: 'identifier_match', detail: 'x', score: '1' }] }, 'no score field');
  bad(c.LinkProposalSchema, { ...l, status: 'accepted' }, 'a person decides');
  bad(c.LinkProposalSchema, { ...l, right: l.left }, 'cannot link a record to itself');
  bad(c.LinkProposalSchema, { ...l, confidence: '1.5' }, 'decimal between 0 and 1');
  const person = { ...l, left: { kind: 'person' as const, id: 'p-9' }, status: 'accepted' as const, decidedBy: 'p-3', decidedAt: at };
  bad(c.LinkProposalSchema, person, 'a person is linked only with their own confirmation');
  ok(c.LinkProposalSchema, { ...person, evidence: [...l.evidence, { kind: 'subject_confirmation', detail: 'Confirmed by the person', similarity: null }] });
});

/* ---------- Schedules, pipelines, runs, editorial items ---------- */

const schedule: c.Schedule = {
  id: 'sch-1', hubId: 'hub-us', pipelineId: 'pl-1', cron: '15 2 * * 1-5', timeZone: 'America/Chicago', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '01:00', to: '05:00' }], jitterSeconds: 300,
  quotas: { maxItemsPerRun: 500, maxRunsPerDay: 1, maxCostPerRun: { minorUnits: '500', currency: 'USD' }, maxRequestsPerMinutePerHost: 30 },
  retry: { maxAttempts: 3, backoff: 'exponential', baseSeconds: 60, maxDelaySeconds: 3600, retryOn: ['network', 'server_error'] }, concurrency: 1,
  alerts: [{ kind: 'zero_items_streak', threshold: 3, notify: 'console' }], paused: false, pausedBy: null, pausedReason: null, revision: 1,
};
test('schedules: cron shape, windows, bounded retries, paused needs a reason', () => {
  ok(c.ScheduleSchema, schedule);
  ok(c.ScheduleSchema, { ...schedule, cron: '*/15 0-6 1,15 * *' });
  for (const cron of ['* * * *', '@daily', '61 * * * * *']) refused(c.ScheduleSchema, { ...schedule, cron }, cron);
  bad(c.CronExpressionSchema, 'a b c d e', 'five-field cron expression');
  refused(c.ScheduleSchema, { ...schedule, retry: { ...schedule.retry, maxAttempts: 50 } }, 'bounded retries');
  bad(c.ScheduleSchema, { ...schedule, paused: true }, 'a paused schedule records who and why');
  ok(c.ScheduleSchema, { ...schedule, paused: true, pausedBy: 'p-1', pausedReason: 'Source maintenance' });
  bad(c.ScheduleSchema, { ...schedule, windows: [{ days: ['mon'], from: '02:00', to: '02:00' }] }, 'a window needs a non-empty span');
});

const step = (kind: c.PipelineStepKind, job: c.ModelJob | null = null): c.PipelineStep => ({ kind, modelRouteId: job ? `route-${job}` : null, modelJob: job, settings: {} });
const pipeline: c.PipelineVersion = {
  id: 'pv1', pipelineId: 'pl-1', hubId: 'hub-us', kind: 'editorial_drafting', version: 1, name: 'Construction news desk (en, es-US)', sourceIds: ['src-sam'], datasetId: null,
  steps: [step('fetch'), step('parse'), step('deduplicate'), step('classify', 'classification'), step('rewrite', 'editorial_rewrite'), step('similarity_check'), step('fact_check', 'fact_check_assist'), step('translate', 'translation'), step('generate_image', 'image_generation'), step('propose_for_review')],
  automationLevel: 'supervised_autonomous', budgetId: 'b1', scheduleId: 'sch-1', status: 'active', draftedBy: 'p-1', activatedBy: 'p-2',
};
test('pipelines: no publish step exists, content ends in review, rewrites are similarity-checked, active pipelines are capped', () => {
  ok(c.PipelineVersionSchema, pipeline);
  refused(c.PipelineStepKindSchema, 'publish', 'no publish step');
  bad(c.PipelineVersionSchema, { ...pipeline, steps: pipeline.steps.slice(0, -1) }, 'content and data pipelines end in a human review queue');
  bad(c.PipelineVersionSchema, { ...pipeline, steps: [...pipeline.steps.slice(0, -1), step('notify_staff')] }, 'generated content must reach review');
  bad(c.PipelineVersionSchema, { ...pipeline, steps: pipeline.steps.filter((s) => s.kind !== 'similarity_check') }, 'a rewrite is followed by a similarity check');
  bad(c.PipelineVersionSchema, { ...pipeline, budgetId: null }, 'active pipelines record the activator and a spending cap');
  bad(c.PipelineVersionSchema, { ...pipeline, sourceIds: [] }, 'ingestion names its sources');
  const refresh = { ...pipeline, kind: 'dataset_refresh' as const, sourceIds: [], steps: [step('fetch'), step('normalise'), step('propose_for_review')] };
  bad(c.PipelineVersionSchema, refresh, 'dataset refresh names its dataset');
  ok(c.PipelineVersionSchema, { ...refresh, datasetId: 'ds-lic' });
  bad(c.PipelineStepSchema, step('rewrite', 'translation'), 'model job does not fit this step');
  bad(c.PipelineStepSchema, { ...step('rewrite'), modelJob: 'editorial_rewrite' }, 'a model step names both route and job');
});

test('runs: dry runs commit nothing; state machine; people start manual runs', () => {
  const run: c.PipelineRun = { id: 'run-1', pipelineVersionId: 'pv1', hubId: 'hub-us', trigger: 'dry_run', dryRun: true, state: 'succeeded', attempt: 1, triggeredBy: { kind: 'person', personId: 'p-1' }, queuedAt: at, startedAt: at, finishedAt: later, counts: { fetched: 40, new: 12, duplicates: 28, skippedByLicence: 0, skippedByRobots: 0, proposed: 12, failed: 0 }, cost: { minorUnits: '0', currency: 'USD' }, effectsCommitted: false, errorCode: null };
  ok(c.PipelineRunSchema, run);
  ok(c.PipelineRunSchema, { ...run, trigger: 'schedule', dryRun: false, triggeredBy: { kind: 'schedule', scheduleId: 'sch-1' }, effectsCommitted: true });
  bad(c.PipelineRunSchema, { ...run, effectsCommitted: true }, 'a dry run commits nothing');
  bad(c.PipelineRunSchema, { ...run, dryRun: false }, 'dry_run trigger and flag agree');
  bad(c.PipelineRunSchema, { ...run, finishedAt: null }, 'finished runs record an end');
  bad(c.PipelineRunSchema, { ...run, state: 'running', startedAt: null, finishedAt: null }, 'running records a start');
  bad(c.PipelineRunSchema, { ...run, trigger: 'manual', dryRun: false, triggeredBy: { kind: 'schedule', scheduleId: 'sch-1' } }, 'manual, dry and backfill runs are started by a person');
  assert.ok(c.runTransitionAllowed('queued', 'running') && c.runTransitionAllowed('running', 'stopped_by_kill_switch'));
  assert.equal(c.runTransitionAllowed('failed', 'running'), false, 'a retry is a new run');
});

const item: c.EditorialItem = {
  id: 'ei-1', hubId: 'hub-us', pipelineRunId: 'run-1', sources: [{ sourceId: 'src-sam', url: 'https://sam.gov/opp/1', retrievedAt: at, contentDigest: sha }], originalLanguage: 'en', targetLanguages: ['es-US'],
  stage: 'in_review', treatment: 'rewrite', ai: { summarised: false, rewritten: true, translated: true, routeIds: ['r1'] }, similarity: { maxSourceOverlap: '0.18', threshold: '0.35', method: 'ngram_jaccard' },
  factChecks: [{ claim: 'Bid deadline is 15 December', status: 'supported', evidenceUrls: ['https://sam.gov/opp/1'] }],
  image: { kind: 'ai_generated', readerLabel: true, metadataLabel: 'trainedAlgorithmicMedia', depictsRealPerson: false, promptDigest: sha }, attribution: 'Based on SAM.gov notice',
  assignedEditorId: 'p-4', review: null, publicationId: null, scheduledFor: null, revision: 1,
};
test('editorial items: only a person approves; AI images labelled; blockers from similarity, facts and licence', () => {
  ok(c.EditorialItemSchema, item);
  bad(c.EditorialItemSchema, { ...item, stage: 'approved' }, 'only a person approves publication');
  const approved = { ...item, stage: 'approved' as const, review: { decision: 'approved' as const, by: 'p-4', at, note: '' } };
  ok(c.EditorialItemSchema, approved);
  bad(c.EditorialItemSchema, { ...approved, stage: 'published' }, 'published items point to their publication');
  bad(c.EditorialItemSchema, { ...approved, stage: 'scheduled' }, 'scheduled items carry a time');
  ok(c.EditorialItemSchema, { ...approved, stage: 'scheduled', scheduledFor: later });
  refused(c.EditorialItemSchema, { ...item, image: { ...item.image, readerLabel: false } }, 'AI images always labelled');
  refused(c.EditorialItemSchema, { ...item, image: { ...item.image, depictsRealPerson: true } }, 'AI images never depict real people');
  bad(c.EditorialItemSchema, { ...item, similarity: null }, 'summaries and rewrites carry a similarity check');
  assert.deepEqual(c.editorialApprovalBlockers(item, source.allowedUses), []);
  assert.deepEqual(codes(c.editorialApprovalBlockers({ ...item, similarity: { ...item.similarity!, maxSourceOverlap: '0.5' } }, source.allowedUses)), ['similarity_above_threshold']);
  assert.ok(codes(c.editorialApprovalBlockers({ ...item, factChecks: [{ claim: 'x', status: 'contradicted', evidenceUrls: [] }] }, source.allowedUses)).includes('contradicted_claim'));
  const headlineOnly = { ...source.allowedUses, rewriteWithAttribution: false, sendToModelProviders: false, translate: false };
  assert.deepEqual(codes(c.editorialApprovalBlockers(item, headlineOnly)), ['licence_forbids_rewrite', 'licence_forbids_translation', 'licence_forbids_model_use']);
  const summary = { ...item, treatment: 'summary' as const, ai: { ...item.ai, rewritten: false, translated: false, summarised: true } };
  assert.deepEqual(codes(c.editorialApprovalBlockers(summary, { ...source.allowedUses, displaySummary: false })), ['licence_forbids_summary']);
  const licensedImage = { ...item, image: { kind: 'licensed' as const, licence: 'Publisher licence', credit: 'Photo: publisher', sourceId: 'src-sam' } };
  assert.deepEqual(codes(c.editorialApprovalBlockers(licensedImage, source.allowedUses)), ['licence_forbids_image_reuse']);
});

/* ---------- Agent product: AGT-002 owns the vocabulary, the console adds hub-side concerns ---------- */

test('agent product: no parallel schemas; plans, meter rates, manifests, policy and connections come from AGT-002', () => {
  const exported = c as unknown as Record<string, unknown>;
  for (const parallel of ['AgentModuleVersionSchema', 'MeteredPriceVersionSchema', 'AgentPlanVersionSchema', 'ExternalAgentClientSchema', 'MeteringUnitSchema', 'meteredVersionsOverlap']) {
    assert.equal(exported[parallel], undefined, `${parallel} is not part of the console contract`);
  }
  assert.ok(exported.SubscriptionPlanVersionSchema && exported.MeterRateVersionSchema && exported.AgentModuleManifestSchema && exported.ExternalConnectionSchema && exported.HubAgentPolicySchema);
  for (const name of ['AgentModuleVersion', 'MeteredPriceVersion', 'AgentPlanVersion', 'ExternalAgentClient', 'HubAgentPolicy']) assert.equal(name in c.HUB_CONSOLE_SCHEMAS, false, name);
  const connection = c.AGENT_CATALOG_EXAMPLES.ExternalConnection[0]!;
  ok(c.ExternalConnectionSchema, connection, 'AGT-002 example connection');
  for (const scope of ['read.public', 'read.private', 'act']) ok(c.ConnectionScopeSchema, scope);
  for (const scope of ['read_public', 'act_under_mandate']) refused(c.ConnectionScopeSchema, scope, `${scope} is not a connection scope`);
});

test('agent policy changes: enabling a commitment module or an extension needs a second person', () => {
  const policy = c.AGENT_CATALOG_EXAMPLES.HubAgentPolicy[0]! as c.HubAgentPolicy;
  ok(c.HubAgentPolicySchema, policy, 'AGT-002 example policy');
  const manifests = [
    { key: 'rfq_responder', version: '1.0.0', actions: ['prepare', 'send_quote', 'communicate'] as c.MandateActionV2[] },
    { key: 'order_desk', version: '1.0.0', actions: ['place_order', 'accept_order'] as c.MandateActionV2[] },
  ];
  const base = { enabledModules: [{ moduleKey: 'rfq_responder', moduleVersion: '1.0.0', freeQuota: [], settings: {} }], activeExtensionVersionIds: [] as string[] };
  assert.deepEqual(c.agentPolicySecondPersonActions(base, base, manifests), [], 'no change needs nobody');
  const withOrders = { ...base, enabledModules: [...base.enabledModules, { moduleKey: 'order_desk', moduleVersion: '1.0.0', freeQuota: [], settings: {} }] };
  assert.deepEqual(c.agentPolicySecondPersonActions(base, withOrders, manifests), ['agents.enable_commitment_module']);
  assert.deepEqual(c.agentPolicySecondPersonActions(null, base, manifests), [], 'a non-commitment module is one person');
  assert.deepEqual(c.agentPolicySecondPersonActions(withOrders, withOrders, manifests), [], 'already enabled');
  assert.deepEqual(c.agentPolicySecondPersonActions(base, { ...base, activeExtensionVersionIds: ['extv-1'] }, manifests), ['agents.activate_extension']);
  assert.deepEqual(c.agentPolicySecondPersonActions(null, { ...withOrders, activeExtensionVersionIds: ['extv-1'] }, manifests), ['agents.enable_commitment_module', 'agents.activate_extension']);
  assert.deepEqual([...c.COMMITMENT_MANDATE_KINDS], ['place_order', 'accept_order']);
});

test('cost beside sale price: operator cost estimates for AGT-002 meter rates and the unit margin', () => {
  const estimate = { id: 'mc1', hubId: 'hub-us', meterRateVersionId: 'mr-1', currency: 'USD', costPerThousandUnitsMinor: '3.25', costBasis: 'measured_average', observedAt: at };
  ok(c.MeterCostEstimateSchema, estimate);
  bad(c.MeterCostEstimateSchema, { ...estimate, costPerThousandUnitsMinor: '-1' }, 'a cost estimate is non-negative');
  refused(c.MeterCostEstimateSchema, { ...estimate, salePrice: '10' }, 'the sale price lives in the meter rate version');
  assert.equal(c.unitMargin({ costPricePerUnitMinor: '3.25', salePricePerUnitMinor: '10' }), '6.75');
  assert.equal(c.unitMargin({ costPricePerUnitMinor: '12.5', salePricePerUnitMinor: '10' }), '-2.5');
  assert.equal(c.unitMargin({ costPricePerUnitMinor: '0.1', salePricePerUnitMinor: '0.1' }), '0');
});

test('agent statistics are cohorts', () => {
  const stat = { hubId: 'hub-us', from: at, to: later, moduleKey: 'rfq_responder', activePrincipals: null, runs: 120, actionsSucceeded: 40, actionsEscalatedToHumans: 12, outcomeUnknown: 1, cost: { minorUnits: '3900', currency: 'USD' }, revenue: { minorUnits: '12000', currency: 'USD' } };
  ok(c.AgentUsageStatSchema, stat);
  refused(c.AgentUsageStatSchema, { ...stat, activePrincipals: 3 }, 'small cohorts are suppressed');
});

/* ---------- ADR 010 decision 22 ---------- */

const jurisdictionRef: c.JurisdictionSettingsRef = {
  hubId: 'hub-us', jurisdiction: 'US-CA', configVersionId: 'cv-jur-1', version: 1, payloadDigest: digest, areas: ['agent_disclosure', 'liability_allocation', 'action_limits'],
  packDefaults: [{ area: 'agent_disclosure', fact: { packCode: 'US', packVersion: '1', factKey: 'us:agents/disclosure/US-CA' } }], weakerThanMandatoryPackRule: false,
  disclosureLocales: ['en', 'es-US'], status: 'draft',
};
test('jurisdiction settings: a sensitive configuration domain with sourced pack defaults, disclosure in every hub language, never weaker than the pack', () => {
  ok(c.JurisdictionSettingsRefSchema, jurisdictionRef);
  bad(c.JurisdictionSettingsRefSchema, { ...jurisdictionRef, areas: ['consent', 'consent'] }, 'each area once');
  bad(c.JurisdictionSettingsRefSchema, { ...jurisdictionRef, areas: ['liability_allocation'] }, 'pack defaults name areas the version sets');
  bad(c.JurisdictionSettingsRefSchema, { ...jurisdictionRef, disclosureLocales: [] }, 'disclosure wording exists in at least one language');
  refused(c.JurisdictionSettingsRefSchema, { ...jurisdictionRef, weakerThanMandatoryPackRule: true }, 'never weaker than a mandatory pack rule');
  refused(c.JurisdictionSettingsRefSchema, { ...jurisdictionRef, jurisdiction: 'California' }, 'jurisdiction code grammar');
  assert.deepEqual(c.disclosureLocalesMissing(jurisdictionRef, usHub), []);
  assert.deepEqual(c.disclosureLocalesMissing({ ...jurisdictionRef, disclosureLocales: ['en'] }, usHub), ['es-US'], 'every hub language before activation');
  assert.deepEqual(c.disclosureLocalesMissing({ areas: ['consent'], disclosureLocales: [] }, usHub), [], 'only disclosure needs wording');
  assert.ok(c.consoleActionNeedsSecondPerson('jurisdiction.activate_settings'));
});

const extension: c.AgentExtensionVersionRef = {
  id: 'extv-1', extensionId: 'ext-permits', hubId: 'hub-us', key: 'permit_lookup', version: 1, manifestDigest: digest,
  capabilityIds: ['permit_lookup.status'], dataClassesRead: ['public'], dataClassesSent: ['public'],
  endpoints: [{ host: 'permits.example.org', country: 'US' }], adapterId: 'permits_http', hasFakeAdapter: true,
  guards: { mandates: true, budgets: true, approvals: true, killSwitches: true, egress: true, privacyRules: true, restrictedPlaces: true, untrustedTextNeverCommands: true },
  safetySuite: { runId: 'eval-1', onFakeAdapter: true, passed: true, engineVersion: '0.1.0', at }, status: 'active', draftedBy: 'p-1', approvedBy: 'p-2', approvalId: 'ap-8', activatedConfigVersionId: 'cv-ext-1',
};
test('agent extensions: AGT-002 capabilities with mandate kinds; guards cannot be switched off; activation needs a passed suite, a second person and a config version', () => {
  ok(c.AgentExtensionVersionRefSchema, extension);
  ok(c.AgentExtensionVersionRefSchema, { ...extension, status: 'draft', safetySuite: null, approvedBy: null, approvalId: null, activatedConfigVersionId: null });
  refused(c.AgentExtensionVersionRefSchema, { ...extension, capabilityIds: [] }, 'an extension adds at least one capability');
  refused(c.AgentExtensionVersionRefSchema, { ...extension, capabilityIds: ['Permit Lookup'] }, 'capability id grammar');
  bad(c.AgentExtensionVersionRefSchema, { ...extension, capabilityIds: ['other_ext.status'] }, 'capability ids are prefixed with the extension key');
  for (const guard of Object.keys(extension.guards)) refused(c.AgentExtensionVersionRefSchema, { ...extension, guards: { ...extension.guards, [guard]: false } }, `guard ${guard} cannot be bypassed`);
  refused(c.AgentExtensionVersionRefSchema, { ...extension, hasFakeAdapter: false }, 'an adapter with a fake');
  bad(c.AgentExtensionVersionRefSchema, { ...extension, capabilityIds: ['permit_lookup.status', 'permit_lookup.status'] }, 'each capability once');
  const suite = 'tested and active extensions passed their safety suite on the fake adapter';
  bad(c.AgentExtensionVersionRefSchema, { ...extension, safetySuite: { ...extension.safetySuite!, passed: false } }, suite);
  bad(c.AgentExtensionVersionRefSchema, { ...extension, status: 'tested', safetySuite: null, approvedBy: null, approvalId: null, activatedConfigVersionId: null }, suite);
  const activation = 'activation needs a second person and a hub configuration version';
  bad(c.AgentExtensionVersionRefSchema, { ...extension, approvedBy: 'p-1' }, activation);
  bad(c.AgentExtensionVersionRefSchema, { ...extension, approvalId: null }, activation);
  bad(c.AgentExtensionVersionRefSchema, { ...extension, activatedConfigVersionId: null }, activation);
  bad(c.AgentExtensionVersionRefSchema, { ...extension, endpoints: [] }, 'data sent goes to a declared endpoint');
  const source = { kind: 'extension' as const, extensionId: 'ext-permits', extensionVersion: 1 };
  const cap = { id: 'permit_lookup.status', source, kind: 'commit' as const, mandateAction: 'research' as const };
  assert.deepEqual(c.extensionCapabilityViolations(extension, [cap]), []);
  assert.deepEqual(c.extensionCapabilityViolations(extension, []), ['capability_missing:permit_lookup.status']);
  assert.deepEqual(c.extensionCapabilityViolations(extension, [{ ...cap, mandateAction: null }]), ['commit_without_mandate_kind:permit_lookup.status'], 'an action without a mandate kind is rejected');
  assert.deepEqual(c.extensionCapabilityViolations(extension, [{ ...cap, source: { ...source, extensionVersion: 2 } }]), ['capability_not_from_this_extension:permit_lookup.status']);
  assert.deepEqual(c.extensionCapabilityViolations(extension, [{ ...cap, source: { kind: 'module', moduleKey: 'permit_lookup', moduleVersion: '1.0.0' } }]), ['capability_not_from_this_extension:permit_lookup.status']);
  assert.deepEqual(c.extensionCapabilityViolations(extension, [{ ...cap, kind: 'govern', mandateAction: null }]), ['extension_adds_governance:permit_lookup.status']);
  assert.deepEqual(c.restrictedPlaceViolations({ extensions: [{ ...extension, endpoints: [{ host: 'permits.example.org', country: 'RU' }] }] }, isRestricted), ['extension:extv-1:permits.example.org']);
  const privateExt = { ...extension, dataClassesSent: ['public', 'person_private'] as c.DataClass[] };
  ok(c.AgentExtensionVersionRefSchema, privateExt);
  assert.deepEqual(c.egressDecision([egressRule({})], { connection: openai, dataClass: 'person_private', residencyCountry: 'US' }), { allowed: false, reason: 'no_rule' }, 'what an extension sends still passes default-deny egress');
});

/* ---------- ADR 010 decisions 20 and 21 ---------- */

const payments: c.HubPaymentSettings = {
  hubId: 'hub-us', version: 1, providers: [{ connectionId: 'pc-pay-fake', capabilities: ['payments', 'payouts'], licence: null }],
  fundsHeldBy: 'licensed_payment_provider', operatorAccountInFundsFlow: false, escrowAndRetainage: 'off', demoNoMoneyMoves: true,
};
test('payments: Trustwork never holds money; live money moves only through licensed providers', () => {
  ok(c.HubPaymentSettingsSchema, payments, 'the US demo: fake provider, no money moves');
  refused(c.HubPaymentSettingsSchema, { ...payments, fundsHeldBy: 'operator' }, 'the operator never holds funds');
  refused(c.HubPaymentSettingsSchema, { ...payments, operatorAccountInFundsFlow: true }, 'no operator account in the funds flow');
  const live = 'live money moves only through licensed providers whose licence is recorded';
  bad(c.HubPaymentSettingsSchema, { ...payments, demoNoMoneyMoves: false }, live);
  bad(c.HubPaymentSettingsSchema, { ...payments, demoNoMoneyMoves: false, providers: [] }, live);
  const licensed = { ...payments, demoNoMoneyMoves: false, escrowAndRetainage: 'provider_managed' as const, providers: [{ connectionId: 'pc-pay', capabilities: ['payments' as const], licence: { regulator: 'State money transmitter regulator (synthetic)', licenceRef: 'SYN-0001', country: 'US' } }] };
  ok(c.HubPaymentSettingsSchema, licensed);
  bad(c.HubPaymentSettingsSchema, { ...payments, providers: [], escrowAndRetainage: 'provider_managed' }, 'escrow and retainage are held by a provider');
  bad(c.HubPaymentSettingsSchema, { ...payments, providers: [payments.providers[0], payments.providers[0]] }, 'each provider once');
});

const fee: c.MarketplaceFeeVersion = {
  id: 'fee-1', hubId: 'hub-us', kind: 'consultation', categoryKey: 'electrical', version: 1, currency: 'USD', basisPoints: 800, fixed: null, payer: 'seller',
  effectiveFrom: '2026-11-15T00:00:00Z', effectiveTo: null, disclosure: { publicPricePage: true, acceptanceTextVersion: 'fees-1' }, status: 'active',
  draftedBy: 'p-5', activatedBy: 'p-1', activatedAt: at, approvalId: 'ap-1',
};
test('marketplace fees: versioned hub settings, second-person activation, public disclosure, no overlap, nothing that touches ranking', () => {
  ok(c.MarketplaceFeeVersionSchema, fee);
  ok(c.MarketplaceFeeVersionSchema, { ...fee, status: 'draft', activatedBy: null, activatedAt: null, approvalId: null });
  bad(c.MarketplaceFeeVersionSchema, { ...fee, basisPoints: null }, 'a fee is a percentage, a fixed amount or both');
  ok(c.MarketplaceFeeVersionSchema, { ...fee, basisPoints: null, fixed: { minorUnits: '500', currency: 'USD' } });
  bad(c.MarketplaceFeeVersionSchema, { ...fee, fixed: { minorUnits: '500', currency: 'EUR' } }, 'fixed fee in the fee currency');
  bad(c.MarketplaceFeeVersionSchema, { ...fee, kind: 'ticket' }, 'categories exist for consultations and tasks');
  bad(c.MarketplaceFeeVersionSchema, { ...fee, approvalId: null }, 'non-draft fee versions record activation under a second-person approval');
  bad(c.MarketplaceFeeVersionSchema, { ...fee, activatedBy: 'p-5' }, 'a fee version is activated by someone other than its drafter');
  bad(c.MarketplaceFeeVersionSchema, { ...fee, effectiveFrom: '2026-10-30T00:00:00Z' }, 'a fee version is never back-dated');
  bad(c.MarketplaceFeeVersionSchema, { ...fee, effectiveTo: '2026-11-01T00:00:00Z' }, 'a fee version ends after it starts');
  refused(c.MarketplaceFeeVersionSchema, { ...fee, basisPoints: 10_001 }, 'at most 100 percent');
  refused(c.MarketplaceFeeVersionSchema, { ...fee, disclosure: { ...fee.disclosure, publicPricePage: false } }, 'always disclosed');
  for (const field of ['rankingBoost', 'matchingWeight', 'reputationBonus', 'position', 'badge']) refused(c.MarketplaceFeeVersionSchema, { ...fee, [field]: 1 }, field);
  assert.ok(c.feeVersionsOverlap(fee, { ...fee, id: 'fee-2', version: 2 }));
  assert.equal(c.feeVersionsOverlap(fee, fee), false, 'a version does not overlap itself');
  assert.equal(c.feeVersionsOverlap(fee, { ...fee, id: 'fee-2', categoryKey: 'plumbing' }), false);
  assert.equal(c.feeVersionsOverlap(fee, { ...fee, id: 'fee-2', payer: 'buyer' }), false);
  assert.equal(c.feeVersionsOverlap({ ...fee, effectiveTo: '2026-12-01T00:00:00Z' }, { ...fee, id: 'fee-2', effectiveFrom: '2026-12-01T00:00:00Z' }), false, 'back to back is fine');
  assert.equal(c.feeVersionsOverlap(fee, { ...fee, id: 'fee-2', status: 'draft' }), false);
});

/* ---------- Plan to people, recommendations, sponsored content ---------- */

test('plan to people: acyclic expert-reviewed templates, marketplace rules, consented knowledge sharing', () => {
  const planItem = (key: string, dependsOn: string[] = [], kind: 'task' | 'consultation' | 'permit_check' = 'task') => ({ key, kind, title: { en: key, 'es-US': key }, categoryKey: null, licenceCategory: null, typicalDurationDays: 5, dependsOn });
  const t: c.PlanTemplateVersion = { id: 'tpl1', hubId: 'hub-us', key: 'single_family_house', version: 1, countryCode: 'US', projectType: 'house_new_build', title: { en: 'Single-family house', 'es-US': 'Casa unifamiliar' }, phases: [{ key: 'design', title: { en: 'Design' }, items: [planItem('architect_consult', [], 'consultation'), planItem('building_permit', ['architect_consult'], 'permit_check')] }, { key: 'build', title: { en: 'Build' }, items: [planItem('foundation', ['building_permit'])] }], references: [], authors: ['p-6'], reviewedBy: 'p-7', status: 'published' };
  ok(c.PlanTemplateVersionSchema, t);
  bad(c.PlanTemplateVersionSchema, { ...t, reviewedBy: 'p-6' }, 'a template is published after review by someone who is not its author');
  bad(c.PlanTemplateVersionSchema, { ...t, phases: [{ key: 'x', title: { en: 'x' }, items: [planItem('a', ['b']), planItem('b', ['a'])] }] }, 'dependencies are acyclic');
  bad(c.PlanTemplateVersionSchema, { ...t, phases: [{ key: 'x', title: { en: 'x' }, items: [planItem('a', ['missing'])] }] }, 'item keys are unique and dependencies point to other items of the template');
  const rule: c.MarketplaceCategoryRule = { id: 'mr1', hubId: 'hub-us', categoryKey: 'electrical', kind: 'task', whoMayOffer: 'verified_company_or_professional', verificationRecipeId: 'rec-tx-electrician', licenceCategory: 'TX-TDLR-electrical-contractor', pricing: 'quote_based', refunds: { cancellationWindowHours: 48, disputeWindowDays: 30 }, agentAutomation: { mayDraftRequests: true, mayDraftOffers: true, mayAcceptWithinMandate: true, requestsPerWeek: 10 }, version: 1, status: 'active' };
  ok(c.MarketplaceCategoryRuleSchema, rule);
  bad(c.MarketplaceCategoryRuleSchema, { ...rule, verificationRecipeId: null }, 'licensed categories need verified providers and a verification recipe');
  bad(c.MarketplaceCategoryRuleSchema, { ...rule, licenceCategory: null, whoMayOffer: 'claimed_company_or_professional' }, 'agents may accept only with verified counterparties');
  refused(c.MarketplaceCategoryRuleSchema, { ...rule, commissionOfferId: 'off-1' }, 'commissions live in fee versions');
  const share: c.KnowledgeShare = { id: 'ks1', hubId: 'hub-us', kind: 'project_diary', projectId: 'pr-1', ownerParty: { kind: 'person', id: 'p-9' }, namedParties: [{ kind: 'company', id: 'co-1' }], consents: [{ party: { kind: 'person', id: 'p-9' }, givenBy: 'p-9', at, scope: 'named', withdrawnAt: null }], privateFieldsExcluded: true, status: 'published', reviewedBy: 'p-4', publicationId: 'pub-1' };
  bad(c.KnowledgeShareSchema, share, 'published only after review and with the consent of the owner and every named party');
  const consented = { ...share, consents: [...share.consents, { party: { kind: 'company' as const, id: 'co-1' }, givenBy: 'p-8', at, scope: 'anonymised' as const, withdrawnAt: null }] };
  ok(c.KnowledgeShareSchema, consented);
  bad(c.KnowledgeShareSchema, { ...consented, consents: consented.consents.map((x) => ({ ...x, withdrawnAt: later })) }, 'published only after review and with the consent of the owner and every named party');
  refused(c.KnowledgeShareSchema, { ...share, privateFieldsExcluded: false }, 'private fields always removed');
});

test('recommendations: explained, regional for people and firms, no paid signal; sponsored content off by default and never ranks', () => {
  const mapping: c.ContentTypeMapping = { id: 'cm1', hubId: 'hub-us', sourceId: 'src-mfr', version: 1, rules: [{ pathPrefix: '/products/', schemaOrgType: 'Product', contentType: 'catalogue_item', categoryKey: 'insulation' }, { pathPrefix: '/academy/', schemaOrgType: 'Course', contentType: 'training', categoryKey: null }], status: 'active' };
  ok(c.ContentTypeMappingSchema, mapping);
  refused(c.ContentTypeMappingSchema, { ...mapping, rules: [{ ...mapping.rules[0], pathPrefix: 'products' }] }, 'path prefixes start with a slash');
  const rule: c.RecommendationRule = { id: 'rr1', hubId: 'hub-us', version: 1, planCategoryKey: 'foundation', planItemKinds: ['task', 'consultation'], recommends: [{ kind: 'material', maxItems: 5, includeSourced: true }, { kind: 'contractor', maxItems: 5, includeSourced: false }, { kind: 'training', maxItems: 3, includeSourced: true }], signals: ['plan_step_match', 'region_served', 'licence_valid', 'reputation_with_samples'], explanationShown: true, status: 'active', draftedBy: 'p-4', activatedBy: 'p-4' };
  ok(c.RecommendationRuleSchema, rule);
  for (const s of c.RecommendationSignalSchema.options) assert.equal(/(sponsor|paid|pay|plan_tier|entitlement|subscription|boost|promot)/.test(s), false, s);
  for (const s of ['sponsorship', 'paid_placement', 'plan_tier', 'entitlement']) refused(c.RecommendationRuleSchema, { ...rule, signals: ['plan_step_match', 'region_served', s] }, `no paid signal: ${s}`);
  bad(c.RecommendationRuleSchema, { ...rule, signals: ['plan_step_match'] }, 'people and firms are recommended only where they serve the region');
  bad(c.RecommendationRuleSchema, { ...rule, recommends: [...rule.recommends, rule.recommends[0]] }, 'each kind once');
  bad(c.RecommendationRuleSchema, { ...rule, activatedBy: null }, 'activation recorded');
  refused(c.RecommendationRuleSchema, { ...rule, explanationShown: false }, 'always explained');
  const off = c.defaultSponsoredContentPolicy('hub-us');
  assert.equal(off.allowed, false, 'ADR 012 decision 3: off by default');
  assert.equal(off.maxSlotsPerPage, 0);
  const sponsored: c.SponsoredContentPolicy = { ...off, allowed: true, maxSlotsPerPage: 1 };
  ok(c.SponsoredContentPolicySchema, sponsored);
  refused(c.SponsoredContentPolicySchema, { ...sponsored, affectsRankingOrMatching: true }, 'sponsored never ranks');
  refused(c.SponsoredContentPolicySchema, { ...sponsored, readerLabel: false }, 'always labelled');
  refused(c.SponsoredContentPolicySchema, { ...sponsored, separateSlotOnly: false }, 'own slot only');
  for (const place of ['search_results', 'matching_results', 'plan_recommendations', 'reputation', 'directory_order']) {
    bad(c.SponsoredContentPolicySchema, { ...sponsored, neverIn: sponsored.neverIn.filter((x) => x !== place) }, 'sponsored content never enters search, matching, plan recommendations, reputation or directory order');
  }
  bad(c.SponsoredContentPolicySchema, { ...off, maxSlotsPerPage: 1 }, 'no slots when not allowed');
  assert.ok(c.consoleActionNeedsSecondPerson('sponsored.enable'));
});

/* ---------- Credentials, setup, support, operations ---------- */

test('reputation building: checked credentials name recipes, revocation is recorded, agents never confirm', () => {
  const type: c.CredentialType = { id: 'ct1', hubId: 'hub-us', key: 'tx_electrical_contractor', version: 1, subject: 'company', claim: 'licence', title: { en: 'Texas electrical contractor licence', 'es-US': 'Licencia de contratista electrico de Texas' }, verificationRecipeId: 'rec-tx-electrician', validityDays: 365, recheckOnSourceChange: true, portable: true, status: 'active' };
  ok(c.CredentialTypeSchema, type);
  bad(c.CredentialTypeSchema, { ...type, verificationRecipeId: null }, 'checked claims name the verification recipe that checks them');
  ok(c.CredentialTypeSchema, { ...type, claim: 'counterparty_confirmation', verificationRecipeId: null });
  refused(c.CredentialTypeSchema, { ...type, score: 5 }, 'a credential is never a score');
  const vc: c.IssuedCredential = { id: 'vc1', hubId: 'hub-us', credentialTypeId: 'ct1', holder: { kind: 'company', id: 'co-1' }, evidenceRefs: ['ev-1'], decidedBy: 'p-7', issuedAt: at, expiresAt: '2027-10-31T10:00:00Z', signingKeyId: 'did:web:us.example.org#key-1', credentialDigest: digest, statusListIndex: 17, status: 'valid', revocation: null };
  ok(c.IssuedCredentialSchema, vc);
  bad(c.IssuedCredentialSchema, { ...vc, status: 'revoked' }, 'revoked credentials carry a revocation record, and only they do');
  bad(c.IssuedCredentialSchema, { ...vc, revocation: { reason: 'fraud', decidedBy: 'p-7', at: later } }, 'revoked credentials carry a revocation record, and only they do');
  ok(c.IssuedCredentialSchema, { ...vc, status: 'revoked', revocation: { reason: 'source_changed', decidedBy: 'p-7', at: later } });
  bad(c.IssuedCredentialSchema, { ...vc, expiresAt: at }, 'expiry after issue');
  refused(c.IssuedCredentialSchema, { ...vc, evidenceRefs: [] }, 'evidence required');
  const policy = { hubId: 'hub-us', version: 1, requireTransactionOrProjectLink: true, maxOpenRequestsPerRequester: 20, maxRequestsPerCounterpartyPerMonth: 3, declineCooldownDays: 30, reciprocalConfirmationsFlagged: true, agentsMayRequest: true, agentsMayConfirm: false };
  ok(c.ConfirmationPolicySchema, policy);
  refused(c.ConfirmationPolicySchema, { ...policy, agentsMayConfirm: true }, 'agents never confirm');
  refused(c.ConfirmationPolicySchema, { ...policy, requireTransactionOrProjectLink: false }, 'only real counterparties');
});

test('setup wizard: ordered steps, first admin with a second factor, finish only when complete', () => {
  const s: c.SetupState = { nodeId: 'node-1', completed: ['install_check', 'node_identity'], current: 'hub_identity', setupTokenHash: sha, setupTokenExpiresAt: later, firstAdmin: null, startedAt: at, finishedAt: null };
  ok(c.SetupStateSchema, s);
  assert.equal(c.nextSetupStep(s), 'hub_identity');
  bad(c.SetupStateSchema, { ...s, completed: [...s.completed, 'first_admin'] }, 'the first admin has a second factor');
  bad(c.SetupStateSchema, { ...s, finishedAt: later }, 'setup finishes only after every step');
  bad(c.SetupStateSchema, { ...s, completed: ['install_check', 'install_check'] }, 'duplicate step');
  assert.equal(c.nextSetupStep({ completed: [...c.SETUP_STEPS] }), null);
  refused(c.SetupStateSchema, { ...s, setupToken: 'plain-token-value' }, 'the setup token itself is never stored');
});

test('support: no impersonation fields, masked e-mail, sign-in changes need evidence, two people and 72 hours', () => {
  const summary: c.SupportAccountSummary = { personId: 'p-9', displayName: 'Synthetic Person', maskedEmail: 'sy***@example.org', emailVerified: true, accountState: 'active', secondFactor: { enrolled: true, methods: 1 }, activeSessions: 2, recovery: 'none', employer: null, entitlements: [], openCases: 1, consents: [] };
  ok(c.SupportAccountSummarySchema, summary);
  refused(c.SupportAccountSummarySchema, { ...summary, maskedEmail: 'synthetic@example.org' }, 'e-mail is masked');
  for (const leak of ['email', 'sessionTokens', 'ipAddresses', 'messages', 'budgets', 'impersonationToken']) refused(c.SupportAccountSummarySchema, { ...summary, [leak]: 'x' }, leak);
  const action: c.AccountServiceAction = { id: 'as1', hubId: 'hub-us', supportCaseId: 'case-1', subjectPersonId: 'p-9', action: 'reset_second_factor', requestedBy: 'p-10', approvedBy: 'p-11', evidenceRefs: ['ev-id'], requestedAt: at, effectiveAt: '2026-11-03T10:00:00Z', subjectNotified: true, state: 'cooling_off' };
  ok(c.AccountServiceActionSchema, action);
  bad(c.AccountServiceActionSchema, { ...action, effectiveAt: later }, 'sign-in factor changes take effect after at least 72 hours');
  bad(c.AccountServiceActionSchema, { ...action, approvedBy: 'p-10' }, 'changing sign-in factors needs evidence and a second person');
  bad(c.AccountServiceActionSchema, { ...action, evidenceRefs: [] }, 'changing sign-in factors needs evidence and a second person');
  bad(c.AccountServiceActionSchema, { ...action, requestedBy: 'p-9', approvedBy: 'p-11' }, 'staff never service their own account');
  ok(c.AccountServiceActionSchema, { ...action, action: 'revoke_all_sessions', approvedBy: null, evidenceRefs: [], effectiveAt: at });
});

test('operations: backups are encrypted; a passed restore drill passed every check in isolation', () => {
  const backup = { id: 'bk1', nodeId: 'node-1', kind: 'database_full', startedAt: at, finishedAt: later, sizeBytes: 1024, encrypted: true, offHost: true, manifestDigest: sha, state: 'completed' };
  ok(c.BackupRecordSchema, backup);
  refused(c.BackupRecordSchema, { ...backup, encrypted: false }, 'always encrypted');
  const drill: c.RestoreDrill = { id: 'dr1', nodeId: 'node-1', backupIds: ['bk1'], isolatedEnvironment: true, externalAdaptersDisabled: true, checks: { schemaChecksums: true, digestsVerified: true, tombstonesReplayed: true, objectsRestored: true, permissionsVerified: true }, measuredRecoveryMinutes: 42, dataLossWindowMinutes: 5, performedBy: 'p-1', witnessedBy: 'p-2', performedAt: at, outcome: 'passed' };
  ok(c.RestoreDrillSchema, drill);
  bad(c.RestoreDrillSchema, { ...drill, checks: { ...drill.checks, tombstonesReplayed: false } }, 'a passed drill passed every check');
  ok(c.RestoreDrillSchema, { ...drill, checks: { ...drill.checks, tombstonesReplayed: false }, outcome: 'failed' });
  refused(c.RestoreDrillSchema, { ...drill, externalAdaptersDisabled: false }, 'drills never call real providers');
});

/* ---------- Commands and results ---------- */

test('commands: strict, versioned, idempotent, with a reason; results name pending approvals', () => {
  const activate = { ...cmd, target: { record: 'marketplace_fee_version', id: 'fee-1' }, expectedRevision: 1, approvalId: 'ap-1', effectiveFrom: '2026-11-15T00:00:00Z' };
  ok(c.ActivateVersionCommandSchema, activate);
  bad(c.ActivateVersionCommandSchema, { ...activate, approvalId: null }, 'prices, plans, meter rates, fees and extensions are activated only under a second-person approval');
  for (const record of ['meter_rate_version', 'subscription_plan_version', 'price_version', 'agent_extension_version']) bad(c.ActivateVersionCommandSchema, { ...activate, target: { record, id: 'x' }, approvalId: null }, 'prices, plans, meter rates, fees and extensions are activated only under a second-person approval');
  ok(c.ActivateVersionCommandSchema, { ...activate, target: { record: 'recommendation_rule', id: 'rr1' }, approvalId: null }, 'content-dependent records are decided by the owning use case');
  for (const record of ['agent_module_version', 'metered_price_version', 'agent_plan_version']) refused(c.ActivateVersionCommandSchema, { ...activate, target: { record, id: 'x' } }, `${record} is not a console record`);
  refused(c.ActivateVersionCommandSchema, { ...activate, target: { record: 'reputation_snapshot', id: 'x' } }, 'reputation is never activated from the console');
  refused(c.ActivateVersionCommandSchema, { ...activate, reason: '' }, 'a reason is required');
  refused(c.ActivateVersionCommandSchema, { ...activate, contractVersion: undefined }, 'versioned');
  refused(c.ActivateVersionCommandSchema, { ...activate, score: 10 }, 'strict');
  ok(c.RequestSecondPersonApprovalCommandSchema, { ...cmd, action: 'agents.activate_extension', scope: { kind: 'hub', hubId: 'hub-us' }, actionDigest: digest });
  refused(c.RequestSecondPersonApprovalCommandSchema, { ...cmd, action: 'hub.edit_identity', scope: { kind: 'hub', hubId: 'hub-us' }, actionDigest: digest }, 'only second-person actions');
  ok(c.DecideSecondPersonApprovalCommandSchema, { ...cmd, approvalRequestId: 'apr-1', decision: 'approve', actionDigest: digest });
  refused(c.DecideSecondPersonApprovalCommandSchema, { ...cmd, approvalRequestId: 'apr-1', decision: 'approve' }, 'the approver restates the digest');
  ok(c.RequestLifecycleTransitionCommandSchema, { ...cmd, hubId: 'hub-us', to: 'soft_launch', expectedRevision: 3 });
  ok(c.EngageKillSwitchCommandSchema, { ...cmd, scope: { kind: 'agent_extension', hubId: 'hub-us', extensionId: 'ext-permits' } });
  ok(c.ReleaseKillSwitchCommandSchema, { ...cmd, killSwitchId: 'k1', approvalId: 'ap-5', incidentNote: 'INC-7 reviewed', expectedRevision: 2 });
  refused(c.ReleaseKillSwitchCommandSchema, { ...cmd, killSwitchId: 'k1', incidentNote: 'INC-7 reviewed', expectedRevision: 2 }, 'release needs an approval');
  ok(c.RunConnectionTestCommandSchema, { ...cmd, connectionId: 'pc-openai', syntheticInputOnly: true });
  refused(c.RunConnectionTestCommandSchema, { ...cmd, connectionId: 'pc-openai', syntheticInputOnly: true, input: 'customer text' }, 'no customer input');
  const run = { ...cmd, pipelineVersionId: 'pv1', trigger: 'dry_run', backfillFrom: null };
  ok(c.StartPipelineRunCommandSchema, run);
  bad(c.StartPipelineRunCommandSchema, { ...run, trigger: 'backfill' }, 'a backfill names its start, and only a backfill does');
  bad(c.StartPipelineRunCommandSchema, { ...run, backfillFrom: at }, 'a backfill names its start, and only a backfill does');
  ok(c.StartPipelineRunCommandSchema, { ...run, trigger: 'backfill', backfillFrom: at });
  const result = { contractVersion: V, outcome: 'pending_second_person', objectId: 'fee-1', revision: 2, approvalRequestId: 'apr-1', auditEventId: 'ae-1' };
  ok(c.ConsoleCommandResultSchema, result);
  ok(c.ConsoleCommandResultSchema, { ...result, outcome: 'applied', approvalRequestId: null });
  bad(c.ConsoleCommandResultSchema, { ...result, approvalRequestId: null }, 'a pending result names the approval request, and only it does');
  bad(c.ConsoleCommandResultSchema, { ...result, outcome: 'applied' }, 'a pending result names the approval request, and only it does');
});

/* ---------- Generated JSON Schema and structural scans over every console schema ---------- */

type Json = Record<string, unknown>;
const jsonSchemas = c.hubConsoleJsonSchemas();
function walk(node: unknown, visit: (n: Json, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
  else if (node && typeof node === 'object') {
    visit(node as Json, path);
    for (const [k, v] of Object.entries(node as Json)) walk(v, visit, `${path}.${k}`);
  }
}
function properties(name: string): { key: string; schema: Json; parent: Json; path: string }[] {
  const out: { key: string; schema: Json; parent: Json; path: string }[] = [];
  walk(jsonSchemas[name as c.HubConsoleSchemaName], (n, path) => {
    if (n.properties && typeof n.properties === 'object') for (const [key, schema] of Object.entries(n.properties as Json)) out.push({ key, schema: schema as Json, parent: n, path });
  });
  return out;
}

test('JSON Schema: every console schema generates draft 2020-12 with a versioned id', () => {
  assert.ok(Object.keys(jsonSchemas).length >= 55, `${Object.keys(jsonSchemas).length} schemas`);
  for (const [name, schema] of Object.entries(jsonSchemas)) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(schema.$id, `urn:trustwork:hub-console:${V}:${name}`);
  }
  for (const name of ['SecretRef', 'ProviderConnection', 'MarketplaceFeeVersion', 'AgentExtensionVersionRef', 'JurisdictionSettingsRef', 'HubPaymentSettings', 'ScopedStaffRoleAssignment']) assert.ok(name in jsonSchemas, name);
});

test('JSON Schema: every object is strict (no additional properties) and every command and result carries the contract version', () => {
  for (const name of Object.keys(jsonSchemas)) {
    walk(jsonSchemas[name as c.HubConsoleSchemaName], (n, path) => {
      if (n.type === 'object' && n.properties) assert.equal(n.additionalProperties, false, `${name} ${path} is not strict`);
    });
    if (/(Command|CommandResult|SubmitResult)$/.test(name)) {
      const root = jsonSchemas[name as c.HubConsoleSchemaName] as Json;
      const version = (root.properties as Json | undefined)?.contractVersion as Json | undefined;
      assert.equal(version?.const, V, `${name} carries contractVersion`);
      assert.ok((root.required as string[]).includes('contractVersion'), `${name} requires contractVersion`);
    }
  }
  for (const name of Object.keys(c.HUB_CONSOLE_SCHEMAS)) if (/Command$/.test(name)) {
    const required = (jsonSchemas[name as c.HubConsoleSchemaName] as Json).required as string[];
    assert.ok(required.includes('idempotencyKey') && required.includes('reason'), `${name} is idempotent and explained`);
  }
});

test('no schema carries a secret value except the write-only submit command', () => {
  // `token` alone (not the `...Tokens` counters of usage and limits) is secret-ish.
  const secretish = /(secret|password|passphrase|api_?key|private_?key|credential|ciphertext|plaintext|token(?!s))/i;
  const referenceSuffix = /(Ref|Hash|Fingerprint|Digest|Id|ExpiresAt)$/;
  for (const name of Object.keys(jsonSchemas)) {
    for (const { key, parent, path } of properties(name)) {
      if (secretish.test(key)) assert.match(key, referenceSuffix, `${name} ${path}.${key} must be a reference, hash or fingerprint`);
      if (key === 'value') {
        const siblings = Object.keys(parent.properties as Json).sort().join(',');
        const isDigest = siblings === 'algorithm,value';
        const isSubmit = name === 'SecretSubmitCommand' && path === '$';
        assert.ok(isDigest || isSubmit, `${name} ${path}.value: only digests and the write-only submit command carry a value`);
      }
    }
  }
  assert.ok(properties('SecretSubmitCommand').some((p) => p.key === 'value' && p.path === '$'));
  assert.equal(properties('SecretSubmitResult').some((p) => p.key === 'value' && p.path === '$'), false);
});

test('no permission or field can set a score, position, badge or ranking weight', () => {
  for (const name of Object.keys(jsonSchemas)) {
    for (const { key, schema, path } of properties(name)) {
      if (c.FORBIDDEN_CONTROL_WORDS.test(key)) assert.equal(schema.const, false, `${name} ${path}.${key} may only be a literal false guard`);
    }
    walk(jsonSchemas[name as c.HubConsoleSchemaName], (n, path) => {
      for (const v of (Array.isArray(n.enum) ? n.enum : []) as unknown[]) if (typeof v === 'string') assert.equal(c.FORBIDDEN_CONTROL_WORDS.test(v), false, `${name} ${path} enum value ${v}`);
    });
  }
  assert.ok(properties('SponsoredContentPolicy').some((p) => p.key === 'affectsRankingOrMatching' && p.schema.const === false));
});

test('coverage: every refinement message and violation code of hub.ts was produced by a negative test above', () => {
  const constants: Record<string, unknown> = c as unknown as Record<string, unknown>;
  const messages = [...hubSource.matchAll(/message: (?:'([^']+)'|`([^`]+)`)/g)].map((m) => (m[1] ?? m[2]!).replace(/\$\{(\w+)\}/g, (_, k: string) => String(constants[k])));
  assert.ok(messages.length >= 110, `found ${messages.length} messages`);
  assert.equal(new Set(messages).size, messages.length, 'refinement messages are unique so each invariant is traceable');
  const missing = messages.filter((m) => !seenMessages.has(m));
  if (missing.length) console.log(missing);
  assert.deepEqual(missing, [], 'invariants without a negative test');
  const violationCodes = [...hubSource.matchAll(/out\.push\('([a-z_]+)'\)/g)].map((m) => m[1]!);
  assert.deepEqual(violationCodes.filter((code) => !seenCodes.has(code)), [], 'violation codes without a test');
});

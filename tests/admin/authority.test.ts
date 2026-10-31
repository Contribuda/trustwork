import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, createPool } from '@trustwork/data';
import type { ConsolePermission, HubStaffRole, StaffScope } from '@trustwork/contracts';
import { NODE_ONLY_PERMISSIONS } from '@trustwork/contracts';
import {
  approverAllowed, assignmentConflicts, effectiveGrants, rolesGranting, scopeCovers, sodEvaluation, FULL_SOD_MIN_STAFF, type AssignmentFact, type DefinitionFact,
} from '../../apps/api/src/modules/platform-admin/authority.js';
import { staffAssignments, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { actors, buildAdminWorld, DEFINITIONS } from '../data/admin/helpers.js';
import { endPool, provisionTestDatabase, SKIP_REASON, untilDatabaseTimePasses } from '../data/helpers/postgres.js';

const db = await provisionTestDatabase('admin_authority');
const now = new Date('2026-11-01T12:00:00Z');
const NODE = '0198b1d0-0000-7000-8000-000000000001';
const HUB = '0198b1d0-0000-7000-8000-0000000000a1';
const OTHER = '0198b1d0-0000-7000-8000-0000000000a2';
const def = (role: HubStaffRole, permissions: ConsolePermission[], extra: Partial<DefinitionFact> = {}): DefinitionFact => ({
  role, version: 1, scopes: ['platform', 'node', 'hub'], permissions, sodMode: 'reduced', sodConflicts: [], grantMaxHours: 72, ...extra,
});
const held = (personId: string, role: HubStaffRole, scope: StaffScope, extra: Partial<AssignmentFact> = {}): AssignmentFact => ({
  personId, role, scope, definitionVersion: 1, breakglass: false, validFrom: new Date('2026-10-01T00:00:00Z'), validUntil: null, revokedAt: null, ...extra,
});

test('scope coverage: platform covers all, node covers its node and every hub, hub covers that hub without node-only permissions', () => {
  const platform: StaffScope = { kind: 'platform' };
  const node: StaffScope = { kind: 'node', nodeId: NODE };
  const hub: StaffScope = { kind: 'hub', hubId: HUB };
  for (const target of [platform, node, hub]) assert.equal(scopeCovers(platform, target), true);
  assert.equal(scopeCovers(node, platform), false);
  assert.equal(scopeCovers(node, node), true);
  assert.equal(scopeCovers(node, { kind: 'node', nodeId: OTHER }), false);
  assert.equal(scopeCovers(node, hub), true);
  assert.equal(scopeCovers(hub, hub), true);
  assert.equal(scopeCovers(hub, { kind: 'hub', hubId: OTHER }), false);
  assert.equal(scopeCovers(hub, node), false);
  assert.equal(scopeCovers(hub, hub, 'admin.ops.restore.execute'), false, 'node-only permissions never through a hub assignment');
  assert.ok(NODE_ONLY_PERMISSIONS.includes('admin.ops.restore.execute'));
});

test('effective grants: active, definition-scoped, union of permissions, break-glass marked', () => {
  const defs = [def('moderator', ['admin.moderation.read', 'admin.moderation.decide'], { scopes: ['hub'] }), def('ops-engineer', ['admin.ops.restore.execute', 'admin.incident.open'])];
  const facts = [
    held('a', 'moderator', { kind: 'hub', hubId: HUB }),
    held('a', 'ops-engineer', { kind: 'hub', hubId: HUB }, { breakglass: true }),
    held('b', 'moderator', { kind: 'platform' }), // the definition does not allow the platform scope
    held('c', 'moderator', { kind: 'hub', hubId: HUB }, { revokedAt: new Date('2026-10-30T00:00:00Z') }),
    held('d', 'moderator', { kind: 'hub', hubId: HUB }, { validUntil: new Date('2026-10-31T00:00:00Z') }),
  ];
  const a = effectiveGrants(facts, defs, 'a', { kind: 'hub', hubId: HUB }, now);
  assert.deepEqual(a.roles, ['moderator', 'ops-engineer']);
  assert.deepEqual(a.permissions, ['admin.incident.open', 'admin.moderation.decide', 'admin.moderation.read']);
  assert.deepEqual(a.breakglassOnly, ['admin.incident.open']);
  for (const person of ['b', 'c', 'd']) assert.deepEqual(effectiveGrants(facts, defs, person, { kind: 'hub', hubId: HUB }, now).roles, [], person);
  assert.deepEqual(rolesGranting(facts, defs, 'a', ['admin.moderation.decide'], { kind: 'hub', hubId: HUB }, now), ['moderator']);
  assert.deepEqual(effectiveGrants(facts, defs, 'a', { kind: 'hub', hubId: OTHER }, now).roles, []);
});

test('separation-of-duties mode: reduced below five staff people, full from five', () => {
  const defs = [def('support-agent', ['admin.support.case.create'])];
  const people = (n: number) => Array.from({ length: n }, (_, i) => held(`p${i}`, 'support-agent', { kind: 'hub', hubId: HUB }));
  assert.equal(sodEvaluation(people(FULL_SOD_MIN_STAFF - 1), defs, { kind: 'hub', hubId: HUB }, now).mode, 'reduced');
  assert.equal(sodEvaluation(people(FULL_SOD_MIN_STAFF), defs, { kind: 'hub', hubId: HUB }, now).mode, 'full');
  assert.equal(sodEvaluation([...people(4), held('p0', 'support-agent', { kind: 'platform' })], defs, { kind: 'hub', hubId: HUB }, now).staffCount, 4, 'people, not assignments');
  assert.equal(sodEvaluation(people(6), defs, { kind: 'hub', hubId: OTHER }, now).mode, 'reduced', 'staff of another hub do not count');
});

test('second person: never the requester; in full mode through a different role', () => {
  const base = { requesterId: 'r', approverId: 'a', requesterRoles: ['staff-admin'] as HubStaffRole[] };
  assert.deepEqual(approverAllowed({ ...base, mode: 'reduced', approverId: 'r', approverRoles: ['platform-owner'] }), { ok: false, reason: 'self_approval' });
  assert.deepEqual(approverAllowed({ ...base, mode: 'full', approverId: 'r', approverRoles: ['platform-owner'] }), { ok: false, reason: 'self_approval' });
  assert.deepEqual(approverAllowed({ ...base, mode: 'reduced', approverRoles: ['staff-admin'] }), { ok: true });
  assert.deepEqual(approverAllowed({ ...base, mode: 'full', approverRoles: ['staff-admin'] }), { ok: false, reason: 'same_role' });
  assert.deepEqual(approverAllowed({ ...base, mode: 'full', approverRoles: ['staff-admin', 'hub-owner'] }), { ok: true });
  assert.deepEqual(approverAllowed({ ...base, mode: 'full', approverRoles: [] }), { ok: false, reason: 'no_role' });
});

test('hard role conflicts of full-mode definitions, on either side', () => {
  const defs = [def('auditor', ['admin.audit.read'], { sodMode: 'full', sodConflicts: ['ops-engineer'] }), def('ops-engineer', ['admin.incident.open']), def('editor', ['admin.publications.read'])];
  assert.deepEqual(assignmentConflicts(defs, [held('x', 'ops-engineer', { kind: 'hub', hubId: HUB })], 'auditor', 1, now), ['ops-engineer']);
  assert.deepEqual(assignmentConflicts(defs, [held('x', 'auditor', { kind: 'platform' })], 'ops-engineer', 1, now), ['auditor']);
  assert.deepEqual(assignmentConflicts(defs, [held('x', 'auditor', { kind: 'platform' }, { revokedAt: now })], 'ops-engineer', 1, now), []);
  assert.deepEqual(assignmentConflicts(defs, [held('x', 'editor', { kind: 'platform' })], 'auditor', 1, now), []);
});

/**
 * Parity on real PostgreSQL: for every synthetic staff person, every permission of the released definitions plus the
 * node-only permissions, and every target (platform, node, the hub, another hub), the materialised grants agree with
 * the database's own `trustwork.admin_has_permission` evaluated as that person under the runtime role. Includes a
 * node-scoped role, a revoked and an expired assignment.
 */
test('materialised grants agree with the database resolver', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime = db.teardown.watch(createPool({ ...db.appConfig, max: 4 }));
  t.after(async () => { await endPool(runtime).catch(() => undefined); await db.close(); });
  const world = await buildAdminWorld(db.admin);
  const a = actors(db.admin, runtime, world);
  const hub = { kind: 'hub', hubId: world.hubId } as const;
  await a.assignSensitive({ personId: world.people.hubOwner, role: 'hub-owner', scope: hub });
  await a.assign({ personId: world.people.moderator, role: 'moderator', scope: hub });
  await a.assign({ personId: world.people.agent, role: 'support-agent', scope: hub });
  await a.assign({ personId: world.people.lead, role: 'support-lead', scope: { kind: 'hub', hubId: world.otherHubId } });
  await a.assign({ personId: world.people.ops, role: 'ops-engineer', scope: { kind: 'node', nodeId: world.nodeId } });
  await a.assignSensitive({ personId: world.people.lead2, role: 'node-operator', scope: { kind: 'node', nodeId: world.nodeId } });
  const revoked = await a.assign({ personId: world.people.auditor, role: 'auditor', scope: hub });
  const ctx = await a.elevate(world.people.owner);
  await a.as(world.people.owner, (trx) => staffAssignments.revoke(trx, ctx, revoked.id));
  const expiring = await a.as(world.people.owner, async (trx) => staffAssignments.assign(trx, await a.elevate(world.people.owner), { personId: world.people.customer, role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: 1 }));
  await untilDatabaseTimePasses(db.admin, expiring.valid_until as Date);

  const { facts, defs } = await withMaintenance(db.admin, async (trx) => ({
    facts: (await trx.selectFrom('staff_role_assignment').selectAll().execute()).map((r): AssignmentFact => ({
      personId: r.person_id, role: r.role as HubStaffRole, definitionVersion: r.definition_version, breakglass: r.breakglass, validFrom: r.valid_from, validUntil: r.valid_until, revokedAt: r.revoked_at,
      scope: r.scope_kind === 'platform' ? { kind: 'platform' } : r.scope_kind === 'node' ? { kind: 'node', nodeId: r.node_id as string } : { kind: 'hub', hubId: r.hub_id as string },
    })),
    defs: (await staffRoleDefinitions.list(trx)).map((r): DefinitionFact => ({ role: r.role as HubStaffRole, version: r.version, scopes: r.scopes, permissions: r.permissions as ConsolePermission[], sodMode: r.sod_mode, sodConflicts: r.sod_conflicts as HubStaffRole[], grantMaxHours: r.grant_max_hours })),
  }));
  const permissions = [...new Set([...DEFINITIONS.flatMap((d) => d.permissions), ...NODE_ONLY_PERMISSIONS])].sort();
  const targets: Array<[string, StaffScope]> = [['platform', { kind: 'platform' }], ['node', { kind: 'node', nodeId: world.nodeId }], ['hub', hub], ['other', { kind: 'hub', hubId: world.otherHubId }]];
  const { rows: clock } = await db.admin.query<{ now: Date }>('SELECT now() AS now');
  const at = clock[0]!.now;
  let compared = 0;
  for (const personId of Object.values(world.people)) {
    const principal = await a.principal(personId);
    const answers = await withPrincipal(runtime, principal, async (trx) => {
      const out = new Map<string, boolean>();
      for (const [name, target] of targets) {
        const node = target.kind === 'node' ? target.nodeId : null;
        const hubId = target.kind === 'hub' ? target.hubId : null;
        const { rows } = await sql<{ permission: string; ok: boolean }>`SELECT p AS permission, trustwork.admin_has_permission(p, ${node}::uuid, ${hubId}::uuid) AS ok FROM unnest(${permissions}::text[]) p`.execute(trx);
        for (const r of rows) out.set(`${name}:${r.permission}`, r.ok);
      }
      return out;
    });
    for (const [name, target] of targets) {
      const mine = new Set(effectiveGrants(facts, defs, personId, target, at).permissions);
      for (const permission of permissions) {
        assert.equal(mine.has(permission as ConsolePermission), answers.get(`${name}:${permission}`), `${personId} ${name} ${permission}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 500, `compared ${compared} decisions`);
});

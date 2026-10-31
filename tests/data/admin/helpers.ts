import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type DataPool, type Principal, type Transaction } from '@trustwork/data';
import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts';
import { adminDigests, adminSetup, approvals, staffAssignments, staffRoleDefinitions, type CommandContext, type StaffScope } from '../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../packages/data/src/repositories/identity.js';
import { principalFor } from '../helpers/seed.js';
import { sqlState } from '../helpers/postgres.js';

/**
 * Synthetic administration world for the DATA-002 suites. Every person, company and hub is synthetic (labelled
 * "Synthetic"), role definitions are test definitions over the real console permission vocabulary, and nothing here
 * claims to be the released ADM-000 capability map.
 */
type Def = { role: HubStaffRole; scopes: ('platform' | 'node' | 'hub')[]; permissions: ConsolePermission[]; grantMaxHours?: number; sodMode?: 'reduced' | 'full'; sodConflicts?: HubStaffRole[] };
export const DEFINITIONS: Def[] = [
  { role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.staff.breakglass', 'admin.staff.conflict.declare',
    'admin.audit.read', 'admin.incident.open', 'admin.incident.review', 'admin.flags.edit', 'admin.config.maintenance', 'admin.providers.kill', 'admin.agents.kill',
    'admin.moderation.read', 'admin.moderation.decide', 'admin.moderation.appeal.decide', 'admin.support.grant.approve', 'admin.ops.restore.execute'] },
  { role: 'staff-admin', scopes: ['platform', 'node', 'hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.staff.breakglass', 'admin.staff.conflict.declare'] },
  { role: 'hub-owner', scopes: ['hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.audit.read', 'admin.moderation.read', 'admin.moderation.decide',
    'admin.moderation.appeal.decide', 'admin.trust.appeals.decide', 'admin.support.grant.approve', 'admin.providers.kill', 'admin.agents.kill', 'admin.incident.open',
    'admin.incident.review', 'admin.flags.edit', 'admin.config.maintenance'] },
  { role: 'support-agent', scopes: ['hub'], permissions: ['admin.support.case.create', 'admin.support.diagnose', 'admin.support.grant.request'], grantMaxHours: 24 },
  { role: 'support-lead', scopes: ['hub'], permissions: ['admin.support.case.create', 'admin.support.case.close', 'admin.support.grant.request', 'admin.support.grant.approve'], grantMaxHours: 72 },
  { role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read', 'admin.moderation.case.open', 'admin.moderation.decide', 'admin.moderation.emergency.hold'] },
  { role: 'ops-engineer', scopes: ['platform', 'node', 'hub'], permissions: ['admin.providers.kill', 'admin.incident.open', 'admin.observability.read', 'admin.staff.conflict.declare'] },
  { role: 'auditor', scopes: ['platform', 'node', 'hub'], permissions: ['admin.audit.read'], sodMode: 'full', sodConflicts: ['ops-engineer'] },
  { role: 'node-operator', scopes: ['node'], permissions: ['admin.ops.restore.execute', 'admin.node.hubs.manage', 'admin.incident.open'] },
];

export interface AdminWorld {
  nodeId: string;
  hubId: string;
  otherHubId: string;
  company: string;
  people: Record<'owner' | 'admin' | 'hubOwner' | 'agent' | 'lead' | 'lead2' | 'moderator' | 'ops' | 'auditor' | 'customer' | 'employee' | 'outsider' | 'otherAgent', string>;
  sessions: Record<string, string>;
}

export async function buildAdminWorld(admin: DataPool): Promise<AdminWorld> {
  return withMaintenance(admin, async (trx) => {
    for (const def of DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions,
        caps: { creditCapMinorUnits: null, grantMaxHours: def.grantMaxHours ?? 72 }, sodConflicts: def.sodConflicts ?? [], sodMode: def.sodMode ?? 'reduced', releasedBy: null });
    }
    const { id: nodeId } = await adminSetup.createNode(trx, 'Synthetic test node');
    const hubRow = await trx.insertInto('hub').values({ slug: `synthetic-${randomBytes(3).toString('hex')}`, lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow();
    const otherHub = await trx.insertInto('hub').values({ slug: `synthetic-other-${randomBytes(3).toString('hex')}`, lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow();
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const people = {
      owner: await person('Synthetic Platform Owner'), admin: await person('Synthetic Staff Admin'), hubOwner: await person('Synthetic Hub Owner'),
      agent: await person('Synthetic Support Agent'), lead: await person('Synthetic Support Lead'), lead2: await person('Synthetic Second Lead'),
      moderator: await person('Synthetic Moderator'), ops: await person('Synthetic Ops Engineer'), auditor: await person('Synthetic Auditor'),
      customer: await person('Synthetic Customer'), employee: await person('Synthetic Employee'), outsider: await person('Synthetic Outsider'),
      otherAgent: await person('Synthetic Other Hub Agent'),
    };
    const company = (await trx.insertInto('company').values({ display_name: 'Synthetic Builders LLC', claim_status: 'unclaimed' }).returning('id').executeTakeFirstOrThrow()).id;
    await trx.insertInto('membership').values({ person_id: people.employee, company_id: company, role: 'administrator', permissions: ['company.members.manage'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    // The support agent is also an ordinary member of the customer's company: a conflict of interest for that company.
    await trx.insertInto('membership').values({ person_id: people.agent, company_id: company, role: 'member', permissions: [], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    const sessions: Record<string, string> = {};
    for (const [key, id] of Object.entries(people)) {
      const row = await trx.insertInto('session').values({
        person_id: id, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow();
      sessions[key] = row.id;
    }
    // Two founding administrators (setup wizard); everything else is assigned through the console in the tests.
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.owner, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.admin, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { nodeId, hubId: hubRow.id, otherHubId: otherHub.id, company, people, sessions };
  });
}

export function actors(adminPool: DataPool, runtime: DataPool, world: AdminWorld) {
  const principal = (personId: string): Promise<Principal> => principalFor(adminPool, personId);
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(runtime, await principal(personId), fn);
  const key = (personId: string) => Object.entries(world.people).find(([, id]) => id === personId)?.[0] as string;
  /**
   * A fresh elevation of the person's own session (BE-004's session_elevation, as the API writes it after a verified
   * second factor; the factor proof itself is BE-004's concern) and a command context bound to it.
   */
  const elevate = async (personId: string, validForSeconds = 900): Promise<CommandContext> => {
    const elevation = await as(personId, (trx) => sessionElevations.insert(trx, { sessionId: world.sessions[key(personId)] as string, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + validForSeconds * 1000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic test action' };
  };
  /** A sensitive role through the console: the founding owner asks, the founding staff admin approves, the owner assigns. */
  const assignSensitive = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => {
    const ownerCtx = await elevate(world.people.owner);
    const adminCtx = await elevate(world.people.admin);
    const digest = adminDigests.assignment({ breakglass: false, personId: input.personId, role: input.role, scope: input.scope, definitionVersion: 1 });
    const request = await as(world.people.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
    await as(world.people.admin, (trx) => approvals.decide(trx, adminCtx, request.id, 'approve', digest));
    return as(world.people.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, definitionVersion: 1, approvalId: request.id }));
  };
  const assign = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => {
    const ownerCtx = await elevate(world.people.owner);
    return as(world.people.owner, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, definitionVersion: 1 }));
  };
  return { principal, as, elevate, assign, assignSensitive, owner: <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => withMaintenance(adminPool, fn) };
}

interface PgError { code?: string; hint?: string; message?: string }
export async function settle(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(() => null, (e: unknown) => e as PgError);
}
export async function rejects(promise: Promise<unknown>, state: string, hint?: string): Promise<void> {
  const error = await settle(promise);
  assert.ok(error, `expected a rejection${hint ? ` (${hint})` : ''}`);
  assert.equal(sqlState(error), state, `${error.message} (hint ${error.hint})`);
  if (hint) assert.equal(error.hint, hint, error.message);
}
export const fieldsHash = () => randomBytes(32).toString('hex');

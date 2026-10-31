import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type DataPool, type Principal, type Transaction } from '@trustwork/data';
import { computeDigest, type ConsolePermission, type HubStaffRole } from '@trustwork/contracts';
import { adminSetup, approvals, staffAssignments, staffRoleDefinitions, adminDigests, type CommandContext, type StaffScope } from '../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../packages/data/src/repositories/identity.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { hubs, type CreateHubInput } from '../../packages/data/src/repositories/hubs.js';
import type { ConsoleSecondPersonAction } from '../../packages/contracts/src/hub.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * Synthetic world for the HUB-001 suites. Every person and hub is synthetic and labelled "Synthetic"; role definitions
 * are test definitions over the real console vocabulary, not the released capability map. The reference hub fixture is
 * the decided United States hub with San Diego as its home territory (ADR 012 decision 31), demo-only, English first.
 *
 * - founder: platform-owner at the platform (founding administrator; assigns staff)
 * - founder2: staff-admin at the platform (founding administrator; approves sensitive assignments)
 * - operator: node-operator (creates hubs: admin.node.hubs.manage)
 * - owner: hub-owner of hub A (drafts, activates, checks gates, requests transitions)
 * - officer: compliance-officer of hub A (the second person; also drafts and activates)
 * - moderator: moderator of hub A (no configuration permission)
 * - otherOwner: hub-owner of hub B (every permission, but at another hub)
 * - outsider: a participant without any role
 */
type Def = { role: HubStaffRole; scopes: ('platform' | 'node' | 'hub')[]; permissions: ConsolePermission[] };
const HUB_CONFIG: ConsolePermission[] = [
  'admin.hub.read', 'admin.hub.identity.edit', 'admin.hub.modes.edit', 'admin.hub.lifecycle.request', 'admin.hub.launch.check', 'admin.config.edit',
  'admin.hub.legal.edit', 'admin.hub.legal.activate', 'admin.hub.residency.edit', 'admin.hub.country.edit', 'admin.hub.jurisdiction.edit', 'admin.hub.jurisdiction.activate',
  'admin.privacy.retention.edit', 'admin.privacy.erasure.execute', 'admin.providers.secret.write', 'admin.providers.toggle', 'admin.providers.egress.edit', 'admin.audit.read',
  'admin.federation.peer.edit', 'admin.agents.modules.activate', 'admin.agents.policy.edit', 'admin.hub.payments.edit',
];
export const DEFINITIONS: Def[] = [
  { role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.audit.read'] },
  { role: 'staff-admin', scopes: ['platform', 'node', 'hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read'] },
  { role: 'node-operator', scopes: ['node'], permissions: ['admin.node.hubs.manage', 'admin.hub.read'] },
  { role: 'hub-owner', scopes: ['hub'], permissions: HUB_CONFIG },
  { role: 'compliance-officer', scopes: ['node', 'hub'], permissions: HUB_CONFIG },
  { role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read'] },
];

export type Key = 'founder' | 'founder2' | 'operator' | 'owner' | 'officer' | 'moderator' | 'otherOwner' | 'outsider';
export const KEYS: Key[] = ['founder', 'founder2', 'operator', 'owner', 'officer', 'moderator', 'otherOwner', 'outsider'];
export interface HubWorld {
  nodeId: string;
  people: Record<Key, string>;
  sessions: Record<Key, string>;
}

/** The reference hub: United States, San Diego home territory, English default with Spanish, USD, demo-only. */
export const US_HUB: Omit<CreateHubInput, 'slug'> = {
  name: { en: 'Synthetic United States demo hub', es: 'Centro de demostración sintético de Estados Unidos' },
  defaultLocale: 'en',
  locales: ['en', 'es'],
  timeZone: 'America/Los_Angeles',
  currency: 'USD',
  countryPack: null,
  territories: [{ level: 'country', code: 'US' }, { level: 'region', code: 'US-CA' }, { level: 'place', code: 'US-CA:san-diego' }],
};

/** The restricted places and jurisdictions synced into the kernel, as the maintenance command does on a real node. */
export async function syncKernel(admin: DataPool): Promise<void> {
  const reference = await kernelReference.fromRepository();
  await withMaintenance(admin, (trx) => kernelSync.apply(trx, reference));
}

export async function buildHubWorld(admin: DataPool): Promise<HubWorld> {
  return withMaintenance(admin, async (trx) => {
    for (const def of DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
        sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const { id: nodeId } = await adminSetup.createNode(trx, 'Synthetic hubs node');
    const people = {} as Record<Key, string>;
    const sessions = {} as Record<Key, string>;
    for (const key of KEYS) {
      people[key] = (await trx.insertInto('person').values({ display_name: `Synthetic ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({
        person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow()).id;
    }
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder2, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { nodeId, people, sessions };
  });
}

export function actors(adminPool: DataPool, runtime: DataPool, world: HubWorld) {
  const principal = (personId: string): Promise<Principal> => principalFor(adminPool, personId);
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(runtime, await principal(personId), fn);
  const keyOf = (personId: string) => KEYS.find((k) => world.people[k] === personId) as Key;
  /** A fresh elevation of the person's own session (BE-004's row, as the API writes it after a verified factor). */
  const elevate = async (personId: string, validForSeconds = 900): Promise<CommandContext> => {
    const elevation = await as(personId, (trx) => sessionElevations.insert(trx, { sessionId: world.sessions[keyOf(personId)], personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + validForSeconds * 1000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic hub test' };
  };
  /** Runs a staff command as the person under a fresh elevation. */
  const cmd = async <T>(personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> => {
    const ctx = await elevate(personId);
    return as(personId, (trx) => fn(trx, ctx));
  };
  const assign = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) =>
    cmd(world.people.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { ...input, definitionVersion: 1 }));
  const assignSensitive = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => {
    const digest = adminDigests.assignment({ breakglass: false, personId: input.personId, role: input.role, scope: input.scope, definitionVersion: 1 });
    const ownerCtx = await elevate(world.people.founder);
    const request = await as(world.people.founder, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
    await cmd(world.people.founder2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return as(world.people.founder, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, definitionVersion: 1, approvalId: request.id }));
  };
  /** Second person: `requester` asks for the action at the hub with the digest, `approver` approves; returns the approval id. */
  const approve = async (requester: string, approver: string, action: ConsoleSecondPersonAction, hubId: string, digestInput: unknown): Promise<string> => {
    const digest = computeDigest(digestInput).value;
    const request = await cmd(requester, (trx, ctx) => approvals.request(trx, ctx, { action, scope: { kind: 'hub', hubId }, actionDigest: digest }));
    await cmd(approver, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  /** Creates a hub as the operator (assigned node-operator first if needed). */
  const createHub = async (slug: string, input: Omit<CreateHubInput, 'slug'> = US_HUB) => cmd(world.people.operator, (trx, ctx) => hubs.create(trx, ctx, { slug, ...input }));
  return { principal, as, elevate, cmd, assign, assignSensitive, approve, createHub };
}

interface PgError { code?: string; hint?: string; message?: string; detail?: string }
export async function settle(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(() => null, (e: unknown) => e as PgError);
}
export async function rejects(promise: Promise<unknown>, state: string, hint?: string): Promise<PgError> {
  const error = await settle(promise);
  assert.ok(error, `expected a rejection${hint ? ` (${hint})` : ''}`);
  assert.equal(error.code, state, `${error.message} (hint ${error.hint}, detail ${error.detail})`);
  if (hint) assert.equal(error.hint, hint, `${error.message} (detail ${error.detail})`);
  return error;
}
export const evidence = (): string => randomUUID();

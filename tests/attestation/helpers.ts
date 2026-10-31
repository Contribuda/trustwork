import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type DataPool, type Principal, type Transaction } from '@trustwork/data';
import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts';
import { adminDigests, adminSetup, approvals, staffAssignments, staffRoleDefinitions, type CommandContext, type StaffScope } from '../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../packages/data/src/repositories/identity.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * Synthetic world for the SANC-009 suites. Every person and hub is synthetic ("Synthetic ..."); the role definitions
 * are test definitions over the real console vocabulary, not the released capability map. Who may attest is decided by
 * the database: an attesting permission (`admin.node.hubs.manage` or `admin.hub.jurisdiction.edit`) resolved at the
 * node, so node- or platform-scoped staff only.
 *
 * - founder: platform-owner at the platform (founding administrator; holds admin.hub.jurisdiction.edit)
 * - founder2: staff-admin at the platform (founding administrator; approves the sensitive assignments; cannot attest)
 * - operator: node-operator at the node (holds admin.node.hubs.manage)
 * - hubOwner: hub-owner of the hub, holding admin.hub.jurisdiction.edit and admin.audit.read at the hub only
 * - auditor: auditor at the node (admin.audit.read: reads the history, cannot attest)
 * - officer: compliance-officer at the node (reads through SANC-001's reader, cannot attest)
 * - moderator: moderator of the hub (no say), outsider: a participant without any role
 */
type Def = { role: HubStaffRole; scopes: ('platform' | 'node' | 'hub')[]; permissions: ConsolePermission[] };
export const DEFINITIONS: Def[] = [
  { role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.audit.read', 'admin.hub.jurisdiction.edit'] },
  { role: 'staff-admin', scopes: ['platform', 'node', 'hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read'] },
  { role: 'node-operator', scopes: ['node'], permissions: ['admin.node.hubs.manage', 'admin.incident.open'] },
  { role: 'hub-owner', scopes: ['hub'], permissions: ['admin.hub.jurisdiction.edit', 'admin.audit.read', 'admin.hub.read'] },
  { role: 'auditor', scopes: ['platform', 'node', 'hub'], permissions: ['admin.audit.read'] },
  { role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read'] },
  { role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read'] },
];

export type Key = 'founder' | 'founder2' | 'operator' | 'hubOwner' | 'auditor' | 'officer' | 'moderator' | 'outsider';
export const KEYS: Key[] = ['founder', 'founder2', 'operator', 'hubOwner', 'auditor', 'officer', 'moderator', 'outsider'];
export interface AttestationWorld {
  nodeId: string;
  hubId: string;
  people: Record<Key, string>;
  sessions: Record<Key, string>;
}

/** The restricted places synced into the kernel, as the maintenance command does on a real node. */
export async function syncRestrictedPlaces(admin: DataPool): Promise<void> {
  const reference = await kernelReference.fromRepository();
  await withMaintenance(admin, (trx) => kernelSync.apply(trx, reference));
}

export async function buildAttestationWorld(admin: DataPool): Promise<AttestationWorld> {
  return withMaintenance(admin, async (trx) => {
    for (const def of DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
        sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const { id: nodeId } = await adminSetup.createNode(trx, 'Synthetic attestation node');
    const hub = await trx.insertInto('hub').values({ slug: `synthetic-att-${randomBytes(3).toString('hex')}`, lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow();
    const people = {} as Record<Key, string>;
    const sessions = {} as Record<Key, string>;
    for (const key of KEYS) {
      people[key] = (await trx.insertInto('person').values({ display_name: `Synthetic ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({
        person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow()).id;
    }
    // The two founding administrators of the setup wizard; everything else is assigned through the console below.
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder2, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { nodeId, hubId: hub.id, people, sessions };
  });
}

export function actors(adminPool: DataPool, runtime: DataPool, world: AttestationWorld) {
  const principal = (personId: string): Promise<Principal> => principalFor(adminPool, personId);
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(runtime, await principal(personId), fn);
  const keyOf = (personId: string) => KEYS.find((k) => world.people[k] === personId) as Key;
  /** A fresh elevation of the person's own session (BE-004's row, as the API writes it after a verified factor). */
  const elevate = async (personId: string, validForSeconds = 900): Promise<CommandContext> => {
    const elevation = await as(personId, (trx) => sessionElevations.insert(trx, { sessionId: world.sessions[keyOf(personId)], personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + validForSeconds * 1000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic attestation test' };
  };
  const assign = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => {
    const ctx = await elevate(world.people.founder);
    return as(world.people.founder, (trx) => staffAssignments.assign(trx, ctx, { ...input, definitionVersion: 1 }));
  };
  /** A sensitive role: the founder asks, the second founder approves, the founder assigns. */
  const assignSensitive = async (input: { personId: string; role: HubStaffRole; scope: StaffScope }) => {
    const ownerCtx = await elevate(world.people.founder);
    const adminCtx = await elevate(world.people.founder2);
    const digest = adminDigests.assignment({ breakglass: false, personId: input.personId, role: input.role, scope: input.scope, definitionVersion: 1 });
    const request = await as(world.people.founder, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
    await as(world.people.founder2, (trx) => approvals.decide(trx, adminCtx, request.id, 'approve', digest));
    return as(world.people.founder, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, definitionVersion: 1, approvalId: request.id }));
  };
  /** The roles of the world's header comment. */
  const assignRoles = async () => {
    const node = { kind: 'node', nodeId: world.nodeId } as const;
    const hub = { kind: 'hub', hubId: world.hubId } as const;
    await assignSensitive({ personId: world.people.operator, role: 'node-operator', scope: node });
    await assignSensitive({ personId: world.people.hubOwner, role: 'hub-owner', scope: hub });
    await assignSensitive({ personId: world.people.officer, role: 'compliance-officer', scope: node });
    await assign({ personId: world.people.auditor, role: 'auditor', scope: node });
    await assign({ personId: world.people.moderator, role: 'moderator', scope: hub });
  };
  return { principal, as, elevate, assign, assignSensitive, assignRoles };
}

/** A US statement (the reference hub's deployment): entity in Delaware, hosting in a US region, upstream gate. */
export const US_STATEMENT = { operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate' } as const;

interface PgError { code?: string; hint?: string; message?: string; detail?: string }
export async function settle(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(() => null, (e: unknown) => e as PgError);
}
export async function rejects(promise: Promise<unknown>, state: string, hint?: string): Promise<PgError> {
  const error = await settle(promise);
  assert.ok(error, `expected a rejection${hint ? ` (${hint})` : ''}`);
  assert.equal(error.code, state, `${error.message} (hint ${error.hint})`);
  if (hint) assert.equal(error.hint, hint, error.message);
  return error;
}

/**
 * Concurrency gate: holds the node's attestation lock (the advisory key attestation_attest takes) in a connection of the
 * test, starts `race`, waits until `waiters` sessions queue on that lock, then releases it. Every racer has passed its
 * authorization and place checks before any of them reads the current attestation; the database then decides.
 */
export async function withHeldNodeLock<T>(admin: DataPool, nodeId: string, waiters: number, race: () => Promise<T>): Promise<T> {
  const key = `trustwork.deployment_location_attestation:${nodeId}`;
  const holder = await admin.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await holder.query('ROLLBACK');
    holder.release();
  };
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const running = race();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
      if ((rows[0]?.n ?? 0) >= waiters) break;
      if (Date.now() > deadline) throw new Error(`only ${rows[0]?.n} of ${waiters} attestations queued on the node lock`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await release();
    return await running;
  } finally {
    await release();
  }
}

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION, type ConsolePermission, type HubStaffRole } from '@trustwork/contracts';
import { adminSetup, adminDigests, approvals, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { agentKillSwitches, agentPolicies } from '../../packages/data/src/repositories/agent-modules.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { AgentPolicyDocumentSchema, diffPolicies, type AgentPolicyDocument, type AgentPolicyDraft, type PreviewCounts } from '../../packages/contracts/src/agent-modules.js';
import { Client, type Harness, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../admin/helpers.js';
import { actors, syncKernel, US_HUB, type HubWorld, type Key } from '../hubs/helpers.js';
import { REGISTRY } from './fixtures.js';

/**
 * Synthetic world for the AGT-003 database suites: the HUB-001 staff world with role definitions that include the agent
 * product permissions (hub owner and compliance officer manage policy and kill switches; a moderator has none of them),
 * the United States demo hub, and the DATA-001 personas as participants. Every person and hub is synthetic.
 */
const AGENTS: ConsolePermission[] = [
  'admin.hub.read', 'admin.config.edit', 'admin.agents.read', 'admin.agents.policy.edit', 'admin.agents.modules.edit', 'admin.agents.modules.activate', 'admin.agents.kill',
  'admin.providers.kill',
];
const DEFINITIONS: { role: HubStaffRole; scopes: ('platform' | 'node' | 'hub')[]; permissions: ConsolePermission[] }[] = [
  { role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.audit.read'] },
  { role: 'staff-admin', scopes: ['platform', 'node', 'hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read'] },
  { role: 'node-operator', scopes: ['node'], permissions: ['admin.node.hubs.manage', 'admin.hub.read'] },
  { role: 'hub-owner', scopes: ['hub'], permissions: AGENTS },
  { role: 'compliance-officer', scopes: ['node', 'hub'], permissions: AGENTS },
  { role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read'] },
];
const KEYS: Key[] = ['founder', 'founder2', 'operator', 'owner', 'officer', 'moderator', 'otherOwner', 'outsider'];
export type Staff = 'owner' | 'officer' | 'moderator';
export const STAFF: Staff[] = ['owner', 'officer', 'moderator'];
const emailOf = (key: Key) => `agent-modules-${key.toLowerCase()}@example.invalid`;

export interface AgentWorld {
  w: HubWorld;
  a: ReturnType<typeof actors>;
  hubId: string;
  staff: Record<Staff, Client>;
}

/** Staff world, the US demo hub (its id becomes TRUSTWORK_HUB_ID, read at every authority check) and elevated staff clients. */
export async function buildAgentWorld(h: Harness): Promise<AgentWorld> {
  await syncKernel(h.db.admin);
  const w = await withMaintenance(h.db.admin, async (trx) => {
    for (const def of DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const { id: nodeId } = await adminSetup.createNode(trx, 'Synthetic agent modules node');
    const people = {} as Record<Key, string>;
    const sessions = {} as Record<Key, string>;
    for (const key of KEYS) {
      people[key] = (await trx.insertInto('person').values({ display_name: `Synthetic ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({ person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow()).id;
    }
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder2, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { nodeId, people, sessions } satisfies HubWorld;
  });
  const a = actors(h.db.admin, h.pool, w);
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub(`synthetic-agents-${randomBytes(3).toString('hex')}`, { ...US_HUB, timeZone: 'America/New_York' })).hub_id;
  await a.assignSensitive({ personId: w.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId } });
  await a.assignSensitive({ personId: w.people.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId } });
  await a.assign({ personId: w.people.moderator, role: 'moderator', scope: { kind: 'hub', hubId } });
  h.staff.set(w.people.owner, ['hub-owner']);
  h.staff.set(w.people.officer, ['compliance-officer']);
  h.staff.set(w.people.moderator, ['moderator']);
  process.env.TRUSTWORK_HUB_ID = hubId;
  await addLogins(h, STAFF.map((k) => [w.people[k], emailOf(k)] as [string, string]));
  const staff = {} as Record<Staff, Client>;
  for (const key of STAFF) {
    staff[key] = h.client();
    await signIn(staff[key], emailOf(key));
    const secret = await enrolNow(h, staff[key]);
    h.clock.advance(30_000);
    assert.equal((await staff[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const elevated = await staff[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
    assert.equal(elevated.status, 200, JSON.stringify(elevated.body));
  }
  return { w, a, hubId, staff };
}

/** A console command (contract version, idempotency key restated, staff reason). */
export function command(client: Client, url: string, body: Record<string, unknown> = {}): Promise<Response> {
  const idempotencyKey = `agt3-${randomUUID()}`;
  return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic agent product change', ...body }, { idempotencyKey });
}

export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

/** The cohort counts the database reports for narrowed modules (owner session; the function is not granted to anyone else). */
export async function affected(admin: DataPool, moduleKeys: string[]): Promise<PreviewCounts> {
  return (await admin.query<{ c: PreviewCounts }>('SELECT trustwork.agent_modules_affected($1::text[]) AS c', [moduleKeys])).rows[0]!.c;
}

/** The document a drafter would store now: the draft plus the preview of its effect against the current policy. */
export async function documentFor(h: Harness, hubId: string, draft: AgentPolicyDraft): Promise<AgentPolicyDocument> {
  const current = (await h.db.admin.query<{ config_version_id: string; document: unknown }>('SELECT config_version_id, document FROM trustwork.agent_policy_current WHERE hub_id = $1', [hubId])).rows[0];
  const before = current ? AgentPolicyDocumentSchema.parse(current.document) : null;
  const diff = diffPolicies(before, draft, REGISTRY);
  return AgentPolicyDocumentSchema.parse({
    ...draft,
    preview: { computedAt: new Date().toISOString(), baseVersionId: current?.config_version_id ?? null, ...diff, registeredModuleKeys: REGISTRY.manifests.map((m) => m.key).sort(), affected: await affected(h.db.admin, diff.narrowedModuleKeys) },
  });
}

/** Drafts (owner) and activates (officer, owner approving) a policy through the repositories; returns the version id. */
export async function activatePolicy(h: Harness, world: AgentWorld, draft: AgentPolicyDraft): Promise<string> {
  const { a, w, hubId } = world;
  const document = await documentFor(h, hubId, draft);
  const v = await a.cmd(w.people.owner, async (trx, ctx) => {
    const version = await hubConfig.draft(trx, ctx, hubId, 'agents', document as unknown as Record<string, unknown>);
    await agentPolicies.recordDraft(trx, ctx, hubId, version.id, document);
    return version;
  });
  const approvalId = await a.approve(w.people.officer, w.people.owner, 'agents.enable_commitment_module', hubId,
    configActivationDigestInput({ id: v.id, hubId, domain: 'agents', version: v.version, payloadDigest: v.payload_digest }));
  await a.cmd(w.people.officer, (trx, ctx) => hubConfig.activate(trx, ctx, v.id, v.revision, approvalId));
  return v.id;
}

/** Engages an agent kill switch at the hub (one person) and returns its id. */
export async function engage(world: AgentWorld, scopeKind: string, target: { moduleKey?: string; capabilityId?: string; action?: string } = {}): Promise<string> {
  return (await world.a.cmd(world.w.people.owner, (trx, ctx) => agentKillSwitches.engage(trx, ctx, world.hubId, scopeKind, target))).id;
}
/** Releases a switch: the officer asks, the owner approves, the officer releases with an incident note. */
export async function release(world: AgentWorld, killSwitchId: string): Promise<void> {
  const note = 'Synthetic incident resolved';
  const { a, w, hubId } = world;
  const ctx = await a.elevate(w.people.officer);
  const digest = adminDigests.killSwitchRelease(killSwitchId, note);
  const request = await a.as(w.people.officer, (trx) => approvals.request(trx, ctx, { action: 'kill_switch.release', scope: { kind: 'hub', hubId }, actionDigest: digest }));
  await a.cmd(w.people.owner, (trx, c) => approvals.decide(trx, c, request.id, 'approve', digest));
  await a.as(w.people.officer, (trx) => agentKillSwitches.release(trx, ctx, killSwitchId, request.id, note));
}

/** Engages the node-wide switch (an owner-run synthetic setup; releasing it needs node authority, so suites engage it last). */
export async function engageNode(h: Harness, world: AgentWorld): Promise<string> {
  return withMaintenance(h.db.admin, async (trx) => (await sql<{ id: string }>`INSERT INTO trustwork.kill_switch (scope_kind, node_id, engaged_by, reason)
    VALUES ('node', ${world.w.nodeId}::uuid, ${world.w.people.founder}::uuid, 'Synthetic node stop') RETURNING id`.execute(trx)).rows[0]!.id);
}

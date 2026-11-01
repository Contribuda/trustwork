import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION, type ConsolePermission, type HubStaffRole } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { staffAssignments, staffRoleDefinitions, type StaffScope } from '../../packages/data/src/repositories/admin.js';
import { Client, type Harness, type RequestOptions, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { CommittedMailbox } from '../worker/mail/helpers/committed-mailbox.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../admin/helpers.js';
import { actors, buildAdminWorld, type AdminWorld } from '../data/admin/helpers.js';

/**
 * Synthetic support world over HTTP for the SUP-001 suites, on DATA-002's synthetic administration world. Role
 * definitions are test definitions over the real console vocabulary (not a released capability map): version 2 of
 * support-agent and support-lead adds the support workspace permissions. Every person, company and hub is synthetic.
 *
 * Staff (hub = the hub this API serves): agent support-agent (also an ordinary member of the world's company, so a
 * conflict of interest for that company); lead and lead2 support-lead; moderator (staff without any support
 * permission); auditor; otherAgent support-agent of another hub. Participants: customer (the usual subject), employee
 * (administrator of the company), outsider. Seven staff people cover the hub: full separation-of-duties mode.
 */
export type StaffKey = 'agent' | 'lead' | 'lead2' | 'moderator' | 'auditor' | 'otherAgent';
export type ParticipantKey = 'customer' | 'employee' | 'outsider';
export type Key = StaffKey | ParticipantKey;
export const emailOf = (key: Key) => `support-${key.toLowerCase()}@example.invalid`;

const SUPPORT_READS: ConsolePermission[] = ['admin.support.account.read', 'admin.support.explain', 'admin.support.diagnose', 'admin.support.notifications'];
const SUPPORT_SERVICING: ConsolePermission[] = ['admin.support.sessions.revoke', 'admin.support.second_factor.reset', 'admin.support.recovery.rebind'];
const V2: Array<{ role: HubStaffRole; permissions: ConsolePermission[]; grantMaxHours: number }> = [
  { role: 'support-agent', permissions: ['admin.support.case.create', 'admin.support.grant.request', ...SUPPORT_READS, ...SUPPORT_SERVICING], grantMaxHours: 24 },
  { role: 'support-lead', permissions: ['admin.support.case.create', 'admin.support.case.close', 'admin.support.grant.request', 'admin.support.grant.approve', 'admin.support.recovery.approve',
    ...SUPPORT_READS, ...SUPPORT_SERVICING], grantMaxHours: 72 },
];

export interface SupportWorld {
  world: AdminWorld;
  people: Record<Key, string>;
  app: CreatedApp;
  mail: CommittedMailbox;
  clients: Record<Key, Client>;
  secrets: Partial<Record<Key, Buffer>>;
  /** A fresh step-up and elevation for every enrolled staff client of this hub. */
  elevateAll(): Promise<void>;
  close(): Promise<void>;
}

export async function buildSupportWorld(h: Harness): Promise<SupportWorld> {
  const world = await buildAdminWorld(h.db.admin);
  await withMaintenance(h.db.admin, async (trx) => {
    for (const def of V2) {
      await staffRoleDefinitions.release(trx, { version: 2, role: def.role, scopes: ['hub'], permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: def.grantMaxHours },
        sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
  });
  const act = actors(h.db.admin, h.pool, world);
  const assign = async (personId: string, role: HubStaffRole, scope: StaffScope, definitionVersion: number) => {
    const ctx = await act.elevate(world.people.owner);
    await act.as(world.people.owner, (trx) => staffAssignments.assign(trx, ctx, { personId, role, scope, definitionVersion }));
  };
  const hub = { kind: 'hub', hubId: world.hubId } as const;
  await assign(world.people.agent, 'support-agent', hub, 2);
  await assign(world.people.lead, 'support-lead', hub, 2);
  await assign(world.people.lead2, 'support-lead', hub, 2);
  await assign(world.people.moderator, 'moderator', hub, 1);
  await assign(world.people.auditor, 'auditor', hub, 1);
  await assign(world.people.otherAgent, 'support-agent', { kind: 'hub', hubId: world.otherHubId }, 2);
  const people: Record<Key, string> = {
    agent: world.people.agent, lead: world.people.lead, lead2: world.people.lead2, moderator: world.people.moderator, auditor: world.people.auditor, otherAgent: world.people.otherAgent,
    customer: world.people.customer, employee: world.people.employee, outsider: world.people.outsider,
  };
  await addLogins(h, (Object.keys(people) as Key[]).map((k) => [people[k], emailOf(k)]));

  const mailKey = randomBytes(32);
  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: world.hubId, MAIL_SECRET_KEY: mailKey.toString('hex') },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
  const clients = {} as Record<Key, Client>;
  const secrets: Partial<Record<Key, Buffer>> = {};
  const staffKeys: StaffKey[] = ['agent', 'lead', 'lead2', 'moderator', 'auditor', 'otherAgent'];
  for (const key of Object.keys(people) as Key[]) {
    const client = new Client(app);
    await signIn(client, emailOf(key));
    if ((staffKeys as string[]).includes(key)) secrets[key] = await enrolNow(h, client);
    clients[key] = client;
  }
  return {
    world, people, app, clients, secrets, mail: new CommittedMailbox(h.db.admin, mailKey),
    async elevateAll() {
      h.clock.advance(30_000);
      for (const key of staffKeys) {
        if (key === 'otherAgent') continue; // no role here: elevation is refused
        const fresh = await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null });
        assert.equal(fresh.status, 200, `step-up ${key}: ${JSON.stringify(fresh.body)}`);
        const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key] as Buffer) } }, { idempotencyKey: null });
        assert.equal(response.status, 200, `elevate ${key}: ${JSON.stringify(response.body)}`);
      }
    },
    async close() {
      await app.close();
    },
  };
}

/** A console command: contract version, a reason and the idempotency key, repeated in the header. */
export function command(client: Client, url: string, body: Record<string, unknown> = {}, options: RequestOptions & { key?: string } = {}): Promise<Response> {
  const key = options.key ?? `sup-${randomUUID()}`;
  return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic support test action', ...body }, { ...options, idempotencyKey: key });
}
/** A recorded support query (lookup, account card, explainer): no idempotency key, a staff reason. */
export function query(client: Client, url: string, body: Record<string, unknown> = {}): Promise<Response> {
  return client.post(url, { reason: 'Synthetic support query', ...body }, { idempotencyKey: null });
}

export function expectRefusal(response: Response, status: number, code: string, reason?: string): void {
  const body = response.body as { code?: string; details?: { reason?: string; required?: string } };
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(body.code, code, JSON.stringify(response.body));
  if (reason !== undefined) assert.equal(body.details?.reason ?? body.details?.required, reason, JSON.stringify(response.body));
}

/** Moves a servicing action (and its BE-004 reset) 73 hours into the past: the cooling-off runs on the database clock. */
export async function backdate(h: Harness, actionId: string): Promise<void> {
  const client = await h.db.admin.connect();
  try {
    await client.query('BEGIN');
    // Superuser test path only: skip the guard triggers so the timestamps move without a state change.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("UPDATE trustwork.account_service_action SET requested_at = requested_at - interval '73 hours', approved_at = approved_at - interval '73 hours', effective_at = effective_at - interval '73 hours' WHERE id = $1", [actionId]);
    await client.query("UPDATE trustwork.second_factor_reset r SET requested_at = r.requested_at - interval '73 hours', approved_at = r.approved_at - interval '73 hours', effective_at = r.effective_at - interval '73 hours' FROM trustwork.account_service_action a WHERE a.id = $1 AND r.id = a.second_factor_reset_id", [actionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const count = async (h: Harness, sql: string, params: unknown[] = []): Promise<number> =>
  (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0]?.n ?? 0;

/** Inserts a participation row (maintenance path) for explainer and diagnostics fixtures. */
export async function participation(h: Harness, row: {
  resourceId: string; party: { kind: 'person' | 'company'; id: string }; side: 'owner' | 'buyer' | 'seller' | 'participant'; capabilities: string[]; audience?: string;
  validUntil?: Date | null; revoked?: boolean; grantedBy: string; validFrom?: Date;
}): Promise<void> {
  await withMaintenance(h.db.admin, (trx) => trx.insertInto('object_participation').values({
    resource_kind: 'project', resource_id: row.resourceId, party_person_id: row.party.kind === 'person' ? row.party.id : null, party_company_id: row.party.kind === 'company' ? row.party.id : null,
    side: row.side, capabilities: row.capabilities, audience: (row.audience ?? 'shared_party') as 'shared_party', valid_from: row.validFrom ?? new Date(Date.now() - 86_400_000),
    valid_until: row.validUntil ?? null, granted_by_person_id: row.grantedBy, revoked_at: row.revoked ? new Date() : null, revoked_reason: row.revoked ? 'Synthetic revocation' : null,
  }).execute());
}

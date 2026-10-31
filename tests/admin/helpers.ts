import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { withMaintenance } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { MODERATION_TARGETS, SANCTION_ENFORCEMENT, type RecordingModerationTargets, type RecordingSanctionEnforcement } from '../../apps/api/src/modules/platform-admin/ports.js';
import { supportCases } from '../../packages/data/src/repositories/admin.js';
import { Client, type Harness, type RequestOptions, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { base32Decode } from '../../apps/api/src/modules/identity/second-factor/totp.js';
import { actors, buildAdminWorld, type AdminWorld } from '../data/admin/helpers.js';

/**
 * Synthetic administration world over HTTP for the ADM-001 suites. People, companies and hubs are synthetic
 * ("Synthetic …"); role definitions are DATA-002's test definitions over the real console vocabulary (not the released
 * capability map). Staff roles are assigned through DATA-002's own commands by the two founding administrators; the
 * API under test resolves them from `staff_role_assignment` (no injected resolver) for the hub it serves.
 */
export type StaffKey = 'owner' | 'admin' | 'admin2' | 'hubOwner' | 'moderator' | 'lead' | 'lead2' | 'agent' | 'ops' | 'auditor' | 'otherAgent';
export type ParticipantKey = 'customer' | 'employee' | 'outsider' | 'candidate';
export type Key = StaffKey | ParticipantKey;
export const PASSWORD = 'synthetic-admin-password-0001';
export const emailOf = (key: Key) => `admin-${key.toLowerCase()}@example.invalid`;

export interface AdminWorldHttp {
  world: AdminWorld;
  people: Record<Key, string>;
  app: CreatedApp;
  actors: ReturnType<typeof actors>;
  moderationTargets: RecordingModerationTargets;
  sanctions: RecordingSanctionEnforcement;
  clients: Record<Key, Client>;
  secrets: Partial<Record<Key, Buffer>>;
  /** A fresh elevation for every enrolled staff client (one TOTP step later). */
  elevateAll(): Promise<void>;
  close(): Promise<void>;
}

/** Adds a verified address and a password credential (maintenance path), so the person can sign in. */
export async function addLogins(h: Harness, entries: Array<[string, string]>): Promise<void> {
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await withMaintenance(h.db.admin, async (trx) => {
    for (const [personId, email] of entries) {
      await trx.insertInto('email_binding').values({ person_id: personId, email_normalized: email, is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: personId, kind: 'password', password_hash: passwordHash }).execute();
    }
  });
}

export async function signIn(client: Client, email: string): Promise<void> {
  const response = await client.post('/v1/auth/login', { email, password: PASSWORD }, { idempotencyKey: null });
  assert.equal(response.status, 200, `login ${email}: ${JSON.stringify(response.body)}`);
}

/** Enrols TOTP right after sign-in (fresh step-up) and returns the secret; the factor's last step is the current one. */
export async function enrolNow(h: Harness, client: Client): Promise<Buffer> {
  const started = await client.post('/v1/me/second-factor/totp', undefined, { idempotencyKey: null });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const body = started.body as { factorId: string; secret: string };
  const secret = base32Decode(body.secret);
  const confirmed = await client.post('/v1/me/second-factor/totp/confirm', { factorId: body.factorId, code: codeNow(h, secret) }, { idempotencyKey: null });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return secret;
}

/** A console command: contract version, a reason and the idempotency key, repeated in the header. */
export function command(client: Client, url: string, body: Record<string, unknown> = {}, options: RequestOptions & { key?: string } = {}): Promise<Response> {
  const key = options.key ?? `adm-${randomUUID()}`;
  return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic test action', ...body }, { ...options, idempotencyKey: key });
}

export function expectRefusal(response: Response, status: number, code: string, reason?: string): void {
  const body = response.body as { code?: string; details?: { reason?: string; required?: string } };
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(body.code, code, JSON.stringify(response.body));
  if (reason !== undefined) assert.equal(body.details?.reason ?? body.details?.required, reason, JSON.stringify(response.body));
}

/**
 * Builds the world: DATA-002's synthetic hub, node and people plus a few extra people, the roles below, logins for
 * everyone, an API serving the world's hub, and signed-in clients (staff enrolled in TOTP, not yet elevated).
 *
 * Roles (hub = the served hub): owner platform-owner@platform and admin staff-admin@platform (founding); admin2
 * staff-admin@platform; hubOwner hub-owner@hub; moderator moderator@hub; lead, lead2 support-lead@hub; agent
 * support-agent@hub (also a member of the customer's company: a conflict of interest); ops ops-engineer@hub; auditor
 * auditor@hub; otherAgent support-agent in another hub of the node (no role here). That is ten staff people
 * covering the hub (full separation-of-duties mode) and four covering the other hub (reduced mode).
 */
export async function buildHttpWorld(h: Harness): Promise<AdminWorldHttp> {
  const world = await buildAdminWorld(h.db.admin);
  const extra = await withMaintenance(h.db.admin, async (trx) => {
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    return { admin2: await person('Synthetic Second Staff Admin'), candidate: await person('Synthetic Staff Candidate') };
  });
  const people: Record<Key, string> = {
    owner: world.people.owner, admin: world.people.admin, admin2: extra.admin2, hubOwner: world.people.hubOwner, moderator: world.people.moderator, lead: world.people.lead,
    lead2: world.people.lead2, agent: world.people.agent, ops: world.people.ops, auditor: world.people.auditor, otherAgent: world.people.otherAgent, customer: world.people.customer,
    employee: world.people.employee, outsider: world.people.outsider, candidate: extra.candidate,
  };
  const act = actors(h.db.admin, h.pool, world);
  const hub = { kind: 'hub', hubId: world.hubId } as const;
  await act.assignSensitive({ personId: people.admin2, role: 'staff-admin', scope: { kind: 'platform' } });
  await act.assignSensitive({ personId: people.hubOwner, role: 'hub-owner', scope: hub });
  for (const [key, role] of [['moderator', 'moderator'], ['lead', 'support-lead'], ['lead2', 'support-lead'], ['agent', 'support-agent'], ['ops', 'ops-engineer']] as const) {
    await act.assign({ personId: people[key], role, scope: hub });
  }
  await act.assign({ personId: people.auditor, role: 'auditor', scope: hub });
  await act.assign({ personId: people.otherAgent, role: 'support-agent', scope: { kind: 'hub', hubId: world.otherHubId } });
  await addLogins(h, (Object.keys(people) as Key[]).map((k) => [people[k], emailOf(k)]));

  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: world.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
  const clients = {} as Record<Key, Client>;
  const secrets: Partial<Record<Key, Buffer>> = {};
  const staffKeys: StaffKey[] = ['owner', 'admin', 'admin2', 'hubOwner', 'moderator', 'lead', 'lead2', 'agent', 'ops', 'auditor', 'otherAgent'];
  for (const key of Object.keys(people) as Key[]) {
    const client = new Client(app);
    await signIn(client, emailOf(key));
    if ((staffKeys as string[]).includes(key)) secrets[key] = await enrolNow(h, client);
    clients[key] = client;
  }
  return {
    world, people, app, actors: act, clients, secrets,
    // CNT-001 wraps the recording fake in the content adapter (apps/api/src/modules/content/moderation.ts), which forwards every effect to it.
    moderationTargets: ((t: { next?: unknown }) => (t.next ?? t) as RecordingModerationTargets)(app.app.get(MODERATION_TARGETS) as { next?: unknown }),
    sanctions: app.app.get(SANCTION_ENFORCEMENT) as RecordingSanctionEnforcement,
    async elevateAll() {
      h.clock.advance(30_000);
      for (const key of staffKeys) {
        if (key === 'otherAgent') continue; // no role here: elevation is refused
        const secret = secrets[key] as Buffer;
        const fresh = await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null });
        assert.equal(fresh.status, 200, `step-up ${key}: ${JSON.stringify(fresh.body)}`);
        const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
        assert.equal(response.status, 200, `elevate ${key}: ${JSON.stringify(response.body)}`);
      }
    },
    async close() {
      await app.close();
    },
  };
}

/** A support case the customer opens about themselves (participant path), for case grants. */
export async function customerCase(w: AdminWorldHttp): Promise<string> {
  const row = await w.actors.as(w.people.customer, (trx) => supportCases.openOwn(trx, { hubId: w.world.hubId, category: 'account_access', summary: 'Synthetic: cannot open my project' }));
  return row.id;
}
/** A support case the employee opens for their employer (the company the support agent also belongs to). */
export async function companyCase(w: AdminWorldHttp): Promise<string> {
  const row = await w.actors.as(w.people.employee, (trx) => supportCases.openOwn(trx, { hubId: w.world.hubId, forCompany: true, category: 'billing_question', summary: 'Synthetic: invoice question' }));
  return row.id;
}

export async function auditRows(h: Harness, where: string, params: unknown[] = []): Promise<Array<{ action: string; outcome: string; actor_person_id: string; reason_code: string; second_approver_person_id: string | null }>> {
  const { rows } = await h.db.admin.query(`SELECT action, outcome, actor_person_id, reason_code, second_approver_person_id FROM trustwork.admin_audit_event WHERE ${where} ORDER BY sequence`, params);
  return rows;
}

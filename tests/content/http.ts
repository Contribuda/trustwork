import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { Client, type Harness, type RequestOptions, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../admin/helpers.js';
import { buildContentWorld, type ContentWorld } from './helpers.js';

/**
 * The synthetic content world over HTTP: an API created like production (staff roles resolved from
 * staff_role_assignment for `TRUSTWORK_HUB_ID`), signed-in clients for every person, staff enrolled in TOTP and
 * elevated on demand. `TRUSTWORK_HUB_ID` is also set in the process environment, which the content module reads per
 * request; `close()` restores it.
 */
export type HttpKey = 'writer' | 'coauthor' | 'member' | 'employee' | 'editorA' | 'editorB' | 'chief' | 'moderator' | 'owner' | 'reader' | 'outsider' | 'mentioned';
const KEYS: HttpKey[] = ['writer', 'coauthor', 'member', 'employee', 'editorA', 'editorB', 'chief', 'moderator', 'owner', 'reader', 'outsider', 'mentioned'];
const STAFF: HttpKey[] = ['editorA', 'editorB', 'chief', 'moderator', 'owner'];

export interface ContentHttpWorld {
  w: ContentWorld;
  app: CreatedApp;
  c: Record<HttpKey, Client>;
  anonymous: Client;
  elevate(...keys: HttpKey[]): Promise<void>;
  close(): Promise<void>;
}

export async function buildContentHttpWorld(h: Harness): Promise<ContentHttpWorld> {
  const w = await buildContentWorld(h.db.admin, h.pool);
  const ids = w.people as Record<HttpKey, string>;
  const email = (k: HttpKey) => `content-${k.toLowerCase()}@example.invalid`;
  await addLogins(h, KEYS.map((k) => [ids[k], email(k)]));
  const previousHub = process.env.TRUSTWORK_HUB_ID;
  process.env.TRUSTWORK_HUB_ID = w.hubId;
  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: w.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
  const c = {} as Record<HttpKey, Client>;
  const secrets: Partial<Record<HttpKey, Buffer>> = {};
  for (const key of KEYS) {
    const client = new Client(app);
    await signIn(client, email(key));
    if (STAFF.includes(key)) secrets[key] = await enrolNow(h, client);
    c[key] = client;
  }
  return {
    w, app, c, anonymous: new Client(app),
    async elevate(...keys: HttpKey[]) {
      h.clock.advance(30_000);
      for (const key of keys.length ? keys : STAFF) {
        const fresh = await c[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null });
        assert.equal(fresh.status, 200, `step-up ${key}: ${JSON.stringify(fresh.body)}`);
        const r = await c[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key] as Buffer) } }, { idempotencyKey: null });
        assert.equal(r.status, 200, `elevate ${key}: ${JSON.stringify(r.body)}`);
      }
    },
    async close() {
      await app.close();
      if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID;
      else process.env.TRUSTWORK_HUB_ID = previousHub;
    },
  };
}

/** A console command with the contract version, a reason and the idempotency key repeated in the header. */
export function consoleCommand(client: Client, url: string, body: Record<string, unknown> = {}, options: RequestOptions & { key?: string } = {}): Promise<Response> {
  const key = options.key ?? `cnt-${randomUUID()}`;
  return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic editorial action', ...body }, { ...options, idempotencyKey: key });
}

export function expectRefusal(response: Response, status: number, code: string, reason?: string): void {
  const body = response.body as { code?: string; details?: { reason?: string; required?: string } };
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(body.code, code, JSON.stringify(response.body));
  if (reason !== undefined) assert.equal(body.details?.reason ?? body.details?.required, reason, JSON.stringify(response.body));
}
export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

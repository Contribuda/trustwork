import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../../../apps/api/src/app.js';
import { Client, type Harness } from '../../backend/helpers/app.js';
import { addLogins, enrolNow, signIn } from '../../admin/helpers.js';
import { codeNow } from '../../backend/second-factor/helpers.js';
import { feeWorld } from './helpers.js';

export async function feeHttpWorld(h: Harness) {
  const world = await feeWorld(h.db.admin, h.pool);
  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000',
      AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: world.hubA, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[fee-api]', line); },
  });
  const clients = {} as Record<'owner' | 'officer' | 'otherOwner' | 'outsider', Client>;
  const secrets = {} as Record<keyof typeof clients, Buffer>;
  const keys = ['owner', 'officer', 'otherOwner', 'outsider'] as const;
  await addLogins(h, keys.map((k) => [world.p[k], `synthetic-fee-${k.toLowerCase()}@example.invalid`]));
  for (const key of keys) {
    clients[key] = new Client(app);
    await signIn(clients[key], `synthetic-fee-${key.toLowerCase()}@example.invalid`);
    secrets[key] = await enrolNow(h, clients[key]);
  }
  const elevate = async () => {
    h.clock.advance(30000);
    for (const key of ['owner', 'officer'] as const) {
      const r = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  };
  return { ...world, app, clients, elevate, anonymous: new Client(app) };
}

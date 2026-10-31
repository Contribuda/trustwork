import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.js';
import { Client, SKIP_REASON, startHarness, type Harness } from '../backend/helpers/app.js';

/**
 * OPS-001 / audit B6: the client address used by rate limits and the per-IP lockout comes from the socket peer
 * unless forwarding hops are explicitly trusted; a spoofed X-Forwarded-For from an untrusted hop changes nothing.
 */
const h = await startHarness('ops_proxy');

async function appWith(harness: Harness, env: Record<string, string>) {
  return createApp({
    env: { PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '3', AUTH_LOCKOUT_IP_THRESHOLD: '1000', AUTH_LOCKOUT_THRESHOLD: '1000', ...env },
    pool: harness.pool, mail: harness.mail, clock: harness.clock, logSink: () => undefined,
  });
}
const attempt = (client: Client, remoteAddress: string, forwardedFor: string | null, n: number) =>
  client.post('/v1/auth/login', { email: `nobody-${n}@example.invalid`, password: 'wrong password for limits' }, { idempotencyKey: null, remoteAddress, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} });

test('spoofed X-Forwarded-For cannot dodge client limits', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());

  await t.test('default (no trusted hop): every request from one peer shares one bucket whatever X-Forwarded-For says', async () => {
    const created = await appWith(h, {});
    t.after(() => created.close());
    const client = new Client(created);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt(client, '198.51.100.7', `203.0.113.${i + 1}`, i)).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    // Another real peer is not affected.
    assert.equal((await attempt(client, '198.51.100.8', null, 9)).status, 401);
  });

  await t.test('concurrent spoofed burst: never more than the limit passes', async () => {
    const created = await appWith(h, {});
    t.after(() => created.close());
    const client = new Client(created);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => attempt(client, '198.51.100.20', `10.9.8.${i}`, i)));
    // The in-memory store counts a simultaneous burst before answering, so it may refuse even the first three; the
    // security property is the upper bound: varying X-Forwarded-For never buys extra attempts.
    assert.ok(results.filter((r) => r.status === 401).length <= 3, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status === 429).length >= 9);
    for (const r of results.filter((x) => x.status === 429)) assert.equal((r.body as { code: string }).code, 'auth.throttled');
  });

  await t.test('one trusted hop: the address appended by the proxy counts; spoofed entries to its left do not', async () => {
    const created = await appWith(h, { API_TRUSTED_PROXY_HOPS: '1' });
    t.after(() => created.close());
    const client = new Client(created);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt(client, '10.0.0.2', `6.6.6.${i}, 203.0.113.50`, i)).status);
    assert.deepEqual(statuses, [401, 401, 401, 429], 'same real client behind the proxy, spoofed prefixes ignored');
    assert.equal((await attempt(client, '10.0.0.2', '203.0.113.51', 7)).status, 401, 'a different real client has its own bucket');
  });

  await t.test('trusted address list: forwarding headers from an untrusted peer are ignored', async () => {
    const created = await appWith(h, { API_TRUSTED_PROXIES: '10.0.0.0/8' });
    t.after(() => created.close());
    const client = new Client(created);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt(client, '192.0.2.66', `203.0.113.${100 + i}`, i)).status);
    assert.deepEqual(statuses, [401, 401, 401, 429], 'untrusted peer: its own address is the key');
    assert.equal((await attempt(client, '10.1.2.3', '203.0.113.200', 8)).status, 401, 'trusted proxy: the forwarded client is the key');
  });

  await t.test('the per-IP lockout uses the same client address (no rate limit in the way)', async () => {
    const created = await appWith(h, { AUTH_RATE_LIMIT_PER_MINUTE: '1000', AUTH_LOCKOUT_IP_THRESHOLD: '2' });
    t.after(() => created.close());
    const client = new Client(created);
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await attempt(client, '198.51.100.99', `203.0.113.${150 + i}`, 100 + i);
      bodies.push((r.body as { code: string }).code);
    }
    assert.deepEqual(bodies.slice(0, 2), ['auth.invalid_credentials', 'auth.invalid_credentials']);
    assert.deepEqual(bodies.slice(2), ['auth.throttled', 'auth.throttled'], 'spoofed addresses do not reset the per-IP counter');
  });
});

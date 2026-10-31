import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger, principalPseudonym, redact, REDACTED, scrubText } from '../../apps/api/src/observability/logger.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { failingPool, LogCapture, PLANTED, SAME_ORIGIN } from './helpers.js';

const FLOW_SECRET = 'f0'.repeat(32);

function assertNoPlantedSecret(lines: string[]): void {
  const all = lines.join('\n');
  for (const [name, value] of Object.entries(PLANTED)) assert.ok(!all.includes(value), `planted ${name} leaked into logs`);
  assert.ok(!all.includes(FLOW_SECRET), 'flow secret leaked');
}

test('a forced 500 (handler path) produces exactly one JSON line with the stack and request id and no secret or private field', async () => {
  const logs = new LogCapture();
  const created = await createApp({ env: { PUBLIC_ORIGIN: 'https://hub.example.test', AUTH_FLOW_SECRET: FLOW_SECRET }, pool: failingPool(), logSink: logs.sink });
  try {
    const requestId = 'ops-forced-500-handler';
    const response = await created.fastify.inject({
      method: 'POST', url: '/v1/auth/login?token=' + PLANTED.apiToken,
      headers: { ...SAME_ORIGIN, 'x-request-id': requestId, authorization: `Bearer ${PLANTED.bearer}`, cookie: `__Host-sr_flow=${PLANTED.sessionToken}`, 'x-project-budget': PLANTED.budget },
      payload: { email: PLANTED.email, password: PLANTED.password },
    });
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(JSON.parse(response.body), { code: 'internal.error', message: 'internal error', requestId }, 'the client sees only the envelope');
    const lines = logs.forRequest(requestId);
    assert.equal(lines.length, 1, `one line for the failed request, got ${JSON.stringify(lines)}`);
    const line = lines[0]!;
    assert.equal(line.level, 'error');
    assert.equal(line.event, 'http.request');
    assert.equal(line.requestId, requestId);
    assert.equal(line.route, '/v1/auth/login', 'route pattern, never the raw URL with its query');
    assert.equal(line.method, 'POST');
    assert.equal(line.status, 500);
    assert.equal(typeof line.durationMs, 'number');
    assert.equal(line.principal, null);
    const err = line.err as { type: string; message: string; code: string; stack: string };
    assert.equal(err.code, 'ECONNREFUSED');
    assert.match(err.stack, /\n\s+at /, 'stack trace kept');
    assert.match(err.message, /postgresql:\/\/\[redacted\]@db\.internal/);
    assert.match(err.message, /\[email\]/);
    assertNoPlantedSecret(logs.lines);
    for (const raw of logs.lines) JSON.parse(raw);
  } finally {
    await created.close();
  }
});

test('a forced 500 in the request hook (principal resolution) is logged once with the same guarantees', async () => {
  const logs = new LogCapture();
  const created = await createApp({ env: { PUBLIC_ORIGIN: 'https://hub.example.test', AUTH_FLOW_SECRET: FLOW_SECRET }, pool: failingPool(), logSink: logs.sink });
  try {
    const requestId = 'ops-forced-500-hook';
    const response = await created.fastify.inject({ method: 'GET', url: '/v1/me', headers: { 'x-request-id': requestId, cookie: `__Host-sr_session=${PLANTED.sessionToken}` } });
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.parse(response.body).code, 'internal.error');
    const lines = logs.forRequest(requestId);
    assert.equal(lines.length, 1);
    assert.match((lines[0]!.err as { stack: string }).stack, /principal\.service/);
    assertNoPlantedSecret(logs.lines);
  } finally {
    await created.close();
  }
});

test('redaction: secret and private keys are removed at any depth; free text is scrubbed; cycles do not break logging', () => {
  const value: Record<string, unknown> = {
    user: { password: 'x', passwordHash: 'y', sessionToken: 'z', email: 'a@b.test', budget: 5, floorPrice: 7, nested: { authorization: 'Bearer q', 'set-cookie': 'c=1' } },
    note: `call postgres://u:p@h/db with Bearer abc.def and ${PLANTED.email}`,
    hash: 'ab'.repeat(32),
  };
  value.self = value;
  const out = redact(value) as Record<string, Record<string, unknown>>;
  const user = out.user!;
  for (const key of ['password', 'passwordHash', 'sessionToken', 'email', 'budget', 'floorPrice']) assert.equal(user[key], REDACTED, key);
  assert.deepEqual(user.nested, { authorization: REDACTED, 'set-cookie': REDACTED });
  assert.equal(out.note, `call postgres://${REDACTED}@h/db with Bearer ${REDACTED} and [email]`);
  assert.equal(out.hash, '[hex]');
  assert.equal(out.self, '[cycle]');
  assert.equal(scrubText('password=hunter2; api_key: "k-1"'), `password=${REDACTED}; api_key: ${REDACTED}`);
});

test('logger levels, reserved fields and a throwing sink', () => {
  const lines: string[] = [];
  const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line), clock: () => new Date('2026-10-31T00:00:00Z') });
  logger.info('ignored');
  logger.warn('kept', { level: 'debug', event: 'spoofed', password: 'p', count: 3 });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { time: '2026-10-31T00:00:00.000Z', level: 'warn', service: 'trustwork-api', event: 'kept', password: REDACTED, count: 3 });
  const throwing = createLogger({ sink: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => throwing.error('x'));
});

const h = await startHarness('ops_logging');
test('authenticated requests carry a stable keyed pseudonym, never the person id, e-mail or session', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const logs = new LogCapture();
  // A second app on the same database with captured logs (the harness app prints only failures).
  const created = await createApp({ env: { PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_FLOW_SECRET: FLOW_SECRET, AUTH_RATE_LIMIT_PER_MINUTE: '1000' }, pool: h.pool, clock: h.clock, logSink: logs.sink });
  t.after(() => created.close());
  const { Client } = await import('../backend/helpers/app.js');
  const client = new Client(created);
  await login(client, 'anna');
  const me = await client.get('/v1/me', { headers: { 'x-request-id': 'ops-me-1' } });
  assert.equal(me.status, 200);
  const again = await client.get('/v1/me', { headers: { 'x-request-id': 'ops-me-2' } });
  assert.equal(again.status, 200);
  const [first] = logs.forRequest('ops-me-1');
  const [second] = logs.forRequest('ops-me-2');
  const expected = principalPseudonym(created.config.log.pseudonymKey, seed.people.anna);
  assert.match(String(first!.principal), /^p_[0-9a-f]{20}$/);
  assert.equal(first!.principal, expected);
  assert.equal(second!.principal, first!.principal, 'stable across requests');
  assert.equal(first!.route, '/v1/me');
  assert.equal(first!.level, 'info');
  const all = logs.lines.join('\n');
  assert.ok(!all.includes(seed.people.anna), 'person id never logged');
  assert.ok(!all.includes('anna@example.invalid'), 'e-mail never logged');
  if (client.sessionCookie) assert.ok(!all.includes(client.sessionCookie), 'session token never logged');
});

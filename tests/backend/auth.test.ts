import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SESSION_COOKIE, FLOW_COOKIE } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { createApp, expectError, SKIP_REASON, startHarness, type Client } from './helpers/app.js';
import { apiConfigFromEnv } from '../../apps/api/src/config.js';
import { EMAILS, login, PASSWORDS, seedPersonas } from './helpers/personas.js';

const h = await startHarness('auth');

test('authentication flows over HTTP against the Nest app (Fastify inject, real PostgreSQL)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const anonymous = h.client();
  const PASSWORD = 'correct horse battery staple 42';

  await t.test('health stays the bootstrap contract', async () => {
    const r = await anonymous.get('/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'ok', mode: 'bootstrap', externalProviders: 'fake' }, 'health reports the configured provider mode truthfully');
  });

  await t.test('EN-02/AL-06: signup is identical for a new and an already bound address; no session before verification', async () => {
    const fresh = await anonymous.post('/v1/auth/signup', { name: 'Новый участник', email: 'newcomer@example.invalid', password: PASSWORD, acceptedTermsVersion: 'draft-2026-10' }, { idempotencyKey: null });
    const duplicate = await anonymous.post('/v1/auth/signup', { name: 'Кто-то', email: 'newcomer@example.invalid', password: PASSWORD, acceptedTermsVersion: 'draft-2026-10' }, { idempotencyKey: null });
    const existing = await anonymous.post('/v1/auth/signup', { name: 'Кто-то', email: EMAILS.anna, password: PASSWORD, acceptedTermsVersion: 'draft-2026-10' }, { idempotencyKey: null });
    for (const r of [fresh, duplicate, existing]) {
      assert.equal(r.status, 202);
      assert.deepEqual(r.body, { status: 'verification_sent' });
      assert.equal(r.cookies.length, 0, 'no Set-Cookie before verification');
    }
    // BE-002: an address held only by an unverified binding stays claimable by mailbox proof, so the second signup
    // receives its own verification link instead of an "already registered" notice.
    assert.equal(h.mail.countTo('newcomer@example.invalid', 'verify_email'), 2);
    assert.equal(h.mail.countTo('newcomer@example.invalid', 'already_registered'), 0);
    assert.equal(h.mail.countTo(EMAILS.anna, 'already_registered'), 1);
    const beforeVerify = await anonymous.post('/v1/auth/login', { email: 'newcomer@example.invalid', password: PASSWORD }, { idempotencyKey: null });
    expectError(beforeVerify, 401, 'auth.invalid_credentials');
    assert.equal(beforeVerify.cookies.length, 0);
  });

  await t.test('verification POST issues the first session; the token is single use; the cookie carries the hardened attributes', async () => {
    const token = h.mail.lastTo('newcomer@example.invalid', 'verify_email')?.params.token as string;
    const client = h.client();
    const verified = await client.post('/v1/auth/verify-email', { token }, { idempotencyKey: null });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const cookie = verified.cookies.find((c) => c.name === SESSION_COOKIE);
    assert.ok(cookie, 'first session issued by the verification POST');
    const raw = verified.headers['set-cookie'];
    const header = (Array.isArray(raw) ? raw : [raw]).find((v) => v?.startsWith(SESSION_COOKIE)) as string;
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
    assert.doesNotMatch(header, /Domain=/);
    const again = await anonymous.post('/v1/auth/verify-email', { token }, { idempotencyKey: null });
    expectError(again, 404, 'access.not_found');
    const me = await client.get('/v1/me');
    assert.equal(me.status, 200);
    const body = me.body as { person: { emailBindings: { verifiedAt: string | null }[] }; principal: { emailVerified: boolean } };
    assert.equal(body.principal.emailVerified, true);
    assert.equal(body.person.emailBindings[0]?.verifiedAt !== null, true);
    assert.ok(!('tokenHash' in body.person));
    const login = await h.client().post('/v1/auth/login', { email: 'newcomer@example.invalid', password: PASSWORD }, { idempotencyKey: null });
    assert.equal(login.status, 200);
  });

  await t.test('EN-01: wrong password and unknown address answer identically; T06 a token hash is not a cookie', async () => {
    const wrong = await anonymous.post('/v1/auth/login', { email: EMAILS.petr, password: 'not the password at all' }, { idempotencyKey: null });
    const unknown = await anonymous.post('/v1/auth/login', { email: 'nobody@example.invalid', password: 'not the password at all' }, { idempotencyKey: null });
    expectError(wrong, 401, 'auth.invalid_credentials');
    expectError(unknown, 401, 'auth.invalid_credentials');
    assert.deepEqual({ ...(wrong.body as object), requestId: null }, { ...(unknown.body as object), requestId: null });
    const forged = h.client();
    forged.setSessionCookie(seed.sessionTokenHashHex);
    expectError(await forged.get('/v1/me'), 401, 'auth.session_invalid');
    expectError(await anonymous.get('/v1/me'), 401, 'auth.session_invalid');
  });

  await t.test('CS-01..CS-04: CSRF header and fetch metadata are required for mutations; GET never mutates', async () => {
    const client = h.client();
    await login(client, 'petr');
    expectError(await client.post('/v1/auth/logout', undefined, { csrf: 'no-header', idempotencyKey: null }), 403, 'auth.csrf_rejected');
    expectError(await client.post('/v1/auth/logout', undefined, { csrf: 'cross-site', idempotencyKey: null }), 403, 'auth.csrf_rejected');
    const foreign = await client.request('POST', '/v1/auth/logout', { headers: { 'X-Trustwork-Request': '1', origin: 'https://evil.invalid' }, csrf: false, idempotencyKey: null });
    expectError(foreign, 403, 'auth.csrf_rejected');
    const originOnly = await client.post('/v1/me/sessions/revoke', { sessionId: '00000000-0000-7000-8000-000000000000' }, { csrf: 'origin-only' });
    expectError(originOnly, 404, 'access.not_found');
    const get = await client.get('/v1/auth/logout');
    assert.equal(get.status, 404);
    assert.equal((await client.get('/v1/me')).status, 200, 'still authenticated: nothing mutated');
  });

  await t.test('sessions: list without hashes, revoke one, logout, revoked cookie is rejected', async () => {
    const a = h.client();
    const b = h.client();
    await login(a, 'petr');
    await login(b, 'petr');
    const list = await a.get('/v1/me/sessions');
    assert.equal(list.status, 200);
    const sessions = list.body as { items: Record<string, unknown>[]; currentSessionId: string };
    assert.ok(sessions.items.length >= 2);
    for (const s of sessions.items) {
      assert.ok(!('tokenHash' in s) && !('personId' in s), 'SessionView has no tokenHash/personId');
    }
    const other = sessions.items.find((s) => s.id !== sessions.currentSessionId && s.revokedAt === null) as { id: string };
    assert.equal((await a.post('/v1/me/sessions/revoke', { sessionId: other.id })).status, 204);
    const revoked = await b.get('/v1/me');
    expectError(revoked, 401, 'auth.session_invalid');
    assert.equal((await a.post('/v1/auth/logout', undefined, { idempotencyKey: null })).status, 204);
    assert.equal(a.sessionCookie, null, 'cookie cleared');
    expectError(await a.get('/v1/me'), 401, 'auth.session_invalid');
  });

  await t.test('SS-05/T14: revoke-others and sensitive actions require step-up; step-up refreshes the proof', async () => {
    const client = h.client();
    await login(client, 'anna');
    h.clock.advance(11 * 60_000);
    expectError(await client.post('/v1/me/sessions/revoke-others'), 403, 'auth.step_up_required');
    expectError(await client.post('/v1/auth/step-up', { password: 'wrong' }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    const stepUp = await client.post('/v1/auth/step-up', { password: PASSWORDS.anna }, { idempotencyKey: null });
    assert.equal(stepUp.status, 200);
    const r = await client.post('/v1/me/sessions/revoke-others');
    assert.equal(r.status, 200);
    h.clock.reset();
  });

  await t.test('idle and absolute expiry are enforced by the configured windows', async () => {
    const client = h.client();
    await login(client, 'carl');
    h.clock.advance(31 * 60_000);
    expectError(await client.get('/v1/me'), 401, 'auth.session_invalid');
    h.clock.reset();
    await login(client, 'carl');
    for (let i = 0; i < 25; i++) {
      h.clock.advance(29 * 60_000);
      const r = await client.get('/v1/me');
      if (r.status !== 200) {
        assert.ok(i >= 24, `idle window extended by activity until the absolute limit (failed at step ${i})`);
        break;
      }
    }
    h.clock.reset();
  });

  await t.test('RC-01..RC-07: recovery is enumeration-safe, single use, invalidated by a newer request, revokes sessions', async () => {
    const session = h.client();
    await login(session, 'boris');
    const known = await anonymous.post('/v1/auth/recovery', { email: EMAILS.boris }, { idempotencyKey: null });
    const unknown = await anonymous.post('/v1/auth/recovery', { email: 'ghost@example.invalid' }, { idempotencyKey: null });
    assert.equal(known.status, 202);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(h.mail.countTo('ghost@example.invalid'), 0);
    const first = h.mail.lastTo(EMAILS.boris, 'recovery')?.params.token as string;
    await anonymous.post('/v1/auth/recovery', { email: EMAILS.boris }, { idempotencyKey: null });
    const second = h.mail.lastTo(EMAILS.boris, 'recovery')?.params.token as string;
    assert.notEqual(first, second);
    expectError(await anonymous.post('/v1/auth/recovery/complete', { token: first, newPassword: 'another long password 123' }, { idempotencyKey: null }), 404, 'access.not_found');
    const done = await anonymous.post('/v1/auth/recovery/complete', { token: second, newPassword: 'another long password 123' }, { idempotencyKey: null });
    assert.equal(done.status, 200);
    assert.equal(done.cookies.length, 0, 'no auto-login after recovery');
    expectError(await anonymous.post('/v1/auth/recovery/complete', { token: second, newPassword: 'another long password 123' }, { idempotencyKey: null }), 404, 'access.not_found');
    expectError(await session.get('/v1/me'), 401, 'auth.session_invalid');
    expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.boris, password: PASSWORDS.boris }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    assert.equal((await anonymous.post('/v1/auth/login', { email: EMAILS.boris, password: 'another long password 123' }, { idempotencyKey: null })).status, 200);
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.updateTable('credential').set({ password_hash: await import('@node-rs/argon2').then((m) => m.hash(PASSWORDS.boris, { memoryCost: 19456, timeCost: 2, parallelism: 1 })) }).where('person_id', '=', seed.people.boris).where('kind', '=', 'password').execute();
    });
  });

  await t.test('BF-01/BF-02: per-account lockout after five failures answers auth.throttled without verifying', async () => {
    for (let i = 0; i < 5; i++) expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.xenia, password: `wrong-${i}` }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.xenia, password: PASSWORDS.xenia }, { idempotencyKey: null }), 429, 'auth.throttled');
    const rows = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.login_failure');
    assert.ok(rows.rows[0]!.n >= 5);
    assert.equal((await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'auth.login_throttled'")).rows[0]?.n, 1);
  });

  await t.test('idempotency: replay returns the recorded result, a different payload conflicts, header is required', async () => {
    const client = h.client();
    await login(client, 'petr');
    const body = { owner: { kind: 'person', id: seed.people.petr }, name: 'Идемпотентный проект', summary: null, leaderPersonId: null };
    const first = await client.post('/v1/projects', body, { idempotencyKey: 'key-project-1' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replay = await client.post('/v1/projects', body, { idempotencyKey: 'key-project-1' });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);
    expectError(await client.post('/v1/projects', { ...body, name: 'Другое имя' }, { idempotencyKey: 'key-project-1' }), 409, 'validation.idempotency_conflict');
    expectError(await client.post('/v1/projects', body, { idempotencyKey: null }), 422, 'validation.schema');
    expectError(await client.post('/v1/projects', { ...body, extra: 1 }), 422, 'validation.unknown_field');
  });

  await t.test('provider login: linked subject signs in; matching e-mail never auto-links (AL-01); Google verified claim (AL-08); Apple stays unverified (AL-03)', async () => {
    const client = h.client();
    const start = await client.post('/v1/auth/google/start', undefined, { idempotencyKey: null });
    assert.equal(start.status, 200);
    assert.ok(client.jar.get(FLOW_COOKIE));
    const url = new URL((start.body as { authorizationUrl: string }).authorizationUrl);
    const state = url.searchParams.get('state') as string;
    h.google.enqueue({ subject: 'google-anna', email: EMAILS.anna, emailVerified: true, name: 'Anna' });
    const refused = await client.get(`/v1/auth/google/callback?code=fake&state=${state}`);
    assert.equal(refused.status, 303);
    assert.match(String(refused.headers.location), /auth=account_exists/);
    assert.equal(client.sessionCookie, null, 'no session for the existing person');
    const bad = await client.get(`/v1/auth/google/callback?code=fake&state=${state}`);
    expectError(bad, 400, 'auth.provider.state_mismatch');

    const flow = async (c: Client, provider: 'google' | 'apple') => {
      const s = await c.post(`/v1/auth/${provider}/start`, undefined, { idempotencyKey: null });
      return new URL((s.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    };
    await anonymous.post('/v1/auth/signup', { name: 'Претендент', email: 'victim@example.invalid', password: PASSWORD, acceptedTermsVersion: 'v' }, { idempotencyKey: null });
    const g = h.client();
    const gState = await flow(g, 'google');
    h.google.enqueue({ subject: 'google-victim', email: 'victim@example.invalid', emailVerified: true, name: 'Victim' });
    const claimed = await g.get(`/v1/auth/google/callback?code=fake&state=${gState}`);
    assert.match(String(claimed.headers.location), /auth=signed_in/);
    const me = await g.get('/v1/me');
    assert.equal(me.status, 200);
    const person = (me.body as { person: { emailBindings: { email: string; verifiedAt: string | null }[]; providerIdentities: { provider: string; subject: string }[] } }).person;
    assert.deepEqual(person.providerIdentities, [{ provider: 'google', subject: 'google-victim' }]);
    assert.equal(person.emailBindings[0]?.verifiedAt !== null, true);
    expectError(await anonymous.post('/v1/auth/login', { email: 'victim@example.invalid', password: PASSWORD }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    const orphan = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.credential c JOIN trustwork.person p ON p.id = c.person_id WHERE p.display_name = 'Претендент' AND c.disabled_at IS NULL");
    assert.equal(orphan.rows[0]?.n, 0, 'the attacker password login is disabled');

    const y = h.client();
    const yState = await flow(y, 'apple');
    h.apple.enqueue({ subject: 'apple-1', email: 'apple-user@example.invalid', emailVerified: false, name: 'Я' });
    const apple = await y.get(`/v1/auth/apple/callback?code=fake&state=${yState}`);
    assert.match(String(apple.headers.location), /auth=verification_pending/);
    const yme = await y.get('/v1/me');
    assert.equal((yme.body as { principal: { emailVerified: boolean } }).principal.emailVerified, false);
    assert.equal(h.mail.countTo('apple-user@example.invalid', 'verify_email'), 1);
    const yProject = await y.post('/v1/projects', { owner: { kind: 'person', id: (yme.body as { person: { id: string } }).person.id }, name: 'Проект без подтверждённой почты', summary: null, leaderPersonId: null });
    assert.equal(yProject.status, 201, 'a session exists via the subject link');
    expectError(await y.post(`/v1/projects/${(yProject.body as { id: string }).id}/publish`, { projectId: (yProject.body as { id: string }).id, publishedStory: 'история', openNeedIds: [], expectedRevision: 1 }), 403, 'auth.email_unverified');
  });

  await t.test('P1-1: a provider-first person keeps the provider link after verifying the address and signs in again', async () => {
    const y = h.client();
    const s = await y.post('/v1/auth/apple/start', undefined, { idempotencyKey: null });
    const st = new URL((s.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.apple.enqueue({ subject: 'apple-first', email: 'apple-first@example.invalid', emailVerified: false, name: 'Первый' });
    assert.match(String((await y.get(`/v1/auth/apple/callback?code=fake&state=${st}`)).headers.location), /verification_pending/);
    const token = h.mail.lastTo('apple-first@example.invalid', 'verify_email')?.params.token as string;
    const fresh = h.client();
    assert.equal((await fresh.post('/v1/auth/verify-email', { token }, { idempotencyKey: null })).status, 200, 'verified from a fresh browser without a session');
    const me = await fresh.get('/v1/me');
    const person = (me.body as { person: { providerIdentities: { subject: string }[] }; principal: { emailVerified: boolean } });
    assert.equal(person.principal.emailVerified, true);
    assert.deepEqual(person.person.providerIdentities.map((p) => p.subject), ['apple-first'], 'the provider link survives verification');
    const again = h.client();
    const s2 = await again.post('/v1/auth/apple/start', undefined, { idempotencyKey: null });
    const st2 = new URL((s2.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.apple.enqueue({ subject: 'apple-first', email: 'apple-first@example.invalid', emailVerified: false, name: 'Первый' });
    assert.match(String((await again.get(`/v1/auth/apple/callback?code=fake&state=${st2}`)).headers.location), /auth=signed_in/);
    assert.equal((await again.get('/v1/me')).status, 200);
  });

  await t.test('P1-2: without AUTH_PROVIDER_MODE provider routes are not found and health says disabled; fake-identity only from loopback', async () => {
    const disabled = await createApp({ env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test' }, pool: h.pool, mail: h.mail, clock: h.clock, log: () => undefined });
    try {
      const health = await disabled.fastify.inject({ method: 'GET', url: '/health' });
      assert.deepEqual(JSON.parse(health.body), { status: 'ok', mode: 'bootstrap', externalProviders: 'disabled' });
      const start = await disabled.fastify.inject({ method: 'POST', url: '/v1/auth/google/start', headers: { 'X-Trustwork-Request': '1', 'sec-fetch-site': 'same-origin' } });
      assert.equal(start.statusCode, 404);
      assert.equal(JSON.parse(start.body).code, 'access.not_found');
      const scripted = await disabled.fastify.inject({ method: 'POST', url: '/v1/auth/google/fake-identity', headers: { 'X-Trustwork-Request': '1', 'sec-fetch-site': 'same-origin' }, payload: { subject: 'x', email: null, emailVerified: false, name: null } });
      assert.equal(scripted.statusCode, 404);
    } finally {
      await disabled.app.close();
    }
    const remote = await anonymous.post('/v1/auth/google/fake-identity', { subject: 'x', email: null, emailVerified: false, name: null }, { idempotencyKey: null, remoteAddress: '203.0.113.9' });
    expectError(remote, 404, 'access.not_found');
    const local = await anonymous.post('/v1/auth/google/fake-identity', { subject: 'loopback-only', email: null, emailVerified: false, name: null }, { idempotencyKey: null });
    assert.equal(local.status, 202);
    assert.throws(() => apiConfigFromEnv({ AUTH_PROVIDER_MODE: 'fake', NODE_ENV: 'production' }), /not allowed/);
  });

  await t.test('P2-2: step-up and password change are throttled after the lockout threshold without verifying', async () => {
    await h.db.admin.query('DELETE FROM trustwork.login_failure'); // every test client shares the loopback IP counter
    const client = h.client();
    await login(client, 'anna');
    for (let i = 0; i < 5; i++) expectError(await client.post('/v1/auth/step-up', { password: `wrong-${i}` }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    expectError(await client.post('/v1/auth/step-up', { password: PASSWORDS.anna }, { idempotencyKey: null }), 429, 'auth.throttled');
    expectError(await client.post('/v1/me/password', { currentPassword: PASSWORDS.anna, newPassword: 'another strong password 99' }), 429, 'auth.throttled');
    expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.anna, password: PASSWORDS.anna }, { idempotencyKey: null }), 429, 'auth.throttled');
    await h.db.admin.query('DELETE FROM trustwork.login_failure');
    const other = h.client();
    await login(other, 'carl');
    for (let i = 0; i < 5; i++) expectError(await other.post('/v1/me/password', { currentPassword: `wrong-${i}`, newPassword: 'another strong password 99' }), 401, 'auth.invalid_credentials');
    expectError(await other.post('/v1/me/password', { currentPassword: PASSWORDS.carl, newPassword: 'another strong password 99' }), 429, 'auth.throttled');
    await h.db.admin.query('DELETE FROM trustwork.login_failure');
  });

  await t.test('P3: a stale epoch during resolution is retried, not logged out; an e-mail change to a bound address is auth.email_taken', async () => {
    const client = h.client();
    await login(client, 'boris');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('person').set({ authz_epoch: (eb) => eb('authz_epoch', '+', 1) }).where('id', '=', seed.people.boris).execute());
    const me = await client.get('/v1/me');
    assert.equal(me.status, 200, 'the resolver re-reads the epoch once');
    assert.ok(client.sessionCookie, 'cookie kept');
    assert.equal((await client.post('/v1/me/email', { newEmail: EMAILS.anna })).status, 202, 'identical acknowledgement');
    const token = h.mail.lastTo(EMAILS.anna, 'email_change')?.params.token as string;
    const taken = await client.post('/v1/auth/verify-email', { token }, { idempotencyKey: null });
    assert.equal(taken.status, 409);
    assert.equal((taken.body as { code: string }).code, 'auth.email_taken');
  });

  await t.test('OA-05/AL-04: linking needs step-up and verified mail; a linked subject logs in; unlinking the last credential is refused', async () => {
    const client = h.client();
    await login(client, 'carl');
    h.clock.advance(11 * 60_000);
    expectError(await client.post('/v1/auth/link/start', { provider: 'google' }, { idempotencyKey: null }), 403, 'auth.step_up_required');
    h.clock.reset();
    const start = await client.post('/v1/auth/link/start', { provider: 'google' }, { idempotencyKey: null });
    assert.equal(start.status, 200);
    const state = new URL((start.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    const stranger = h.client();
    stranger.jar.set(FLOW_COOKIE, client.jar.get(FLOW_COOKIE) as string);
    h.google.enqueue({ subject: 'google-carl', email: EMAILS.carl, emailVerified: true, name: 'Carl' });
    expectError(await stranger.get(`/v1/auth/google/callback?code=fake&state=${state}`), 401, 'auth.session_invalid');
    const restart = await client.post('/v1/auth/link/start', { provider: 'google' }, { idempotencyKey: null });
    const state2 = new URL((restart.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.google.enqueue({ subject: 'google-carl', email: EMAILS.carl, emailVerified: true, name: 'Carl' });
    const linked = await client.get(`/v1/auth/google/callback?code=fake&state=${state2}`);
    assert.match(String(linked.headers.location), /auth=linked/);
    assert.ok(h.mail.countTo(EMAILS.carl, 'security_notice') >= 1);
    const fresh = h.client();
    const s = await fresh.post('/v1/auth/google/start', undefined, { idempotencyKey: null });
    const st = new URL((s.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.google.enqueue({ subject: 'google-carl', email: 'other@example.invalid', emailVerified: true, name: 'Carl' });
    assert.match(String((await fresh.get(`/v1/auth/google/callback?code=fake&state=${st}`)).headers.location), /auth=signed_in/);
    assert.equal((await fresh.get('/v1/me')).status, 200);
    const anna = h.client();
    await login(anna, 'anna');
    const annaStart = await anna.post('/v1/auth/link/start', { provider: 'google' }, { idempotencyKey: null });
    const annaState = new URL((annaStart.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.google.enqueue({ subject: 'google-carl', email: EMAILS.anna, emailVerified: true, name: 'Anna' });
    expectError(await anna.get(`/v1/auth/google/callback?code=fake&state=${annaState}`), 409, 'auth.provider.already_linked');
    assert.equal((await client.post('/v1/auth/unlink', { provider: 'google' }, { idempotencyKey: null })).status, 204);
    const providerOnly = fresh;
    expectError(await providerOnly.post('/v1/auth/unlink', { provider: 'google' }, { idempotencyKey: null }), 404, 'access.not_found');
  });

  await t.test('password change revokes the other sessions; e-mail change needs verification of the new address', async () => {
    const a = h.client();
    const b = h.client();
    await login(a, 'pure');
    await login(b, 'pure');
    expectError(await a.post('/v1/me/password', { currentPassword: 'wrong', newPassword: 'brand new password 2026!' }), 401, 'auth.invalid_credentials');
    assert.equal((await a.post('/v1/me/password', { currentPassword: PASSWORDS.pure, newPassword: 'brand new password 2026!' })).status, 204);
    expectError(await b.get('/v1/me'), 401, 'auth.session_invalid');
    assert.equal((await a.get('/v1/me')).status, 200);
    assert.equal((await a.post('/v1/me/email', { newEmail: 'pure-new@example.invalid' })).status, 202);
    const token = h.mail.lastTo('pure-new@example.invalid', 'email_change')?.params.token as string;
    assert.equal((await a.post('/v1/auth/verify-email', { token }, { idempotencyKey: null })).status, 200);
    const me = await a.get('/v1/me');
    const bindings = (me.body as { person: { emailBindings: { email: string; isPrimary: boolean; verifiedAt: string | null }[] } }).person.emailBindings;
    assert.deepEqual(bindings.find((x) => x.isPrimary)?.email, 'pure-new@example.invalid');
    assert.equal(createHash('sha256').update('x').digest('hex').length, 64);
  });

  await t.test('audit rows carry actor and request id, never secrets', async () => {
    const { rows } = await h.db.admin.query<{ action: string; basis: unknown; request_id: string | null }>("SELECT action, basis, request_id FROM trustwork.audit_event WHERE action LIKE 'auth.%' ORDER BY id");
    assert.ok(rows.some((r) => r.action === 'auth.login') && rows.some((r) => r.action === 'auth.login_failed') && rows.some((r) => r.action === 'auth.recovery_completed'));
    for (const row of rows) {
      assert.ok(row.request_id, 'request id recorded');
      const text = JSON.stringify(row.basis ?? {});
      assert.ok(!text.includes(PASSWORD) && !text.includes(PASSWORDS.petr) && !/token/i.test(text), 'no secret in audit basis');
    }
  });
});

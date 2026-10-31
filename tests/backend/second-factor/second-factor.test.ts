import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expectError, SKIP_REASON, startHarness, type Client } from '../helpers/app.js';
import { EMAILS, login, seedPersonas } from '../helpers/personas.js';
import { auditCount, outboxCount } from '../hardening/helpers.js';
import { codeNow, enrol, installUpdateGate, nextCode, notices, passwordLogin, secondStep, signInWithTotp } from './helpers.js';
import { normalizeRecoveryCode } from '../../../packages/contracts/src/second-factor.js';
import { base32Decode } from '../../../apps/api/src/modules/identity/second-factor/totp.js';

const h = await startHarness('second_factor');

/**
 * BE-004 on real PostgreSQL: TOTP enrolment with confirmation, sign-in with the second factor, replay protection,
 * single-use recovery codes, brute-force limits, concurrent uses of one code, regeneration and removal, owner notices
 * through the outbox and secrets that never reach the database in clear.
 */
test('second factor: enrolment, sign-in, replay, recovery codes, brute force, concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const petr = h.client();
  await login(petr, 'petr');

  let secret: Buffer = Buffer.alloc(0);
  let recovery: string[] = [];
  let factorId = '';

  await t.test('enrolment needs a recent step-up and a confirming code; secrets are sealed and codes hashed', async () => {
    h.clock.advance(11 * 60_000);
    expectError(await petr.post('/v1/me/second-factor/totp', undefined, { idempotencyKey: null }), 403, 'auth.step_up_required');
    h.clock.reset();
    const status0 = await petr.get('/v1/me/second-factor');
    assert.equal(status0.status, 200);
    assert.deepEqual(status0.body, { enrolled: false, factors: [], recoveryCodes: null, pendingReset: null });

    const started = await petr.post('/v1/me/second-factor/totp', undefined, { idempotencyKey: null });
    assert.equal(started.status, 201);
    const body = started.body as { factorId: string; secret: string; otpauthUri: string };
    assert.match(body.secret, /^[A-Z2-7]{32}$/);
    assert.ok(body.otpauthUri.startsWith('otpauth://totp/trustwork.test:'), body.otpauthUri);
    const real = codeNow(h, base32Decode(body.secret));
    expectError(await petr.post('/v1/me/second-factor/totp/confirm', { factorId: body.factorId, code: real === '000000' ? '111111' : '000000' }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    // Not enrolled until confirmed.
    assert.equal(((await petr.get('/v1/me/second-factor')).body as { enrolled: boolean }).enrolled, false);

    const enrolled = await enrol(h, petr);
    secret = enrolled.secret;
    recovery = enrolled.recoveryCodes;
    factorId = enrolled.factorId;
    assert.equal(recovery.length, 10);
    assert.equal(new Set(recovery).size, 10);
    for (const code of recovery) assert.match(code, /^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){3}$/);

    const stored = await h.db.admin.query<{ state: string; secret_sealed: Buffer }>('SELECT state, secret_sealed FROM trustwork.second_factor WHERE person_id = $1 ORDER BY created_at', [seed.people.petr]);
    assert.deepEqual(stored.rows.map((r) => r.state), ['revoked', 'active'], 'the first enrolment was abandoned, the second activated');
    const sealed = stored.rows[1]!.secret_sealed;
    assert.ok(!sealed.includes(secret), 'the secret is not stored in clear');
    assert.ok(!sealed.toString('latin1').includes(secret.toString('base64')), 'nor encoded');

    const hashes = await h.db.admin.query<{ code_hash: Buffer }>('SELECT code_hash FROM trustwork.recovery_code WHERE person_id = $1', [seed.people.petr]);
    assert.equal(hashes.rows.length, 10);
    for (const code of recovery) {
      const normalized = normalizeRecoveryCode(code) as string;
      const plain = createHash('sha256').update(normalized).digest();
      assert.ok(hashes.rows.every((r) => !r.code_hash.equals(plain) && !r.code_hash.toString('latin1').includes(normalized)), 'recovery codes are stored only as keyed hashes');
    }
    await assert.rejects(h.db.app.query('SELECT code_hash FROM trustwork.recovery_code'), /permission denied/, 'the runtime role cannot read recovery-code hashes');
    await assert.rejects(h.db.app.query('SELECT token_hash FROM trustwork.second_factor_challenge'), /permission denied/);

    const status = (await petr.get('/v1/me/second-factor')).body as { enrolled: boolean; factors: { id: string }[]; recoveryCodes: { remaining: number; total: number } };
    assert.equal(status.enrolled, true);
    assert.deepEqual(status.factors.map((f) => f.id), [factorId]);
    assert.deepEqual({ remaining: status.recoveryCodes.remaining, total: status.recoveryCodes.total }, { remaining: 10, total: 10 });
    assert.ok(!JSON.stringify(status).includes(recovery[0]!), 'status never returns codes');

    assert.deepEqual(await notices(h, EMAILS.petr), ['second_factor_enabled'], 'the change is announced to every verified address');
    assert.equal(await auditCount(h.db.admin, 'auth.second_factor_enabled'), 1);
    assert.equal(await outboxCount(h.db.admin, 'identity.second_factor_enabled', seed.people.petr), 1);
    const outbox = await h.db.admin.query<{ payload: unknown }>("SELECT payload FROM trustwork.outbox_event WHERE type LIKE 'identity.second_factor%' OR type = 'mail.requested'");
    assert.ok(!JSON.stringify(outbox.rows).includes(recovery[0]!) && !JSON.stringify(outbox.rows).includes(body.secret), 'no secret in outbox payloads');

    // A second factor cannot be started while one is active.
    expectError(await petr.post('/v1/me/second-factor/totp', undefined, { idempotencyKey: null }), 403, 'access.forbidden');
  });

  await t.test('sign-in requires the second factor; a reused or earlier code is rejected', async () => {
    const browser = h.client();
    const first = await passwordLogin(browser, 'petr');
    assert.equal(first.status, 200);
    assert.equal((first.body as { status: string }).status, 'second_factor_required');
    assert.equal(browser.sessionCookie, null, 'no session before the second factor');
    expectError(await browser.get('/v1/me'), 401, 'auth.session_invalid');

    const code = nextCode(h, secret);
    const ok = await secondStep(browser, { method: 'totp', code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(browser.sessionCookie, 'session after the second factor');
    assert.equal((await browser.get('/v1/me')).status, 200);
    expectError(await secondStep(browser, { method: 'totp', code }), 401, 'auth.session_invalid');

    // The same code again, still inside its window, on a fresh sign-in: refused (replay).
    const replay = h.client();
    await passwordLogin(replay, 'petr');
    expectError(await secondStep(replay, { method: 'totp', code }), 401, 'auth.invalid_credentials');
    assert.equal(replay.sessionCookie, null);

    // A later code is accepted; afterwards the earlier (still valid by time) code is refused.
    const later = codeNow(h, secret, 1);
    const earlier = codeNow(h, secret, 0);
    assert.notEqual(later, earlier);
    assert.equal((await secondStep(replay, { method: 'totp', code: later })).status, 200);
    h.clock.advance(30_000); // the next fresh code (nextCode) must lie after the step just accepted
    const again = h.client();
    await passwordLogin(again, 'petr');
    expectError(await secondStep(again, { method: 'totp', code: earlier }), 401, 'auth.invalid_credentials');
    // Each subtest starts without failure counters, so the limits of one never decide another.
    await h.db.admin.query("DELETE FROM trustwork.login_failure");
  });

  await t.test('recovery codes work once each and the owner is told', async () => {
    const before = (await notices(h, EMAILS.petr)).filter((e) => e === 'recovery_code_used').length;
    const one = h.client();
    await passwordLogin(one, 'petr');
    const used = await secondStep(one, { method: 'recovery_code', code: recovery[0]!.toUpperCase().replaceAll('-', ' ') });
    assert.equal(used.status, 200, 'any case and separators');
    const two = h.client();
    await passwordLogin(two, 'petr');
    expectError(await secondStep(two, { method: 'recovery_code', code: recovery[0]! }), 401, 'auth.invalid_credentials');
    assert.equal((await notices(h, EMAILS.petr)).filter((e) => e === 'recovery_code_used').length, before + 1);
    const status = (await petr.get('/v1/me/second-factor')).body as { recoveryCodes: { remaining: number } };
    assert.equal(status.recoveryCodes.remaining, 9);
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.recovery_code WHERE person_id = $1 AND used_at IS NOT NULL', [seed.people.petr])).rowCount, 1);
    await h.db.admin.query("DELETE FROM trustwork.login_failure");
  });

  await t.test('brute force: five wrong codes end the challenge, the delay starts and the owner is told', async () => {
    const attacker = h.client();
    await passwordLogin(attacker, 'petr');
    const wrong = (n: number) => String((Number(codeNow(h, secret)) + 500_000 + n) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) expectError(await secondStep(attacker, { method: 'totp', code: wrong(i) }), 401, 'auth.invalid_credentials');
    // The challenge is spent: even a correct code does not open a session now.
    const after = await secondStep(attacker, { method: 'totp', code: codeNow(h, secret, 1) });
    assert.ok(after.status === 401 || after.status === 429, `challenge closed: ${after.status}`);
    assert.equal(attacker.sessionCookie, null);
    // A fresh challenge (the password is known) is throttled for this person.
    const retry = h.client();
    await passwordLogin(retry, 'petr');
    expectError(await secondStep(retry, { method: 'totp', code: codeNow(h, secret, 1) }), 429, 'auth.throttled');
    assert.ok((await notices(h, EMAILS.petr)).includes('second_factor_throttled'));
    assert.equal(await auditCount(h.db.admin, 'auth.second_factor_lockout'), 1);
    await h.db.admin.query("DELETE FROM trustwork.login_failure");
  });

  await t.test('concurrency: two simultaneous sign-ins with one TOTP code open exactly one session', async () => {
    const gate = await installUpdateGate(h.db.admin, 'second_factor', 77_001);
    try {
      const a = h.client();
      const b = h.client();
      await passwordLogin(a, 'petr');
      await passwordLogin(b, 'petr');
      const code = nextCode(h, secret);
      const results = await gate.race(() => Promise.all([secondStep(a, { method: 'totp', code }), secondStep(b, { method: 'totp', code })]));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 401], JSON.stringify(results.map((r) => r.body)));
      assert.equal([a, b].filter((c) => c.sessionCookie).length, 1);
    } finally {
      await gate.drop();
      await h.db.admin.query("DELETE FROM trustwork.login_failure");
    }
  });

  await t.test('concurrency: two simultaneous uses of one recovery code succeed once', async () => {
    const gate = await installUpdateGate(h.db.admin, 'recovery_code', 77_002);
    try {
      const a = h.client();
      const b = h.client();
      await passwordLogin(a, 'petr');
      await passwordLogin(b, 'petr');
      const results = await gate.race(() => Promise.all([secondStep(a, { method: 'recovery_code', code: recovery[1]! }), secondStep(b, { method: 'recovery_code', code: recovery[1]! })]));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 401], JSON.stringify(results.map((r) => r.body)));
      assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.recovery_code WHERE person_id = $1 AND used_at IS NOT NULL', [seed.people.petr])).rowCount, 2);
    } finally {
      await gate.drop();
      await h.db.admin.query("DELETE FROM trustwork.login_failure");
    }
  });

  await t.test('regenerating recovery codes needs a proof and retires the old set', async () => {
    const fresh = h.client();
    await signInWithTotp(h, fresh, 'petr', secret);
    expectError(await fresh.post('/v1/me/second-factor/recovery-codes', { proof: { method: 'totp', code: '12345' } }, { idempotencyKey: null }), 422, 'validation.schema');
    const replayed = codeNow(h, secret);
    expectError(await fresh.post('/v1/me/second-factor/recovery-codes', { proof: { method: 'totp', code: replayed } }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    const issued = await fresh.post('/v1/me/second-factor/recovery-codes', { proof: { method: 'recovery_code', code: recovery[2]! } }, { idempotencyKey: null });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const next = (issued.body as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(next.length, 10);
    const old = h.client();
    await passwordLogin(old, 'petr');
    expectError(await secondStep(old, { method: 'recovery_code', code: recovery[3]! }), 401, 'auth.invalid_credentials');
    assert.equal((await secondStep(old, { method: 'recovery_code', code: next[0]! })).status, 200);
    recovery = next.slice(1);
    const events = await notices(h, EMAILS.petr);
    assert.ok(events.includes('recovery_codes_regenerated'));
    await h.db.admin.query("DELETE FROM trustwork.login_failure");
  });

  await t.test('an e-mail change proof issues no session to a person with a second factor', async () => {
    const fresh = h.client();
    await signInWithTotp(h, fresh, 'petr', secret);
    const newAddress = 'petr.second@example.invalid';
    assert.equal((await fresh.post('/v1/me/email', { newEmail: newAddress }, { idempotencyKey: null })).status, 202);
    const token = (await h.mail.lastTo(newAddress, 'email_change'))?.params.token as string;
    const elsewhere = h.client();
    const verified = await elsewhere.post('/v1/auth/verify-email', { token }, { idempotencyKey: null });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(elsewhere.sessionCookie, null, 'the mailbox proof does not bypass the second factor');
  });

  await t.test('removing the last factor needs a proof, retires the codes and is announced', async () => {
    const fresh = h.client();
    await signInWithTotp(h, fresh, 'petr', secret);
    expectError(await fresh.post('/v1/me/second-factor/remove', { factorId, proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    const removed = await fresh.post('/v1/me/second-factor/remove', { factorId, proof: { method: 'totp', code: nextCode(h, secret) } }, { idempotencyKey: null });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body, { status: 'removed', enrolled: false });
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.recovery_code WHERE person_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [seed.people.petr])).rowCount, 0);
    const plain = h.client();
    const signIn = await passwordLogin(plain, 'petr');
    assert.deepEqual((signIn.body as { status: string }).status, 'authenticated');
    // Recovery codes do not work without an active factor, and nothing else does either.
    expectError(await fresh.post('/v1/me/second-factor/recovery-codes', { proof: { method: 'recovery_code', code: recovery[0]! } }, { idempotencyKey: null }), 403, 'access.forbidden');
    const events = await notices(h, EMAILS.petr);
    assert.equal(events.at(-1), 'second_factor_removed');
    // The database refuses to resurrect a revoked factor or move a step back, even for the owner.
    await assert.rejects(h.db.admin.query("UPDATE trustwork.second_factor SET state = 'active', revoked_at = NULL, revoked_reason = NULL, activated_at = now() WHERE id = $1", [factorId]), /stays revoked/);
  });

  await t.test('provider sign-in of an enrolled person also asks for the second factor', async () => {
    const anna = h.client();
    await login(anna, 'anna');
    const enrolled = await enrol(h, anna);
    await h.db.admin.query("INSERT INTO trustwork.credential (person_id, kind, provider, provider_subject) VALUES ($1, 'google', 'google', 'google-subject-anna-2fa')", [seed.people.anna]);
    const browser: Client = h.client();
    const start = await browser.post('/v1/auth/google/start', undefined, { idempotencyKey: null });
    const state = new URL((start.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.google.enqueue({ subject: 'google-subject-anna-2fa', email: EMAILS.anna, emailVerified: true, name: null });
    const callback = await browser.get(`/v1/auth/google/callback?code=fake&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 303);
    assert.match(String(callback.headers.location), /auth=second_factor_required/);
    assert.equal(browser.sessionCookie, null);
    assert.equal((await secondStep(browser, { method: 'totp', code: nextCode(h, enrolled.secret) })).status, 200);
    const session = await h.db.admin.query<{ auth_method: string }>('SELECT auth_method FROM trustwork.session WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1', [seed.people.anna]);
    assert.equal(session.rows[0]?.auth_method, 'google');
  });
});

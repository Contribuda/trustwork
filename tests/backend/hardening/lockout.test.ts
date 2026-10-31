import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness } from '../helpers/app.js';
import { EMAILS, login, PASSWORDS, seedPersonas } from '../helpers/personas.js';
import { auditCount, count, outboxCount, subject } from './helpers.js';
import { accountDelaySeconds, lockoutPolicy } from '../../../apps/api/src/modules/identity/lockout.js';
import { apiConfigFromEnv } from '../../../apps/api/src/config.js';

const h = await startHarness('hardening_lockout');

/**
 * BE-002 acceptance: "An attacker cannot disable another person's password by failed attempts." Failures cause a
 * progressive delay (never a disabled credential), the owner is notified, and a successful sign-in or recovery
 * clears the counter. The attacker and the owner use different client addresses.
 */
test('failed attempts slow an account down but never disable its password', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const anonymous = h.client();
  const ATTACKER = '203.0.113.7';
  const OWNER = '198.51.100.4';
  const attempt = (email: string, password: string, ip: string) => anonymous.post('/v1/auth/login', { email, password }, { idempotencyKey: null, remoteAddress: ip });
  const account = subject('account', EMAILS.xenia);
  const failures = () => count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [account]);
  const disabled = (personId: string) => count(h.db.admin, "SELECT 1 FROM trustwork.credential WHERE person_id = $1 AND kind = 'password' AND disabled_at IS NOT NULL", [personId]);
  /** Moves every recorded failure of the account `seconds` into the past (the database clock decides the delay). */
  const age = (seconds: number) => h.db.admin.query("UPDATE trustwork.login_failure SET occurred_at = occurred_at - make_interval(secs => $2) WHERE subject_hash = $1", [account, seconds]);

  await t.test('policy: the delay doubles from the threshold on and is capped at the window', () => {
    const policy = lockoutPolicy(apiConfigFromEnv({}).lockout);
    assert.deepEqual([4, 5, 6, 7, 8, 9, 10, 40].map((n) => accountDelaySeconds(n, policy)), [0, 30, 60, 120, 240, 480, 900, 900]);
  });

  await t.test('threshold: the owner is notified once, attempts are delayed, the password stays enabled', async () => {
    for (let i = 0; i < 5; i++) expectError(await attempt(EMAILS.xenia, `wrong-${i}`, ATTACKER), 401, 'auth.invalid_credentials');
    const throttled = await attempt(EMAILS.xenia, PASSWORDS.xenia, OWNER);
    expectError(throttled, 429, 'auth.throttled');
    const retryAfter = (throttled.body as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds ?? 0;
    assert.ok(retryAfter > 0 && retryAfter <= 30, `retry after ${retryAfter}s`);
    assert.equal(await h.mail.countTo(EMAILS.xenia, 'security_notice'), 1);
    assert.equal(await outboxCount(h.db.admin, 'identity.login_throttled', seed.people.xenia), 1);
    assert.equal(await auditCount(h.db.admin, 'auth.login_lockout'), 1);
    assert.equal(await failures(), 5, 'a throttled attempt is not counted');
    assert.equal(await disabled(seed.people.xenia), 0);
  });

  await t.test('a sustained attack only lengthens the delay up to the window; the credential is never disabled', async () => {
    // Paced attacker: wait out each delay, then fail again (well past the former 100-per-day disable threshold).
    for (let i = 0; i < 6; i++) {
      await age(accountDelaySeconds(await failures(), lockoutPolicy(h.created.config.lockout)) + 1);
      expectError(await attempt(EMAILS.xenia, `paced-${i}`, ATTACKER), 401, 'auth.invalid_credentials');
    }
    // Plus a backlog of 150 failures inside the last 24 hours, as the old disable rule counted them.
    await h.db.admin.query("INSERT INTO trustwork.login_failure (subject_hash, occurred_at, expires_at) SELECT $1, now() - make_interval(secs => g * 60), now() + interval '1 day' FROM generate_series(1, 150) g", [account]);
    const throttled = await attempt(EMAILS.xenia, `again`, ATTACKER);
    expectError(throttled, 429, 'auth.throttled');
    const retryAfter = (throttled.body as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    assert.ok(retryAfter <= h.created.config.lockout.windowSeconds, `capped at the window (${retryAfter}s)`);
    assert.equal(await disabled(seed.people.xenia), 0, 'the password is still enabled');
    assert.equal(await h.mail.countTo(EMAILS.xenia, 'security_notice'), 1, 'no notification storm');
  });

  await t.test('the owner signs in once the delay has passed, and the sign-in clears the counter', async () => {
    await h.db.admin.query("UPDATE trustwork.login_failure SET occurred_at = now() - interval '16 minutes' WHERE subject_hash = $1", [account]);
    const owner = h.client();
    const ok = await owner.post('/v1/auth/login', { email: EMAILS.xenia, password: PASSWORDS.xenia }, { idempotencyKey: null, remoteAddress: OWNER });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await failures(), 0, 'a verified sign-in clears the account counter');
  });

  await t.test('concurrency: a burst of parallel failures never disables the password and leaves the owner able to recover', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => attempt(EMAILS.xenia, `burst-${i}`, `203.0.113.${20 + i}`)));
    assert.ok(results.every((r) => r.status === 401 || r.status === 429), JSON.stringify(results.map((r) => r.status)));
    // The pre-check is not serialized, so a parallel burst may all be verified; it still only adds failures.
    assert.ok((await failures()) <= 25);
    assert.equal(await disabled(seed.people.xenia), 0);
    expectError(await attempt(EMAILS.xenia, PASSWORDS.xenia, OWNER), 429, 'auth.throttled');
    // Recovery is never throttled by the account counter and clears it.
    assert.equal((await anonymous.post('/v1/auth/recovery', { email: EMAILS.xenia }, { idempotencyKey: null })).status, 202);
    const token = (await h.mail.lastTo(EMAILS.xenia, 'recovery'))?.params.token as string;
    assert.equal((await anonymous.post('/v1/auth/recovery/complete', { token, newPassword: 'recovered password for xenia 1' }, { idempotencyKey: null })).status, 200);
    assert.equal(await failures(), 0, 'recovery clears the account counter');
    assert.equal((await attempt(EMAILS.xenia, 'recovered password for xenia 1', OWNER)).status, 200);
  });

  await t.test('step-up success clears the counter of the acting person only', async () => {
    const boris = h.client();
    await login(boris, 'boris');
    const borisAccount = subject('account', EMAILS.boris);
    const annaAccount = subject('account', EMAILS.anna);
    await h.db.admin.query("INSERT INTO trustwork.login_failure (subject_hash, expires_at) SELECT s, now() + interval '1 day' FROM unnest(ARRAY[$1::bytea, $2::bytea]) s, generate_series(1, 3)", [borisAccount, annaAccount]);
    assert.equal((await boris.post('/v1/auth/step-up', { password: PASSWORDS.boris }, { idempotencyKey: null })).status, 200);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [borisAccount]), 0);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [annaAccount]), 3, "nobody clears another person's counter");
  });

  await t.test('the runtime role cannot clear counters without an identity', async () => {
    const result = await h.pool.query('SELECT trustwork.auth_clear_login_failures()').then(() => 'ok', (e: unknown) => (e as { code?: string }).code);
    assert.equal(result, '28000');
  });
});

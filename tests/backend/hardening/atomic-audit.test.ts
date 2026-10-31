import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness } from '../helpers/app.js';
import { EMAILS, login, PASSWORDS, seedPersonas } from '../helpers/personas.js';
import { auditCount, count, installAuditFault, outboxCount, providerState, signupBody, subject } from './helpers.js';

const h = await startHarness('hardening_atomic');

/**
 * BE-002 acceptance: "A forced failure after the change but before the audit write rolls back the change for every
 * identity flow listed" — sign-up, verification, login, failed login, lockout, recovery request and completion, and
 * the provider events (first sign-in, H06 claim, sign-in, link, unlink). Real PostgreSQL, real runtime role.
 */
test('identity changes commit atomically with their audit rows and outbox intents', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const fault = await installAuditFault(h.db.admin);
  const anonymous = h.client();
  const forced = (r: { status: number; body: unknown }) => assert.equal(r.status, 500, JSON.stringify(r.body));
  t.afterEach(() => fault.clear());

  await t.test('sign-up: no person, binding, credential or token survives a failed audit write; no mail leaves', async () => {
    const email = 'atomic-signup@example.invalid';
    await fault.fail('auth.signup');
    forced(await anonymous.post('/v1/auth/signup', signupBody(email), { idempotencyKey: null }));
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1', [email]), 0);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.auth_token WHERE email_normalized = $1', [email]), 0);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.person WHERE display_name = 'Atomic Person'"), 0);
    assert.equal(await h.mail.countTo(email), 0, 'mail goes out only after COMMIT');
    await fault.clear();
    const before = await outboxCount(h.db.admin, 'identity.person_registered');
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(email, 'Atomic Person'), { idempotencyKey: null })).status, 202);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1', [email]), 1);
    assert.equal(await outboxCount(h.db.admin, 'identity.person_registered'), before + 1, 'the intent commits with the change');
    assert.equal(await h.mail.countTo(email, 'verify_email'), 1);
  });

  await t.test('verification: the token stays usable and the binding unverified when the audit write fails', async () => {
    const email = 'atomic-signup@example.invalid';
    const token = (await h.mail.lastTo(email, 'verify_email'))?.params.token as string;
    await fault.fail('auth.email_verified');
    const client = h.client();
    forced(await client.post('/v1/auth/verify-email', { token }, { idempotencyKey: null }));
    assert.equal(client.sessionCookie, null);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1 AND verified_at IS NULL', [email]), 1);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.auth_token WHERE email_normalized = $1 AND consumed_at IS NULL', [email]), 1);
    await fault.clear();
    assert.equal((await client.post('/v1/auth/verify-email', { token }, { idempotencyKey: null })).status, 200);
    assert.ok(client.sessionCookie);
  });

  await t.test('login: no session row and no cookie when the audit write fails', async () => {
    const sessions = () => count(h.db.admin, 'SELECT 1 FROM trustwork.session WHERE person_id = $1', [seed.people.petr]);
    const before = await sessions();
    await fault.fail('auth.login');
    const client = h.client();
    forced(await client.post('/v1/auth/login', { email: EMAILS.petr, password: PASSWORDS.petr }, { idempotencyKey: null }));
    assert.equal(client.sessionCookie, null);
    assert.equal(await sessions(), before);
    assert.equal(await outboxCount(h.db.admin, 'identity.session_started', seed.people.petr), 0);
    await fault.clear();
    await login(client, 'petr');
    assert.equal(await sessions(), before + 1);
    assert.equal(await outboxCount(h.db.admin, 'identity.session_started', seed.people.petr), 1);
  });

  await t.test('failed login: the failure counters are not incremented when the audit write fails', async () => {
    const failures = () => count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [subject('account', EMAILS.boris)]);
    await fault.fail('auth.login_failed');
    forced(await anonymous.post('/v1/auth/login', { email: EMAILS.boris, password: 'not the password at all' }, { idempotencyKey: null, remoteAddress: '198.51.100.20' }));
    assert.equal(await failures(), 0);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [subject('ip', '198.51.100.20')]), 0);
    await fault.clear();
    expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.boris, password: 'not the password at all' }, { idempotencyKey: null, remoteAddress: '198.51.100.20' }), 401, 'auth.invalid_credentials');
    assert.equal(await failures(), 1);
  });

  await t.test('lockout: the threshold failure, its owner notification intent and the notice roll back together', async () => {
    const account = subject('account', EMAILS.carl);
    await h.db.admin.query("INSERT INTO trustwork.login_failure (subject_hash, expires_at) SELECT $1, now() + interval '1 day' FROM generate_series(1, 4)", [account]);
    await fault.fail('auth.login_lockout');
    forced(await anonymous.post('/v1/auth/login', { email: EMAILS.carl, password: 'not the password at all' }, { idempotencyKey: null, remoteAddress: '198.51.100.21' }));
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [account]), 4, 'the fifth failure is not recorded');
    assert.equal(await outboxCount(h.db.admin, 'identity.login_throttled', seed.people.carl), 0);
    assert.equal(await h.mail.countTo(EMAILS.carl, 'security_notice'), 0);
    await fault.clear();
    expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.carl, password: 'not the password at all' }, { idempotencyKey: null, remoteAddress: '198.51.100.21' }), 401, 'auth.invalid_credentials');
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.login_failure WHERE subject_hash = $1', [account]), 5);
    assert.equal(await outboxCount(h.db.admin, 'identity.login_throttled', seed.people.carl), 1);
    assert.equal(await auditCount(h.db.admin, 'auth.login_lockout'), 1);
    assert.equal(await h.mail.countTo(EMAILS.carl, 'security_notice'), 1, 'the owner is notified once');
    await h.db.admin.query('DELETE FROM trustwork.login_failure WHERE subject_hash = $1', [account]);
  });

  await t.test('recovery request: no new token and no invalidation of the earlier one when the audit write fails', async () => {
    assert.equal((await anonymous.post('/v1/auth/recovery', { email: EMAILS.anna }, { idempotencyKey: null })).status, 202);
    const live = () => count(h.db.admin, "SELECT 1 FROM trustwork.auth_token WHERE person_id = $1 AND kind = 'recovery' AND consumed_at IS NULL", [seed.people.anna]);
    const all = () => count(h.db.admin, "SELECT 1 FROM trustwork.auth_token WHERE person_id = $1 AND kind = 'recovery'", [seed.people.anna]);
    assert.equal(await live(), 1);
    const total = await all();
    await fault.fail('auth.recovery_requested');
    forced(await anonymous.post('/v1/auth/recovery', { email: EMAILS.anna }, { idempotencyKey: null }));
    assert.equal(await all(), total, 'no token issued');
    assert.equal(await live(), 1, 'the earlier token is still valid');
    assert.equal(await h.mail.countTo(EMAILS.anna, 'recovery'), 1);
    await fault.clear();
  });

  await t.test('recovery completion: the password, sessions and tokens are unchanged when the audit write fails', async () => {
    const token = (await h.mail.lastTo(EMAILS.anna, 'recovery'))?.params.token as string;
    await fault.fail('auth.recovery_completed');
    forced(await anonymous.post('/v1/auth/recovery/complete', { token, newPassword: 'a brand new password 2026' }, { idempotencyKey: null }));
    await login(h.client(), 'anna');
    await fault.clear();
    assert.equal((await anonymous.post('/v1/auth/recovery/complete', { token, newPassword: 'a brand new password 2026' }, { idempotencyKey: null })).status, 200);
    expectError(await anonymous.post('/v1/auth/login', { email: EMAILS.anna, password: PASSWORDS.anna }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
  });

  await t.test('provider first sign-in: no person, credential, token or session survives; H06 claim leaves the unverified binding intact', async () => {
    const client = h.client();
    let state = await providerState(client, 'apple');
    h.apple.enqueue({ subject: 'apple-atomic', email: 'apple-atomic@example.invalid', emailVerified: false, name: null });
    await fault.fail('auth.login');
    forced(await client.get(`/v1/auth/apple/callback?code=fake&state=${state}`));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential WHERE provider = 'apple' AND provider_subject = 'apple-atomic'"), 0);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.email_binding WHERE email_normalized = 'apple-atomic@example.invalid'"), 0);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.auth_token WHERE email_normalized = 'apple-atomic@example.invalid'"), 0);
    assert.equal(client.sessionCookie, null);
    assert.equal(await h.mail.countTo('apple-atomic@example.invalid'), 0);
    await fault.clear();

    // H06: a verified Google identity claims an unverified binding; a failed audit write keeps the original owner.
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody('claimable@example.invalid', 'Unverified Owner'), { idempotencyKey: null })).status, 202);
    const google = h.client();
    state = await providerState(google, 'google');
    h.google.enqueue({ subject: 'google-atomic', email: 'claimable@example.invalid', emailVerified: true, name: 'Google Claimant' });
    await fault.fail('auth.unverified_binding_claimed');
    forced(await google.get(`/v1/auth/google/callback?code=fake&state=${state}`));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.email_binding b JOIN trustwork.person p ON p.id = b.person_id WHERE b.email_normalized = 'claimable@example.invalid' AND p.display_name = 'Unverified Owner' AND b.verified_at IS NULL"), 1);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential c JOIN trustwork.person p ON p.id = c.person_id WHERE p.display_name = 'Unverified Owner' AND c.disabled_at IS NULL"), 1, 'the password of the unverified owner is untouched');
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential WHERE provider_subject = 'google-atomic'"), 0);
    await fault.clear();
    state = await providerState(google, 'google');
    h.google.enqueue({ subject: 'google-atomic', email: 'claimable@example.invalid', emailVerified: true, name: 'Google Claimant' });
    assert.match(String((await google.get(`/v1/auth/google/callback?code=fake&state=${state}`)).headers.location), /auth=signed_in/);
    assert.equal(await auditCount(h.db.admin, 'auth.unverified_binding_claimed'), 1);
  });

  await t.test('provider sign-in, link and unlink: session, link and unlink roll back with the audit write', async () => {
    // Sign-in of the subject linked above.
    const again = h.client();
    let state = await providerState(again, 'google');
    h.google.enqueue({ subject: 'google-atomic', email: 'claimable@example.invalid', emailVerified: true, name: 'Google Claimant' });
    const sessionsOf = (personSql: string) => count(h.db.admin, `SELECT 1 FROM trustwork.session s WHERE s.person_id IN (${personSql})`);
    const claimant = "SELECT person_id FROM trustwork.credential WHERE provider_subject = 'google-atomic'";
    const before = await sessionsOf(claimant);
    await fault.fail('auth.login');
    forced(await again.get(`/v1/auth/google/callback?code=fake&state=${state}`));
    assert.equal(await sessionsOf(claimant), before);
    await fault.clear();

    // Link (step-up fresh session of a verified persona) and unlink.
    const petr = h.client();
    await login(petr, 'petr');
    const link = await petr.post('/v1/auth/link/start', { provider: 'apple' }, { idempotencyKey: null });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    state = new URL((link.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.apple.enqueue({ subject: 'apple-petr-atomic', email: null, emailVerified: false, name: null });
    await fault.fail('auth.provider_linked');
    forced(await petr.get(`/v1/auth/apple/callback?code=fake&state=${state}`));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential WHERE provider_subject = 'apple-petr-atomic'"), 0);
    assert.equal(await outboxCount(h.db.admin, 'identity.provider_linked', seed.people.petr), 0);
    await fault.clear();
    const relink = await petr.post('/v1/auth/link/start', { provider: 'apple' }, { idempotencyKey: null });
    state = new URL((relink.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
    h.apple.enqueue({ subject: 'apple-petr-atomic', email: null, emailVerified: false, name: null });
    assert.match(String((await petr.get(`/v1/auth/apple/callback?code=fake&state=${state}`)).headers.location), /auth=linked/);
    assert.equal(await outboxCount(h.db.admin, 'identity.provider_linked', seed.people.petr), 1);

    await fault.fail('auth.provider_unlinked');
    forced(await petr.post('/v1/auth/unlink', { provider: 'apple' }, { idempotencyKey: null }));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential WHERE provider_subject = 'apple-petr-atomic' AND disabled_at IS NULL"), 1, 'still linked');
    await fault.clear();
    assert.equal((await petr.post('/v1/auth/unlink', { provider: 'apple' }, { idempotencyKey: null })).status, 204);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential WHERE provider_subject = 'apple-petr-atomic' AND disabled_at IS NULL"), 0);
    assert.equal(await outboxCount(h.db.admin, 'identity.provider_unlinked', seed.people.petr), 1);
  });

  await t.test('every committed identity change above has its audit row (no orphan change, no orphan audit)', async () => {
    for (const action of ['auth.signup', 'auth.email_verified', 'auth.login', 'auth.login_failed', 'auth.login_lockout', 'auth.recovery_requested', 'auth.recovery_completed', 'auth.provider_linked', 'auth.provider_unlinked']) {
      assert.ok((await auditCount(h.db.admin, action)) >= 1, action);
    }
  });
});

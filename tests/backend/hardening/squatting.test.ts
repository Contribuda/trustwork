import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness } from '../helpers/app.js';
import { EMAILS, login, seedPersonas } from '../helpers/personas.js';
import { auditCount, count, outboxCount, PASSWORD, providerState, signupBody } from './helpers.js';

const h = await startHarness('hardening_squat');

/**
 * BE-002 acceptance: "The squatting scenario is resolved by victim verification." An attacker who registers someone
 * else's address holds only an unverified binding; the mailbox owner's proof (a verification or e-mail change token
 * delivered to that mailbox) removes it and binds the address to the owner.
 */
test('e-mail squatting is resolved by the mailbox proof of the address owner', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await seedPersonas(h);
  const anonymous = h.client();
  const ATTACKER_PASSWORD = 'attacker chosen password 1234';

  await t.test('password squatter: the victim signs up, proves the mailbox and owns the address; the squatter loses it', async () => {
    const victim = 'victim@example.invalid';
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(victim, 'Squatter', ATTACKER_PASSWORD), { idempotencyKey: null })).status, 202);
    const squatterToken = h.mail.lastTo(victim, 'verify_email')?.params.token as string;
    expectError(await anonymous.post('/v1/auth/login', { email: victim, password: ATTACKER_PASSWORD }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');

    // The victim signs up for their own address: same response as always, and their mailbox gets a verification link.
    const signup = await anonymous.post('/v1/auth/signup', signupBody(victim, 'Real Owner'), { idempotencyKey: null });
    assert.equal(signup.status, 202);
    assert.deepEqual(signup.body, { status: 'verification_sent' });
    assert.equal(h.mail.countTo(victim, 'verify_email'), 2);
    assert.equal(h.mail.countTo(victim, 'already_registered'), 0);
    const claimToken = h.mail.lastTo(victim, 'verify_email')?.params.token as string;

    const owner = h.client();
    const verified = await owner.post('/v1/auth/verify-email', { token: claimToken }, { idempotencyKey: null });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.ok(owner.sessionCookie, 'the owner is signed in by the proof');
    const me = (await owner.get('/v1/me')).body as { person: { displayName: string; emailBindings: { email: string; verifiedAt: string | null; isPrimary: boolean }[] } };
    assert.equal(me.person.displayName, 'Real Owner');
    assert.deepEqual(me.person.emailBindings.map((b) => [b.email, b.isPrimary, b.verifiedAt !== null]), [[victim, true, true]]);

    expectError(await anonymous.post('/v1/auth/login', { email: victim, password: ATTACKER_PASSWORD }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    assert.equal((await h.client().post('/v1/auth/login', { email: victim, password: PASSWORD }, { idempotencyKey: null })).status, 200);
    expectError(await h.client().post('/v1/auth/verify-email', { token: squatterToken }, { idempotencyKey: null }), 404, 'access.not_found');
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.credential c JOIN trustwork.person p ON p.id = c.person_id WHERE p.display_name = 'Squatter' AND c.disabled_at IS NULL"), 0, 'the squatter password is disabled');
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.email_binding b JOIN trustwork.person p ON p.id = b.person_id WHERE p.display_name = 'Squatter'"), 0);
    assert.equal(await auditCount(h.db.admin, 'auth.squatting_binding_removed'), 1);
    const squatter = (await h.db.admin.query<{ id: string }>("SELECT id FROM trustwork.person WHERE display_name = 'Squatter'")).rows[0]?.id as string;
    assert.equal(await outboxCount(h.db.admin, 'identity.sessions_revoked', squatter), 1);
  });

  await t.test('provider squatter (Apple, unverified address): sessions revoked and the link disabled by the owner proof', async () => {
    const victim = 'victim-two@example.invalid';
    const apple = h.client();
    const state = await providerState(apple, 'apple');
    h.apple.enqueue({ subject: 'apple-squatter', email: victim, emailVerified: false, name: 'Apple Squatter' });
    assert.match(String((await apple.get(`/v1/auth/apple/callback?code=fake&state=${state}`)).headers.location), /auth=verification_pending/);
    assert.equal((await apple.get('/v1/me')).status, 200, 'the squatter holds a session through the provider link');

    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(victim, 'Second Owner'), { idempotencyKey: null })).status, 202);
    const claimToken = h.mail.lastTo(victim, 'verify_email')?.params.token as string;
    assert.equal((await h.client().post('/v1/auth/verify-email', { token: claimToken }, { idempotencyKey: null })).status, 200);
    expectError(await apple.get('/v1/me'), 401, 'auth.session_invalid');

    const retry = h.client();
    const retryState = await providerState(retry, 'apple');
    h.apple.enqueue({ subject: 'apple-squatter', email: victim, emailVerified: false, name: 'Apple Squatter' });
    assert.match(String((await retry.get(`/v1/auth/apple/callback?code=fake&state=${retryState}`)).headers.location), /auth=account_exists/, 'the disabled link no longer signs in');
    assert.equal(retry.sessionCookie, null);
  });

  await t.test('e-mail change to a squatted address: the proof moves the address to the account that proved it', async () => {
    const squatted = 'carl-new@example.invalid';
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(squatted, 'Change Squatter', ATTACKER_PASSWORD), { idempotencyKey: null })).status, 202);
    const carl = h.client();
    await login(carl, 'carl');
    assert.equal((await carl.post('/v1/me/email', { newEmail: squatted })).status, 202);
    const token = h.mail.lastTo(squatted, 'email_change')?.params.token as string;
    assert.equal((await carl.post('/v1/auth/verify-email', { token }, { idempotencyKey: null })).status, 200);
    const bindings = ((await carl.get('/v1/me')).body as { person: { emailBindings: { email: string; isPrimary: boolean; verifiedAt: string | null }[] } }).person.emailBindings;
    assert.deepEqual(bindings.find((b) => b.isPrimary)?.email, squatted);
    assert.ok(bindings.every((b) => b.verifiedAt !== null));
  });

  await t.test('a verified address is never claimable: an e-mail change to it answers auth.email_taken and changes nothing', async () => {
    const boris = h.client();
    await login(boris, 'boris');
    assert.equal((await boris.post('/v1/me/email', { newEmail: EMAILS.anna })).status, 202);
    const token = h.mail.lastTo(EMAILS.anna, 'email_change')?.params.token as string;
    const taken = await boris.post('/v1/auth/verify-email', { token }, { idempotencyKey: null });
    assert.equal(taken.status, 409);
    assert.equal((taken.body as { code: string }).code, 'auth.email_taken');
    await login(h.client(), 'anna');
    // A signup for a verified address still only notifies the owner.
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(EMAILS.anna, 'Intruder'), { idempotencyKey: null })).status, 202);
    assert.equal(h.mail.countTo(EMAILS.anna, 'already_registered'), 1);
    assert.equal(h.mail.countTo(EMAILS.anna, 'verify_email'), 0);
  });

  await t.test('concurrency: two mailbox proofs for the same squatted address race; exactly one wins', async () => {
    const victim = 'race@example.invalid';
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(victim, 'Race Squatter', ATTACKER_PASSWORD), { idempotencyKey: null })).status, 202);
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(victim, 'Race Claimant A'), { idempotencyKey: null })).status, 202);
    const tokenA = h.mail.lastTo(victim, 'verify_email')?.params.token as string;
    assert.equal((await anonymous.post('/v1/auth/signup', signupBody(victim, 'Race Claimant B', 'another claimant password 77'), { idempotencyKey: null })).status, 202);
    const tokenB = h.mail.lastTo(victim, 'verify_email')?.params.token as string;
    const [a, b] = await Promise.all([h.client().post('/v1/auth/verify-email', { token: tokenA }, { idempotencyKey: null }), h.client().post('/v1/auth/verify-email', { token: tokenB }, { idempotencyKey: null })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1 AND verified_at IS NOT NULL', [victim]), 1);
    const winner = a.status === 200 ? PASSWORD : 'another claimant password 77';
    assert.equal((await h.client().post('/v1/auth/login', { email: victim, password: winner }, { idempotencyKey: null })).status, 200);
  });

  await t.test('concurrency: simultaneous signups for a free address leave one binding; the other becomes a claim', async () => {
    const email = 'twins@example.invalid';
    const results = await Promise.all([0, 1, 2].map((i) => anonymous.post('/v1/auth/signup', signupBody(email, `Twin ${i}`), { idempotencyKey: null })));
    assert.deepEqual(results.map((r) => r.status), [202, 202, 202]);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.email_binding WHERE email_normalized = $1', [email]), 1);
    assert.equal(h.mail.countTo(email, 'verify_email'), 3, 'each signup can prove the mailbox');
  });
});

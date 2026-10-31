import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../helpers/app.js';
import { EMAILS, login, seedPersonas, type PersonaKey } from '../helpers/personas.js';
import { auditCount, outboxCount } from '../hardening/helpers.js';
import { elevate, enrol, nextCode, notices, passwordLogin, secondStep, signInWithTotp, type Enrolled } from './helpers.js';

const h = await startHarness('second_factor_staff');

function required(response: Response): string | undefined {
  return (response.body as { details?: { required?: string } }).details?.required;
}

/**
 * BE-004 staff side on real PostgreSQL: `admin.session.elevate` (step-up plus a second factor, short expiry, bound to
 * the session), staff routes refusing unelevated or expired sessions, and the support reset of another person's
 * second factor with evidence, a second person and the 72-hour cooling-off, announced to the subject.
 */
test('elevated sessions and the support reset', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const enrolled = new Map<PersonaKey, Enrolled>();
  const signedIn = async (key: PersonaKey): Promise<Client> => {
    const client = h.client();
    await login(client, key);
    if (!enrolled.has(key)) enrolled.set(key, await enrol(h, client));
    else {
      // login() saw the challenge; finish it.
      assert.equal((await secondStep(client, { method: 'totp', code: nextCode(h, enrolled.get(key)!.secret) })).status, 200);
    }
    return client;
  };
  // anna: support agent; boris: support lead; petr: the subject; carl: staff without a second factor; xenia: no staff role.
  h.staff.set(seed.people.anna, ['support-agent']);
  h.staff.set(seed.people.boris, ['support-lead']);
  h.staff.set(seed.people.carl, ['support-agent']);
  const anna = await signedIn('anna');
  const boris = await signedIn('boris');
  let petr = await signedIn('petr');

  await t.test('a staff route refuses non-staff, unelevated and expired sessions with 403', async () => {
    const xenia = h.client();
    await login(xenia, 'xenia');
    const nonStaff = await xenia.get('/v1/admin/session');
    expectError(nonStaff, 403, 'access.forbidden');
    assert.equal(required(nonStaff), 'staff');
    expectError(await xenia.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: '123456' } }, { idempotencyKey: null }), 403, 'access.forbidden');

    const unelevated = await anna.get('/v1/admin/session');
    expectError(unelevated, 403, 'access.forbidden');
    assert.equal(required(unelevated), 'elevation');
    const resetRoute = await anna.post('/v1/admin/support/second-factor-resets', { subjectPersonId: seed.people.petr, supportCaseId: randomUUID(), evidenceRefs: [randomUUID()], reason: 'Lost phone, identity checked by video call' });
    expectError(resetRoute, 403, 'access.forbidden');
    assert.equal(required(resetRoute), 'elevation');

    const carl = h.client();
    await login(carl, 'carl');
    const noFactor = await carl.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: '123456' } }, { idempotencyKey: null });
    expectError(noFactor, 403, 'access.forbidden');
    assert.equal(required(noFactor), 'second_factor');

    const elevation = await elevate(h, anna, enrolled.get('anna')!.secret);
    const live = await anna.get('/v1/admin/session');
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(live.body, { elevationId: elevation.elevationId, factor: 'totp', expiresAt: elevation.expiresAt, staffRoles: ['support-agent'] });
    assert.ok(Date.parse(elevation.expiresAt) - h.clock.now().getTime() <= 15 * 60_000 + 1_000, 'short-lived');
    assert.equal(await auditCount(h.db.admin, 'admin.session.elevate'), 1);

    h.clock.advance(15 * 60_000 + 1_000);
    const expired = await anna.get('/v1/admin/session');
    expectError(expired, 403, 'access.forbidden');
    assert.equal(required(expired), 'elevation');
  });

  await t.test('elevation needs a fresh step-up and an unused code, and is bound to its session', async () => {
    h.clock.advance(11 * 60_000);
    const fresh = h.client();
    await login(fresh, 'anna');
    assert.equal((await secondStep(fresh, { method: 'totp', code: nextCode(h, enrolled.get('anna')!.secret) })).status, 200);
    const used = nextCode(h, enrolled.get('anna')!.secret);
    assert.equal((await fresh.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: used } }, { idempotencyKey: null })).status, 200);
    expectError(await fresh.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: used } }, { idempotencyKey: null }), 401, 'auth.invalid_credentials');
    // The old session of the same person is not elevated by the new session's elevation, and its step-up is stale.
    const other = await anna.get('/v1/admin/session');
    expectError(other, 403, 'access.forbidden');
    expectError(await anna.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: nextCode(h, enrolled.get('anna')!.secret) } }, { idempotencyKey: null }), 403, 'auth.step_up_required');
    // Ending the elevation and signing out both end it.
    assert.deepEqual((await fresh.post('/v1/admin/session/end', undefined, { idempotencyKey: null })).body, { ended: 1 });
    expectError(await fresh.get('/v1/admin/session'), 403, 'access.forbidden');
    await elevate(h, fresh, enrolled.get('anna')!.secret);
    assert.equal((await fresh.get('/v1/admin/session')).status, 200);
    const cookie = fresh.sessionCookie;
    assert.equal((await fresh.post('/v1/auth/logout', undefined, { idempotencyKey: null })).status, 204);
    fresh.setSessionCookie(cookie);
    expectError(await fresh.get('/v1/admin/session'), 401, 'auth.session_invalid');
    // Losing the staff role ends what the elevation allowed.
    const again = h.client();
    await login(again, 'anna');
    assert.equal((await secondStep(again, { method: 'totp', code: nextCode(h, enrolled.get('anna')!.secret) })).status, 200);
    await elevate(h, again, enrolled.get('anna')!.secret);
    h.staff.set(seed.people.anna, []);
    const revoked = await again.get('/v1/admin/session');
    expectError(revoked, 403, 'access.forbidden');
    assert.equal(required(revoked), 'staff');
    h.staff.set(seed.people.anna, ['support-agent']);
  });

  let agent: Client = anna;
  let lead: Client = boris;
  const reset = async (client: Client, path: string, body?: unknown) => client.post(`/v1/admin/support/second-factor-resets${path}`, body ?? {});
  const request = (client: Client, subject = seed.people.petr) =>
    reset(client, '', { subjectPersonId: subject, supportCaseId: randomUUID(), evidenceRefs: [randomUUID()], reason: 'Lost phone; identity confirmed by a recorded video check' });

  await t.test('support reset: evidence, a second person, the 72-hour cooling-off and notices to the subject', async () => {
    agent = h.client();
    await login(agent, 'anna');
    await secondStep(agent, { method: 'totp', code: nextCode(h, enrolled.get('anna')!.secret) });
    await elevate(h, agent, enrolled.get('anna')!.secret);
    lead = h.client();
    await login(lead, 'boris');
    await secondStep(lead, { method: 'totp', code: nextCode(h, enrolled.get('boris')!.secret) });
    await elevate(h, lead, enrolled.get('boris')!.secret);

    petr = h.client();
    await signInWithTotp(h, petr, 'petr', enrolled.get('petr')!.secret);

    expectError(await reset(agent, '', { subjectPersonId: seed.people.petr, supportCaseId: randomUUID(), evidenceRefs: [], reason: 'No evidence at all here' }), 422, 'validation.schema');
    expectError(await request(agent, seed.people.anna), 403, 'access.forbidden');
    const before = (await notices(h, EMAILS.petr)).length;
    const requested = await request(agent);
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const view = requested.body as { id: string; state: string; requestedBy: string; approvedBy: string | null; effectiveAt: string | null };
    assert.deepEqual({ state: view.state, requestedBy: view.requestedBy, approvedBy: view.approvedBy, effectiveAt: view.effectiveAt }, { state: 'pending', requestedBy: seed.people.anna, approvedBy: null, effectiveAt: null });
    assert.deepEqual((await notices(h, EMAILS.petr)).slice(before), ['second_factor_reset_requested']);
    assert.equal(await outboxCount(h.db.admin, 'identity.second_factor_reset_requested', seed.people.petr), 1);
    const audit = await h.db.admin.query<{ basis: { sessionElevationId?: string; evidenceCount?: number } }>("SELECT basis FROM trustwork.audit_event WHERE action = 'support.second_factor_reset_requested'");
    assert.equal(audit.rows[0]?.basis.evidenceCount, 1);
    assert.ok(audit.rows[0]?.basis.sessionElevationId, 'audit names the elevation');
    expectError(await request(agent), 409, 'validation.revision_conflict');

    // The requester cannot approve (no approver role), and an approver who is also the requester is refused by the database.
    expectError(await reset(agent, `/${view.id}/approve`), 403, 'access.forbidden');
    h.staff.set(seed.people.anna, ['support-agent', 'support-lead']);
    expectError(await reset(agent, `/${view.id}/approve`), 403, 'access.second_approver_required');
    h.staff.set(seed.people.anna, ['support-agent']);
    // The subject is no staff member and cannot reach staff routes at all.
    expectError(await reset(petr, `/${view.id}/approve`), 403, 'access.forbidden');
    // Executing before approval is refused.
    expectError(await reset(agent, `/${view.id}/execute`), 409, 'validation.revision_conflict');

    const approved = await reset(lead, `/${view.id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const cooling = approved.body as { state: string; approvedBy: string; requestedAt: string; approvedAt: string; effectiveAt: string };
    assert.equal(cooling.state, 'cooling_off');
    assert.equal(cooling.approvedBy, seed.people.boris);
    assert.ok(Date.parse(cooling.effectiveAt) - Date.parse(cooling.requestedAt) >= 72 * 3_600_000);
    assert.ok(Date.parse(cooling.effectiveAt) - Date.parse(cooling.approvedAt) >= 72 * 3_600_000);
    assert.equal((await notices(h, EMAILS.petr)).at(-1), 'second_factor_reset_approved');

    // The cooling-off runs on the database clock (the API clock cannot shorten it).
    const early = await reset(agent, `/${view.id}/execute`);
    expectError(early, 403, 'access.forbidden');
    assert.equal((early.body as { details?: { reason?: string } }).details?.reason, 'cooling_off');

    // The subject sees the pending reset and cancels it; nothing changes for them.
    const status = (await petr.get('/v1/me/second-factor')).body as { pendingReset: { id: string; state: string } | null };
    assert.deepEqual(status.pendingReset && { id: status.pendingReset.id, state: status.pendingReset.state }, { id: view.id, state: 'cooling_off' });
    const cancelled = await petr.post(`/v1/me/second-factor/resets/${view.id}/cancel`, undefined, { idempotencyKey: null });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await notices(h, EMAILS.petr)).at(-1), 'second_factor_reset_cancelled');
    expectError(await reset(agent, `/${view.id}/execute`), 409, 'validation.revision_conflict');
    assert.equal(((await petr.get('/v1/me/second-factor')).body as { enrolled: boolean; pendingReset: unknown }).enrolled, true);
    // Someone uninvolved cannot read or cancel it.
    expectError(await xeniaCannotCancel(view.id), 404, 'access.not_found');
  });

  async function xeniaCannotCancel(id: string): Promise<Response> {
    const xenia = h!.client();
    await login(xenia, 'xenia');
    return xenia.post(`/v1/me/second-factor/resets/${id}/cancel`, undefined, { idempotencyKey: null });
  }

  await t.test('after the cooling-off the reset ends every factor, code and session of the subject', async () => {
    const requested = await request(agent);
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const id = (requested.body as { id: string }).id;
    assert.equal((await reset(lead, `/${id}/approve`)).status, 200);
    // Simulate the passage of 73 hours on the database clock for this row only.
    await h.db.admin.query("UPDATE trustwork.second_factor_reset SET requested_at = requested_at - interval '73 hours', approved_at = approved_at - interval '73 hours', effective_at = effective_at - interval '73 hours' WHERE id = $1", [id]);
    const sessionsBefore = (await h.db.admin.query('SELECT 1 FROM trustwork.session WHERE person_id = $1 AND revoked_at IS NULL', [seed.people.petr])).rowCount ?? 0;
    assert.ok(sessionsBefore >= 1);
    const done = await reset(lead, `/${id}/execute`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((done.body as { state: string }).state, 'done');
    expectError(await petr.get('/v1/me'), 401, 'auth.session_invalid');
    assert.equal((await h.db.admin.query("SELECT 1 FROM trustwork.second_factor WHERE person_id = $1 AND state = 'active'", [seed.people.petr])).rowCount, 0);
    assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.recovery_code WHERE person_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [seed.people.petr])).rowCount, 0);
    assert.equal((await notices(h, EMAILS.petr)).at(-1), 'second_factor_reset_completed');
    assert.equal(await outboxCount(h.db.admin, 'identity.second_factor_reset_completed', seed.people.petr), 1);
    // The subject signs in with the password alone and may enrol again.
    const back = h.client();
    assert.equal(((await passwordLogin(back, 'petr')).body as { status: string }).status, 'authenticated');
    await enrol(h, back);
    expectError(await reset(lead, `/${id}/execute`), 409, 'validation.revision_conflict');
  });
});

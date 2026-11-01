import test from 'node:test';
import assert from 'node:assert/strict';
import { InvitationPreviewSchema } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { chosenLocale, requestLocales } from '../../apps/api/src/modules/identity/mail.js';
import { expectError, SKIP_REASON, startHarness, type Client } from './helpers/app.js';
import { EMAILS, login, PASSWORDS, seedPersonas, type PersonaKey } from './helpers/personas.js';

const h = await startHarness('invitations');

test('request languages: the web language cookie first, then Accept-Language; malformed values are ignored', () => {
  assert.deepEqual(requestLocales('ru;q=0.5, en-US', 'other=1; trustwork.locale=es; x=y'), ['es', 'en-US', 'ru']);
  assert.deepEqual(requestLocales('es-US,es;q=0.8', undefined), ['es-US', 'es']);
  assert.deepEqual(requestLocales(undefined, 'trustwork.locale=uz-latn'), ['uz-Latn'], 'canonical case');
  assert.equal(chosenLocale('trustwork.locale=../../etc'), null);
  assert.equal(chosenLocale('trustwork.locale=%E0%A4%A'), null);
  assert.equal(chosenLocale(undefined), null);
  assert.deepEqual(requestLocales('en', 'trustwork.locale=en'), ['en'], 'no duplicates');
});

/**
 * QA-002 D1 and D5 over HTTP on real PostgreSQL. The mailed link `/invitations/<membershipId>/<token>` works without a
 * company id: preview (never spends the proof) and accept (spends it once) for the signed-in invitee only, with the
 * single-use, expiry and wrong-person refusals; and the invitation mail's language follows the invitee's recorded
 * language, else the inviter's chosen language, else the hub default.
 */
test('invitation link: preview and accept without a company id; single use, expiry, wrong person; mail language', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const as = async (key: PersonaKey, headers: Record<string, string> = {}): Promise<Client> => {
    const client = h.client();
    if (Object.keys(headers).length === 0) await login(client, key);
    else assert.equal((await client.post('/v1/auth/login', { email: EMAILS[key], password: PASSWORDS[key] }, { idempotencyKey: null, headers })).status, 200);
    return client;
  };
  const company = seed.companies.unrelated;
  const carl = await as('carl');
  const anonymous = h.client();
  const invite = async (key: PersonaKey, inviter: Client = carl, headers: Record<string, string> = {}) => {
    const response = await inviter.post(`/v1/companies/${company}/memberships`, { companyId: company, inviteeEmail: EMAILS[key], role: 'member', permissions: [] }, { headers });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const mail = (await h.mail.lastTo(EMAILS[key], 'membership_invitation'))!;
    return { body: { membershipId: mail.params.membershipId as string, invitationToken: mail.params.token as string }, mail };
  };
  const activations = async (membershipId: string) =>
    (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'membership.activated' AND object_id = $1", [membershipId])).rows[0]!.n;

  // D5 first: Petr signs in with the web app set to Spanish, so his own language is recorded; Xenia never chose one.
  const petr = await as('petr', { cookie: 'trustwork.locale=es', 'accept-language': 'en-US' });
  const xenia = await as('xenia');
  const recorded = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('person_mail_locale').selectAll().where('person_id', '=', seed.people.petr).executeTakeFirst());
  assert.equal(recorded?.locale, 'es');
  assert.equal(recorded?.source, 'sign_in');
  const { body: link, mail: linkMail } = await invite('petr', carl, { 'accept-language': 'ru' });

  await t.test('D5: the invitee\'s recorded language comes first, then the inviter\'s chosen language', async () => {
    assert.deepEqual(linkMail.localePreferences, ['es', 'ru']);
    carl.jar.set('trustwork.locale', 'uz-Latn');
    const inviterChoice = await invite('xenia', carl, { 'accept-language': 'es-US,es;q=0.8' });
    carl.jar.delete('trustwork.locale');
    assert.deepEqual(inviterChoice.mail.localePreferences.slice(0, 3), ['uz-Latn', 'es-US', 'es'], 'no recorded language: the inviter\'s chosen language');
    const none = await invite('xenia');
    assert.deepEqual(none.mail.localePreferences, [], 'nothing known: the worker uses the hub default');
  });

  await t.test('D1: without a session the link routes answer 401 and change nothing', async () => {
    expectError(await anonymous.post('/v1/invitations/preview', link, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await anonymous.post('/v1/invitations/accept', link), 401, 'auth.session_invalid');
    assert.equal(await activations(link.membershipId), 0);
  });

  await t.test('D1: another signed-in person gets not found for the preview and the accept, and the proof stays usable', async () => {
    expectError(await xenia.post('/v1/invitations/preview', link, { idempotencyKey: null }), 404, 'access.not_found');
    expectError(await xenia.post('/v1/invitations/accept', link), 404, 'access.not_found');
    expectError(await petr.post('/v1/invitations/preview', { ...link, invitationToken: 'x'.repeat(43) }, { idempotencyKey: null }), 404, 'access.not_found');
    expectError(await petr.post('/v1/invitations/preview', { ...link, membershipId: seed.memberships.carl }, { idempotencyKey: null }), 404, 'access.not_found');
    assert.equal(await activations(link.membershipId), 0);
  });

  await t.test('D1: the invitee previews the company and role as often as needed without spending the proof', async () => {
    for (let i = 0; i < 2; i++) {
      const preview = await petr.post('/v1/invitations/preview', link, { idempotencyKey: null });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const parsed = InvitationPreviewSchema.parse(preview.body);
      assert.equal(parsed.membershipId, link.membershipId);
      assert.equal(parsed.company.id, company);
      assert.ok(parsed.company.name.length > 0);
      assert.equal(parsed.role, 'member');
    }
    const token = await h.db.admin.query<{ consumed_at: Date | null }>("SELECT consumed_at FROM trustwork.auth_token WHERE kind = 'membership_invitation' AND person_id = $1 ORDER BY created_at DESC LIMIT 1", [seed.people.petr]);
    assert.equal(token.rows[0]?.consumed_at, null, 'the preview rolled its consumption back');
  });

  await t.test('D1: two concurrent accepts activate the membership once; the link is single use afterwards', async () => {
    const results = await Promise.all([petr.post('/v1/invitations/accept', link), petr.post('/v1/invitations/accept', link)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 404], JSON.stringify(results.map((r) => r.body)));
    const accepted = results.find((r) => r.status === 200)!.body as { id: string; companyId: string; status: string; revision: number };
    assert.equal(accepted.id, link.membershipId);
    assert.equal(accepted.companyId, company, 'the company comes from the membership');
    assert.equal(accepted.status, 'active');
    assert.equal(await activations(link.membershipId), 1);
    expectError(await petr.post('/v1/invitations/preview', link, { idempotencyKey: null }), 404, 'access.not_found');
    expectError(await petr.post('/v1/invitations/accept', link), 404, 'access.not_found');
    const ended = await carl.post(`/v1/companies/${company}/memberships/end`, { membershipId: accepted.id, reason: 'invitation test', expectedRevision: accepted.revision });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
  });

  await t.test('D1: an expired invitation is refused by the preview and the accept', async () => {
    const fresh = (await invite('petr')).body;
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('auth_token').set({ expires_at: new Date(Date.now() - 1_000) })
      .where('kind', '=', 'membership_invitation').where('person_id', '=', seed.people.petr).where('consumed_at', 'is', null).execute());
    expectError(await petr.post('/v1/invitations/preview', fresh, { idempotencyKey: null }), 404, 'access.not_found');
    expectError(await petr.post('/v1/invitations/accept', fresh), 404, 'access.not_found');
    assert.equal(await activations(fresh.membershipId), 0);
  });

  await t.test('D1: the company route still accepts the same proof (the link and the route agree)', async () => {
    const again = (await invite('petr')).body;
    const accepted = await petr.post(`/v1/companies/${company}/memberships/accept`, again);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  });
});

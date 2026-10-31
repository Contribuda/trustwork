import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { CONSENT_NOTICE_VERSIONS } from '../../packages/contracts/src/profiles.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * Directory follow-up to PPL-001 (BE-003 #51, PPL-001 #67; integrator decision on PR #308): a person whose profile
 * is public without a live profile_public consent (a maintenance seed, an import, older data) is never listed, never
 * found by id or handle and never readable by another signed-in person, through every public listing and lookup:
 * the anonymous and signed-in directories, by-handle lookups, handle resolution, GET /v1/people/:id and the person
 * row under RLS. The person still sees themselves.
 */
const h = await startHarness('directory_consent');

function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

test('directory: a public person without a live profile_public consent is never listed and never found', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const carl = await as('carl');
  const petr = await as('petr');
  const anonymous = h.client();
  const carlId = seed.people.carl;
  ok(await carl.post('/v1/me/handle', { handle: 'carl-builds' }));

  const listed = async (client: Client) => ok<{ items: { id: string }[] }>(await client.get('/v1/people?limit=100')).items.some((p) => p.id === carlId);
  const rowVisibleTo = async (viewer: string) => withPrincipal(h.db.app, await principalFor(h.db.admin, viewer), (trx) => trx.selectFrom('person').select('id').where('id', '=', carlId).executeTakeFirst());
  async function hiddenEverywhere(label: string): Promise<void> {
    for (const client of [anonymous, petr]) {
      assert.equal(await listed(client), false, `${label}: not listed`);
      expectError(await client.get(`/v1/people/${carlId}`), 404, 'access.not_found');
      expectError(await client.get('/v1/people/by-handle/carl-builds'), 404, 'access.not_found');
      expectError(await client.get('/v1/handles/person/carl-builds'), 404, 'access.not_found');
      expectError(await client.get(`/v1/people/${carlId}/profile`), 404, 'access.not_found');
      expectError(await client.get('/v1/people/by-handle/carl-builds/profile'), 404, 'access.not_found');
    }
    assert.equal(await rowVisibleTo(seed.people.petr), undefined, `${label}: another person cannot read the row`);
    assert.equal((await rowVisibleTo(carlId))?.id, carlId, `${label}: the person still sees themselves`);
  }

  await t.test('made public through maintenance without consent: hidden from every public path', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public', public_headline: 'Site manager' }).where('id', '=', carlId).execute());
    await hiddenEverywhere('no consent');
    const anon = await h.db.app.query('SELECT count(*)::int AS n FROM trustwork.directory_public_people(NULL, NULL, 101) WHERE id = $1', [carlId]);
    assert.equal(anon.rows[0].n, 0, 'the owner-run anonymous list checks the consent itself');
    assert.equal((await h.db.app.query('SELECT count(*)::int AS n FROM trustwork.public_person_read($1)', [carlId])).rows[0].n, 0);
    assert.equal((await h.db.app.query("SELECT count(*)::int AS n FROM trustwork.directory_public_resolve('person', 'carl-builds')")).rows[0].n, 0);
    assert.equal(ok<{ person: { id: string } }>(await carl.get('/v1/me')).person.id, carlId);
  });

  await t.test('with the consent the person appears; after withdrawal nothing brings them back', async () => {
    ok(await carl.post('/v1/me/profile/visibility', { visibility: 'public', noticeVersion: CONSENT_NOTICE_VERSIONS.profile_public }));
    for (const client of [anonymous, petr]) {
      assert.equal(await listed(client), true);
      assert.equal(ok<{ item: { id: string } }>(await client.get('/v1/people/by-handle/carl-builds')).item.id, carlId);
      assert.equal(ok<{ id: string }>(await client.get('/v1/handles/person/carl-builds')).id, carlId);
      assert.equal(ok<{ id: string }>(await client.get(`/v1/people/${carlId}`)).id, carlId);
    }
    assert.equal((await rowVisibleTo(seed.people.petr))?.id, carlId);
    ok(await carl.post('/v1/me/profile/visibility', { visibility: 'private', reason: 'Not now' }));
    // Flipping the flag back without a new consent (maintenance, an import) does not republish.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', '=', carlId).execute());
    await hiddenEverywhere('consent withdrawn');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';

const h = await startHarness('directory_api');

type Page<T> = { items: T[]; nextCursor: string | null };
type Company = { id: string; handle: string | null; name: string; origin: string; claimStatus: string; legalIdentifiers: unknown[]; publicDescription: string | null };
type MyProject = { id: string; handle: string | null; relation: 'owner' | 'participant'; owner: { kind: string; id: string }; published: boolean };
const COMPANY_KEYS = ['claimStatus', 'handle', 'id', 'legalIdentifiers', 'name', 'origin', 'publicDescription'];
const PERSON_KEYS = ['displayName', 'handle', 'id', 'publicProfile'];
const PROJECT_KEYS = ['handle', 'id', 'name', 'openNeedIds', 'publicParticipantIds', 'publishedStory', 'status', 'summary'];
const MY_PROJECT_KEYS = ['createdAt', 'handle', 'id', 'leaderPersonId', 'name', 'owner', 'published', 'relation', 'status', 'summary'];
/** Values that exist only in private columns of the seeded rows; no directory response may contain them. */
const PRIVATE_MARKERS = ['owner_private', 'internalNotes', 'internal_notes', 'billingAccountId', 'privateNotes', 'private_notes', 'emailBindings', 'example.invalid', 'verifiedDomains', 'membershipRequests', 'budgets', 'tokenHash'];

const body = <T>(r: Response): T => r.body as T;
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
function noPrivateMarkers(r: Response): void {
  const json = JSON.stringify(r.body);
  for (const marker of PRIVATE_MARKERS) assert.ok(!json.includes(marker), `private marker ${marker} leaked: ${json.slice(0, 300)}`);
}
function keysOf(items: readonly object[], expected: readonly string[]): void {
  for (const item of items) assert.deepEqual(Object.keys(item).sort(), expected);
}
/** Walks every page of a list with the given page size; fails on a duplicate id. */
async function walk<T extends { id: string }>(client: Client, path: string, limit: number): Promise<T[]> {
  const seen: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const page: Page<T> = ok(await client.get(`${path}?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`));
    assert.ok(page.items.length <= limit);
    for (const item of page.items) {
      assert.ok(!seen.some((s) => s.id === item.id), `duplicate ${item.id} in ${path}`);
      seen.push(item);
    }
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

test('directory API: company creation, handles with redirects, keyset directories and negative authorization', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const petr = await as('petr');
  const anna = await as('anna');
  const boris = await as('boris');
  const carl = await as('carl');
  const xenia = await as('xenia');
  const pure = await as('pure');
  const anonymous = h.client();
  const admin = h.db.admin;
  const count = async (sqlText: string, params: unknown[] = []): Promise<number> => Number((await admin.query<{ n: number }>(sqlText, params)).rows[0]?.n);

  let roofing: Company;
  await t.test('POST /v1/companies: a registered, unclaimed company with exactly one administrator, the creator', async () => {
    expectError(await anonymous.post('/v1/companies', { name: 'Fixture Roofing', handle: null, publicDescription: null }), 401, 'auth.session_invalid');
    expectError(await petr.post('/v1/companies', { name: 'Fixture Roofing', handle: null, publicDescription: null, claimStatus: 'verified' }), 422, 'validation.unknown_field');
    const before = await count('SELECT count(*)::int AS n FROM trustwork.company');
    expectError(await anna.post('/v1/companies', { name: 'Second Employer', handle: null, publicDescription: null }), 409, 'membership.already_employed');
    assert.equal(await count('SELECT count(*)::int AS n FROM trustwork.company'), before, 'an employed person creates nothing');

    const created = ok<{ company: Company; membership: { personId: string; companyId: string; role: string; status: string; permissions: string[]; invitedBy: string | null } }>(
      await petr.post('/v1/companies', { name: 'Fixture Roofing', handle: 'Fixture-Roofing', publicDescription: 'Roofs and gutters' }), 201,
    );
    roofing = created.company;
    assert.deepEqual(Object.keys(created.company).sort(), COMPANY_KEYS);
    assert.equal(created.company.origin, 'registered');
    assert.equal(created.company.claimStatus, 'unclaimed', 'never claimed or verified at creation');
    assert.equal(created.company.handle, 'fixture-roofing', 'handles are normalised');
    assert.equal(created.membership.personId, seed.people.petr);
    assert.equal(created.membership.role, 'administrator');
    assert.equal(created.membership.status, 'active');
    assert.equal(created.membership.invitedBy, null);
    assert.equal(created.membership.permissions.length, 7);
    const rows = await withMaintenance(admin, (trx) => trx.selectFrom('membership').selectAll().where('company_id', '=', roofing.id).execute());
    assert.equal(rows.length, 1, 'exactly one membership');
    assert.equal(rows.filter((r) => r.status === 'active' && r.role === 'administrator').length, 1, 'exactly one administrator');
    const company = await withMaintenance(admin, (trx) => trx.selectFrom('company').selectAll().where('id', '=', roofing.id).executeTakeFirstOrThrow());
    assert.equal(company.claim_status, 'unclaimed');
    assert.equal(company.sourced_status, 'registered');
    assert.deepEqual(company.verified_domains, []);
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'company.created' AND object_id = $1", [roofing.id]), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE type = 'company.created' AND aggregate_id = $1", [roofing.id]), 1);

    // The creator is now employed: the next request re-resolves the principal (epoch bumped) and is refused.
    expectError(await petr.post('/v1/companies', { name: 'Fixture Roofing Two', handle: null, publicDescription: null }), 409, 'membership.already_employed');
    const me = ok<{ membership: { companyId: string; role: string } | null }>(await petr.get('/v1/me'));
    assert.equal(JSON.stringify(me).includes(roofing.id), true, 'the founding membership is the active employer');
  });

  await t.test('company creation is atomic: a taken handle or a concurrent second creation leaves no company behind', async () => {
    const before = await count('SELECT count(*)::int AS n FROM trustwork.company');
    const taken = await xenia.post('/v1/companies', { name: 'Handle Squatter', handle: 'fixture-roofing', publicDescription: null });
    expectError(taken, 422, 'validation.schema');
    assert.deepEqual((taken.body as { details: unknown }).details, { field: 'handle', reason: 'handle_unavailable' });
    assert.equal(await count('SELECT count(*)::int AS n FROM trustwork.company'), before, 'rolled back with the handle');
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.membership WHERE person_id = $1 AND status = 'active'", [seed.people.xenia]), 0);

    const results = await Promise.all([1, 2, 3].map((i) => xenia.post('/v1/companies', { name: `Race ${i}`, handle: null, publicDescription: null })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(results.map((r) => r.body)));
    for (const r of results.filter((r) => r.status === 409)) expectError(r, 409, 'membership.already_employed');
    assert.equal(await count('SELECT count(*)::int AS n FROM trustwork.company'), before + 1, 'only the winner exists');
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.company c WHERE NOT EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.company_id = c.id AND m.role = 'administrator' AND m.status = 'active') AND c.created_at > now() - interval '1 hour' AND c.display_name LIKE 'Race %'"), 0, 'no company without an administrator');
  });

  await t.test('person handles: own only, changeable with a redirect, never reused for another person, reclaimable by the owner', async () => {
    expectError(await anonymous.post('/v1/me/handle', { handle: 'nobody-here' }), 401, 'auth.session_invalid');
    expectError(await pure.post('/v1/me/handle', { handle: 'me' }), 422, 'validation.schema');
    assert.deepEqual(ok(await pure.post('/v1/me/handle', { handle: 'pure-fixture' })), { kind: 'person', id: seed.people.pure, handle: 'pure-fixture' });
    assert.deepEqual(ok(await pure.post('/v1/me/handle', { handle: 'pure-builder' })), { kind: 'person', id: seed.people.pure, handle: 'pure-builder' });
    // Public profile: anonymous lookups follow the retired handle to the current one.
    const old = ok<{ item: { id: string; handle: string }; redirect: boolean }>(await anonymous.get('/v1/people/by-handle/pure-fixture'));
    assert.equal(old.redirect, true);
    assert.equal(old.item.handle, 'pure-builder');
    assert.deepEqual(Object.keys(old.item).sort(), PERSON_KEYS);
    assert.deepEqual(ok(await anonymous.get('/v1/handles/person/PURE-FIXTURE')), { kind: 'person', id: seed.people.pure, handle: 'pure-builder', requested: 'pure-fixture', redirect: true });
    const current = ok<{ redirect: boolean }>(await anna.get('/v1/people/by-handle/pure-builder'));
    assert.equal(current.redirect, false);
    // Never reused: neither the retired nor the current handle can be taken by someone else.
    for (const handle of ['pure-fixture', 'pure-builder']) {
      const r = await petr.post('/v1/me/handle', { handle });
      expectError(r, 422, 'validation.schema');
      assert.equal((r.body as { details: { reason: string } }).details.reason, 'handle_unavailable');
    }
    assert.equal(ok<{ handle: string }>(await pure.post('/v1/me/handle', { handle: 'pure-fixture' })).handle, 'pure-fixture', 'the owner reclaims a former handle');
    assert.equal(ok<{ redirect: boolean }>(await anonymous.get('/v1/people/by-handle/pure-builder')).redirect, true);
    assert.equal(await count("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'person.handle_changed' AND object_id = $1", [seed.people.pure]), 3);
  });

  await t.test('a private profile is not listed and its handle resolves only for the person', async () => {
    ok(await petr.post('/v1/me/handle', { handle: 'petr-private' }));
    for (const client of [anonymous, anna, pure]) {
      expectError(await client.get('/v1/handles/person/petr-private'), 404, 'access.not_found');
      expectError(await client.get('/v1/people/by-handle/petr-private'), 404, 'access.not_found');
    }
    assert.equal(ok<{ id: string }>(await petr.get('/v1/handles/person/petr-private')).id, seed.people.petr, 'the person resolves their own handle');
    expectError(await petr.get('/v1/people/by-handle/petr-private'), 404, 'access.not_found');
    for (const client of [anonymous, anna, petr]) {
      const people = await walk<{ id: string; handle: string | null }>(client, '/v1/people', 2);
      assert.ok(!people.some((p) => p.id === seed.people.petr), 'private profile never listed');
      assert.ok(people.some((p) => p.id === seed.people.pure && p.handle === 'pure-fixture'));
      keysOf(people, PERSON_KEYS);
    }
  });

  await t.test('company handles: active employer with company.page.edit only; existence is public, so outsiders are forbidden', async () => {
    expectError(await boris.post(`/v1/companies/${seed.companies.mixed}/handle`, { handle: 'mixed-taken' }), 403, 'access.forbidden');
    expectError(await xenia.post(`/v1/companies/${seed.companies.mixed}/handle`, { handle: 'mixed-taken' }), 403, 'access.forbidden');
    expectError(await carl.post(`/v1/companies/${seed.companies.unrelated}/handle`, { handle: 'unrelated' }), 403, 'membership.permission_missing');
    expectError(await anna.post('/v1/companies/0190f3a2-1b2c-7d3e-8f40-123456789abc/handle', { handle: 'ghost-co' }), 404, 'access.not_found');
    expectError(await anna.post('/v1/companies/not-a-uuid/handle', { handle: 'ghost-co' }), 404, 'access.not_found');
    assert.equal(ok<{ handle: string }>(await anna.post(`/v1/companies/${seed.companies.mixed}/handle`, { handle: 'mixed-facades' })).handle, 'mixed-facades');
    // Non-members (signed in or not), a former member and even a member read only the public projection here.
    for (const client of [anonymous, boris, xenia, carl, anna]) {
      const response = await client.get('/v1/companies/by-handle/mixed-facades');
      noPrivateMarkers(response);
      const company = ok<{ item: Company; redirect: boolean }>(response);
      assert.equal(company.item.id, seed.companies.mixed);
      assert.deepEqual(Object.keys(company.item).sort(), COMPANY_KEYS);
    }
    expectError(await anonymous.get('/v1/companies/by-handle/admin'), 404, 'access.not_found');
    expectError(await anonymous.get('/v1/companies/by-handle/no-such-company'), 404, 'access.not_found');
  });

  let mixedPublic = '';
  let mixedPrivate = '';
  await t.test('project handles: the owner party only (company projects need company.publish); private handles stay private', async () => {
    assert.equal(ok<{ handle: string }>(await petr.post(`/v1/projects/${seed.project}/handle`, { handle: 'petr-house' })).handle, 'petr-house');
    expectError(await anna.post(`/v1/projects/${seed.project}/handle`, { handle: 'stolen-house' }), 404, 'access.not_found');
    expectError(await carl.post(`/v1/projects/${seed.project}/handle`, { handle: 'stolen-house' }), 404, 'access.not_found');
    // Boris acts for the supplier company, a live participant: the project is visible but its URL is not his to change.
    expectError(await boris.post(`/v1/projects/${seed.project}/handle`, { handle: 'stolen-house' }), 403, 'access.forbidden');
    mixedPrivate = ok<{ id: string }>(await anna.post('/v1/projects', { owner: { kind: 'company', id: seed.companies.mixed }, name: 'Facade retrofit (private)', summary: null, leaderPersonId: null }), 201).id;
    mixedPublic = ok<{ id: string }>(await anna.post('/v1/projects', { owner: { kind: 'company', id: seed.companies.mixed }, name: 'Facade retrofit (public)', summary: 'Public summary', leaderPersonId: null }), 201).id;
    await withMaintenance(admin, (trx) => trx.updateTable('project').set({ publicity_enabled: true, published_story: 'Published story', private_notes: 'owner_private' }).where('id', '=', mixedPublic).execute());
    expectError(await anna.post(`/v1/projects/${mixedPublic}/handle`, { handle: 'facade-retrofit' }), 403, 'membership.permission_missing');
    await withMaintenance(admin, (trx) => trx.insertInto('directory_handle').values({ kind: 'project', handle: 'facade-retrofit', subject_id: mixedPublic, assigned_by: seed.people.anna }).execute());
    await withMaintenance(admin, (trx) => trx.insertInto('directory_handle').values({ kind: 'project', handle: 'facade-secret', subject_id: mixedPrivate, assigned_by: seed.people.anna }).execute());

    for (const client of [anonymous, carl, pure, xenia]) {
      expectError(await client.get('/v1/handles/project/petr-house'), 404, 'access.not_found');
      expectError(await client.get('/v1/handles/project/facade-secret'), 404, 'access.not_found');
      expectError(await client.get('/v1/projects/by-handle/petr-house'), 404, 'access.not_found');
    }
    assert.equal(ok<{ id: string }>(await petr.get('/v1/handles/project/petr-house')).id, seed.project, 'the owner resolves a private project');
    assert.equal(ok<{ id: string }>(await boris.get('/v1/handles/project/petr-house')).id, seed.project, 'a live participant resolves it too');
    expectError(await petr.get('/v1/projects/by-handle/petr-house'), 404, 'access.not_found');
    const pub = await anonymous.get('/v1/projects/by-handle/facade-retrofit');
    noPrivateMarkers(pub);
    const item = ok<{ item: Record<string, unknown>; redirect: boolean }>(pub).item;
    assert.deepEqual(Object.keys(item).sort(), PROJECT_KEYS);
    assert.equal(item.publishedStory, 'Published story');
    expectError(await xenia.get('/v1/projects/by-handle/facade-secret'), 404, 'access.not_found');
  });

  await t.test('directories list only public projections, identically for every caller, with no private fields', async () => {
    for (const client of [anonymous, petr, anna, boris, xenia]) {
      const projects = await walk<{ id: string }>(client, '/v1/projects', 1);
      assert.deepEqual(projects.map((p) => p.id), [mixedPublic], 'only the published project, for owners too');
      keysOf(projects, PROJECT_KEYS);
      const companies = await walk<Company>(client, '/v1/companies', 2);
      keysOf(companies, COMPANY_KEYS);
      assert.ok(companies.some((c) => c.id === roofing.id && c.handle === 'fixture-roofing'));
      assert.ok(companies.some((c) => c.id === seed.companies.mixed && c.handle === 'mixed-facades'));
      for (const path of ['/v1/projects?limit=100', '/v1/companies?limit=100', '/v1/people?limit=100']) noPrivateMarkers(await client.get(path));
    }
    const anonymousCompanies = await walk<Company>(anonymous, '/v1/companies', 100);
    const annaCompanies = await walk<Company>(anna, '/v1/companies', 3);
    assert.deepEqual(annaCompanies, anonymousCompanies, 'page size and caller never change the directory content or order');
    const all = await walk<Company>(anonymous, '/v1/companies', 100);
    assert.equal(all.length, await count('SELECT count(*)::int AS n FROM trustwork.company'));
  });

  await t.test('GET /v1/me/projects: own, employer (with company.deals.manage) and participations; never other private projects', async () => {
    expectError(await anonymous.get('/v1/me/projects'), 401, 'auth.session_invalid');
    const petrs = ok<Page<MyProject>>(await petr.get('/v1/me/projects'));
    assert.deepEqual(petrs.items.map((p) => [p.id, p.relation, p.handle]), [[seed.project, 'owner', 'petr-house']]);
    keysOf(petrs.items, MY_PROJECT_KEYS);
    const annas = await walk<MyProject>(anna, '/v1/me/projects', 1);
    assert.deepEqual(new Set(annas.map((p) => p.id)), new Set([mixedPublic, mixedPrivate]));
    assert.ok(annas.every((p) => p.relation === 'owner' && p.owner.id === seed.companies.mixed));
    const boriss = ok<Page<MyProject>>(await boris.get('/v1/me/projects'));
    assert.deepEqual(boriss.items.map((p) => [p.id, p.relation]), [[seed.project, 'participant']], 'the supplier participation');
    // Carl administers "unrelated" but lacks company.deals.manage: the company's private project is not his to list.
    const unrelatedProject = await withMaintenance(admin, (trx) => trx.insertInto('project').values({ owner_company_id: seed.companies.unrelated, creator_person_id: seed.people.carl, name: 'Unrelated private', summary: null, private_notes: 'owner_private' }).returning('id').executeTakeFirstOrThrow());
    assert.deepEqual(ok<Page<MyProject>>(await carl.get('/v1/me/projects')).items, []);
    for (const client of [xenia, pure]) assert.deepEqual(ok<Page<MyProject>>(await client.get('/v1/me/projects')).items, [], 'former members and unrelated people see nothing');
    for (const client of [petr, anna, boris, carl]) noPrivateMarkers(await client.get('/v1/me/projects?limit=100'));
    assert.ok(unrelatedProject.id);
  });

  await t.test('pagination input: malformed or foreign cursors and limits are rejected; a cursor never widens a list', async () => {
    expectError(await anonymous.get('/v1/companies?limit=0'), 422, 'validation.schema');
    expectError(await anonymous.get('/v1/companies?limit=101'), 422, 'validation.schema');
    expectError(await anonymous.get('/v1/companies?sort=name'), 422, 'validation.unknown_field');
    expectError(await anonymous.get('/v1/companies?cursor=AAAA'), 422, 'validation.schema');
    // A cursor issued by "my projects" (a private project position) positions the public list but reveals nothing.
    const mine = ok<Page<MyProject>>(await anna.get('/v1/me/projects?limit=1'));
    assert.ok(mine.nextCursor);
    const reused = ok<Page<{ id: string }>>(await anonymous.get(`/v1/projects?limit=100&cursor=${mine.nextCursor}`));
    assert.ok(reused.items.every((p) => p.id === mixedPublic));
  });

  await t.test('handle limit: ten lifetime handles per subject stop squatting by renaming; reclaiming stays possible', async () => {
    for (let i = 1; i <= 7; i++) ok(await pure.post('/v1/me/handle', { handle: `pure-step-${i}` }));
    const history = await count("SELECT count(*)::int AS n FROM trustwork.directory_handle WHERE kind = 'person' AND subject_id = $1", [seed.people.pure]);
    assert.equal(history, 9);
    ok(await pure.post('/v1/me/handle', { handle: 'pure-step-8' }));
    const limited = await pure.post('/v1/me/handle', { handle: 'pure-step-9' });
    expectError(limited, 422, 'validation.schema');
    assert.equal((limited.body as { details: { reason: string } }).details.reason, 'handle_limit');
    assert.equal(ok<{ handle: string }>(await pure.post('/v1/me/handle', { handle: 'pure-builder' })).handle, 'pure-builder');
    assert.equal(body<{ redirect: boolean }>(await anonymous.get('/v1/people/by-handle/pure-step-3')).redirect, true);
  });

  await t.test('BE-002: a public person without a display name is listed with displayName null and nothing private', async () => {
    const id = await withMaintenance(admin, async (trx) => (await trx.insertInto('person').values({ display_name: null, profile_visibility: 'public' }).returning('id').executeTakeFirstOrThrow()).id);
    const people = await walk<{ id: string; displayName: string | null }>(anonymous, '/v1/people', 100);
    keysOf(people, PERSON_KEYS);
    const nameless = people.find((p) => p.id === id);
    assert.ok(nameless, 'listed like any public profile');
    assert.equal(nameless.displayName, null, 'no name is invented; clients render personPage.unnamed');
    noPrivateMarkers(await anonymous.get('/v1/people?limit=100'));
  });
});

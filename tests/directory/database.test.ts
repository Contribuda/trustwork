import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { createPool, withMaintenance, withPrincipal, type DataPool, type Principal } from '@trustwork/data';
import { RESERVED_HANDLES } from '../../packages/contracts/src/directory.js';
import { directory, type DirectoryPage, type DirectoryPosition } from '../../packages/data/src/repositories/directory.js';
import { provisionTestDatabase, SKIP_REASON, sqlState } from '../data/helpers/postgres.js';
import { consentPublicProfiles, principalFor, seedFixtures, type Seed } from '../data/helpers/seed.js';

const db = await provisionTestDatabase('directory_db');

interface PgError { code?: string; hint?: string; constraint?: string; message?: string }
const settle = async (promise: Promise<unknown>): Promise<PgError | null> => promise.then(() => null, (e: unknown) => e as PgError);

test('directory persistence: handle permanence, definer authority, RLS visibility and concurrency under the runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const seed: Seed = await seedFixtures(db.admin);
  const runtime: DataPool = createPool({ ...db.appConfig, max: 16 });
  // The runtime pool must end before the test database is dropped (FORCE terminates idle connections).
  t.after(async () => { await runtime.end(); await db.close(); });
  const principal = (personId: string) => principalFor(db.admin, personId);
  const as = async <T>(personId: string, fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(runtime, await principal(personId), fn);
  const rejects = async (promise: Promise<unknown>, state: string, hint?: string) => {
    const error = await settle(promise);
    assert.ok(error, 'expected a rejection');
    assert.equal(sqlState(error), state, `${error?.message} (hint ${error?.hint})`);
    if (hint) assert.equal(error?.hint, hint, error?.message);
  };
  const newPeople = async (n: number, visibility: 'private' | 'public' = 'private'): Promise<string[]> => withMaintenance(db.admin, async (trx) => {
    const rows = await trx.insertInto('person').values(Array.from({ length: n }, (_, i) => ({ display_name: `Synthetic Person ${i}`, profile_visibility: visibility }))).returning('id').execute();
    if (visibility === 'public') await consentPublicProfiles(trx, rows.map((r) => r.id));
    return rows.map((r) => r.id);
  });

  await t.test('the runtime role cannot write handles or companies directly, nor call the internal assigner', async () => {
    const petr: Principal = await principal(seed.people.petr);
    await rejects(withPrincipal(runtime, petr, (trx) => trx.insertInto('directory_handle').values({ kind: 'person', handle: 'direct-write', subject_id: petr.personId, assigned_by: petr.personId }).execute()), '42501');
    await rejects(withPrincipal(runtime, petr, (trx) => trx.updateTable('directory_handle').set({ retired_at: null }).execute()), '42501');
    await rejects(withPrincipal(runtime, petr, (trx) => trx.deleteFrom('directory_handle').execute()), '42501');
    await rejects(withPrincipal(runtime, petr, (trx) => trx.insertInto('company').values({ display_name: 'Self Verified', claim_status: 'verified' }).execute()), '42501');
    await rejects(withPrincipal(runtime, petr, (trx) => sql`SELECT trustwork.directory_assign_handle('person', ${petr.personId}::uuid, 'sneaky-handle', ${petr.personId}::uuid)`.execute(trx)), '42501');
    await rejects(runtime.query("SELECT trustwork.directory_set_handle('person', $1::uuid, 'no-identity')", [petr.personId]), '28000');
    await rejects(runtime.query("SELECT * FROM trustwork.directory_create_company('No Identity', NULL, NULL)"), '28000');
  });

  await t.test('handles are permanent for every role: never deleted, never re-pointed to another subject', async () => {
    await as(seed.people.petr, (trx) => directory.setHandle(trx, 'person', seed.people.petr, 'petr-permanent'));
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('directory_handle').set({ subject_id: seed.people.anna }).where('handle', '=', 'petr-permanent').execute()), '23000', 'directory.handle_permanent');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('directory_handle').where('handle', '=', 'petr-permanent').execute()), '23000', 'directory.handle_permanent');
    await rejects(as(seed.people.anna, (trx) => directory.setHandle(trx, 'person', seed.people.anna, 'petr-permanent')), '23505', 'directory.handle_unavailable');
    // Unique per kind: the same text may name a company and a person.
    const hold = await withMaintenance(db.admin, (trx) => trx.insertInto('directory_handle').values({ kind: 'company', handle: 'petr-permanent', subject_id: seed.companies.unrelated, assigned_by: seed.people.carl }).returning('kind').executeTakeFirstOrThrow());
    assert.equal(hold.kind, 'company');
  });

  await t.test('database format and reserved list match the contract', async () => {
    for (const word of RESERVED_HANDLES) {
      await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('directory_handle').values({ kind: 'project', handle: word, subject_id: seed.project, assigned_by: seed.people.petr }).execute()), '23514');
      await rejects(as(seed.people.petr, (trx) => directory.setHandle(trx, 'person', seed.people.petr, word)), '22023', 'directory.handle_invalid');
    }
    for (const bad of ['ab', 'a'.repeat(41), 'Upper', 'a--b', '-ab', 'ab-', 'a_b', '12345', '0190f3a2-1b2c-7d3e-8f40-123456789abc']) {
      await rejects(as(seed.people.petr, (trx) => directory.setHandle(trx, 'person', seed.people.petr, bad)), '22023', 'directory.handle_invalid');
    }
    const { rows } = await db.admin.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'directory_handle_not_reserved'");
    const words = [...(rows[0]?.def ?? '').matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]);
    assert.deepEqual([...words].sort(), [...RESERVED_HANDLES].sort(), 'the database check lists exactly the contract words');
  });

  await t.test('definer authority mirrors the policy: own person, employer with page.edit, owner party (company.publish) for projects', async () => {
    await rejects(as(seed.people.anna, (trx) => directory.setHandle(trx, 'person', seed.people.petr, 'not-annas')), '42501', 'directory.not_authorised');
    await rejects(as(seed.people.boris, (trx) => directory.setHandle(trx, 'company', seed.companies.mixed, 'not-boriss')), '42501', 'directory.not_authorised');
    await rejects(as(seed.people.xenia, (trx) => directory.setHandle(trx, 'company', seed.companies.mixed, 'former-member')), '42501', 'directory.not_authorised');
    await rejects(as(seed.people.carl, (trx) => directory.setHandle(trx, 'company', seed.companies.unrelated, 'no-page-edit')), '42501', 'membership.permission_missing');
    await rejects(as(seed.people.carl, (trx) => directory.setHandle(trx, 'company', '0190f3a2-1b2c-7d3e-8f40-123456789abc', 'ghost-company')), '42501', 'directory.not_found');
    assert.equal(await as(seed.people.anna, (trx) => directory.setHandle(trx, 'company', seed.companies.mixed, 'mixed-co')), 'mixed-co');
    // Project: not the owner (person-owned), unrelated to a company-owned project whose owner_person_id is NULL.
    await rejects(as(seed.people.anna, (trx) => directory.setHandle(trx, 'project', seed.project, 'not-annas-house')), '42501', 'directory.not_authorised');
    const companyProject = await withMaintenance(db.admin, (trx) => trx.insertInto('project').values({ owner_company_id: seed.companies.supplier, creator_person_id: seed.people.boris, name: 'Supplier project' }).returning('id').executeTakeFirstOrThrow());
    await rejects(as(seed.people.petr, (trx) => directory.setHandle(trx, 'project', companyProject.id, 'null-owner-gap')), '42501', 'directory.not_authorised');
    await rejects(as(seed.people.boris, (trx) => directory.setHandle(trx, 'project', companyProject.id, 'needs-publish')), '42501', 'directory.not_authorised');
    await withMaintenance(db.admin, (trx) => trx.updateTable('membership').set({ permissions: ['company.deals.manage', 'company.members.manage', 'company.publish'] }).where('id', '=', seed.memberships.boris).execute());
    assert.equal(await as(seed.people.boris, (trx) => directory.setHandle(trx, 'project', companyProject.id, 'supplier-project')), 'supplier-project');
    assert.equal(await as(seed.people.petr, (trx) => directory.setHandle(trx, 'project', seed.project, 'petr-house')), 'petr-house');
  });

  await t.test('RLS: a handle is visible exactly when its subject is visible to the caller', async () => {
    await as(seed.people.pure, (trx) => directory.setHandle(trx, 'person', seed.people.pure, 'pure-public'));
    const anonymous = await runtime.query<{ kind: string; handle: string }>('SELECT kind, handle FROM trustwork.directory_handle ORDER BY kind, handle');
    assert.ok(anonymous.rows.every((r) => r.kind === 'company'), `no identity: company handles only, got ${JSON.stringify(anonymous.rows)}`);
    const visible = async (personId: string) => (await as(personId, (trx) => trx.selectFrom('directory_handle').select(['kind', 'handle']).execute())).map((r) => `${r.kind}:${r.handle}`);
    const carl = await visible(seed.people.carl);
    assert.ok(carl.includes('person:pure-public'), 'public profile handle');
    assert.ok(!carl.includes('person:petr-permanent'), 'private profile handle hidden');
    assert.ok(!carl.includes('project:petr-house'), 'private project handle hidden');
    assert.ok(!carl.includes('project:supplier-project'), 'company-private project handle hidden from outsiders');
    const petr = await visible(seed.people.petr);
    assert.ok(petr.includes('person:petr-permanent') && petr.includes('project:petr-house'), 'own subjects');
    const boris = await visible(seed.people.boris);
    assert.ok(boris.includes('project:petr-house'), 'a live participant (supplier company) sees the project and its handle');
    assert.equal(await as(seed.people.carl, (trx) => directory.resolve(trx, 'project', 'petr-house')), undefined);
    assert.equal((await withMaintenance(db.admin, (trx) => directory.publicResolve(trx, 'project', 'petr-house'))), undefined, 'public resolution ignores private projects even for the owner role');
  });

  await t.test('concurrency: one winner when many subjects claim the same handle at once', async () => {
    const people = await newPeople(12);
    const results = await Promise.all(people.map((id) => settle(as(id, (trx) => directory.setHandle(trx, 'person', id, 'contested-handle')))));
    const winners = results.filter((r) => r === null).length;
    assert.equal(winners, 1, JSON.stringify(results.map((r) => r?.hint ?? 'ok')));
    for (const r of results) if (r) assert.equal(r.hint, 'directory.handle_unavailable');
    const rows = await withMaintenance(db.admin, (trx) => trx.selectFrom('directory_handle').selectAll().where('kind', '=', 'person').where('handle', '=', 'contested-handle').execute());
    assert.equal(rows.length, 1);
  });

  await t.test('concurrency: one subject renaming in parallel keeps exactly one current handle and every former one as a redirect', async () => {
    const [person] = await newPeople(1);
    const names = ['race-a', 'race-b', 'race-c', 'race-d', 'race-e', 'race-f'];
    const results = await Promise.all(names.map((handle) => settle(as(person as string, (trx) => directory.setHandle(trx, 'person', person as string, handle)))));
    assert.deepEqual(results, names.map(() => null));
    const rows = await withMaintenance(db.admin, (trx) => trx.selectFrom('directory_handle').selectAll().where('kind', '=', 'person').where('subject_id', '=', person as string).execute());
    assert.equal(rows.length, names.length);
    assert.equal(rows.filter((r) => r.retired_at === null).length, 1);
    for (const name of names) {
      const resolved: { subject_id: string } | undefined = await withMaintenance(db.admin, (trx) => directory.resolve(trx, 'person', name));
      assert.equal(resolved?.subject_id, person);
    }
  });

  await t.test('concurrency: parallel company creation by one person yields one company with one administrator and no orphans', async () => {
    const [founder] = await newPeople(1);
    const before = Number((await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.company')).rows[0]?.n);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => settle(as(founder as string, (trx) => directory.createCompany(trx, { name: `Parallel ${i}`, publicDescription: null, handle: `parallel-${i}` })))));
    assert.equal(results.filter((r) => r === null).length, 1);
    // A loser either hits the one-active-employer index or, when the winner committed first, fails closed on the
    // bumped authorization epoch (the API re-resolves the principal and then answers membership.already_employed).
    for (const r of results) if (r) assert.ok(r.constraint === 'membership_one_active_employer' || r.code === 'access.stale_epoch', `${r.code} ${r.message}`);
    const after = Number((await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.company')).rows[0]?.n);
    assert.equal(after, before + 1);
    const handles = await withMaintenance(db.admin, (trx) => trx.selectFrom('directory_handle').select('handle').where('kind', '=', 'company').where('handle', 'like', 'parallel-%').execute());
    assert.equal(handles.length, 1, 'the losers left no handle behind');
    const admins = await withMaintenance(db.admin, (trx) => trx.selectFrom('membership').selectAll().where('person_id', '=', founder as string).execute());
    assert.equal(admins.length, 1);
    assert.equal(admins[0]?.role, 'administrator');
  });

  await t.test('pagination is stable under concurrent inserts: every existing item exactly once, in strict keyset order', async () => {
    const owner = seed.people.petr;
    // 240 published projects spread over two days, then paging (page size 17) while other transactions insert 160
    // more with created_at inside and after the range already paged.
    const base = Date.parse('2026-10-01T00:00:00Z');
    const original = await withMaintenance(db.admin, async (trx) => (await trx.insertInto('project').values(Array.from({ length: 240 }, (_, i) => ({
      owner_person_id: owner, creator_person_id: owner, name: `Stable ${i}`, publicity_enabled: true, published_story: 'Story',
      created_at: new Date(base + (i % 120) * 1_000 + (i < 120 ? 0 : 500)).toISOString(),
    }))).returning('id').execute()).map((r) => r.id));
    for (const path of ['runtime', 'anonymous'] as const) {
      const seen: { id: string; key: string }[] = [];
      let after: DirectoryPosition | null = null;
      let inserted = 0;
      for (let i = 0; i < 100; i++) {
        const page: DirectoryPage = { after, limit: 17 };
        const [rows] = await Promise.all([
          path === 'runtime' ? as(seed.people.carl, (trx) => directory.listProjects(trx, page)) : withMaintenance(db.admin, (trx) => directory.publicProjects(trx, page)),
          withMaintenance(db.admin, (trx) => trx.insertInto('project').values(Array.from({ length: 8 }, (_, j) => ({
            owner_person_id: owner, creator_person_id: owner, name: `Concurrent ${path} ${i}-${j}`, publicity_enabled: true,
            created_at: new Date(base + Math.floor(Math.random() * 200_000)).toISOString(),
          }))).execute()).then(() => { inserted += 8; }),
        ]);
        for (const row of rows) seen.push({ id: row.id, key: row.sort_key });
        if (rows.length < 17) break;
        const last = rows.at(-1) as { id: string; sort_key: string };
        after = { createdAt: last.sort_key, id: last.id };
      }
      assert.ok(inserted >= 80, 'inserts really ran concurrently with paging');
      const ids = seen.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, `${path}: no duplicates`);
      for (const id of original) assert.ok(ids.includes(id), `${path}: original ${id} not skipped`);
      for (let i = 1; i < seen.length; i++) {
        const a = seen[i - 1] as { id: string; key: string };
        const b = seen[i] as { id: string; key: string };
        assert.ok(a.key > b.key || (a.key === b.key && a.id > b.id), `${path}: strict (created_at, id) descending at ${i}`);
      }
    }
  });
});

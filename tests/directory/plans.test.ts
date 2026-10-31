import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CompiledQuery, sql, type Compilable } from 'kysely';
import { createPool, withMaintenance, withPrincipal, bindTransaction, type DataPool, type Transaction } from '@trustwork/data';
import { directoryQueries, type DirectoryPage, type DirectoryPosition } from '../../packages/data/src/repositories/directory.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { principalFor } from '../data/helpers/seed.js';

/**
 * Acceptance: list queries use index scans on 100,000 synthetic rows under the runtime role. Every runtime query is
 * EXPLAINed exactly as the repository builds it, inside a `withPrincipal` transaction of a login role that is a member
 * of trustwork_app (RLS active); the owner-run anonymous functions are observed with auto_explain (nested statements),
 * called by the same runtime login.
 */
const ROWS = 100_000;
const BIG = new Set(['person', 'company', 'project', 'object_participation', 'directory_handle']);
const db = await provisionTestDatabase('directory_plans');

interface PlanNode { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] }
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}
/** Each expected entry is an index name or a list of acceptable alternatives (the planner may pick either). */
function assertIndexed(label: string, plan: PlanNode, expectedIndexes: readonly (string | readonly string[])[]): void {
  const all = nodes(plan);
  const seq = all.filter((n) => n['Node Type'] === 'Seq Scan' && BIG.has(n['Relation Name'] ?? ''));
  assert.deepEqual(seq.map((n) => n['Relation Name']), [], `${label}: no sequential scan of a large table\n${JSON.stringify(plan, null, 1).slice(0, 4000)}`);
  const used = all.filter((n) => /Index/.test(n['Node Type'])).map((n) => n['Index Name']);
  console.log(`[directory-plans] ${label}: ${[...new Set(used)].join(', ')}`);
  for (const index of expectedIndexes) {
    const options = typeof index === 'string' ? [index] : index;
    assert.ok(options.some((o) => used.includes(o)), `${label}: expected ${options.join(' or ')}, used ${used.join(', ')}`);
  }
}
async function explain(trx: Transaction, query: Compilable | { compile(): CompiledQuery }): Promise<PlanNode> {
  const compiled = query.compile();
  const result = await trx.executeQuery<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(CompiledQuery.raw(`EXPLAIN (FORMAT JSON) ${compiled.sql}`, [...compiled.parameters]));
  return (result.rows[0] as { 'QUERY PLAN': [{ Plan: PlanNode }] })['QUERY PLAN'][0].Plan;
}

test('directory list queries use index scans on 100,000 synthetic rows under the runtime role', { skip: db ? false : SKIP_REASON, timeout: 600_000 }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });

  // Synthetic data only (no real people or companies): 100k people (10% public), 100k companies, 100k projects
  // (10% published, 20% company-owned), 20k participations and 90k handles.
  const ids = await withMaintenance(db.admin, async (trx) => {
    await sql`INSERT INTO trustwork.person (display_name, profile_visibility, created_at)
      SELECT 'Synthetic Person ' || g, CASE WHEN g % 10 = 0 THEN 'public' ELSE 'private' END, timestamptz '2026-01-01 00:00:00Z' + g * interval '7 seconds'
      FROM generate_series(1, ${ROWS}::int) g`.execute(trx);
    await sql`INSERT INTO trustwork.company (display_name, created_at)
      SELECT 'Synthetic Company ' || g, timestamptz '2026-01-01 00:00:00Z' + g * interval '7 seconds' FROM generate_series(1, ${ROWS}::int) g`.execute(trx);
    await sql`CREATE TEMP TABLE syn_person ON COMMIT DROP AS SELECT id, row_number() OVER (ORDER BY created_at) AS rn FROM trustwork.person WHERE display_name LIKE 'Synthetic Person %'`.execute(trx);
    await sql`CREATE TEMP TABLE syn_company ON COMMIT DROP AS SELECT id, row_number() OVER (ORDER BY created_at) AS rn FROM trustwork.company WHERE display_name LIKE 'Synthetic Company %'`.execute(trx);
    await sql`INSERT INTO trustwork.project (owner_person_id, owner_company_id, creator_person_id, name, publicity_enabled, published_story, private_notes, created_at)
      SELECT CASE WHEN g % 5 = 0 THEN NULL ELSE p.id END, CASE WHEN g % 5 = 0 THEN c.id END, p.id, 'Synthetic Project ' || g, g % 10 = 1,
             CASE WHEN g % 10 = 1 THEN 'Story' END, 'synthetic private note', timestamptz '2026-01-01 00:00:00Z' + g * interval '7 seconds'
      FROM generate_series(1, ${ROWS}::int) g JOIN syn_person p ON p.rn = (g % 40000) + 1 JOIN syn_company c ON c.rn = CASE WHEN g % 50 = 0 THEN 1 ELSE (g % 2000) + 1 END`.execute(trx);
    await sql`CREATE TEMP TABLE syn_project ON COMMIT DROP AS SELECT id, row_number() OVER (ORDER BY created_at) AS rn FROM trustwork.project WHERE name LIKE 'Synthetic Project %'`.execute(trx);
    await sql`INSERT INTO trustwork.object_participation (resource_kind, resource_id, party_person_id, side, capabilities, audience, granted_by_person_id)
      SELECT 'project', pr.id, p.id, 'participant', ARRAY['read.shared'], 'shared_party', p.id
      FROM generate_series(1, 20000) g JOIN syn_project pr ON pr.rn = g * 5 JOIN syn_person p ON p.rn = (g % 30000) + 50001`.execute(trx);
    await sql`INSERT INTO trustwork.directory_handle (kind, handle, subject_id, assigned_by)
      SELECT 'person', 'syn-person-' || rn, id, id FROM syn_person WHERE rn <= 30000`.execute(trx);
    await sql`INSERT INTO trustwork.directory_handle (kind, handle, subject_id, assigned_by)
      SELECT 'company', 'syn-company-' || c.rn, c.id, p.id FROM syn_company c JOIN syn_person p ON p.rn = 1 WHERE c.rn <= 30000`.execute(trx);
    await sql`INSERT INTO trustwork.directory_handle (kind, handle, subject_id, assigned_by)
      SELECT 'project', 'syn-project-' || pr.rn, pr.id, p.id FROM syn_project pr JOIN syn_person p ON p.rn = 1 WHERE pr.rn <= 30000`.execute(trx);
    // The principal: owns projects, participates in others, and is employed with company.deals.manage by a company
    // that owns 2,000 projects (so keyset seeks matter for the employer branch).
    const me = (await sql<{ id: string }>`SELECT id FROM syn_person WHERE rn = 1`.execute(trx)).rows[0]?.id as string;
    const employer = (await sql<{ id: string }>`SELECT id FROM syn_company WHERE rn = 1`.execute(trx)).rows[0]?.id as string;
    await trx.insertInto('membership').values({ person_id: me, company_id: employer, role: 'administrator', permissions: ['company.deals.manage'], status: 'active', valid_from: new Date('2026-01-01T00:00:00Z') }).execute();
    await sql`INSERT INTO trustwork.object_participation (resource_kind, resource_id, party_person_id, side, capabilities, audience, granted_by_person_id)
      SELECT 'project', pr.id, ${me}::uuid, 'participant', ARRAY['read.shared'], 'shared_party', ${me}::uuid FROM syn_project pr WHERE pr.rn BETWEEN 50000 AND 50040`.execute(trx);
    const middle = (await sql<{ key: string; id: string }>`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key, id FROM trustwork.person WHERE display_name = 'Synthetic Person 50000'`.execute(trx)).rows[0];
    return { me, employer, middle: { createdAt: middle?.key as string, id: middle?.id as string } satisfies DirectoryPosition };
  });
  for (const table of ['person', 'company', 'project', 'object_participation', 'directory_handle', 'membership']) await db.admin.query(`ANALYZE trustwork.${table}`);
  const counts = (await db.admin.query<{ people: number; companies: number; projects: number }>('SELECT (SELECT count(*) FROM trustwork.person)::int AS people, (SELECT count(*) FROM trustwork.company)::int AS companies, (SELECT count(*) FROM trustwork.project)::int AS projects')).rows[0];
  assert.ok((counts?.people ?? 0) >= ROWS && (counts?.companies ?? 0) >= ROWS && (counts?.projects ?? 0) >= ROWS, JSON.stringify(counts));

  const principal = await principalFor(db.admin, ids.me);
  const first: DirectoryPage = { after: null, limit: 21 };
  const deep: DirectoryPage = { after: ids.middle, limit: 21 };

  await t.test('signed-in directories (RLS on): first and deep pages seek the partial keyset indexes', async () => {
    await withPrincipal(runtime, principal, async (trx) => {
      const role = (await sql<{ user: string; member: boolean }>`SELECT current_user AS user, pg_has_role(current_user, 'trustwork_app', 'MEMBER') AS member`.execute(trx)).rows[0];
      assert.deepEqual(role, { user: db.appLoginRole, member: true }, 'EXPLAIN runs as the runtime login');
      for (const [label, page] of [['first', first], ['deep', deep]] as const) {
        assertIndexed(`people ${label}`, await explain(trx, directoryQueries.people(trx, page)), ['directory_person_public_idx']);
        assertIndexed(`companies ${label}`, await explain(trx, directoryQueries.companies(trx, page)), ['directory_company_idx']);
        assertIndexed(`projects ${label}`, await explain(trx, directoryQueries.projects(trx, page)), ['directory_project_public_idx']);
      }
      for (const id of [ids.me, ids.employer]) {
        assertIndexed('person by id', await explain(trx, directoryQueries.people(trx, first, id)), []);
        assertIndexed('company by id', await explain(trx, directoryQueries.companies(trx, first, id)), []);
      }
      assertIndexed('handle resolution', await explain(trx, trx.selectFrom('directory_handle as h')
        .innerJoin('directory_handle as c', (j) => j.onRef('c.kind', '=', 'h.kind').onRef('c.subject_id', '=', 'h.subject_id').on('c.retired_at', 'is', null))
        .select(['h.subject_id', 'c.handle as current_handle']).where('h.kind', '=', 'company').where('h.handle', '=', 'syn-company-777')), ['directory_handle_pkey']);
    });
  });

  await t.test('my projects (own, employer, participations) seek the owner and participation indexes', async () => {
    await withPrincipal(runtime, principal, async (trx) => {
      const query = { compile: () => directoryQueries.myProjects(ids.me, ids.employer, first).compile(trx) };
      assertIndexed('my projects', await explain(trx, query), [
        ['directory_project_owner_person_idx', 'project_owner_person_idx'],
        'directory_project_owner_company_idx',
        ['participation_person_idx', 'participation_one_live_per_person'],
      ]);
      const deepQuery = { compile: () => directoryQueries.myProjects(ids.me, ids.employer, { after: ids.middle, limit: 21 }).compile(trx) };
      assertIndexed('my projects deep', await explain(trx, deepQuery), ['directory_project_owner_company_idx']);
      const rows = await directoryQueries.myProjects(ids.me, ids.employer, { after: null, limit: 101 }).execute(trx);
      assert.ok(rows.rows.length > 50, `owned, employer and participated projects are listed (${rows.rows.length})`);
    });
  });

  await t.test('anonymous company directory (no identity, runtime role) seeks the keyset index', async () => {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      const trx = bindTransaction(client);
      assertIndexed('anonymous companies first', await explain(trx, directoryQueries.companies(trx, first)), ['directory_company_idx']);
      assertIndexed('anonymous companies deep', await explain(trx, directoryQueries.companies(trx, deep)), ['directory_company_idx']);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await t.test('anonymous people and projects: the owner-run functions seek the same indexes (auto_explain, nested statements)', async (st) => {
    const client = new pg.Client(db.adminConfig);
    await client.connect();
    try {
      try {
        await client.query("LOAD 'auto_explain'");
      } catch (error) {
        st.skip(`auto_explain not available on this server: ${(error as Error).message}`);
        return;
      }
      const notices: string[] = [];
      client.on('notice', (notice) => notices.push(notice.message ?? ''));
      await client.query("SET auto_explain.log_min_duration = 0; SET auto_explain.log_nested_statements = on; SET auto_explain.log_format = 'json'; SET auto_explain.log_level = 'notice'");
      await client.query(`SET ROLE ${db.appLoginRole}`);
      assert.equal((await client.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u, db.appLoginRole);
      const plans = async (call: string, params: unknown[], marker: string): Promise<PlanNode[]> => {
        notices.length = 0;
        await client.query(call, params);
        const found = notices.filter((n) => n.includes(marker)).map((n) => (JSON.parse(n.slice(n.indexOf('{'))) as { Plan: PlanNode }).Plan);
        assert.ok(found.length > 0, `no nested plan for ${marker}: ${notices.map((n) => n.slice(0, 120)).join(' | ')}`);
        return found;
      };
      for (const [label, after] of [['first', null], ['deep', ids.middle]] as const) {
        const args = [after?.createdAt ?? null, after?.id ?? null, 21];
        for (const plan of await plans('SELECT * FROM trustwork.directory_public_people($1::timestamptz, $2::uuid, $3)', args, 'FROM trustwork.person p')) assertIndexed(`anonymous people ${label}`, plan, ['directory_person_public_idx']);
        for (const plan of await plans('SELECT * FROM trustwork.directory_public_projects($1::timestamptz, $2::uuid, $3)', args, 'FROM trustwork.project p')) assertIndexed(`anonymous projects ${label}`, plan, ['directory_project_public_idx']);
      }
      for (const plan of await plans("SELECT * FROM trustwork.directory_public_resolve('person', 'syn-person-10')", [], 'FROM trustwork.directory_handle h')) assertIndexed('anonymous resolution', plan, ['directory_handle_pkey']);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      await client.end();
    }
  });
});

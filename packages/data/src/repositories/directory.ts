import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { ClaimStatus, ProjectStatus, SourcedStatus } from '../schema/index.js';
import type { HandleKind } from '../schema/directory.js';

/**
 * Directory reads and writes (BE-003). Lists are keyset-paginated by `(created_at DESC, id DESC)` with the position as
 * a row comparison (an index condition on the partial keyset indexes), and select only public columns joined with the
 * subject's current handle. Runtime queries run under `withPrincipal` (RLS applies on every table, including the
 * handle table, whose visibility follows the subject's). Anonymous callers have no identity, so people and projects
 * are read through the owner-run `directory_public_*` functions (public columns of public rows); companies are public
 * rows readable without identity and use the same runtime query. Handle writes and company creation go only through
 * the SECURITY DEFINER commands, which re-check authority in the database.
 */

/** Exclusive keyset position: `createdAt` is the sort key with microseconds (UTC, `…T…:…:….ffffffZ`). */
export interface DirectoryPosition { createdAt: string; id: string }
export interface DirectoryPage { after: DirectoryPosition | null; limit: number }
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
/** Placeholder sort key for single reads that are never paginated. */
const EPOCH_KEY = '1970-01-01T00:00:00.000000Z';

/** Sort key text for a cursor, keeping PostgreSQL's microsecond precision (a JavaScript Date would drop it). */
function sortKey(alias: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(`${alias}.created_at`)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
/** Row comparison `(created_at, id) < (position)`; the first page compares with ('infinity', max uuid). */
function before(alias: string, after: DirectoryPosition | null): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(`${alias}.created_at`)}, ${sql.ref(`${alias}.id`)}) < (${after?.createdAt ?? 'infinity'}::timestamptz, ${after?.id ?? MAX_UUID}::uuid)`;
}

export interface PersonDirectoryRow { id: string; display_name: string; public_headline: string | null; public_expertise: string[]; handle: string | null; sort_key: string }
export interface CompanyDirectoryRow { id: string; display_name: string; sourced_status: SourcedStatus; claim_status: ClaimStatus; legal_identifiers: unknown; public_description: string | null; handle: string | null; sort_key: string }
export interface ProjectDirectoryRow { id: string; name: string; summary: string | null; status: ProjectStatus; published_story: string | null; handle: string | null; sort_key: string }
export interface MyProjectRow {
  id: string; owner_person_id: string | null; owner_company_id: string | null; creator_person_id: string; leader_person_id: string | null; name: string; summary: string | null;
  status: ProjectStatus; publicity_enabled: boolean; revision: number; created_at: Date; handle: string | null; sort_key: string;
}
export interface HandleResolutionRow { subject_id: string; current_handle: string }

/** Query builders (exported so tests can EXPLAIN exactly the SQL the API runs). `id` narrows to one subject. */
export const directoryQueries = {
  people(trx: Transaction, page: DirectoryPage, id?: string) {
    let q = trx.selectFrom('person as p')
      .leftJoin('directory_handle as h', (j) => j.on('h.kind', '=', 'person').onRef('h.subject_id', '=', 'p.id').on('h.retired_at', 'is', null))
      .select(['p.id', 'p.display_name', 'p.public_headline', 'p.public_expertise', 'h.handle', sortKey('p').as('sort_key')])
      .where('p.profile_visibility', '=', 'public')
      .where(before('p', page.after));
    if (id !== undefined) q = q.where('p.id', '=', id);
    return q.orderBy('p.created_at', 'desc').orderBy('p.id', 'desc').limit(page.limit);
  },
  companies(trx: Transaction, page: DirectoryPage, id?: string) {
    let q = trx.selectFrom('company as c')
      .leftJoin('directory_handle as h', (j) => j.on('h.kind', '=', 'company').onRef('h.subject_id', '=', 'c.id').on('h.retired_at', 'is', null))
      .select(['c.id', 'c.display_name', 'c.sourced_status', 'c.claim_status', 'c.legal_identifiers', 'c.public_description', 'h.handle', sortKey('c').as('sort_key')])
      .where(before('c', page.after));
    if (id !== undefined) q = q.where('c.id', '=', id);
    return q.orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').limit(page.limit);
  },
  projects(trx: Transaction, page: DirectoryPage, id?: string) {
    let q = trx.selectFrom('project as p')
      .leftJoin('directory_handle as h', (j) => j.on('h.kind', '=', 'project').onRef('h.subject_id', '=', 'p.id').on('h.retired_at', 'is', null))
      .select(['p.id', 'p.name', 'p.summary', 'p.status', 'p.published_story', 'h.handle', sortKey('p').as('sort_key')])
      .where('p.publicity_enabled', '=', true)
      .where(before('p', page.after));
    if (id !== undefined) q = q.where('p.id', '=', id);
    return q.orderBy('p.created_at', 'desc').orderBy('p.id', 'desc').limit(page.limit);
  },
  /**
   * Projects owned by the person, owned by the employer (pass `companyId` only when the membership may read company
   * objects) or with a live non-owner, non-staff participation of either party. Each branch seeks its own index and
   * stops at `limit`; the union is merged in keyset order. RLS on project and participation still applies.
   */
  myProjects(personId: string, companyId: string | null, page: DirectoryPage): RawBuilder<MyProjectRow> {
    const after = page.after;
    const position = sql`(${after?.createdAt ?? 'infinity'}::timestamptz, ${after?.id ?? MAX_UUID}::uuid)`;
    const company = companyId ?? null;
    return sql<MyProjectRow>`
      WITH mine AS (
        (SELECT p.id FROM trustwork.project p
          WHERE p.owner_person_id = ${personId}::uuid AND (p.created_at, p.id) < ${position}
          ORDER BY p.created_at DESC, p.id DESC LIMIT ${page.limit})
        UNION
        (SELECT p.id FROM trustwork.project p
          WHERE p.owner_company_id = ${company}::uuid AND (p.created_at, p.id) < ${position}
          ORDER BY p.created_at DESC, p.id DESC LIMIT ${page.limit})
        UNION
        (SELECT p.id FROM trustwork.object_participation op JOIN trustwork.project p ON p.id = op.resource_id
          WHERE op.resource_kind = 'project' AND op.side IN ('buyer', 'seller', 'participant') AND op.revoked_at IS NULL
            AND op.valid_from <= now() AND (op.valid_until IS NULL OR op.valid_until > now())
            AND (op.party_person_id = ${personId}::uuid OR op.party_company_id = ${company}::uuid)
            AND (p.created_at, p.id) < ${position}
          ORDER BY p.created_at DESC, p.id DESC LIMIT ${page.limit})
      )
      SELECT p.id, p.owner_person_id, p.owner_company_id, p.creator_person_id, p.leader_person_id, p.name, p.summary, p.status, p.publicity_enabled,
             p.revision, p.created_at, h.handle,
             to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key
      FROM mine JOIN trustwork.project p ON p.id = mine.id
      LEFT JOIN trustwork.directory_handle h ON h.kind = 'project' AND h.subject_id = p.id AND h.retired_at IS NULL
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${page.limit}`;
  },
};

export const directory = {
  listPeople(trx: Transaction, page: DirectoryPage): Promise<PersonDirectoryRow[]> {
    return directoryQueries.people(trx, page).execute();
  },
  listCompanies(trx: Transaction, page: DirectoryPage): Promise<CompanyDirectoryRow[]> {
    return directoryQueries.companies(trx, page).execute();
  },
  listProjects(trx: Transaction, page: DirectoryPage): Promise<ProjectDirectoryRow[]> {
    return directoryQueries.projects(trx, page).execute();
  },
  async listMyProjects(trx: Transaction, personId: string, companyId: string | null, page: DirectoryPage): Promise<MyProjectRow[]> {
    return (await directoryQueries.myProjects(personId, companyId, page).execute(trx)).rows;
  },
  person(trx: Transaction, id: string): Promise<PersonDirectoryRow | undefined> {
    return directoryQueries.people(trx, { after: null, limit: 1 }, id).executeTakeFirst();
  },
  company(trx: Transaction, id: string): Promise<CompanyDirectoryRow | undefined> {
    return directoryQueries.companies(trx, { after: null, limit: 1 }, id).executeTakeFirst();
  },
  project(trx: Transaction, id: string): Promise<ProjectDirectoryRow | undefined> {
    return directoryQueries.projects(trx, { after: null, limit: 1 }, id).executeTakeFirst();
  },

  /** Handle -> subject and its current handle, visible only when the subject is visible to the caller (RLS). */
  resolve(trx: Transaction, kind: HandleKind, handle: string): Promise<HandleResolutionRow | undefined> {
    return trx.selectFrom('directory_handle as h')
      .innerJoin('directory_handle as c', (j) => j.onRef('c.kind', '=', 'h.kind').onRef('c.subject_id', '=', 'h.subject_id').on('c.retired_at', 'is', null))
      .select(['h.subject_id', 'c.handle as current_handle'])
      .where('h.kind', '=', kind).where('h.handle', '=', handle)
      .executeTakeFirst();
  },
  /** Every handle record of a subject (current first), as visible to the caller. */
  history(trx: Transaction, kind: HandleKind, subjectId: string) {
    return trx.selectFrom('directory_handle').selectAll().where('kind', '=', kind).where('subject_id', '=', subjectId)
      .orderBy(sql`retired_at IS NOT NULL`).orderBy('assigned_at', 'desc').execute();
  },

  /** Anonymous reads (owner-run, public rows and columns only). */
  async publicPeople(trx: Transaction, page: DirectoryPage): Promise<PersonDirectoryRow[]> {
    const { rows } = await sql<PersonDirectoryRow>`SELECT * FROM trustwork.directory_public_people(${page.after?.createdAt ?? null}::timestamptz, ${page.after?.id ?? null}::uuid, ${page.limit})`.execute(trx);
    return rows;
  },
  async publicProjects(trx: Transaction, page: DirectoryPage): Promise<ProjectDirectoryRow[]> {
    const { rows } = await sql<ProjectDirectoryRow>`SELECT * FROM trustwork.directory_public_projects(${page.after?.createdAt ?? null}::timestamptz, ${page.after?.id ?? null}::uuid, ${page.limit})`.execute(trx);
    return rows;
  },
  /** One public profile through the BE-001 lookup; `handle` and `sort_key` are not part of that lookup (filled by the caller). */
  async publicPerson(trx: Transaction, id: string): Promise<PersonDirectoryRow | undefined> {
    const { rows } = await sql<Omit<PersonDirectoryRow, 'handle' | 'sort_key'>>`SELECT id, display_name, public_headline, public_expertise FROM trustwork.public_person_read(${id}::uuid)`.execute(trx);
    return rows[0] ? { ...rows[0], handle: null, sort_key: EPOCH_KEY } : undefined;
  },
  /** One published project through the BE-001 lookup. */
  async publicProject(trx: Transaction, id: string): Promise<ProjectDirectoryRow | undefined> {
    const { rows } = await sql<Omit<ProjectDirectoryRow, 'handle' | 'sort_key'>>`SELECT id, name, summary, status, published_story FROM trustwork.public_project_read(${id}::uuid)`.execute(trx);
    return rows[0] ? { ...rows[0], handle: null, sort_key: EPOCH_KEY } : undefined;
  },
  async publicResolve(trx: Transaction, kind: HandleKind, handle: string): Promise<HandleResolutionRow | undefined> {
    const { rows } = await sql<HandleResolutionRow>`SELECT * FROM trustwork.directory_public_resolve(${kind}, ${handle})`.execute(trx);
    return rows[0];
  },

  /**
   * Creates a registered, unclaimed company with the caller as its only administrator (all company permissions) and
   * the optional handle, atomically. 23505 on `membership_one_active_employer` when the caller is already employed;
   * hints `directory.handle_unavailable` / `directory.handle_invalid` for the handle.
   */
  async createCompany(trx: Transaction, input: { name: string; publicDescription: string | null; handle: string | null }): Promise<{ company_id: string; membership_id: string }> {
    const { rows } = await sql<{ company_id: string; membership_id: string }>`SELECT * FROM trustwork.directory_create_company(${input.name}, ${input.publicDescription}, ${input.handle})`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('directory_create_company returned no row');
    return row;
  },
  /**
   * Makes `handle` the subject's current handle (the previous one is retired and keeps redirecting). Raises 42501 with
   * hint `directory.not_authorised` / `directory.not_found` / `membership.permission_missing`, 23505 with
   * `directory.handle_unavailable`, 22023 with `directory.handle_invalid`, 54000 with `directory.handle_limit`.
   */
  async setHandle(trx: Transaction, kind: HandleKind, subjectId: string, handle: string): Promise<string> {
    const { rows } = await sql<{ handle: string }>`SELECT trustwork.directory_set_handle(${kind}, ${subjectId}::uuid, ${handle}) AS handle`.execute(trx);
    return rows[0]?.handle as string;
  },
};

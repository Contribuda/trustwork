import { PersonSchema, ProjectSchema, type Party, type Principal, type PublicProjectOwner } from '../../deps/contracts.js';
import { auditEvents, companies, memberships, outbox, persons, projects, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { iso, toMembership } from '../identity/serializers.js';
import {
  CompanyDirectoryPageSchema, CompanyLookupSchema, CreateCompanyResultSchema, decodeDirectoryCursor, directory, encodeDirectoryCursor, HandleAssignmentSchema, HandleResolutionSchema, HandleSchema,
  MyProjectPageSchema, PersonDirectoryPageSchema, PersonLookupSchema, ProjectDirectoryPageSchema, ProjectLookupSchema, toCompanyDirectoryEntry, toMyProject, toPersonDirectoryEntry, toProjectDirectoryEntry,
  type CompanyDirectoryEntry, type CompanyDirectoryRow, type CreateCompanyCommand, type CreateCompanyResult, type DirectoryPage, type DirectoryPageQuery, type HandleAssignment, type HandleKind,
  type HandleResolution, type MyProject, type MyProjectRow, type PersonDirectoryEntry, type PersonDirectoryRow, type ProjectDirectoryEntry, type ProjectDirectoryRow, type PublicProjectOwnerRow,
} from './deps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Page<T> = { items: T[]; nextCursor: string | null };
interface PgError { code?: string; hint?: string }

/**
 * Database hints of the directory commands -> contract codes. Handle problems are `validation.schema` with
 * `details.field = 'handle'` and a reason until the frozen error list gains a directory code (requested in the PR).
 */
function mapDirectoryError(error: unknown): unknown {
  const pg = error as PgError;
  if (!pg || typeof pg.code !== 'string' || !pg.hint) return error;
  switch (pg.hint) {
    case 'directory.handle_unavailable': return new ApiError('validation.schema', 'this handle is not available', { field: 'handle', reason: 'handle_unavailable' });
    case 'directory.handle_invalid': return new ApiError('validation.schema', 'this handle is not allowed', { field: 'handle', reason: 'handle_invalid' });
    case 'directory.handle_limit': return new ApiError('validation.schema', 'this subject has used all its handle changes', { field: 'handle', reason: 'handle_limit' });
    case 'directory.not_authorised': return new ApiError('access.forbidden');
    case 'directory.not_found': return new ApiError('access.not_found');
    default: return error;
  }
}

// Row -> contract record -> allowlist serializer of the public layer. Rows carry only public columns already; going
// through the contract serializers keeps one serializer per layer for API reads, search and exports.
function personEntry(row: PersonDirectoryRow): PersonDirectoryEntry {
  const person = PersonSchema.parse({
    id: row.id, displayName: row.display_name, profileVisibility: 'public', publicProfile: { headline: row.public_headline, expertise: row.public_expertise },
    emailBindings: [], providerIdentities: [], preferences: { buying: false, selling: false, industryParticipation: false }, revision: 1, createdAt: row.sort_key,
  });
  const entry = toPersonDirectoryEntry(person, row.handle);
  if (!entry) throw new ApiError('access.not_found');
  return entry;
}
function companyEntry(row: CompanyDirectoryRow): CompanyDirectoryEntry {
  return toCompanyDirectoryEntry({
    id: row.id, handle: row.handle, name: row.display_name, origin: row.sourced_status, claimStatus: row.claim_status,
    legalIdentifiers: row.legal_identifiers as CompanyDirectoryEntry['legalIdentifiers'], publicDescription: row.public_description,
  });
}
/** Public owner row -> contract (QA-002 D2): only the public name and the current handle. */
export function toPublicOwner(row: PublicProjectOwnerRow): PublicProjectOwner {
  return row.owner_kind === 'company'
    ? { kind: 'company', id: row.owner_id, name: row.owner_name ?? '', handle: row.owner_handle }
    : { kind: 'person', id: row.owner_id, name: row.owner_name, handle: row.owner_handle };
}
function projectEntry(row: ProjectDirectoryRow, publicOwner: PublicProjectOwner | null = null): ProjectDirectoryEntry {
  const project = ProjectSchema.parse({
    id: row.id, owner: { kind: 'person', id: row.id }, creatorPersonId: row.id, leaderPersonId: null, name: row.name, summary: row.summary, status: row.status,
    publicity: { enabled: true, publishedStory: row.published_story, openNeedIds: [], publicParticipantIds: [] }, milestones: [], sharedFiles: [], baselinePlanId: null,
    budgets: [], participantIds: [], privateFiles: [], privateNotes: null, revision: 1, createdAt: row.sort_key,
  });
  const entry = toProjectDirectoryEntry(project, row.handle, publicOwner);
  if (!entry) throw new ApiError('access.not_found');
  return entry;
}
function ownerOf(row: Pick<MyProjectRow, 'owner_person_id' | 'owner_company_id'>): Party {
  return row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string };
}
function myProject(row: MyProjectRow, principal: Principal, companyId: string | null): MyProject {
  const owner = ownerOf(row);
  const relation = (owner.kind === 'person' && owner.id === principal.personId) || (owner.kind === 'company' && owner.id === companyId) ? 'owner' : 'participant';
  const project = ProjectSchema.parse({
    id: row.id, owner, creatorPersonId: row.creator_person_id, leaderPersonId: row.leader_person_id, name: row.name, summary: row.summary, status: row.status,
    publicity: { enabled: row.publicity_enabled, publishedStory: null, openNeedIds: [], publicParticipantIds: [] }, milestones: [], sharedFiles: [], baselinePlanId: null,
    budgets: [], participantIds: [], privateFiles: [], privateNotes: null, revision: row.revision, createdAt: iso(row.created_at),
  });
  return toMyProject(project, relation, row.handle);
}

/**
 * Company creation, handles and directories (BE-003). Directories serve the public projection to everyone; private
 * subjects are neither listed nor found by handle. Authenticated reads run under the principal (RLS); anonymous reads
 * use the owner-run public functions (people, projects) or the identity-free public company rows.
 */
export class DirectoryService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly policy: ParticipationService) {}

  private page(query: DirectoryPageQuery): DirectoryPage {
    if (query.cursor === undefined) return { after: null, limit: query.limit + 1 };
    const after = decodeDirectoryCursor(query.cursor);
    if (!after) throw new ApiError('validation.schema', 'cursor was not issued by this list', { field: 'cursor' });
    return { after, limit: query.limit + 1 };
  }
  /** Fetches limit + 1 rows; the extra row only says that another page exists. */
  private paginate<R extends { id: string; sort_key: string }, T>(rows: readonly R[], page: DirectoryPage, map: (row: R) => T): Page<T> {
    const limit = page.limit - 1;
    const slice = rows.slice(0, limit);
    const last = slice.at(-1);
    return { items: slice.map(map), nextCursor: rows.length > limit && last ? encodeDirectoryCursor({ createdAt: last.sort_key, id: last.id }) : null };
  }
  private read<T>(state: RequestState, signedIn: (trx: Transaction, principal: Principal) => Promise<T>, anonymous: (trx: Transaction) => Promise<T>): Promise<T> {
    return state.principal ? this.principals.runAs(state, signedIn) : withoutPrincipal(this.ctx.pool, anonymous);
  }

  // ---- Directories --------------------------------------------------------------------------------------------

  async people(query: DirectoryPageQuery, state: RequestState): Promise<Page<PersonDirectoryEntry>> {
    const page = this.page(query);
    const rows = await this.read(state, (trx) => directory.listPeople(trx, page), (trx) => directory.publicPeople(trx, page));
    return PersonDirectoryPageSchema.parse(this.paginate(rows, page, personEntry));
  }

  async companies(query: DirectoryPageQuery, state: RequestState): Promise<Page<CompanyDirectoryEntry>> {
    const page = this.page(query);
    const rows = await this.read(state, (trx) => directory.listCompanies(trx, page), (trx) => directory.listCompanies(trx, page));
    return CompanyDirectoryPageSchema.parse(this.paginate(rows, page, companyEntry));
  }

  /**
   * Public owners of published projects by id (QA-002 D2), through the owner-run lookup: the public projection is the
   * same for every caller, so signed-in and anonymous reads use the same function. Absent ids have no public owner.
   */
  async publicOwners(ids: readonly string[]): Promise<Map<string, PublicProjectOwner>> {
    const rows = await withoutPrincipal(this.ctx.pool, (trx) => directory.publicProjectOwners(trx, ids));
    return new Map(rows.map((row) => [row.project_id, toPublicOwner(row)]));
  }

  async projects(query: DirectoryPageQuery, state: RequestState): Promise<Page<ProjectDirectoryEntry>> {
    const page = this.page(query);
    const rows = await this.read(state, (trx) => directory.listProjects(trx, page), (trx) => directory.publicProjects(trx, page));
    const owners = await this.publicOwners(rows.map((r) => r.id));
    return ProjectDirectoryPageSchema.parse(this.paginate(rows, page, (row) => projectEntry(row, owners.get(row.id) ?? null)));
  }

  /** Published projects of a company for its public page (QA-002 D2); an unknown company is not found. */
  async companyProjects(companyId: string, query: DirectoryPageQuery): Promise<Page<ProjectDirectoryEntry>> {
    if (!UUID.test(companyId)) throw new ApiError('access.not_found');
    const page = this.page(query);
    const rows = await withoutPrincipal(this.ctx.pool, async (trx) => {
      if (!(await companies.getById(trx, companyId))) throw new ApiError('access.not_found');
      return directory.publicCompanyProjects(trx, companyId, page);
    });
    const owners = await this.publicOwners(rows.map((r) => r.id));
    return ProjectDirectoryPageSchema.parse(this.paginate(rows, page, (row) => projectEntry(row, owners.get(row.id) ?? null)));
  }

  /**
   * Projects the person owns or takes part in, and those of the employer when the membership may read company objects
   * (`company.deals.manage`, as in the object policy: membership alone never reaches company project data).
   */
  async myProjects(query: DirectoryPageQuery, state: RequestState): Promise<Page<MyProject>> {
    const page = this.page(query);
    return this.principals.runAs(state, async (trx, principal) => {
      const companyId = principal.membership?.permissions.includes('company.deals.manage') ? principal.membership.companyId : null;
      const rows = await directory.listMyProjects(trx, principal.personId, companyId, page);
      return MyProjectPageSchema.parse(this.paginate(rows, page, (row) => myProject(row, principal, companyId)));
    });
  }

  // ---- Handles --------------------------------------------------------------------------------------------------

  /** Resolution respects the caller's visibility: owners resolve their private projects, others get not found. */
  async resolve(kind: HandleKind, requested: string, state: RequestState): Promise<HandleResolution> {
    const handle = HandleSchema.safeParse(requested);
    if (!handle.success) throw new ApiError('access.not_found');
    const row = await this.read(state, (trx) => directory.resolve(trx, kind, handle.data), (trx) => directory.publicResolve(trx, kind, handle.data));
    if (!row) throw new ApiError('access.not_found');
    return HandleResolutionSchema.parse({ kind, id: row.subject_id, handle: row.current_handle, requested: handle.data, redirect: row.current_handle !== handle.data });
  }

  /** Public directory entry by handle (current or retired); private subjects are not found for everyone. */
  lookupPerson(requested: string, state: RequestState) {
    return this.lookup('person', requested, state, directory.person, directory.publicPerson, personEntry, PersonLookupSchema);
  }
  lookupCompany(requested: string, state: RequestState) {
    return this.lookup('company', requested, state, directory.company, directory.company, companyEntry, CompanyLookupSchema);
  }
  async lookupProject(requested: string, state: RequestState) {
    const found = await this.lookup('project', requested, state, directory.project, directory.publicProject, (row) => projectEntry(row), ProjectLookupSchema);
    const owner = (await this.publicOwners([found.item.id])).get(found.item.id) ?? null;
    return ProjectLookupSchema.parse({ ...found, item: { ...found.item, publicOwner: owner } });
  }

  private async lookup<R extends { handle: string | null }, E, S extends { parse(value: unknown): unknown }>(
    kind: HandleKind, requested: string, state: RequestState,
    signedIn: (trx: Transaction, id: string) => Promise<R | undefined>, anonymous: (trx: Transaction, id: string) => Promise<R | undefined>,
    map: (row: R) => E, schema: S,
  ): Promise<{ item: E; redirect: boolean }> {
    const handle = HandleSchema.safeParse(requested);
    if (!handle.success) throw new ApiError('access.not_found');
    const found = await this.read(
      state,
      async (trx) => {
        const resolved = await directory.resolve(trx, kind, handle.data);
        return resolved ? { resolved, row: await signedIn(trx, resolved.subject_id) } : null;
      },
      async (trx) => {
        const resolved = await directory.publicResolve(trx, kind, handle.data);
        return resolved ? { resolved, row: await anonymous(trx, resolved.subject_id) } : null;
      },
    );
    if (!found?.row) throw new ApiError('access.not_found');
    const item = map({ ...found.row, handle: found.resolved.current_handle });
    return schema.parse({ item, redirect: found.resolved.current_handle !== handle.data }) as { item: E; redirect: boolean };
  }

  async setPersonHandle(handle: string, state: RequestState): Promise<HandleAssignment> {
    return this.assign(state, 'person', null, handle, async (trx, principal) => (await persons.getById(trx, principal.personId))?.revision ?? 1);
  }

  async setCompanyHandle(id: string, handle: string, state: RequestState): Promise<HandleAssignment> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    return this.assign(state, 'company', id, handle, async (trx, principal) => {
      const company = await companies.getById(trx, id);
      if (!company) throw new ApiError('access.not_found');
      // Company existence is public, so a non-member is told "forbidden"; a member needs company.page.edit.
      if (principal.membership?.companyId !== id) throw new ApiError('access.forbidden');
      if (!principal.membership.permissions.includes('company.page.edit')) throw new ApiError('membership.permission_missing');
      return company.revision;
    });
  }

  async setProjectHandle(id: string, handle: string, state: RequestState): Promise<HandleAssignment> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    return this.assign(state, 'project', id, handle, async (trx, principal) => {
      const row = await projects.getById(trx, id);
      if (!row) throw new ApiError('access.not_found');
      const owner: Party = row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string };
      const resource = { kind: 'project' as const, id, ownerParty: owner, lifecycle: row.status, publishedProjection: row.publicity_enabled };
      const decision = this.policy.evaluate(principal, 'publish', resource, await this.policy.rowsFor(trx, { kind: 'project', id }));
      this.policy.require(decision);
      // The handle is part of the owner's public presentation: delegated "publish" participants do not rename it.
      if (decision.side !== 'owner') throw new ApiError('access.forbidden');
      return row.revision;
    });
  }

  /** `authorize` throws the policy error or returns the subject's current revision (for the outbox event). */
  private async assign(state: RequestState, kind: HandleKind, subjectId: string | null, handle: string, authorize: (trx: Transaction, principal: Principal) => Promise<number>): Promise<HandleAssignment> {
    try {
      return await this.principals.runAs(state, async (trx, principal) => {
        if (principal.delegation) throw new ApiError('access.mandate_scope');
        const revision = await authorize(trx, principal);
        const subject = subjectId ?? principal.personId;
        const previous = (await directory.history(trx, kind, subject)).find((h) => h.retired_at === null)?.handle ?? null;
        const current = await directory.setHandle(trx, kind, subject, handle);
        if (previous !== current) {
          const companyId = kind === 'company' ? subject : null;
          await auditEvents.append(trx, { actor_person_id: principal.personId, on_behalf_of_company_id: companyId, action: `${kind}.handle_changed`, object_kind: kind, object_id: subject, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis: { previous, handle: current } });
          await outbox.append(trx, { aggregate_kind: kind, aggregate_id: subject, revision, type: `${kind}.handle_changed`, payload: { previous, handle: current } });
        }
        return HandleAssignmentSchema.parse({ kind, id: subject, handle: current });
      });
    } catch (error) {
      throw mapDirectoryError(error);
    }
  }

  // ---- Company creation -----------------------------------------------------------------------------------------

  async createCompany(input: CreateCompanyCommand, state: RequestState): Promise<CreateCompanyResult> {
    const principal = state.principal as Principal;
    if (principal.delegation) throw new ApiError('access.mandate_scope');
    if (!principal.emailVerified) throw new ApiError('auth.email_unverified');
    // Fast path for the common case; the one-active-employer index decides races inside the transaction.
    if (principal.membership) throw new ApiError('membership.already_employed');
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        const created = await directory.createCompany(trx, { name: input.name, publicDescription: input.publicDescription, handle: input.handle });
        const row = await directory.company(trx, created.company_id);
        const membership = await memberships.getById(trx, created.membership_id);
        if (!row || !membership) throw new Error('created company is not readable in its own transaction');
        await auditEvents.append(trx, { actor_person_id: p.personId, on_behalf_of_company_id: created.company_id, action: 'company.created', object_kind: 'company', object_id: created.company_id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { origin: 'registered', founder: p.personId, membershipId: created.membership_id, handle: input.handle } });
        await outbox.append(trx, { aggregate_kind: 'company', aggregate_id: created.company_id, revision: 1, type: 'company.created', payload: { origin: 'registered' } });
        return CreateCompanyResultSchema.parse({ company: companyEntry(row), membership: toMembership(membership) });
      });
    } catch (error) {
      throw mapDirectoryError(error);
    }
  }
}

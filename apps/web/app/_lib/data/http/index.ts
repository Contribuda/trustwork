import { cache } from 'react';
import {
  CompanyDirectoryPageSchema,
  CompanyLookupSchema,
  MembershipSchema,
  MyProfileViewSchema,
  MyProjectPageSchema,
  PersonDirectoryPageSchema,
  PersonSchema,
  PrincipalSchema,
  ProjectDirectoryPageSchema,
  ProjectLookupSchema,
  ProjectSchema,
  PublicCompanySchema,
  PublicPersonProfileSchema,
  PublicPersonSchema,
  PublicProjectSchema,
  handleLookupSchema,
  ParticipantProjectSchema,
  SessionViewSchema,
  type MyProject,
} from '@trustwork/contracts/client';
import { z } from 'zod';
import type { DataPort, Handle } from '../port';
import type { AuthenticatedPrincipal, CompanyWorkspaceView, HomeView, MeView, OverviewView, Principal, SettingsView, TopicKey, WorkspaceProjectDetail, WorkspaceProjectRow } from '../types';
import { createTransport, type Transport } from './transport';
import {
  fromDirectoryCompany,
  fromPublicCompany,
  toCompanyCard,
  toCompanyDetail,
  toMembershipView,
  toPersonCard,
  toPersonDetailFromProfile,
  toPrincipal,
  toProjectCard,
  toProjectDetail,
  toSettings,
  toWorkspaceProject,
  toWorkspaceRow,
} from './map';

/**
 * Live implementation of the `DataPort` (WEB-004) on the implemented `/v1/*` endpoints. Server rendering reads with
 * the visitor's session cookie (workspace) or without any cookie (public pages, so a public page shows exactly what
 * every visitor sees). Modules the API does not serve yet (editorial, events, magazine, academy, procurement, sales,
 * assistant) answer empty lists and `null`, which pages render as their empty or not-found states: in live mode no
 * fixture ever reaches a page. Every response is parsed with the frozen contract schema before mapping.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 100;
/**
 * `GET /v1/companies/:id` reports neither the origin nor the handle (its contract status says `sourced` for every
 * unclaimed company, registered ones included). Until the API returns them (follow-up requested in WEB-004), the
 * adapter finds the directory entry of an id in at most this many directory pages and otherwise keeps the contract
 * status.
 */
const DIRECTORY_SCAN_PAGES = 5;
const TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];

const MeSchema = z.object({ person: PersonSchema, principal: PrincipalSchema });
const ProfileLookupSchema = handleLookupSchema(PublicPersonProfileSchema);
const CompanyReadSchema = z.object({ company: PublicCompanySchema, privateView: z.unknown().nullable(), membership: MembershipSchema.nullable() });
const MembershipListSchema = z.object({ items: z.array(MembershipSchema) });
const SessionListSchema = z.object({ items: z.array(SessionViewSchema), currentSessionId: z.string() });
const ProjectReadSchema = z.discriminatedUnion('projection', [
  z.object({ projection: z.literal('owner_private'), project: ProjectSchema }),
  z.object({ projection: z.literal('shared_party'), project: ParticipantProjectSchema }),
  z.object({ projection: z.literal('public'), project: PublicProjectSchema }),
]);

function person(principal: Principal): AuthenticatedPrincipal {
  if (principal.kind !== 'person') throw new Error('Workspace data requires a signed-in principal');
  return principal;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function createHttpDataPort(transport: Transport): DataPort {
  /** `GET /v1/me` once per request (React request cache); `null` without a valid session. */
  const me = cache(async () => {
    if (!(await transport.hasSession())) return null;
    try {
      const body = await transport.get('/v1/me');
      return body === null ? null : MeSchema.parse(body);
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status: number }).status === 401) return null;
      throw error;
    }
  });

  const companyRead = cache(async (id: string) => {
    const body = await transport.get(`/v1/companies/${segment(id)}`);
    return body === null ? null : CompanyReadSchema.parse(body);
  });

  /** The public directory entry of a company id (origin, claim status and handle), or null when not found in the scan. */
  const directoryCompany = cache(async (id: string) => {
    let cursor: string | null = null;
    for (let page = 0; page < DIRECTORY_SCAN_PAGES; page++) {
      const body = await transport.get(`/v1/companies?limit=${LIST_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { anonymous: true });
      if (body === null) return null;
      const parsed = CompanyDirectoryPageSchema.parse(body);
      const found = parsed.items.find((entry) => entry.id === id);
      if (found) return found;
      if (!parsed.nextCursor) return null;
      cursor = parsed.nextCursor;
    }
    return null;
  });

  /** A company read by id, with the directory's origin and handle when the scan finds them. */
  async function companyById(company: z.infer<typeof PublicCompanySchema>) {
    const entry = await directoryCompany(company.id).catch(() => null);
    return entry ? fromDirectoryCompany(entry) : fromPublicCompany(company);
  }

  const myProjects = cache(async (): Promise<MyProject[]> => {
    const body = await transport.get(`/v1/me/projects?limit=${LIST_LIMIT}`);
    return body === null ? [] : MyProjectPageSchema.parse(body).items;
  });

  const principalFor = cache(async (): Promise<AuthenticatedPrincipal | null> => {
    const session = await me();
    if (!session) return null;
    const employer = session.principal.membership ? await companyRead(session.principal.membership.companyId) : null;
    const resolved = employer ? await companyById(employer.company) : null;
    return toPrincipal(session, employer && resolved ? { company: resolved, membership: employer.membership } : null);
  });

  async function publicGet(path: `/v1/${string}`): Promise<unknown | null> {
    return transport.get(path, { anonymous: true });
  }

  async function listCompanies() {
    const body = await publicGet(`/v1/companies?limit=${LIST_LIMIT}`);
    return body === null ? [] : CompanyDirectoryPageSchema.parse(body).items.map((entry) => toCompanyCard(fromDirectoryCompany(entry)));
  }

  async function listPeople() {
    const body = await publicGet(`/v1/people?limit=${LIST_LIMIT}`);
    return body === null ? [] : PersonDirectoryPageSchema.parse(body).items.map(toPersonCard);
  }

  async function listPublicProjects() {
    const body = await publicGet(`/v1/projects?limit=${LIST_LIMIT}`);
    return body === null ? [] : ProjectDirectoryPageSchema.parse(body).items.map((entry) => toProjectCard(entry));
  }

  async function getCompany(handle: Handle) {
    if (UUID.test(handle)) {
      const body = await publicGet(`/v1/companies/${segment(handle)}`);
      return body === null ? null : toCompanyDetail(await companyById(CompanyReadSchema.parse(body).company));
    }
    const body = await publicGet(`/v1/companies/by-handle/${segment(handle)}`);
    return body === null ? null : toCompanyDetail(fromDirectoryCompany(CompanyLookupSchema.parse(body).item));
  }

  /**
   * The allowlisted public profile (PPL-001): found only while the person keeps the profile public with a live
   * `profile_public` consent, so a person listed without consent never gets a page.
   */
  async function getPerson(handle: Handle) {
    if (UUID.test(handle)) {
      const body = await publicGet(`/v1/people/${segment(handle)}/profile`);
      return body === null ? null : toPersonDetailFromProfile(PublicPersonProfileSchema.parse(body));
    }
    const body = await publicGet(`/v1/people/by-handle/${segment(handle)}/profile`);
    return body === null ? null : toPersonDetailFromProfile(ProfileLookupSchema.parse(body).item);
  }

  async function getPublicProject(handle: Handle) {
    if (UUID.test(handle)) {
      const body = (await publicGet(`/v1/projects/${segment(handle)}`)) as { projection?: unknown; project?: unknown } | null;
      // Anonymous reads only ever answer the public projection; anything else is refused before it is even parsed.
      if (body === null || body.projection !== 'public') return null;
      return toProjectDetail(PublicProjectSchema.parse(body.project));
    }
    const body = await publicGet(`/v1/projects/by-handle/${segment(handle)}`);
    return body === null ? null : toProjectDetail(ProjectLookupSchema.parse(body).item);
  }

  async function listWorkspaceProjects(principal: Principal): Promise<WorkspaceProjectRow[]> {
    const p = person(principal);
    return (await myProjects()).map((project) => toWorkspaceRow(project, p));
  }

  async function getWorkspaceProject(principal: Principal, id: string): Promise<WorkspaceProjectDetail | null> {
    const p = person(principal);
    if (!UUID.test(id)) return null;
    const body = await transport.get(`/v1/projects/${segment(id)}`);
    if (body === null) return null;
    const handle = (await myProjects()).find((x) => x.id === id)?.handle ?? null;
    return toWorkspaceProject(ProjectReadSchema.parse(body), handle, p);
  }

  async function getCompanyWorkspace(principal: Principal): Promise<CompanyWorkspaceView | null> {
    const p = person(principal);
    if (!p.company) return null;
    const read = await companyRead(p.company.id);
    if (!read) return null;
    const list = await transport.get(`/v1/companies/${segment(p.company.id)}/memberships`);
    const memberships = list === null ? [] : MembershipListSchema.parse(list).items;
    const names = await Promise.all(
      memberships.map(async (m) => {
        if (m.personId === p.personId) return p.displayName;
        const pub = await publicGet(`/v1/people/${segment(m.personId)}`).catch(() => null);
        const parsed = pub === null ? null : PublicPersonSchema.safeParse(pub);
        return parsed?.success ? toPersonCard(parsed.data).displayName : '';
      }),
    );
    const projects = await listWorkspaceProjects(p);
    return {
      company: toCompanyCard(await companyById(read.company)),
      myRole: p.company.role,
      permissions: p.company.permissions,
      pendingRequests: 0,
      members: memberships
        .filter((m) => m.status !== 'ended')
        .map((m, i) => ({ id: m.id, name: names[i] ?? '', role: m.role, status: m.status, since: m.validFrom, isPublic: names[i] !== '' })),
      catalogue: null,
      canSeeFloors: false,
      projects: projects.filter((r) => r.ownerKind === 'company'),
      wall: [],
      decisions: [],
    };
  }

  async function getOverview(principal: Principal): Promise<OverviewView> {
    const p = person(principal);
    const projects = await listWorkspaceProjects(p);
    return {
      variant: 'personal',
      decisions: [],
      procurement: { show: false, inProgress: 0, rows: [] },
      sales: { show: false, inProgress: 0, rows: [], canFillCatalogue: false },
      projects: projects.slice(0, 4),
      events: [],
      publications: [],
      assistant: { running: 0, approvals: 0, unknown: 0, unread: 0 },
      industryPicks: [],
    };
  }

  /** The owner view of the profile (PPL-001); `null` when the API does not serve it. */
  const myProfile = cache(async () => {
    const body = await transport.get('/v1/me/profile');
    return body === null ? null : MyProfileViewSchema.parse(body);
  });

  async function getMe(principal: Principal): Promise<MeView> {
    const p = person(principal);
    const session = await me();
    const owner = await myProfile().catch(() => null);
    const isPublished = owner ? owner.publicPreview !== null : session?.person.profileVisibility === 'public';
    const projects = await listWorkspaceProjects(p);
    const memberships = [];
    if (p.company) {
      const read = await companyRead(p.company.id);
      if (read?.membership) memberships.push(toMembershipView(read.membership, { name: read.company.name, handle: p.company.handle }));
    }
    return {
      principal: p,
      publicHref: isPublished ? `/people/${p.handle}` : null,
      isPublished,
      headline: owner?.person.headline ?? session?.person.publicProfile.headline ?? null,
      roleLine: owner?.profile?.roleLine ?? owner?.person.headline ?? session?.person.publicProfile.headline ?? '',
      topics: (owner?.profile?.topics ?? []).filter((topic): topic is TopicKey => (TOPICS as readonly string[]).includes(topic)),
      decisions: [],
      projects,
      publications: [],
      mandatesCount: 0,
      memberships,
      experience: '',
      portraitConsent: owner?.consents.some((c) => c.purpose === 'portrait_display' && c.withdrawnAt === null) ?? false,
      showEmployer: owner?.profile?.showEmployer ?? false,
    };
  }

  async function getSettings(principal: Principal): Promise<SettingsView> {
    const p = person(principal);
    const session = await me();
    if (!session) throw new Error('Settings require a valid session');
    const body = await transport.get('/v1/me/sessions');
    const sessions = body === null ? { items: [], currentSessionId: '' } : SessionListSchema.parse(body);
    return toSettings(session.person, sessions, p);
  }

  async function getHome(): Promise<HomeView> {
    // The home page aggregates; an unreachable API leaves the people and projects block empty instead of failing the page.
    const [people, projects] = await Promise.all([listPeople().catch(() => []), listPublicProjects().catch(() => [])]);
    return {
      featured: [],
      topics: TOPICS.map((key) => ({ key, latest: null })),
      articles: [],
      useful: [],
      currentIssue: null,
      peopleAndProjects: { people: people.slice(0, 4), projects: projects.slice(0, 4) },
    };
  }

  const none = async () => null;
  const empty = async () => [];

  return {
    source: 'api',
    getHome,
    listEvents: empty,
    getEvent: none,
    listNews: empty,
    listArticles: empty,
    getPublication: none,
    listCompanies,
    getCompany,
    listPeople,
    getPerson,
    listPublicProjects,
    getPublicProject,
    listCourses: empty,
    getPlatformCertificate: none,
    getMagazine: async () => ({ current: null, archive: [] }),
    listRubrics: empty,
    listRubricEntries: empty,
    listMagazineAuthors: empty,
    getIssue: none,
    getOverview,
    listRfqs: async (principal) => (person(principal), []),
    listLeads: async (principal) => (person(principal), []),
    listWorkspaceProjects,
    getWorkspaceProject,
    listMyPublications: async (principal) => (person(principal), []),
    getCompanyWorkspace,
    getMe,
    getAssistant: async (principal) => (person(principal), { summary: { running: 0, approvals: 0, unknown: 0, unread: 0 }, mandates: [], approvals: [], runs: [] }),
    getSettings,
    principalFor: async () => principalFor(),
  };
}

/** The live adapter of this process: the configured API origin and the current request's cookies. */
export const httpDataPort: DataPort = createHttpDataPort(createTransport());

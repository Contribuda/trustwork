import type { PublicLegalDocuments } from '@trustwork/contracts/client';
import type { DemoContext } from '../persona';
import type {
  AssistantView,
  AuthenticatedPrincipal,
  CertificateCheck,
  CompanyCard,
  CompanyDetail,
  CompanyWorkspaceView,
  Course,
  EventCard,
  EventDetail,
  HomeView,
  IssueLookup,
  LeadRow,
  MagazineAuthor,
  MagazineView,
  MeView,
  MyPublicationRow,
  OverviewView,
  PersonCard,
  PersonDetail,
  Principal,
  ProjectCard,
  ProjectDetail,
  PublicationCard,
  PublicationDetail,
  RfqRow,
  RubricEntry,
  RubricKey,
  RubricSummary,
  SettingsView,
  TopicKey,
  WorkspaceProjectDetail,
  WorkspaceProjectRow,
} from './types';

/**
 * Public URL identity of a person, company or project (`/people/<handle>`, `/companies/<handle>`,
 * `/projects/<handle>`). Handles are changeable and never reused (BE-003); the UUID `id` of every view
 * model stays the stable identifier (ADR 012). Today the fixture adapter serves the fixture slug as the handle.
 */
export type Handle = string;

/** Where the data comes from: synthetic fixtures (demo) or the live `/v1/*` API. */
export type DataSource = 'fixtures' | 'api';

export type EventScope = 'upcoming' | 'past' | 'all';

/**
 * Public reads. Anonymous-safe projections only: unpublished, private or unknown handles resolve to `null`
 * (pages answer 404, never 403, so existence is not disclosed).
 */
export interface PublicDataPort {
  getHome(): Promise<HomeView>;
  /** Events sorted by start; `scope` keeps upcoming (default) or past ones. `now` is injectable for tests. */
  listEvents(scope?: EventScope, now?: number): Promise<EventCard[]>;
  getEvent(slug: string, now?: number): Promise<EventDetail | null>;
  listNews(topic?: TopicKey): Promise<PublicationCard[]>;
  listArticles(format?: string): Promise<PublicationCard[]>;
  getPublication(slug: string, format: 'news' | 'article'): Promise<PublicationDetail | null>;
  listCompanies(): Promise<CompanyCard[]>;
  getCompany(handle: Handle): Promise<CompanyDetail | null>;
  listPeople(): Promise<PersonCard[]>;
  getPerson(handle: Handle): Promise<PersonDetail | null>;
  listPublicProjects(): Promise<ProjectCard[]>;
  getPublicProject(handle: Handle): Promise<ProjectDetail | null>;
  listCourses(): Promise<Course[]>;
  /** Public certificate check by certificate id: the holder's public card and the course, or `null`. */
  getPlatformCertificate(id: string): Promise<CertificateCheck | null>;
  getMagazine(): Promise<MagazineView>;
  listRubrics(): Promise<RubricSummary[]>;
  listRubricEntries(key: RubricKey): Promise<RubricEntry[]>;
  listMagazineAuthors(): Promise<MagazineAuthor[]>;
  getIssue(number: number): Promise<IssueLookup | null>;
  /**
   * The hub's active legal texts (`GET /v1/legal`, HUB-001 legal documents, QA-002 D4) for the terms and privacy pages
   * and the terms version sign-up records. Fixtures and an API without a hub answer no active text, which the pages
   * show as a labelled draft notice.
   */
  getLegalDocuments(): Promise<PublicLegalDocuments>;
}

/**
 * Workspace reads for the signed-in person. Objects are addressed by their stable id, never by handle.
 * Every call takes the request principal; an anonymous principal is rejected (pages gate with
 * `requirePrincipal` first). Results are already filtered to what this person may see.
 */
export interface WorkspaceDataPort {
  getOverview(principal: Principal): Promise<OverviewView>;
  listRfqs(principal: Principal): Promise<RfqRow[]>;
  listLeads(principal: Principal): Promise<LeadRow[]>;
  listWorkspaceProjects(principal: Principal): Promise<WorkspaceProjectRow[]>;
  getWorkspaceProject(principal: Principal, id: string): Promise<WorkspaceProjectDetail | null>;
  listMyPublications(principal: Principal): Promise<MyPublicationRow[]>;
  getCompanyWorkspace(principal: Principal): Promise<CompanyWorkspaceView | null>;
  getMe(principal: Principal): Promise<MeView>;
  getAssistant(principal: Principal): Promise<AssistantView>;
  getSettings(principal: Principal): Promise<SettingsView>;
}

/** Resolves the request's person. The fixture adapter reads the demo persona; the API adapter reads the session. */
export interface SessionDataPort {
  principalFor(demo: DemoContext): Promise<AuthenticatedPrincipal | null>;
}

/**
 * The data boundary of apps/web. Pages, layouts and route handlers depend only on this interface (through
 * `data` from `./index`); adapters implement it. Every method is asynchronous so a network-backed adapter
 * fits without touching callers. View models are plain and serializable (`./types`).
 */
export interface DataPort extends PublicDataPort, WorkspaceDataPort, SessionDataPort {
  readonly source: DataSource;
}

import type { CompanyPermission, CompanyStatus, ProjectStatus, PublicationStatus, RunState } from './contract-types';
export type { CompanyStatus, ProjectStatus };
import type { DemoContext, Persona } from '../persona';

/**
 * View models crossing the data boundary. They are plain, serializable projections: pages render them
 * directly and may pass them to client components. Private fields (budgets, floors, notes, e-mails)
 * never enter a public view model; the adapter applies the contract projection rules.
 */

export type TopicKey = 'materials' | 'technologies' | 'markets' | 'regulation' | 'projects' | 'people' | 'events';
/** ISO 3166-2 region code of the active country pack (e.g. `UZ-TK`). */
export type RegionKey = string;
export type ArticleFormat = 'analysis' | 'practice' | 'experience' | 'opinion' | 'interview' | 'projectStory' | 'overview';
export type AuthorKind = 'editorial' | 'person' | 'company';

export type PublicationCard = {
  id: string;
  slug: string;
  href: string;
  format: 'news' | 'article' | 'magazine_piece' | 'company_post' | 'personal_post';
  articleFormat: ArticleFormat | null;
  title: string;
  /** Short name for utility lists; null when the title is short enough. */
  shortTitle: string | null;
  lede: string;
  topics: TopicKey[];
  authorKind: AuthorKind;
  authorLabel: string;
  authorHref: string | null;
  assistantAssisted: boolean;
  publishedAt: string;
  eventTime: string | null;
  isCorrected: boolean;
  correctedAt: string | null;
  readMinutes: number | null;
  region: RegionKey | null;
  source: { name: string; url: string; type: 'industryMedia' | 'manufacturer' | 'event' | 'science' } | null;
};

export type PublicationDetail = PublicationCard & {
  body: string;
  version: number;
  correction: { note: string; date: string; fromVersion: number } | null;
  history: Array<{ version: number; publishedAt: string | null; note: string | null }>;
  mentions: Array<{ label: string; href: string | null; kind: 'person' | 'company' | 'project' }>;
  related: PublicationCard[];
};

export type CompanyKind = 'developer' | 'client' | 'generalContractor' | 'contractor' | 'designer' | 'manufacturer' | 'supplier' | 'equipment' | 'services' | 'logistics';
export type CompanyCard = {
  id: string;
  /** Public URL identity (see `Handle` in ./port); `id` stays the stable identifier. */
  handle: string;
  href: string;
  name: string;
  status: CompanyStatus;
  kinds: CompanyKind[];
  /** Self-declared public statuses (hiring, accepting orders, looking for…). */
  signals: Signal<CompanySignalKind>[];
  location: { lat: number; lng: number } | null;
  /** Platform accreditation mark; implies `status === 'verified'`. */
  verified: boolean;
  /** Public evidence signals (no ratings): legal identifier state, verified domain, published catalogue version, public members. */
  evidence: {
    identifier: { kind: string; status: CompanyStatus } | null;
    domainVerified: boolean;
    catalogue: { version: number; publishedAt: string; entries: number } | null;
    publicMembers: number;
  };
  description: string | null;
  directions: string[];
  region: RegionKey;
  website: string | null;
  provenance: { source: string; observedAt: string } | null;
  claimedAt: string | null;
  projectsCount: number;
  publicationsCount: number;
};

export type CatalogueEntry = { id: string; name: string; kind: 'goods' | 'works' | 'services' | 'bundle'; unit: string; priceOnRequest: boolean; isPublic: boolean; privateFloorMinorUnits: string | null };

export type CompanyVacancy = {
  id: string;
  title: string;
  location: string;
  format: 'office' | 'site' | 'remote' | 'hybrid';
  employment: 'full' | 'part' | 'contract';
  salaryFromMinorUnits: string | null;
  salaryToMinorUnits: string | null;
  postedAt: string;
  description: string | null;
  responsibilities: string[];
  requirements: string[];
  conditions: string[];
};
export type CompanyUpdate = { id: string; date: string; kind: 'news' | 'project' | 'catalogue' | 'certificate' | 'team'; title: string; href: string | null };
export type CompanyProfile = {
  tagline: string | null;
  signals: Signal<CompanySignalKind>[];
  accreditation: Accreditation;
  about: string | null;
  founded: number | null;
  geography: string[];
  certificates: Certificate[];
  contacts: { email: string | null; phone: string | null; address: string | null; hours: string | null } | null;
  vacancies: CompanyVacancy[];
  updates: CompanyUpdate[];
  faq: Array<{ q: string; a: string }>;
};
export type CompanyDetail = CompanyCard & {
  catalogue: { version: number; publishedAt: string; entries: CatalogueEntry[] } | null;
  people: PersonCard[];
  projects: ProjectCard[];
  /** Published materials authored by the company or attached to its page, newest first. */
  publications: PublicationCard[];
  /** Published materials that mention the company without being authored by it. */
  mentions: PublicationCard[];
  profile: CompanyProfile;
};

export type PersonField = 'management' | 'engineering' | 'design' | 'procurement' | 'sales' | 'production' | 'construction' | 'logistics' | 'control' | 'client';
export type PersonSignalKind = 'openToWork' | 'openToProjects' | 'hiring' | 'lookingForPartners' | 'consulting' | 'busy';
export type CompanySignalKind = 'hiring' | 'acceptingOrders' | 'lookingForSubcontractors' | 'lookingForSuppliers' | 'lookingForPartners' | 'lookingForProjects' | 'paused';
export type CertificateKind = 'sro' | 'permit' | 'declaration' | 'technical' | 'education' | 'membership' | 'other';
export type Certificate = { id: string; kind: CertificateKind; name: string; issuer: string; number: string | null; validUntil: string | null; evidence: 'asserted' | 'confirmed' };
export type Accreditation = { verifiedAt: string; scope: string[] } | null;
export type Course = { id: string; slug: string; title: string; summary: string; durationMinutes: number; modules: number; topics: TopicKey[] };
export type PlatformCertificate = { id: string; course: Course; issuedAt: string; score: number | null };
/** Public certificate check: the certificate and its holder's public card. */
export type CertificateCheck = { certificate: PlatformCertificate; holder: PersonCard };
export type Signal<K extends string> = { kind: K; note: string | null; until: string | null };
export type PersonCard = {
  id: string;
  /** Public URL identity (see `Handle` in ./port); `id` stays the stable identifier. */
  handle: string;
  href: string;
  displayName: string;
  /** Null when the source does not say (the live API has no field yet; never guessed). */
  field: PersonField | null;
  /** Works in a company (employer shown) or independently. */
  independent: boolean;
  signals: Signal<PersonSignalKind>[];
  /** Platform accreditation mark («Verified by the platform»). */
  verified: boolean;
  platformCertificatesCount: number;
  since: number | null;
  servicesCount: number;
  portfolioCount: number;
  /** Consented portrait manifest id; null → initials. */
  portrait: string | null;
  headline: string | null;
  roleLine: string;
  expertise: string[];
  topics: TopicKey[];
  region: RegionKey;
  employer: { name: string; href: string } | null;
  projectsCount: number;
  publicationsCount: number;
};

export type PersonProfile = {
  about: string | null;
  since: number | null;
  geography: string[];
  signals: Signal<PersonSignalKind>[];
  accreditation: Accreditation;
  platformCertificates: PlatformCertificate[];
  /** `confirmation` (live API, PPL-001): entries are self-declared until a company confirmation is recorded; absent in fixtures. */
  career: Array<{ id: string; company: string; companyHref: string | null; role: string; from: number; to: number | null; summary: string | null; confirmation?: 'self_declared' | 'company_confirmed' }>;
  education: Array<{ id: string; school: string; degree: string; year: number | null }>;
  certificates: Certificate[];
  services: Array<{ id: string; name: string; description: string | null; format: 'onsite' | 'remote' | 'both'; unit: string | null }>;
  portfolio: Array<{ id: string; title: string; kind: string; year: number | null; description: string | null; cover: string | null; projectHref: string | null }>;
  contacts: { email: string | null; phone: string | null; telegram: string | null } | null;
  faq: Array<{ q: string; a: string }>;
};
export type PersonDetail = PersonCard & {
  experience: string;
  /** Published materials authored by the person or attached to the page, newest first. */
  publications: PublicationCard[];
  /** Published materials mentioning the person. */
  mentions: PublicationCard[];
  projects: ProjectCard[];
  profile: PersonProfile;
};

export type ProjectCard = {
  id: string;
  /** Public URL identity (see `Handle` in ./port); `id` stays the stable identifier. */
  handle: string;
  href: string;
  name: string;
  summary: string | null;
  status: ProjectStatus;
  /** Null when the source does not say (the live API has no category yet; never guessed). */
  category: 'housing' | 'education' | 'industrial' | 'publicSpace' | 'infrastructure' | null;
  region: RegionKey;
  owner: { label: string; href: string | null; kind: 'person' | 'company' };
  publicParticipants: Array<{ label: string; href: string | null; roleTitle: string }>;
  openNeedsCount: number;
  progressPercent: number;
  cover: string | null;
  location: { lat: number; lng: number } | null;
  projectionDate: string | null;
  updatedAt: string;
};

export type ProjectMilestone = { id: string; title: string; baselineDue: string; changedDue: string | null; actual: string | null; changedByClient: boolean; state: 'done' | 'current' | 'upcoming' };
export type ProjectNeed = {
  id: string;
  title: string;
  kind: 'goods' | 'works' | 'services' | 'bundle';
  region: RegionKey;
  deadline: string;
  summary: string | null;
  quantity: string | null;
  unit: string | null;
  quotesCount: number;
};
export type PartyRole = 'developer' | 'client' | 'technicalClient' | 'designer' | 'generalContractor' | 'subcontractor' | 'supplier' | 'supervision' | 'investor' | 'operator' | 'other';
export type ProjectParticipant = { label: string; href: string | null; kind: 'person' | 'company'; roleTitle: string; role: 'owner' | 'leader' | 'participant'; partyRole: PartyRole; portrait: string | null };
export type ProjectDetail = ProjectCard & {
  story: string | null;
  leader: { label: string; href: string | null; portrait: string | null } | null;
  participants: ProjectParticipant[];
  updates: Array<{ id: string; type: 'result' | 'teamMessage' | 'discussion'; title: string; date: string; evidence: 'asserted' | 'confirmed' | 'disputed' | 'superseded' }>;
  milestones: ProjectMilestone[];
  progress: { done: number; total: number; percent: number; current: ProjectMilestone | null; delayed: boolean };
  openNeeds: ProjectNeed[];
  publicFiles: Array<{ id: string; name: string; kind: 'presentation' | 'brochure' | 'drawing' | 'archive' | 'other' }>;
  publications: PublicationCard[];
  mentions: PublicationCard[];
  startedAt: string;
  showcase: {
    gallery: Array<{ id: string; photo: string; caption: string | null }>;
    video: { url: string; title: string } | null;
    highlights: Array<{ label: string; value: string }>;
    plans: Array<{ id: string; title: string; when: string }>;
    partnerNote: string | null;
    contact: ProjectParticipant | null;
    passport: { address: string; objectType: string; totalArea: string | null; floors: string | null; siteArea: string | null; designer: string | null; commissioning: string | null } | null;
    openRoles: Array<{ id: string; role: PartyRole; title: string; note: string | null; when: string | null }>;
    materials: Array<{ id: string; name: string; supplier: { label: string; href: string | null } | null; status: 'planned' | 'approved' | 'inUse' }>;
    procurementPlan: Array<{ id: string; title: string; kind: 'goods' | 'works' | 'services' | 'bundle'; when: string; status: 'planned' | 'open' | 'closed'; rfqId: string | null }>;
    supplierTerms: string[];
    commercial: {
      offering: string;
      infrastructure: string[];
      audiences: Array<{
        id: string;
        kind: 'buyers' | 'tenants' | 'residents' | 'investors';
        title: string;
        description: string | null;
        units: Array<{ id: string; title: string; detail: string | null }>;
        terms: string[];
        commercialTerms: string[];
        files: Array<{ id: string; name: string; kind: 'presentation' | 'brochure' | 'drawing' | 'archive' | 'other' }>;
        faq: Array<{ q: string; a: string }>;
        action: 'viewing' | 'request' | 'join';
      }>;
      note: string | null;
      contact: ProjectParticipant | null;
      salesOffice: string | null;
    } | null;
    press: Array<{ id: string; title: string; source: string; url: string; date: string }>;
    documents: Array<{ id: string; kind: 'permit' | 'expertise' | 'landPlan' | 'contract' | 'certificate' | 'other'; name: string; number: string | null; date: string | null; evidence: 'asserted' | 'confirmed' }>;
  };
};

/** Magazine rubrics (sections of an issue); fixture items carry the rubric key (legacy Russian labels still map), the adapter resolves it. */
export type RubricKey = 'analysis' | 'practice' | 'report' | 'interview' | 'people' | 'projectStory' | 'materials' | 'opinion' | 'week' | 'numbers' | 'qa';

export type IssueItem = {
  position: number;
  section: string;
  rubric: RubricKey;
  title: string;
  slug: string;
  publicationId: string;
  version: number;
  isCorrected: boolean;
  articleFormat: ArticleFormat | null;
  body: string;
  lede: string;
  readMinutes: number | null;
  authorKind: AuthorKind;
  authorLabel: string;
  authorHref: string | null;
  topics: TopicKey[];
  quiz: QuizQuestion[];
  mentions: Array<{ label: string; href: string | null; kind: 'person' | 'company' | 'project' }>;
};

export type QuizQuestion = { question: string; options: string[]; answer: number; explanation: string };
export type IssuePoll = { question: string; options: string[]; sample: number[] };
export type GlossaryEntry = { term: string; definition: string };

export type RubricSummary = { key: RubricKey; count: number; latestIssue: number | null };
export type RubricEntry = { item: IssueItem; issue: { number: number; title: string; href: string; readerHref: string; dateFrom: string; dateTo: string } };
export type MagazineAuthor = { label: string; href: string | null; kind: AuthorKind; count: number; person: PersonCard | null };

export type IssueView = {
  id: string;
  number: number;
  href: string;
  readerHref: string;
  title: string;
  lede: string;
  dateFrom: string;
  dateTo: string;
  releasedAt: string;
  /** Planned date of the next weekly issue (released + 7 days). */
  nextReleaseAt: string;
  edition: number;
  status: 'released' | 'corrected';
  itemsCount: number;
  /** Sum of the items' reading time. */
  readMinutes: number;
  /** Distinct rubrics in item order. */
  rubrics: RubricKey[];
  items: IssueItem[];
  pdf: { state: 'pending' } | { state: 'ready'; size: string; pages: number };
  poll: IssuePoll | null;
  glossary: GlossaryEntry[];
  corrections: Array<{ id: string; itemTitle: string; summary: string; date: string; fromEdition: number; toEdition: number }>;
};
/** The magazine: the current released issue and the archive, newest first. */
export type MagazineView = { current: IssueView | null; archive: IssueView[] };
/** One released issue with its neighbours in the archive. */
export type IssueLookup = { issue: IssueView; previous: IssueView | null; next: IssueView | null };

export type EventType = 'conference' | 'seminar' | 'webinar' | 'tour' | 'exhibition' | 'meetup';
export type EventFormat = 'offline' | 'online' | 'hybrid';
export type EventStatus = 'open' | 'soldout' | 'closed' | 'past';
export type EventTicket = { id: string; name: string; description: string; priceMinorUnits: number; currency: string; quota: number | null; taken: number; salesUntil: string | null; available: boolean };
export type EventSpeaker = { id: string; name: string; role: string; href: string | null; portrait: string | null };
export type EventCard = {
  id: string;
  slug: string;
  href: string;
  title: string;
  lede: string;
  type: EventType;
  format: EventFormat;
  startsAt: string;
  endsAt: string;
  timezone: string;
  city: string | null;
  region: RegionKey | null;
  venueName: string | null;
  organizer: { kind: 'company' | 'editorial' | 'community'; name: string; href: string | null };
  cover: string;
  topics: TopicKey[];
  status: EventStatus;
  /** Lowest ticket price in minor units; 0 when a free ticket exists. */
  priceFromMinorUnits: number;
  priceToMinorUnits: number;
  registered: number;
  capacity: number | null;
  featured: boolean;
  speakers: EventSpeaker[];
};
export type EventDetail = EventCard & {
  venue: { name: string; address: string } | null;
  onlineNote: string | null;
  body: string;
  program: Array<{ time: string; title: string; speakers: EventSpeaker[] }>;
  tickets: EventTicket[];
  related: PublicationCard[];
  materialsHref: string | null;
};
export type HomeView = {
  featured: PublicationCard[];
  topics: Array<{ key: TopicKey; latest: PublicationCard | null }>;
  articles: PublicationCard[];
  useful: PublicationCard[];
  currentIssue: IssueView | null;
  peopleAndProjects: { people: PersonCard[]; projects: ProjectCard[] };
};

// Workspace -------------------------------------------------------------------------------

export type MembershipView = {
  id: string;
  role: 'member' | 'administrator';
  permissions: CompanyPermission[];
  status: 'invited' | 'active' | 'declined' | 'expired' | 'withdrawn' | 'ended';
  validFrom: string | null;
  endedAt: string | null;
  companyName: string;
  companyHandle: string;
};

/** `live` notifications come from `GET /v1/notifications` (COMMS-001) and can be marked read; fixture ones cannot. */
export type NotificationView = { id: string; kind: 'decision' | 'quote' | 'project' | 'publication' | 'assistant' | 'magazine' | 'message' | 'account'; title: string; at: string; href: string; unread: boolean; live?: boolean };

export type AssistantSummary = { running: number; approvals: number; unknown: number; unread: number };

export type AuthenticatedPrincipal = {
  kind: 'person';
  /** The demo persona, or `session` for a principal resolved from the live API session (WEB-004). */
  persona: Exclude<Persona, 'anonymous'> | 'session';
  demo: DemoContext;
  personId: string;
  displayName: string;
  /** Handle of the person's public profile. */
  handle: string;
  preferences: { buying: boolean; selling: boolean; industryParticipation: boolean };
  pinned: { procurement: boolean; sales: boolean };
  onboarding: 'completed' | 'skipped' | 'pending';
  company: { id: string; name: string; handle: string; status: CompanyStatus; role: 'member' | 'administrator'; permissions: CompanyPermission[]; membershipId: string } | null;
  attention: { procurement: number; sales: number; projects: number; publications: number; assistant: number };
  notifications: NotificationView[];
  assistant: AssistantSummary;
  isPlatformAdmin: boolean;
  /** Live sessions only: whether the primary e-mail is verified (publishing and invitations need it). */
  emailVerified?: boolean;
};
export type AnonymousPrincipal = { kind: 'anonymous'; persona: 'anonymous'; demo: DemoContext };
export type Principal = AuthenticatedPrincipal | AnonymousPrincipal;

export type DecisionRow = {
  id: string;
  kind: 'quoteComparison' | 'approvalDigest' | 'orderAcceptance' | 'dispute' | 'publicationReview';
  title: string;
  context: string;
  due: string;
  href: string;
  action: string;
  digestChanged: boolean;
};
export type RfqRow = {
  id: string;
  title: string;
  kind: 'goods' | 'works' | 'services' | 'bundle';
  version: number;
  quotesCount: number;
  deadline: string;
  operator: string;
  status: string;
  projectId: string | null;
  projectName: string | null;
  needsDecision: boolean;
  ownerKind: 'person' | 'company';
};
export type LeadRow = { id: string; buyer: string; request: string; source: 'invitation' | 'openNeed' | 'direct' | 'email'; deadline: string; status: string; quoteVersion: number | null; needsDecision: boolean };
export type EventRow = { id: string; date: string; title: string; href: string };
export type WorkspaceProjectProgress = { done: number; total: number; percent: number; delayed: boolean };
export type WorkspaceProjectRow = {
  id: string;
  handle: string;
  href: string;
  name: string;
  summary: string | null;
  status: ProjectStatus;
  region: RegionKey;
  ownerKind: 'person' | 'company';
  ownerLabel: string;
  myRole: 'owner' | 'leader' | 'participant';
  nextMilestone: { title: string; due: string; changed: boolean } | null;
  progress: WorkspaceProjectProgress;
  participantsCount: number;
  updatedAt: string;
  isPublished: boolean;
};
export type MyPublicationRow = {
  id: string;
  title: string;
  format: PublicationCard['format'];
  authorLabel: string;
  status: PublicationStatus;
  updatedAt: string;
  shownIn: Array<{ kind: 'myWall' | 'companyWall' | 'issue'; number?: number }>;
  href: string | null;
};

export type OverviewView = {
  variant: 'mixed' | 'buyer' | 'seller' | 'personal';
  decisions: DecisionRow[];
  procurement: { show: boolean; inProgress: number; rows: RfqRow[] };
  sales: { show: boolean; inProgress: number; rows: LeadRow[]; canFillCatalogue: boolean };
  projects: WorkspaceProjectRow[];
  events: EventRow[];
  publications: MyPublicationRow[];
  assistant: AssistantSummary;
  industryPicks: PublicationCard[];
};

export type WorkspaceMilestone = {
  id: string;
  title: string;
  /** Effective due date: the changed date when the client moved it, otherwise the baseline. */
  due: string;
  baselineDue: string;
  changedDue: string | null;
  actual: string | null;
  changedByClient: boolean;
  state: 'done' | 'current' | 'upcoming';
  budget: string | null;
  shared: boolean;
};
export type WorkspaceParticipant = ProjectParticipant & { grant: string; isPublic: boolean };
export type WorkspaceProjectDetail = {
  id: string;
  handle: string;
  name: string;
  summary: string | null;
  status: ProjectStatus;
  region: RegionKey;
  ownerKind: 'person' | 'company';
  ownerLabel: string;
  ownerHref: string | null;
  leader: { label: string; href: string | null; portrait: string | null } | null;
  myRole: 'owner' | 'leader' | 'participant';
  publicity: { enabled: boolean; fields: string[]; publicHref: string | null };
  milestones: WorkspaceMilestone[];
  progress: WorkspaceProjectProgress;
  updates: ProjectDetail['updates'];
  participants: WorkspaceParticipant[];
  files: Array<{ id: string; name: string; audience: 'private' | 'participants' | 'public' }>;
  purchases: RfqRow[];
  openNeedsCount: number;
  budget: { limit: string; reserved: string; settled: string; reservedShare: number; settledShare: number } | null;
  canSeeBudget: boolean;
  nextMilestone: { title: string; due: string; changed: boolean } | null;
  updatedAt: string;
  /** Live API only (WEB-004): the revision publishing must name, the published story and whether this person may publish. */
  live?: { revision: number | null; publishedStory: string | null; canPublish: boolean };
};

export type CompanyWorkspaceView = {
  company: CompanyCard;
  myRole: 'member' | 'administrator';
  permissions: CompanyPermission[];
  pendingRequests: number;
  members: Array<{ id: string; name: string; role: 'member' | 'administrator'; status: MembershipView['status']; since: string | null; isPublic: boolean }>;
  catalogue: { version: number; publishedAt: string; entries: CatalogueEntry[] } | null;
  canSeeFloors: boolean;
  projects: WorkspaceProjectRow[];
  wall: MyPublicationRow[];
  decisions: DecisionRow[];
};

export type MeView = {
  principal: AuthenticatedPrincipal;
  publicHref: string | null;
  isPublished: boolean;
  headline: string | null;
  roleLine: string;
  topics: TopicKey[];
  decisions: DecisionRow[];
  projects: WorkspaceProjectRow[];
  publications: MyPublicationRow[];
  mandatesCount: number;
  memberships: MembershipView[];
  experience: string;
  portraitConsent: boolean;
  showEmployer: boolean;
};

export type AssistantView = {
  summary: AssistantSummary;
  mandates: Array<{ id: string; action: string; context: string; limit: string | null; validUntil: string; state: 'active' | 'paused' | 'revoked' | 'expired'; version: number; approval: 'none' | 'digest' | 'escalate' }>;
  approvals: DecisionRow[];
  runs: Array<{ id: string; title: string; state: RunState; at: string }>;
};

export type SettingsView = {
  name: string;
  email: string;
  providers: { apple: boolean; google: boolean; password: boolean };
  /** `id` and `authMethod` come with live sessions (WEB-004) and enable revoking a session. */
  sessions: Array<{ id?: string; device: string; location: string; lastSeen: string; isCurrent: boolean; authMethod?: string }>;
  pinned: { procurement: boolean; sales: boolean };
  preferences: AuthenticatedPrincipal['preferences'];
  canSeeCompanyBilling: boolean;
};

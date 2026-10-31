import type { CompanyDirectoryEntry, Membership, MyProject, ParticipantProject, Person, PersonDirectoryEntry, Principal as ContractPrincipal, Project, ProjectDirectoryEntry, PublicCompany, PublicPerson, PublicProject, SessionView } from '@trustwork/contracts/client';
import type {
  AuthenticatedPrincipal,
  CompanyCard,
  CompanyDetail,
  CompanyStatus,
  MembershipView,
  PersonCard,
  PersonDetail,
  ProjectCard,
  ProjectDetail,
  SettingsView,
  WorkspaceProjectDetail,
  WorkspaceProjectRow,
} from '../types';
import { LIVE_CONTEXT } from '../../persona';
import { personDisplayName } from '../../person-name';

/**
 * Contract projections from the live API mapped to the web view models. Only what the API returns is shown: fields
 * the API does not serve yet (categories, regions, portfolios, milestones, catalogues…) stay empty or null, and no
 * value is invented. Every public mapper takes a public projection only, so private fields cannot leak by mapping.
 */

/** URL identity: the current handle when the subject has one, otherwise the stable id (pages accept both). */
function urlName(entry: { id: string; handle?: string | null }): string {
  return entry.handle ?? entry.id;
}

/** Registered companies are neither sourced nor claimed until a claim recipe decides (BE-003); verification is separate. */
export function companyStatus(origin: 'sourced' | 'registered' | null, claim: 'unclaimed' | 'claimed' | 'verified' | null, fallback: PublicCompany['status'] | null = null): CompanyStatus {
  if (claim === 'verified') return 'verified';
  if (claim === 'claimed') return 'claimed';
  if (origin === 'registered') return 'registered';
  if (origin === 'sourced') return 'sourced';
  return fallback ?? 'sourced';
}

export type CompanyInput = { id: string; handle: string | null; name: string; status: CompanyStatus; legalIdentifiers: PublicCompany['legalIdentifiers']; publicDescription: string | null };

export function fromDirectoryCompany(entry: CompanyDirectoryEntry): CompanyInput {
  return { id: entry.id, handle: entry.handle, name: entry.name, status: companyStatus(entry.origin, entry.claimStatus), legalIdentifiers: entry.legalIdentifiers, publicDescription: entry.publicDescription };
}

/** `GET /v1/companies/:id` reports the contract status only (an unclaimed company answers `sourced`, whatever its origin). */
export function fromPublicCompany(company: PublicCompany): CompanyInput {
  return { id: company.id, handle: null, name: company.name, status: company.status, legalIdentifiers: company.legalIdentifiers, publicDescription: company.publicDescription };
}

export function toCompanyCard(company: CompanyInput): CompanyCard {
  const identifier = company.legalIdentifiers[0];
  return {
    id: company.id,
    handle: urlName(company),
    href: `/companies/${urlName(company)}`,
    name: company.name,
    status: company.status,
    kinds: [],
    signals: [],
    location: null,
    verified: company.status === 'verified',
    evidence: { identifier: identifier ? { kind: identifier.kind, status: identifier.status } : null, domainVerified: false, catalogue: null, publicMembers: 0 },
    description: company.publicDescription,
    directions: [],
    region: '',
    website: null,
    provenance: null,
    claimedAt: null,
    projectsCount: 0,
    publicationsCount: 0,
  };
}

export function toCompanyDetail(company: CompanyInput): CompanyDetail {
  return {
    ...toCompanyCard(company),
    catalogue: null,
    people: [],
    projects: [],
    publications: [],
    mentions: [],
    profile: { tagline: null, signals: [], accreditation: null, about: company.publicDescription, founded: null, geography: [], certificates: [], contacts: null, vacancies: [], updates: [], faq: [] },
  };
}

export function toPersonCard(person: PublicPerson | PersonDirectoryEntry): PersonCard {
  const handle = 'handle' in person ? person.handle : null;
  const name = urlName({ id: person.id, handle });
  return {
    id: person.id,
    handle: name,
    href: `/people/${name}`,
    displayName: personDisplayName(person.displayName),
    field: null,
    independent: true,
    signals: [],
    verified: false,
    platformCertificatesCount: 0,
    since: null,
    servicesCount: 0,
    portfolioCount: 0,
    portrait: null,
    headline: person.publicProfile.headline,
    roleLine: person.publicProfile.headline ?? '',
    expertise: person.publicProfile.expertise,
    topics: [],
    region: '',
    employer: null,
    projectsCount: 0,
    publicationsCount: 0,
  };
}

export function toPersonDetail(person: PublicPerson | PersonDirectoryEntry): PersonDetail {
  return {
    ...toPersonCard(person),
    experience: '',
    publications: [],
    mentions: [],
    projects: [],
    profile: { about: null, since: null, geography: [], signals: [], accreditation: null, platformCertificates: [], career: [], education: [], certificates: [], services: [], portfolio: [], contacts: null, faq: [] },
  };
}

export function toProjectCard(project: PublicProject | ProjectDirectoryEntry, owner: ProjectCard['owner'] | null = null): ProjectCard {
  const handle = 'handle' in project ? project.handle : null;
  const name = urlName({ id: project.id, handle });
  return {
    id: project.id,
    handle: name,
    href: `/projects/${name}`,
    name: project.name,
    summary: project.summary,
    status: project.status,
    category: null,
    region: '',
    // The public projection carries no owner (BE-001); the label stays empty rather than guessed.
    owner: owner ?? { label: '', href: null, kind: 'person' },
    publicParticipants: [],
    openNeedsCount: project.openNeedIds.length,
    progressPercent: project.status === 'completed' ? 100 : 0,
    cover: null,
    location: null,
    projectionDate: null,
    updatedAt: '',
  };
}

export function toProjectDetail(project: PublicProject | ProjectDirectoryEntry): ProjectDetail {
  return {
    ...toProjectCard(project),
    story: project.publishedStory,
    leader: null,
    participants: [],
    updates: [],
    milestones: [],
    progress: { done: 0, total: 0, percent: project.status === 'completed' ? 100 : 0, current: null, delayed: false },
    openNeeds: [],
    publicFiles: [],
    publications: [],
    mentions: [],
    startedAt: '',
    showcase: { gallery: [], video: null, highlights: [], plans: [], partnerNote: null, contact: null, passport: null, openRoles: [], materials: [], procurementPlan: [], supplierTerms: [], commercial: null, press: [], documents: [] },
  };
}

export type CompanyOfPrincipal = { company: CompanyInput; membership: Membership | null };

/** The session principal (`GET /v1/me`) and, when employed, the employer (`GET /v1/companies/:id`). */
export function toPrincipal(me: { person: Person; principal: ContractPrincipal }, employer: CompanyOfPrincipal | null): AuthenticatedPrincipal {
  const { person, principal } = me;
  const membership = principal.membership;
  return {
    kind: 'person',
    persona: 'session',
    demo: LIVE_CONTEXT,
    personId: person.id,
    displayName: personDisplayName(person.displayName),
    handle: person.id,
    preferences: person.preferences,
    pinned: { procurement: person.preferences.buying, sales: person.preferences.selling },
    onboarding: 'completed',
    company:
      membership && employer
        ? { id: membership.companyId, name: employer.company.name, handle: urlName(employer.company), status: employer.company.status, role: membership.role, permissions: membership.permissions, membershipId: membership.membershipId }
        : null,
    attention: { procurement: 0, sales: 0, projects: 0, publications: 0, assistant: 0 },
    notifications: [],
    assistant: { running: 0, approvals: 0, unknown: 0, unread: 0 },
    isPlatformAdmin: false,
    emailVerified: principal.emailVerified,
  };
}

function ownerLabel(owner: Project['owner'], principal: AuthenticatedPrincipal): string {
  if (owner.kind === 'person' && owner.id === principal.personId) return principal.displayName;
  if (owner.kind === 'company' && principal.company?.id === owner.id) return principal.company.name;
  return '';
}

function myRole(relation: MyProject['relation'], leaderPersonId: string | null, principal: AuthenticatedPrincipal): WorkspaceProjectRow['myRole'] {
  if (relation === 'owner') return 'owner';
  return leaderPersonId === principal.personId ? 'leader' : 'participant';
}

export function toWorkspaceRow(project: MyProject, principal: AuthenticatedPrincipal): WorkspaceProjectRow {
  return {
    id: project.id,
    handle: urlName(project),
    href: `/app/projects/${project.id}`,
    name: project.name,
    summary: project.summary,
    status: project.status,
    region: '',
    ownerKind: project.owner.kind,
    ownerLabel: ownerLabel(project.owner, principal),
    myRole: myRole(project.relation, project.leaderPersonId, principal),
    nextMilestone: null,
    progress: { done: 0, total: 0, percent: project.status === 'completed' ? 100 : 0, delayed: false },
    participantsCount: 0,
    updatedAt: project.createdAt,
    isPublished: project.published,
  };
}

export type ProjectRead = { projection: 'owner_private'; project: Project } | { projection: 'shared_party'; project: ParticipantProject } | { projection: 'public'; project: PublicProject };

/**
 * Workspace view of `GET /v1/projects/:id`. Only the owner and shared projections open the workspace page; a project
 * that is merely public belongs to the public page, so it answers `null` here (404, existence not disclosed).
 */
export function toWorkspaceProject(read: ProjectRead, handle: string | null, principal: AuthenticatedPrincipal): WorkspaceProjectDetail | null {
  if (read.projection === 'public') return null;
  const project = read.project;
  const owner = read.projection === 'owner_private';
  const published = owner ? read.project.publicity.enabled : false;
  const role: WorkspaceProjectRow['myRole'] = owner ? 'owner' : project.leaderPersonId === principal.personId ? 'leader' : 'participant';
  const publicName = handle ?? project.id;
  return {
    id: project.id,
    handle: publicName,
    name: project.name,
    summary: project.summary,
    status: project.status,
    region: '',
    ownerKind: project.owner.kind,
    ownerLabel: ownerLabel(project.owner, principal),
    ownerHref: null,
    leader: null,
    myRole: role,
    publicity: { enabled: published, fields: published ? ['story'] : [], publicHref: published ? `/projects/${publicName}` : null },
    milestones: [],
    progress: { done: 0, total: 0, percent: project.status === 'completed' ? 100 : 0, delayed: false },
    updates: [],
    participants: [],
    files: [],
    purchases: [],
    openNeedsCount: 0,
    budget: null,
    canSeeBudget: owner,
    nextMilestone: null,
    updatedAt: owner ? read.project.createdAt : '',
    live: {
      revision: owner ? read.project.revision : null,
      publishedStory: owner ? read.project.publicity.publishedStory : read.project.publishedStory,
      canPublish: owner && (project.owner.kind === 'person' || (principal.company?.id === project.owner.id && principal.company.permissions.includes('company.publish'))),
    },
  };
}

export function toMembershipView(membership: Membership, company: { name: string; handle: string }): MembershipView {
  return { id: membership.id, role: membership.role, permissions: membership.permissions, status: membership.status, validFrom: membership.validFrom, endedAt: membership.endedAt, companyName: company.name, companyHandle: company.handle };
}

export function toSettings(person: Person, sessions: { items: SessionView[]; currentSessionId: string }, principal: AuthenticatedPrincipal): SettingsView {
  return {
    name: principal.displayName,
    email: person.emailBindings.find((b) => b.isPrimary)?.email ?? '',
    providers: { apple: person.providerIdentities.some((x) => x.provider === 'apple'), google: person.providerIdentities.some((x) => x.provider === 'google'), password: true },
    sessions: sessions.items
      .filter((s) => s.revokedAt === null)
      .map((s) => ({ id: s.id, device: s.client.userAgentFamily, location: s.client.ipPrefix, lastSeen: s.lastSeenAt, isCurrent: s.id === sessions.currentSessionId, authMethod: s.authMethod })),
    pinned: principal.pinned,
    preferences: principal.preferences,
    canSeeCompanyBilling: principal.company?.permissions.includes('company.billing.view') ?? false,
  };
}

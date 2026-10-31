import { toPublicCompany, toPublicPerson, toPublicProject } from '@trustwork/contracts/client';
import type { CompanyFixture, EventFixture, IssueFixture, PersonFixture, ProjectFixture, PublicationFixture } from '@/fixtures/schemas';
import { DATA_SOURCE, fixtures } from './fixtures';
import type { DataPort, EventScope, Handle } from './port';
import type {
  AssistantView,
  AuthenticatedPrincipal,
  CompanyCard,
  CompanyDetail,
  CompanyWorkspaceView,
  DecisionRow,
  HomeView,
  IssueView,
  MagazineAuthor,
  RubricEntry,
  RubricKey,
  RubricSummary,
  LeadRow,
  MeView,
  MembershipView,
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
  SettingsView,
  TopicKey,
  WorkspaceProjectDetail,
  WorkspaceProjectRow,
  EventCard,
  EventDetail,
  EventSpeaker,
  EventStatus,
  Course,
  PlatformCertificate,
  ProjectMilestone,
  ProjectParticipant,
  WorkspaceMilestone,
  WorkspaceProjectProgress,
} from './types';
import type { DemoContext } from '../persona';
import { formatMoney } from '../i18n';
import { currencyCode } from '../country';

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/**
 * Fixture-backed implementation of the `DataPort` (`./port`), exported as `fixtureDataPort`. The functions
 * below stay synchronous and module-private; the port wraps each one in an async method, so callers see the
 * same contract a network-backed adapter offers. Pages never import this module: they use `data` from
 * `./index`. Public lookups take the handle (here: the fixture slug), workspace lookups take the object id.
 *
 * Projection rules mirror the contracts: public people require `profileVisibility: public`
 * (`toPublicPerson` returns null otherwise), public projects require `publicity.enabled`
 * (`toPublicProject`), company public pages use `toPublicCompany`. Unpublished handles resolve to
 * `null`, which pages turn into 404 (never 403: existence is not disclosed).
 */

const TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];
const PUBLIC_STATES = new Set(['published', 'corrected']);

function isPublished(p: PublicationFixture): boolean {
  return PUBLIC_STATES.has(p.publication.status);
}

function currentVersion(p: PublicationFixture) {
  const v = p.publication.currentVersion ?? p.versions.length;
  return p.versions.find((x) => x.version === v) ?? p.versions[p.versions.length - 1]!;
}

function authorKindOf(p: PublicationFixture): PublicationCard['authorKind'] {
  return p.publication.authorship[0]?.author.kind ?? 'editorial';
}

function authorHrefOf(p: PublicationFixture): string | null {
  const kind = authorKindOf(p);
  if (!p.authorSlug) return null;
  return kind === 'person' ? `/people/${p.authorSlug}` : kind === 'company' ? `/companies/${p.authorSlug}` : null;
}

function hrefOf(p: PublicationFixture): string {
  if (p.publication.format === 'news') return `/news/${p.slug}`;
  return `/articles/${p.slug}`;
}

function toCard(p: PublicationFixture): PublicationCard {
  const version = currentVersion(p);
  const corrected = p.publication.status === 'corrected' && version.correctionOf !== null;
  return {
    id: p.publication.id,
    slug: p.slug,
    href: hrefOf(p),
    format: p.publication.format,
    articleFormat: p.articleFormat,
    title: version.title,
    lede: p.lede,
    shortTitle: p.shortTitle ?? null,
    topics: p.topics,
    authorKind: authorKindOf(p),
    authorLabel: p.authorLabel,
    authorHref: authorHrefOf(p),
    assistantAssisted: p.publication.authorship.some((a) => a.assistantAssisted),
    publishedAt: version.publishedAt ?? p.updatedAt,
    eventTime: version.eventTime,
    isCorrected: corrected,
    correctedAt: corrected ? version.publishedAt : null,
    readMinutes: p.readMinutes,
    region: p.region,
    source: p.source,
  };
}

function publishedPublications(): PublicationFixture[] {
  return fixtures.publications.filter(isPublished).sort((a, b) => (currentVersion(b).publishedAt ?? '').localeCompare(currentVersion(a).publishedAt ?? ''));
}

function personById(id: string): PersonFixture | undefined {
  return fixtures.people.find((p) => p.person.id === id);
}
function companyById(id: string): CompanyFixture | undefined {
  return fixtures.companies.find((c) => c.company.id === id);
}
function projectById(id: string): ProjectFixture | undefined {
  return fixtures.projects.find((p) => p.project.id === id);
}
function publicationById(id: string): PublicationFixture | undefined {
  return fixtures.publications.find((p) => p.publication.id === id);
}

function partyLabel(party: { kind: 'person' | 'company'; id: string }): { label: string; href: string | null; kind: 'person' | 'company' } {
  if (party.kind === 'person') {
    const person = personById(party.id);
    const pub = person ? toPublicPerson(person.person) : null;
    return { label: pub?.displayName ?? person?.person.displayName ?? party.id, href: pub && person ? `/people/${person.slug}` : null, kind: 'person' };
  }
  const company = companyById(party.id);
  return { label: company?.company.name ?? party.id, href: company ? `/companies/${company.slug}` : null, kind: 'company' };
}

function currentEmployerOf(personId: string): CompanyFixture | null {
  const membership = fixtures.workspace.memberships.find((m) => m.personId === personId && m.status === 'active');
  return membership ? (companyById(membership.companyId) ?? null) : null;
}

/** Published materials authored by the person (authorship) or attached through `publicationIds`, newest first. */
function personPublications(p: PersonFixture): PublicationFixture[] {
  const seen = new Set<string>();
  const out: PublicationFixture[] = [];
  for (const pf of publishedPublications()) {
    const authored = pf.publication.authorship.some((a) => a.author.kind === 'person' && a.author.id === p.person.id);
    if ((authored || p.publicationIds.includes(pf.publication.id)) && !seen.has(pf.publication.id)) {
      seen.add(pf.publication.id);
      out.push(pf);
    }
  }
  return out.sort((a, b) => Date.parse(currentVersion(b).publishedAt ?? b.updatedAt) - Date.parse(currentVersion(a).publishedAt ?? a.updatedAt));
}

function personMentions(p: PersonFixture, own: Set<string>): PublicationFixture[] {
  return publishedPublications().filter((pf) => !own.has(pf.publication.id) && pf.publication.entityLinks.some((l) => l.party.kind === 'person' && l.party.id === p.person.id));
}

const EMPTY_PERSON_PROFILE = {
  about: null,
  since: null,
  geography: [],
  signals: [],
  accreditation: null,
  platformCertificates: [],
  career: [],
  education: [],
  certificates: [],
  services: [],
  portfolio: [],
  contacts: null,
  faq: [],
};

function toPersonCard(p: PersonFixture): PersonCard | null {
  const pub = toPublicPerson(p.person);
  if (!pub) return null;
  const employer = p.showEmployer ? currentEmployerOf(p.person.id) : null;
  const profile = p.profile ?? EMPTY_PERSON_PROFILE;
  return {
    id: pub.id,
    handle: p.slug,
    href: `/people/${p.slug}`,
    displayName: pub.displayName,
    field: p.field,
    independent: !employer,
    signals: profile.signals,
    verified: Boolean(profile.accreditation),
    platformCertificatesCount: (profile.platformCertificates ?? []).length,
    since: profile.since,
    servicesCount: profile.services.length,
    portfolioCount: profile.portfolio.length,
    portrait: p.portraitConsent ? (p.portrait ?? null) : null,
    headline: pub.publicProfile.headline,
    roleLine: p.roleLine,
    expertise: pub.publicProfile.expertise,
    topics: p.topics,
    region: p.region,
    employer: employer ? { name: employer.company.name, href: `/companies/${employer.slug}` } : null,
    projectsCount: p.projectIds.filter((id) => projectById(id)?.project.publicity.enabled).length,
    publicationsCount: personPublications(p).length,
  };
}

/** Published milestones with a derived state; progress = share of milestones with an actual date. */
function projectMilestones(p: ProjectFixture): ProjectMilestone[] {
  const rows = p.publishedMilestones.flatMap((m) => {
    const source = p.project.milestones.find((x) => x.id === m.milestoneId);
    return source ? [{ id: m.milestoneId, title: source.title, baselineDue: m.baselineDue, changedDue: m.changedDue, actual: m.actual, changedByClient: m.changedByClient }] : [];
  });
  let currentSet = false;
  return rows.map((m) => {
    let state: ProjectMilestone['state'] = 'upcoming';
    if (m.actual) state = 'done';
    else if (!currentSet) {
      state = 'current';
      currentSet = true;
    }
    return { ...m, state };
  });
}

function projectProgress(p: ProjectFixture): ProjectDetail['progress'] {
  const ms = projectMilestones(p);
  const done = ms.filter((m) => m.state === 'done').length;
  const total = ms.length;
  const percent = p.project.status === 'completed' ? 100 : total ? Math.round((done / total) * 100) : 0;
  return { done, total, percent, current: ms.find((m) => m.state === 'current') ?? null, delayed: ms.some((m) => m.changedDue !== null && m.actual === null) };
}

function projectParticipant(p: ProjectFixture, partyId: string): ProjectParticipant | null {
  const x = p.participants.find((pp) => pp.party.id === partyId);
  if (!x) return null;
  const label = partyLabel(x.party);
  const person = x.party.kind === 'person' ? personById(x.party.id) : null;
  const fallback: ProjectParticipant['partyRole'] = x.role === 'owner' ? (x.party.kind === 'company' ? 'developer' : 'client') : 'other';
  return { ...label, kind: x.party.kind, roleTitle: x.roleTitle, role: x.role, partyRole: x.partyRole ?? fallback, portrait: person && person.portraitConsent ? (person.portrait ?? null) : null };
}

function toProjectCard(p: ProjectFixture): ProjectCard | null {
  const pub = toPublicProject(p.project);
  if (!pub) return null;
  return {
    id: pub.id,
    handle: p.slug,
    href: `/projects/${p.slug}`,
    name: pub.name,
    summary: pub.summary,
    status: pub.status,
    category: p.category,
    region: p.region,
    owner: partyLabel(p.project.owner),
    publicParticipants: p.participants.filter((x) => x.isPublic && pub.publicParticipantIds.includes(x.party.id)).map((x) => ({ ...partyLabel(x.party), roleTitle: x.roleTitle })),
    openNeedsCount: pub.openNeedIds.length,
    progressPercent: projectProgress(p).percent,
    cover: p.showcase?.gallery[0]?.photo ?? null,
    location: p.location ?? null,
    projectionDate: p.projectionDate,
    updatedAt: p.updatedAt,
  };
}

/** Published materials authored by the company (authorship) or attached through `publicationIds`, newest first. */
function companyPublications(c: CompanyFixture): PublicationFixture[] {
  const seen = new Set<string>();
  const out: PublicationFixture[] = [];
  for (const pf of publishedPublications()) {
    const authored = pf.publication.authorship.some((a) => a.author.kind === 'company' && a.author.id === c.company.id);
    if ((authored || c.publicationIds.includes(pf.publication.id)) && !seen.has(pf.publication.id)) {
      seen.add(pf.publication.id);
      out.push(pf);
    }
  }
  return out.sort((a, b) => Date.parse(currentVersion(b).publishedAt ?? b.updatedAt) - Date.parse(currentVersion(a).publishedAt ?? a.updatedAt));
}

/** Published materials that link the company as an entity but are not authored by it. */
function companyMentions(c: CompanyFixture, own: Set<string>): PublicationFixture[] {
  return publishedPublications().filter((pf) => !own.has(pf.publication.id) && pf.publication.entityLinks.some((l) => l.party.kind === 'company' && l.party.id === c.company.id));
}

function toCompanyCard(c: CompanyFixture): CompanyCard {
  const pub = toPublicCompany(c.company);
  return {
    id: pub.id,
    handle: c.slug,
    href: `/companies/${c.slug}`,
    name: pub.name,
    status: pub.status,
    kinds: c.kinds,
    signals: c.profile?.signals ?? [],
    location: c.location ?? null,
    verified: pub.status === 'verified' && Boolean(c.profile?.accreditation),
    evidence: {
      identifier: c.company.legalIdentifiers[0] ? { kind: c.company.legalIdentifiers[0].kind, status: c.company.legalIdentifiers[0].status } : null,
      domainVerified: c.company.verifiedDomains.length > 0,
      catalogue: c.catalogue ? { version: c.catalogue.version, publishedAt: c.catalogue.publishedAt, entries: c.catalogue.entries.filter((e) => e.isPublic).length } : null,
      publicMembers: c.publicMemberPersonIds.length,
    },
    description: pub.publicDescription,
    directions: c.directions,
    region: c.region,
    website: c.website,
    provenance: c.provenance,
    claimedAt: c.claimedAt,
    projectsCount: c.projectIds.filter((id) => projectById(id)?.project.publicity.enabled).length,
    publicationsCount: companyPublications(c).length,
  };
}

/**
 * Fixture `section` → rubric key. The issue contract keeps the section as free text; the demo fixtures store
 * the rubric key itself so the mapping is locale-independent (legacy Russian labels are still accepted).
 */
const SECTION_RUBRICS: Record<string, RubricKey> = {
  analysis: 'analysis',
  practice: 'practice',
  report: 'report',
  interview: 'interview',
  people: 'people',
  projectStory: 'projectStory',
  materials: 'materials',
  opinion: 'opinion',
  week: 'week',
  numbers: 'numbers',
  qa: 'qa',
  Разбор: 'analysis',
  Практика: 'practice',
  Репортаж: 'report',
  Интервью: 'interview',
  Люди: 'people',
  'История проекта': 'projectStory',
  Материалы: 'materials',
  Мнение: 'opinion',
  'Неделя в отрасли': 'week',
  'Цифры недели': 'numbers',
  'Вопрос — ответ': 'qa',
};
const RUBRIC_KEYS: RubricKey[] = ['analysis', 'practice', 'report', 'interview', 'people', 'projectStory', 'materials', 'opinion', 'week', 'numbers', 'qa'];

function rubricOf(section: string): RubricKey {
  return SECTION_RUBRICS[section.trim()] ?? 'analysis';
}

function toIssueView(i: IssueFixture): IssueView | null {
  if (i.issue.status !== 'released' && i.issue.status !== 'corrected') return null;
  const items = [...i.issue.items]
    .sort((a, b) => a.position - b.position)
    .flatMap((item) => {
      const pf = publicationById(item.publicationId);
      if (!pf) return [];
      const version = pf.versions.find((v) => v.version === item.publicationVersion);
      if (!version) return [];
      const latest = currentVersion(pf);
      return [
        {
          position: item.position,
          section: item.section,
          rubric: rubricOf(item.section),
          title: version.title,
          slug: pf.slug,
          publicationId: pf.publication.id,
          version: version.version,
          isCorrected: latest.version !== version.version || i.corrections.some((c) => c.publicationId === pf.publication.id),
          articleFormat: pf.articleFormat,
          body: version.body,
          lede: pf.lede,
          readMinutes: pf.readMinutes,
          authorKind: authorKindOf(pf),
          authorLabel: pf.authorLabel,
          authorHref: authorHrefOf(pf),
          topics: pf.topics,
          quiz: pf.quiz ?? [],
          mentions: pf.publication.entityLinks.map((link) => partyLabel(link.party)),
        },
      ];
    });
  return {
    id: i.issue.id,
    number: i.issue.number,
    href: `/magazine/${i.issue.number}`,
    readerHref: `/magazine/${i.issue.number}/read`,
    title: i.title,
    lede: i.lede,
    dateFrom: i.dateFrom,
    dateTo: i.dateTo,
    releasedAt: i.releasedAt,
    nextReleaseAt: new Date(new Date(`${i.releasedAt}T00:00:00Z`).getTime() + 7 * 86400000).toISOString().slice(0, 10),
    edition: i.issue.edition,
    status: i.issue.status,
    itemsCount: items.length,
    readMinutes: items.reduce((a, x) => a + (x.readMinutes ?? 0), 0),
    rubrics: items.map((x) => x.rubric).filter((r, idx, arr) => arr.indexOf(r) === idx),
    items,
    pdf: i.pdf,
    poll: i.poll ?? null,
    glossary: i.glossary ?? [],
    corrections: i.corrections.map((c) => ({
      id: c.correction.id,
      itemTitle: publicationById(c.publicationId) ? currentVersion(publicationById(c.publicationId)!).title : c.publicationId,
      summary: c.summary,
      date: c.correction.correctedAt,
      fromEdition: c.correction.subject.kind === 'issue' ? c.correction.subject.fromEdition : i.issue.edition - 1,
      toEdition: c.correction.subject.kind === 'issue' ? c.correction.subject.toEdition : i.issue.edition,
    })),
  };
}

function releasedIssues(): IssueView[] {
  return fixtures.issues.flatMap((i) => toIssueView(i) ?? []).sort((a, b) => b.number - a.number);
}

// Public ---------------------------------------------------------------------------------------

function getHome(): HomeView {
  const published = publishedPublications().map(toCard);
  const featured = published.filter((p) => fixtures.publications.find((f) => f.publication.id === p.id)?.featured).slice(0, 3);
  const articles = published.filter((p) => p.format === 'article').slice(0, 5);
  const useful = published.filter((p) => fixtures.publications.find((f) => f.publication.id === p.id)?.utility).slice(0, 5);
  const topics = TOPICS.slice(0, 4).map((key) => ({ key, latest: published.find((p) => p.topics.includes(key)) ?? null }));
  return {
    featured,
    topics,
    articles,
    useful,
    currentIssue: releasedIssues()[0] ?? null,
    peopleAndProjects: { people: listPeople().slice(0, 2), projects: listPublicProjects().slice(0, 2) },
  };
}

function eventStatus(e: EventFixture, now: number): EventStatus {
  if (Date.parse(e.endsAt) < now) return 'past';
  if (!e.registrationOpen) return 'closed';
  const anyAvailable = e.tickets.some((tk) => (tk.quota === null || tk.taken < tk.quota) && (!tk.salesUntil || Date.parse(tk.salesUntil) > now));
  return anyAvailable ? 'open' : 'soldout';
}

function eventSpeaker(s: EventFixture['speakers'][number]): EventSpeaker {
  const person = s.personSlug ? fixtures.people.find((p) => p.slug === s.personSlug) : undefined;
  return { id: s.id, name: s.name, role: s.role, href: person ? `/people/${person.slug}` : null, portrait: s.portrait ?? (person?.portraitConsent ? (person.portrait ?? null) : null) };
}

function toEventCard(e: EventFixture, now = Date.now()): EventCard {
  const company = e.organizer.companySlug ? fixtures.companies.find((c) => c.slug === e.organizer.companySlug) : undefined;
  return {
    id: e.id,
    slug: e.slug,
    href: `/events/${e.slug}`,
    title: e.title,
    lede: e.lede,
    type: e.type,
    format: e.format,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    timezone: e.timezone,
    city: e.city,
    region: e.region,
    venueName: e.venue?.name ?? null,
    organizer: { kind: e.organizer.kind, name: e.organizer.name, href: company ? `/companies/${company.slug}` : null },
    cover: e.cover,
    topics: e.topics,
    status: eventStatus(e, now),
    priceFromMinorUnits: Math.min(...e.tickets.map((tk) => tk.priceMinorUnits)),
    priceToMinorUnits: Math.max(...e.tickets.map((tk) => tk.priceMinorUnits)),
    registered: e.registered,
    capacity: e.capacity,
    featured: e.featured,
    speakers: e.speakers.map(eventSpeaker),
  };
}

/** Events sorted by start; `scope` keeps upcoming (default) or past ones. */
function listEvents(scope: 'upcoming' | 'past' | 'all' = 'upcoming', now = Date.now()): EventCard[] {
  return fixtures.events
    .map((e) => toEventCard(e, now))
    .filter((e) => (scope === 'all' ? true : scope === 'past' ? e.status === 'past' : e.status !== 'past'))
    .sort((a, b) => (scope === 'past' ? Date.parse(b.startsAt) - Date.parse(a.startsAt) : Date.parse(a.startsAt) - Date.parse(b.startsAt)));
}

function getEvent(slug: string, now = Date.now()): EventDetail | null {
  const e = fixtures.events.find((x) => x.slug === slug);
  if (!e) return null;
  const card = toEventCard(e, now);
  const speakers = new Map(card.speakers.map((s) => [s.id, s]));
  const related = publishedPublications()
    .filter((p) => e.relatedPublicationSlugs.includes(p.slug))
    .map(toCard);
  return {
    ...card,
    venue: e.venue,
    onlineNote: e.onlineNote,
    body: e.body,
    program: e.program.map((row) => ({ time: row.time, title: row.title, speakers: row.speakerIds.map((id) => speakers.get(id)).filter((s): s is EventSpeaker => Boolean(s)) })),
    tickets: e.tickets.map((tk) => ({ ...tk, available: card.status === 'open' && (tk.quota === null || tk.taken < tk.quota) && (!tk.salesUntil || Date.parse(tk.salesUntil) > now) })),
    related,
    materialsHref: e.materialsHref,
  };
}

function listNews(topic?: TopicKey): PublicationCard[] {
  return publishedPublications()
    .filter((p) => p.publication.format === 'news' && (!topic || p.topics.includes(topic)))
    .map(toCard);
}

function listArticles(format?: string): PublicationCard[] {
  return publishedPublications()
    .filter((p) => p.publication.format === 'article' && (!format || format === 'all' || p.articleFormat === format))
    .map(toCard);
}

function getPublication(slug: string, format: 'news' | 'article'): PublicationDetail | null {
  const pf = fixtures.publications.find((p) => p.slug === slug);
  if (!pf || !isPublished(pf)) return null;
  const expected = format === 'news' ? pf.publication.format === 'news' : pf.publication.format !== 'news';
  if (!expected) return null;
  const card = toCard(pf);
  const version = currentVersion(pf);
  const related = publishedPublications()
    .filter((p) => p.publication.id !== pf.publication.id && p.topics.some((tp) => pf.topics.includes(tp)))
    .slice(0, 3)
    .map(toCard);
  return {
    ...card,
    body: version.body,
    version: version.version,
    correction: version.correctionOf !== null && version.correctionNote ? { note: version.correctionNote, date: version.publishedAt ?? pf.updatedAt, fromVersion: version.correctionOf } : null,
    history: pf.versions.map((v) => ({ version: v.version, publishedAt: v.publishedAt, note: v.correctionNote })),
    mentions: pf.publication.entityLinks.map((link) => partyLabel(link.party)),
    related,
  };
}

function listCompanies(): CompanyCard[] {
  return fixtures.companies.map(toCompanyCard);
}

function getCompany(handle: Handle): CompanyDetail | null {
  const c = fixtures.companies.find((x) => x.slug === handle);
  if (!c) return null;
  const card = toCompanyCard(c);
  return {
    ...card,
    catalogue: c.catalogue ? { ...c.catalogue, entries: c.catalogue.entries.filter((e) => e.isPublic).map((e) => ({ ...e, privateFloorMinorUnits: null })) } : null,
    people: c.publicMemberPersonIds.flatMap((id) => {
      const p = personById(id);
      const card = p ? toPersonCard(p) : null;
      return card ? [card] : [];
    }),
    projects: c.projectIds.flatMap((id) => {
      const p = projectById(id);
      const card = p ? toProjectCard(p) : null;
      return card ? [card] : [];
    }),
    publications: companyPublications(c).map(toCard),
    mentions: companyMentions(c, new Set(companyPublications(c).map((pf) => pf.publication.id))).map(toCard),
    profile: c.profile
      ? { ...c.profile, signals: c.profile.signals ?? [], accreditation: c.profile.accreditation ?? null }
      : { tagline: null, signals: [], accreditation: null, about: null, founded: null, geography: [], certificates: [], contacts: null, vacancies: [], updates: [], faq: [] },
  };
}

function listCourses(): Course[] {
  return fixtures.courses;
}

/** Public certificate check: the holder's public card and the course; unknown ids resolve to null. */
function getPlatformCertificate(id: string): { certificate: PlatformCertificate; holder: PersonCard } | null {
  for (const p of fixtures.people) {
    const hit = (p.profile?.platformCertificates ?? []).find((c) => c.id === id);
    if (!hit) continue;
    const course = fixtures.courses.find((x) => x.id === hit.courseId);
    const holder = toPersonCard(p);
    if (!course || !holder) return null;
    return { certificate: { id: hit.id, course, issuedAt: hit.issuedAt, score: hit.score }, holder };
  }
  return null;
}

function listPeople(): PersonCard[] {
  return fixtures.people.flatMap((p) => toPersonCard(p) ?? []);
}

function getPerson(handle: Handle): PersonDetail | null {
  const p = fixtures.people.find((x) => x.slug === handle);
  if (!p) return null;
  const card = toPersonCard(p);
  if (!card) return null;
  const own = personPublications(p);
  const pr = p.profile ?? EMPTY_PERSON_PROFILE;
  return {
    ...card,
    experience: p.experience,
    publications: own.map(toCard),
    mentions: personMentions(p, new Set(own.map((pf) => pf.publication.id))).map(toCard),
    projects: p.projectIds.flatMap((id) => {
      const prj = projectById(id);
      const c = prj ? toProjectCard(prj) : null;
      return c ? [c] : [];
    }),
    profile: {
      ...pr,
      accreditation: pr.accreditation ?? null,
      platformCertificates: (pr.platformCertificates ?? []).flatMap((c) => {
        const course = fixtures.courses.find((x) => x.id === c.courseId);
        return course ? [{ id: c.id, course, issuedAt: c.issuedAt, score: c.score }] : [];
      }),
      career: pr.career.map((c) => {
        const company = c.companyId ? companyById(c.companyId) : null;
        return { id: c.id, company: c.company, companyHref: company ? `/companies/${company.slug}` : null, role: c.role, from: c.from, to: c.to, summary: c.summary };
      }),
      portfolio: pr.portfolio.map((w) => {
        const prj = w.projectId ? projectById(w.projectId) : null;
        return { id: w.id, title: w.title, kind: w.kind, year: w.year, description: w.description, cover: w.cover, projectHref: prj ? `/projects/${prj.slug}` : null };
      }),
    },
  };
}

function listPublicProjects(): ProjectCard[] {
  return fixtures.projects.flatMap((p) => toProjectCard(p) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getPublicProject(handle: Handle): ProjectDetail | null {
  const p = fixtures.projects.find((x) => x.slug === handle);
  if (!p) return null;
  const card = toProjectCard(p);
  if (!card) return null;
  const pub = toPublicProject(p.project)!;
  const participants = p.participants
    .filter((x) => x.isPublic && pub.publicParticipantIds.includes(x.party.id))
    .flatMap((x) => {
      const pp = projectParticipant(p, x.party.id);
      return pp ? [pp] : [];
    });
  const leaderFixture = p.project.leaderPersonId ? personById(p.project.leaderPersonId) : null;
  const leaderPublic = leaderFixture && pub.publicParticipantIds.includes(leaderFixture.person.id) ? leaderFixture : null;
  const show = p.showcase;
  return {
    ...card,
    story: pub.publishedStory,
    leader: leaderPublic ? { label: leaderPublic.person.displayName, href: `/people/${leaderPublic.slug}`, portrait: leaderPublic.portraitConsent ? (leaderPublic.portrait ?? null) : null } : null,
    participants,
    updates: p.updates.filter((u) => u.isPublic).map(({ id, type, title, date, evidence }) => ({ id, type, title, date, evidence })),
    milestones: projectMilestones(p),
    progress: projectProgress(p),
    openNeeds: pub.openNeedIds.flatMap((id) => {
      const rfq = fixtures.workspace.rfqs.find((r) => r.id === id);
      const extra = show?.needs.find((n) => n.rfqId === id);
      return rfq
        ? [
            {
              id: rfq.id,
              title: rfq.title,
              kind: rfq.kind,
              region: p.region,
              deadline: rfq.deadline,
              summary: extra?.summary ?? null,
              quantity: extra?.quantity ?? null,
              unit: extra?.unit ?? null,
              quotesCount: rfq.quotesCount,
            },
          ]
        : [];
    }),
    publicFiles: p.files.filter((f) => f.audience === 'public').map((f) => ({ id: f.id, name: f.name, kind: f.kind ?? 'other' })),
    publications: p.publicationIds.flatMap((id) => {
      const pf = publicationById(id);
      return pf && isPublished(pf) ? [toCard(pf)] : [];
    }),
    mentions: [],
    startedAt: p.project.createdAt,
    showcase: {
      gallery: show?.gallery ?? [],
      video: show?.video ?? null,
      highlights: show?.highlights ?? [],
      plans: show?.plans ?? [],
      partnerNote: show?.partnerNote ?? null,
      contact: show?.contactPartyId ? projectParticipant(p, show.contactPartyId) : null,
      passport: show?.passport ?? null,
      openRoles: show?.openRoles ?? [],
      materials: (show?.materials ?? []).map((m) => {
        const supplier = m.supplierPartyId ? partyLabel({ kind: 'company', id: m.supplierPartyId }) : m.supplierName ? { label: m.supplierName, href: null } : null;
        return { id: m.id, name: m.name, supplier, status: m.status };
      }),
      procurementPlan: show?.procurementPlan ?? [],
      supplierTerms: show?.supplierTerms ?? [],
      commercial: show?.commercial
        ? {
            offering: show.commercial.offering,
            infrastructure: show.commercial.infrastructure,
            audiences: show.commercial.audiences.map((a) => ({
              id: a.id,
              kind: a.kind,
              title: a.title,
              description: a.description,
              units: a.units,
              terms: a.terms,
              commercialTerms: a.commercialTerms ?? [],
              files: a.fileIds.flatMap((fid) => p.files.filter((f) => f.id === fid && f.audience === 'public').map((f) => ({ id: f.id, name: f.name, kind: f.kind ?? 'other' }))),
              faq: a.faq,
              action: a.action,
            })),
            note: show.commercial.note,
            contact: show.commercial.contactPartyId ? projectParticipant(p, show.commercial.contactPartyId) : null,
            salesOffice: show.commercial.salesOffice,
          }
        : null,
      press: show?.press ?? [],
      documents: show?.documents ?? [],
    },
  };
}

function getMagazine(): { current: IssueView | null; archive: IssueView[] } {
  const issues = releasedIssues();
  return { current: issues[0] ?? null, archive: issues };
}

function listRubrics(): RubricSummary[] {
  const issues = releasedIssues();
  return RUBRIC_KEYS.map((key) => {
    const hits = issues.filter((i) => i.items.some((x) => x.rubric === key));
    return { key, count: issues.reduce((a, i) => a + i.items.filter((x) => x.rubric === key).length, 0), latestIssue: hits[0]?.number ?? null };
  });
}

function listRubricEntries(key: RubricKey): RubricEntry[] {
  return releasedIssues().flatMap((i) =>
    i.items.filter((x) => x.rubric === key).map((item) => ({ item, issue: { number: i.number, title: i.title, href: i.href, readerHref: i.readerHref, dateFrom: i.dateFrom, dateTo: i.dateTo } })),
  );
}

/** People and companies credited in released issues (editorial pieces count under «Редакция»), most prolific first. */
function listMagazineAuthors(): MagazineAuthor[] {
  const counts = new Map<string, MagazineAuthor>();
  for (const i of releasedIssues())
    for (const x of i.items) {
      const id = `${x.authorKind}:${x.authorHref ?? x.authorLabel}`;
      const hit = counts.get(id);
      if (hit) hit.count += 1;
      else {
        const slug = x.authorKind === 'person' && x.authorHref ? (x.authorHref.split('/').pop() ?? null) : null;
        const person = slug ? (listPeople().find((p) => p.handle === slug) ?? null) : null;
        counts.set(id, { label: x.authorLabel, href: x.authorHref, kind: x.authorKind, count: 1, person });
      }
    }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function getIssue(number: number): { issue: IssueView; previous: IssueView | null; next: IssueView | null } | null {
  const issues = releasedIssues();
  const index = issues.findIndex((i) => i.number === number);
  if (index === -1) return null;
  return { issue: issues[index]!, previous: issues[index + 1] ?? null, next: issues[index - 1] ?? null };
}

// Workspace ------------------------------------------------------------------------------------

function requirePerson(principal: Principal): AuthenticatedPrincipal {
  if (principal.kind !== 'person') throw new Error('workspace data requires an authenticated principal');
  return principal;
}

function withDemoHref(demo: DemoContext, href: string): string {
  if (demo.persona === demo.defaultPersona) return href;
  const [path, hash] = href.split('#');
  return `${path}${path?.includes('?') ? '&' : '?'}persona=${demo.persona}${hash ? `#${hash}` : ''}`;
}

function membershipsOf(personId: string): MembershipView[] {
  return fixtures.workspace.memberships
    .filter((m) => m.personId === personId)
    .map((m) => {
      const company = companyById(m.companyId);
      return { id: m.id, role: m.role, permissions: m.permissions, status: m.status, validFrom: m.validFrom, endedAt: m.endedAt, companyName: company?.company.name ?? m.companyId, companyHandle: company?.slug ?? '' };
    });
}

function decisionsOf(personId: string): DecisionRow[] {
  return fixtures.workspace.decisions.filter((d) => d.personId === personId).map((d) => omit(d, 'personId'));
}

function toRfqRow(r: (typeof fixtures.workspace.rfqs)[number]): RfqRow {
  const operator = personById(r.operatorPersonId)?.person.displayName ?? r.operatorPersonId;
  const project = r.projectId ? projectById(r.projectId) : undefined;
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    version: r.version,
    quotesCount: r.quotesCount,
    deadline: r.deadline,
    operator,
    status: r.status,
    projectId: r.projectId,
    projectName: project?.project.name ?? null,
    needsDecision: r.needsDecision,
    ownerKind: r.owner.kind,
  };
}

/** RFQs the principal may see: company RFQs with the deals grant, plus personally owned ones. */
function listRfqs(principal: Principal): RfqRow[] {
  const p = requirePerson(principal);
  const canSeeCompany = p.company !== null && p.company.permissions.includes('company.deals.manage');
  return fixtures.workspace.rfqs.filter((r) => (r.owner.kind === 'person' && r.owner.id === p.personId) || (canSeeCompany && r.owner.kind === 'company' && r.owner.id === p.company!.id)).map(toRfqRow);
}

function listLeads(principal: Principal): LeadRow[] {
  const p = requirePerson(principal);
  if (!p.company || !p.company.permissions.includes('company.deals.manage')) return [];
  return fixtures.workspace.leads.filter((l) => l.companyId === p.company!.id).map((l) => omit(l, 'companyId'));
}

function roleIn(project: ProjectFixture, principal: AuthenticatedPrincipal): 'owner' | 'leader' | 'participant' | null {
  const owner = project.project.owner;
  if (owner.kind === 'person' && owner.id === principal.personId) return 'owner';
  if (owner.kind === 'company' && principal.company && owner.id === principal.company.id) return project.project.leaderPersonId === principal.personId ? 'leader' : 'owner';
  if (project.project.leaderPersonId === principal.personId) return 'leader';
  if (project.project.participantIds.includes(principal.personId)) return 'participant';
  if (principal.company && project.project.participantIds.includes(principal.company.id) && principal.company.permissions.includes('company.deals.manage')) return 'participant';
  return null;
}

function nextMilestoneOf(project: ProjectFixture, role: 'owner' | 'leader' | 'participant'): WorkspaceProjectRow['nextMilestone'] {
  const visible = project.project.milestones.filter((m) => role !== 'participant' || m.shared).sort((a, b) => a.due.date.localeCompare(b.due.date));
  const next = visible.find((m) => !project.publishedMilestones.some((pm) => pm.milestoneId === m.id && pm.actual));
  if (!next) return null;
  const published = project.publishedMilestones.find((pm) => pm.milestoneId === next.id);
  return { title: next.title, due: published?.changedDue ?? next.due.date, changed: Boolean(published?.changedDue) };
}

/** Milestones the role may see, joined with the published actual/changed dates; the first unfinished one is current. */
function workspaceMilestones(project: ProjectFixture, role: 'owner' | 'leader' | 'participant', canSeeBudget: boolean): WorkspaceMilestone[] {
  let currentFound = false;
  return project.project.milestones
    .filter((m) => role !== 'participant' || m.shared)
    .slice()
    .sort((a, b) => a.due.date.localeCompare(b.due.date))
    .map((m) => {
      const pub = project.publishedMilestones.find((pm) => pm.milestoneId === m.id);
      const actual = pub?.actual ?? null;
      let state: WorkspaceMilestone['state'] = 'upcoming';
      if (actual) state = 'done';
      else if (!currentFound) {
        currentFound = true;
        state = 'current';
      }
      return {
        id: m.id,
        title: m.title,
        due: pub?.changedDue ?? m.due.date,
        baselineDue: pub?.baselineDue ?? m.due.date,
        changedDue: pub?.changedDue ?? null,
        actual,
        changedByClient: pub?.changedByClient ?? false,
        state,
        budget: canSeeBudget && m.budget ? formatMoney(m.budget.minorUnits, m.budget.currency) : null,
        shared: m.shared,
      };
    });
}

function workspaceProgress(project: ProjectFixture, ms: WorkspaceMilestone[]): WorkspaceProjectProgress {
  const done = ms.filter((m) => m.state === 'done').length;
  const total = ms.length;
  const percent = project.project.status === 'completed' ? 100 : total ? Math.round((done / total) * 100) : 0;
  return { done, total, percent, delayed: ms.some((m) => m.changedDue !== null && m.actual === null) };
}

function toWorkspaceRow(project: ProjectFixture, role: 'owner' | 'leader' | 'participant', demo: DemoContext): WorkspaceProjectRow {
  const owner = partyLabel(project.project.owner);
  const ms = workspaceMilestones(project, role, false);
  return {
    id: project.project.id,
    handle: project.slug,
    href: withDemoHref(demo, `/app/projects/${project.project.id}`),
    name: project.project.name,
    summary: project.project.summary,
    status: project.project.status,
    region: project.region,
    ownerKind: project.project.owner.kind,
    ownerLabel: owner.label,
    myRole: role,
    nextMilestone: nextMilestoneOf(project, role),
    progress: workspaceProgress(project, ms),
    participantsCount: project.participants.length,
    updatedAt: project.updatedAt,
    isPublished: project.project.publicity.enabled,
  };
}

function listWorkspaceProjects(principal: Principal): WorkspaceProjectRow[] {
  const p = requirePerson(principal);
  return fixtures.projects
    .flatMap((project) => {
      const role = roleIn(project, p);
      return role ? [toWorkspaceRow(project, role, p.demo)] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getWorkspaceProject(principal: Principal, id: string): WorkspaceProjectDetail | null {
  const p = requirePerson(principal);
  const project = projectById(id);
  if (!project) return null;
  const role = roleIn(project, p);
  if (!role) return null;
  const canSeeBudget = role === 'owner';
  const owner = partyLabel(project.project.owner);
  const leaderFixture = project.project.leaderPersonId ? personById(project.project.leaderPersonId) : undefined;
  const leader = leaderFixture ? { ...partyLabel({ kind: 'person', id: leaderFixture.person.id }), portrait: leaderFixture.portraitConsent ? (leaderFixture.portrait ?? null) : null } : null;
  const milestones = workspaceMilestones(project, role, canSeeBudget);
  const next = nextMilestoneOf(project, role);
  const limit = project.project.budgets[0]?.limit;
  const share = (minor: string) => (limit ? Math.min(100, Math.round((Number(minor) / Number(limit.minorUnits)) * 100)) : 0);
  return {
    id: project.project.id,
    handle: project.slug,
    name: project.project.name,
    summary: project.project.summary,
    status: project.project.status,
    region: project.region,
    ownerKind: project.project.owner.kind,
    ownerLabel: owner.label,
    ownerHref: owner.href,
    leader: leader ? { label: leader.label, href: leader.href, portrait: leader.portrait } : null,
    myRole: role,
    publicity: {
      enabled: project.project.publicity.enabled,
      fields: project.project.publicity.enabled ? ['story', 'milestones', 'participants'] : [],
      publicHref: project.project.publicity.enabled ? `/projects/${project.slug}` : null,
    },
    milestones,
    progress: workspaceProgress(project, milestones),
    updates: project.updates.filter((u) => role !== 'participant' || u.isPublic).map(({ id, type, title, date, evidence }) => ({ id, type, title, date, evidence })),
    participants: project.participants
      .filter((x) => role !== 'participant' || x.isPublic || x.party.id === p.personId || x.party.id === p.company?.id)
      .flatMap((x) => {
        const participant = projectParticipant(project, x.party.id);
        return participant ? [{ ...participant, roleTitle: x.roleTitle, role: x.role, grant: x.grant, isPublic: x.isPublic }] : [];
      }),
    files: project.files.filter((f) => role !== 'participant' || f.audience !== 'private'),
    purchases: role === 'participant' ? [] : fixtures.workspace.rfqs.filter((r) => r.projectId === project.project.id).map(toRfqRow),
    openNeedsCount: project.project.publicity.openNeedIds.length,
    budget:
      canSeeBudget && limit && project.budget
        ? {
            limit: formatMoney(limit.minorUnits, limit.currency),
            reserved: formatMoney(project.budget.reservedMinorUnits, limit.currency),
            settled: formatMoney(project.budget.settledMinorUnits, limit.currency),
            reservedShare: share(project.budget.reservedMinorUnits),
            settledShare: share(project.budget.settledMinorUnits),
          }
        : null,
    canSeeBudget,
    nextMilestone: next,
    updatedAt: project.updatedAt,
  };
}

function myPublications(principal: AuthenticatedPrincipal): MyPublicationRow[] {
  const canSeeCompany = principal.company !== null && principal.company.permissions.includes('company.publish');
  return fixtures.publications
    .filter((pf) => {
      const author = pf.publication.authorship[0]?.author;
      if (!author) return false;
      if (author.kind === 'person' && author.id === principal.personId) return true;
      if (author.kind === 'company' && canSeeCompany && author.id === principal.company!.id) return true;
      return pf.publication.editors.includes(principal.personId);
    })
    .map((pf) => {
      const version = currentVersion(pf);
      const author = pf.publication.authorship[0]!.author;
      const shownIn: MyPublicationRow['shownIn'] = [];
      if (isPublished(pf)) shownIn.push({ kind: author.kind === 'company' ? 'companyWall' : 'myWall' });
      for (const issue of fixtures.issues) if (issue.issue.items.some((i) => i.publicationId === pf.publication.id)) shownIn.push({ kind: 'issue', number: issue.issue.number });
      return {
        id: pf.publication.id,
        title: version.title,
        format: pf.publication.format,
        authorLabel: pf.authorLabel,
        status: pf.publication.status,
        updatedAt: pf.updatedAt,
        shownIn,
        href: isPublished(pf) ? hrefOf(pf) : null,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function listMyPublications(principal: Principal): MyPublicationRow[] {
  return myPublications(requirePerson(principal));
}

function getOverview(principal: Principal): OverviewView {
  const p = requirePerson(principal);
  const rfqs = listRfqs(p);
  const leads = listLeads(p);
  const showProcurement = p.preferences.buying || rfqs.length > 0;
  const showSales = (p.preferences.selling && p.company !== null) || leads.length > 0;
  const variant: OverviewView['variant'] = showProcurement && showSales ? 'mixed' : showProcurement ? 'buyer' : showSales ? 'seller' : 'personal';
  const assistant = fixtures.workspace.assistant.find((a) => a.personId === p.personId);
  const closed = new Set(['closed', 'expired', 'cancelled', 'accepted', 'reviewed']);
  return {
    variant,
    decisions: decisionsOf(p.personId).map((d) => ({ ...d, href: withDemoHref(p.demo, d.href) })),
    procurement: { show: showProcurement, inProgress: rfqs.filter((r) => !closed.has(r.status)).length, rows: rfqs.slice(0, 4) },
    sales: {
      show: showSales,
      inProgress: leads.filter((l) => !['won', 'lost', 'expired'].includes(l.status)).length,
      rows: leads.slice(0, 4),
      canFillCatalogue: p.company?.permissions.includes('company.catalogue.edit') ?? false,
    },
    projects: listWorkspaceProjects(p).slice(0, 4),
    events: fixtures.workspace.events
      .filter((e) => e.personIds.includes(p.personId))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => omit(e, 'personIds'))
      .map((e) => ({ ...e, href: e.href.startsWith('/app') ? withDemoHref(p.demo, e.href) : e.href })),
    publications: myPublications(p).filter((x) => x.status === 'draft' || x.status === 'in_review' || x.status === 'scheduled'),
    assistant: { running: assistant?.running ?? 0, approvals: assistant?.approvals ?? 0, unknown: assistant?.unknown ?? 0, unread: assistant?.unread ?? 0 },
    industryPicks: publishedPublications().slice(0, 3).map(toCard),
  };
}

function getCompanyWorkspace(principal: Principal): CompanyWorkspaceView | null {
  const p = requirePerson(principal);
  if (!p.company) return null;
  const c = companyById(p.company.id);
  if (!c) return null;
  const canSeeFloors = p.company.permissions.includes('company.catalogue.edit');
  const isAdmin = p.company.role === 'administrator';
  return {
    company: toCompanyCard(c),
    myRole: p.company.role,
    permissions: p.company.permissions,
    pendingRequests: isAdmin ? c.company.membershipRequests.length : 0,
    members: fixtures.workspace.memberships
      .filter((m) => m.companyId === c.company.id && m.status !== 'ended')
      .map((m) => ({ id: m.id, name: personById(m.personId)?.person.displayName ?? m.personId, role: m.role, status: m.status, since: m.validFrom, isPublic: c.publicMemberPersonIds.includes(m.personId) })),
    catalogue: c.catalogue ? { ...c.catalogue, entries: c.catalogue.entries.map((e) => ({ ...e, privateFloorMinorUnits: canSeeFloors ? e.privateFloorMinorUnits : null })) } : null,
    canSeeFloors,
    projects: listWorkspaceProjects(p).filter((r) => r.ownerKind === 'company'),
    wall: myPublications(p).filter((x) => x.authorLabel === c.company.name),
    decisions: decisionsOf(p.personId)
      .filter((d) => d.kind !== 'publicationReview')
      .map((d) => ({ ...d, href: withDemoHref(p.demo, d.href) })),
  };
}

function getMe(principal: Principal): MeView {
  const p = requirePerson(principal);
  const pf = personById(p.personId)!;
  const isPublished = pf.person.profileVisibility === 'public';
  const assistant = fixtures.workspace.assistant.find((a) => a.personId === p.personId);
  return {
    principal: p,
    publicHref: isPublished ? `/people/${pf.slug}` : null,
    isPublished,
    headline: pf.person.publicProfile.headline,
    roleLine: pf.roleLine,
    topics: pf.topics,
    decisions: decisionsOf(p.personId).map((d) => ({ ...d, href: withDemoHref(p.demo, d.href) })),
    projects: listWorkspaceProjects(p),
    publications: myPublications(p),
    mandatesCount: assistant?.mandates.length ?? 0,
    memberships: membershipsOf(p.personId),
    experience: pf.experience,
    portraitConsent: pf.portraitConsent,
    showEmployer: pf.showEmployer,
  };
}

function getAssistant(principal: Principal): AssistantView {
  const p = requirePerson(principal);
  const a = fixtures.workspace.assistant.find((x) => x.personId === p.personId);
  return {
    summary: { running: a?.running ?? 0, approvals: a?.approvals ?? 0, unknown: a?.unknown ?? 0, unread: a?.unread ?? 0 },
    mandates: (a?.mandates ?? []).map((m) => ({
      id: m.id,
      action: m.action,
      context: m.context,
      limit: m.limitMinorUnits ? formatMoney(m.limitMinorUnits, currencyCode()) : null,
      validUntil: m.validUntil,
      state: m.state,
      version: m.version,
      approval: m.approval,
    })),
    approvals: decisionsOf(p.personId)
      .filter((d) => d.kind === 'approvalDigest')
      .map((d) => ({ ...d, href: withDemoHref(p.demo, d.href) })),
    runs: a?.runs ?? [],
  };
}

function getSettings(principal: Principal): SettingsView {
  const p = requirePerson(principal);
  const pf = personById(p.personId)!;
  return {
    name: pf.person.displayName,
    email: pf.person.emailBindings.find((b) => b.isPrimary)?.email ?? '',
    providers: { apple: pf.person.providerIdentities.some((x) => x.provider === 'apple'), google: pf.person.providerIdentities.some((x) => x.provider === 'google'), password: true },
    sessions: fixtures.workspace.sessions.filter((s) => s.personId === p.personId).map((s) => omit(s, 'personId')),
    pinned: p.pinned,
    preferences: p.preferences,
    canSeeCompanyBilling: p.company?.permissions.includes('company.billing.view') ?? false,
  };
}

/** Builds the authenticated principal for a persona (null for anonymous or unknown personas). */
function principalFor(demo: DemoContext): AuthenticatedPrincipal | null {
  if (demo.persona === 'anonymous') return null;
  const entry = fixtures.workspace.personas[demo.persona];
  const pf = entry ? personById(entry.personId) : undefined;
  if (!entry || !pf) return null;
  const membership = fixtures.workspace.memberships.find((m) => m.personId === pf.person.id && m.status === 'active');
  const company = membership ? companyById(membership.companyId) : undefined;
  const assistant = fixtures.workspace.assistant.find((a) => a.personId === pf.person.id);
  const base: AuthenticatedPrincipal = {
    kind: 'person',
    persona: demo.persona,
    demo,
    personId: pf.person.id,
    displayName: pf.person.displayName,
    handle: pf.slug,
    preferences: pf.person.preferences,
    pinned: entry.pinned,
    onboarding: entry.onboarding,
    company:
      membership && company
        ? { id: company.company.id, name: company.company.name, handle: company.slug, status: company.company.status, role: membership.role, permissions: membership.permissions, membershipId: membership.id }
        : null,
    attention: { procurement: 0, sales: 0, projects: 0, publications: 0, assistant: assistant?.approvals ?? 0 },
    notifications: fixtures.workspace.notifications
      .filter((n) => n.personIds.includes(pf.person.id))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((n) => omit(n, 'personIds'))
      .map((n) => ({ ...n, href: n.href.startsWith('/app') ? withDemoHref(demo, n.href) : n.href })),
    assistant: { running: assistant?.running ?? 0, approvals: assistant?.approvals ?? 0, unknown: assistant?.unknown ?? 0, unread: assistant?.unread ?? 0 },
    isPlatformAdmin: false,
  };
  base.attention.procurement = listRfqs(base).filter((r) => r.needsDecision).length;
  base.attention.sales = listLeads(base).filter((l) => l.needsDecision).length;
  base.attention.publications = myPublications(base).filter((x) => x.status === 'in_review').length;
  return base;
}

// Port -----------------------------------------------------------------------------------------

/**
 * The fixture adapter as a `DataPort`. `satisfies` makes the compiler prove conformance here as well
 * (tests/web/data-port checks it from the outside, including that a synchronous adapter is rejected).
 */
export const fixtureDataPort = {
  source: DATA_SOURCE,
  getHome: async () => getHome(),
  listEvents: async (scope?: EventScope, now?: number) => listEvents(scope, now),
  getEvent: async (slug: string, now?: number) => getEvent(slug, now),
  listNews: async (topic?: TopicKey) => listNews(topic),
  listArticles: async (format?: string) => listArticles(format),
  getPublication: async (slug: string, format: 'news' | 'article') => getPublication(slug, format),
  listCompanies: async () => listCompanies(),
  getCompany: async (handle: Handle) => getCompany(handle),
  listPeople: async () => listPeople(),
  getPerson: async (handle: Handle) => getPerson(handle),
  listPublicProjects: async () => listPublicProjects(),
  getPublicProject: async (handle: Handle) => getPublicProject(handle),
  listCourses: async () => listCourses(),
  getPlatformCertificate: async (id: string) => getPlatformCertificate(id),
  getMagazine: async () => getMagazine(),
  listRubrics: async () => listRubrics(),
  listRubricEntries: async (key: RubricKey) => listRubricEntries(key),
  listMagazineAuthors: async () => listMagazineAuthors(),
  getIssue: async (number: number) => getIssue(number),
  getOverview: async (principal: Principal) => getOverview(principal),
  listRfqs: async (principal: Principal) => listRfqs(principal),
  listLeads: async (principal: Principal) => listLeads(principal),
  listWorkspaceProjects: async (principal: Principal) => listWorkspaceProjects(principal),
  getWorkspaceProject: async (principal: Principal, id: string) => getWorkspaceProject(principal, id),
  listMyPublications: async (principal: Principal) => listMyPublications(principal),
  getCompanyWorkspace: async (principal: Principal) => getCompanyWorkspace(principal),
  getMe: async (principal: Principal) => getMe(principal),
  getAssistant: async (principal: Principal) => getAssistant(principal),
  getSettings: async (principal: Principal) => getSettings(principal),
  principalFor: async (demo: DemoContext) => principalFor(demo),
} satisfies DataPort;

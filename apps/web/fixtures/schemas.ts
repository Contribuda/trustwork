import { z } from 'zod';
import { CompanySchema, CorrectionSchema, IdSchema, IssueSchema, MembershipSchema, PersonSchema, ProjectSchema, PublicationSchema, PublicationVersionSchema, TimestampSchema } from '@trustwork/contracts/client';

/**
 * Fixture envelopes for apps/web. Domain records are typed with the frozen contract schemas
 * (`@trustwork/contracts/client`); presentation-only fields the contracts do not model yet
 * (slugs, topic keys, source labels, demo workspace rows) are wrapped around them here.
 * Validated at module load (apps/web/app/_lib/data/fixtures.ts) and by tests/web/fixtures.test.ts.
 *
 * Every file carries `synthetic: true`; names and numbers are invented and never presented as real.
 */

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/);
const Date = z.iso.date();
/** ISO 3166-2 code of the active country pack (validated against the pack in tests). */
const RegionKey = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
const TopicKey = z.enum(['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events']);
const ArticleFormat = z.enum(['analysis', 'practice', 'experience', 'opinion', 'interview', 'projectStory', 'overview']);
const Party = z.strictObject({ kind: z.enum(['person', 'company']), id: IdSchema });

const Envelope = { synthetic: z.literal(true), description: z.string().min(1) };

export const CertificateKind = z.enum(['sro', 'permit', 'declaration', 'technical', 'education', 'membership', 'other']);
export const CertificateSchema = z.strictObject({
  id: IdSchema,
  kind: CertificateKind,
  name: z.string().min(1).max(160),
  issuer: z.string().min(1).max(120),
  number: z.string().max(40).nullable(),
  validUntil: Date.nullable(),
  evidence: z.enum(['asserted', 'confirmed']),
});
/** Platform accreditation («verified by the platform»): what was checked and when. */
export const AccreditationSchema = z.strictObject({ verifiedAt: Date, scope: z.array(z.string().min(1).max(80)).min(1) }).nullable();
export const PlatformCertificateSchema = z.strictObject({ id: IdSchema, courseId: IdSchema, issuedAt: Date, score: z.int().min(0).max(100).nullable() });
export const CourseFixtureSchema = z.strictObject({
  id: IdSchema,
  slug: Slug,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(400),
  durationMinutes: z.int().min(10).max(600),
  modules: z.int().min(1).max(30),
  topics: z.array(TopicKey),
});
export const CoursesFileSchema = z.strictObject({ ...Envelope, courses: z.array(CourseFixtureSchema) });
export const PersonSignalKind = z.enum(['openToWork', 'openToProjects', 'hiring', 'lookingForPartners', 'consulting', 'busy']);
export const CompanySignalKind = z.enum(['hiring', 'acceptingOrders', 'lookingForSubcontractors', 'lookingForSuppliers', 'lookingForPartners', 'lookingForProjects', 'paused']);
const SignalExtras = { note: z.string().max(160).nullable(), until: Date.nullable() };
export const PersonSignalSchema = z.strictObject({ kind: PersonSignalKind, ...SignalExtras });
export const CompanySignalSchema = z.strictObject({ kind: CompanySignalKind, ...SignalExtras });
export const PersonField = z.enum(['management', 'engineering', 'design', 'procurement', 'sales', 'production', 'construction', 'logistics', 'control', 'client']);
export const PersonProfileSchema = z.strictObject({
  about: z.string().max(4000).nullable(),
  since: z.int().min(1950).max(2100).nullable(),
  geography: z.array(z.string().min(1).max(80)),
  /** Self-declared public statuses («open to work», «taking projects»…), several at once. */
  signals: z.array(PersonSignalSchema),
  accreditation: AccreditationSchema.optional(),
  platformCertificates: z.array(PlatformCertificateSchema).optional(),
  career: z.array(
    z.strictObject({
      id: IdSchema,
      company: z.string().min(1).max(120),
      companyId: IdSchema.nullable(),
      role: z.string().min(1).max(120),
      from: z.int().min(1950).max(2100),
      to: z.int().min(1950).max(2100).nullable(),
      summary: z.string().max(400).nullable(),
    }),
  ),
  education: z.array(z.strictObject({ id: IdSchema, school: z.string().min(1).max(160), degree: z.string().min(1).max(160), year: z.int().min(1950).max(2100).nullable() })),
  certificates: z.array(CertificateSchema),
  services: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1).max(120), description: z.string().max(400).nullable(), format: z.enum(['onsite', 'remote', 'both']), unit: z.string().max(40).nullable() })),
  portfolio: z.array(
    z.strictObject({
      id: IdSchema,
      title: z.string().min(1).max(160),
      kind: z.string().min(1).max(80),
      year: z.int().min(1950).max(2100).nullable(),
      description: z.string().max(400).nullable(),
      cover: z.string().max(80).nullable(),
      projectId: IdSchema.nullable(),
    }),
  ),
  contacts: z.strictObject({ email: z.string().max(120).nullable(), phone: z.string().max(40).nullable(), telegram: z.string().max(64).nullable() }).nullable(),
  faq: z.array(z.strictObject({ q: z.string().min(1).max(200), a: z.string().min(1).max(1000) })),
});
export const PersonFixtureSchema = z.strictObject({
  slug: Slug,
  person: PersonSchema,
  roleLine: z.string().min(1).max(120),
  /** Field of activity for hub filters (workers to managers). */
  field: PersonField,
  region: RegionKey,
  topics: z.array(TopicKey),
  showEmployer: z.boolean(),
  portraitConsent: z.boolean(),
  /** Manifest id of the consented portrait (demo profiles only); null → initials. */
  portrait: z.string().nullable().optional(),
  experience: z.string().max(2000),
  publicationIds: z.array(IdSchema),
  projectIds: z.array(IdSchema),
  /** Public profile extras (synthetic): about, career, education, certificates, services, portfolio, contacts, FAQ. */
  profile: PersonProfileSchema.nullable().optional(),
});
export type PersonFixture = z.infer<typeof PersonFixtureSchema>;
export const PeopleFileSchema = z.strictObject({ ...Envelope, people: z.array(PersonFixtureSchema) });

export const CatalogueEntrySchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  kind: z.enum(['goods', 'works', 'services', 'bundle']),
  unit: z.enum(['t', 'm2', 'm3', 'pcs', 'set']),
  priceOnRequest: z.boolean(),
  /** Public entries appear on the company page; private floors never leave the workspace. */
  isPublic: z.boolean(),
  /** owner_private, shown only to members with the catalogue grant. */
  privateFloorMinorUnits: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .nullable(),
});
export const CompanyProfileSchema = z.strictObject({
  tagline: z.string().min(1).max(160).nullable(),
  /** Self-declared public statuses («hiring», «accepting orders»…). */
  signals: z.array(CompanySignalSchema).optional(),
  accreditation: AccreditationSchema.optional(),
  about: z.string().max(4000).nullable(),
  founded: z.int().min(1900).max(2100).nullable(),
  geography: z.array(z.string().min(1).max(80)),
  certificates: z.array(CertificateSchema),
  contacts: z.strictObject({ email: z.string().max(120).nullable(), phone: z.string().max(40).nullable(), address: z.string().max(200).nullable(), hours: z.string().max(80).nullable() }).nullable(),
  vacancies: z.array(
    z.strictObject({
      id: IdSchema,
      title: z.string().min(1).max(120),
      location: z.string().min(1).max(80),
      format: z.enum(['office', 'site', 'remote', 'hybrid']),
      employment: z.enum(['full', 'part', 'contract']),
      salaryFromMinorUnits: z
        .string()
        .regex(/^(0|[1-9]\d*)$/)
        .nullable(),
      salaryToMinorUnits: z
        .string()
        .regex(/^(0|[1-9]\d*)$/)
        .nullable(),
      postedAt: TimestampSchema,
      description: z.string().max(1000).nullable(),
      responsibilities: z.array(z.string().min(1).max(200)),
      requirements: z.array(z.string().min(1).max(200)),
      conditions: z.array(z.string().min(1).max(200)),
    }),
  ),
  updates: z.array(z.strictObject({ id: IdSchema, date: Date, kind: z.enum(['news', 'project', 'catalogue', 'certificate', 'team']), title: z.string().min(1).max(200), href: z.string().max(200).nullable() })),
  faq: z.array(z.strictObject({ q: z.string().min(1).max(200), a: z.string().min(1).max(1000) })),
});
export const GeoPoint = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export const CompanyKind = z.enum(['developer', 'client', 'generalContractor', 'contractor', 'designer', 'manufacturer', 'supplier', 'equipment', 'services', 'logistics']);
const CompanyFixtureSchema = z.strictObject({
  slug: Slug,
  company: CompanySchema,
  /** Activity profile for hub filters; `directions` stay free text. */
  kinds: z.array(CompanyKind).min(1),
  directions: z.array(z.string().min(1).max(80)),
  region: RegionKey,
  website: z.url().nullable(),
  provenance: z.strictObject({ source: z.string().min(1).max(120), observedAt: TimestampSchema }).nullable(),
  claimedAt: TimestampSchema.nullable(),
  catalogue: z.strictObject({ version: z.int().min(1), publishedAt: TimestampSchema, entries: z.array(CatalogueEntrySchema) }).nullable(),
  publicationIds: z.array(IdSchema),
  projectIds: z.array(IdSchema),
  /** People who consented to be listed on the company page. */
  publicMemberPersonIds: z.array(IdSchema),
  /** Public profile extras (synthetic): positioning, geography, certificates, contacts, vacancies, updates, FAQ. */
  profile: CompanyProfileSchema.nullable().optional(),
  /** Head office point for the map search (synthetic, near the region's city). */
  location: GeoPoint.nullable().optional(),
});
export type CompanyFixture = z.infer<typeof CompanyFixtureSchema>;
export const CompaniesFileSchema = z.strictObject({ ...Envelope, companies: z.array(CompanyFixtureSchema) });

export const PartyRole = z.enum(['developer', 'client', 'technicalClient', 'designer', 'generalContractor', 'subcontractor', 'supplier', 'supervision', 'investor', 'operator', 'other']);
export const ProjectParticipantSchema = z.strictObject({
  party: Party,
  role: z.enum(['owner', 'leader', 'participant']),
  /** Structured role in the project chain (developer … operator); `roleTitle` stays free text. */
  partyRole: PartyRole.optional(),
  roleTitle: z.string().min(1).max(80),
  /** Consented to be listed in the public projection. */
  isPublic: z.boolean(),
  grant: z.string().min(1).max(80),
});
export const ProjectUpdateSchema = z.strictObject({
  id: IdSchema,
  type: z.enum(['result', 'teamMessage', 'discussion']),
  title: z.string().min(1).max(200),
  date: Date,
  evidence: z.enum(['asserted', 'confirmed', 'disputed', 'superseded']),
  isPublic: z.boolean(),
});
export const PublishedMilestoneSchema = z.strictObject({
  milestoneId: IdSchema,
  baselineDue: Date,
  changedDue: Date.nullable(),
  actual: Date.nullable(),
  changedByClient: z.boolean(),
});
export const ProjectShowcaseSchema = z.strictObject({
  /** Object passport: address, type, sizes, approvals. */
  passport: z
    .strictObject({
      address: z.string().min(1).max(200),
      objectType: z.string().min(1).max(120),
      totalArea: z.string().max(80).nullable(),
      floors: z.string().max(40).nullable(),
      siteArea: z.string().max(40).nullable(),
      designer: z.string().max(120).nullable(),
      commissioning: z.string().max(60).nullable(),
    })
    .nullable(),
  /** Roles the owner is looking for (partners, subcontractors, suppliers). */
  openRoles: z.array(z.strictObject({ id: IdSchema, role: PartyRole, title: z.string().min(1).max(120), note: z.string().max(300).nullable(), when: z.string().max(60).nullable() })),
  /** Materials and solutions with their suppliers (public, no prices). */
  materials: z.array(
    z.strictObject({ id: IdSchema, name: z.string().min(1).max(160), supplierPartyId: IdSchema.nullable(), supplierName: z.string().max(120).nullable(), status: z.enum(['planned', 'approved', 'inUse']) }),
  ),
  /** Procurement plan: what will be bought and when; `rfqId` links an open need. */
  procurementPlan: z.array(
    z.strictObject({
      id: IdSchema,
      title: z.string().min(1).max(160),
      kind: z.enum(['goods', 'works', 'services', 'bundle']),
      when: z.string().min(1).max(60),
      status: z.enum(['planned', 'open', 'closed']),
      rfqId: IdSchema.nullable(),
    }),
  ),
  /** Requirements for suppliers and subcontractors. */
  supplierTerms: z.array(z.string().min(1).max(200)),
  /** Commercial information for future clients (owner-published, prices on request): audiences such as buyers, tenants, residents. */
  commercial: z
    .strictObject({
      offering: z.string().min(1).max(300),
      infrastructure: z.array(z.string().min(1).max(80)),
      audiences: z.array(
        z.strictObject({
          id: IdSchema,
          kind: z.enum(['buyers', 'tenants', 'residents', 'investors']),
          title: z.string().min(1).max(80),
          description: z.string().max(600).nullable(),
          units: z.array(z.strictObject({ id: IdSchema, title: z.string().min(1).max(120), detail: z.string().max(200).nullable() })),
          terms: z.array(z.string().min(1).max(200)),
          /** Commercial terms without prices: payment, installments, what the rate includes, deposits, indexation. */
          commercialTerms: z.array(z.string().min(1).max(200)).optional(),
          fileIds: z.array(IdSchema),
          faq: z.array(z.strictObject({ q: z.string().min(1).max(200), a: z.string().min(1).max(600) })),
          action: z.enum(['viewing', 'request', 'join']),
        }),
      ),
      note: z.string().max(400).nullable(),
      contactPartyId: IdSchema.nullable(),
      salesOffice: z.string().max(200).nullable(),
    })
    .nullable(),
  /** Press and external coverage. */
  press: z.array(z.strictObject({ id: IdSchema, title: z.string().min(1).max(200), source: z.string().min(1).max(120), url: z.url(), date: Date })),
  /** Approvals and documents with evidence state. */
  documents: z.array(
    z.strictObject({
      id: IdSchema,
      kind: z.enum(['permit', 'expertise', 'landPlan', 'contract', 'certificate', 'other']),
      name: z.string().min(1).max(160),
      number: z.string().max(60).nullable(),
      date: Date.nullable(),
      evidence: z.enum(['asserted', 'confirmed']),
    }),
  ),
  /** Public gallery: photo manifest ids with captions (owner-published). */
  gallery: z.array(z.strictObject({ id: IdSchema, photo: z.string().min(1).max(80), caption: z.string().max(160).nullable() })),
  /** Optional public video (external link; the stand embeds nothing). */
  video: z.strictObject({ url: z.url(), title: z.string().min(1).max(160) }).nullable(),
  /** Key public figures: area, floors, site… */
  highlights: z.array(z.strictObject({ label: z.string().min(1).max(60), value: z.string().min(1).max(80) })),
  /** Plans the owner published for the next period. */
  plans: z.array(z.strictObject({ id: IdSchema, title: z.string().min(1).max(160), when: z.string().min(1).max(60) })),
  /** Note for partners and suppliers: how to join, what is expected. */
  partnerNote: z.string().max(1500).nullable(),
  /** Public contact role for partner questions (a public participant). */
  contactPartyId: IdSchema.nullable(),
  /** Public detail for open needs keyed by RFQ id (no prices). */
  needs: z.array(z.strictObject({ rfqId: IdSchema, summary: z.string().min(1).max(300), quantity: z.string().max(40).nullable(), unit: z.string().max(20).nullable() })),
});
export const ProjectFixtureSchema = z.strictObject({
  slug: Slug,
  project: ProjectSchema,
  category: z.enum(['housing', 'education', 'industrial', 'publicSpace', 'infrastructure']),
  region: RegionKey,
  participants: z.array(ProjectParticipantSchema),
  updates: z.array(ProjectUpdateSchema),
  publishedMilestones: z.array(PublishedMilestoneSchema),
  publicationIds: z.array(IdSchema),
  projectionDate: Date.nullable(),
  updatedAt: TimestampSchema,
  /** Shared-party thread count etc. are out of scope; files are listed with their audience only. */
  files: z.array(
    z.strictObject({ id: IdSchema, name: z.string().min(1).max(120), audience: z.enum(['private', 'participants', 'public']), kind: z.enum(['presentation', 'brochure', 'drawing', 'archive', 'other']).optional() }),
  ),
  budget: z.strictObject({ reservedMinorUnits: z.string().regex(/^(0|[1-9]\d*)$/), settledMinorUnits: z.string().regex(/^(0|[1-9]\d*)$/) }).nullable(),
  /** Owner-published public extras (synthetic). */
  showcase: ProjectShowcaseSchema.nullable().optional(),
  /** Site point for the map search (synthetic). */
  location: GeoPoint.nullable().optional(),
});
export type ProjectFixture = z.infer<typeof ProjectFixtureSchema>;
export const ProjectsFileSchema = z.strictObject({ ...Envelope, projects: z.array(ProjectFixtureSchema) });

export const EventType = z.enum(['conference', 'seminar', 'webinar', 'tour', 'exhibition', 'meetup']);
export const EventFormat = z.enum(['offline', 'online', 'hybrid']);
const DateTime = z.iso.datetime();
export const EventTicketSchema = z.strictObject({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().max(240),
  priceMinorUnits: z.int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
  quota: z.int().min(1).nullable(),
  taken: z.int().min(0),
  salesUntil: DateTime.nullable(),
});
export const EventSpeakerSchema = z.strictObject({ id: z.string().min(1).max(40), name: z.string().min(1).max(120), role: z.string().min(1).max(160), personSlug: Slug.nullable(), portrait: z.string().nullable() });
export const EventFixtureSchema = z.strictObject({
  slug: Slug,
  id: IdSchema,
  title: z.string().min(1).max(160),
  lede: z.string().min(1).max(400),
  type: EventType,
  format: EventFormat,
  startsAt: DateTime,
  endsAt: DateTime,
  timezone: z.string().min(1),
  city: z.string().max(80).nullable(),
  region: RegionKey.nullable(),
  venue: z.strictObject({ name: z.string().min(1).max(160), address: z.string().min(1).max(240) }).nullable(),
  onlineNote: z.string().max(240).nullable(),
  organizer: z.strictObject({ kind: z.enum(['company', 'editorial', 'community']), name: z.string().min(1).max(120), companySlug: Slug.nullable() }),
  cover: z.string().min(1),
  topics: z.array(TopicKey),
  body: z.string().min(1),
  program: z.array(z.strictObject({ time: z.string().min(1).max(20), title: z.string().min(1).max(200), speakerIds: z.array(z.string()) })),
  speakers: z.array(EventSpeakerSchema),
  tickets: z.array(EventTicketSchema).min(1),
  capacity: z.int().min(1).nullable(),
  registered: z.int().min(0),
  featured: z.boolean(),
  registrationOpen: z.boolean(),
  relatedPublicationSlugs: z.array(Slug),
  materialsHref: z.string().nullable(),
});
export type EventFixture = z.infer<typeof EventFixtureSchema>;
export const EventsFileSchema = z.strictObject({ ...Envelope, events: z.array(EventFixtureSchema) });

export const PublicationFixtureSchema = z.strictObject({
  slug: Slug,
  publication: PublicationSchema,
  versions: z.array(PublicationVersionSchema).min(1),
  lede: z.string().min(1).max(500),
  /** Short name for utility lists («Полезно под рукой»); ≤ 32 characters. */
  shortTitle: z.string().min(1).max(32).nullable().optional(),
  articleFormat: ArticleFormat.nullable(),
  topics: z.array(TopicKey),
  source: z.strictObject({ name: z.string().min(1).max(120), url: z.url(), type: z.enum(['industryMedia', 'manufacturer', 'event', 'science']) }).nullable(),
  region: RegionKey.nullable(),
  authorLabel: z.string().min(1).max(120),
  authorSlug: Slug.nullable(),
  featured: z.boolean(),
  utility: z.boolean(),
  readMinutes: z.int().min(1).max(120).nullable(),
  updatedAt: TimestampSchema,
  /** «Проверь себя»: short self-check after the piece (magazine engagement; answers stay in the reader's browser). */
  quiz: z
    .array(z.strictObject({ question: z.string().min(1).max(200), options: z.array(z.string().min(1).max(120)).min(2).max(4), answer: z.int().min(0).max(3), explanation: z.string().min(1).max(300) }))
    .max(5)
    .optional(),
});
export type PublicationFixture = z.infer<typeof PublicationFixtureSchema>;
export const PublicationsFileSchema = z.strictObject({ ...Envelope, publications: z.array(PublicationFixtureSchema) });

export const IssueFixtureSchema = z.strictObject({
  issue: IssueSchema,
  title: z.string().min(1).max(200),
  lede: z.string().min(1).max(500),
  dateFrom: Date,
  dateTo: Date,
  releasedAt: Date,
  pdf: z.discriminatedUnion('state', [z.strictObject({ state: z.literal('pending') }), z.strictObject({ state: z.literal('ready'), size: z.string().min(1).max(20), pages: z.int().min(1) })]),
  corrections: z.array(z.strictObject({ correction: CorrectionSchema, publicationId: IdSchema, summary: z.string().min(1).max(300) })),
  /** Poll of the week; `sample` is a synthetic, labelled distribution for the demo (no real votes are collected). */
  poll: z.strictObject({ question: z.string().min(1).max(200), options: z.array(z.string().min(1).max(120)).min(2).max(5), sample: z.array(z.int().min(0)).min(2).max(5) }).optional(),
  /** Glossary of the issue: terms explained in the pieces. */
  glossary: z
    .array(z.strictObject({ term: z.string().min(1).max(80), definition: z.string().min(1).max(300) }))
    .max(12)
    .optional(),
});
export type IssueFixture = z.infer<typeof IssueFixtureSchema>;
export const IssuesFileSchema = z.strictObject({ ...Envelope, issues: z.array(IssueFixtureSchema) });

const RfqStatus = z.enum([
  'needDraft',
  'clarifying',
  'published',
  'quotesCollected',
  'negotiating',
  'termsSelected',
  'orderPlaced',
  'supplierAccepted',
  'fulfilling',
  'partiallyAccepted',
  'accepted',
  'reviewed',
  'disputed',
  'closed',
  'expired',
  'cancelled',
]);
const LeadStatus = z.enum(['new', 'drafting', 'sent', 'negotiating', 'won', 'lost', 'expired']);
const LeadSource = z.enum(['invitation', 'openNeed', 'direct', 'email']);

export const WorkspaceFileSchema = z.strictObject({
  ...Envelope,
  personas: z.record(
    z.enum(['reader', 'mixed', 'owner']),
    z.strictObject({
      personId: IdSchema,
      companyId: IdSchema.nullable(),
      pinned: z.strictObject({ procurement: z.boolean(), sales: z.boolean() }),
      onboarding: z.enum(['completed', 'skipped', 'pending']),
    }),
  ),
  memberships: z.array(MembershipSchema),
  rfqs: z.array(
    z.strictObject({
      id: IdSchema,
      owner: Party,
      title: z.string().min(1).max(200),
      kind: z.enum(['goods', 'works', 'services', 'bundle']),
      version: z.int().min(1),
      quotesCount: z.int().min(0),
      deadline: Date,
      operatorPersonId: IdSchema,
      status: RfqStatus,
      projectId: IdSchema.nullable(),
      needsDecision: z.boolean(),
    }),
  ),
  leads: z.array(
    z.strictObject({
      id: IdSchema,
      companyId: IdSchema,
      buyer: z.string().min(1).max(120),
      request: z.string().min(1).max(200),
      source: LeadSource,
      deadline: Date,
      status: LeadStatus,
      quoteVersion: z.int().min(1).nullable(),
      needsDecision: z.boolean(),
    }),
  ),
  decisions: z.array(
    z.strictObject({
      id: IdSchema,
      personId: IdSchema,
      kind: z.enum(['quoteComparison', 'approvalDigest', 'orderAcceptance', 'dispute', 'publicationReview']),
      title: z.string().min(1).max(200),
      context: z.string().min(1).max(200),
      due: Date,
      href: z.string().startsWith('/app'),
      action: z.string().min(1).max(60),
      digestChanged: z.boolean(),
    }),
  ),
  events: z.array(z.strictObject({ id: IdSchema, personIds: z.array(IdSchema), date: Date, title: z.string().min(1).max(200), href: z.string().startsWith('/') })),
  notifications: z.array(
    z.strictObject({
      id: IdSchema,
      personIds: z.array(IdSchema),
      kind: z.enum(['decision', 'quote', 'project', 'publication', 'assistant', 'magazine']),
      title: z.string().min(1).max(200),
      at: TimestampSchema,
      href: z.string().startsWith('/'),
      unread: z.boolean(),
    }),
  ),
  assistant: z.array(
    z.strictObject({
      personId: IdSchema,
      running: z.int().min(0),
      approvals: z.int().min(0),
      unknown: z.int().min(0),
      unread: z.int().min(0),
      mandates: z.array(
        z.strictObject({
          id: IdSchema,
          action: z.string().min(1).max(200),
          context: z.string().min(1).max(200),
          limitMinorUnits: z
            .string()
            .regex(/^(0|[1-9]\d*)$/)
            .nullable(),
          validUntil: Date,
          state: z.enum(['active', 'paused', 'revoked', 'expired']),
          version: z.int().min(1),
          approval: z.enum(['none', 'digest', 'escalate']),
        }),
      ),
      runs: z.array(
        z.strictObject({
          id: IdSchema,
          title: z.string().min(1).max(200),
          state: z.enum(['proposed', 'authorized', 'reserved', 'queued', 'executing', 'pending', 'succeeded', 'failed', 'outcomeUnknown', 'reconciling', 'revoked']),
          at: TimestampSchema,
        }),
      ),
    }),
  ),
  sessions: z.array(z.strictObject({ personId: IdSchema, device: z.string().min(1).max(80), location: z.string().min(1).max(80), lastSeen: TimestampSchema, isCurrent: z.boolean() })),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

export const FIXTURE_FILES = {
  'people.json': PeopleFileSchema,
  'companies.json': CompaniesFileSchema,
  'projects.json': ProjectsFileSchema,
  'publications.json': PublicationsFileSchema,
  'issues.json': IssuesFileSchema,
  'workspace.json': WorkspaceFileSchema,
  'events.json': EventsFileSchema,
  'courses.json': CoursesFileSchema,
} as const;

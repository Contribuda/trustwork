import { suppressSmallCount } from '@trustwork/contracts/client';
import { HUB_US_ID } from '../../../_fixtures/ids.js';
import { ProductModulesSchema, type ProductModules } from './_kit/schemas.js';
import { preview } from './_kit/fixture-helpers.js';

/**
 * Section-local fixtures of the product module screens on the US demo hub (HC-60 to HC-67, HUBC-005). Titles are
 * invented and labelled "(demo)"; parties of knowledge shares are synthetic example companies and people; every
 * participant count is a cohort (`suppressSmallCount`). Templates and rules parse with the frozen contract schemas.
 */

const c = suppressSmallCount;
/** The US example hub's country pack code (the fixtures describe that hub; engine code never branches on it). */
const US_PACK = 'US';
const en = (text: string) => ({ text, lang: 'en' });
const name = (text: string, es?: string) => ({ en: text, ...(es ? { es } : {}) });
const item = (key: string, kind: string, title: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({
  key, kind, title: name(title), categoryKey: null, licenceCategory: null, typicalDurationDays: null, dependsOn, ...extra,
});

const consultationFeePreview = preview('pv-fee-consultation-2', '7a', {
  changes: [{ field: 'commission', before: { kind: 'text', value: '10 %', lang: 'en' }, after: { kind: 'text', value: '8 %', lang: 'en' } }],
  affected: { mandates: null, jobSubscriptions: null, externalConnections: null, openRuns: null, payers: c(126) },
  audiences: ['person', 'company_member'],
  plans: [],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: null,
});

export const US_PRODUCT_MODULES: ProductModules = ProductModulesSchema.parse({
  projects: {
    publishingAllowed: true,
    publicFields: ['title', 'category', 'region', 'status', 'photos'],
    counts: { created: c(1840), published: c(212), completed: c(96) },
    reports: [{ id: 'rp-project-1', title: en('Backyard ADU in Chula Vista (demo)'), reason: 'private_data', at: '2026-10-30T19:20:00Z' }],
    transferDisputes: 1,
    version: 2,
  },
  planner: {
    templates: [
      {
        template: {
          id: 'pt-us-house-2', hubId: HUB_US_ID, key: 'single_family_new_build', version: 2, countryCode: US_PACK, projectType: 'house_new_build',
          title: name('Single-family house, new build', 'Vivienda unifamiliar, obra nueva'),
          phases: [
            { key: 'design', title: name('Design'), items: [item('site_survey', 'task', 'Site survey'), item('architect_review', 'consultation', 'Architect review of the drawings', ['site_survey'])] },
            { key: 'permits', title: name('Permits'), items: [item('building_permit', 'permit_check', 'Building permit from the city building department', ['architect_review'])] },
            { key: 'structure', title: name('Foundation and framing'), items: [item('foundation', 'task', 'Foundation', ['building_permit'], { typicalDurationDays: 14 }), item('framing', 'task', 'Framing', ['foundation'], { typicalDurationDays: 21 })] },
            { key: 'mep', title: name('Mechanical, electrical, plumbing'), items: [item('electrical', 'task', 'Electrical rough-in', ['framing'], { licenceCategory: 'C-10 electrical (California)', typicalDurationDays: 7 }), item('inspection', 'milestone', 'Rough inspection', ['electrical'])] },
          ],
          references: [{ label: 'California Residential Code (example reference)', url: 'https://codes.example/california-residential' }],
          authors: ['p-editor'], reviewedBy: 'p-hub-owner', status: 'published',
        },
        plansCreated: c(214),
        itemsTurnedIntoRequestsPercent: 38,
      },
      {
        template: {
          id: 'pt-us-kitchen-1', hubId: HUB_US_ID, key: 'kitchen_remodel', version: 1, countryCode: US_PACK, projectType: 'remodel',
          title: name('Kitchen remodel', 'Remodelación de cocina'),
          phases: [
            { key: 'plan', title: name('Plan'), items: [item('layout_consultation', 'consultation', 'Layout consultation'), item('quote_review', 'consultation', 'Review of contractor quotes', ['layout_consultation'])] },
            { key: 'build', title: name('Build'), items: [item('demolition', 'task', 'Demolition', ['quote_review']), item('cabinets', 'task', 'Cabinets and counters', ['demolition'])] },
          ],
          references: [],
          authors: ['p-editor'], reviewedBy: null, status: 'in_review',
        },
        plansCreated: c(4),
        itemsTurnedIntoRequestsPercent: null,
      },
    ],
    blocked: [{ templateKey: 'adu_conversion', version: 1, problem: 'cycle', itemKey: 'final_inspection' }],
    feedback: 3,
    adaptation: { addItems: true, removeItems: false, reorder: true },
  },
  marketplace: {
    rules: [
      {
        id: 'mr-architect-review', hubId: HUB_US_ID, categoryKey: 'architect_review', kind: 'consultation', whoMayOffer: 'verified_professional', verificationRecipeId: 'rc-us-architect',
        licenceCategory: 'Architect (state board)', pricing: 'fixed', refunds: { cancellationWindowHours: 24, disputeWindowDays: 14 },
        agentAutomation: { mayDraftRequests: true, mayDraftOffers: true, mayAcceptWithinMandate: true, requestsPerWeek: 5 }, version: 2, status: 'active',
      },
      {
        id: 'mr-electrical', hubId: HUB_US_ID, categoryKey: 'electrical_work', kind: 'task', whoMayOffer: 'verified_company', verificationRecipeId: 'rc-us-contractor',
        licenceCategory: 'C-10 electrical (California)', pricing: 'quote_based', refunds: { cancellationWindowHours: 48, disputeWindowDays: 30 },
        agentAutomation: { mayDraftRequests: true, mayDraftOffers: true, mayAcceptWithinMandate: false, requestsPerWeek: 3 }, version: 1, status: 'active',
      },
      {
        id: 'mr-quote-review', hubId: HUB_US_ID, categoryKey: 'quote_review', kind: 'consultation', whoMayOffer: 'claimed_company_or_professional', verificationRecipeId: null,
        licenceCategory: null, pricing: 'hourly', refunds: { cancellationWindowHours: 12, disputeWindowDays: 7 },
        agentAutomation: { mayDraftRequests: true, mayDraftOffers: false, mayAcceptWithinMandate: false, requestsPerWeek: 5 }, version: 1, status: 'active',
      },
    ],
    fees: [
      {
        fee: {
          id: 'fee-consultation-1', hubId: HUB_US_ID, kind: 'consultation', categoryKey: null, version: 1, currency: 'USD', basisPoints: 1000, fixed: null, payer: 'seller',
          effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, disclosure: { publicPricePage: true, acceptanceTextVersion: 'fees-2026-10' }, status: 'active',
          draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', activatedAt: '2026-09-30T12:00:00Z', approvalId: 'ap-fee-consultation-1',
        },
        preview: null,
      },
      {
        fee: {
          id: 'fee-consultation-2', hubId: HUB_US_ID, kind: 'consultation', categoryKey: null, version: 2, currency: 'USD', basisPoints: 800, fixed: null, payer: 'seller',
          effectiveFrom: '2026-12-01T00:00:00Z', effectiveTo: null, disclosure: { publicPricePage: true, acceptanceTextVersion: 'fees-2026-12' }, status: 'draft',
          draftedBy: 'p-commercial', activatedBy: null, activatedAt: null, approvalId: null,
        },
        preview: consultationFeePreview,
      },
      {
        fee: {
          id: 'fee-task-1', hubId: HUB_US_ID, kind: 'task', categoryKey: 'electrical_work', version: 1, currency: 'USD', basisPoints: 500, fixed: { minorUnits: '200', currency: 'USD' }, payer: 'seller',
          effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, disclosure: { publicPricePage: true, acceptanceTextVersion: 'fees-2026-10' }, status: 'active',
          draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', activatedAt: '2026-09-30T12:00:00Z', approvalId: 'ap-fee-task-1',
        },
        preview: null,
      },
    ],
    counts: [
      { categoryKey: 'architect_review', openRequests: c(41), engagements: c(27) },
      { categoryKey: 'electrical_work', openRequests: c(18), engagements: c(6) },
      { categoryKey: 'quote_review', openRequests: c(66), engagements: c(52) },
    ],
    disputes: 2,
    refundsOutsidePolicy: 1,
    pausedForExpiredLicence: c(3),
  },
  knowledge: {
    shares: [
      {
        share: {
          id: 'ks-diary-1', hubId: HUB_US_ID, kind: 'project_diary', projectId: 'prj-demo-adu', ownerParty: { kind: 'person', id: 'pp-demo-owner-1' },
          namedParties: [{ kind: 'company', id: 'co-demo-framing' }],
          consents: [{ party: { kind: 'person', id: 'pp-demo-owner-1' }, givenBy: 'pp-demo-owner-1', at: '2026-10-25T10:00:00Z', scope: 'named', withdrawnAt: null }],
          privateFieldsExcluded: true, status: 'consent_pending', reviewedBy: null, publicationId: null,
        },
        projectTitle: en('Garage to ADU conversion (demo)'),
        parties: [
          { kind: 'owner', partyKind: 'person', label: en('Project owner (demo)'), consent: 'given' },
          { kind: 'named', partyKind: 'company', label: en('Example Framing Co. (demo)'), consent: 'missing' },
        ],
      },
      {
        share: {
          id: 'ks-lesson-2', hubId: HUB_US_ID, kind: 'lesson', projectId: 'prj-demo-deck', ownerParty: { kind: 'company', id: 'co-demo-decks' },
          namedParties: [],
          consents: [{ party: { kind: 'company', id: 'co-demo-decks' }, givenBy: 'pp-demo-rep-2', at: '2026-10-27T10:00:00Z', scope: 'anonymised', withdrawnAt: null }],
          privateFieldsExcluded: true, status: 'in_review', reviewedBy: null, publicationId: null,
        },
        projectTitle: en('Composite deck on a slope (demo)'),
        parties: [{ kind: 'owner', partyKind: 'company', label: en('Example Decks LLC (demo)'), consent: 'given' }],
      },
    ],
    kindsAccepted: ['project_diary', 'plan_template', 'qa', 'lesson'],
    anonymisedAllowed: true,
    mentoring: true,
  },
  events: {
    hostingPolicy: 'verified_and_editorial',
    ticketing: true,
    feeVersionLabel: 'Ticket fee 1',
    partnerMeetings: true,
    inReview: [{ id: 'ev-demo-1', title: en('Title 24 energy code workshop (demo)'), startsAt: '2026-11-18T17:00:00Z', organizerKind: 'company' }],
    counts: { published: c(34), registrations: c(1260), checkIns: c(410) },
    refunds: 2,
    organizerScreening: 1,
    payoutBatchesWaiting: 1,
  },
  learning: {
    inReview: [{ id: 'cr-demo-1', title: en('Reading structural drawings (demo)'), submittedAt: '2026-10-28T09:00:00Z' }],
    certificates: { issued: c(388), revoked: c(2), expired: c(17) },
    revocationRequests: 1,
    accreditations: [{ id: 'acc-demo-1', body: en('Example continuing-education board (demo)'), source: 'https://board.example/providers/demo', validUntil: '2027-06-30T00:00:00Z' }],
    paidCourses: false,
  },
  matching: {
    counts: { needsPublished: c(146), needsFilled: c(61), introductionsRequested: c(520), introductionsAccepted: c(301) },
    introductionsPerPersonPerWeek: 10,
    needsBoard: true,
    crossBorderInterest: false,
    methods: [
      { version: 1, status: 'superseded', explanation: en('Matches by trade, region and availability.'), releasedAt: '2026-08-01T00:00:00Z' },
      { version: 2, status: 'released', explanation: en('Adds verified licence categories; paid plans never change the order.'), releasedAt: '2026-10-01T00:00:00Z' },
    ],
    reports: 2,
  },
  commerce: {
    rules: [
      { categoryKey: 'electrical', licenceCheck: true, pricesIncludeTax: false, version: 3 },
      { categoryKey: 'lumber', licenceCheck: false, pricesIncludeTax: false, version: 1 },
    ],
    flows: { rfqs: c(318), quotes: c(904), agreements: c(122), orders: c(97), medianHoursToFirstQuote: 19, medianDaysAcceptanceToOrder: 3 },
    unknownOutcomes: [
      { id: 'uo-demo-1', kind: 'payment', state: 'outcome_unknown', since: '2026-10-31T07:40:00Z' },
      { id: 'uo-demo-2', kind: 'e_signature', state: 'reconciling', since: '2026-10-30T22:10:00Z' },
    ],
  },
});

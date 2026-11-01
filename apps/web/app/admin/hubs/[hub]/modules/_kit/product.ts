import { DEFAULT_MCP_HUB_POLICY } from '@trustwork/contracts/client';
import { HUB_SAMARKAND_ID, HUB_US_ID } from '../../../../_fixtures/ids.js';
import { US_AGENT_PRODUCT } from '../../agents/_fixtures.js';
import { US_BILLING } from '../../billing/_fixtures.js';
import { US_COMMUNICATIONS } from '../../communications/_fixtures.js';
import { US_PRODUCT_MODULES } from '../_fixtures.js';
import { HubProductSchema, type HubProduct } from './schemas.js';

/**
 * The fixture adapter's `product(hubId)` (HUBC-005): the US demo hub has the full product; the Samarkand example hub
 * has switched nothing on yet, so its screens show their teaching empty states. Live mode never reaches this module.
 */

const SAMARKAND_PRODUCT: HubProduct = HubProductSchema.parse({
  hubId: HUB_SAMARKAND_ID,
  synthetic: true,
  agents: {
    modules: [],
    plans: [],
    policy: {
      version: 1, forbiddenPreAuthorization: ['place_order', 'accept_order', 'release_payment'], commitmentsOnlyForVerifiedCompanies: true, outreachPerPersonPerWeek: 10,
      outreachOnlyToParticipants: true, channels: ['in_app'], disclosure: [], planToPeople: { mayDraftRequests: false, mayDraftOffers: false, mayAcceptWithinMandate: false, requestsPerWeek: 0 },
      protectionLimits: { openIntroductionsPerPerson: 5, newCounterpartiesPerDay: 10, maxNegotiationRounds: 4, consumerMaxRounds: 3, envelopesPerCounterpartyPerDay: 10, publicRecordsPerConnectionPerDay: 500, connectionsPerPerson: 2, connectionIdleExpiryDays: 60 },
      jurisdictions: [], draft: null,
    },
    extensions: [],
    external: {
      protocols: { mcp: false, a2a: false }, rateLimits: { defaultPerMinute: 10, maximumPerMinute: 30, defaultActionsPerDay: 0, maximumActionsPerDay: 10 },
      modulesForExternalClients: [], representativesMayUseExternalClients: false, registeredClients: { mcp: null, a2a: null },
      mcp: { ...DEFAULT_MCP_HUB_POLICY, endpoints: { public: false, participant: false, admin: false } },
    },
    usage: [],
    cohorts: [],
    abuse: { signals: [], throttlesActive: 0, draft: null },
  },
  modules: {
    projects: { publishingAllowed: false, publicFields: ['title', 'region'], counts: { created: null, published: null, completed: null }, reports: [], transferDisputes: 0, version: 1 },
    planner: { templates: [], blocked: [], feedback: 0, adaptation: { addItems: false, removeItems: false, reorder: false } },
    marketplace: { rules: [], fees: [], counts: [], disputes: 0, refundsOutsidePolicy: 0, pausedForExpiredLicence: null },
    knowledge: { shares: [], kindsAccepted: ['qa'], anonymisedAllowed: false, mentoring: false },
    events: { hostingPolicy: 'editorial_only', ticketing: false, feeVersionLabel: null, partnerMeetings: false, inReview: [], counts: { published: null, registrations: null, checkIns: null }, refunds: 0, organizerScreening: 0, payoutBatchesWaiting: 0 },
    learning: { inReview: [], certificates: { issued: null, revoked: null, expired: null }, revocationRequests: 0, accreditations: [], paidCourses: false },
    matching: { counts: { needsPublished: null, needsFilled: null, introductionsRequested: null, introductionsAccepted: null }, introductionsPerPersonPerWeek: 5, needsBoard: false, crossBorderInterest: false, methods: [], reports: 0 },
    commerce: { rules: [], flows: { rfqs: null, quotes: null, agreements: null, orders: null, medianHoursToFirstQuote: null, medianDaysAcceptanceToOrder: null }, unknownOutcomes: [] },
  },
  billing: {
    currency: 'UZS', freeMinimum: [], offers: [], plans: [], prices: [], meterRates: [], invoiceRuns: [], payoutBatches: [],
    credits: { issuedThisMonth: 0, issuedAmount: { minorUnits: '0', currency: 'UZS' }, roleCap: { minorUnits: '0', currency: 'UZS' }, packs: [], refundPolicy: { version: 1, summary: { text: "Qaytarish siyosati hali e'lon qilinmagan.", lang: 'uz-Latn' }, effectiveFrom: '2026-10-01T00:00:00Z' } },
    tax: { version: 1, feesTaxable: [], eInvoicing: 'optional', pricesShownWithTax: true },
  },
  communications: { domains: [], sms: { registration: 'not_needed', mode: 'fake' }, templates: [], deliverability: [], bounceThresholdPercent: '2', announcements: [], quietHours: { from: '22:00', to: '08:00' } },
});

const US_PRODUCT: HubProduct = HubProductSchema.parse({ hubId: HUB_US_ID, synthetic: true, agents: US_AGENT_PRODUCT, modules: US_PRODUCT_MODULES, billing: US_BILLING, communications: US_COMMUNICATIONS });

export const HUB_PRODUCTS: readonly HubProduct[] = [US_PRODUCT, SAMARKAND_PRODUCT];

export function productFor(hubId: string): HubProduct | null {
  return HUB_PRODUCTS.find((p) => p.hubId === hubId) ?? null;
}

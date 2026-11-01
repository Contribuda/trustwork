import { suppressSmallCount } from '@trustwork/contracts/client';
import { HUB_US_ID } from '../../../_fixtures/ids.js';
import { BillingViewSchema, type BillingView } from '../modules/_kit/schemas.js';
import { preview } from '../modules/_kit/fixture-helpers.js';

/**
 * Section-local fixtures of the billing screens on the US demo hub (HC-90 to HC-95, HUBC-005). Prices are invented
 * examples in USD (the handbook's `rfq_responder` run: cost 3.25 cents, sale 10 cents); acceptances and payees are
 * cohorts; tax sources point to `.example` hosts. The demo hub moves no money: payouts and invoices are records only.
 */

const c = suppressSmallCount;
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });

const priceDraftPreview = preview('pv-price-planner-2', '8b', {
  changes: [{ field: 'salePrice', before: { kind: 'text', value: '10', lang: 'en' }, after: { kind: 'text', value: '12', lang: 'en' } }],
  affected: { mandates: null, jobSubscriptions: c(37), externalConnections: null, openRuns: null, payers: c(64) },
  audiences: ['person', 'company_member'],
  plans: ['pro_person', 'company_team'],
  advanceNoticeDays: 30,
  estimatedMonthlyCostChange: null,
});

const modelDraftPreview = preview('pv-price-model-1', '9c', {
  changes: [{ field: 'salePrice', before: { kind: 'none' }, after: { kind: 'text', value: '0.3', lang: 'en' } }],
  affected: { mandates: null, jobSubscriptions: null, externalConnections: null, openRuns: null, payers: c(0) },
  audiences: ['person', 'company_member'],
  plans: ['pro_person'],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: null,
});

const planPreview = preview('pv-plan-team-2', '6d', {
  changes: [{ field: 'includedRuns', before: { kind: 'text', value: '300', lang: 'en' }, after: { kind: 'text', value: '500', lang: 'en' } }],
  affected: { mandates: null, jobSubscriptions: null, externalConnections: null, openRuns: null, payers: c(9) },
  audiences: ['company_member', 'company_representative'],
  plans: ['company_team'],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: usd('1200'),
});

const packPreview = preview('pv-pack-200-2', '5e', {
  changes: [{ field: 'validity', before: { kind: 'text', value: '365', lang: 'en' }, after: { kind: 'key', key: 'product.values.credits.noExpiry' } }],
  affected: { mandates: null, jobSubscriptions: null, externalConnections: null, openRuns: null, payers: c(73) },
  audiences: ['person', 'company_member'],
  plans: [],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: null,
});

const price = (id: string, version: number, cost: string, sale: string, unit = 'run') => ({ priceVersionId: id, version, currency: 'USD', unit, costPerUnitMinor: cost, salePerUnitMinor: sale, costBasis: 'measured_average' });

export const US_BILLING: BillingView = BillingViewSchema.parse({
  currency: 'USD',
  freeMinimum: [
    { moduleKey: 'research', unitsPerMonth: 100, unit: 'run' },
    { moduleKey: 'project_planner', unitsPerMonth: 30, unit: 'run' },
  ],
  offers: [
    { id: 'of-pro-person', code: 'pro_person', name: 'Pro (person)', kind: 'plan', status: 'active', revision: 2 },
    { id: 'of-company-team', code: 'company_team', name: 'Company team', kind: 'plan', status: 'active', revision: 1 },
    { id: 'of-credits-200', code: 'credits_200', name: '200 agent credits', kind: 'credit_pack', status: 'active', revision: 1 },
  ],
  plans: [
    {
      key: 'pro_person', trialDays: 14, draftedBy: 'p-commercial', preview: null,
      plan: { id: 'pl-pro-person-1', offerId: 'of-pro-person', version: 1, payerKind: 'person', moduleKeys: ['research', 'project_planner', 'reputation_coach'], includedQuota: [{ moduleKey: 'project_planner', meter: 'agent_actions', units: '200', window: 'month' }], connections: 2, channels: 3, representativeIncluded: false, priceVersionId: 'pv-pro-person-1', status: 'active' },
      price: { id: 'pv-pro-person-1', offerId: 'of-pro-person', version: 1, currency: 'USD', amountMinorUnits: '1900', effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'plans-2026-10', status: 'active', draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', activatedAt: '2026-09-30T12:00:00Z' },
    },
    {
      key: 'company_team', trialDays: 30, draftedBy: 'p-commercial', preview: planPreview,
      plan: { id: 'pl-company-team-2', offerId: 'of-company-team', version: 2, payerKind: 'company', moduleKeys: ['research', 'rfq_responder', 'order_desk'], includedQuota: [{ moduleKey: 'rfq_responder', meter: 'agent_actions', units: '500', window: 'month' }], connections: 5, channels: 6, representativeIncluded: true, priceVersionId: 'pv-company-team-2', status: 'draft' },
      price: { id: 'pv-company-team-2', offerId: 'of-company-team', version: 2, currency: 'USD', amountMinorUnits: '9900', effectiveFrom: '2026-12-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'plans-2026-12', status: 'draft', draftedBy: 'p-commercial', activatedBy: null, activatedAt: null },
    },
  ],
  prices: [
    {
      subject: { kind: 'module', key: 'rfq_responder' }, price: price('pr-rfq-1', 1, '3.25', '10'), basis: { kind: 'flat' }, status: 'active',
      effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'agents-2026-10', acceptances: c(52), notice: 'not_needed',
      draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', preview: null, costChanged: null,
    },
    {
      subject: { kind: 'module', key: 'project_planner' }, price: price('pr-planner-1', 1, '3.25', '10'), basis: { kind: 'flat' }, status: 'active',
      effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'agents-2026-10', acceptances: c(64), notice: 'not_needed',
      draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', preview: null, costChanged: null,
    },
    {
      subject: { kind: 'module', key: 'project_planner' }, price: price('pr-planner-2', 2, '4.1', '12'), basis: { kind: 'markup', percent: 192, costAtDraftMinor: '4.1' }, status: 'draft',
      effectiveFrom: '2026-12-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'agents-2026-12', acceptances: null, notice: 'scheduled',
      draftedBy: 'p-commercial', activatedBy: null, preview: priceDraftPreview, costChanged: null,
    },
    {
      subject: { kind: 'module', key: 'reputation_coach' }, price: price('pr-coach-1', 1, '1.8', '1'), basis: { kind: 'flat' }, status: 'active',
      effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'agents-2026-10', acceptances: c(51), notice: 'not_needed',
      draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', preview: null, costChanged: { newCostPerUnitMinor: '2.2', observedAt: '2026-10-28T00:00:00Z' },
    },
    {
      subject: { kind: 'capability', key: 'rfq_responder.send_quote' }, price: price('pr-send-quote-1', 1, '0.5', '2', 'action'), basis: { kind: 'flat' }, status: 'active',
      effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'agents-2026-10', acceptances: c(22), notice: 'not_needed',
      draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', preview: null, costChanged: null,
    },
    {
      subject: { kind: 'model', key: 'self-hosted-llm-70b', direction: 'output' }, price: price('pr-model-out-1', 1, '0.12', '0.3', 'thousand_tokens'), basis: { kind: 'markup', percent: 150, costAtDraftMinor: '0.12' }, status: 'draft',
      effectiveFrom: '2026-11-15T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'models-2026-11', acceptances: null, notice: 'not_needed',
      draftedBy: 'p-commercial', activatedBy: null, preview: modelDraftPreview, costChanged: null,
    },
  ],
  meterRates: [
    {
      rate: { id: 'mr-tokens-1', hubId: HUB_US_ID, version: 1, meter: 'model_tokens', providerClass: 'local', currency: 'USD', pricePerThousandUnits: usd('1'), passThrough: false, effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null, status: 'active', draftedBy: 'p-commercial', activatedBy: 'p-hub-owner', activatedAt: '2026-09-30T12:00:00Z' },
      cost: { id: 'mc-tokens-1', hubId: HUB_US_ID, meterRateVersionId: 'mr-tokens-1', currency: 'USD', costPerThousandUnitsMinor: '0.35', costBasis: 'measured_average', observedAt: '2026-10-28T00:00:00Z' },
    },
  ],
  invoiceRuns: [
    { id: 'ir-2026-09', period: '2026-09', state: 'issued', invoices: c(118), failed: 0, total: usd('412300'), byOffer: [{ offerCode: 'pro_person', total: usd('121600') }, { offerCode: 'company_team', total: usd('290700') }], eInvoicing: 'not_required' },
    { id: 'ir-2026-10', period: '2026-10', state: 'partially_failed', invoices: c(131), failed: 2, total: usd('455100'), byOffer: [{ offerCode: 'pro_person', total: usd('133000') }, { offerCode: 'company_team', total: usd('322100') }], eInvoicing: 'not_required' },
  ],
  payoutBatches: [
    { id: 'pb-experts-10', recipients: 'experts', payees: c(23), total: usd('184000'), state: 'awaiting_release', createdAt: '2026-10-31T06:00:00Z' },
    { id: 'pb-organizers-10', recipients: 'organizers', payees: c(4), total: usd('62000'), state: 'outcome_unknown', createdAt: '2026-10-29T06:00:00Z' },
    { id: 'pb-authors-09', recipients: 'authors', payees: c(12), total: usd('21000'), state: 'paid', createdAt: '2026-09-30T06:00:00Z' },
  ],
  credits: {
    issuedThisMonth: 14,
    issuedAmount: usd('18500'),
    roleCap: usd('5000'),
    packs: [
      { id: 'cp-200-1', version: 1, credits: 200, price: usd('1500'), validityDays: 365, reminderDaysBeforeExpiry: 30, refundPolicyVersion: 2, status: 'active', draftedBy: 'p-commercial', preview: null },
      { id: 'cp-200-2', version: 2, credits: 200, price: usd('1500'), validityDays: null, reminderDaysBeforeExpiry: null, refundPolicyVersion: 2, status: 'draft', draftedBy: 'p-commercial', preview: packPreview },
    ],
    refundPolicy: { version: 2, summary: { text: 'Unused credits are refundable within 30 days of purchase; used credits are not.', lang: 'en' }, effectiveFrom: '2026-10-01T00:00:00Z' },
  },
  tax: {
    version: 1,
    feesTaxable: [
      { region: 'US-CA', treatment: 'exempt', source: 'https://tax.example/us-ca/digital-services', checkedAt: '2026-10-15T00:00:00Z' },
      { region: 'US-TX', treatment: 'taxable', source: 'https://tax.example/us-tx/data-processing', checkedAt: '2026-10-15T00:00:00Z' },
      { region: 'US-NY', treatment: 'needs_advice', source: 'https://tax.example/us-ny/saas', checkedAt: '2026-10-15T00:00:00Z' },
    ],
    eInvoicing: 'not_required',
    pricesShownWithTax: false,
  },
});

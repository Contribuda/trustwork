import { DEFAULT_MCP_HUB_POLICY, suppressSmallCount } from '@trustwork/contracts/client';
import { HUB_US_ID } from '../../../_fixtures/ids.js';
import { AgentProductSchema, type ActivationPreview, type AgentProduct } from '../modules/_kit/schemas.js';
import { digest, preview } from '../modules/_kit/fixture-helpers.js';

/**
 * Section-local fixtures of the agent product on the US demo hub (HC-80 to HC-85, HUBC-005). Synthetic: module and
 * extension keys are examples from the handbook, endpoints use `.example` hosts, counts are invented and pass through
 * `suppressSmallCount` like the AGT-004 statistics will, so anything under ten arrives as "fewer than 10". No record
 * names a participant or one participant's agent; drafters and approvers are the synthetic staff of `_fixtures/staff.ts`.
 */

const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const c = suppressSmallCount;
/** The US example hub's country pack code (the fixtures describe that hub; engine code never branches on it). */
const US_PACK = 'US';

const plannerPreview: ActivationPreview = preview('pv-agents-planner-3', 'a1', {
  changes: [
    { field: 'capability', before: { kind: 'key', key: 'product.values.capability.on' }, after: { kind: 'key', key: 'product.values.capability.offExternal' } },
    { field: 'outreachPerWeek', before: { kind: 'text', value: '20', lang: 'en' }, after: { kind: 'text', value: '15', lang: 'en' } },
  ],
  affected: { mandates: c(140), jobSubscriptions: c(37), externalConnections: c(6), openRuns: c(12), payers: null },
  audiences: ['external_client'],
  plans: [],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: usd('-1850'),
});

const orderDeskPreview: ActivationPreview = preview('pv-agents-order-desk-1', 'b2', {
  changes: [{ field: 'moduleStatus', before: { kind: 'key', key: 'product.values.module.draft' }, after: { kind: 'key', key: 'product.values.module.beta' } }],
  affected: { mandates: c(0), jobSubscriptions: c(0), externalConnections: c(0), openRuns: c(0), payers: c(24) },
  audiences: ['company_member', 'company_representative'],
  plans: ['company_team'],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: usd('4200'),
});

const policyPreview: ActivationPreview = preview('pv-agents-policy-4', 'c3', {
  changes: [{ field: 'requestsPerWeek', before: { kind: 'text', value: '10', lang: 'en' }, after: { kind: 'text', value: '8', lang: 'en' } }],
  affected: { mandates: c(96), jobSubscriptions: c(41), externalConnections: null, openRuns: c(3), payers: null },
  audiences: ['person', 'company_member'],
  plans: [],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: null,
});

const jurisdictionPreview: ActivationPreview = preview('pv-jur-us-tx-1', 'f3', {
  changes: [{ field: 'recordKeepingYears', before: { kind: 'text', value: '4', lang: 'en' }, after: { kind: 'text', value: '5', lang: 'en' } }],
  affected: { mandates: c(25), jobSubscriptions: null, externalConnections: null, openRuns: c(2), payers: null },
  audiences: ['person', 'company_member', 'company_representative'],
  plans: [],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: null,
});

const extensionPreview: ActivationPreview = preview('pv-ext-catalog-2', 'd4', {
  changes: [{ field: 'extensionStatus', before: { kind: 'key', key: 'product.values.extension.tested' }, after: { kind: 'key', key: 'product.values.extension.active' } }],
  affected: { mandates: c(58), jobSubscriptions: c(19), externalConnections: c(4), openRuns: c(0), payers: c(31) },
  audiences: ['company_member', 'company_representative'],
  plans: ['company_team'],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: usd('950'),
});

const abusePreview: ActivationPreview = preview('pv-agents-abuse-2', 'e5', {
  changes: [{ field: 'threshold', before: { kind: 'text', value: '40', lang: 'en' }, after: { kind: 'text', value: '30', lang: 'en' } }],
  affected: { mandates: null, jobSubscriptions: null, externalConnections: null, openRuns: null, payers: null },
  audiences: ['person', 'company_member', 'company_representative', 'external_client'],
  plans: [],
  advanceNoticeDays: null,
  estimatedMonthlyCostChange: null,
});

const guards = { mandates: true, budgets: true, approvals: true, killSwitches: true, egress: true, privacyRules: true, restrictedPlaces: true, untrustedTextNeverCommands: true } as const;
const extRef = (r: Record<string, unknown>) => ({ hubId: HUB_US_ID, hasFakeAdapter: true, guards, ...r });

export const US_AGENT_PRODUCT: AgentProduct = AgentProductSchema.parse({
  plans: ['free', 'pro_person', 'company_team'],
  modules: [
    {
      key: 'research', family: 'core', engineStatus: 'contract', version: 2, lifecycle: 'active', actions: ['research'],
      eligibility: ['person', 'company_member', 'company_representative', 'external_client'], verifiedCompanyRequired: false,
      capabilities: [
        { id: 'research.search_public', kind: 'read', hubOn: true, offFor: [], offForPlans: [] },
        { id: 'research.cited_answer', kind: 'read', hubOn: true, offFor: [], offForPlans: [] },
      ],
      defaults: [{ key: 'report_cadence_days', value: 7, maximum: 30, unit: 'count' }],
      jobs: [{ key: 'weekly_market_digest', offered: true, triggers: ['schedule'], minIntervalHours: 24 }],
      routes: [{ job: 'agent_reasoning', routeKey: 'public_vendor', dataClasses: ['public'] }],
      limits: { runsPerDay: 50, actionsPerDay: 0, concurrentRuns: 2, tokensPerMonth: 2000000, outreachPerWeek: null },
      metering: { unit: 'run', freeUnitsPerMonth: 100 },
      price: { priceVersionId: 'pr-research-2', version: 2, currency: 'USD', unit: 'run', costPerUnitMinor: '0.8', salePerUnitMinor: '2', costBasis: 'measured_average' },
      draft: null,
    },
    {
      key: 'project_planner', family: 'plan_to_people', engineStatus: 'proposed', version: 2, lifecycle: 'beta', actions: ['prepare', 'research', 'communicate'],
      eligibility: ['person', 'company_member', 'external_client'], verifiedCompanyRequired: false,
      capabilities: [
        { id: 'project_planner.build_plan', kind: 'draft', hubOn: true, offFor: [], offForPlans: [] },
        { id: 'project_planner.propose_requests', kind: 'draft', hubOn: true, offFor: [], offForPlans: [] },
        { id: 'project_planner.weekly_report', kind: 'read', hubOn: true, offFor: [], offForPlans: ['free'] },
      ],
      defaults: [
        { key: 'outreach_per_week', value: 10, maximum: 20, unit: 'per_week' },
        { key: 'approval_above_items', value: 5, maximum: 20, unit: 'count' },
      ],
      jobs: [
        { key: 'plan_progress_report', offered: true, triggers: ['schedule', 'deadline'], minIntervalHours: 24 },
        { key: 'find_consultants_for_step', offered: true, triggers: ['goal', 'request'], minIntervalHours: 6 },
      ],
      routes: [{ job: 'agent_drafting', routeKey: 'self_hosted_private', dataClasses: ['public', 'project_restricted'] }],
      limits: { runsPerDay: 30, actionsPerDay: 20, concurrentRuns: 2, tokensPerMonth: 1500000, outreachPerWeek: 20 },
      metering: { unit: 'run', freeUnitsPerMonth: 30 },
      price: { priceVersionId: 'pr-planner-1', version: 1, currency: 'USD', unit: 'run', costPerUnitMinor: '3.25', salePerUnitMinor: '10', costBasis: 'measured_average' },
      draft: { version: 3, baseVersion: 2, draftedBy: 'p-hub-owner', draftedAt: '2026-10-30T15:00:00Z', preview: plannerPreview },
    },
    {
      key: 'rfq_responder', family: 'deal', engineStatus: 'contract', version: 1, lifecycle: 'active', actions: ['prepare', 'send_quote', 'communicate'],
      eligibility: ['company_member', 'company_representative'], verifiedCompanyRequired: false,
      capabilities: [
        { id: 'rfq_responder.draft_quote', kind: 'draft', hubOn: true, offFor: [], offForPlans: [] },
        { id: 'rfq_responder.send_quote', kind: 'commit', hubOn: true, offFor: ['external_client'], offForPlans: ['free'] },
      ],
      defaults: [{ key: 'quotes_per_day', value: 10, maximum: 40, unit: 'per_day' }],
      jobs: [{ key: 'answer_matching_invitations', offered: true, triggers: ['event'], minIntervalHours: 1 }],
      routes: [{ job: 'agent_drafting', routeKey: 'self_hosted_private', dataClasses: ['public', 'company_private'] }],
      limits: { runsPerDay: 40, actionsPerDay: 40, concurrentRuns: 3, tokensPerMonth: 3000000, outreachPerWeek: 30 },
      metering: { unit: 'run', freeUnitsPerMonth: 30 },
      price: { priceVersionId: 'pr-rfq-1', version: 1, currency: 'USD', unit: 'run', costPerUnitMinor: '3.25', salePerUnitMinor: '10', costBasis: 'measured_average' },
      draft: null,
    },
    {
      key: 'order_desk', family: 'deal', engineStatus: 'contract', version: 1, lifecycle: 'draft', actions: ['place_order', 'accept_order'],
      eligibility: ['company_member', 'company_representative'], verifiedCompanyRequired: true,
      capabilities: [
        { id: 'order_desk.place_order', kind: 'commit', hubOn: true, offFor: ['external_client'], offForPlans: ['free', 'pro_person'] },
        { id: 'order_desk.accept_order', kind: 'commit', hubOn: true, offFor: ['external_client'], offForPlans: ['free', 'pro_person'] },
      ],
      defaults: [{ key: 'orders_per_day', value: 5, maximum: 20, unit: 'per_day' }],
      jobs: [],
      routes: [{ job: 'agent_reasoning', routeKey: 'self_hosted_private', dataClasses: ['public', 'company_private', 'deal_party_private'] }],
      limits: { runsPerDay: 20, actionsPerDay: 20, concurrentRuns: 1, tokensPerMonth: 1000000, outreachPerWeek: null },
      metering: { unit: 'action', freeUnitsPerMonth: 0 },
      price: null,
      draft: { version: 1, baseVersion: 0, draftedBy: 'p-hub-owner', draftedAt: '2026-10-29T10:00:00Z', preview: orderDeskPreview },
    },
    {
      key: 'reputation_coach', family: 'presence', engineStatus: 'proposed', version: 1, lifecycle: 'beta', actions: ['prepare', 'research', 'communicate'],
      eligibility: ['person', 'company_member'], verifiedCompanyRequired: false,
      capabilities: [
        { id: 'reputation_coach.suggest_evidence', kind: 'read', hubOn: true, offFor: [], offForPlans: [] },
        { id: 'reputation_coach.draft_confirmation_request', kind: 'draft', hubOn: true, offFor: [], offForPlans: [] },
      ],
      defaults: [{ key: 'confirmation_requests_per_month', value: 5, maximum: 10, unit: 'per_month' }],
      jobs: [{ key: 'monthly_reputation_review', offered: true, triggers: ['schedule'], minIntervalHours: 168 }],
      routes: [{ job: 'agent_drafting', routeKey: 'self_hosted_private', dataClasses: ['public', 'person_private'] }],
      limits: { runsPerDay: 10, actionsPerDay: 5, concurrentRuns: 1, tokensPerMonth: 500000, outreachPerWeek: 5 },
      metering: { unit: 'run', freeUnitsPerMonth: 20 },
      // A subsidised unit: the margin is negative and the screen highlights it.
      price: { priceVersionId: 'pr-coach-1', version: 1, currency: 'USD', unit: 'run', costPerUnitMinor: '1.8', salePerUnitMinor: '1', costBasis: 'model_list_price' },
      draft: null,
    },
  ],
  policy: {
    version: 3,
    forbiddenPreAuthorization: ['place_order', 'accept_order', 'release_payment'],
    commitmentsOnlyForVerifiedCompanies: true,
    outreachPerPersonPerWeek: 25,
    outreachOnlyToParticipants: true,
    channels: ['in_app', 'email'],
    disclosure: [
      { lang: 'en', text: 'Prepared by the agent of {person} on Trustwork.' },
      { lang: 'es', text: 'Preparado por el agente de {person} en Trustwork.' },
    ],
    planToPeople: { mayDraftRequests: true, mayDraftOffers: true, mayAcceptWithinMandate: false, requestsPerWeek: 10 },
    protectionLimits: { openIntroductionsPerPerson: 10, newCounterpartiesPerDay: 15, maxNegotiationRounds: 6, consumerMaxRounds: 3, envelopesPerCounterpartyPerDay: 20, publicRecordsPerConnectionPerDay: 2000, connectionsPerPerson: 3, connectionIdleExpiryDays: 90 },
    jurisdictions: [
      {
        ref: {
          hubId: HUB_US_ID, jurisdiction: 'US-CA', configVersionId: 'cv-jur-us-ca-2', version: 2, payloadDigest: digest('f1'),
          areas: ['agent_disclosure', 'liability_allocation', 'action_limits'],
          packDefaults: [
            { area: 'agent_disclosure', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/disclosure/bot-disclosure' } },
            { area: 'liability_allocation', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/liability/principal-bound' } },
          ],
          weakerThanMandatoryPackRule: false, disclosureLocales: ['en', 'es'], status: 'active',
        },
        preview: null,
        rows: [
          { area: 'agent_disclosure', packDefault: { text: 'Automated messages that try to influence a transaction say they are automated.', lang: 'en', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/disclosure/bot-disclosure' }, mandatory: true }, hubValue: { text: 'Every agent message says it is automated and names the person it acts for.', lang: 'en' }, comparison: 'stricter' },
          { area: 'liability_allocation', packDefault: { text: 'The principal is bound by commitments made within the mandate.', lang: 'en', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/liability/principal-bound' }, mandatory: false }, hubValue: { text: 'The principal is bound by commitments made within the mandate.', lang: 'en' }, comparison: 'same' },
          { area: 'action_limits', packDefault: { text: 'No engine default; the hub sets the limit.', lang: 'en', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/limits/none' }, mandatory: false }, hubValue: { text: 'Orders above 2,500 USD always need the person to confirm.', lang: 'en' }, comparison: 'stricter' },
        ],
      },
      {
        ref: {
          hubId: HUB_US_ID, jurisdiction: 'US-TX', configVersionId: 'cv-jur-us-tx-1', version: 1, payloadDigest: digest('f2'),
          areas: ['agent_disclosure', 'record_keeping'],
          packDefaults: [{ area: 'agent_disclosure', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/disclosure/general' } }],
          // The Spanish disclosure is missing, so this draft cannot be activated yet.
          weakerThanMandatoryPackRule: false, disclosureLocales: ['en'], status: 'draft',
        },
        preview: jurisdictionPreview,
        rows: [
          { area: 'agent_disclosure', packDefault: { text: 'Agent messages are labelled as automated.', lang: 'en', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'agents/disclosure/general' }, mandatory: true }, hubValue: { text: 'Agent messages are labelled as automated.', lang: 'en' }, comparison: 'same' },
          { area: 'record_keeping', packDefault: { text: 'Keep records of commitments for four years.', lang: 'en', fact: { packCode: 'US', packVersion: '0.3.0', factKey: 'records/commitments/retention' }, mandatory: false }, hubValue: { text: 'Keep records of commitments for five years.', lang: 'en' }, comparison: 'stricter' },
        ],
      },
    ],
    draft: { version: 4, baseVersion: 3, draftedBy: 'p-hub-owner', draftedAt: '2026-10-30T17:00:00Z', preview: policyPreview },
  },
  extensions: [
    {
      ref: extRef({
        id: 'ext-permit-lookup-1', extensionId: 'ext-permit-lookup', key: 'permit_lookup', version: 1, manifestDigest: digest('aa'),
        capabilityIds: ['permit_lookup.check_status'], dataClassesRead: ['public'], dataClassesSent: ['public'], endpoints: [{ host: 'permits.city.example', country: US_PACK }],
        adapterId: 'city_permits', safetySuite: { runId: 'ss-permit-1', onFakeAdapter: true, passed: true, engineVersion: '0.9.0', at: '2026-10-20T09:00:00Z' },
        status: 'active', draftedBy: 'p-hub-owner', approvedBy: 'p-compliance', approvalId: 'ap-ext-permit-1', activatedConfigVersionId: 'cv-ext-permit-1',
      }),
      title: { text: 'City permit status lookup', lang: 'en' },
      actions: [{ capabilityId: 'permit_lookup.check_status', mandateKind: 'research', sideEffect: 'external_call' }],
      inputs: ['permit_number', 'city'],
      costModel: { unit: 'api_call', costPerUnitMinor: '0.5', currency: 'USD' },
      routeKey: null,
      history: [
        { at: '2026-10-18T09:00:00Z', event: 'drafted', by: 'p-hub-owner' },
        { at: '2026-10-20T09:00:00Z', event: 'safety_passed', by: 'p-hub-owner' },
        { at: '2026-10-21T10:00:00Z', event: 'activated', by: 'p-compliance' },
      ],
      preview: null,
    },
    {
      ref: extRef({
        id: 'ext-catalog-sync-2', extensionId: 'ext-catalog-sync', key: 'supplier_catalog', version: 2, manifestDigest: digest('bb'),
        capabilityIds: ['supplier_catalog.import_items', 'supplier_catalog.draft_listing'], dataClassesRead: ['public', 'company_private'], dataClassesSent: ['public'],
        endpoints: [{ host: 'api.catalog-partner.example', country: US_PACK }], adapterId: 'catalog_partner',
        safetySuite: { runId: 'ss-catalog-2', onFakeAdapter: true, passed: true, engineVersion: '0.9.0', at: '2026-10-29T14:00:00Z' },
        status: 'tested', draftedBy: 'p-hub-owner', approvedBy: null, approvalId: null, activatedConfigVersionId: null,
      }),
      title: { text: 'Supplier catalogue import', lang: 'en' },
      actions: [
        { capabilityId: 'supplier_catalog.import_items', mandateKind: 'maintain_records', sideEffect: 'state_change' },
        { capabilityId: 'supplier_catalog.draft_listing', mandateKind: 'prepare', sideEffect: 'draft_state' },
      ],
      inputs: ['catalogue_file', 'category'],
      costModel: { unit: 'thousand_tokens', costPerUnitMinor: '0.4', currency: 'USD' },
      routeKey: 'public_vendor',
      history: [
        { at: '2026-10-27T09:00:00Z', event: 'drafted', by: 'p-hub-owner' },
        { at: '2026-10-29T14:00:00Z', event: 'safety_passed', by: 'p-hub-owner' },
      ],
      preview: extensionPreview,
    },
    {
      ref: extRef({
        id: 'ext-weather-1', extensionId: 'ext-weather', key: 'weather_window', version: 1, manifestDigest: digest('cc'),
        capabilityIds: ['weather_window.suggest_dates'], dataClassesRead: ['public', 'project_restricted'], dataClassesSent: ['public'],
        endpoints: [{ host: 'forecast.weather-service.example', country: US_PACK }], adapterId: 'weather_service',
        // The safety suite failed (a forecast text tried to change the plan), so activation is blocked.
        safetySuite: { runId: 'ss-weather-1', onFakeAdapter: true, passed: false, engineVersion: '0.9.0', at: '2026-10-30T11:00:00Z' },
        status: 'draft', draftedBy: 'p-hub-owner', approvedBy: null, approvalId: null, activatedConfigVersionId: null,
      }),
      title: { text: 'Weather windows for site work', lang: 'en' },
      actions: [{ capabilityId: 'weather_window.suggest_dates', mandateKind: 'prepare', sideEffect: 'draft_state' }],
      inputs: ['site_region', 'plan_step'],
      costModel: { unit: 'api_call', costPerUnitMinor: '0.1', currency: 'USD' },
      routeKey: null,
      history: [
        { at: '2026-10-30T09:00:00Z', event: 'drafted', by: 'p-hub-owner' },
        { at: '2026-10-30T11:00:00Z', event: 'safety_failed', by: 'p-hub-owner' },
      ],
      preview: null,
    },
  ],
  external: {
    protocols: { mcp: true, a2a: false },
    rateLimits: { defaultPerMinute: 30, maximumPerMinute: 60, defaultActionsPerDay: 20, maximumActionsPerDay: 50 },
    modulesForExternalClients: ['research', 'project_planner'],
    representativesMayUseExternalClients: false,
    registeredClients: { mcp: c(43), a2a: c(0) },
    mcp: { ...DEFAULT_MCP_HUB_POLICY, disabledTools: [], revision: 2 },
  },
  usage: [
    { hubId: HUB_US_ID, from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', moduleKey: 'research', activePrincipals: c(412), runs: c(3120), actionsSucceeded: c(0), actionsEscalatedToHumans: c(0), outcomeUnknown: 0, cost: usd('2496'), revenue: usd('4100') },
    { hubId: HUB_US_ID, from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', moduleKey: 'project_planner', activePrincipals: c(88), runs: c(940), actionsSucceeded: c(310), actionsEscalatedToHumans: c(42), outcomeUnknown: 0, cost: usd('3055'), revenue: usd('6200') },
    { hubId: HUB_US_ID, from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', moduleKey: 'rfq_responder', activePrincipals: c(7), runs: c(64), actionsSucceeded: c(22), actionsEscalatedToHumans: c(9), outcomeUnknown: 1, cost: usd('208'), revenue: usd('340') },
    { hubId: HUB_US_ID, from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', moduleKey: 'reputation_coach', activePrincipals: c(51), runs: c(230), actionsSucceeded: c(75), actionsEscalatedToHumans: c(18), outcomeUnknown: 0, cost: usd('414'), revenue: usd('110') },
  ],
  cohorts: [
    { segment: 'audience', key: 'person', activePrincipals: c(380), runs: c(3510), cost: usd('4600'), revenue: usd('7300') },
    { segment: 'audience', key: 'company_member', activePrincipals: c(52), runs: c(780), cost: usd('1400'), revenue: usd('3200') },
    { segment: 'audience', key: 'external_client', activePrincipals: c(6), runs: c(64), cost: usd('173'), revenue: usd('250') },
    { segment: 'plan', key: 'free', activePrincipals: c(300), runs: c(2100), cost: usd('2900'), revenue: usd('0') },
    { segment: 'plan', key: 'pro_person', activePrincipals: c(64), runs: c(1600), cost: usd('2200'), revenue: usd('8100') },
    { segment: 'plan', key: 'company_team', activePrincipals: c(9), runs: c(654), cost: usd('1073'), revenue: usd('2650') },
  ],
  abuse: {
    signals: [
      { kind: 'rate_above_limit', last7Days: 112, threshold: 50, response: 'throttle', casesOpened: 0 },
      { kind: 'outreach_declines', last7Days: 14, threshold: 40, response: 'quota_reduction', casesOpened: 1 },
      { kind: 'injection_attempts', last7Days: 5, threshold: 3, response: 'security_event', casesOpened: 1 },
      { kind: 'confirmation_spam', last7Days: 2, threshold: 10, response: 'confirmation_limit', casesOpened: 0 },
      { kind: 'unknown_outcomes', last7Days: 1, threshold: 5, response: 'module_pause', casesOpened: 0 },
    ],
    throttlesActive: 3,
    draft: { version: 2, baseVersion: 1, draftedBy: 'p-ops', draftedAt: '2026-10-31T08:00:00Z', preview: abusePreview },
  },
});

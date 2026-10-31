import test from 'node:test';
import assert from 'node:assert/strict';
import { isRestricted } from '@trustwork/country-packs';
import * as c from '../../packages/contracts/src/index.js';

const at = '2026-10-31T10:00:00Z';
const later = '2026-11-01T10:00:00Z';
const digest = { algorithm: 'trustwork-digest-1' as const, value: 'a'.repeat(64) };
const sha = 'b'.repeat(64);

// US reference hub (owner decision 2026-10-31) with Spanish as the second language.
const usHub: c.Hub = {
  id: 'hub-us',
  nodeId: 'node-1',
  slug: 'us',
  name: { en: 'Trustwork United States', 'es-US': 'Trustwork Estados Unidos' },
  lifecycle: 'preparing',
  territories: [{ level: 'country', code: 'US' }, { level: 'region', code: 'US-TX' }, { level: 'place', code: 'US-TX:austin', wikidata: 'Q16559', osmRelation: null }],
  countryPack: null,
  defaultLocale: 'en',
  locales: ['en', 'es-US'],
  timeZone: 'America/Chicago',
  currency: 'USD',
  brandOverlay: null,
  revision: 1,
};

test('hub: locales, names and territory shapes; the US hub starts from the generic profile', () => {
  assert.ok(c.HubSchema.safeParse(usHub).success);
  assert.equal(c.HubSchema.safeParse({ ...usHub, defaultLocale: 'fr' }).success, false, 'default locale must be served');
  assert.equal(c.HubSchema.safeParse({ ...usHub, name: { en: 'Trustwork United States' } }).success, false, 'name in every hub locale');
  assert.equal(c.HubSchema.safeParse({ ...usHub, locales: ['en', 'en'], name: { en: 'x' } }).success, false);
  assert.ok(c.LocaleTagSchema.safeParse('uz-Latn').success && c.LocaleTagSchema.safeParse('es-419').success);
  assert.equal(c.LocaleTagSchema.safeParse('EN').success, false);
  const uz = { ...usHub, id: 'hub-uz', slug: 'uz-samarkand', name: { 'uz-Latn': 'Trustwork Samarqand', ru: 'Trustwork Самарканд' }, defaultLocale: 'uz-Latn', locales: ['uz-Latn', 'ru'], territories: [{ level: 'place', code: 'UZ-SA:samarkand', wikidata: null, osmRelation: null }], countryPack: { code: 'UZ', version: '1' }, timeZone: 'Asia/Samarkand', currency: 'UZS' };
  assert.ok(c.HubSchema.safeParse(uz).success, 'one non-US example proves the same shape');
});

test('territory: restricted places are refused at country, region and place level (predicate from country-packs)', () => {
  const t = (code: string) => (code.includes(':') ? { level: 'place' as const, code, wikidata: null, osmRelation: null } : code.includes('-') ? { level: 'region' as const, code } : { level: 'country' as const, code });
  assert.equal(c.territoryRestricted(t('US-TX:austin'), isRestricted), false);
  assert.equal(c.territoryRestricted(t('RU'), isRestricted), true);
  assert.equal(c.territoryRestricted(t('UA-43'), isRestricted), true);
  assert.equal(c.territoryRestricted(t('UA-43:simferopol'), isRestricted), true, 'a place inside a restricted region is restricted');
  assert.equal(c.territoryRestricted(t('UA-30:kyiv'), isRestricted), false);
  assert.deepEqual(c.territoryCodes(t('US-TX:austin')), ['US', 'US-TX', 'US-TX:austin']);
});

test('lifecycle transitions and launch gates: no waiver, public needs every gate', () => {
  assert.ok(c.hubTransitionAllowed('preparing', 'soft_launch'));
  assert.equal(c.hubTransitionAllowed('draft', 'public'), false);
  assert.equal(c.hubTransitionAllowed('closed', 'public'), false);
  const passed = (gate: c.LaunchGateId): c.LaunchGate => ({ hubId: 'hub-us', gate, state: 'passed', evidenceRef: `ev-${gate}`, checkedBy: 'p-1', checkedAt: at });
  assert.equal(c.LaunchGateSchema.safeParse({ ...passed('i18n_complete'), evidenceRef: null }).success, false);
  assert.equal(c.LaunchGateSchema.safeParse({ ...passed('i18n_complete'), state: 'waived' }).success, false);
  const soft = c.SOFT_LAUNCH_GATES.map(passed);
  assert.deepEqual(c.blockingGates('soft_launch', soft), []);
  assert.ok(c.blockingGates('public', soft).includes('backup_restore_exercised'));
  assert.deepEqual(c.blockingGates('public', c.LAUNCH_GATES.map(passed)), []);
});

const modes: c.HubModes = {
  dataMode: 'demo',
  registration: 'closed',
  modules: ['publications', 'magazine', 'events', 'search'],
  moderation: 'pre_moderate_new_authors',
  automation: { editorial: 'assisted', translation: 'assisted', magazine_assembly: 'manual', data_mining: 'manual', entity_resolution: 'manual', verification_rechecks: 'assisted', moderation_triage: 'manual' },
  searchEngineIndexing: false,
  maintenance: false,
};
test('modes: demo data stays private and pre-launch; module dependencies hold', () => {
  assert.ok(c.HubModesSchema.safeParse(modes).success);
  assert.deepEqual(c.modesViolations('preparing', modes), []);
  assert.ok(c.modesViolations('soft_launch', modes).includes('demo_data_only_before_soft_launch'));
  assert.ok(c.modesViolations('preparing', { ...modes, searchEngineIndexing: true }).includes('demo_data_never_indexed'));
  assert.ok(c.modesViolations('soft_launch', { ...modes, dataMode: 'live', registration: 'open' }).includes('open_registration_only_when_public'));
  assert.ok(c.modesViolations('public', { ...modes, dataMode: 'live', modules: ['sales'] }).includes('module_sales_requires_procurement'));
  assert.ok(c.modesViolations('public', { ...modes, dataMode: 'live', modules: ['expert_marketplace'] }).includes('module_expert_marketplace_requires_billing'));
  assert.equal(c.HubModesSchema.safeParse({ ...modes, automation: { ...modes.automation, editorial: 'autonomous' } }).success, false, 'no unsupervised level');
  assert.ok(c.HUMAN_GATES.includes('publication') && c.HUMAN_GATES.includes('dataset_activation'));
});

test('permissions and second-person actions extend the frozen vocabulary without duplicates', () => {
  const frozen = new Set<string>(c.ADMIN_PERMISSIONS);
  assert.ok(c.HUB_CONSOLE_PERMISSIONS.every((p) => !frozen.has(p) && /^admin\.[a-z_]+(\.[a-z_]+)+$/.test(p)));
  assert.equal(new Set(c.HUB_CONSOLE_PERMISSIONS).size, c.HUB_CONSOLE_PERMISSIONS.length);
  assert.ok(c.ConsolePermissionSchema.safeParse('admin.audit.read').success && c.ConsolePermissionSchema.safeParse('admin.providers.secret.write').success);
  assert.equal(c.ConsolePermissionSchema.safeParse('admin.ranking.edit').success, false, 'no ranking permission exists');
  assert.ok(c.consoleActionNeedsSecondPerson('providers.enable_non_fake'));
  assert.ok(c.consoleActionNeedsSecondPerson('hub.transition_public'));
  assert.equal(c.consoleActionNeedsSecondPerson('hub.edit_identity'), false);
});

test('hub staff: sensitive roles need a distinct approver; node-operator is node-scoped', () => {
  const a: c.HubStaffAssignment = { id: 'a1', personId: 'p-2', role: 'editor', scope: { kind: 'hub', hubId: 'hub-us' }, grantedBy: 'p-1', approvedBy: null, reason: 'Editorial team', validFrom: at, validUntil: null, revokedAt: null };
  assert.ok(c.HubStaffAssignmentSchema.safeParse(a).success);
  assert.equal(c.HubStaffAssignmentSchema.safeParse({ ...a, role: 'hub-owner' }).success, false);
  assert.equal(c.HubStaffAssignmentSchema.safeParse({ ...a, role: 'compliance-officer', approvedBy: 'p-1' }).success, false);
  assert.ok(c.HubStaffAssignmentSchema.safeParse({ ...a, role: 'compliance-officer', approvedBy: 'p-3' }).success);
  assert.equal(c.HubStaffAssignmentSchema.safeParse({ ...a, role: 'node-operator', approvedBy: 'p-3' }).success, false);
});

test('config versions: sensitive domains need approval and a different activator; no back-dating', () => {
  const v: c.HubConfigVersion = { id: 'cv1', hubId: 'hub-us', domain: 'modes', version: 2, payloadDigest: digest, status: 'active', reason: 'Enable events', draftedBy: 'p-1', activatedBy: 'p-1', activatedAt: at, approvalId: null, effectiveFrom: at };
  assert.ok(c.HubConfigVersionSchema.safeParse(v).success);
  assert.equal(c.HubConfigVersionSchema.safeParse({ ...v, domain: 'residency' }).success, false);
  assert.ok(c.HubConfigVersionSchema.safeParse({ ...v, domain: 'residency', activatedBy: 'p-2', approvalId: 'ap-1' }).success);
  assert.equal(c.HubConfigVersionSchema.safeParse({ ...v, effectiveFrom: '2026-10-30T10:00:00Z' }).success, false);
});

const secretRef: c.SecretRef = { id: 's1', store: 'envelope_db', ref: 'hub-us/providers/openai/api-key', keyedFingerprint: '0123456789ab', version: 1, createdAt: at, createdBy: 'p-1', rotatedAt: null, lastUsedAt: null };
test('secrets: references only, values rejected wherever a reference is expected', () => {
  assert.ok(c.SecretRefSchema.safeParse(secretRef).success);
  for (const value of ['sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'sk_live_51Habcdefghijklmnop', 'AKIAIOSFODNN7EXAMPLE', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Zx9vQ2mL8kP4nR7tY1wE5uI3oA6sD0fG2hJ']) {
    assert.ok(c.looksLikeSecretValue(value), value);
    assert.equal(c.SecretRefSchema.safeParse({ ...secretRef, ref: value }).success, false, value);
  }
  assert.equal(c.looksLikeSecretValue('hub-us/providers/openai/api-key'), false);
  assert.equal(c.SecretRefSchema.safeParse({ ...secretRef, value: 'sk-123' }).success, false, 'strict: no value field');
  assert.ok(c.SecretSubmitCommandSchema.safeParse({ connectionId: 'pc1', value: 'sk-test-only-synthetic', reason: 'Initial key', expectedRevision: 1 }).success);
});

const openai: c.ProviderConnection = {
  id: 'pc-openai', scope: { kind: 'hub', hubId: 'hub-us' }, adapterId: 'openai', label: 'OpenAI', capabilities: ['llm', 'embeddings'], mode: 'live', endpoint: 'https://api.openai.com/v1',
  secretRef, hosting: { kind: 'vendor', country: 'US', zeroRetention: true, trainsOnInputs: false, broker: false }, status: 'enabled',
  lastTest: { at, by: 'p-1', outcome: 'ok', latencyMs: 420, modelsListed: 12, cost: { minorUnits: '1', currency: 'USD' }, syntheticInputOnly: true }, enabledBy: 'p-2', approvalId: 'ap-2', revision: 3,
};
const ollama: c.ProviderConnection = { ...openai, id: 'pc-local', adapterId: 'openai_compatible', label: 'Local models', endpoint: 'http://10.0.0.5:11434/v1', secretRef: null, hosting: { kind: 'self_hosted', country: 'US' } };
test('provider connections: live needs secret and second person, http only self-hosted, enable after a passing test', () => {
  assert.ok(c.ProviderConnectionSchema.safeParse(openai).success);
  assert.ok(c.ProviderConnectionSchema.safeParse(ollama).success, 'local endpoint without a key');
  assert.equal(c.ProviderConnectionSchema.safeParse({ ...openai, secretRef: null }).success, false);
  assert.equal(c.ProviderConnectionSchema.safeParse({ ...openai, approvalId: null }).success, false);
  assert.equal(c.ProviderConnectionSchema.safeParse({ ...openai, endpoint: 'http://api.example.com' }).success, false);
  assert.equal(c.ProviderConnectionSchema.safeParse({ ...openai, lastTest: { ...openai.lastTest!, outcome: 'auth_failed' } }).success, false);
  assert.equal(c.ProviderConnectionSchema.safeParse({ ...openai, mode: 'fake' }).success, false, 'fakes hold no secret');
  assert.equal(c.ConnectionTestResultSchema.safeParse({ ...openai.lastTest, syntheticInputOnly: false }).success, false);
});

const route: c.ModelRoute = {
  id: 'r1', hubId: 'hub-us', job: 'editorial_rewrite', version: 1, primary: { connectionId: 'pc-openai', modelId: 'model-a', modelRevision: null },
  fallbacks: [{ connectionId: 'pc-local', modelId: 'model-b', modelRevision: null }], allowedDataClasses: ['public'],
  limits: { maxInputTokens: 16000, maxOutputTokens: 2000, timeoutMs: 60000 }, budgetId: 'b1', status: 'active', draftedBy: 'p-1', activatedBy: 'p-1', approvalId: null,
};
test('model routes: no repeated fallbacks, embeddings never mix, images public only, private routes need two people', () => {
  assert.ok(c.ModelRouteSchema.safeParse(route).success);
  assert.equal(c.ModelRouteSchema.safeParse({ ...route, fallbacks: [route.primary] }).success, false);
  assert.equal(c.ModelRouteSchema.safeParse({ ...route, job: 'embeddings' }).success, false);
  assert.equal(c.ModelRouteSchema.safeParse({ ...route, job: 'image_generation', fallbacks: [], allowedDataClasses: ['public', 'person_private'] }).success, false);
  assert.equal(c.ModelRouteSchema.safeParse({ ...route, job: 'agent_reasoning', allowedDataClasses: ['public', 'party_private' as never] }).success, false);
  assert.equal(c.ModelRouteSchema.safeParse({ ...route, job: 'agent_reasoning', allowedDataClasses: ['public', 'deal_party_private'] }).success, false);
  assert.ok(c.ModelRouteSchema.safeParse({ ...route, job: 'agent_reasoning', allowedDataClasses: ['public', 'deal_party_private'], activatedBy: 'p-2', approvalId: 'ap-3' }).success);
});

test('egress: default deny, residency, retention and never to vendors that train on inputs', () => {
  const rule = (o: Partial<c.EgressRule>): c.EgressRule => ({ hubId: 'hub-us', connectionId: 'pc-openai', dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, version: 1, approvalId: null, ...o });
  assert.equal(c.EgressRuleSchema.safeParse(rule({ dataClass: 'person_private' })).success, false);
  const priv = rule({ dataClass: 'person_private', requireInResidency: true, requireZeroRetention: true, approvalId: 'ap-4' });
  assert.ok(c.EgressRuleSchema.safeParse(priv).success);
  const input = { connection: openai, dataClass: 'person_private' as const, residencyCountry: 'US' };
  assert.deepEqual(c.egressDecision([], input), { allowed: false, reason: 'no_rule' });
  assert.deepEqual(c.egressDecision([priv], input), { allowed: true, reason: 'allowed' });
  assert.deepEqual(c.egressDecision([priv], { ...input, residencyCountry: 'UZ' }), { allowed: false, reason: 'residency' });
  assert.deepEqual(c.egressDecision([priv], { ...input, connection: { ...openai, hosting: { kind: 'vendor', country: 'US', zeroRetention: false, trainsOnInputs: false, broker: true } } }), { allowed: false, reason: 'retention' });
  assert.deepEqual(c.egressDecision([priv], { ...input, connection: { ...openai, hosting: { kind: 'vendor', country: 'US', zeroRetention: true, trainsOnInputs: true, broker: false } } }), { allowed: false, reason: 'training' });
  assert.deepEqual(c.egressDecision([priv, { ...priv, version: 2, decision: 'deny' }], input), { allowed: false, reason: 'denied' }, 'latest version wins');
  assert.deepEqual(c.egressDecision([priv], { ...input, connection: { ...openai, status: 'killed' } }), { allowed: false, reason: 'connection_not_enabled' });
});

test('budgets, kill switches and cohort suppression', () => {
  const b: c.ProviderBudget = { id: 'b1', hubId: 'hub-us', scope: { kind: 'job', job: 'translation' }, period: 'month', limit: { minorUnits: '50000', currency: 'USD' }, alertAtPercent: [50, 80], onExhausted: 'pause', revision: 1 };
  assert.ok(c.ProviderBudgetSchema.safeParse(b).success);
  assert.equal(c.providerBudgetState(b, '1000'), 'ok');
  assert.equal(c.providerBudgetState(b, '40000'), 'alert');
  assert.equal(c.providerBudgetState(b, '50000'), 'exhausted');
  assert.equal(c.ProviderBudgetSchema.safeParse({ ...b, onExhausted: 'allow_overspend' }).success, false);
  const k: c.KillSwitch = { id: 'k1', scope: { kind: 'hub_agent_dispatch', hubId: 'hub-us' }, state: 'engaged', engagedBy: 'p-1', engagedAt: at, reason: 'Injection campaign', releasedBy: null, releasedAt: null, releaseApprovalId: null, incidentNote: null };
  assert.ok(c.KillSwitchSchema.safeParse(k).success);
  assert.equal(c.KillSwitchSchema.safeParse({ ...k, state: 'released', releasedBy: 'p-2', releasedAt: later, releaseApprovalId: 'ap-5' }).success, false, 'release needs an incident note');
  assert.ok(c.KillSwitchSchema.safeParse({ ...k, state: 'released', releasedBy: 'p-2', releasedAt: later, releaseApprovalId: 'ap-5', incidentNote: 'INC-7 reviewed' }).success);
  assert.equal(c.suppressSmallCount(9), null);
  assert.equal(c.suppressSmallCount(10), 10);
});

const source: c.HubSource = {
  id: 'src-sam', hubId: 'hub-us', kind: 'api', name: 'SAM.gov contract opportunities', url: 'https://sam.gov/', purposes: ['opportunities'],
  licence: { kind: 'statutory_public', name: 'US federal public data', url: null, agreementRef: null }, robots: null, terms: null,
  allowedUses: { displayHeadlineAndLink: true, displaySummary: true, storeFullText: true, indexForSearch: true, sendToModelProviders: true, translate: true, rewriteWithAttribution: true, reuseImages: false, syndicateToPeers: true },
  attributionTemplate: 'Source: SAM.gov', takedownContact: 'data steward', ownerPersonId: 'p-3', personalData: false, legalBasis: null,
  proposedBy: { kind: 'pipeline', pipelineId: 'pl-disc', runId: 'run-1' }, status: 'active', activatedBy: 'p-3', activatedAt: at, pauseReason: null, revision: 2,
};
test('sources: pipelines propose, people activate; crawling needs robots and terms; no licence means headline and link', () => {
  assert.ok(c.HubSourceSchema.safeParse(source).success);
  assert.equal(c.HubSourceSchema.safeParse({ ...source, activatedBy: null }).success, false);
  assert.equal(c.HubSourceSchema.safeParse({ ...source, kind: 'web_page' }).success, false);
  const robots = { checkedAt: at, robotsUrl: 'https://example.org/robots.txt', userAgent: 'TrustworkBot', allowed: true, crawlDelaySeconds: 10, robotsDigest: sha };
  const terms = { checkedAt: at, termsUrl: 'https://example.org/terms', termsDigest: sha, automatedAccess: 'permitted' as const, reviewedBy: 'p-3', notes: '' };
  assert.ok(c.HubSourceSchema.safeParse({ ...source, kind: 'web_page', robots, terms }).success);
  assert.equal(c.HubSourceSchema.safeParse({ ...source, kind: 'web_page', robots, terms: { ...terms, automatedAccess: 'unclear' } }).success, false);
  assert.equal(c.HubSourceSchema.safeParse({ ...source, kind: 'sitemap', robots: { ...robots, allowed: false }, terms }).success, false);
  const unlicensed = { ...source, licence: { kind: 'unknown' as const, name: null, url: null, agreementRef: null } };
  assert.equal(c.HubSourceSchema.safeParse(unlicensed).success, false);
  assert.ok(c.HubSourceSchema.safeParse({ ...unlicensed, allowedUses: { ...source.allowedUses, storeFullText: false, sendToModelProviders: false, translate: false, rewriteWithAttribution: false, syndicateToPeers: false } }).success);
  assert.equal(c.HubSourceSchema.safeParse({ ...source, personalData: true }).success, false, 'personal data needs a legal basis');
});

const dataset: c.Dataset = {
  id: 'ds-lic', hubId: 'hub-us', subject: 'licences_permits', name: 'Texas TDLR licence holders (candidate)', sourceIds: ['src-tdlr'], purpose: 'Licence checks for verification and eligibility',
  legalBasis: 'statutory_public_register', personalData: { present: true, naturalPersons: true, categories: ['name', 'licence_number'] }, impactAssessmentRef: null,
  retention: { className: 'register_mirror', days: 400 }, outputs: ['verification_evidence', 'matching_eligibility'], publicDisplay: false, subjectNotice: true,
  refreshScheduleId: 'sch-1', status: 'active', activatedBy: 'p-3', approvalId: 'ap-6', version: 1,
};
test('datasets: legal flags per subject, no reputation output, personal data needs two people', () => {
  assert.ok(c.DatasetSchema.safeParse(dataset).success);
  assert.equal(c.DatasetSchema.safeParse({ ...dataset, approvalId: null }).success, false);
  assert.equal(c.DatasetSchema.safeParse({ ...dataset, outputs: ['reputation'] }).success, false);
  const court = { ...dataset, subject: 'court_cases' as const, outputs: ['verification_evidence' as const], personalData: { present: true, naturalPersons: true, categories: ['court_party' as const] } };
  assert.equal(c.DatasetSchema.safeParse(court).success, false, 'impact assessment required');
  assert.ok(c.DatasetSchema.safeParse({ ...court, impactAssessmentRef: 'dpia-1' }).success);
  assert.equal(c.DatasetSchema.safeParse({ ...court, impactAssessmentRef: 'dpia-1', publicDisplay: true }).success, false);
  assert.equal(c.DatasetSchema.safeParse({ ...court, impactAssessmentRef: 'dpia-1', outputs: ['verification_evidence', 'knowledge_base'] }).success, false);
  assert.equal(c.DatasetSchema.safeParse({ ...dataset, subject: 'people', legalBasis: 'legitimate_interest_assessed', impactAssessmentRef: 'dpia-2', outputs: ['verification_evidence'] }).success, false);
  assert.equal(c.DatasetSchema.safeParse({ ...dataset, subject: 'court_cases', impactAssessmentRef: 'dpia-1', personalData: { present: false, naturalPersons: false, categories: [] }, outputs: ['matching_eligibility'] }).success, false);
});

test('entity links: always a link, decided by a person; people need their own confirmation', () => {
  const l: c.LinkProposal = { id: 'l1', hubId: 'hub-us', left: { kind: 'company', id: 'co-1' }, right: { kind: 'sourced_record', id: 'sr-9' }, evidence: [{ kind: 'identifier_match', detail: 'EIN matches', score: '1' }], confidence: '0.98', proposedBy: { kind: 'pipeline', pipelineId: 'pl-er', runId: 'run-2' }, status: 'proposed', decidedBy: null, decidedAt: null, effect: 'link' };
  assert.ok(c.LinkProposalSchema.safeParse(l).success);
  assert.equal(c.LinkProposalSchema.safeParse({ ...l, effect: 'merge' }).success, false);
  assert.equal(c.LinkProposalSchema.safeParse({ ...l, status: 'accepted' }).success, false);
  assert.equal(c.LinkProposalSchema.safeParse({ ...l, confidence: '1.5' }).success, false);
  const person = { ...l, left: { kind: 'person' as const, id: 'p-9' }, status: 'accepted' as const, decidedBy: 'p-3', decidedAt: at };
  assert.equal(c.LinkProposalSchema.safeParse(person).success, false);
  assert.ok(c.LinkProposalSchema.safeParse({ ...person, evidence: [...l.evidence, { kind: 'subject_confirmation', detail: 'Confirmed by the person', score: null }] }).success);
});

const schedule: c.Schedule = {
  id: 'sch-1', hubId: 'hub-us', pipelineId: 'pl-1', cron: '15 2 * * 1-5', timeZone: 'America/Chicago', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '01:00', to: '05:00' }], jitterSeconds: 300,
  quotas: { maxItemsPerRun: 500, maxRunsPerDay: 1, maxCostPerRun: { minorUnits: '500', currency: 'USD' }, maxRequestsPerMinutePerHost: 30 },
  retry: { maxAttempts: 3, backoff: 'exponential', baseSeconds: 60, maxDelaySeconds: 3600, retryOn: ['network', 'server_error'] }, concurrency: 1,
  alerts: [{ kind: 'zero_items_streak', threshold: 3, notify: 'console' }], paused: false, pausedBy: null, pausedReason: null, revision: 1,
};
test('schedules: cron shape, windows, bounded retries, paused needs a reason', () => {
  assert.ok(c.ScheduleSchema.safeParse(schedule).success);
  for (const bad of ['* * * *', '@daily', '61 * * * * *', 'a b c d e']) assert.equal(c.ScheduleSchema.safeParse({ ...schedule, cron: bad }).success, false, bad);
  assert.ok(c.ScheduleSchema.safeParse({ ...schedule, cron: '*/15 0-6 1,15 * *' }).success);
  assert.equal(c.ScheduleSchema.safeParse({ ...schedule, retry: { ...schedule.retry, maxAttempts: 50 } }).success, false);
  assert.equal(c.ScheduleSchema.safeParse({ ...schedule, paused: true }).success, false);
  assert.equal(c.ScheduleSchema.safeParse({ ...schedule, windows: [{ days: ['mon'], from: '02:00', to: '02:00' }] }).success, false);
});

const step = (kind: c.PipelineStepKind, job: c.ModelJob | null = null): c.PipelineStep => ({ kind, modelRouteId: job ? `route-${job}` : null, modelJob: job, settings: {} });
const pipeline: c.PipelineVersion = {
  id: 'pv1', pipelineId: 'pl-1', hubId: 'hub-us', kind: 'editorial_drafting', version: 1, name: 'Construction news desk (en, es-US)', sourceIds: ['src-sam'], datasetId: null,
  steps: [step('fetch'), step('parse'), step('deduplicate'), step('classify', 'classification'), step('rewrite', 'editorial_rewrite'), step('similarity_check'), step('fact_check', 'fact_check_assist'), step('translate', 'translation'), step('generate_image', 'image_generation'), step('propose_for_review')],
  automationLevel: 'supervised_autonomous', budgetId: 'b1', scheduleId: 'sch-1', status: 'active', draftedBy: 'p-1', activatedBy: 'p-2',
};
test('pipelines: no publish step exists, content ends in review, rewrites are similarity-checked', () => {
  assert.ok(c.PipelineVersionSchema.safeParse(pipeline).success);
  assert.equal(c.PipelineStepKindSchema.safeParse('publish').success, false);
  assert.equal(c.PipelineVersionSchema.safeParse({ ...pipeline, steps: pipeline.steps.slice(0, -1) }).success, false);
  assert.equal(c.PipelineVersionSchema.safeParse({ ...pipeline, steps: pipeline.steps.filter((s) => s.kind !== 'similarity_check') }).success, false);
  assert.equal(c.PipelineVersionSchema.safeParse({ ...pipeline, budgetId: null }).success, false, 'active pipelines have a cap');
  assert.equal(c.PipelineStepSchema.safeParse(step('rewrite', 'translation')).success, false, 'job must fit the step');
  assert.equal(c.PipelineStepSchema.safeParse({ ...step('rewrite'), modelJob: 'editorial_rewrite' }).success, false, 'route and job together');
});

test('runs: dry runs commit nothing; state machine; people start manual runs', () => {
  const run: c.PipelineRun = { id: 'run-1', pipelineVersionId: 'pv1', hubId: 'hub-us', trigger: 'dry_run', dryRun: true, state: 'succeeded', attempt: 1, triggeredBy: { kind: 'person', personId: 'p-1' }, queuedAt: at, startedAt: at, finishedAt: later, counts: { fetched: 40, new: 12, duplicates: 28, skippedByLicence: 0, skippedByRobots: 0, proposed: 12, failed: 0 }, cost: { minorUnits: '0', currency: 'USD' }, effectsCommitted: false, errorCode: null };
  assert.ok(c.PipelineRunSchema.safeParse(run).success);
  assert.equal(c.PipelineRunSchema.safeParse({ ...run, effectsCommitted: true }).success, false);
  assert.equal(c.PipelineRunSchema.safeParse({ ...run, dryRun: false }).success, false);
  assert.equal(c.PipelineRunSchema.safeParse({ ...run, finishedAt: null }).success, false);
  assert.equal(c.PipelineRunSchema.safeParse({ ...run, trigger: 'manual', dryRun: false, triggeredBy: { kind: 'schedule', scheduleId: 'sch-1' } }).success, false);
  assert.ok(c.runTransitionAllowed('queued', 'running') && c.runTransitionAllowed('running', 'stopped_by_kill_switch'));
  assert.equal(c.runTransitionAllowed('failed', 'running'), false, 'a retry is a new run');
});

const item: c.EditorialItem = {
  id: 'ei-1', hubId: 'hub-us', pipelineRunId: 'run-1', sources: [{ sourceId: 'src-sam', url: 'https://sam.gov/opp/1', retrievedAt: at, contentDigest: sha }], originalLanguage: 'en', targetLanguages: ['es-US'],
  stage: 'in_review', treatment: 'rewrite', ai: { summarised: false, rewritten: true, translated: true, routeIds: ['r1'] }, similarity: { maxSourceOverlap: '0.18', threshold: '0.35', method: 'ngram_jaccard' },
  factChecks: [{ claim: 'Bid deadline is 15 December', status: 'supported', evidenceUrls: ['https://sam.gov/opp/1'] }],
  image: { kind: 'ai_generated', readerLabel: true, metadataLabel: 'trainedAlgorithmicMedia', depictsRealPerson: false, promptDigest: sha }, attribution: 'Based on SAM.gov notice',
  assignedEditorId: 'p-4', review: null, publicationId: null, scheduledFor: null, revision: 1,
};
test('editorial items: only a person approves; AI images labelled; blockers from similarity, facts and licence', () => {
  assert.ok(c.EditorialItemSchema.safeParse(item).success);
  assert.equal(c.EditorialItemSchema.safeParse({ ...item, stage: 'approved' }).success, false);
  assert.ok(c.EditorialItemSchema.safeParse({ ...item, stage: 'approved', review: { decision: 'approved', by: 'p-4', at, note: '' } }).success);
  assert.equal(c.EditorialItemSchema.safeParse({ ...item, image: { ...item.image, readerLabel: false } }).success, false);
  assert.equal(c.EditorialItemSchema.safeParse({ ...item, image: { ...item.image, depictsRealPerson: true } }).success, false);
  assert.equal(c.EditorialItemSchema.safeParse({ ...item, similarity: null }).success, false);
  assert.deepEqual(c.editorialApprovalBlockers(item, source.allowedUses), []);
  assert.deepEqual(c.editorialApprovalBlockers({ ...item, similarity: { ...item.similarity!, maxSourceOverlap: '0.5' } }, source.allowedUses), ['similarity_above_threshold']);
  assert.ok(c.editorialApprovalBlockers({ ...item, factChecks: [{ claim: 'x', status: 'contradicted', evidenceUrls: [] }] }, source.allowedUses).includes('contradicted_claim'));
  const headlineOnly = { ...source.allowedUses, rewriteWithAttribution: false, sendToModelProviders: false, translate: false };
  assert.deepEqual(c.editorialApprovalBlockers(item, headlineOnly), ['licence_forbids_rewrite', 'licence_forbids_translation', 'licence_forbids_model_use']);
});

test('agent modules: commitments only for verified companies and with two people; outreach quotas', () => {
  const m: c.AgentModuleVersion = { id: 'am1', hubId: 'hub-us', key: 'rfq_responder', version: 1, actions: ['prepare', 'send_quote', 'communicate'], eligibility: { principals: ['company_member', 'company_representative'], requireVerifiedCompany: false }, modelRoutes: [{ job: 'agent_drafting', routeId: 'r2' }], limits: { runsPerDay: 50, actionsPerDay: 20, maxConcurrentRuns: 2, tokensPerMonth: 2_000_000, outreachPerWeek: 20 }, metering: { unit: 'run', freeUnitsPerMonth: 30 }, status: 'active', draftedBy: 'p-1', activatedBy: 'p-1', approvalId: null };
  assert.ok(c.AgentModuleVersionSchema.safeParse(m).success);
  assert.equal(c.AgentModuleVersionSchema.safeParse({ ...m, limits: { ...m.limits, outreachPerWeek: null } }).success, false);
  const commit = { ...m, key: 'order_desk', actions: ['place_order' as const] };
  assert.equal(c.AgentModuleVersionSchema.safeParse(commit).success, false);
  assert.equal(c.AgentModuleVersionSchema.safeParse({ ...commit, eligibility: { ...m.eligibility, requireVerifiedCompany: true } }).success, false);
  assert.ok(c.AgentModuleVersionSchema.safeParse({ ...commit, eligibility: { ...m.eligibility, requireVerifiedCompany: true }, activatedBy: 'p-2', approvalId: 'ap-7' }).success);
});

test('metered prices: cost vs sale, margin, second-person activation, no back-dating or overlap; plans cannot buy ranking', () => {
  const p: c.MeteredPriceVersion = { id: 'mp1', hubId: 'hub-us', offerId: 'off-agent', moduleKey: 'rfq_responder', unit: 'run', version: 1, currency: 'USD', costPricePerUnitMinor: '3.25', costBasis: 'measured_average', salePricePerUnitMinor: '10', effectiveFrom: '2026-11-15T00:00:00Z', effectiveTo: null, acceptanceTextVersion: 'agent-terms-1', status: 'active', draftedBy: 'p-5', activatedBy: 'p-1', activatedAt: at };
  assert.ok(c.MeteredPriceVersionSchema.safeParse(p).success);
  assert.equal(c.unitMargin(p), '6.75');
  assert.equal(c.unitMargin({ costPricePerUnitMinor: '12.5', salePricePerUnitMinor: '10' }), '-2.5');
  assert.equal(c.unitMargin({ costPricePerUnitMinor: '0.1', salePricePerUnitMinor: '0.1' }), '0');
  assert.equal(c.MeteredPriceVersionSchema.safeParse({ ...p, activatedBy: 'p-5' }).success, false);
  assert.equal(c.MeteredPriceVersionSchema.safeParse({ ...p, effectiveFrom: at }).success, false);
  assert.equal(c.MeteredPriceVersionSchema.safeParse({ ...p, salePricePerUnitMinor: '-1' }).success, false);
  assert.ok(c.meteredVersionsOverlap(p, { ...p, id: 'mp2', version: 2 }));
  assert.equal(c.meteredVersionsOverlap(p, { ...p, id: 'mp2', unit: 'action' }), false);
  const plan: c.AgentPlanVersion = { id: 'pl1', hubId: 'hub-us', offerId: 'off-pro', version: 1, payer: 'company', includes: [{ moduleKey: 'rfq_responder', unitsPerMonth: 200 }], trialDays: 14, status: 'active', draftedBy: 'p-5', activatedBy: 'p-1' };
  assert.ok(c.AgentPlanVersionSchema.safeParse(plan).success);
  assert.equal(c.AgentPlanVersionSchema.safeParse({ ...plan, rankingBoost: 2 }).success, false, 'no field can touch ranking');
  assert.equal(c.AgentPlanVersionSchema.safeParse({ ...plan, activatedBy: 'p-5' }).success, false);
});

test('external agents act only for a person under mandates; statistics are cohorts', () => {
  const client: c.ExternalAgentClient = { id: 'ext-1', hubId: 'hub-us', actingFor: { personId: 'p-9', onBehalfOf: { kind: 'company', id: 'co-1' } }, protocol: 'mcp', label: 'Desktop agent', scopes: ['read_public', 'act_under_mandate'], credentialRef: secretRef, mandateRequired: true, rateLimit: { requestsPerMinute: 60, actionsPerDay: 100 }, status: 'active', createdAt: at, revokedAt: null };
  assert.ok(c.ExternalAgentClientSchema.safeParse(client).success);
  assert.equal(c.ExternalAgentClientSchema.safeParse({ ...client, mandateRequired: false }).success, false);
  assert.equal(c.ExternalAgentClientSchema.safeParse({ ...client, scopes: ['staff_read'] }).success, false);
  const stat = { hubId: 'hub-us', from: at, to: later, moduleKey: 'rfq_responder', activePrincipals: null, runs: 120, actionsSucceeded: 40, actionsEscalatedToHumans: 12, outcomeUnknown: 1, cost: { minorUnits: '3900', currency: 'USD' }, revenue: { minorUnits: '12000', currency: 'USD' } };
  assert.ok(c.AgentUsageStatSchema.safeParse(stat).success);
  assert.equal(c.AgentUsageStatSchema.safeParse({ ...stat, activePrincipals: 3 }).success, false, 'small cohorts are suppressed');
});

test('plan to people: acyclic expert-reviewed templates, marketplace rules, consented knowledge sharing', () => {
  const item = (key: string, dependsOn: string[] = [], kind: 'task' | 'consultation' | 'permit_check' = 'task') => ({ key, kind, title: { en: key, 'es-US': key }, categoryKey: null, licenceCategory: null, typicalDurationDays: 5, dependsOn });
  const t: c.PlanTemplateVersion = { id: 'tpl1', hubId: 'hub-us', key: 'single_family_house', version: 1, countryCode: 'US', projectType: 'house_new_build', title: { en: 'Single-family house', 'es-US': 'Casa unifamiliar' }, phases: [{ key: 'design', title: { en: 'Design' }, items: [item('architect_consult', [], 'consultation'), item('building_permit', ['architect_consult'], 'permit_check')] }, { key: 'build', title: { en: 'Build' }, items: [item('foundation', ['building_permit'])] }], references: [], authors: ['p-6'], reviewedBy: 'p-7', status: 'published' };
  assert.ok(c.PlanTemplateVersionSchema.safeParse(t).success);
  assert.equal(c.PlanTemplateVersionSchema.safeParse({ ...t, reviewedBy: 'p-6' }).success, false, 'author cannot review own template');
  const cyclic = { ...t, phases: [{ key: 'x', title: { en: 'x' }, items: [item('a', ['b']), item('b', ['a'])] }] };
  assert.equal(c.PlanTemplateVersionSchema.safeParse(cyclic).success, false);
  assert.equal(c.PlanTemplateVersionSchema.safeParse({ ...t, phases: [{ key: 'x', title: { en: 'x' }, items: [item('a', ['missing'])] }] }).success, false);
  const rule: c.MarketplaceCategoryRule = { id: 'mr1', hubId: 'hub-us', categoryKey: 'electrical', kind: 'task', whoMayOffer: 'verified_company_or_professional', verificationRecipeId: 'rec-tx-electrician', licenceCategory: 'TX-TDLR-electrical-contractor', pricing: 'quote_based', commissionOfferId: 'off-commission', refunds: { cancellationWindowHours: 48, disputeWindowDays: 30 }, agentAutomation: { mayDraftRequests: true, mayDraftOffers: true, mayAcceptWithinMandate: true, requestsPerWeek: 10 }, version: 1, status: 'active' };
  assert.ok(c.MarketplaceCategoryRuleSchema.safeParse(rule).success);
  assert.equal(c.MarketplaceCategoryRuleSchema.safeParse({ ...rule, verificationRecipeId: null }).success, false);
  assert.equal(c.MarketplaceCategoryRuleSchema.safeParse({ ...rule, licenceCategory: null, whoMayOffer: 'claimed_company_or_professional' }).success, false, 'agents accept only with verified counterparties');
  const share: c.KnowledgeShare = { id: 'ks1', hubId: 'hub-us', kind: 'project_diary', projectId: 'pr-1', ownerParty: { kind: 'person', id: 'p-9' }, namedParties: [{ kind: 'company', id: 'co-1' }], consents: [{ party: { kind: 'person', id: 'p-9' }, givenBy: 'p-9', at, scope: 'named', withdrawnAt: null }], privateFieldsExcluded: true, status: 'published', reviewedBy: 'p-4', publicationId: 'pub-1' };
  assert.equal(c.KnowledgeShareSchema.safeParse(share).success, false, 'named company has not consented');
  assert.ok(c.KnowledgeShareSchema.safeParse({ ...share, consents: [...share.consents, { party: { kind: 'company', id: 'co-1' }, givenBy: 'p-8', at, scope: 'anonymised', withdrawnAt: null }] }).success);
  assert.equal(c.KnowledgeShareSchema.safeParse({ ...share, privateFieldsExcluded: false }).success, false);
});

test('reputation building: checked credentials name recipes, revocation is recorded, agents never confirm', () => {
  const type: c.CredentialType = { id: 'ct1', hubId: 'hub-us', key: 'tx_electrical_contractor', version: 1, subject: 'company', claim: 'licence', title: { en: 'Texas electrical contractor licence', 'es-US': 'Licencia de contratista eléctrico de Texas' }, verificationRecipeId: 'rec-tx-electrician', validityDays: 365, recheckOnSourceChange: true, portable: true, status: 'active' };
  assert.ok(c.CredentialTypeSchema.safeParse(type).success);
  assert.equal(c.CredentialTypeSchema.safeParse({ ...type, verificationRecipeId: null }).success, false);
  assert.equal(c.CredentialTypeSchema.safeParse({ ...type, score: 5 }).success, false, 'a credential is never a score');
  const vc: c.IssuedCredential = { id: 'vc1', hubId: 'hub-us', credentialTypeId: 'ct1', holder: { kind: 'company', id: 'co-1' }, evidenceRefs: ['ev-1'], decidedBy: 'p-7', issuedAt: at, expiresAt: '2027-10-31T10:00:00Z', signingKeyId: 'did:web:us.example.org#key-1', credentialDigest: digest, statusListIndex: 17, status: 'valid', revocation: null };
  assert.ok(c.IssuedCredentialSchema.safeParse(vc).success);
  assert.equal(c.IssuedCredentialSchema.safeParse({ ...vc, status: 'revoked' }).success, false);
  assert.ok(c.IssuedCredentialSchema.safeParse({ ...vc, status: 'revoked', revocation: { reason: 'source_changed', decidedBy: 'p-7', at: later } }).success);
  assert.equal(c.IssuedCredentialSchema.safeParse({ ...vc, evidenceRefs: [] }).success, false);
  const policy = { hubId: 'hub-us', version: 1, requireTransactionOrProjectLink: true, maxOpenRequestsPerRequester: 20, maxRequestsPerCounterpartyPerMonth: 3, declineCooldownDays: 30, reciprocalConfirmationsFlagged: true, agentsMayRequest: true, agentsMayConfirm: false };
  assert.ok(c.ConfirmationPolicySchema.safeParse(policy).success);
  assert.equal(c.ConfirmationPolicySchema.safeParse({ ...policy, agentsMayConfirm: true }).success, false);
  assert.equal(c.ConfirmationPolicySchema.safeParse({ ...policy, requireTransactionOrProjectLink: false }).success, false);
});

test('setup wizard: ordered steps, first admin with a second factor, finish only when complete', () => {
  const s: c.SetupState = { nodeId: 'node-1', completed: ['install_check', 'node_identity'], current: 'hub_identity', setupTokenHash: sha, setupTokenExpiresAt: later, firstAdmin: null, startedAt: at, finishedAt: null };
  assert.ok(c.SetupStateSchema.safeParse(s).success);
  assert.equal(c.nextSetupStep(s), 'hub_identity');
  assert.equal(c.SetupStateSchema.safeParse({ ...s, completed: [...s.completed, 'first_admin'] }).success, false);
  assert.equal(c.SetupStateSchema.safeParse({ ...s, finishedAt: later }).success, false);
  assert.equal(c.nextSetupStep({ completed: [...c.SETUP_STEPS] }), null);
});

test('support: no impersonation fields, masked e-mail, sign-in changes need evidence, two people and 72 hours', () => {
  const summary: c.SupportAccountSummary = { personId: 'p-9', displayName: 'Synthetic Person', maskedEmail: 'sy***@example.org', emailVerified: true, accountState: 'active', secondFactor: { enrolled: true, methods: 1 }, activeSessions: 2, recovery: 'none', employer: null, entitlements: [], openCases: 1, consents: [] };
  assert.ok(c.SupportAccountSummarySchema.safeParse(summary).success);
  assert.equal(c.SupportAccountSummarySchema.safeParse({ ...summary, maskedEmail: 'synthetic@example.org' }).success, false);
  for (const leak of ['email', 'sessionTokens', 'ipAddresses', 'messages', 'budgets', 'impersonationToken']) assert.equal(c.SupportAccountSummarySchema.safeParse({ ...summary, [leak]: 'x' }).success, false, leak);
  const action: c.AccountServiceAction = { id: 'as1', hubId: 'hub-us', supportCaseId: 'case-1', subjectPersonId: 'p-9', action: 'reset_second_factor', requestedBy: 'p-10', approvedBy: 'p-11', evidenceRefs: ['ev-id'], requestedAt: at, effectiveAt: '2026-11-03T10:00:00Z', subjectNotified: true, state: 'cooling_off' };
  assert.ok(c.AccountServiceActionSchema.safeParse(action).success);
  assert.equal(c.AccountServiceActionSchema.safeParse({ ...action, effectiveAt: later }).success, false);
  assert.equal(c.AccountServiceActionSchema.safeParse({ ...action, approvedBy: 'p-10' }).success, false);
  assert.equal(c.AccountServiceActionSchema.safeParse({ ...action, evidenceRefs: [] }).success, false);
  assert.equal(c.AccountServiceActionSchema.safeParse({ ...action, requestedBy: 'p-9', approvedBy: 'p-11' }).success, false);
  assert.ok(c.AccountServiceActionSchema.safeParse({ ...action, action: 'revoke_all_sessions', approvedBy: null, evidenceRefs: [], effectiveAt: at }).success);
});

test('operations: backups are encrypted; a passed restore drill passed every check in isolation', () => {
  assert.equal(c.BackupRecordSchema.safeParse({ id: 'bk1', nodeId: 'node-1', kind: 'database_full', startedAt: at, finishedAt: later, sizeBytes: 1024, encrypted: false, offHost: true, manifestDigest: sha, state: 'completed' }).success, false);
  const drill: c.RestoreDrill = { id: 'dr1', nodeId: 'node-1', backupIds: ['bk1'], isolatedEnvironment: true, externalAdaptersDisabled: true, checks: { schemaChecksums: true, digestsVerified: true, tombstonesReplayed: true, objectsRestored: true, permissionsVerified: true }, measuredRecoveryMinutes: 42, dataLossWindowMinutes: 5, performedBy: 'p-1', witnessedBy: 'p-2', performedAt: at, outcome: 'passed' };
  assert.ok(c.RestoreDrillSchema.safeParse(drill).success);
  assert.equal(c.RestoreDrillSchema.safeParse({ ...drill, checks: { ...drill.checks, tombstonesReplayed: false } }).success, false);
  assert.equal(c.RestoreDrillSchema.safeParse({ ...drill, externalAdaptersDisabled: false }).success, false);
});

test('manufacturer knowledge: content mapping, explained recommendations without paid signals, sponsored content kept apart', () => {
  const mapping: c.ContentTypeMapping = { id: 'cm1', hubId: 'hub-us', sourceId: 'src-mfr', version: 1, rules: [{ pathPrefix: '/products/', schemaOrgType: 'Product', contentType: 'catalogue_item', categoryKey: 'insulation' }, { pathPrefix: '/academy/', schemaOrgType: 'Course', contentType: 'training', categoryKey: null }, { pathPrefix: '/events/', schemaOrgType: 'Event', contentType: 'event', categoryKey: null }], status: 'active' };
  assert.ok(c.ContentTypeMappingSchema.safeParse(mapping).success);
  assert.equal(c.ContentTypeMappingSchema.safeParse({ ...mapping, rules: [{ ...mapping.rules[0], pathPrefix: 'products' }] }).success, false);
  const rule: c.RecommendationRule = { id: 'rr1', hubId: 'hub-us', version: 1, planCategoryKey: 'foundation', planItemKinds: ['task', 'consultation'], recommends: [{ kind: 'material', maxItems: 5, includeSourced: true }, { kind: 'contractor', maxItems: 5, includeSourced: false }, { kind: 'training', maxItems: 3, includeSourced: true }], signals: ['plan_step_match', 'region_served', 'licence_valid', 'reputation_with_samples'], explanationShown: true, status: 'active', draftedBy: 'p-4', activatedBy: 'p-4' };
  assert.ok(c.RecommendationRuleSchema.safeParse(rule).success);
  assert.equal(c.RecommendationRuleSchema.safeParse({ ...rule, signals: ['plan_step_match', 'sponsorship'] }).success, false, 'no paid signal exists');
  assert.equal(c.RecommendationRuleSchema.safeParse({ ...rule, signals: ['plan_step_match'] }).success, false, 'contractors only where they serve');
  assert.equal(c.RecommendationRuleSchema.safeParse({ ...rule, explanationShown: false }).success, false);
  const sponsored: c.SponsoredContentPolicy = { hubId: 'hub-us', version: 1, allowed: true, readerLabel: true, separateSlotOnly: true, affectsRankingOrMatching: false, requireVerifiedSponsor: true, maxSlotsPerPage: 1, neverIn: ['search_results', 'matching_results', 'plan_recommendations', 'reputation', 'directory_order', 'magazine_editorial'] };
  assert.ok(c.SponsoredContentPolicySchema.safeParse(sponsored).success);
  assert.equal(c.SponsoredContentPolicySchema.safeParse({ ...sponsored, affectsRankingOrMatching: true }).success, false);
  assert.equal(c.SponsoredContentPolicySchema.safeParse({ ...sponsored, neverIn: ['search_results'] }).success, false);
  assert.equal(c.SponsoredContentPolicySchema.safeParse({ ...sponsored, allowed: false }).success, false);
});

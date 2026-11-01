import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_CONSOLE_CONTRACT_VERSION, type ProviderHosting } from '../../packages/contracts/src/hub.js';
import {
  capAllows, connectionInResidency, connectionRestricted, CreateConnectionCommandSchema, DraftRouteCommandSchema, egressRuleNeedsSecondPerson, endpointProblem,
  estimateCallCostMinor, isMovingAlias, isPinned, PROVIDER_REASON_CODES, providerEgressDecision, ProviderSecretSubmitCommandSchema, resolveRoute, routeNeedsSecondPerson,
  ScopedModelRouteSchema, SetEgressRuleCommandSchema, syntheticProbesFor, type EgressConnection, type RouteScope,
} from '../../packages/contracts/src/providers.js';

const base = { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: 'synthetic-key-0001', reason: 'Synthetic contract test' };
const VENDOR_US: ProviderHosting = { kind: 'vendor', country: 'US', zeroRetention: true, trainsOnInputs: false, broker: false };
const SELF_US: ProviderHosting = { kind: 'self_hosted', country: 'US' };
const HUB = 'hub-1';

test('connections: restricted places, residency and endpoints', () => {
  const isRestricted = (c: string) => ['RU', 'IR', 'KP', 'CU'].includes(c.slice(0, 2));
  assert.equal(connectionRestricted({ hosting: VENDOR_US, storageCountry: null }, isRestricted), false);
  assert.equal(connectionRestricted({ hosting: { ...VENDOR_US, country: 'RU' }, storageCountry: null }, isRestricted), true, 'processing in a restricted place');
  assert.equal(connectionRestricted({ hosting: VENDOR_US, storageCountry: 'IR' }, isRestricted), true, 'storage in a restricted place');
  assert.equal(connectionInResidency({ hosting: VENDOR_US, storageCountry: 'US' }, ['US']), true);
  assert.equal(connectionInResidency({ hosting: VENDOR_US, storageCountry: 'DE' }, ['US']), false, 'storage outside residency');
  assert.equal(connectionInResidency({ hosting: VENDOR_US, storageCountry: null }, []), false, 'no residency configured fails closed');

  assert.equal(endpointProblem('https://api.vendor.example/v1', 'vendor'), null);
  assert.equal(endpointProblem('http://api.vendor.example/v1', 'vendor'), 'plain_http_vendor');
  assert.equal(endpointProblem('https://10.0.0.5/v1', 'vendor'), 'private_address_vendor');
  assert.equal(endpointProblem('https://localhost:8443/v1', 'vendor'), 'private_address_vendor');
  assert.equal(endpointProblem('http://127.0.0.1:11434/v1', 'self_hosted'), null, 'self-hosted servers may be local');
  assert.equal(endpointProblem('https://user:pass@api.vendor.example', 'vendor'), 'credentials_in_url');
  assert.equal(endpointProblem('https://api.vendor.example/v1?key=sk-synthetic0000000000000000000000', 'vendor'), 'secret_in_url');

  const create = { ...base, adapterId: 'openai_compatible', mode: 'live', label: 'Synthetic US model server', capabilities: ['llm'], endpoint: 'https://models.example/v1', hosting: VENDOR_US, storageCountry: null, region: 'us-east-1', credentialRefId: null };
  assert.ok(CreateConnectionCommandSchema.safeParse(create).success);
  assert.ok(!CreateConnectionCommandSchema.safeParse({ ...create, label: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345' }).success, 'a key-shaped label is refused');
  assert.ok(!CreateConnectionCommandSchema.safeParse({ ...create, mode: 'fake', credentialRefId: 'cred-1' }).success, 'fake adapters hold no secret');
  assert.ok(!CreateConnectionCommandSchema.safeParse({ ...create, capabilities: ['llm', 'llm'] }).success);
  assert.ok(!CreateConnectionCommandSchema.safeParse({ ...create, secret: 'x' }).success, 'strict: no secret field on a connection');
});

test('secrets: one write-only command carries a value; it is one line', () => {
  const ok = { ...base, connectionId: 'conn-1', value: 'synthetic-secret-value-0001', expectedRevision: 1, graceHours: 24 };
  assert.ok(ProviderSecretSubmitCommandSchema.safeParse(ok).success);
  assert.ok(!ProviderSecretSubmitCommandSchema.safeParse({ ...ok, value: 'short' }).success);
  assert.ok(!ProviderSecretSubmitCommandSchema.safeParse({ ...ok, value: 'two\nlines-of-secret' }).success);
  assert.ok(!ProviderSecretSubmitCommandSchema.safeParse({ ...ok, graceHours: 1000 }).success);
});

test('synthetic probes: fixed engine text only', () => {
  const probes = syntheticProbesFor(['llm', 'email']);
  assert.equal(probes[0]!.kind, 'auth_check');
  assert.ok(probes.every((p) => p.text === null || p.text.includes('Trustwork') || p.text === 'Trustwork'));
  assert.deepEqual(syntheticProbesFor(['llm']), syntheticProbesFor(['llm']), 'deterministic');
});

test('routes: pinned revisions, scopes and most specific resolution', () => {
  assert.equal(isMovingAlias('latest'), true);
  assert.equal(isMovingAlias('gpt-x-latest'), true);
  assert.equal(isMovingAlias('model@stable'), true);
  assert.equal(isMovingAlias('2026-09-01'), false);
  assert.equal(isPinned({ connectionId: 'c', modelId: 'm', modelRevision: null }), false);
  assert.equal(isPinned({ connectionId: 'c', modelId: 'm', modelRevision: 'rev-7' }), true);

  const draft = {
    ...base, job: 'agent_drafting', scope: { kind: 'module', moduleKey: 'negotiator' }, primary: { connectionId: 'c1', modelId: 'm1', modelRevision: 'r1' },
    fallbacks: [{ connectionId: 'c2', modelId: 'm2', modelRevision: null }], allowedDataClasses: ['public', 'deal_party_private'],
    limits: { maxInputTokens: 8000, maxOutputTokens: 1000, maxFileBytes: null, timeoutMs: 30_000 }, budgetId: null,
  };
  assert.ok(DraftRouteCommandSchema.safeParse(draft).success, 'a draft may leave a fallback revision open');
  assert.ok(!DraftRouteCommandSchema.safeParse({ ...draft, primary: { ...draft.primary, modelRevision: 'latest' } }).success, 'never a moving alias');
  assert.ok(!DraftRouteCommandSchema.safeParse({ ...draft, job: 'embeddings' }).success, 'embeddings have no fallbacks');
  assert.ok(!DraftRouteCommandSchema.safeParse({ ...draft, job: 'image_generation', fallbacks: [] }).success, 'images carry public data only');
  assert.equal(routeNeedsSecondPerson(draft as never), true);
  assert.equal(routeNeedsSecondPerson({ allowedDataClasses: ['public'] }), false);

  const view = {
    id: 'r1', hubId: HUB, version: 1, job: 'agent_drafting', scope: draft.scope, primary: draft.primary, fallbacks: [{ connectionId: 'c2', modelId: 'm2', modelRevision: 'r2' }],
    allowedDataClasses: draft.allowedDataClasses, limits: draft.limits, budgetId: null, status: 'active', reason: 'Synthetic', draftedBy: 'p1', draftedAt: '2026-11-03T00:00:00Z',
    activatedBy: 'p2', activatedAt: '2026-11-03T00:00:00Z', approvalId: 'a1', killSwitchId: null, revision: 2,
  };
  assert.ok(ScopedModelRouteSchema.safeParse(view).success);
  assert.ok(!ScopedModelRouteSchema.safeParse({ ...view, activatedBy: 'p1' }).success, 'the drafter alone never activates a non-public route');
  assert.ok(!ScopedModelRouteSchema.safeParse({ ...view, approvalId: null }).success, 'non-public routes need an approval');
  assert.ok(!ScopedModelRouteSchema.safeParse({ ...view, fallbacks: [{ connectionId: 'c2', modelId: 'm2', modelRevision: null }] }).success, 'active routes are pinned');

  const route = (id: string, scope: RouteScope, status = 'active') => ({ id, hubId: HUB, job: 'agent_drafting' as const, scope, status });
  const routes = [route('job', { kind: 'job' }), route('mod', { kind: 'module', moduleKey: 'negotiator' }), route('ext', { kind: 'extension', extensionId: 'ext-1' }), route('draft-ext', { kind: 'extension', extensionId: 'ext-2' }, 'draft')];
  const call = (moduleKey: string | null, extensionId: string | null, job = 'agent_drafting' as const) => resolveRoute(routes, { hubId: HUB, job, moduleKey, extensionId });
  assert.equal(call('negotiator', 'ext-1').route?.id, 'ext', 'extension first');
  assert.equal(call('negotiator', 'ext-9').route?.id, 'mod', 'then module');
  assert.equal(call('research', null).route?.id, 'job', 'then job');
  assert.equal(call('research', 'ext-2').route?.id, 'job', 'a draft never serves');
  assert.deepEqual(resolveRoute(routes, { hubId: HUB, job: 'translation', moduleKey: null, extensionId: null }), { route: null, reason: 'no_active_route' });
  assert.deepEqual(resolveRoute(routes, { hubId: 'other-hub', job: 'agent_drafting', moduleKey: null, extensionId: null }), { route: null, reason: 'no_active_route' }, 'another hub\'s route never serves');
});

test('egress: default deny, training, brokers, residency, retention, kills', () => {
  const conn = (over: Partial<EgressConnection> = {}): EgressConnection => ({ id: 'c1', status: 'enabled', hosting: VENDOR_US, storageCountry: null, killed: false, restricted: false, ...over });
  const allow = (dataClass: 'public' | 'person_private', version = 1) => ({ connectionId: 'c1', dataClass, decision: 'allow' as const, requireInResidency: dataClass !== 'public', requireZeroRetention: dataClass !== 'public', version });
  const d = (rules: Parameters<typeof providerEgressDecision>[0], c: EgressConnection, dataClass: 'public' | 'person_private' = 'person_private', residency = ['US']) =>
    providerEgressDecision(rules, { connection: c, dataClass, residencyCountries: residency }).reason;
  assert.equal(d([], conn()), 'no_rule', 'default deny');
  assert.equal(d([allow('public')], conn()), 'no_rule', 'a public allow says nothing about private data');
  assert.equal(d([allow('person_private'), { ...allow('person_private', 2), decision: 'deny' }], conn()), 'denied', 'the latest version wins');
  assert.equal(d([allow('person_private')], conn()), 'allowed');
  assert.equal(d([allow('person_private')], conn({ killed: true })), 'killed');
  assert.equal(d([allow('person_private')], conn({ status: 'disabled' })), 'connection_not_enabled');
  assert.equal(d([allow('person_private')], conn({ restricted: true })), 'restricted_place');
  assert.equal(d([allow('person_private')], conn({ hosting: { ...VENDOR_US, trainsOnInputs: true } })), 'training');
  assert.equal(d([allow('person_private')], conn({ hosting: { ...VENDOR_US, broker: true } })), 'broker');
  assert.equal(d([allow('public')], conn({ hosting: { ...VENDOR_US, broker: true } }), 'public'), 'allowed', 'brokers carry public data');
  assert.equal(d([allow('person_private')], conn(), 'person_private', ['UZ']), 'residency');
  assert.equal(d([allow('person_private')], conn({ storageCountry: 'DE' })), 'residency', 'storage counts');
  assert.equal(d([allow('person_private')], conn({ hosting: { ...VENDOR_US, zeroRetention: false } })), 'retention');
  assert.equal(d([allow('person_private')], conn({ hosting: SELF_US })), 'allowed', 'self-hosted in residency');

  const cell = { ...base, connectionId: 'c1', dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: null };
  assert.ok(SetEgressRuleCommandSchema.safeParse(cell).success);
  assert.ok(!SetEgressRuleCommandSchema.safeParse({ ...cell, requireZeroRetention: false }).success, 'non-public allow requires zero retention');
  assert.equal(egressRuleNeedsSecondPerson({ decision: 'allow', dataClass: 'person_private' }), true);
  assert.equal(egressRuleNeedsSecondPerson({ decision: 'deny', dataClass: 'person_private' }), false, 'narrowing needs one person');
  assert.equal(egressRuleNeedsSecondPerson({ decision: 'allow', dataClass: 'public' }), false);
});

test('caps: a hard stop without overspend', () => {
  const cap = { limit: { minorUnits: '1000', currency: 'USD' } };
  assert.equal(capAllows(cap, { spentMinorUnits: '0', reservedMinorUnits: '0', estimateMinorUnits: '1000' }), true);
  assert.equal(capAllows(cap, { spentMinorUnits: '600', reservedMinorUnits: '300', estimateMinorUnits: '101' }), false, 'the estimate must fit');
  assert.equal(capAllows(cap, { spentMinorUnits: '1000', reservedMinorUnits: '0', estimateMinorUnits: '0' }), false, 'exhausted blocks even a zero estimate');
  assert.equal(capAllows({ limit: { minorUnits: '0', currency: 'USD' } }, { spentMinorUnits: '0', reservedMinorUnits: '0', estimateMinorUnits: '0' }), false, 'a zero cap blocks paid calls');
});

test('cost estimates: exact and rounded up', () => {
  const pricing = { inputPerMillionTokens: '3.00', outputPerMillionTokens: '15.00', perImage: null, perAudioMinute: null };
  assert.equal(estimateCallCostMinor(pricing, { inputTokens: 1_000_000, outputTokens: 0, images: 0, audioMinutes: 0 }, 2), '300');
  assert.equal(estimateCallCostMinor(pricing, { inputTokens: 1, outputTokens: 0, images: 0, audioMinutes: 0 }, 2), '1', 'a fraction of a cent reserves a whole cent');
  assert.equal(estimateCallCostMinor(pricing, { inputTokens: 8000, outputTokens: 1000, images: 0, audioMinutes: 0 }, 2), '4', '2.4 + 1.5 cents rounds up to 4');
  assert.equal(estimateCallCostMinor({ inputPerMillionTokens: null, outputPerMillionTokens: null, perImage: '0.040000', perAudioMinute: null }, { inputTokens: 0, outputTokens: 0, images: 3, audioMinutes: 0 }, 2), '12');
  assert.equal(estimateCallCostMinor(pricing, { inputTokens: 0, outputTokens: 0, images: 0, audioMinutes: 0 }, 2), '0');
});

test('every reason code is unique and machine-shaped', () => {
  assert.equal(new Set(PROVIDER_REASON_CODES).size, PROVIDER_REASON_CODES.length);
  for (const code of PROVIDER_REASON_CODES) assert.match(code, /^[a-z][a-z_]*$/);
});

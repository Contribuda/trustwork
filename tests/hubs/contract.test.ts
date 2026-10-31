import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_SECOND_PERSON_ACTIONS, ADMIN_PERMISSIONS, CONSOLE_PERMISSIONS, CONSOLE_SECOND_PERSON_ACTIONS, FORBIDDEN_CONTROL_WORDS, HUB_CONFIG_DOMAINS, HUB_CONSOLE_CONTRACT_VERSION,
  HubConfigVersionSchema, SENSITIVE_CONFIG_DOMAINS, consoleActionNeedsSecondPerson,
} from '@trustwork/contracts';
import { DeploymentConfigSchema, resolveDeployment } from '../../packages/config/src/index.js';
import {
  CONFIG_DOMAIN_GATES, CONFIG_DOMAIN_PERMISSIONS, CONFIG_DOMAIN_SECOND_PERSON_ACTIONS, CreateHubCommandSchema, DeploymentDocumentSchema, IdentityConfigPayloadSchema,
  CountryConfigPayloadSchema, ImportDeploymentCommandSchema, JurisdictionConfigPayloadSchema, LIFECYCLE_SECOND_PERSON_ACTIONS, PrivacyConfigPayloadSchema, RegisterCredentialCommandSchema,
  ResidencyConfigPayloadSchema, TransitionHubCommandSchema, configPayloadProblems, forbiddenConfigKeys, joinDeploymentConfig, splitDeploymentConfig,
} from '../../packages/contracts/src/hub-core.js';

const cmd = { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: 'hub-contract-test-0001', reason: 'Synthetic contract test' };

test('vocabulary: every domain has a drafting permission from the console vocabulary; exactly the sensitive domains name a second-person action', () => {
  assert.deepEqual(Object.keys(CONFIG_DOMAIN_PERMISSIONS).sort(), [...HUB_CONFIG_DOMAINS].sort());
  for (const permission of Object.values(CONFIG_DOMAIN_PERMISSIONS)) assert.ok((CONSOLE_PERMISSIONS as readonly string[]).includes(permission), permission);
  assert.ok((ADMIN_PERMISSIONS as readonly string[]).includes('admin.config.edit'));
  assert.deepEqual(Object.keys(CONFIG_DOMAIN_SECOND_PERSON_ACTIONS).sort(), [...SENSITIVE_CONFIG_DOMAINS].sort());
  for (const action of [...Object.values(CONFIG_DOMAIN_SECOND_PERSON_ACTIONS), ...Object.values(LIFECYCLE_SECOND_PERSON_ACTIONS)]) {
    assert.ok((CONSOLE_SECOND_PERSON_ACTIONS as readonly string[]).includes(action!), action);
    assert.ok(consoleActionNeedsSecondPerson(action!), action);
  }
  assert.equal(ACTIVATION_SECOND_PERSON_ACTIONS.hub_config_version, undefined, 'the frozen contract leaves configuration to the owning use case, which decides by domain');
  for (const domain of Object.keys(CONFIG_DOMAIN_GATES)) assert.ok((HUB_CONFIG_DOMAINS as readonly string[]).includes(domain), domain);
});

test('the frozen HubConfigVersion contract agrees: sensitive versions are activated by another person under an approval', () => {
  const at = '2026-10-31T12:00:00.000Z';
  const base = { id: 'v-1', hubId: 'h-1', domain: 'residency', version: 1, payloadDigest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) }, status: 'active', reason: 'Synthetic', draftedBy: 'p-1', activatedAt: at, effectiveFrom: at };
  assert.equal(HubConfigVersionSchema.safeParse({ ...base, activatedBy: 'p-1', approvalId: 'ap-1' }).success, false, 'the drafter never activates');
  assert.equal(HubConfigVersionSchema.safeParse({ ...base, activatedBy: 'p-2', approvalId: null }).success, false, 'never without an approval');
  assert.equal(HubConfigVersionSchema.safeParse({ ...base, activatedBy: 'p-2', approvalId: 'ap-1' }).success, true);
  assert.equal(HubConfigVersionSchema.safeParse({ ...base, domain: 'identity', activatedBy: 'p-1', approvalId: null }).success, true, 'non-sensitive domains need one person');
});

test('no hub setting widens data access: forbidden keys at any depth, in every domain', () => {
  assert.deepEqual(forbiddenConfigKeys({ a: { b: [{ grantRole: 'x' }] }, visibility: 1, ok: true, rerankModel: 'm' }), ['grantRole', 'visibility']);
  for (const key of ['staffReadPrivate', 'caseAccessHours', 'bypassRls', 'shareWith', 'rankBoost', 'score', 'badge', 'audience', 'permissions', 'impersonate', 'rowLevel', 'accessOverride']) {
    assert.equal(forbiddenConfigKeys({ nested: { [key]: true } }).length, 1, key);
    for (const domain of HUB_CONFIG_DOMAINS) assert.ok(configPayloadProblems(domain, { [key]: true }).some((p) => p.includes(key)), `${domain}: ${key}`);
  }
  assert.equal(FORBIDDEN_CONTROL_WORDS.test('rerank'), false);
});

test('payload schemas: residency, privacy, jurisdiction', () => {
  assert.equal(ResidencyConfigPayloadSchema.safeParse({ hostingCountry: 'US', hostingRegion: 'US-CA', personalDataCountries: ['US'] }).success, true);
  assert.equal(ResidencyConfigPayloadSchema.safeParse({ hostingCountry: 'US', hostingRegion: 'CA-ON', personalDataCountries: ['US'] }).success, false, 'the region lies in the country');
  assert.equal(ResidencyConfigPayloadSchema.safeParse({ hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['CA'] }).success, false, 'data stays where the hosting is');
  assert.equal(PrivacyConfigPayloadSchema.safeParse({ retention: [{ class: 'accounting', minPeriod: 'P7Y', maxPeriod: null, packFactRef: null, disclosureTextKey: null }] }).success, true);
  assert.equal(PrivacyConfigPayloadSchema.safeParse({ retention: [{ class: 'accounting', minPeriod: 'P7Y', maxPeriod: 'P1Y', packFactRef: null, disclosureTextKey: null }] }).success, false);
  assert.equal(PrivacyConfigPayloadSchema.safeParse({ retention: [{ class: 'forever', minPeriod: null, maxPeriod: null, packFactRef: null, disclosureTextKey: null }] }).success, false);
  assert.equal(JurisdictionConfigPayloadSchema.safeParse({ addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: 'Synthetic order 1', url: null } }], agentDisclosure: { en: 'x' } }).success, true, 'HUB-005 settings pass through');
  assert.equal(JurisdictionConfigPayloadSchema.safeParse({ addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: '', url: null } }] }).success, false, 'a cited legal basis');
  assert.equal(JurisdictionConfigPayloadSchema.safeParse({ addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: 'One', url: null } }, { code: 'VE', legalBasis: { citation: 'Two', url: null } }] }).success, false);
});

test('CFG-001: a deployment document splits into identity and country version 1 and joins back into a file the CFG-001 loader accepts', () => {
  const documents = [
    { schemaVersion: 1 },
    { schemaVersion: 1, countries: { default: 'US', offered: 'all', featured: ['US'] }, languages: { default: 'en', enabled: ['en', 'es'], byCountry: { US: 'en', MX: 'es' } }, brand: { overlay: null }, site: { url: 'https://build.example.org' } },
    { schemaVersion: 1, countries: { default: null, offered: ['GE', 'AM'] }, languages: { enabled: 'all' }, brand: { overlay: 'stroy' }, revision: { number: 3, note: 'Synthetic' }, dataDir: './data' },
  ] as const;
  for (const doc of documents) {
    assert.equal(DeploymentConfigSchema.safeParse(doc).success, true, 'a valid CFG-001 file');
    const parsed = DeploymentDocumentSchema.parse(doc);
    const { identity, country } = splitDeploymentConfig(parsed);
    assert.equal(IdentityConfigPayloadSchema.safeParse(identity).success, true);
    assert.equal(CountryConfigPayloadSchema.safeParse(country).success, true);
    const joined = joinDeploymentConfig(identity, country);
    assert.equal(DeploymentConfigSchema.safeParse(joined).success, true, 'the CFG-001 schema reads the active versions');
    const { revision: _r, dataDir: _d, ...versioned } = parsed as Record<string, unknown>;
    void _r; void _d;
    assert.deepEqual(joined, versioned, 'nothing is lost but the installation path and the revision counter');
    const resolved = resolveDeployment({ file: joined, fileName: 'hub configuration' });
    assert.deepEqual(resolved.problems, []);
  }
  // Both grammars refuse the same malformed values.
  for (const bad of [{ schemaVersion: 2 }, { schemaVersion: 1, countries: { default: 'us' } }, { schemaVersion: 1, languages: { default: 'EN' } }, { schemaVersion: 1, brand: { overlay: 'Bad Brand' } }, { schemaVersion: 1, extra: true }]) {
    assert.equal(DeploymentConfigSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(DeploymentDocumentSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(ImportDeploymentCommandSchema.safeParse({ ...cmd, deployment: documents[1] }).success, true);
});

test('commands: strict console commands; a hub needs a territory and its name in every language; credentials carry references only', () => {
  const hub = { ...cmd, slug: 'synthetic-us', name: { en: 'Synthetic', es: 'Sintético' }, defaultLocale: 'en', locales: ['en', 'es'], timeZone: 'America/Los_Angeles', currency: 'USD', countryPack: null, territories: [{ level: 'place', code: 'US-CA:san-diego' }] };
  assert.equal(CreateHubCommandSchema.safeParse(hub).success, true);
  assert.equal(CreateHubCommandSchema.safeParse({ ...hub, territories: [] }).success, false);
  assert.equal(CreateHubCommandSchema.safeParse({ ...hub, name: { en: 'Synthetic' } }).success, false, 'a name in every hub language');
  assert.equal(CreateHubCommandSchema.safeParse({ ...hub, defaultLocale: 'ru' }).success, false);
  assert.equal(CreateHubCommandSchema.safeParse({ ...hub, rank: 1 }).success, false, 'strict');
  assert.equal(TransitionHubCommandSchema.safeParse({ ...cmd, to: 'public', expectedRevision: 3, approvalId: null }).success, true);
  const credential = { ...cmd, provider: 'payments', adapter: 'stripe', mode: 'live', secret: { store: 'env', ref: 'PAYMENTS_KEY' } };
  assert.equal(RegisterCredentialCommandSchema.safeParse(credential).success, true);
  assert.equal(RegisterCredentialCommandSchema.safeParse({ ...credential, secret: { store: 'env', ref: 'sk_live_abcdefghijklmnop' } }).success, false, 'never a secret value');
});

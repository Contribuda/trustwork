import test from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { CONSOLE_PERMISSIONS, FORBIDDEN_CONTROL_WORDS, modesViolations, nextSetupStep, restrictedPlaces, ScopedStaffRoleDefinitionSchema, SETUP_STEPS } from '@trustwork/contracts';
import { configPayloadProblems, splitDeploymentConfig } from '../../../packages/contracts/src/hub-core.js';
import {
  canSaveStep, FOUNDING_NODE_OPERATOR_PERMISSIONS, HubIdentityAnswerSchema, maskEmail, ModesAnswerSchema, OperatorAnswerSchema, ProvidersAnswerSchema, SETUP_ANSWER_SCHEMAS,
  SETUP_DIRECT_MODEL_ADAPTERS, setupDeploymentDocument, setupHubSlug, setupLegalPayload, setupModes, setupModesProblems, setupPlaceRefusals, setupProvidersPayload,
  setupResidencyPayload, SetupTokenSchema, type HubIdentityAnswer, type NodeIdentityAnswer, type OperatorAnswer, type ProvidersAnswer, type StorageResidencyAnswer,
} from '../../../packages/contracts/src/hub-setup.js';
import { newSetupToken, setupTokenHash } from '../../../apps/api/src/modules/hubs/setup/token.js';
import { ANSWERS } from './helpers.js';

const RESTRICTED = restrictedPlaces(['RU', 'IR', 'KP', 'CU', 'UA-43', 'UA-40', 'UA-14', 'UA-09']);
const node = ANSWERS.node_identity as NodeIdentityAnswer;
const hub = HubIdentityAnswerSchema.parse(ANSWERS.hub_identity) as HubIdentityAnswer;
const operator = OperatorAnswerSchema.parse(ANSWERS.operator) as OperatorAnswer;
const residency = ANSWERS.storage_residency as StorageResidencyAnswer;
const providers = ProvidersAnswerSchema.parse(ANSWERS.providers) as ProvidersAnswer;

test('the setup token: 32 random bytes in base64url, stored only as a SHA-256', () => {
  const token = newSetupToken();
  assert.ok(SetupTokenSchema.safeParse(token).success);
  assert.notEqual(newSetupToken(), token);
  assert.match(setupTokenHash(token), /^[a-f0-9]{64}$/);
  assert.equal(setupTokenHash(token), setupTokenHash(token));
  for (const bad of ['', 'short', `${token}x`, token.replace(/./, '+')]) assert.ok(!SetupTokenSchema.safeParse(bad).success, bad);
});

test('steps are saved in order: nothing ahead of the first incomplete step', () => {
  assert.equal(nextSetupStep({ completed: [] }), 'install_check');
  assert.ok(canSaveStep({ completed: [] }, 'install_check'));
  assert.ok(!canSaveStep({ completed: [] }, 'hub_identity'));
  assert.ok(canSaveStep({ completed: ['install_check', 'node_identity'] }, 'hub_identity'));
  assert.ok(!canSaveStep({ completed: ['install_check', 'hub_identity'] }, 'operator'), 'a gap blocks later steps');
  assert.deepEqual(Object.keys(SETUP_ANSWER_SCHEMAS), SETUP_STEPS.filter((s) => s !== 'first_admin' && s !== 'review'), 'every other step has its own route');
});

test('a country is required and every territory lies in it; hub languages are engine languages with a name in each', () => {
  const refused = (patch: Record<string, unknown>) => assert.ok(!HubIdentityAnswerSchema.safeParse({ ...ANSWERS.hub_identity, ...patch }).success, JSON.stringify(patch));
  refused({ country: undefined });
  refused({ territories: [] });
  refused({ territories: [{ level: 'country', code: 'MX' }] });
  refused({ locales: ['en', 'fr'], name: { en: 'x', fr: 'y' } });
  refused({ name: { en: 'Only English' } });
  refused({ defaultLocale: 'es-MX' });
  assert.ok(HubIdentityAnswerSchema.safeParse({ ...ANSWERS.hub_identity, locales: ['en', 'es-US'], name: { en: 'x', 'es-US': 'y' } }).success, 'a regional variant of an engine language');
  assert.equal(setupHubSlug({ ...hub, slug: undefined }), 'us-ca-san-diego');
  assert.equal(setupHubSlug(hub), 'synthetic-us');
});

test('restricted places are refused at country, region and place level in every step', () => {
  assert.deepEqual(setupPlaceRefusals('node_identity', { ...node, jurisdiction: 'RU' }, RESTRICTED), ['jurisdiction:RU']);
  assert.deepEqual(setupPlaceRefusals('node_identity', node, RESTRICTED), []);
  assert.deepEqual(setupPlaceRefusals('hub_identity', { ...hub, country: 'UA', territories: [{ level: 'place', code: 'UA-43:simferopol' }, { level: 'region', code: 'UA-46' }] }, RESTRICTED), ['territories:UA-43:simferopol']);
  assert.deepEqual(setupPlaceRefusals('hub_identity', { ...hub, country: 'IR', territories: [{ level: 'country', code: 'IR' }] }, RESTRICTED), ['country:IR', 'territories:IR']);
  assert.deepEqual(setupPlaceRefusals('hub_identity', hub, RESTRICTED), []);
  assert.deepEqual(setupPlaceRefusals('operator', { ...operator, hostingCountry: 'UA', hostingRegion: null }, RESTRICTED), ['hostingRegion:region_required']);
  assert.deepEqual(setupPlaceRefusals('operator', { ...operator, entityCountry: 'KP', entityRegion: null, hostingCountry: 'UA', hostingRegion: 'UA-40' }, RESTRICTED), ['entityCountry:KP', 'hostingRegion:UA-40']);
  assert.deepEqual(setupPlaceRefusals('operator', operator, RESTRICTED), []);
  assert.deepEqual(setupPlaceRefusals('storage_residency', { ...residency, personalDataCountry: 'CU' }, RESTRICTED), ['personalDataCountry:CU']);
});

test('providers: every capability fake or manual; OpenRouter is one optional router next to the direct providers', () => {
  assert.ok(!SETUP_DIRECT_MODEL_ADAPTERS.includes('openrouter' as never) && !SETUP_DIRECT_MODEL_ADAPTERS.includes('fake' as never));
  assert.deepEqual([...SETUP_DIRECT_MODEL_ADAPTERS].sort(), ['anthropic', 'google', 'mistral', 'openai', 'openai_compatible']);
  assert.ok(!ProvidersAnswerSchema.safeParse({ ...ANSWERS.providers, capabilities: { ...ANSWERS.providers.capabilities, llm: 'manual' } }).success, 'a person is not a language model');
  assert.ok(!ProvidersAnswerSchema.safeParse({ ...ANSWERS.providers, models: 'direct', directModelAdapter: null }).success);
  assert.ok(!ProvidersAnswerSchema.safeParse({ ...ANSWERS.providers, models: 'openrouter', directModelAdapter: 'openai' }).success);
  assert.ok(ProvidersAnswerSchema.safeParse({ ...ANSWERS.providers, models: 'direct', directModelAdapter: 'openai_compatible' }).success);
  const payload = setupProvidersPayload(providers) as { capabilities: Record<string, { mode: string; connectLater: boolean }> };
  assert.ok(Object.values(payload.capabilities).every((c) => c.mode === 'fake' || c.mode === 'manual'), 'nothing live');
  assert.equal(payload.capabilities.llm?.connectLater, true);
  assert.equal(payload.capabilities.register_lookup?.mode, 'manual');
});

test('modes: registration closed, indexing off, every automation domain manual; module dependencies enforced', () => {
  const modes = setupModes(ModesAnswerSchema.parse({ dataMode: 'demo' }));
  assert.equal(modes.registration, 'closed');
  assert.equal(modes.searchEngineIndexing, false);
  assert.ok(Object.values(modes.automation).every((a) => a === 'manual'));
  assert.deepEqual(modes.modules, ['publications', 'magazine', 'events', 'search', 'communications']);
  assert.deepEqual(modesViolations('draft', modes), []);
  assert.deepEqual(setupModesProblems({ dataMode: 'live', modules: ['sales'] }), ['module_sales_requires_procurement', 'module_sales_requires_catalogue']);
});

test('the answers become HUB-001 configuration payloads its contract accepts (CFG-001 deployment document for identity and country)', () => {
  const { identity, country } = splitDeploymentConfig(setupDeploymentDocument(node, hub));
  assert.deepEqual(identity, { schemaVersion: 1, languages: { default: 'en', enabled: ['en', 'es'] }, brand: { overlay: null }, site: { url: 'https://build.example.org' } });
  assert.deepEqual(country, { schemaVersion: 1, countries: { default: 'US', offered: 'all' } });
  const payloads = {
    identity, country, modes: setupModes({ dataMode: 'demo' }), legal: setupLegalPayload(operator), residency: setupResidencyPayload(operator, residency), providers: setupProvidersPayload(providers),
  } as const;
  for (const [domain, payload] of Object.entries(payloads)) assert.deepEqual(configPayloadProblems(domain as keyof typeof payloads, payload), [], domain);
  assert.deepEqual(setupResidencyPayload(operator, { ...residency, personalDataCountry: 'CA' }).personalDataCountries, ['US', 'CA'], 'personal data is also where the hosting is');
});

test('the founding role: node scope, every permission in the console vocabulary, no ranking control', () => {
  const def = ScopedStaffRoleDefinitionSchema.parse({
    version: 1, role: 'node-operator', scopes: ['node'], permissions: [...FOUNDING_NODE_OPERATOR_PERMISSIONS], caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
    sodConflicts: [], sodMode: 'reduced', releasedAt: '2026-11-03T06:00:00Z', releasedBy: 'engine',
  });
  assert.ok(def.permissions.every((p) => (CONSOLE_PERMISSIONS as readonly string[]).includes(p)));
  assert.ok(def.permissions.includes('admin.node.hubs.manage') && def.permissions.includes('admin.session.elevate'));
  assert.ok(!def.permissions.some((p) => p.startsWith('admin.ops.restore.execute') || p === 'admin.staff.breakglass'), 'no emergency powers');
  for (const schema of Object.values(SETUP_ANSWER_SCHEMAS)) {
    const json = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }));
    assert.ok(json.includes('"properties"'), 'the schema was walked');
    const keys = [...json.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]);
    assert.ok(!keys.some((k) => FORBIDDEN_CONTROL_WORDS.test(k as string)), 'no ranking control in any answer');
  }
});

test('the wizard view masks the founding administrator address', () => {
  assert.equal(maskEmail('founder@example.org'), 'fo*****@example.org');
  assert.equal(maskEmail('a@example.org'), 'a***@example.org');
});

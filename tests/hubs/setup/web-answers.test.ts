import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_ANSWER_SCHEMAS } from '../../../packages/contracts/src/hub-setup.js';
import { answerFor, territoryOf } from '../../../apps/web/app/admin/setup/_live/answers.js';
import { ANSWERS } from './helpers.js';

/** A form as the live wizard submits it (`f.` fields), from plain values. */
function form(values: Record<string, string>) {
  const data = new Map(Object.entries(values).map(([k, v]) => [`f.${k}`, v]));
  return { get: (name: string) => data.get(name) ?? null, getAll: (name: string) => (data.has(name) ? [data.get(name) as string] : []) };
}

/**
 * The live wizard (apps/web/app/admin/setup/_live) shapes what a person typed into the API's step answers; every
 * answer it builds from a filled form is one the contract accepts, so the server's validation is the only check that
 * refuses (restricted places, order, second factor).
 */
test('the live wizard forms become answers the setup contract accepts', () => {
  const now = new Date('2026-11-03T06:00:00Z');
  const cases: Array<[keyof typeof SETUP_ANSWER_SCHEMAS, Record<string, string>, unknown]> = [
    ['install_check', {}, { clientTime: now.toISOString() }],
    ['node_identity', { nodeName: ' Synthetic reference node ', domain: 'Build.Example.org', jurisdiction: 'us' }, ANSWERS.node_identity],
    ['hub_identity', {
      country: 'US', startingPoint: 'generic', territories: 'us, US-CA ,us-ca:San-Diego', name: 'Synthetic Trustwork United States', languages: 'en, es', currency: 'usd',
      timeZone: 'America/Los_Angeles', slug: 'synthetic-us',
    }, { ...ANSWERS.hub_identity, name: { en: 'Synthetic Trustwork United States', es: 'Synthetic Trustwork United States' } }],
    ['operator', {
      legalName: ANSWERS.operator.legalName, form: 'llc', identifier: ANSWERS.operator.identifier, address: ANSWERS.operator.address, legalContact: ANSWERS.operator.legalContact,
      abuseContact: ANSWERS.operator.abuseContact, ownership: 'on', entityCountry: 'US', entityRegion: 'us-de', hostingCountry: 'US', hostingRegion: '', gateMode: 'upstream_gate',
    }, ANSWERS.operator],
    ['storage_residency', { personalDataCountry: 'US', privacyRegime: 'us_state_privacy', note: '' }, ANSWERS.storage_residency],
    ['providers', {
      'provider.llm': 'later', 'provider.email': 'fake', 'provider.sms': 'fake', 'provider.payments': 'fake', 'provider.maps_geocoding': 'fake', 'provider.register_lookup': 'manual',
      'provider.e_signature': 'fake', 'provider.tax_calculation': 'later', models: 'openrouter', directModelAdapter: 'anthropic',
    }, ANSWERS.providers],
    ['modes', { dataMode: 'demo', moderation: 'pre_moderate_new_authors' }, { dataMode: 'demo', moderation: 'pre_moderate_new_authors' }],
  ];
  for (const [step, values, expected] of cases) {
    const answer = answerFor(step, form(values), now);
    assert.deepEqual(answer, expected, step);
    assert.ok(SETUP_ANSWER_SCHEMAS[step].safeParse(answer).success, step);
  }
  assert.equal(answerFor('operator', form({ ownership: '' })).ownershipDeclared, false, 'an unticked declaration is sent as false and refused by the server');
  assert.deepEqual(territoryOf('UA-43:Simferopol'), { level: 'place', code: 'UA-43:simferopol' });
  assert.deepEqual(territoryOf('us-tx'), { level: 'region', code: 'US-TX' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPack } from '@trustwork/country-packs';
import { BUILT_IN_CLIENT_PACKS, getClientPack, toClientPack } from '@trustwork/country-packs/client';

test('GB ships a v1 client projection with hierarchy and formats but no national or regional facets', () => {
  const full = getPack('GB');
  const client = getClientPack('GB');
  assert.ok(full && client);
  assert.deepEqual(client, toClientPack(full));
  assert.deepEqual(BUILT_IN_CLIENT_PACKS.find((p) => p.code === 'GB'), client);
  assert.equal(client.currency.code, 'GBP');
  assert.equal(client.defaultLocale, 'en');
  assert.equal(client.formats.timeZone, 'Europe/London');
  assert.equal(client.regions.length, 221);
  assert.equal(client.regions.find((r) => r.code === 'GB-EDH')?.parent, 'GB-SCT');
  assert.deepEqual(Object.keys(client.registrationIdentifier).sort(), ['example', 'kind', 'label', 'pattern']);
  const serialized = JSON.stringify(client);
  for (const serverOnly of ['facets', 'sources', 'notes', 'verification', 'dataResidency', 'legalTemplates', 'candidateAdapters', 'registrationThreshold', 'counselReview', 'sensitive-utr', 'GB-UTR']) {
    assert.ok(!serialized.includes(`"${serverOnly}"`), `${serverOnly} must stay out of the client projection`);
  }
  assert.ok(full.facets.tax!.length > 0);
  assert.ok(full.regions.find((r) => r.code === 'GB-ENG')?.facets?.licensing?.length);
});

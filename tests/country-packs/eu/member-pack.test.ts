import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packProblems, validatePack } from '@trustwork/country-packs';
import { getLayer, layerProblems, layerResolver, layeredFactsFor, layeredPackProblems, memberVariesFor, validateLayer, validateLayeredPack, type CountryLayer } from '@trustwork/country-packs/layers';
import { syntheticLayer, syntheticMember } from './layer-fixture.js';

/** CTRY-EU: how a member pack inherits a shared layer, tested with a synthetic layer and member (no real facts). */

const LAYER = (): CountryLayer => validateLayer(syntheticLayer());
const check = (raw: unknown, layers: readonly CountryLayer[] = [LAYER()]) => layeredPackProblems(raw, { layers }).problems;
const memberSource = [{ url: 'https://example.invalid/xm/national-act', what: 'Synthetic member source: national act', accessed: '2026-10-31' }];

test('the synthetic layer validates', () => {
  assert.deepEqual(layerProblems(syntheticLayer()).problems, []);
});

test('a member pack that lists the layer validates and shows layer facts with the layer as their source', () => {
  assert.deepEqual(check(syntheticMember()), []);
  const pack = validateLayeredPack(syntheticMember(), { layers: [LAYER()] });
  assert.deepEqual(pack.layers, ['XL']);

  const privacy = layeredFactsFor(pack, 'privacy', undefined, [LAYER()]);
  assert.deepEqual(privacy.map((f) => [f.fact.id, f.scope, f.layer]), [['xl-data-law', 'XL', 'XL'], ['xl-child-consent', 'XL', 'XL']]);
  const tax = layeredFactsFor(pack, 'tax', undefined, [LAYER()]);
  assert.deepEqual(tax.map((f) => [f.fact.id, f.scope, f.layer]), [['xm-vat', 'XM', null]]);
  // A subdivision sees the layer facts too.
  assert.deepEqual(layeredFactsFor(pack, 'payments', 'XM-01', [LAYER()]).map((f) => [f.fact.id, f.layer]), [['xl-credit-transfer', 'XL']]);
  assert.deepEqual(memberVariesFor(pack, [LAYER()]).map((v) => `${v.layer}:${v.facet}/${v.topic}`), ['XL:tax/vat-rates', 'XL:calendar/public-holidays']);
});

test('a pack that lists a layer is refused by the plain validator, so a layer is never skipped silently', () => {
  const { pack, problems } = packProblems(syntheticMember());
  assert.equal(pack, null);
  assert.ok(problems.some((p) => p.includes('validate it with the layer registry')));
  assert.throws(() => validatePack(syntheticMember()), /layer registry/);
});

test('an override with its own source replaces the layer fact for the member', () => {
  const raw = syntheticMember({
    facets: {
      tax: syntheticMember().facets.tax,
      privacy: [{ type: 'law', id: 'xl-child-consent', name: { en: 'Child consent age (national)' }, minorsAge: 14, sources: memberSource, verification: 'official' }],
    },
  });
  assert.deepEqual(check(raw), []);
  const pack = validateLayeredPack(raw, { layers: [LAYER()] });
  const child = layeredFactsFor(pack, 'privacy', undefined, [LAYER()]).find((f) => f.fact.id === 'xl-child-consent');
  assert.ok(child);
  assert.equal(child.layer, null);
  assert.equal(child.scope, 'XM');
  assert.equal(child.fact.type === 'law' && child.fact.minorsAge, 14);
});

test('a member pack cannot silently contradict a layer fact: an override needs its own source', () => {
  const layerSources = syntheticLayer().facets.privacy[1]!.sources;
  const copied = syntheticMember({
    facets: { privacy: [{ type: 'law', id: 'xl-child-consent', name: { en: 'Child consent age' }, minorsAge: 13, sources: layerSources, verification: 'official' }] },
  });
  assert.ok(check(copied).some((p) => p.includes('XM privacy/xl-child-consent') && p.includes('without its own source')));

  // The same URL with a fragment or a trailing slash is still the layer's source.
  const disguised = syntheticMember({
    facets: { privacy: [{ type: 'law', id: 'xl-child-consent', name: { en: 'Child consent age' }, minorsAge: 13, sources: [{ ...layerSources[0]!, url: 'https://LAYER.example.invalid/acts/1/#art-8' }], verification: 'official' }] },
  });
  assert.ok(check(disguised).some((p) => p.includes('without its own source')));

  // A subdivision override follows the same rule.
  const regional = syntheticMember({
    regions: [{ code: 'XM-01', name: { en: 'First Province' }, kind: 'province', facets: { payments: [{ type: 'scheme', id: 'xl-credit-transfer', name: { en: 'Provincial transfer' }, rails: ['credit-transfer'], sources: syntheticLayer().facets.payments[0]!.sources, verification: 'official' }] } }],
  });
  assert.ok(check(regional).some((p) => p.includes('XM-01 payments/xl-credit-transfer') && p.includes('without its own source')));
});

test('an override must keep the facet and kind of the layer fact', () => {
  const raw = syntheticMember({
    facets: { contentLaw: [{ id: 'xl-data-law', topic: 'other', summary: { en: 'Not a privacy law' }, sources: memberSource, verification: 'official' }] },
  });
  assert.ok(check(raw).some((p) => p.includes('contentLaw/xl-data-law') && p.includes('different kind of fact')));
});

test('unknown, repeated and foreign layers are refused', () => {
  assert.ok(check(syntheticMember({ layers: ['ZZ'] })).some((p) => p.includes('layer ZZ is not a known layer')));
  assert.ok(check(syntheticMember({ layers: ['XL', 'XL'] })).some((p) => p.includes('listed twice')));
  const outsider = syntheticMember({
    code: 'XQ',
    regions: [{ code: 'XQ-01', name: { en: 'Province' }, kind: 'province' }],
    registrationIdentifier: { ...syntheticMember().registrationIdentifier, kind: 'XQ-REG' },
    facets: {},
  });
  assert.ok(check(outsider).some((p) => p.includes('XQ is not a member of layer XL')));
  const v1 = syntheticMember();
  delete (v1 as Record<string, unknown>).schemaVersion;
  delete (v1 as Record<string, unknown>).timeZones;
  delete (v1 as Record<string, unknown>).facets;
  for (const key of ['verificationLevel'] as const) delete (v1 as Record<string, unknown>)[key];
  delete (v1.registrationIdentifier as Record<string, unknown>).verificationLevel;
  delete (v1.dataResidency as Record<string, unknown>).verificationLevel;
  assert.ok(check(v1).some((p) => p.includes('layers needs "schemaVersion": 2')));
});

test('two layers may not declare the same fact', () => {
  const second = validateLayer({ ...syntheticLayer(), code: 'XK', memberVaries: [] });
  assert.ok(check(syntheticMember({ layers: ['XL', 'XK'] }), [LAYER(), second]).some((p) => p.includes('layers XL and XK both declare privacy/xl-data-law')));
});

test('layers cannot enable a restricted place', () => {
  // A layer that lists a restricted place is refused when it is validated...
  const tainted = syntheticLayer();
  tainted.members.codes.push('KP');
  assert.ok(layerProblems(tainted).problems.some((p) => p.includes('member KP is a restricted place')));
  // ...and refused again if an unvalidated layer object reaches the resolver.
  const unchecked = { ...LAYER(), members: { ...LAYER().members!, codes: ['XM', 'IR'] } } as CountryLayer;
  assert.ok(check(syntheticMember(), [unchecked]).some((p) => p.includes('lists a restricted place')));
  // A restricted pack stays refused whatever layer it lists, even one that names it as a member.
  const member = { ...LAYER(), members: { ...LAYER().members!, codes: ['IR'] } } as CountryLayer;
  const restricted = syntheticMember({ code: 'IR', regions: [{ code: 'IR-01', name: { en: 'x' }, kind: 'province' }], registrationIdentifier: { ...syntheticMember().registrationIdentifier, kind: 'IR-REG' }, facets: {} });
  const { pack, problems } = layeredPackProblems(restricted, { layers: [member] });
  assert.equal(pack, null);
  assert.ok(problems.some((p) => p.includes('restricted place')));
});

test('layer rules: official hosts, counsel review and member topics', () => {
  const offHost = syntheticLayer();
  offHost.facets.payments[0]!.sources = [{ url: 'https://elsewhere.example.invalid/blog', what: 'Synthetic secondary page', accessed: '2026-10-31' }];
  assert.ok(layerProblems(offHost).problems.some((p) => p.includes('payments/xl-credit-transfer') && p.includes('no official source')));

  const counsel = syntheticLayer();
  counsel.facets.agentLaw[0]!.verification = 'official';
  assert.ok(layerProblems(counsel).problems.some((p) => p.includes('counsel review')));

  const both = syntheticLayer();
  both.memberVaries.push({ facet: 'privacy', topic: 'xl-data-law', summary: { en: 'Contradiction' }, sources: [] });
  assert.ok(layerProblems(both).problems.some((p) => p.includes('is also stated as a layer fact')));

  const adapter = syntheticLayer();
  (adapter.facets.procurement[0] as Record<string, unknown>).adapter = { capability: 'sanctions_list', id: 'does-not-exist' };
  assert.ok(layerProblems(adapter).problems.some((p) => p.includes('does not exist in the engine')));
});

test('reading facts fails closed when a listed layer is not available', () => {
  const pack = validateLayeredPack(syntheticMember(), { layers: [LAYER()] });
  assert.throws(() => layeredFactsFor(pack, 'privacy', undefined, []), /layer XL is not available/);
  assert.equal(getLayer('XL', []), null);
  assert.equal(typeof layerResolver([LAYER()]), 'function');
});

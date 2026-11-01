import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { BUILT_IN_PACKS, RESTRICTED, VERIFICATION_LEVELS, isRestricted, listFacts, packProblems } from '@trustwork/country-packs';
import { BUILT_IN_LAYERS, getLayer, layerProblems, layeredPackProblems } from '@trustwork/country-packs/layers';

/** CTRY-EU: the European Union layer, sourced from EUR-Lex and other official EU pages. */

const RAW = JSON.parse(readFileSync('packages/country-packs/layers/eu.json', 'utf8')) as Record<string, unknown>;
type RawLayer = { code: string; members: { codes: string[] }; facets: { privacy: { sources: unknown[] }[] } };
const clone = (): RawLayer => structuredClone(RAW) as unknown as RawLayer;
const eu = () => {
  const layer = getLayer('eu');
  assert.ok(layer, 'the EU layer ships with the engine');
  return layer;
};
const officialEu = (url: string) => {
  const host = new URL(url).hostname;
  return host === 'europa.eu' || host.endsWith('.europa.eu');
};

test('the EU layer validates without a single problem and ships as a built-in layer', () => {
  assert.deepEqual(layerProblems(RAW).problems, []);
  assert.ok(BUILT_IN_LAYERS.some((layer) => layer.code === 'EU'));
  assert.deepEqual(eu().officialHosts, ['europa.eu']);
});

test('every layer fact cites an official EU source with its access date and an honest verification level', () => {
  const facts = listFacts(eu().facets);
  assert.ok(facts.length >= 20, 'the layer covers the sourced EU topics');
  for (const { facet, fact } of facts) {
    const at = `${facet}/${fact.id}`;
    assert.ok(fact.sources.some((source) => officialEu(source.url)), `${at} cites a europa.eu page`);
    for (const source of fact.sources) {
      assert.match(source.accessed, /^\d{4}-\d{2}-\d{2}$/, `${at} source has an access date`);
      assert.ok(source.what.length > 10, `${at} source says what it confirms`);
      assert.ok(!source.url.includes('example.invalid'), `${at} cites no placeholder`);
    }
    assert.ok(VERIFICATION_LEVELS.includes(fact.verification), `${at} has a verification level`);
    if (fact.verification !== 'official') assert.ok(fact.verificationNote, `${at} says why it is below official`);
    assert.equal('adapter' in fact && fact.adapter !== undefined, false, `${at} names adapters only as candidates (no live register call)`);
  }
  assert.ok(eu().sources.some((source) => officialEu(source.url)));
  assert.ok(eu().members?.sources.every((source) => officialEu(source.url)));
});

test('the layer covers every act the package names', () => {
  const ids = new Set(listFacts(eu().facets).map((entry) => entry.fact.id));
  for (const id of [
    'gdpr', 'gdpr-child-consent-age', 'eidas-qualified-signature', 'eidas-advanced-signature', 'eu-digital-identity-wallet',
    'eu-einvoicing-public-buyers', 'vida-intra-eu-einvoicing', 'eurocodes', 'construction-products-regulation', 'ted',
    'public-works-threshold', 'central-supplies-services-threshold', 'sub-central-supplies-services-threshold', 'utilities-works-threshold',
    'utilities-supplies-services-threshold', 'sepa-credit-transfer-direct-debit', 'sepa-instant-credit-transfer', 'late-payment-directive',
    'dsa-notice-and-action', 'dsa-advertising-transparency', 'dsa-recommender-transparency', 'dsa-trader-traceability', 'ai-act-interaction-disclosure',
    'european-accessibility-act', 'eu-consolidated-financial-sanctions',
  ]) assert.ok(ids.has(id), `fact ${id}`);
  const cited = JSON.stringify(eu().facets);
  for (const act of ['32016R0679', '32014R0910', '32024R1183', '32025L0516', '32014L0055', '32003H0887', '32024R3110', '32014L0024', '32014L0025', '32019R1780', '32012R0260', '32024R0886', '32011L0007', '32022R2065', '32024R1689', '32019L0882']) {
    assert.ok(cited.includes(act), `act ${act} is cited`);
  }
});

test('recorded values match the cited texts', () => {
  const facets = eu().facets;
  const gdpr = facets.privacy?.find((f) => f.id === 'gdpr');
  assert.ok(gdpr && gdpr.type === 'law');
  assert.equal(gdpr.breachNotificationHours, 72);
  assert.equal(gdpr.effectiveFrom, '2018-05-25');
  const child = facets.privacy?.find((f) => f.id === 'gdpr-child-consent-age');
  assert.ok(child && child.type === 'law' && child.minorsAge === 16);
  const thresholds = Object.fromEntries((facets.procurement ?? []).flatMap((f) => (f.type === 'threshold' ? [[f.id, f.amount]] : [])));
  assert.deepEqual(thresholds['public-works-threshold'], { minorUnits: '540400000', currency: 'EUR' });
  assert.deepEqual(thresholds['central-supplies-services-threshold'], { minorUnits: '14000000', currency: 'EUR' });
  assert.deepEqual(thresholds['sub-central-supplies-services-threshold'], { minorUnits: '21600000', currency: 'EUR' });
  assert.deepEqual(thresholds['utilities-works-threshold'], { minorUnits: '540400000', currency: 'EUR' });
  assert.deepEqual(thresholds['utilities-supplies-services-threshold'], { minorUnits: '43200000', currency: 'EUR' });
  const late = facets.payments?.find((f) => f.id === 'late-payment-directive');
  assert.ok(late && late.type === 'payment-terms' && late.businessMaxDays === 60 && late.publicAuthorityMaxDays === 30);
  const vida = facets.tax?.find((f) => f.id === 'vida-intra-eu-einvoicing');
  assert.ok(vida && vida.type === 'e-invoicing' && vida.mandatory && vida.effectiveFrom === '2030-07-01');
  const cpr = facets.standards?.find((f) => f.id === 'construction-products-regulation');
  assert.equal(cpr?.effectiveFrom, '2026-01-08');
  assert.deepEqual(facets.standards?.find((f) => f.id === 'eurocodes')?.adopts, ['EN 1990', 'EN 1991', 'EN 1992', 'EN 1993', 'EN 1994', 'EN 1995', 'EN 1996', 'EN 1997', 'EN 1998', 'EN 1999']);
  const ted = facets.procurement?.find((f) => f.id === 'ted');
  assert.ok(ted && ted.type === 'portal' && ted.level === 'supranational' && ted.url === 'https://ted.europa.eu/');
});

test('agent-law defaults stay unverified until counsel review', () => {
  for (const fact of eu().facets.agentLaw ?? []) {
    assert.notEqual(fact.verification, 'official');
    assert.equal(fact.counselReview, 'pending');
  }
});

test('what members vary is left to the member packs', () => {
  const layer = eu();
  const topics = layer.memberVaries.map((v) => `${v.facet}/${v.topic}`);
  for (const topic of ['tax/vat-rates', 'tax/national-einvoicing-mandates', 'standards/national-annexes', 'calendar/public-holidays']) assert.ok(topics.includes(topic), topic);
  assert.equal((layer.facets.tax ?? []).some((f) => f.type === 'rate'), false, 'no VAT rate is stated by the layer');
  assert.equal(layer.facets.calendar, undefined, 'no holiday is stated by the layer');
  for (const varies of layer.memberVaries) for (const source of varies.sources ?? []) assert.ok(officialEu(source.url));
});

test('members: the 27 member states, none of them a restricted place', () => {
  const codes = eu().members?.codes ?? [];
  assert.equal(codes.length, 27);
  assert.equal(new Set(codes).size, 27);
  for (const code of codes) assert.equal(isRestricted(code), false, code);
});

test('a layer cannot enable a restricted place', () => {
  // Countries restricted as a whole; restricted subdivisions cannot be members at all (members are ISO 3166-1 codes).
  for (const place of RESTRICTED.places.map((p) => p.code).filter((code) => /^[A-Z]{2}$/.test(code))) {
    const raw = clone();
    raw.members.codes.push(place);
    assert.ok(layerProblems(raw).problems.some((p) => p.includes('restricted place')), `${place} refused as a member`);
  }
  const named = clone();
  named.code = 'IR';
  assert.ok(layerProblems(named).problems.some((p) => p.includes('restricted place')));
});

test('a layer fact without an official EU source is refused', () => {
  const raw = clone();
  raw.facets.privacy[0]!.sources = [{ url: 'https://www.example.com/gdpr-summary', what: 'A secondary summary', accessed: '2026-10-31' }];
  assert.ok(layerProblems(raw).problems.some((p) => p.includes('privacy/gdpr') && p.includes('official source')));
});

test('the shipped packs list no layer and validate the same with and without the layer registry', () => {
  for (const pack of BUILT_IN_PACKS) {
    assert.equal(pack.layers, undefined, pack.code);
    const raw = JSON.parse(readFileSync(`packages/country-packs/packs/${pack.code.toLowerCase()}.json`, 'utf8')) as unknown;
    assert.deepEqual(packProblems(raw).problems, []);
    assert.deepEqual(layeredPackProblems(raw).problems, []);
  }
});

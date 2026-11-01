import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  enabledPacks, factsFor, formatMoney, getCountryPack, getPack, holidaysInYear,
  identifierKinds, isRestricted, listFacts, packProblems, validateIdentifier, type CountryPack,
} from '@trustwork/country-packs';
import { getClientPack, toClientPack } from '@trustwork/country-packs/client';
import { intlTagFor } from '@trustwork/ui/i18n';
import { negotiate } from '../../../apps/web/app/_lib/locale-negotiation.js';

const RAW: unknown = JSON.parse(readFileSync('packages/country-packs/packs/mx.json', 'utf8'));
const mx = (): CountryPack => {
  const pack = getPack('MX');
  assert.ok(pack, 'Mexico is registered, not just a file on disk');
  return pack;
};
const allFacts = () => [...listFacts(mx().facets), ...mx().regions.flatMap((r) => listFacts(r.facets))];

test('Mexico validates as a partial v2 pack and replaces the generic visitor profile', () => {
  assert.deepEqual(packProblems(RAW).problems, []);
  assert.equal(mx().schemaVersion, 2);
  assert.equal(mx().status, 'partial');
  assert.equal(getCountryPack('mx'), mx());
  assert.ok(enabledPacks().some((p) => p.code === 'MX'));
  assert.equal(mx().layers, undefined, 'Mexico does not inherit EU law');
  assert.equal(mx().verificationLevel, 'pending', 'ISO mapping is not overstated');
});

test('a visitor choosing Mexico gets Spanish, es-MX formats, MXN and 32 entities', () => {
  const pack = mx();
  assert.equal(negotiate(null, pack, true), 'es');
  assert.equal(negotiate('en-US,en;q=0.9', pack, true), 'en', 'language remains independent of country');
  assert.equal(intlTagFor('es', pack.code), 'es-MX');
  assert.equal(pack.currency.code, 'MXN');
  assert.equal(pack.currency.minorUnitDigits, 2);
  assert.equal(formatMoney('123456', pack.currency.code, 'es-MX'), '$1,234.56');
  assert.equal(new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC' }).format(new Date('2026-09-16T00:00:00Z')), '16/9/2026');
  const states = 'AGU BCN BCS CAM CHP CHH COA COL DUR GUA GRO HID JAL MEX MIC MOR NAY NLE OAX PUE QUE ROO SLP SIN SON TAB TAM TLA VER YUC ZAC'.split(' ');
  assert.deepEqual(pack.regions.filter((r) => r.kind === 'state').map((r) => r.code.slice(3)).sort(), states.sort());
  assert.deepEqual(pack.regions.filter((r) => r.kind === 'district').map((r) => r.code), ['MX-CMX']);
  assert.equal(pack.regions.length, 32);
  for (const r of pack.regions) {
    assert.ok(r.name.en && r.name.es);
    assert.equal(isRestricted(r.code), false);
  }
});

test('phone and postal formats preserve leading zeros and all twelve IANA zones are usable', () => {
  assert.equal(mx().formats.phone.callingCode, '+52');
  assert.equal(mx().formats.phone.nationalLength, 10);
  const postal = new RegExp(mx().formats.postalCode.pattern);
  for (const value of ['01000', '77520']) assert.ok(postal.test(value));
  for (const value of ['1000', '010000', '01000-1234', 'ABCDE']) assert.equal(postal.test(value), false);
  assert.equal(new Set(mx().timeZones).size, 12);
  for (const zone of mx().timeZones) assert.doesNotThrow(() => new Intl.DateTimeFormat('es-MX', { timeZone: zone }));
  assert.ok(mx().timeZones.includes('America/Ciudad_Juarez') && mx().timeZones.includes('America/Ojinaga'));
  const offset = (zone: string, date: string) => new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(date)).find((p) => p.type === 'timeZoneName')?.value;
  assert.equal(offset('America/Mexico_City', '2026-07-01'), 'GMT-06:00', 'do not revive obsolete nationwide summer time');
  assert.equal(offset('America/Tijuana', '2026-07-01'), 'GMT-07:00');
  assert.equal(offset('America/Tijuana', '2026-01-01'), 'GMT-08:00', 'border zone keeps its own rules');
});

test('RFC formats distinguish legal entities from sole proprietors and never expose CURP', () => {
  const pack = mx();
  for (const value of ['XXX010101AA0', 'Ñ&X000101AA0']) assert.ok(validateIdentifier(pack, value));
  for (const value of ['XXXX010101AA0', 'XXX001301AA0', 'XXX010132AA0', 'XXX010101AAB', 'xxx010101AA0']) assert.equal(validateIdentifier(pack, value), false);
  assert.ok(validateIdentifier(pack, 'XXXX010101AA0', 'MX-RFCPF'));
  assert.equal(validateIdentifier(pack, 'XXX010101AA0', 'MX-RFCPF'), false);
  assert.deepEqual(identifierKinds(pack).map((k) => k.kind), ['MX-RFC', 'MX-RFCPF']);
  assert.equal(validateIdentifier(pack, 'SYNTHETIC-PRIVATE-ID', 'MX-CURP'), false);
  assert.doesNotMatch(JSON.stringify(identifierKinds(pack).map(({ kind, label, pattern, example }) => ({ kind, label, pattern, example }))), /CURP|curp/);
  assert.doesNotMatch(JSON.stringify(pack.facets.registers), /CURP|curp/);
  assert.match(pack.notes?.join(' ') ?? '', /CURP.*never display/);
  assert.match(pack.registrationIdentifier.verification, /synthetic/);
});

test('every fact has dated primary provenance and uncertain facts explain their limits', () => {
  const primaryHost = (url: string) => /(?:^|\.)(?:gob\.mx|inegi\.org\.mx|ift\.org\.mx|secihti\.mx|ine\.mx|iana\.org|iso\.org|upu\.int|six-group\.com)$/.test(new URL(url).hostname);
  const sources = [...mx().sources, ...mx().registrationIdentifier.sources, ...mx().dataResidency.sources, ...allFacts().flatMap(({ fact }) => fact.sources)];
  for (const source of sources) {
    assert.ok(primaryHost(source.url), source.url);
    assert.equal(source.accessed, '2026-11-01');
    assert.ok(source.what.length > 20);
  }
  for (const { fact } of allFacts()) {
    assert.ok(fact.sources.length > 0);
    assert.ok(['official', 'secondary', 'candidate', 'pending'].includes(fact.verification));
    if (fact.verification !== 'official') assert.ok(fact.verificationNote, fact.id);
    assert.equal('adapter' in fact, false, `${fact.id} must not activate an adapter`);
  }
});

test('Mexico City licensing and codes do not become national rules', () => {
  for (const facet of ['licensing', 'standards'] as const) {
    assert.ok(factsFor(mx(), facet, 'MX-CMX').some(({ scope, fact }) => scope === 'MX-CMX' && fact.id.startsWith('cmx-')));
    for (const region of [undefined, 'MX-JAL', 'MX-BCN']) assert.equal(factsFor(mx(), facet, region).some(({ fact }) => fact.id.startsWith('cmx-')), false);
  }
  const repse = factsFor(mx(), 'licensing', 'MX-JAL').find(({ fact }) => fact.id === 'specialized-subcontracting')?.fact;
  assert.ok(repse?.type === 'activity' && repse.required);
  assert.match(repse.verificationNote ?? '', /not a blanket licence/);
});

test('standard IVA and conditional border incentive are separate and never computed by country alone', () => {
  const tax = factsFor(mx(), 'tax').map(({ fact }) => fact);
  const standard = tax.find((f) => f.id === 'iva');
  const border = tax.find((f) => f.id === 'border-iva-incentive');
  assert.ok(standard?.type === 'rate' && border?.type === 'rate');
  assert.equal(standard.standardRate, '16');
  assert.equal(standard.verification, 'official');
  assert.equal(border.standardRate, '16', 'a conditional credit does not eliminate the standard rate');
  assert.equal(border.reducedRates[0]?.rate, '8');
  assert.equal(border.verification, 'pending');
  for (const fact of [standard, border]) assert.equal(fact.calculation, 'adapter');
  const cfdi = tax.find((f) => f.type === 'e-invoicing');
  assert.ok(cfdi?.type === 'e-invoicing');
  assert.equal(cfdi.mandatory, true);
  assert.equal(cfdi.signatureRequired, true);
  assert.deepEqual(cfdi.scope, ['B2B', 'B2G', 'B2C']);
  assert.match(cfdi.verificationNote ?? '', /paid PAC is not universally required/);
});

test('statutory annual rest days follow article 74 with no invented recurring inauguration or election day', () => {
  const dates = (year: number) => holidaysInYear(mx(), year).map((h) => h.date);
  assert.deepEqual(dates(2026), ['2026-01-01', '2026-02-02', '2026-03-16', '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25']);
  assert.deepEqual(dates(2027), ['2027-01-01', '2027-02-01', '2027-03-15', '2027-05-01', '2027-09-16', '2027-11-15', '2027-12-25']);
  assert.equal(dates(2026).includes('2026-10-01'), false);
  for (const h of holidaysInYear(mx(), 2027)) assert.equal(h.observed, h.date, 'no unsupported Monday substitution');
});

test('privacy records the 2025 authority and keeps residency and agent-law decisions unverified', () => {
  const law = mx().facets.privacy?.find((f) => f.id === 'private-data-law');
  assert.ok(law?.type === 'law');
  assert.equal(law.authority?.name.es, 'Secretaría Anticorrupción y Buen Gobierno');
  assert.equal(law.effectiveFrom, '2025-03-21');
  assert.equal(mx().dataResidency.verificationLevel, 'pending');
  assert.match(mx().dataResidency.note.en ?? '', /not permission/);
  for (const fact of mx().facets.agentLaw ?? []) {
    assert.equal(fact.counselReview, 'pending');
    assert.equal(fact.verification, 'pending');
  }
});

test('missing evidence and unauthorized upgrades never validate', () => {
  const noSource = structuredClone(mx());
  noSource.facets.tax![0]!.sources = [];
  assert.notDeepEqual(packProblems(noSource).problems, []);
  const counsel = structuredClone(mx());
  counsel.facets.agentLaw![0]!.verification = 'official';
  assert.notDeepEqual(packProblems(counsel).problems, []);
  const restricted = structuredClone(mx());
  restricted.regions[0]!.parent = 'RU-MOW';
  assert.notDeepEqual(packProblems(restricted).problems, []);
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.next', '.next-e2e', 'dist', 'storybook-static'].includes(entry.name)) return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test('no engine country branching or Russian provider is introduced', () => {
  const branch = /(?:===|!==|==|!=)\s*['"`]MX(?:-[A-Z0-9]{1,3})?['"`]|['"`]MX(?:-[A-Z0-9]{1,3})?['"`]\s*(?:===|!==|==|!=)|case\s+['"`]MX(?:-[A-Z0-9]{1,3})?['"`]/;
  assert.deepEqual([...sourceFiles('apps'), ...sourceFiles('packages')].filter((path) => branch.test(readFileSync(path, 'utf8'))), []);
  const raw = JSON.stringify(RAW);
  assert.doesNotMatch(raw, /https?:[^"\s]*\.(?:ru|su|xn--p1ai)(?:[\/"\s]|$)/i);
  assert.doesNotMatch(raw, /\b(?:RUB|sberbank|sber|vtb|tinkoff|t-bank|yandex|yoomoney|yumoney|qiwi|webmoney|mir|nspk|sbp|gazprombank|alfa-bank|kontur|cryptopro|rostelecom|gosuslugi)\b/i);
  assert.doesNotMatch(raw, /\p{Script=Cyrillic}/u);
  assert.deepEqual(mx().facets.payments?.map((p) => p.id).sort(), ['cards', 'spei']);
});

test('the built-in browser projection contains Mexico formats but no national or city facets', () => {
  const client = getClientPack('MX');
  assert.ok(client, 'generated client data registers Mexico');
  assert.deepEqual(client, toClientPack(mx()));
  assert.equal(client.defaultLocale, 'es');
  assert.equal(client.currency.code, 'MXN');
  assert.equal(client.regions.length, 32);
  for (const key of ['facets', 'sources', 'notes', 'verificationLevel', 'dataResidency', 'timeZones', 'layers']) assert.equal(key in client, false, key);
  for (const region of client.regions) assert.equal('facets' in region, false, region.code);
  assert.equal('sources' in client.registrationIdentifier, false);
  assert.doesNotMatch(JSON.stringify(client), /MX-RFCPF|CURP|candidateAdapters|private-data-law|cmx-dro-corresponsables/);
});

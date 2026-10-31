import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFuzzyThreshold, engineRuleMatches, fuzzyRuleScore, FuzzyThresholdError, jaroWinkler, MATCHER_VERSION, screenedEntryTypes, screenedNamesDigest, screenNames, type CandidateEntry,
} from '../../packages/compliance/src/matching/index.js';
import { nameKey, nameKeys, NAME_KEY_VERSION } from '../../packages/compliance/src/names/index.js';
import { FUZZY_THRESHOLD_BOUNDS } from '../../packages/contracts/src/sanctions.js';

/**
 * SANC-003 matcher (ADR 014 decision 11). Every name below is invented for these tests; none is, or is meant to
 * resemble, a listed person or company.
 */
const tokens = (name: string) => nameKey(name).split(' ');
const entry = (uid: string, type: CandidateEntry['entryType'], names: string[], listCode = 'ofac-sdn'): CandidateEntry => ({
  listCode, listVersionId: '00000000-0000-4000-8000-000000000001', entryUid: uid, entryType: type, primaryName: names[0] as string, programs: ['SYNTHETIC-A'],
  nameKeys: nameKeys(names), entryDigest: 'a'.repeat(64),
});

test('engine rule: subject within the entry with at most one extra entry token', () => {
  assert.ok(engineRuleMatches(tokens('Zorvan Exampleton'), tokens('Zorvan Exampleton')));
  assert.ok(engineRuleMatches(tokens('Exampleton Zorvan'), tokens('Zorvan Exampleton')), 'order never matters');
  assert.ok(engineRuleMatches(tokens('Zorvan Exampleton'), tokens('Zorvan Q. Exampleton')), 'one more token on the entry side');
  assert.equal(engineRuleMatches(tokens('Zorvan Exampleton'), tokens('Zorvan Q. R. Exampleton')), false, 'two more tokens on the entry side');
  assert.equal(engineRuleMatches(tokens('Zorvan Exampleton'), tokens('Zorvan Fictivsky')), false);
});

test('engine rule: the entry equals the subject minus one token only for subjects of three or more tokens', () => {
  assert.ok(engineRuleMatches(tokens('Zorvan Quill Exampleton'), tokens('Zorvan Exampleton')));
  assert.equal(engineRuleMatches(tokens('Zorvan Exampleton'), tokens('Exampleton')), false, 'two-token subject: no dropped token');
  assert.equal(engineRuleMatches(tokens('Zorvan Quill Exampleton Moor'), tokens('Zorvan Exampleton')), false, 'two dropped tokens');
  assert.equal(engineRuleMatches(tokens('Zorvan Quill Exampleton'), tokens('Zorvan Exampleton Moor')), false, 'one dropped and one different');
});

test('engine rule: one-token subjects are never compared', () => {
  assert.equal(engineRuleMatches(['exampleton'], ['exampleton']), false);
  const report = screenNames('person', ['Exampleton'], [entry('S-1', 'individual', ['EXAMPLETON'])]);
  assert.equal(report.outcome, 'insufficient_name', 'a one-token name is never clear');
  assert.equal(report.matches.length, 0);
  assert.equal(screenNames('person', ['  '], []).outcome, 'insufficient_name', 'no letters at all');
});

test('screening: persons meet individuals, companies meet entities; vessels and aircraft only when enabled', () => {
  const entries = [
    entry('S-1', 'individual', ['Zorvan EXAMPLETON']),
    entry('S-3', 'entity', ['NORTHWIND SYNTHETIC SUPPLY LLC', 'NORTHWIND SYNTHETIC SUPPLY']),
    entry('S-5', 'vessel', ['NORTHWIND SYNTHETIC VOYAGER']),
  ];
  assert.deepEqual(screenedEntryTypes('person'), ['individual']);
  assert.deepEqual(screenedEntryTypes('company'), ['entity']);
  assert.deepEqual(screenedEntryTypes('company', { vesselsAndAircraft: true }), ['entity', 'vessel', 'aircraft']);
  const person = screenNames('person', ['Northwind Synthetic Supply'], entries);
  assert.equal(person.outcome, 'clear', 'a person is never compared with an entity');
  const company = screenNames('company', ['Northwind Synthetic Supply'], entries);
  assert.equal(company.outcome, 'possible_match');
  assert.deepEqual(company.matches.map((m) => [m.entryUid, m.rule, m.score]), [['S-3', 'engine', null]]);
  assert.equal(screenNames('company', ['Northwind Synthetic Voyager'], entries).outcome, 'clear');
  assert.equal(screenNames('company', ['Northwind Synthetic Voyager'], entries, { vesselsAndAircraft: true }).outcome, 'possible_match');
  assert.equal(screenNames('person', ['Zorvan Exampleton'], entries).matches[0]?.matchedKey, 'exampleton zorvan');
});

test('screening: transliteration and marks meet the same entry; one match per entry; matcher version recorded', () => {
  const entries = [entry('S-1', 'individual', ['Zorvan EXAMPLETON', 'Зорван ЭКЗАМПЛТОН'])];
  const cyrillic = screenNames('person', ['Зорван Экзамплтон'], entries);
  assert.equal(cyrillic.outcome, 'possible_match');
  const marked = screenNames('person', ['Zörvan Exämpleton', 'Zorvan Exampleton'], entries);
  assert.equal(marked.matches.length, 1, 'several names matching one entry give one match');
  assert.equal(marked.matcherVersion, MATCHER_VERSION);
  assert.ok(MATCHER_VERSION.includes(NAME_KEY_VERSION), 'the name-key version is part of the matcher version');
  assert.equal(screenedNamesDigest(['Zorvan Exampleton']), screenedNamesDigest(['EXAMPLETON, Zorvan']), 'the same keys give the same digest');
  assert.notEqual(screenedNamesDigest(['Zorvan Exampleton']), screenedNamesDigest(['Zorvan Exampletown']));
});

test('fuzzy layer: off by default, bounded, and it only ever adds matches', () => {
  assert.equal(checkFuzzyThreshold(undefined), null);
  assert.equal(checkFuzzyThreshold(null), null);
  assert.equal(checkFuzzyThreshold(0.9), 0.9);
  for (const bad of [0.84, 0.995, 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => checkFuzzyThreshold(bad), FuzzyThresholdError, String(bad));
  assert.deepEqual(FUZZY_THRESHOLD_BOUNDS, { min: 0.85, max: 0.99 });
  const entries = [entry('S-1', 'individual', ['Zorvan EXAMPLETON']), entry('S-2', 'individual', ['Milo FICTIVSKY'])];
  const near = ['Zorvan Exampletonn'];
  assert.equal(screenNames('person', near, entries).outcome, 'clear', 'without a threshold a near spelling is not matched');
  const fuzzy = screenNames('person', near, entries, { fuzzyThreshold: 0.9 });
  assert.equal(fuzzy.outcome, 'possible_match');
  assert.equal(fuzzy.matches[0]?.rule, 'fuzzy');
  assert.ok((fuzzy.matches[0]?.score ?? 0) >= 0.9 && (fuzzy.matches[0]?.score ?? 1) < 1);
  assert.equal(fuzzy.fuzzyThreshold, 0.9);
  // Every engine-rule match survives with the fuzzy layer on, as an engine match (the layer adds, never replaces).
  const names = ['Zorvan Exampleton', 'Milo Fictivsky', 'Milo Q Fictivsky', 'Unrelated Person'];
  for (const name of names) {
    const off = screenNames('person', [name], entries);
    const on = screenNames('person', [name], entries, { fuzzyThreshold: 0.85 });
    for (const m of off.matches) assert.ok(on.matches.some((x) => x.entryUid === m.entryUid && x.rule === 'engine'), `${name}: ${m.entryUid} kept`);
    assert.ok(on.matches.length >= off.matches.length);
  }
  assert.equal(screenNames('person', ['Completely Different'], entries, { fuzzyThreshold: 0.85 }).outcome, 'clear');
  assert.throws(() => screenNames('person', near, entries, { fuzzyThreshold: 0.5 }), FuzzyThresholdError, 'no setting loosens matching below the bounds');
});

test('Jaro-Winkler: known values and the fuzzy rule structure', () => {
  assert.equal(jaroWinkler('same', 'same'), 1);
  assert.equal(jaroWinkler('', 'x'), 0);
  assert.ok(Math.abs(jaroWinkler('martha', 'marhta') - 0.9611) < 0.001);
  assert.ok(Math.abs(jaroWinkler('dwayne', 'duane') - 0.84) < 0.001);
  assert.equal(fuzzyRuleScore(['zorvan'], ['zorvan'], 0.9), null, 'one-token subjects stay out of the fuzzy layer too');
  assert.equal(fuzzyRuleScore(['zorvan', 'exampleton'], ['zorvan', 'q', 'r', 'exampleton'], 0.9), null, 'at most one extra entry token');
  assert.ok((fuzzyRuleScore(['zorvan', 'quill', 'exampletonn'], ['zorvan', 'exampleton'], 0.9) ?? 0) >= 0.9, 'entry minus one, under similarity');
});

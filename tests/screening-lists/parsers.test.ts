import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkListSanity, ScreeningListEntrySchema } from '../../packages/contracts/src/sanctions.js';
import {
  entryDigest, FAKE_LIST_ENTRIES, fakeListExport, listDigest, MalformedListError, parseOfacSlsXml, parseXml, renderOfacSlsXml, XmlFormatError,
} from '../../packages/compliance/src/lists/index.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const malformed = (text: string, pattern: RegExp) => assert.throws(() => parseOfacSlsXml(text), (e: unknown) => e instanceof MalformedListError && pattern.test(e.message));

test('OFAC SDN export: publication data, entry types, programs, primary names, aliases and attributes', () => {
  const list = parseOfacSlsXml(fixture('ofac-sdn-synthetic.xml'));
  assert.equal(list.format, 'ofac-sls-xml');
  assert.equal(list.publishedOn, '2026-10-28');
  assert.equal(list.declaredCount, 6);
  assert.deepEqual(list.entries.map((e) => [e.entryUid, e.entryType]), [['910001', 'individual'], ['910002', 'individual'], ['910003', 'entity'], ['910004', 'entity'], ['910005', 'vessel'], ['910006', 'aircraft']]);
  const anna = list.entries[0]!;
  assert.equal(anna.primaryName, 'Anna Demonova TESTOVA');
  assert.deepEqual(anna.nameKeys, ['anna demonova testova', 'anna testova'], 'the Cyrillic alias meets the primary name; the shorter alias keeps its own key');
  assert.deepEqual(anna.attributes.aliases, ['Анна Демонова ТЕСТОВА', 'Ánna TESTOVÁ']);
  assert.deepEqual(anna.attributes.identifiers, [{ type: 'Passport', number: 'X0000001', country: 'Synthetica' }]);
  assert.deepEqual(anna.attributes.datesOfBirth, ['01 Jan 1970']);
  assert.deepEqual(anna.attributes.nationalities, ['Synthetica']);
  assert.deepEqual(anna.attributes.placesOfBirth, ['Example City, Synthetica']);
  assert.deepEqual(list.entries[1]!.programs, ['SYNTHETIC-A', 'SYNTHETIC-B']);
  assert.deepEqual(list.entries[2]!.attributes.aliases, ['EXAMPLE SYNTHETIC TRADING COMPANY & PARTNERS'], 'entities decode');
  assert.deepEqual(list.entries[2]!.attributes.addresses, ['1 Example Street, Example City, 00000, Synthetica']);
  for (const entry of list.entries) {
    assert.ok(ScreeningListEntrySchema.safeParse(entry).success, entry.entryUid);
    const { entryDigest: digest, ...body } = entry;
    assert.equal(digest, entryDigest(body), 'the digest is the canonical form');
  }
});

test('OFAC consolidated non-SDN export parses with the same adapter', () => {
  const list = parseOfacSlsXml(fixture('ofac-cons-synthetic.xml'));
  assert.equal(list.publishedOn, '2026-10-21');
  assert.equal(list.entries.length, 3);
  assert.deepEqual(list.entries[1]!.nameKeys, ['eksamplov zoran']);
});

test('digests: the version digest depends on content, not on entry order or file layout', () => {
  const a = parseOfacSlsXml(fixture('ofac-sdn-synthetic.xml'));
  const reordered = fixture('ofac-sdn-synthetic.xml').replace(/\n\s+/g, '');
  const b = parseOfacSlsXml(reordered);
  assert.equal(listDigest(a.entries), listDigest(b.entries));
  assert.equal(listDigest([...a.entries].reverse()), listDigest(a.entries));
  const changed = parseOfacSlsXml(fixture('ofac-sdn-synthetic.xml').replace('SYNTHETIC VOYAGER', 'SYNTHETIC VOYAGER II'));
  assert.notEqual(listDigest(changed.entries), listDigest(a.entries));
  assert.equal(listDigest([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty: SHA-256 of nothing, as the database computes it');
});

test('a truncated or malformed export is refused as a whole', () => {
  malformed(fixture('ofac-sdn-truncated.xml'), /unclosed element/);
  malformed('<sdnList><publshInformation><Publish_Date>13/45/2026</Publish_Date></publshInformation></sdnList>', /Publish_Date/);
  malformed('<sdnList><sdnEntry><lastName>X</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>', /no numeric uid/);
  malformed('<sdnList><sdnEntry><uid>1</uid><sdnType>Entity</sdnType></sdnEntry></sdnList>', /no lastName/);
  malformed('<sdnList><sdnEntry><uid>1</uid><lastName>X</lastName><sdnType>Spaceship</sdnType></sdnEntry></sdnList>', /unknown sdnType/);
  malformed('<sdnList><sdnEntry><uid>1</uid><lastName>X Y</lastName><sdnType>Entity</sdnType></sdnEntry><sdnEntry><uid>1</uid><lastName>Z W</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>', /duplicate entry uid 1/);
  malformed('<sdnList><sdnEntry><uid>1</uid><lastName>...</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>', /no name with letters/);
  malformed('<other/>', /not sdnList/);
  malformed('', /no root element/);
  malformed('<sdnList></sdnList><sdnList></sdnList>', /more than one root/);
  malformed('<sdnList>text & more</sdnList>', /bare ampersand/);
  malformed('<sdnList><publshInformation><Record_Count>many</Record_Count></publshInformation></sdnList>', /Record_Count/);
});

test('the XML reader refuses document type declarations and unknown entities (no expansion, no external entities)', () => {
  const doctype = '<?xml version="1.0"?><!DOCTYPE sdnList [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><sdnList>&b;</sdnList>';
  assert.throws(() => parseXml(doctype), (e: unknown) => e instanceof XmlFormatError && /document type/.test(e.message));
  assert.throws(() => parseXml('<a>&ext;</a>'), /unknown entity/);
  assert.throws(() => parseXml('<a><b></a></b>'), /unexpected closing tag/);
  assert.throws(() => parseXml('<a>' + '<b>'.repeat(40) + '</b>'.repeat(40) + '</a>'), /nesting too deep/);
  assert.equal(parseXml('<a x="1 &amp; 2"><![CDATA[<raw> & text]]>&#65;&#x42;</a>').text, '<raw> & textAB');
  assert.equal(parseXml('<ns:a xmlns:ns="urn:x"><ns:b>v</ns:b></ns:a>').children[0]?.name, 'b', 'namespaces reduce to local names');
});

test('sanity bounds: declared count, minimum, empty export and a drop beyond the share', () => {
  assert.deepEqual(checkListSanity({ parsedCount: 6, declaredCount: 6, previousCount: null, maxDropShare: 0.1, minEntries: 1 }).outcome, 'pass');
  const truncated = checkListSanity({ parsedCount: 4, declaredCount: 6, previousCount: 6, maxDropShare: 0.1, minEntries: 1 });
  assert.equal(truncated.outcome, 'rejected');
  assert.deepEqual(truncated.reasons, ['declared_count_mismatch']);
  assert.deepEqual(checkListSanity({ parsedCount: 0, declaredCount: null, previousCount: null, maxDropShare: 0.1, minEntries: 1 }).reasons, ['empty']);
  assert.deepEqual(checkListSanity({ parsedCount: 900, declaredCount: 900, previousCount: null, maxDropShare: 0.1, minEntries: 1000 }).reasons, ['below_minimum']);
  const drop = checkListSanity({ parsedCount: 80, declaredCount: 80, previousCount: 100, maxDropShare: 0.1, minEntries: 1 });
  assert.equal(drop.outcome, 'needs_confirmation');
  assert.equal(drop.dropShare, 0.2);
  assert.equal(checkListSanity({ parsedCount: 95, declaredCount: null, previousCount: 100, maxDropShare: 0.1, minEntries: 1 }).outcome, 'pass', 'a small drop passes');
  assert.equal(checkListSanity({ parsedCount: 150, declaredCount: null, previousCount: 100, maxDropShare: 0.1, minEntries: 1 }).dropShare, 0, 'growth is no drop');
});

test('the fake list is synthetic and renders in the OFAC schema the parser reads', () => {
  const list = parseOfacSlsXml(fakeListExport());
  assert.equal(list.entries.length, FAKE_LIST_ENTRIES.length);
  assert.equal(list.declaredCount, FAKE_LIST_ENTRIES.length);
  for (const entry of FAKE_LIST_ENTRIES) assert.ok(entry.programs.every((p) => p.startsWith('SYNTHETIC-')), 'every program marks the entry as synthetic');
  const short = parseOfacSlsXml(renderOfacSlsXml({ publishedOn: '2026-10-02', entries: FAKE_LIST_ENTRIES.slice(0, 2), declaredCount: 6 }));
  assert.equal(short.declaredCount, 6);
  assert.equal(short.entries.length, 2);
});

import type { ScreeningEntryType } from '../../../contracts/src/sanctions.js';

/**
 * A fake list with synthetic entries for tests, demos and the `fake` ingestion mode. Every name is invented and
 * marked as such; none is, or is meant to resemble, a listed person or company. The fake source renders these entries
 * in the OFAC classic XML schema, so the `fake` mode runs exactly the parser, sanity bounds and activation the real
 * exports run.
 */
export interface FakeListEntry {
  uid: string;
  type: ScreeningEntryType;
  firstName?: string;
  lastName: string;
  aliases?: { firstName?: string; lastName: string }[];
  programs: string[];
  datesOfBirth?: string[];
  country?: string;
}

export const FAKE_LIST_PUBLISHED_ON = '2026-10-01';

export const FAKE_LIST_ENTRIES: readonly FakeListEntry[] = [
  { uid: '900001', type: 'individual', firstName: 'Anna Demonova', lastName: 'TESTOVA', aliases: [{ firstName: 'Анна Демонова', lastName: 'ТЕСТОВА' }], programs: ['SYNTHETIC-A'], datesOfBirth: ['01 Jan 1970'], country: 'Synthetica' },
  { uid: '900002', type: 'individual', firstName: 'Ivo', lastName: 'PLACEHOLDER-SAMPLEMAN', programs: ['SYNTHETIC-A', 'SYNTHETIC-B'] },
  { uid: '900003', type: 'entity', lastName: 'EXAMPLE SYNTHETIC TRADING LLC', aliases: [{ lastName: 'EXAMPLE SYNTHETIC TRADING COMPANY' }], programs: ['SYNTHETIC-B'], country: 'Synthetica' },
  { uid: '900004', type: 'entity', lastName: 'DEMO FICTITIOUS HOLDINGS', programs: ['SYNTHETIC-C'] },
  { uid: '900005', type: 'vessel', lastName: 'SYNTHETIC VOYAGER', programs: ['SYNTHETIC-C'] },
  { uid: '900006', type: 'aircraft', lastName: 'TEST-REG-0001', programs: ['SYNTHETIC-C'] },
];

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const element = (name: string, text: string | undefined): string => (text === undefined ? '' : `<${name}>${escape(text)}</${name}>`);
const TYPE_NAMES: Readonly<Record<ScreeningEntryType, string>> = { individual: 'Individual', entity: 'Entity', vessel: 'Vessel', aircraft: 'Aircraft' };

/**
 * Renders entries in the OFAC classic XML schema. `declaredCount` defaults to the number of entries; tests pass a
 * different one to imitate a truncated export.
 */
export function renderOfacSlsXml(input: { publishedOn: string; entries: readonly FakeListEntry[]; declaredCount?: number }): string {
  const [year, month, day] = input.publishedOn.split('-');
  const entries = input.entries.map((e) => [
    '<sdnEntry>',
    element('uid', e.uid),
    element('firstName', e.firstName),
    element('lastName', e.lastName),
    element('sdnType', TYPE_NAMES[e.type]),
    `<programList>${e.programs.map((p) => element('program', p)).join('')}</programList>`,
    e.aliases?.length ? `<akaList>${e.aliases.map((a, i) => `<aka>${element('uid', `${e.uid}${i}`)}${element('type', 'a.k.a.')}${element('category', 'strong')}${element('firstName', a.firstName)}${element('lastName', a.lastName)}</aka>`).join('')}</akaList>` : '',
    e.datesOfBirth?.length ? `<dateOfBirthList>${e.datesOfBirth.map((d, i) => `<dateOfBirthItem>${element('uid', `${e.uid}${i}`)}${element('dateOfBirth', d)}</dateOfBirthItem>`).join('')}</dateOfBirthList>` : '',
    e.country ? `<addressList><address>${element('uid', `${e.uid}9`)}${element('country', e.country)}</address></addressList>` : '',
    '</sdnEntry>',
  ].join(''));
  return [
    '<?xml version="1.0" standalone="yes"?>',
    '<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">',
    `<publshInformation><Publish_Date>${month}/${day}/${year}</Publish_Date><Record_Count>${input.declaredCount ?? input.entries.length}</Record_Count></publshInformation>`,
    ...entries,
    '</sdnList>',
    '',
  ].join('\n');
}

/** The fake export of a list: the synthetic entries in the OFAC schema. */
export function fakeListExport(): string {
  return renderOfacSlsXml({ publishedOn: FAKE_LIST_PUBLISHED_ON, entries: FAKE_LIST_ENTRIES });
}

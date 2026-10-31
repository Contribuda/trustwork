import type { ScreeningEntryType } from '../../../contracts/src/sanctions.js';
import { assertUniqueUids, buildEntry, MalformedListError, type ParsedList, type RawEntry } from './entries.js';
import { child, childrenNamed, childText, parseXml, XmlFormatError, type XmlElement } from './xml.js';

/**
 * OFAC Sanctions List Service exports in the classic XML schema (`sdnList` with `publshInformation` and `sdnEntry`
 * elements): `SDN.XML` (the SDN list) and `CONSOLIDATED.XML` (the consolidated non-SDN lists). Both carry the
 * publication date and the record count, so a truncated download is caught twice: the XML does not close, or the
 * count disagrees. Reimplemented from the published schema; the OFAC exports are works of the US government.
 *
 * Read per entry: `uid`, `firstName`, `lastName`, `sdnType`, `programList/program`, `akaList/aka` (names), dates and
 * places of birth, nationalities, citizenships, `idList/id` and addresses. Unknown elements are ignored, so additions
 * to the schema do not break ingestion; a missing required element refuses the whole export.
 */
export const OFAC_SLS_XML_FORMAT = 'ofac-sls-xml';

const TYPES: Readonly<Record<string, ScreeningEntryType>> = { individual: 'individual', entity: 'entity', vessel: 'vessel', aircraft: 'aircraft' };

function publishDate(text: string | null): string | null {
  if (text === null) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) throw new MalformedListError(`unreadable Publish_Date ${text.slice(0, 20)}`);
  const [, month, day, year] = match as unknown as [string, string, string, string];
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new MalformedListError(`invalid Publish_Date ${text}`);
  return iso;
}

const personName = (element: XmlElement): string => [childText(element, 'firstName'), childText(element, 'lastName')].filter((p): p is string => p !== null).join(' ');

/** The items of a list element (`<programList><program>`), or none when the list element is missing. */
const items = (element: XmlElement, list: string, item: string): XmlElement[] => {
  const container = child(element, list);
  return container ? childrenNamed(container, item) : [];
};
const fieldTexts = (element: XmlElement, list: string, item: string, field: string): string[] =>
  items(element, list, item).map((i) => childText(i, field)).filter((v): v is string => v !== null);

function readEntry(element: XmlElement, index: number): RawEntry {
  const uid = childText(element, 'uid');
  if (uid === null || !/^\d{1,12}$/.test(uid)) throw new MalformedListError(`entry ${index + 1} has no numeric uid`);
  const typeText = childText(element, 'sdnType');
  const entryType = typeText ? TYPES[typeText.toLowerCase()] : undefined;
  if (!entryType) throw new MalformedListError(`entry ${uid} has an unknown sdnType ${String(typeText).slice(0, 30)}`);
  if (childText(element, 'lastName') === null) throw new MalformedListError(`entry ${uid} has no lastName`);
  const addresses = items(element, 'addressList', 'address').map((a) =>
    ['address1', 'address2', 'address3', 'city', 'stateOrProvince', 'postalCode', 'country'].map((f) => childText(a, f)).filter((v): v is string => v !== null).join(', '),
  );
  const identifiers = items(element, 'idList', 'id').flatMap((id) => {
    const type = childText(id, 'idType');
    const number = childText(id, 'idNumber');
    return type && number ? [{ type, number, country: childText(id, 'idCountry') }] : [];
  });
  return {
    entryUid: uid,
    entryType,
    primaryName: personName(element),
    aliases: items(element, 'akaList', 'aka').map(personName).filter((n) => n !== ''),
    programs: items(element, 'programList', 'program').map((p) => p.text).filter((t) => t !== ''),
    attributes: {
      datesOfBirth: fieldTexts(element, 'dateOfBirthList', 'dateOfBirthItem', 'dateOfBirth'),
      placesOfBirth: fieldTexts(element, 'placeOfBirthList', 'placeOfBirthItem', 'placeOfBirth'),
      nationalities: fieldTexts(element, 'nationalityList', 'nationality', 'country'),
      citizenships: fieldTexts(element, 'citizenshipList', 'citizenship', 'country'),
      addresses: addresses.filter((a) => a !== ''),
      identifiers,
    },
  };
}

/** Parses an OFAC SLS classic XML export (SDN or consolidated non-SDN). Throws `MalformedListError` on anything unreadable. */
export function parseOfacSlsXml(text: string): ParsedList {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    if (error instanceof XmlFormatError) throw new MalformedListError(error.message);
    throw error;
  }
  if (root.name !== 'sdnList') throw new MalformedListError(`root element ${root.name.slice(0, 40)} is not sdnList`);
  const info = child(root, 'publshInformation');
  const countText = info ? childText(info, 'Record_Count') : null;
  if (countText !== null && !/^\d{1,9}$/.test(countText)) throw new MalformedListError('unreadable Record_Count');
  const entries = childrenNamed(root, 'sdnEntry').map((element, index) => buildEntry(readEntry(element, index)));
  assertUniqueUids(entries);
  return { format: OFAC_SLS_XML_FORMAT, publishedOn: publishDate(info ? childText(info, 'Publish_Date') : null), declaredCount: countText === null ? null : Number(countText), entries };
}

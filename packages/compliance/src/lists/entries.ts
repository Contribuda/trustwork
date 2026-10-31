import { createHash } from 'node:crypto';
import { ScreeningListEntrySchema, type ScreeningEntryAttributes, type ScreeningEntryType, type ScreeningListEntry } from '../../../contracts/src/sanctions.js';
import { nameKeys } from '../names/index.js';

/** An export that cannot be read as a whole list. Nothing of it is staged; the active version stays. */
export class MalformedListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedListError';
  }
}

/** What a parser returns: the export's own publication data and every entry with its name keys and digest. */
export interface ParsedList {
  readonly format: string;
  /** ISO date the export states, or null. */
  readonly publishedOn: string | null;
  /** The entry count the export declares, or null when the format declares none. */
  readonly declaredCount: number | null;
  readonly entries: readonly ScreeningListEntry[];
}

export interface RawEntry {
  entryUid: string;
  entryType: ScreeningEntryType;
  primaryName: string;
  aliases: string[];
  programs: string[];
  attributes: Omit<ScreeningEntryAttributes, 'aliases'>;
}

/** Canonical JSON: object keys sorted, no whitespace; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** SHA-256 of an entry's canonical form without its digest. */
export function entryDigest(entry: Omit<ScreeningListEntry, 'entryDigest'>): string {
  return sha256(canonicalJson(entry));
}

/**
 * SHA-256 of the entry digests in entry-uid order, joined by a line feed. The database recomputes it at activation
 * (`string_agg(entry_digest, E'\n' ORDER BY entry_uid COLLATE "C")`), so a partly written version never activates.
 */
export function listDigest(entries: readonly Pick<ScreeningListEntry, 'entryUid' | 'entryDigest'>[]): string {
  const sorted = [...entries].sort((a, b) => (a.entryUid < b.entryUid ? -1 : a.entryUid > b.entryUid ? 1 : 0));
  return sha256(sorted.map((e) => e.entryDigest).join('\n'));
}

/** SHA-256 of the export bytes as received. */
export function sourceDigest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const clean = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.replace(/\s+/g, ' ').trim()).filter((v) => v !== ''))];

/** Builds and validates one entry: name keys of the primary name and every alias, canonical digest. */
export function buildEntry(raw: RawEntry): ScreeningListEntry {
  const primaryName = raw.primaryName.replace(/\s+/g, ' ').trim();
  const aliases = clean(raw.aliases).filter((a) => a !== primaryName);
  const keys = nameKeys([primaryName, ...aliases]);
  if (keys.length === 0) throw new MalformedListError(`entry ${raw.entryUid} has no name with letters or digits`);
  const attributes: ScreeningEntryAttributes = {};
  if (aliases.length) attributes.aliases = aliases;
  for (const field of ['datesOfBirth', 'placesOfBirth', 'nationalities', 'citizenships', 'addresses'] as const) {
    const values = clean(raw.attributes[field] ?? []);
    if (values.length) attributes[field] = values;
  }
  if (raw.attributes.identifiers?.length) attributes.identifiers = raw.attributes.identifiers;
  const body = { entryUid: raw.entryUid, entryType: raw.entryType, primaryName, programs: clean(raw.programs).sort(), nameKeys: keys, attributes };
  const parsed = ScreeningListEntrySchema.safeParse({ ...body, entryDigest: entryDigest(body) });
  if (!parsed.success) throw new MalformedListError(`entry ${raw.entryUid} does not fit the entry contract: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim());
  return parsed.data;
}

/** Refuses duplicate entry identifiers, which would make the version digest ambiguous. */
export function assertUniqueUids(entries: readonly ScreeningListEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.entryUid)) throw new MalformedListError(`duplicate entry uid ${entry.entryUid}`);
    seen.add(entry.entryUid);
  }
}

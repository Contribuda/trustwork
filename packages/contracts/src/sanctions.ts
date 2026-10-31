import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';

/**
 * Sanctions compliance: the jurisdiction gate and holds (SANC-001, ADR 014 decisions 2 and 6 to 9).
 *
 * - **Restricted places** come only from the authoritative list in `@trustwork/country-packs` (`restricted.json`); this
 *   file never lists them. Callers pass the list (`RestrictedPlaces`), so the API can take it from the synced kernel
 *   table and the web from the country-pack package, and a range table or header can never add or move a place.
 * - **The gate** runs before anything else at every door (the web proxy and the API). It asks a geolocation adapter for
 *   the restricted place of a request; the address is used for the lookup only and is never stored, logged or put in
 *   an outbox payload: a refusal and a hold name the place and the dataset.
 * - **Adapters** (pure, no network): `ranges_file` (a reduced range table generated locally from a dataset the operator
 *   obtains, see `RANGE_TABLE_FORMAT`), `edge_header` (a country and region header written by an edge the operator
 *   trusts), `upstream_gate` (an upstream place check already refuses restricted places) and `fake` (documentation
 *   address ranges, refused in production).
 * - **Holds**: a refused request that carries a valid session holds the person; an open hold refuses them everywhere and
 *   at sign-in until a compliance reviewer clears it with a reason and an evidence category (never the person).
 *
 * The address primitives and the range table live here, in the contracts package, because the web and both backend
 * images ship it (ADR 014 decision 19).
 */

/* ---------- Codes, modes and records ---------- */

/** Error codes of the gate. `jurisdiction.restricted` is HTTP 451 (RFC 7725); `auth.jurisdiction_hold` is 403. */
export const JURISDICTION_ERROR_CODES = ['jurisdiction.restricted', 'auth.jurisdiction_hold'] as const;
export type JurisdictionErrorCode = (typeof JURISDICTION_ERROR_CODES)[number];
export const JURISDICTION_ERROR_STATUS: Readonly<Record<JurisdictionErrorCode, number>> = { 'jurisdiction.restricted': 451, 'auth.jurisdiction_hold': 403 };

export const JURISDICTION_GATE_MODES = ['ranges_file', 'edge_header', 'upstream_gate', 'fake'] as const;
export const JurisdictionGateModeSchema = z.enum(JURISDICTION_GATE_MODES);
export type JurisdictionGateMode = z.infer<typeof JurisdictionGateModeSchema>;

export const HOLD_SOURCES = ['geolocation', 'edge_header', 'self_declared', 'payout_country', 'staff_report'] as const;
export const HoldSourceSchema = z.enum(HOLD_SOURCES);
export type HoldSource = z.infer<typeof HoldSourceSchema>;

export const HOLD_CLEAR_EVIDENCE = ['document', 'call', 'travel_record', 'other'] as const;
export const HoldClearEvidenceSchema = z.enum(HOLD_CLEAR_EVIDENCE);
export type HoldClearEvidence = z.infer<typeof HoldClearEvidenceSchema>;

/** ISO 3166-1 alpha-2 or ISO 3166-2 code. */
export const RestrictedPlaceCodeSchema = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/);
/** The dataset that answered, for example `dbip-city-lite-2026-10`, `edge-header` or `fake`. Never an address. */
export const GeoDatasetSchema = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,99}$/);

/** A hold as compliance staff see it (`SC`). The subject sees only `JurisdictionStatusSchema`. */
export const JurisdictionHoldSchema = z
  .strictObject({
    id: IdSchema,
    personId: IdSchema,
    place: RestrictedPlaceCodeSchema,
    source: HoldSourceSchema,
    dataset: GeoDatasetSchema,
    placedAt: TimestampSchema,
    clearedAt: TimestampSchema.nullable(),
    clearedBy: IdSchema.nullable(),
    clearReason: z.string().min(1).max(500).nullable(),
    clearEvidence: HoldClearEvidenceSchema.nullable(),
  })
  .refine((h) => [h.clearedAt, h.clearedBy, h.clearReason, h.clearEvidence].every((v) => v === null) || [h.clearedAt, h.clearedBy, h.clearReason, h.clearEvidence].every((v) => v !== null), {
    message: 'cleared is a time, a reviewer, a reason and an evidence category together, or none of them',
  })
  .refine((h) => h.clearedBy === null || h.clearedBy !== h.personId, { message: 'a hold is never cleared by its subject' });
export type JurisdictionHold = z.infer<typeof JurisdictionHoldSchema>;

/** Staff command: clear a hold after establishing that the person is not in a restricted place. */
export const ClearJurisdictionHoldCommandSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  evidence: HoldClearEvidenceSchema,
});
export type ClearJurisdictionHoldCommand = z.infer<typeof ClearJurisdictionHoldCommandSchema>;

/** What the subject is told about their own account: held or not, nothing about the place, dataset or reviewer. */
export const JurisdictionStatusSchema = z.strictObject({ held: z.boolean() });
export type JurisdictionStatus = z.infer<typeof JurisdictionStatusSchema>;

/** What a process reports about its gate (health, console): never a range, never an address. */
export const JurisdictionGateDescriptionSchema = z.strictObject({
  mode: z.union([JurisdictionGateModeSchema, z.literal('unconfigured')]),
  dataset: GeoDatasetSchema.nullable(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
  rangeCount: z.int().min(0).nullable(),
  attribution: z.string().max(300).nullable(),
});
export type JurisdictionGateDescription = z.infer<typeof JurisdictionGateDescriptionSchema>;

/* ---------- Restricted places (injected) ---------- */

/** The authoritative restricted codes (country-pack list or its kernel mirror). */
export interface RestrictedPlaces {
  readonly codes: ReadonlySet<string>;
}
export function restrictedPlaces(codes: Iterable<string>): RestrictedPlaces {
  const set = new Set<string>();
  for (const code of codes) {
    const upper = code.trim().toUpperCase();
    if (!RestrictedPlaceCodeSchema.safeParse(upper).success) throw new Error(`invalid restricted place code ${code}`);
    set.add(upper);
  }
  if (set.size === 0) throw new Error('the restricted places list is empty');
  return { codes: set };
}

/**
 * The listed restricted place that covers `code`, or null: the whole country when the country is listed (`RU-MOW` →
 * `RU`), the listed subdivision otherwise (`UA-43` → `UA-43`), nothing for an unlisted subdivision (`UA-30`) or a
 * country only partly restricted (`UA`).
 */
export function coveringRestrictedPlace(code: string | null | undefined, restricted: RestrictedPlaces): string | null {
  if (typeof code !== 'string') return null;
  const upper = code.trim().toUpperCase();
  if (!RestrictedPlaceCodeSchema.safeParse(upper).success) return null;
  const country = upper.slice(0, 2);
  if (restricted.codes.has(country)) return country;
  return restricted.codes.has(upper) ? upper : null;
}

/* ---------- Network addresses ---------- */

export type NumericAddress = { readonly family: 4; readonly value: number } | { readonly family: 6; readonly value: bigint };

/** An IPv4 address as an unsigned number, or null when the text is not one. */
export function ipv4ToNumber(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv6 address as a bigint, or null when the text is not one. A zone index (`%eth0`) is ignored. */
export function ipv6ToBigInt(text: string): bigint | null {
  let rest = text;
  const zone = rest.indexOf('%');
  if (zone >= 0) rest = rest.slice(0, zone);
  if (rest.length === 0) return null;
  const lastColon = rest.lastIndexOf(':');
  if (lastColon < 0) return null;
  if (rest.includes('.', lastColon)) {
    const v4 = ipv4ToNumber(rest.slice(lastColon + 1));
    if (v4 === null) return null;
    rest = `${rest.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const read = (half: string): number[] | null => {
    if (half === '') return [];
    const groups: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = read(halves[0] ?? '');
  const tail = halves.length === 2 ? read(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

/**
 * The address as a number of its family, or null when the text is not an address. An IPv4 address carried in IPv6
 * (`::ffff:203.0.113.7`) is read as IPv4, because that is how a dual-stack server reports a client that came over IPv4.
 */
export function parseAddress(text: string | null | undefined): NumericAddress | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 45) return null;
  if (!trimmed.includes(':')) {
    const value = ipv4ToNumber(trimmed);
    return value === null ? null : { family: 4, value };
  }
  const value = ipv6ToBigInt(trimmed);
  if (value === null) return null;
  if (value >> 32n === 0xffffn) return { family: 4, value: Number(value & 0xffffffffn) };
  return { family: 6, value };
}

/* ---------- Reduced range table (`ranges_file`) ---------- */

/**
 * Format of the reduced range table, JSON:
 *
 * ```json
 * { "format": "trustwork-restricted-ranges-1", "dataset": "dbip-city-lite", "month": "2026-10",
 *   "attribution": "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0",
 *   "codes": ["RU", "UA-43"],
 *   "v4": [[start, end, codeIndex]],         unsigned 32-bit integers, inclusive
 *   "v6": [["startHex", "endHex", codeIndex]] } 128-bit values in hexadecimal, inclusive
 * ```
 *
 * Generated by `packages/compliance/bin/restricted-ranges.mjs`. Both lists are sorted and disjoint; anything else is
 * refused, so a corrupt file never answers "not restricted" silently.
 */
export const RANGE_TABLE_FORMAT = 'trustwork-restricted-ranges-1';

export interface RangeTable {
  /** `<dataset>-<month>`, recorded beside every refusal and hold. */
  readonly datasetId: string;
  readonly month: string;
  readonly attribution: string;
  readonly rangeCount: number;
  /** The restricted place code an address lies in, or null. */
  lookup(address: string | null | undefined): string | null;
}

export class RangeTableError extends Error {
  constructor(message: string) {
    super(`invalid restricted range table: ${message}`);
    this.name = 'RangeTableError';
  }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATASET_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const HEX = /^[0-9a-f]{1,32}$/;
const V6_MAX = (1n << 128n) - 1n;

function searchRanges<T extends number | bigint>(starts: readonly T[], ends: readonly T[], value: T): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as T) > value) hi = mid - 1;
    else if ((ends[mid] as T) < value) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Validates a parsed range file against the authoritative list and returns the lookup. */
export function loadRangeTable(input: unknown, restricted: RestrictedPlaces): RangeTable {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RangeTableError('not an object');
  const file = input as Record<string, unknown>;
  if (file.format !== RANGE_TABLE_FORMAT) throw new RangeTableError(`format must be ${RANGE_TABLE_FORMAT}`);
  const { dataset, month, attribution, codes, v4, v6 } = file;
  if (typeof dataset !== 'string' || !DATASET_NAME.test(dataset)) throw new RangeTableError('dataset name');
  if (typeof month !== 'string' || !MONTH.test(month)) throw new RangeTableError('month (YYYY-MM)');
  if (typeof attribution !== 'string' || attribution.length > 300) throw new RangeTableError('attribution');
  if (!Array.isArray(codes) || codes.length === 0) throw new RangeTableError('codes');
  for (const code of codes) {
    if (typeof code !== 'string' || coveringRestrictedPlace(code, restricted) !== code) throw new RangeTableError(`code ${String(code)} is not a listed restricted place`);
  }
  if (!Array.isArray(v4) || !Array.isArray(v6)) throw new RangeTableError('v4 and v6 lists');
  const codeAt = (index: unknown): number => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= codes.length) throw new RangeTableError('code index');
    return index;
  };
  const v4s: number[] = [];
  const v4e: number[] = [];
  const v4c: number[] = [];
  for (const row of v4 as unknown[]) {
    if (!Array.isArray(row) || row.length !== 3) throw new RangeTableError('v4 row');
    const [start, end, code] = row as [unknown, unknown, unknown];
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 0xffffffff || start > end) throw new RangeTableError('v4 bounds');
    if (v4e.length && start <= (v4e[v4e.length - 1] as number)) throw new RangeTableError('v4 rows must be sorted and disjoint');
    v4s.push(start);
    v4e.push(end);
    v4c.push(codeAt(code));
  }
  const v6s: bigint[] = [];
  const v6e: bigint[] = [];
  const v6c: number[] = [];
  for (const row of v6 as unknown[]) {
    if (!Array.isArray(row) || row.length !== 3) throw new RangeTableError('v6 row');
    const [startHex, endHex, code] = row as [unknown, unknown, unknown];
    if (typeof startHex !== 'string' || typeof endHex !== 'string' || !HEX.test(startHex) || !HEX.test(endHex)) throw new RangeTableError('v6 row');
    const start = BigInt(`0x${startHex}`);
    const end = BigInt(`0x${endHex}`);
    if (start > end || end > V6_MAX) throw new RangeTableError('v6 bounds');
    if (v6e.length && start <= (v6e[v6e.length - 1] as bigint)) throw new RangeTableError('v6 rows must be sorted and disjoint');
    v6s.push(start);
    v6e.push(end);
    v6c.push(codeAt(code));
  }
  const names = [...(codes as string[])];
  return {
    datasetId: `${dataset}-${month}`,
    month,
    attribution,
    rangeCount: v4s.length + v6s.length,
    lookup(address) {
      const parsed = parseAddress(address);
      if (!parsed) return null;
      if (parsed.family === 4) {
        const index = searchRanges(v4s, v4e, parsed.value);
        return index < 0 ? null : (names[v4c[index] as number] ?? null);
      }
      const index = searchRanges(v6s, v6e, parsed.value);
      return index < 0 ? null : (names[v6c[index] as number] ?? null);
    },
  };
}

/** Whole months between a table's month and `now`; past two the gate is due a refresh (ADR 014 decision 7). */
export function rangeTableAgeInMonths(month: string, now: Date): number {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - mon);
}

/* ---------- The gate ---------- */

/** What a door knows about a request: the client address after its trusted-proxy rules, and header access. */
export interface GateRequest {
  readonly address: string | null;
  header(name: string): string | null;
}

/** A restricted sighting: the place and the dataset that answered. Never the address. */
export interface Sighting {
  readonly place: string;
  readonly dataset: string;
}

export interface JurisdictionGate {
  readonly mode: JurisdictionGateMode | 'unconfigured';
  /** The restricted place of a request, or null when it is served. */
  decide(request: GateRequest): Sighting | null;
  describe(): JurisdictionGateDescription;
}

export function rangesFileGate(table: RangeTable): JurisdictionGate {
  return {
    mode: 'ranges_file',
    decide(request) {
      const place = table.lookup(request.address);
      return place ? { place, dataset: table.datasetId } : null;
    },
    describe: () => ({ mode: 'ranges_file', dataset: table.datasetId, month: table.month, rangeCount: table.rangeCount, attribution: table.attribution }),
  };
}

/**
 * Country (ISO 3166-1 alpha-2) and optional region header written by an edge the operator trusts, for example a CDN
 * that strips client-supplied copies. The region header may carry the subdivision with or without the country prefix
 * (`43` or `UA-43`). A country restricted only in part (Ukraine) is refused only when the region is known.
 */
export function edgeHeaderGate(options: { restricted: RestrictedPlaces; countryHeader: string; regionHeader?: string | null }): JurisdictionGate {
  const countryHeader = options.countryHeader.toLowerCase();
  const regionHeader = options.regionHeader ? options.regionHeader.toLowerCase() : null;
  return {
    mode: 'edge_header',
    decide(request) {
      const country = request.header(countryHeader)?.trim().toUpperCase() ?? '';
      if (!/^[A-Z]{2}$/.test(country)) return null;
      const whole = coveringRestrictedPlace(country, options.restricted);
      if (whole) return { place: whole, dataset: 'edge-header' };
      if (!regionHeader) return null;
      const region = request.header(regionHeader)?.trim().toUpperCase() ?? '';
      if (!/^(?:[A-Z]{2}-)?[A-Z0-9]{1,3}$/.test(region)) return null;
      const code = region.includes('-') ? region : `${country}-${region}`;
      if (code.slice(0, 2) !== country) return null;
      const place = coveringRestrictedPlace(code, options.restricted);
      return place ? { place, dataset: 'edge-header' } : null;
    },
    describe: () => ({ mode: 'edge_header', dataset: 'edge-header', month: null, rangeCount: null, attribution: null }),
  };
}

/** An upstream place check already refuses restricted places (for example the hosted preview's private network). */
export function upstreamGate(): JurisdictionGate {
  return { mode: 'upstream_gate', decide: () => null, describe: () => ({ mode: 'upstream_gate', dataset: null, month: null, rangeCount: null, attribution: null }) };
}

/** No gate configured (development only); the API refuses this in production. */
export function unconfiguredGate(): JurisdictionGate {
  return { mode: 'unconfigured', decide: () => null, describe: () => ({ mode: 'unconfigured', dataset: null, month: null, rangeCount: null, attribution: null }) };
}

/**
 * Deterministic answers for tests and demos over documentation address ranges (RFC 5737, RFC 3849), never real
 * addresses: 192.0.2.0/24 is the first listed country, 198.51.100.0/25 the first listed subdivision (if any) and
 * 2001:db8::/48 the first listed country; 203.0.113.0/24 and 198.51.100.128/25 are served. Refused in production.
 */
export const FAKE_GATE_RANGES = {
  restrictedCountryV4: '192.0.2.0/24',
  restrictedSubdivisionV4: '198.51.100.0/25',
  restrictedCountryV6: '2001:db8::/48',
  servedV4: ['203.0.113.0/24', '198.51.100.128/25'],
} as const;
export function fakeGate(restricted: RestrictedPlaces): JurisdictionGate {
  const sorted = [...restricted.codes].sort();
  const country = sorted.find((c) => c.length === 2) ?? (sorted[0] as string);
  const subdivision = sorted.find((c) => c.includes('-')) ?? country;
  const codes = [...new Set([country, subdivision])];
  const table = loadRangeTable(
    {
      format: RANGE_TABLE_FORMAT,
      dataset: 'fake',
      month: '2026-01',
      attribution: 'Fake gate: documentation address ranges only',
      codes,
      v4: [
        [0xc0000200, 0xc00002ff, 0],
        [0xc6336400, 0xc633647f, codes.indexOf(subdivision)],
      ],
      v6: [['20010db8000000000000000000000000', '20010db80000ffffffffffffffffffff', 0]],
    },
    restricted,
  );
  return {
    mode: 'fake',
    decide(request) {
      const place = table.lookup(request.address);
      return place ? { place, dataset: 'fake' } : null;
    },
    describe: () => ({ mode: 'fake', dataset: 'fake', month: null, rangeCount: table.rangeCount, attribution: table.attribution }),
  };
}

/* ---------- Configuration ---------- */

export class JurisdictionGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JurisdictionGateConfigError';
  }
}

/**
 * Environment variables (the same names for the web and the API):
 *
 * - `TRUSTWORK_JURISDICTION_GATE`: `ranges_file`, `edge_header`, `upstream_gate` or `fake`. Unset means unconfigured,
 *   which only development accepts (`requireMode`); `fake` is refused in production.
 * - `TRUSTWORK_JURISDICTION_RANGES_FILE`: path of the reduced range table (`ranges_file`); default
 *   `<TRUSTWORK_DATA_DIR>/jurisdiction/restricted-ranges.json`.
 * - `TRUSTWORK_JURISDICTION_COUNTRY_HEADER`, `TRUSTWORK_JURISDICTION_REGION_HEADER`: header names (`edge_header`).
 */
export const JURISDICTION_ENV = {
  mode: 'TRUSTWORK_JURISDICTION_GATE',
  rangesFile: 'TRUSTWORK_JURISDICTION_RANGES_FILE',
  countryHeader: 'TRUSTWORK_JURISDICTION_COUNTRY_HEADER',
  regionHeader: 'TRUSTWORK_JURISDICTION_REGION_HEADER',
  dataDir: 'TRUSTWORK_DATA_DIR',
} as const;

export function jurisdictionGateFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { restricted: RestrictedPlaces; production: boolean; requireMode: boolean; readJson: (path: string) => unknown; joinPath: (...parts: string[]) => string },
): JurisdictionGate {
  const raw = env[JURISDICTION_ENV.mode]?.trim() ?? '';
  if (raw === '') {
    if (options.requireMode) throw new JurisdictionGateConfigError(`${JURISDICTION_ENV.mode} must be set in production (ranges_file, edge_header or upstream_gate)`);
    return unconfiguredGate();
  }
  const mode = JurisdictionGateModeSchema.safeParse(raw);
  if (!mode.success) throw new JurisdictionGateConfigError(`${JURISDICTION_ENV.mode} must be one of ${JURISDICTION_GATE_MODES.join(', ')}`);
  switch (mode.data) {
    case 'fake':
      if (options.production) throw new JurisdictionGateConfigError(`${JURISDICTION_ENV.mode}=fake is refused in production`);
      return fakeGate(options.restricted);
    case 'upstream_gate':
      return upstreamGate();
    case 'edge_header': {
      const countryHeader = env[JURISDICTION_ENV.countryHeader]?.trim();
      if (!countryHeader || !/^[A-Za-z0-9-]{1,64}$/.test(countryHeader)) throw new JurisdictionGateConfigError(`${JURISDICTION_ENV.countryHeader} must name the country header for edge_header`);
      const regionHeader = env[JURISDICTION_ENV.regionHeader]?.trim() || null;
      if (regionHeader && !/^[A-Za-z0-9-]{1,64}$/.test(regionHeader)) throw new JurisdictionGateConfigError(`${JURISDICTION_ENV.regionHeader} must be a header name`);
      return edgeHeaderGate({ restricted: options.restricted, countryHeader, regionHeader });
    }
    case 'ranges_file': {
      const dataDir = env[JURISDICTION_ENV.dataDir]?.trim();
      const path = env[JURISDICTION_ENV.rangesFile]?.trim() || (dataDir ? options.joinPath(dataDir, 'jurisdiction', 'restricted-ranges.json') : '');
      if (!path) throw new JurisdictionGateConfigError(`${JURISDICTION_ENV.rangesFile} (or ${JURISDICTION_ENV.dataDir}) must locate the range table for ranges_file`);
      let parsed: unknown;
      try {
        parsed = options.readJson(path);
      } catch {
        throw new JurisdictionGateConfigError(`the range table named by ${JURISDICTION_ENV.rangesFile} cannot be read`);
      }
      return rangesFileGate(loadRangeTable(parsed, options.restricted));
    }
  }
}

/* ---------- Screening lists, versions, entries and freshness (SANC-002) ---------- */

/*
 * Lists are data ingested by the worker (ADR 014 decisions 10 and 11). Every hub screens against the **baseline** (the
 * OFAC Sanctions List Service exports: the SDN list and the consolidated non-SDN lists), which cannot be paused or
 * deleted; a hub adds lists through country-pack `sanctions` facts that name an adapter. Each list version is
 * immutable once staged and is activated only after it parses and passes the sanity bounds, so a truncated export
 * never "clears" anyone. Freshness ages run per list; a stale or missing baseline makes screening unavailable, and
 * every money and commitment gate then refuses (SANC-004 reads `ScreeningAvailability`).
 *
 * Name keys (`NameKeySchema`) are produced by `@trustwork/compliance` (`packages/compliance/src/names`): lower case,
 * compatibility decomposition with marks removed, punctuation dropped, transliteration into Latin by sourced tables
 * (ICAO Doc 9303 for Cyrillic), distinct tokens sorted and joined by one space.
 */

export const SCREENING_LIST_MODES = ['fake', 'file', 'live'] as const;
export const ScreeningListModeSchema = z.enum(SCREENING_LIST_MODES);
export type ScreeningListMode = z.infer<typeof ScreeningListModeSchema>;

export const SCREENING_LIST_STATUSES = ['active', 'paused'] as const;
export const ScreeningListStatusSchema = z.enum(SCREENING_LIST_STATUSES);
export type ScreeningListStatus = z.infer<typeof ScreeningListStatusSchema>;

export const SCREENING_LIST_VERSION_STATES = ['staged', 'active', 'superseded', 'rejected'] as const;
export const ScreeningListVersionStateSchema = z.enum(SCREENING_LIST_VERSION_STATES);
export type ScreeningListVersionState = z.infer<typeof ScreeningListVersionStateSchema>;

export const SCREENING_ENTRY_TYPES = ['individual', 'entity', 'vessel', 'aircraft'] as const;
export const ScreeningEntryTypeSchema = z.enum(SCREENING_ENTRY_TYPES);
export type ScreeningEntryType = z.infer<typeof ScreeningEntryTypeSchema>;

/** The baseline lists every hub screens against; the migration seeds them and nothing can pause or delete them. */
export const BASELINE_LIST_CODES = ['ofac-sdn', 'ofac-cons'] as const;
/** Engine bound: a baseline list is stale at the latest 14 days after its content was last confirmed. */
export const BASELINE_STALE_AFTER_MAX_SECONDS = 14 * 24 * 3600;

export const ScreeningListCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);
export const ScreeningListAdapterIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/);
/** One normalized name: distinct tokens of letters and digits, sorted, joined by one space. */
export const NameKeySchema = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u)
  .refine((key) => key === key.toLowerCase(), { message: 'a name key is lower case' });
/** The list's own identifier of an entry (OFAC: the `uid`). ASCII only, so byte order and code-unit order agree. */
export const ScreeningEntryUidSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDateSchema = z.iso.date();

export const ScreeningListSchema = z
  .strictObject({
    id: IdSchema,
    /** Null for the baseline lists, which apply to every hub of the node. */
    hubId: IdSchema.nullable(),
    code: ScreeningListCodeSchema,
    name: z.string().min(1).max(200),
    authority: z.string().min(1).max(200),
    sourceUrl: z.url({ protocol: /^https$/ }).max(500),
    adapter: ScreeningListAdapterIdSchema,
    mode: ScreeningListModeSchema,
    /** How often the worker looks for a new version. */
    cadenceSeconds: z.int().min(60),
    /** Past this age since the content was last confirmed the console warns. */
    warnAfterSeconds: z.int().min(60),
    /** Past this age the list is stale; for the baseline at most `BASELINE_STALE_AFTER_MAX_SECONDS`. */
    staleAfterSeconds: z.int().min(60),
    /** A new version whose entry count drops by more than this share of the active one waits for a person. */
    maxDropShare: z.number().gt(0).lt(1),
    /** Fewer entries than this never activate. */
    minEntries: z.int().min(1),
    baseline: z.boolean(),
    status: ScreeningListStatusSchema,
  })
  .refine((l) => l.baseline === (l.hubId === null), { message: 'the baseline lists, and only they, apply to every hub (hubId null)' })
  .refine((l) => !l.baseline || (l.status === 'active' && l.staleAfterSeconds <= BASELINE_STALE_AFTER_MAX_SECONDS), { message: 'a baseline list stays active and is stale after at most 14 days' })
  .refine((l) => l.cadenceSeconds <= l.warnAfterSeconds && l.warnAfterSeconds < l.staleAfterSeconds, { message: 'cadence <= warning age < stale age' });
export type ScreeningList = z.infer<typeof ScreeningListSchema>;

export const ScreeningIdentifierSchema = z.strictObject({
  type: z.string().min(1).max(100),
  number: z.string().min(1).max(200),
  country: z.string().min(1).max(100).nullable(),
});

/** Secondary attributes as published. Shown to reviewers; never used to clear a match automatically. */
export const ScreeningEntryAttributesSchema = z.strictObject({
  /** Aliases as published (a.k.a. and f.k.a. names), for reviewers; their keys are in `nameKeys`. */
  aliases: z.array(z.string().min(1).max(1000)).max(1000).optional(),
  datesOfBirth: z.array(z.string().min(1).max(200)).max(100).optional(),
  placesOfBirth: z.array(z.string().min(1).max(300)).max(100).optional(),
  nationalities: z.array(z.string().min(1).max(200)).max(100).optional(),
  citizenships: z.array(z.string().min(1).max(200)).max(100).optional(),
  identifiers: z.array(ScreeningIdentifierSchema).max(200).optional(),
  addresses: z.array(z.string().min(1).max(1000)).max(200).optional(),
});
export type ScreeningEntryAttributes = z.infer<typeof ScreeningEntryAttributesSchema>;

export const ScreeningListEntrySchema = z.strictObject({
  entryUid: ScreeningEntryUidSchema,
  entryType: ScreeningEntryTypeSchema,
  /** The primary name as published (individuals: given names then surname). */
  primaryName: z.string().min(1).max(1000),
  programs: z.array(z.string().min(1).max(100)).max(100),
  /** Normalized keys of the primary name and every alias, distinct and sorted. */
  nameKeys: z.array(NameKeySchema).min(1).max(1000),
  attributes: ScreeningEntryAttributesSchema,
  /** SHA-256 of the entry's canonical form (`@trustwork/compliance`); the version digest is built from these. */
  entryDigest: Sha256HexSchema,
});
export type ScreeningListEntry = z.infer<typeof ScreeningListEntrySchema>;

export const LIST_SANITY_OUTCOMES = ['pass', 'needs_confirmation', 'rejected'] as const;
export const LIST_SANITY_REASONS = ['declared_count_mismatch', 'below_minimum', 'empty', 'drop_beyond_share'] as const;
export type ListSanityReason = (typeof LIST_SANITY_REASONS)[number];

/** The sanity check recorded beside every staged version. */
export const ListSanitySchema = z.strictObject({
  outcome: z.enum(LIST_SANITY_OUTCOMES),
  reasons: z.array(z.enum(LIST_SANITY_REASONS)),
  /** The count the export itself declares (OFAC `Record_Count`), when it declares one. */
  declaredCount: z.int().min(0).nullable(),
  parsedCount: z.int().min(0),
  /** The entry count of the version active when this one was staged. */
  previousCount: z.int().min(0).nullable(),
  /** Share of the previous count that disappeared (0 when the list grew). */
  dropShare: z.number().min(0).max(1).nullable(),
  maxDropShare: z.number().gt(0).lt(1),
  minEntries: z.int().min(1),
});
export type ListSanity = z.infer<typeof ListSanitySchema>;

/**
 * Sanity bounds before activation (ADR 014 decision 10): an export that disagrees with its own declared count, is
 * empty or has fewer entries than the list's minimum is rejected; one whose count drops by more than the configured
 * share of the active version waits for a person's confirmation. Pure, so the worker and the tests share it.
 */
export function checkListSanity(input: { parsedCount: number; declaredCount: number | null; previousCount: number | null; maxDropShare: number; minEntries: number }): ListSanity {
  const reasons: ListSanityReason[] = [];
  if (input.declaredCount !== null && input.declaredCount !== input.parsedCount) reasons.push('declared_count_mismatch');
  if (input.parsedCount === 0) reasons.push('empty');
  else if (input.parsedCount < input.minEntries) reasons.push('below_minimum');
  const dropShare = input.previousCount === null || input.previousCount === 0 ? null : Math.max(0, (input.previousCount - input.parsedCount) / input.previousCount);
  const rejected = reasons.length > 0;
  if (!rejected && dropShare !== null && dropShare > input.maxDropShare) reasons.push('drop_beyond_share');
  return {
    outcome: rejected ? 'rejected' : reasons.length ? 'needs_confirmation' : 'pass',
    reasons,
    declaredCount: input.declaredCount,
    parsedCount: input.parsedCount,
    previousCount: input.previousCount,
    dropShare: dropShare === null ? null : Math.round(dropShare * 10_000) / 10_000,
    maxDropShare: input.maxDropShare,
    minEntries: input.minEntries,
  };
}

export const ScreeningListVersionSchema = z
  .strictObject({
    id: IdSchema,
    listId: IdSchema,
    version: z.int().min(1),
    /** The publication date the export states, when it states one. */
    publishedOn: IsoDateSchema.nullable(),
    /** When the content was obtained from its source (download time, or the file's modification time). */
    fetchedAt: TimestampSchema,
    mode: ScreeningListModeSchema,
    /** SHA-256 of the export's bytes. */
    sourceDigest: Sha256HexSchema,
    entryCount: z.int().min(0),
    /** SHA-256 of the entry digests in entry-uid order (`@trustwork/compliance` `listDigest`, rechecked by the database). */
    digest: Sha256HexSchema,
    state: ScreeningListVersionStateSchema,
    sanity: ListSanitySchema,
    stagedAt: TimestampSchema,
    activatedAt: TimestampSchema.nullable(),
    /** The person who confirmed a drop beyond the share; null for an automatic activation. */
    activatedBy: IdSchema.nullable(),
    rejectedReason: z.string().regex(/^[a-z_]{1,60}$/).nullable(),
  })
  .refine((v) => (v.state === 'active' || v.state === 'superseded') === (v.activatedAt !== null), { message: 'activated exactly when active or superseded' })
  .refine((v) => (v.state === 'rejected') === (v.rejectedReason !== null), { message: 'a rejected version names its reason' });
export type ScreeningListVersion = z.infer<typeof ScreeningListVersionSchema>;

/** Outbox event `screening.list_version_activated` (identifiers and counts only; SANC-005 re-screens on it). */
export const SCREENING_LIST_VERSION_ACTIVATED = 'screening.list_version_activated';
export const ScreeningListVersionActivatedEventSchema = z.strictObject({
  listId: IdSchema,
  listCode: ScreeningListCodeSchema,
  hubId: IdSchema.nullable(),
  baseline: z.boolean(),
  versionId: IdSchema,
  version: z.int().min(1),
  previousVersionId: IdSchema.nullable(),
  entryCount: z.int().min(0),
  digest: Sha256HexSchema,
  publishedOn: IsoDateSchema.nullable(),
  /** Set when a person confirmed a drop beyond the share. */
  confirmedBy: IdSchema.nullable(),
});
export type ScreeningListVersionActivatedEvent = z.infer<typeof ScreeningListVersionActivatedEventSchema>;

/** Outcome of one ingestion attempt, kept on the list for the console and metrics. */
export const LIST_INGEST_OUTCOMES = ['activated', 'unchanged', 'needs_confirmation', 'rejected', 'malformed', 'source_missing', 'refused', 'failed'] as const;
export const ListIngestOutcomeSchema = z.enum(LIST_INGEST_OUTCOMES);
export type ListIngestOutcome = z.infer<typeof ListIngestOutcomeSchema>;

/* ---------- Freshness ---------- */

/**
 * `fresh` and `warning` lists are usable; `stale` (older than its stale age), `missing` (no active version) and
 * `paused` (additional lists only) are not. Ages count from when the active content was last confirmed from its
 * source, never from the export's publication date (OFAC publishes irregularly).
 */
export const SCREENING_FRESHNESS_STATES = ['fresh', 'warning', 'stale', 'missing', 'paused'] as const;
export const ScreeningFreshnessStateSchema = z.enum(SCREENING_FRESHNESS_STATES);
export type ScreeningFreshnessState = z.infer<typeof ScreeningFreshnessStateSchema>;

export const ScreeningListFreshnessSchema = z.strictObject({
  listId: IdSchema,
  hubId: IdSchema.nullable(),
  code: ScreeningListCodeSchema,
  baseline: z.boolean(),
  status: ScreeningListStatusSchema,
  state: ScreeningFreshnessStateSchema,
  activeVersionId: IdSchema.nullable(),
  publishedOn: IsoDateSchema.nullable(),
  lastCheckedAt: TimestampSchema.nullable(),
  ageSeconds: z.int().min(0).nullable(),
  warnAfterSeconds: z.int().min(60),
  staleAfterSeconds: z.int().min(60),
});
export type ScreeningListFreshness = z.infer<typeof ScreeningListFreshnessSchema>;

export const SCREENING_UNAVAILABLE_REASONS = ['no_baseline', 'baseline_missing', 'baseline_stale'] as const;
export type ScreeningUnavailableReason = (typeof SCREENING_UNAVAILABLE_REASONS)[number];

/** What the money and commitment gates read (SANC-004): screening is available only with every baseline list usable. */
export const ScreeningAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  checkedAt: TimestampSchema,
  reasons: z.array(z.strictObject({ reason: z.enum(SCREENING_UNAVAILABLE_REASONS), code: ScreeningListCodeSchema.nullable() })),
  lists: z.array(ScreeningListFreshnessSchema),
});
export type ScreeningAvailability = z.infer<typeof ScreeningAvailabilitySchema>;

/** The freshness state of one list at `now`. The database function `screening_list_freshness` implements the same rule. */
export function listFreshnessState(
  list: { status: ScreeningListStatus; baseline: boolean; hasActiveVersion: boolean; lastCheckedAt: Date | null; warnAfterSeconds: number; staleAfterSeconds: number },
  now: Date,
): ScreeningFreshnessState {
  if (list.status === 'paused' && !list.baseline) return 'paused';
  if (!list.hasActiveVersion || list.lastCheckedAt === null) return 'missing';
  const age = Math.max(0, (now.getTime() - list.lastCheckedAt.getTime()) / 1000);
  const staleAfter = list.baseline ? Math.min(list.staleAfterSeconds, BASELINE_STALE_AFTER_MAX_SECONDS) : list.staleAfterSeconds;
  if (age > staleAfter) return 'stale';
  if (age > list.warnAfterSeconds) return 'warning';
  return 'fresh';
}

/** Screening is available when at least one baseline list exists and every baseline list is `fresh` or `warning`. */
export function screeningAvailability(lists: readonly ScreeningListFreshness[], checkedAt: Date): ScreeningAvailability {
  const reasons: ScreeningAvailability['reasons'] = [];
  const baseline = lists.filter((l) => l.baseline);
  if (baseline.length === 0) reasons.push({ reason: 'no_baseline', code: null });
  for (const list of baseline) {
    if (list.state === 'missing' || list.state === 'paused') reasons.push({ reason: 'baseline_missing', code: list.code });
    else if (list.state === 'stale') reasons.push({ reason: 'baseline_stale', code: list.code });
  }
  return { available: reasons.length === 0, checkedAt: checkedAt.toISOString(), reasons, lists: [...lists] };
}

/** Staff command (console): pause or resume an additional list. The baseline lists refuse it (`screening.baseline_list`). */
export const SetScreeningListStatusCommandSchema = z.strictObject({ status: ScreeningListStatusSchema, reason: z.string().trim().min(1).max(500) });
export type SetScreeningListStatusCommand = z.infer<typeof SetScreeningListStatusCommandSchema>;

/** Staff command (console): activate a staged version whose entry count dropped beyond the share, after checking it. */
export const ConfirmScreeningListVersionCommandSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
export type ConfirmScreeningListVersionCommand = z.infer<typeof ConfirmScreeningListVersionCommandSchema>;

/* ---------- Screening: subjects, results, matches, decisions and review cases (SANC-003) ---------- */

/**
 * The screening engine (SANC-003, ADR 014 decisions 11 to 17; data model section 24a).
 *
 * - **Subjects** are persons (screened against individual entries) and companies (against entity entries; vessels and
 *   aircraft only when a hub enables them). Their names come from the database, never from a caller.
 * - **Outcomes are honest**: `clear` (screened against named active list versions, no unresolved possible match),
 *   `possible_match`, `insufficient_name` (a one-token name is never reported as clear) or `not_screened` (no active
 *   version, stale baseline, adapter error). No score ever clears.
 * - **Money is held** (`moneyHeld`) unless the latest result is `clear` against the active baseline versions, or every
 *   possible match was decided `not_same_person`, and the baseline is fresh. A possible match never blocks sign-in; a
 *   confirmed match suspends the subject.
 * - **Review cases** with separation of duties: confirmed by one compliance reviewer; "not the same person" and the
 *   reversal of a confirmation need a second person (`SCREENING_SECOND_PERSON_ACTIONS`); an appeal is decided by a
 *   reviewer other than the one who confirmed. Nobody decides about themselves, a company they belong to, or a party
 *   they declared a conflict with.
 * - **Nothing here is public**: screening records are staff-only (`SC`); the subject sees status words only
 *   (`OwnComplianceStatusSchema`); a counterparty learns only that the other side cannot transact now (SANC-004).
 *   No screening field may appear in a public, counterparty, search, federation or agent projection
 *   (`SCREENING_PRIVATE_FIELDS`, checked by tests/screening/projections.test.ts).
 */

/** A suspended person reaches only their own compliance status, the appeal and sign-out (HTTP 403). */
export const SCREENING_ERROR_CODES = ['auth.compliance_suspended'] as const;
export const SCREENING_ERROR_STATUS: Readonly<Record<(typeof SCREENING_ERROR_CODES)[number], number>> = { 'auth.compliance_suspended': 403 };

export const SCREENING_SUBJECT_KINDS = ['person', 'company'] as const;
export const ScreeningSubjectRefSchema = z.strictObject({ kind: z.enum(SCREENING_SUBJECT_KINDS), id: IdSchema });
export type ScreeningSubjectRef = z.infer<typeof ScreeningSubjectRefSchema>;

export const SCREENING_OUTCOMES = ['clear', 'possible_match', 'insufficient_name', 'not_screened'] as const;
export const ScreeningOutcomeSchema = z.enum(SCREENING_OUTCOMES);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcomeSchema>;

export const SCREENING_TRIGGERS = ['registration', 'sign_in', 'name_change', 'company_change', 'claim', 'seller', 'counterparty', 'payee', 'organizer', 'peer', 'operator', 'list_update', 'scheduled'] as const;
export const ScreeningTriggerSchema = z.enum(SCREENING_TRIGGERS);
export type ScreeningTrigger = z.infer<typeof ScreeningTriggerSchema>;

export const SCREENING_MATCH_RULES = ['engine', 'fuzzy'] as const;
export const ScreeningMatchRuleSchema = z.enum(SCREENING_MATCH_RULES);
export type ScreeningMatchRule = z.infer<typeof ScreeningMatchRuleSchema>;

/** Review states of one (subject, list, entry) pair. Only the screening decisions move them. */
export const SCREENING_MATCH_STATES = ['open', 'pending_second', 'not_same_person', 'confirmed', 'appeal', 'pending_reversal'] as const;
export const ScreeningMatchStateSchema = z.enum(SCREENING_MATCH_STATES);
export type ScreeningMatchState = z.infer<typeof ScreeningMatchStateSchema>;
/** States that keep money held. `not_same_person` is the only resolved state. */
export const UNRESOLVED_MATCH_STATES: readonly ScreeningMatchState[] = ['open', 'pending_second', 'confirmed', 'appeal', 'pending_reversal'];
/** States that suspend the subject (a confirmed match, also while an appeal or a reversal is pending). */
export const SUSPENDING_MATCH_STATES: readonly ScreeningMatchState[] = ['confirmed', 'appeal', 'pending_reversal'];
/** States a staff review queue shows as waiting for a reviewer. */
export const QUEUED_MATCH_STATES: readonly ScreeningMatchState[] = ['open', 'pending_second', 'appeal', 'pending_reversal'];

export const SCREENING_DECISION_KINDS = ['confirm', 'propose_not_same_person', 'approve', 'reject', 'appeal', 'uphold', 'propose_reversal'] as const;
export const ScreeningDecisionKindSchema = z.enum(SCREENING_DECISION_KINDS);
export type ScreeningDecisionKind = z.infer<typeof ScreeningDecisionKindSchema>;

/** What a reviewer relied on. Secondary attributes are shown to reviewers and never used to clear automatically. */
export const SCREENING_EVIDENCE_CATEGORIES = ['identity_document', 'date_of_birth', 'nationality', 'address', 'registration_identifier', 'other'] as const;
export const ScreeningEvidenceCategorySchema = z.enum(SCREENING_EVIDENCE_CATEGORIES);
export type ScreeningEvidenceCategory = z.infer<typeof ScreeningEvidenceCategorySchema>;

/**
 * Second-person actions of the screening engine, registered in the data layer's approval vocabulary
 * (`trustwork.admin_second_person_actions()`) with the data integrator's agreement. They extend the frozen console
 * vocabulary (`CONSOLE_SECOND_PERSON_ACTIONS`, HUBC-000) only in the database: they are requested, approved and
 * consumed through the screening commands, which apply the screening guards, never through the generic approval routes.
 */
export const SCREENING_SECOND_PERSON_ACTIONS = ['screening.clear_match', 'screening.reverse_confirmation'] as const;
export type ScreeningSecondPersonAction = (typeof SCREENING_SECOND_PERSON_ACTIONS)[number];

/**
 * The fuzzy layer (ADR 014 decision 11): token similarity (Jaro-Winkler) with a threshold inside engine bounds. It only
 * adds possible matches; it is off unless a hub sets a threshold (the owner has not chosen one, ADR 014 open question 3).
 */
export const FUZZY_THRESHOLD_BOUNDS = { min: 0.85, max: 0.99 } as const;
export const FuzzyThresholdSchema = z.number().min(FUZZY_THRESHOLD_BOUNDS.min).max(FUZZY_THRESHOLD_BOUNDS.max);

/** Review service level (hub setting, engine bounds one to five business days; default one). */
export const REVIEW_SERVICE_LEVEL_BOUNDS = { min: 1, max: 5, default: 1 } as const;
export const ReviewServiceLevelSchema = z.int().min(REVIEW_SERVICE_LEVEL_BOUNDS.min).max(REVIEW_SERVICE_LEVEL_BOUNDS.max);

/**
 * When a queue item opened at `openedAt` becomes late: after `businessDays` whole business days (Monday to Friday,
 * UTC). Hub holidays are not counted yet (they come with the hub calendar).
 */
export function reviewDueAt(openedAt: Date, businessDays: number): Date {
  const days = ReviewServiceLevelSchema.parse(businessDays);
  const due = new Date(openedAt.getTime());
  let added = 0;
  while (added < days) {
    due.setUTCDate(due.getUTCDate() + 1);
    const weekday = due.getUTCDay();
    if (weekday !== 0 && weekday !== 6) added += 1;
  }
  return due;
}

/** Ten business days for the operator's blocked-property or rejected-transaction report (US: 31 CFR 501.603, 501.604). */
export const REPORT_DRAFT_BUSINESS_DAYS = 10;

/** Why the effective state holds money. Order is not meaningful. */
export const SCREENING_HOLD_REASONS = ['not_screened', 'insufficient_name', 'review_pending', 'confirmed', 'lists_unavailable', 'rescreen_due'] as const;
export const ScreeningHoldReasonSchema = z.enum(SCREENING_HOLD_REASONS);
export type ScreeningHoldReason = z.infer<typeof ScreeningHoldReasonSchema>;

/**
 * The internal `screeningState(subject)` port for the gates (SANC-004). Never shown to anyone but the gate's own code:
 * a counterparty is told only that the other side cannot transact now. A gate that cannot read it refuses.
 */
export const ScreeningStateSchema = z
  .strictObject({
    subject: ScreeningSubjectRefSchema,
    moneyHeld: z.boolean(),
    suspended: z.boolean(),
    reasons: z.array(ScreeningHoldReasonSchema),
    lastOutcome: ScreeningOutcomeSchema.nullable(),
    lastScreenedAt: TimestampSchema.nullable(),
    checkedAt: TimestampSchema,
  })
  .refine((s) => s.moneyHeld === s.reasons.length > 0, { message: 'money is held exactly when there is a reason' })
  .refine((s) => !s.suspended || s.reasons.includes('confirmed'), { message: 'a suspension comes from a confirmed match' });
export type ScreeningState = z.infer<typeof ScreeningStateSchema>;

/** Status words a subject sees about themselves (`core.compliance_status`); never a list, an entry or a reviewer. */
export const OWN_COMPLIANCE_STATUSES = ['clear', 'checking', 'name_needed', 'review', 'suspended', 'appeal_pending'] as const;
export const OwnComplianceStatusSchema = z.strictObject({
  subject: ScreeningSubjectRefSchema,
  status: z.enum(OWN_COMPLIANCE_STATUSES),
  /** Payments, payouts, sales and commercial commitments are paused. */
  paymentsPaused: z.boolean(),
  /** A confirmed decision can be appealed (once per decision; a reviewer other than the decider answers). */
  canAppeal: z.boolean(),
  /** Locale keys of the words to show (namespace `screening`). */
  messageKeys: z.array(z.string().regex(/^screening\.[a-zA-Z.]+$/)).min(1),
});
export type OwnComplianceStatus = z.infer<typeof OwnComplianceStatusSchema>;

/** The status words of an effective state, for the subject (pure; the API and the tests share it). */
export function ownComplianceStatus(state: ScreeningState, appealable: boolean): OwnComplianceStatus {
  const r = new Set(state.reasons);
  let status: OwnComplianceStatus['status'];
  if (!state.moneyHeld) status = 'clear';
  else if (state.suspended) status = appealable ? 'suspended' : 'appeal_pending';
  else if (r.has('review_pending')) status = 'review';
  else if (r.has('insufficient_name')) status = 'name_needed';
  else status = 'checking';
  const keys: Record<OwnComplianceStatus['status'], string[]> = {
    clear: ['screening.status.clear'],
    checking: ['screening.status.checking', 'screening.paymentsPaused'],
    name_needed: ['screening.status.nameNeeded', 'screening.paymentsPaused'],
    review: ['screening.status.review', 'screening.paymentsPaused', 'screening.contact'],
    suspended: ['screening.status.suspended', 'screening.contact', 'screening.appeal.available'],
    appeal_pending: ['screening.status.appealPending', 'screening.contact'],
  };
  return { subject: state.subject, status, paymentsPaused: state.moneyHeld, canAppeal: status === 'suspended', messageKeys: keys[status] };
}

/** Subject command (`core.appeal_compliance_decision`, fresh step-up): appeal a confirmed decision. */
export const AppealComplianceDecisionCommandSchema = z.strictObject({
  /** Null for the caller's own account; a company the caller administers otherwise. */
  companyId: IdSchema.nullable(),
  reason: z.string().trim().min(1).max(2000),
});
export type AppealComplianceDecisionCommand = z.infer<typeof AppealComplianceDecisionCommandSchema>;

const ReasonSchema = z.string().trim().min(1).max(500);
/** Staff commands on one match (compliance officer of the node, elevated session). */
export const ConfirmScreeningMatchCommandSchema = z.strictObject({ reason: ReasonSchema, evidence: ScreeningEvidenceCategorySchema });
export const ProposeNotSamePersonCommandSchema = z.strictObject({ reason: ReasonSchema, evidence: ScreeningEvidenceCategorySchema });
/** The second person restates the digest of the proposal they reviewed (the `pendingApproval.actionDigest` of the match). */
export const DecideScreeningProposalCommandSchema = z.strictObject({ decision: z.enum(['approve', 'reject']), actionDigest: Sha256HexSchema, reason: ReasonSchema });
export const DecideScreeningAppealCommandSchema = z.strictObject({ decision: z.enum(['uphold', 'propose_reversal']), reason: ReasonSchema, evidence: ScreeningEvidenceCategorySchema });
export type ConfirmScreeningMatchCommand = z.infer<typeof ConfirmScreeningMatchCommandSchema>;
export type ProposeNotSamePersonCommand = z.infer<typeof ProposeNotSamePersonCommandSchema>;
export type DecideScreeningProposalCommand = z.infer<typeof DecideScreeningProposalCommandSchema>;
export type DecideScreeningAppealCommand = z.infer<typeof DecideScreeningAppealCommandSchema>;

/** A match as compliance staff see it under the case (`SC`): the entry and the screened name side by side. */
export const ScreeningMatchSchema = z.strictObject({
  id: IdSchema,
  subject: ScreeningSubjectRefSchema,
  listCode: ScreeningListCodeSchema,
  listVersionId: IdSchema,
  entryUid: ScreeningEntryUidSchema,
  entryType: ScreeningEntryTypeSchema,
  entryName: z.string().min(1).max(1000),
  programs: z.array(z.string().min(1).max(100)).max(100),
  matchedKey: NameKeySchema,
  screenedName: z.string().min(1).max(1000),
  rule: ScreeningMatchRuleSchema,
  /** The fuzzy layer's similarity; null for the engine rule. Shown to reviewers, never used to decide. */
  score: z.number().min(0).max(1).nullable(),
  state: ScreeningMatchStateSchema,
  openedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  revision: z.int().min(1),
  /** The open second-person request of a proposal (approve with this digest), when one waits. */
  pendingApproval: z.strictObject({ id: IdSchema, action: z.enum(SCREENING_SECOND_PERSON_ACTIONS), actionDigest: Sha256HexSchema, requestedBy: IdSchema, requestExpiresAt: TimestampSchema }).nullable(),
});
export type ScreeningMatchView = z.infer<typeof ScreeningMatchSchema>;

/** One review queue item per subject with matches waiting for a reviewer; names nobody in notifications. */
export const ScreeningQueueItemSchema = z.strictObject({
  subjectStateId: IdSchema,
  subject: ScreeningSubjectRefSchema,
  openedAt: TimestampSchema,
  dueAt: TimestampSchema,
  late: z.boolean(),
  waiting: z.int().min(1),
  states: z.array(ScreeningMatchStateSchema).min(1),
});
export type ScreeningQueueItem = z.infer<typeof ScreeningQueueItemSchema>;

/** Outbox events of the screening engine. Payloads carry identifiers only: never a name, a list, an entry or a reviewer. */
export const SCREENING_EVENTS = {
  /** Compliance staff notification: a subject needs a reviewer. Cannot be muted; names nobody (the queue item only). */
  reviewRequested: 'screening.review_requested',
  /** The subject's effective standing changed (their notice, SANC-007; gates). */
  subjectStatusChanged: 'screening.subject_status_changed',
  /** A confirmed match prepared a report draft for the operator. */
  reportDraftPrepared: 'screening.report_draft_prepared',
} as const;
export const ScreeningReviewRequestedEventSchema = z.strictObject({ queueItemId: IdSchema, mutable: z.literal(false) });
export const ScreeningSubjectStatusChangedEventSchema = z.strictObject({ subject: ScreeningSubjectRefSchema, moneyHeld: z.boolean(), suspended: z.boolean() });

/**
 * Events that start a screening (ADR 014 decision 12). `identity.name_changed` and `company.renamed` are emitted by the
 * database whenever a display name changes, whatever path changed it, so no rename can skip screening;
 * `company.ownership_declaration_changed` is consumed here and emitted once the ownership declaration is persisted.
 */
export const SCREENING_TRIGGER_EVENTS = {
  'identity.person_registered': 'registration',
  'identity.session_started': 'sign_in',
  'identity.name_changed': 'name_change',
  'company.created': 'company_change',
  'company.renamed': 'company_change',
  'company.ownership_declaration_changed': 'company_change',
} as const satisfies Record<string, ScreeningTrigger>;
export type ScreeningTriggerEvent = keyof typeof SCREENING_TRIGGER_EVENTS;

/**
 * Field names that belong to screening and must never appear in a public, counterparty, search, federation or agent
 * projection (ADR 014 decision 16). The projection tests walk every such schema and every public database read.
 */
export const SCREENING_PRIVATE_FIELDS = [
  'moneyHeld', 'money_held', 'screeningState', 'screening_state', 'screeningOutcome', 'complianceStatus', 'compliance_status', 'possibleMatch', 'possible_match',
  'matchedKey', 'matched_key', 'screenedName', 'screened_name', 'entryUid', 'entry_uid', 'listCode', 'list_code', 'sanctionsMatch', 'screenedVersions', 'screened_versions',
  'namesDigest', 'names_digest', 'suspendedForCompliance',
] as const;

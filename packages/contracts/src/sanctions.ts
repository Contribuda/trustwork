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

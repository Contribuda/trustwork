#!/usr/bin/env node
/**
 * Reduce a city-level IP geolocation CSV to the restricted places only (SANC-001, ADR 014 decision 7), writing the
 * range table the `ranges_file` jurisdiction gate loads (format `trustwork-restricted-ranges-1`, see
 * packages/contracts/src/sanctions.ts).
 *
 *   node packages/compliance/bin/restricted-ranges.mjs --input dbip-city-lite-2026-10.csv --month 2026-10 \
 *     --output <dataDir>/jurisdiction/restricted-ranges.json
 *
 * The engine ships no dataset and this script makes no network call: the operator downloads the CSV under its own
 * licence. The recommended source is DB-IP "IP to City Lite" (CC BY 4.0, no account or key; columns ip_start, ip_end,
 * continent, country, stateprov, city, latitude, longitude); its attribution is written into the table and shown on the
 * refusal page. Another dataset works with --dataset, --attribution and --columns start,end,country,region (0-based).
 *
 * Countries restricted as a whole keep every range; a country restricted only in some subdivisions (Ukraine) keeps the
 * ranges whose region name maps to a listed subdivision (--region-map a JSON file of {"UA": {"crimea": "UA-43"}}
 * overrides the defaults below; names are compared lower-case, without marks, by containment). The restricted list is
 * read from packages/country-packs/packs/restricted.json (or --restricted <file>). Exit codes: 0 written, 1 failure,
 * 2 usage.
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_REGION_NAMES = {
  UA: [
    ['sevastopol', 'UA-40'],
    ['crimea', 'UA-43'],
    ['krym', 'UA-43'],
    ['donetsk', 'UA-14'],
    ['luhansk', 'UA-09'],
    ['lugansk', 'UA-09'],
  ],
};

function usage(message) {
  if (message) console.error(message);
  console.error('usage: restricted-ranges.mjs --input <csv> --month YYYY-MM --output <json> [--dataset dbip-city-lite] [--attribution text] [--columns 0,1,3,4] [--region-map file] [--restricted file]');
  process.exit(2);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) usage(`bad argument ${key ?? ''}`);
    args[key.slice(2)] = value;
  }
  return args;
}

/** One CSV line into fields (RFC 4180 quoting). */
export function csvFields(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

export function v4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

export function v6(text) {
  let rest = text;
  const last = rest.lastIndexOf(':');
  if (last < 0) return null;
  if (rest.includes('.', last)) {
    const four = v4(rest.slice(last + 1));
    if (four === null) return null;
    rest = `${rest.slice(0, last + 1)}${Math.floor(four / 65536).toString(16)}:${(four % 65536).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const read = (h) => (h === '' ? [] : h.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

const fold = (s) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

/** Reduce rows to sorted, merged ranges per family. */
export function reduceRows(rows, { restricted, regionNames }) {
  const listed = new Set(restricted);
  const whole = new Set(restricted.filter((c) => c.length === 2));
  const partial = new Set(restricted.filter((c) => c.includes('-')).map((c) => c.slice(0, 2)));
  const ranges = { 4: [], 6: [] };
  for (const { start, end, country, region } of rows) {
    const cc = (country ?? '').trim().toUpperCase();
    let code = null;
    if (whole.has(cc)) code = cc;
    else if (partial.has(cc) && region) {
      const name = fold(region);
      for (const [needle, candidate] of regionNames[cc] ?? []) if (name.includes(needle) && listed.has(candidate)) { code = candidate; break; }
    }
    if (!code) continue;
    const s4 = v4(start);
    const e4 = v4(end);
    if (s4 !== null && e4 !== null) { ranges[4].push([s4, e4, code]); continue; }
    const s6 = v6(start);
    const e6 = v6(end);
    if (s6 !== null && e6 !== null) ranges[6].push([s6, e6, code]);
  }
  const merge = (list, one) => {
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = [];
    for (const r of list) {
      const prev = out[out.length - 1];
      if (prev && prev[2] === r[2] && r[0] <= prev[1] + one) { if (r[1] > prev[1]) prev[1] = r[1]; continue; }
      if (prev && r[0] <= prev[1]) throw new Error('overlapping ranges for different places in the input');
      out.push([...r]);
    }
    return out;
  };
  return { v4: merge(ranges[4], 1), v6: merge(ranges[6], 1n) };
}

export function buildTable({ v4: four, v6: six }, { dataset, month, attribution }) {
  const codes = [...new Set([...four, ...six].map((r) => r[2]))].sort();
  return {
    format: 'trustwork-restricted-ranges-1',
    dataset,
    month,
    attribution,
    codes,
    v4: four.map(([s, e, c]) => [s, e, codes.indexOf(c)]),
    v6: six.map(([s, e, c]) => [s.toString(16), e.toString(16), codes.indexOf(c)]),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output || !args.month) usage('--input, --month and --output are required');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) usage('--month must be YYYY-MM');
  const dataset = args.dataset ?? 'dbip-city-lite';
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(dataset)) usage('--dataset must be lower-case letters, digits and dashes');
  const attribution = args.attribution ?? (dataset === 'dbip-city-lite' ? 'IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0' : '');
  const [cStart, cEnd, cCountry, cRegion] = (args.columns ?? '0,1,3,4').split(',').map(Number);
  const restrictedFile = args.restricted ?? resolve(dirname(new URL(import.meta.url).pathname), '../../country-packs/packs/restricted.json');
  const restricted = JSON.parse(readFileSync(restrictedFile, 'utf8')).places.map((p) => p.code);
  const regionNames = args['region-map']
    ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(args['region-map'], 'utf8'))).map(([cc, map]) => [cc, Object.entries(map).map(([k, v]) => [fold(k), v])]))
    : DEFAULT_REGION_NAMES;
  const rows = [];
  const lines = createInterface({ input: createReadStream(args.input, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const f = csvFields(line);
    rows.push({ start: f[cStart] ?? '', end: f[cEnd] ?? '', country: f[cCountry] ?? '', region: cRegion >= 0 ? (f[cRegion] ?? '') : '' });
  }
  const table = buildTable(reduceRows(rows, { restricted, regionNames }), { dataset, month: args.month, attribution });
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(table)}\n`);
  console.log(`Wrote ${table.v4.length} IPv4 and ${table.v6.length} IPv6 ranges for ${table.codes.length} restricted places (${dataset}-${args.month}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}

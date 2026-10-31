import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JURISDICTION_ENV, RANGE_TABLE_FORMAT, rangeTableAgeInMonths } from '../../../../packages/contracts/src/sanctions.js';

/**
 * The age of the geolocation range table the gate reads (ADR 014 decision 7): a table older than two months raises an
 * operations warning so the operator regenerates it from a fresh dataset. Only the header (format, dataset, month) is
 * read; the ranges themselves are the gate's business. Other gate modes have no table to age.
 */
export type RangeTableAge =
  | { readonly state: 'not_applicable'; readonly mode: string }
  | { readonly state: 'unreadable'; readonly reason: string }
  | { readonly state: 'current' | 'overdue'; readonly dataset: string; readonly month: string; readonly ageMonths: number };

/** Past this many whole months the table is overdue. */
export const RANGE_TABLE_MAX_AGE_MONTHS = 2;

export function rangeTableAge(env: Readonly<Record<string, string | undefined>>, now: Date, readJson: (path: string) => unknown = (path) => JSON.parse(readFileSync(path, 'utf8'))): RangeTableAge {
  const mode = env[JURISDICTION_ENV.mode]?.trim() || 'unconfigured';
  if (mode !== 'ranges_file') return { state: 'not_applicable', mode };
  const dataDir = env[JURISDICTION_ENV.dataDir]?.trim();
  const path = env[JURISDICTION_ENV.rangesFile]?.trim() || (dataDir ? join(dataDir, 'jurisdiction', 'restricted-ranges.json') : '');
  if (!path) return { state: 'unreadable', reason: 'no_path' };
  let header: unknown;
  try {
    header = readJson(path);
  } catch {
    return { state: 'unreadable', reason: 'unreadable' };
  }
  const file = header as { format?: unknown; dataset?: unknown; month?: unknown } | null;
  if (!file || file.format !== RANGE_TABLE_FORMAT || typeof file.dataset !== 'string' || typeof file.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(file.month)) {
    return { state: 'unreadable', reason: 'not_a_range_table' };
  }
  const ageMonths = Math.max(0, rangeTableAgeInMonths(file.month, now));
  return { state: ageMonths > RANGE_TABLE_MAX_AGE_MONTHS ? 'overdue' : 'current', dataset: file.dataset, month: file.month, ageMonths };
}

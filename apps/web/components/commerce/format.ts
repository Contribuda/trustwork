import { UNIT_CATALOGUE, getUnit, type Money, type Quantity } from '@trustwork/contracts/client';
import { formatMoney, formatNumber, shortDate } from '@/app/_lib/i18n';

/** Presentation helpers of the commerce pages (WEB-002): display only; conversions of typed values are in `amounts.ts`. */
export { fromMinor, toMinor } from './amounts';

export function money(value: Money | null | undefined): string {
  return value ? formatMoney(value.minorUnits, value.currency) : '—';
}

export function unitSymbol(code: string): string {
  return getUnit(code)?.symbol ?? code;
}

export function quantity(value: Quantity | null | undefined): string {
  if (!value) return '—';
  const n = Number(value.value);
  return `${Number.isFinite(n) ? formatNumber(n) : value.value} ${unitSymbol(value.unit)}`;
}

/** Unit choices for line editors: the measurement-unit catalogue's international symbols (O11). */
export const UNIT_OPTIONS: readonly { id: string; label: string }[] = UNIT_CATALOGUE.map((u) => ({ id: u.code, label: u.symbol === u.code ? u.symbol : `${u.symbol} (${u.code})` }));

/** First twelve hex digits of a digest: enough to compare two snapshots by eye; the full value is in the title. */
export function shortDigest(digest: { value: string } | null | undefined): string {
  return digest ? digest.value.slice(0, 12) : '—';
}

export function businessDate(value: { date: string } | null | undefined): string {
  return value ? shortDate(value.date) : '—';
}


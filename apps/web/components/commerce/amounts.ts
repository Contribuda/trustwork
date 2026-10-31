import { currencyMeta, packs } from '@trustwork/country-packs';

/**
 * Exact conversions between what a person types and contract values (WEB-002), shared by the server pages and the
 * one client form. Money stays in integer minor units; decimals are parsed as strings, never as floating point.
 */

/** Minor-unit digits of a currency: the country pack's statement first (as `formatMoney` does), else `Intl`. */
export function minorDigits(currency: string): number {
  return packs().find((p) => p.currency.code === currency)?.currency.minorUnitDigits ?? currencyMeta(currency).minorUnitDigits;
}

/** `12.5` in USD -> `1250`; null when the text is not a non-negative decimal with at most the currency's digits. */
export function toMinor(text: string, currency: string): string | null {
  const value = text.trim().replace(',', '.');
  const digits = minorDigits(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return null;
  return BigInt(`${match[1]}${fraction.padEnd(digits, '0')}`).toString();
}

/** `1250` in USD -> `12.50` (an input value, not display). */
export function fromMinor(minor: string, currency: string): string {
  const digits = minorDigits(currency);
  const negative = minor.startsWith('-');
  const raw = (negative ? minor.slice(1) : minor).padStart(digits + 1, '0');
  const whole = raw.slice(0, raw.length - digits);
  return `${negative ? '-' : ''}${whole}${digits ? `.${raw.slice(raw.length - digits)}` : ''}`;
}

const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
/** A typed quantity as the contract's exact decimal string, or null (empty, zero or not a decimal). */
export function quantityValue(text: string): string | null {
  const value = text.trim().replace(',', '.');
  return DECIMAL.test(value) && !/^0+(\.0+)?$/.test(value) ? value : null;
}

/** A typed percentage (`8.875`), or null. */
export function rateValue(text: string): string | null {
  const value = text.trim().replace(',', '.');
  return DECIMAL.test(value) ? value : null;
}

/** The browser's IANA time zone for business dates typed in a form (UTC when unknown). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `datetime-local` value -> RFC 3339 UTC timestamp, or null. */
export function localToTimestamp(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** RFC 3339 timestamp -> `datetime-local` value in the server's zone (the browser corrects nothing; it is a default). */
export function timestampToLocal(value: string | null | undefined): string {
  if (!value) return '';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 16);
}

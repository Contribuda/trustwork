import { currencyMeta } from '@trustwork/country-packs/client';

/** Preserve every minor unit, including values above Number.MAX_SAFE_INTEGER. */
export function exactPrice(minor: string, currency: string, locale: string): string {
  const digits = currencyMeta(currency).minorUnitDigits;
  const scale = 10n ** BigInt(digits);
  const amount = BigInt(minor);
  const format = new Intl.NumberFormat(locale, {
    style: 'currency', currency, currencyDisplay: 'code',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  const fraction = new Intl.NumberFormat(locale, { useGrouping: false, minimumIntegerDigits: Math.max(1, digits) }).format(amount % scale);
  return format.formatToParts(amount / scale).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}

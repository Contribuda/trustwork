import { intlTag } from '@trustwork/ui/i18n';
import { currentLocale, formatDate, formatNumber, tDynamic } from '@/app/_lib/i18n';
import { countryName } from '@trustwork/country-packs';
import type { LocalizedName } from '@trustwork/contracts/client';

/** Formatting helpers of the console (server side): everything through `Intl` in the viewer's language. */

const displayNames = new Map<string, Intl.DisplayNames | null>();

/** A language's name in the viewer's language (`es` → "Spanish" in English, "español" in Spanish), falling back to the tag. */
export function languageName(tag: string): string {
  const locale = currentLocale();
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  try {
    return names?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function country(code: string): string {
  return countryName(code, currentLocale());
}

/** A localized data value (hub names, labels) in the viewer's language when the data has it, otherwise the first one, with its language. */
export function localized(name: LocalizedName, preferred: readonly string[] = []): { text: string; lang: string } {
  const locale = currentLocale();
  for (const tag of [locale, ...preferred]) if (name[tag]) return { text: name[tag]!, lang: tag };
  const [lang, text] = Object.entries(name)[0]!;
  return { text, lang };
}

/** Date and time in the hub's time zone (the identity screen names the zone). */
export function dateTime(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(intlTag(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value));
  } catch {
    return formatDate(value, 'long');
  }
}

export function longDate(value: string): string {
  return formatDate(value, 'long');
}

export function shortDateTime(value: string): string {
  return formatDate(value, 'short');
}

export function number(value: number): string {
  return formatNumber(value);
}

/** Labels for a list of codes under one locale prefix, joined by the viewer's list format. */
export function list(items: readonly string[]): string {
  try {
    return new Intl.ListFormat(currentLocale(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export function label(prefix: string, code: string): string {
  return tDynamic(`${prefix}.${code}`, code);
}

/** A `modesViolations` code as a sentence (`module_magazine_requires_publications` → "Magazine needs Publications"). */
export function violationLabel(code: string): string {
  const match = /^module_(.+)_requires_(.+)$/.exec(code);
  if (match) return tDynamic('admin.details.moduleRequires', code, { module: tDynamic(`admin.hub.modules.names.${match[1]}`, match[1]!), dependency: tDynamic(`admin.hub.modules.names.${match[2]}`, match[2]!) });
  return tDynamic(`admin.details.${code}`, code);
}

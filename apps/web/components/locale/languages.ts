import { cache } from 'react';
import type { ReviewStatus } from '@trustwork/i18n-runtime/review-status';
import { t } from '@/app/_lib/i18n';
import { coverage } from '@/app/_lib/locale-data';
import { localesFor, type ActiveLocale } from '@/app/_lib/locale';
import { reviewStatusOf } from './review';
import type { SwitcherLanguage } from './LocaleSwitcher';

const LOCALE_NAMES: Record<string, string> = { en: 'English', ru: 'Русский', 'uz-Latn': 'Oʻzbekcha', ka: 'ქართული', hy: 'Հայերեն', 'az-Latn': 'Azərbaycanca' };
/** A language's own name; a language added as data only (INTL-004) gets its name from `Intl`. */
function localeName(tag: string): string {
  const known = LOCALE_NAMES[tag];
  if (known) return known;
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag;
  } catch {
    return tag;
  }
}

/**
 * Server side: the offered languages with their names, translation coverage and review status in the active language.
 * Computed once per request and locale (React `cache`), so the header switcher and the first-visit window hand the
 * browser the same array; languages of one review status share one object for the same reason. Every offered language
 * is listed: a draft is labelled, never hidden. This module stays free of client components, so a page can read the
 * list without carrying the controls in its own client chunk.
 */
export const switcherLanguages = cache(function switcherLanguages(active: ActiveLocale): SwitcherLanguage[] {
  const reviews = new Map<ReviewStatus, SwitcherLanguage['review']>();
  const reviewOf = (status: ReviewStatus) => {
    const review = reviews.get(status) ?? { label: t(`translations.status.${status}.label`), description: t(`translations.status.${status}.description`) };
    reviews.set(status, review);
    return review;
  };
  return localesFor(active.pack).map((tag) => {
    const c = coverage(tag);
    return { tag, name: localeName(tag), partial: c.translated < c.total, review: reviewOf(reviewStatusOf(tag)) };
  });
});

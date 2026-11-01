import en from './en.json' with { type: 'json' };
import es from './es.json' with { type: 'json' };
import ru from './ru.json' with { type: 'json' };
import uz from './uz-Latn.json' with { type: 'json' };
import ka from './ka.json' with { type: 'json' };
import hy from './hy.json' with { type: 'json' };
import az from './az-Latn.json' with { type: 'json' };

/** All transition kinds intentionally render the same safe generic notice until an authoritative disclosure policy exists. */
export const SCREENING_NOTICE_KINDS = ['hold', 'cleared', 'review', 'decision', 'appeal_received', 'appeal_outcome'] as const;
export const screeningNoticeDictionaries = { en, es, ru, 'uz-Latn': uz, ka, hy, 'az-Latn': az };
export const screeningTranslationReview = Object.fromEntries(Object.keys(screeningNoticeDictionaries).map((locale) => [locale, {
  source: locale === 'en' ? 'reference_draft' : 'machine_draft', nativeReviewed: false, counselReviewed: false,
}]));

/** Never interpolate names, identifiers, evidence, reasons, list data, places or client-provided URLs. */
export function validateScreeningNotice(params: Readonly<Record<string, string>>): void {
  if (Object.keys(params).length !== 1 || !(SCREENING_NOTICE_KINDS as readonly string[]).includes(params.kind ?? '')) {
    throw new Error('screening notice accepts only a known transition kind');
  }
}

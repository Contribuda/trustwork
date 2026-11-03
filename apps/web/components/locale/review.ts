import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentDeployment, dataPath } from '@trustwork/config/server';
import { UNREVIEWED, readLocaleReview, reviewStatement, shownStatus, type LocaleReview, type LocaleReviewStatement, type ReviewStatus } from '@trustwork/i18n-runtime/review-status';
import { LOCALES_DIR, appNamespaces } from '../../app/_lib/locale-data';

/**
 * Review status on the server (INTL-007). The record of a language is `<tag>.meta.json` beside its dictionaries: the
 * deployment's data directory first, as for dictionaries (CFG-001), else the built-in file. Records are read once per
 * process. They stay out of the browser: client components receive the finished labels (`LocaleControls`).
 */
const records = new Map<string, LocaleReview>();

function readRecord(tag: string): LocaleReview {
  const data = dataPath(currentDeployment(), 'locales');
  const own = data ? resolve(data, `${tag}.meta.json`) : null;
  const file = own && existsSync(own) ? own : resolve(LOCALES_DIR, `${tag}.meta.json`);
  try {
    return readLocaleReview(tag, JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // No file, or one that does not parse: nothing is claimed.
    return UNREVIEWED;
  }
}

/** The recorded review of a language; without a record that holds up, a machine draft. */
export function localeReview(tag: string): LocaleReview {
  let record = records.get(tag);
  if (!record) {
    record = readRecord(tag);
    records.set(tag, record);
  }
  return record;
}

/** The status a reader is told about a language. */
export function reviewStatusOf(tag: string): ReviewStatus {
  return shownStatus(localeReview(tag), appNamespaces());
}

/** The given languages in the machine-readable form a capability statement publishes. */
export function localeReviewStatement(tags: readonly string[]): LocaleReviewStatement {
  return reviewStatement(tags.map((tag) => ({ tag, review: localeReview(tag) })), appNamespaces());
}

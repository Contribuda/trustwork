/**
 * Locale review status (INTL-007, ADR 012 decision 30): how far a language has been checked by people, recorded in
 * `apps/web/locales/<tag>.meta.json` beside the language directory. The rule of this module is that nothing can claim
 * a review that did not happen: a language without a record, or with a record that does not hold up, reads as a
 * machine draft, and only the language every other one is translated from is the reference.
 *
 * No imports and only erasable TypeScript: the web server, `scripts/locale-status.mjs` (under plain Node) and the
 * capability statement (ADR 016) share these rules. Client components never import it; they receive finished labels.
 */
export const REFERENCE_LOCALE_TAG = 'en';

/** `reference` is the source of every key; the two reviewed values are raised by a pull request naming a reviewer. */
export const REVIEW_STATUSES = ['reference', 'machine_draft', 'community_reviewed', 'native_reviewed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** A language as recorded. `reviewers` are public handles of people who consented to being named; never anything else. */
export type LocaleReview = {
  status: ReviewStatus;
  reviewers: string[];
  /** The day the review finished, `YYYY-MM-DD`. */
  reviewedOn: string | null;
  /** The dictionary namespaces the review covered. */
  namespaces: string[];
  /** The issue or pull request where the review can be read. */
  reviewLink: string | null;
  /** The work package that added the language and a note for contributors; both for the docs table, never for readers. */
  package: string | null;
  note: string | null;
};

/** What a language is without a record that holds up. */
export const UNREVIEWED: LocaleReview = Object.freeze({ status: 'machine_draft', reviewers: [], reviewedOn: null, namespaces: [], reviewLink: null, package: null, note: null });

/** One language in the machine-readable form; `status` is what readers are told, `review` is the record behind it. */
export type LocaleReviewEntry = {
  tag: string;
  status: ReviewStatus;
  review: { status: ReviewStatus; reviewers: string[]; reviewedOn: string; namespaces: string[]; link: string } | null;
};

/** Machine-readable review status of a set of languages: the `hubs[].languages` review status of a capability statement. */
export type LocaleReviewStatement = { schema: 'trustwork-locale-review/1'; reference: string; locales: LocaleReviewEntry[] };

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAMESPACE = /^[a-z][a-z0-9-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

function realDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value) ? value : null;
}

function httpsLink(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  return new URL(value).protocol === 'https:' ? value : null;
}

/** Every handle, or null when one is malformed or its owner has not consented: the whole record then stops counting. */
function consentedHandles(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const handles: string[] = [];
  for (const reviewer of value as unknown[]) {
    if (!isRecord(reviewer) || reviewer.consent !== true || typeof reviewer.handle !== 'string' || !HANDLE.test(reviewer.handle)) return null;
    handles.push(reviewer.handle);
  }
  return handles;
}

function namespaceList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  return value.every((name) => typeof name === 'string' && NAMESPACE.test(name)) ? (value as string[]) : null;
}

/**
 * Reads the contents of a `<tag>.meta.json`, or `undefined` when there is none. A reviewed status counts only with a
 * consenting reviewer, a real date, the namespaces covered and a link to the review; anything else is a machine draft.
 */
export function readLocaleReview(tag: string, raw: unknown): LocaleReview {
  if (!isRecord(raw)) return UNREVIEWED;
  const described = { package: text(raw.package), note: text(raw.note) };
  if (raw.status === 'reference' && tag === REFERENCE_LOCALE_TAG) return { ...UNREVIEWED, ...described, status: 'reference' };
  if (raw.status !== 'community_reviewed' && raw.status !== 'native_reviewed') return { ...UNREVIEWED, ...described };
  const reviewers = consentedHandles(raw.reviewers);
  const reviewedOn = realDay(raw.reviewedOn);
  const reviewLink = httpsLink(raw.reviewLink);
  const namespaces = namespaceList(raw.namespaces);
  if (!reviewers || !reviewedOn || !reviewLink || !namespaces) return { ...UNREVIEWED, ...described };
  return { status: raw.status, reviewers, reviewedOn, namespaces, reviewLink, ...described };
}

/**
 * The status readers are told. A review speaks for the namespaces it covered, so a language whose review left some
 * out, or that gained a namespace since, stays a machine draft until the review covers everything it ships.
 */
export function shownStatus(review: LocaleReview, namespaces: readonly string[]): ReviewStatus {
  if (review.status === 'reference' || review.status === 'machine_draft') return review.status;
  return namespaces.every((name) => review.namespaces.includes(name)) ? review.status : 'machine_draft';
}

/** The machine-readable form of the given languages; it carries the consented handles and nothing a contributor noted. */
export function reviewStatement(reviews: ReadonlyArray<{ tag: string; review: LocaleReview }>, namespaces: readonly string[]): LocaleReviewStatement {
  return {
    schema: 'trustwork-locale-review/1',
    reference: REFERENCE_LOCALE_TAG,
    locales: reviews.map(({ tag, review }) => ({
      tag,
      status: shownStatus(review, namespaces),
      review: review.reviewedOn && review.reviewLink ? { status: review.status, reviewers: review.reviewers, reviewedOn: review.reviewedOn, namespaces: review.namespaces, link: review.reviewLink } : null,
    })),
  };
}

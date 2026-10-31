import type { ScreeningEntryType } from '../../../../packages/contracts/src/sanctions.js';
import { MATCHER_VERSION, screenedEntryTypes, screenedNamesDigest } from '../../../../packages/compliance/src/matching/index.js';
import { nameTokens } from '../../../../packages/compliance/src/names/index.js';
import type { RescreenSubjectRow } from '../../../../packages/data/src/repositories/rescreen.js';
import type { ScreeningConfig } from '../screening/config.js';

/**
 * Pure decisions of a re-screening batch (SANC-005). Fail closed: anything not provably covered by an earlier `clear`
 * for the same names, matcher and settings is screened in full.
 */

export interface SubjectFacts {
  readonly types: readonly ScreeningEntryType[];
  readonly tokens: readonly string[];
  readonly initials: readonly string[];
  readonly screenedNamesDigest: string;
  /** Some name has two or more tokens (otherwise the outcome is `insufficient_name` and nothing is compared). */
  readonly screenable: boolean;
}

/** The subject's entry types and name tokens, as `screenSubject` (SANC-003) derives them. */
export function subjectFacts(row: Pick<RescreenSubjectRow, 'kind' | 'names'>, config: Pick<ScreeningConfig, 'fuzzyThreshold' | 'vesselsAndAircraft'>): SubjectFacts {
  const tokens = [...new Set(row.names.flatMap((n) => nameTokens(n)))].sort();
  const initials = config.fuzzyThreshold === null ? [] : [...new Set(tokens.map((t) => [...t][0] as string))].sort();
  return {
    types: screenedEntryTypes(row.kind, { vesselsAndAircraft: config.vesselsAndAircraft }), tokens, initials, screenedNamesDigest: screenedNamesDigest(row.names),
    screenable: row.names.some((n) => nameTokens(n).length >= 2),
  };
}

/**
 * Screened against every active version with the names it has now (the rule SANC-003 applies at sign-in): nothing for
 * a list update to do. This is the idempotency per (subject, list version).
 */
export function isCurrent(row: RescreenSubjectRow, activeVersionIds: readonly string[]): boolean {
  return row.hasState && row.lastOutcome !== null && row.lastOutcome !== 'not_screened' && row.stateNamesDigest === row.namesDigest
    && activeVersionIds.every((id) => row.screenedVersions.includes(id));
}

/** Same matcher and settings as the subject's last result: a verification may trust its outcome. */
export function sameSettings(row: RescreenSubjectRow, config: Pick<ScreeningConfig, 'fuzzyThreshold'>): boolean {
  return row.lastMatcherVersion === MATCHER_VERSION && row.lastFuzzyThreshold === config.fuzzyThreshold;
}

/**
 * Whether the subject's last result can carry a `clear` to the new versions once the delta keys are ruled out: a
 * `clear` with no match at all (not even a decided one), for the same raw and normalized names, the same matcher
 * version and fuzzy setting, against at least one version. Companies are always screened in full while vessels and
 * aircraft are compared, because results do not record that setting. The database rechecks all of it after locking.
 */
export function deltaEligible(row: RescreenSubjectRow, facts: SubjectFacts, config: Pick<ScreeningConfig, 'fuzzyThreshold' | 'vesselsAndAircraft'>): boolean {
  return row.hasState && row.lastOutcome === 'clear' && !row.hasMatches && row.stateNamesDigest === row.namesDigest && sameSettings(row, config)
    && row.lastScreenedNamesDigest === facts.screenedNamesDigest && row.screenedVersions.length > 0 && facts.screenable
    && !(row.kind === 'company' && config.vesselsAndAircraft);
}

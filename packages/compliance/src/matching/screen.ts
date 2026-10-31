import { createHash } from 'node:crypto';
import type { ScreeningEntryType, ScreeningMatchRule, ScreeningOutcome, ScreeningSubjectRef } from '../../../contracts/src/sanctions.js';
import { NAME_KEY_VERSION, nameTokens } from '../names/index.js';
import { checkFuzzyThreshold, fuzzyRuleScore } from './fuzzy.js';
import { engineRuleMatches, MIN_SCREENABLE_TOKENS } from './rule.js';

/**
 * Screening one subject's names against candidate list entries (SANC-003). Pure: the worker loads the subject's names
 * and the candidate entries of the active list versions from the database and records what this returns; the
 * database rechecks every match against the entry it names and refuses a `clear` that is not against the active
 * baseline versions.
 *
 * `MATCHER_VERSION` is recorded in every result; it changes whenever the outcome for the same names and entries can
 * change (the rule, the fuzzy layer or the name keys).
 */
export const ENGINE_RULE_VERSION = 'engine-rule-1';
export const MATCHER_VERSION = `${ENGINE_RULE_VERSION}+fuzzy-jw-1+${NAME_KEY_VERSION}`;

/** Entry types screened for each subject kind. Vessels and aircraft only when a hub enables them, and only for companies. */
export function screenedEntryTypes(kind: ScreeningSubjectRef['kind'], options: { vesselsAndAircraft?: boolean } = {}): ScreeningEntryType[] {
  if (kind === 'person') return ['individual'];
  return options.vesselsAndAircraft ? ['entity', 'vessel', 'aircraft'] : ['entity'];
}

export interface CandidateEntry {
  readonly listCode: string;
  readonly listVersionId: string;
  readonly entryUid: string;
  readonly entryType: ScreeningEntryType;
  readonly primaryName: string;
  readonly programs: readonly string[];
  readonly nameKeys: readonly string[];
  readonly entryDigest: string;
}

export interface FoundMatch {
  readonly listCode: string;
  readonly listVersionId: string;
  readonly entryUid: string;
  readonly entryType: ScreeningEntryType;
  readonly entryName: string;
  readonly programs: readonly string[];
  readonly entryDigest: string;
  readonly matchedKey: string;
  readonly screenedName: string;
  readonly rule: ScreeningMatchRule;
  /** Fuzzy similarity (lowest token pair), rounded to three decimals; null for the engine rule. */
  readonly score: number | null;
}

export interface MatcherOptions {
  /** Null or absent: the fuzzy layer is off (the default). Otherwise a threshold inside the engine bounds. */
  readonly fuzzyThreshold?: number | null;
  readonly vesselsAndAircraft?: boolean;
}

export interface ScreeningReport {
  /** `clear`, `possible_match` or `insufficient_name`. `not_screened` is the caller's when no list was usable. */
  readonly outcome: Exclude<ScreeningOutcome, 'not_screened'>;
  readonly matcherVersion: string;
  readonly fuzzyThreshold: number | null;
  /** SHA-256 over the matcher version and the screened names' keys: the same names give the same digest. */
  readonly screenedNamesDigest: string;
  readonly screenedKeys: readonly string[];
  readonly matches: readonly FoundMatch[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The digest of the names a result screened (keys, distinct and sorted, with the name-key version). */
export function screenedNamesDigest(names: readonly string[]): string {
  const keys = [...new Set(names.map((n) => nameTokens(n).join(' ')).filter((k) => k !== ''))].sort();
  return sha256(`${NAME_KEY_VERSION}\n${keys.join('\n')}`);
}

/**
 * Screens `names` (a person's or a company's names) against `entries`. Only entries of the subject's entry types are
 * compared. When no name has two or more tokens the outcome is `insufficient_name` and nothing is compared. A match is
 * reported once per entry, with the first name and key that matched (engine rule before fuzzy).
 */
export function screenNames(subjectKind: ScreeningSubjectRef['kind'], names: readonly string[], entries: readonly CandidateEntry[], options: MatcherOptions = {}): ScreeningReport {
  const threshold = checkFuzzyThreshold(options.fuzzyThreshold);
  const types = new Set(screenedEntryTypes(subjectKind, options));
  const screened = [...new Map(names.map((name) => [nameTokens(name).join(' '), { name, tokens: nameTokens(name) }])).values()]
    .filter((n) => n.tokens.length > 0)
    .sort((a, b) => (a.tokens.join(' ') < b.tokens.join(' ') ? -1 : 1));
  const screenable = screened.filter((n) => n.tokens.length >= MIN_SCREENABLE_TOKENS);
  const base = { matcherVersion: MATCHER_VERSION, fuzzyThreshold: threshold, screenedNamesDigest: screenedNamesDigest(names), screenedKeys: screened.map((n) => n.tokens.join(' ')) };
  if (screenable.length === 0) return { ...base, outcome: 'insufficient_name', matches: [] };
  const found = new Map<string, FoundMatch>();
  const ordered = [...entries].filter((e) => types.has(e.entryType)).sort((a, b) => (a.listCode + '\u0000' + a.entryUid < b.listCode + '\u0000' + b.entryUid ? -1 : 1));
  for (const entry of ordered) {
    const id = `${entry.listCode}\u0000${entry.entryUid}`;
    const keys = [...entry.nameKeys].sort();
    const make = (subject: { name: string }, key: string, rule: ScreeningMatchRule, score: number | null): FoundMatch => ({
      listCode: entry.listCode, listVersionId: entry.listVersionId, entryUid: entry.entryUid, entryType: entry.entryType, entryName: entry.primaryName,
      programs: [...entry.programs], entryDigest: entry.entryDigest, matchedKey: key, screenedName: subject.name, rule, score,
    });
    engine: for (const subject of screenable) {
      for (const key of keys) {
        if (engineRuleMatches(subject.tokens, key.split(' '))) {
          found.set(id, make(subject, key, 'engine', null));
          break engine;
        }
      }
    }
    if (found.has(id) || threshold === null) continue;
    let best: { subject: { name: string }; key: string; score: number } | null = null;
    for (const subject of screenable) {
      for (const key of keys) {
        const score = fuzzyRuleScore(subject.tokens, key.split(' '), threshold);
        if (score !== null && (best === null || score > best.score)) best = { subject, key, score };
      }
    }
    if (best) found.set(id, make(best.subject, best.key, 'fuzzy', Math.floor(best.score * 1000) / 1000));
  }
  const matches = [...found.values()];
  return { ...base, outcome: matches.length ? 'possible_match' : 'clear', matches };
}

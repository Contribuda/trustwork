import { FUZZY_THRESHOLD_BOUNDS } from '../../../contracts/src/sanctions.js';
import { MIN_SCREENABLE_TOKENS } from './rule.js';

/**
 * The optional fuzzy layer (ADR 014 decision 11): the engine rule with token equality replaced by token similarity
 * (Jaro-Winkler, prefix scale 0.1, at most four prefix characters) at or above a hub threshold inside the engine
 * bounds. It runs only where the engine rule found nothing, so it can only add possible matches; its score is shown
 * to reviewers and never clears anything. Off by default: the owner has not chosen a threshold (ADR 014 open
 * question 3).
 */

export class FuzzyThresholdError extends Error {
  constructor(value: unknown) {
    super(`a fuzzy threshold is null (off) or between ${FUZZY_THRESHOLD_BOUNDS.min} and ${FUZZY_THRESHOLD_BOUNDS.max}, got ${String(value)}`);
    this.name = 'FuzzyThresholdError';
  }
}

/** Validates a hub's threshold: null (off) or inside the engine bounds. */
export function checkFuzzyThreshold(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < FUZZY_THRESHOLD_BOUNDS.min || value > FUZZY_THRESHOLD_BOUNDS.max) throw new FuzzyThresholdError(value);
  return value;
}

/** Jaro similarity of two strings (code points), in [0, 1]. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const x = [...a];
  const y = [...b];
  if (x.length === 0 || y.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const xMatched = new Array<boolean>(x.length).fill(false);
  const yMatched = new Array<boolean>(y.length).fill(false);
  let matches = 0;
  for (let i = 0; i < x.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(y.length - 1, i + window);
    for (let j = from; j <= to; j += 1) {
      if (yMatched[j] || x[i] !== y[j]) continue;
      xMatched[i] = true;
      yMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < x.length; i += 1) {
    if (!xMatched[i]) continue;
    while (!yMatched[k]) k += 1;
    if (x[i] !== y[k]) transpositions += 1;
    k += 1;
  }
  const m = matches;
  return (m / x.length + m / y.length + (m - transpositions / 2) / m) / 3;
}

/** Jaro-Winkler similarity (prefix scale 0.1, prefix up to four characters), in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  const x = [...a];
  const y = [...b];
  let prefix = 0;
  while (prefix < 4 && prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix += 1;
  return j + prefix * 0.1 * (1 - j);
}

/**
 * The best injective assignment of every token of `from` to a distinct token of `to` with similarity at or above the
 * threshold; returns the lowest pair similarity of the best assignment, or null when none exists. Names have few
 * tokens, so an exhaustive search is cheap; inputs beyond eight tokens are refused (null) rather than guessed.
 */
function assign(from: readonly string[], to: readonly string[], threshold: number): number | null {
  if (from.length > to.length || from.length > 8 || to.length > 9) return null;
  const sims = from.map((f) => to.map((t) => jaroWinkler(f, t)));
  const used = new Array<boolean>(to.length).fill(false);
  let best: number | null = null;
  const walk = (i: number, worst: number): void => {
    if (best !== null && worst <= best) return;
    if (i === from.length) {
      best = worst;
      return;
    }
    const row = sims[i] as number[];
    for (let j = 0; j < to.length; j += 1) {
      const sim = row[j] as number;
      if (used[j] || sim < threshold) continue;
      used[j] = true;
      walk(i + 1, Math.min(worst, sim));
      used[j] = false;
    }
  };
  walk(0, 1);
  return best;
}

/**
 * The engine rule's structure under token similarity: (a) every subject token pairs with a distinct entry token and
 * the entry has at most one more token, or (b) for subjects of three or more tokens, every entry token pairs with a
 * distinct subject token and the subject has exactly one more. Returns the score (lowest pair similarity) or null.
 */
export function fuzzyRuleScore(subject: readonly string[], entry: readonly string[], threshold: number): number | null {
  const s = [...new Set(subject)];
  const e = [...new Set(entry)];
  if (s.length < MIN_SCREENABLE_TOKENS || e.length === 0) return null;
  const scores: number[] = [];
  if (e.length - s.length >= 0 && e.length - s.length <= 1) {
    const a = assign(s, e, threshold);
    if (a !== null) scores.push(a);
  }
  if (s.length >= 3 && s.length - e.length === 1) {
    const b = assign(e, s, threshold);
    if (b !== null) scores.push(b);
  }
  return scores.length ? Math.max(...scores) : null;
}

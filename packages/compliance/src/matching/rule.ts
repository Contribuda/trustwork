/**
 * The engine rule (ADR 014 decision 11; parity with Contribuda). Subject and entry names are compared as sets of
 * name-key tokens (`packages/compliance/src/names`). A subject of `n` tokens possibly matches an entry key when
 *
 *   (a) every subject token is among the entry key's tokens and the entry key has at most one more token, or
 *   (b) the subject has three or more tokens and the entry key equals the subject's tokens minus one.
 *
 * A one-token subject is never compared: its outcome is `insufficient_name`, never `clear`. The rule is pure and
 * deterministic; the fuzzy layer (`fuzzy.ts`) can only add matches to it.
 */

export const MIN_SCREENABLE_TOKENS = 2;

/** True when the subject's tokens possibly match the entry key's tokens under the engine rule. */
export function engineRuleMatches(subject: readonly string[], entry: readonly string[]): boolean {
  const s = new Set(subject);
  const e = new Set(entry);
  if (s.size < MIN_SCREENABLE_TOKENS || e.size === 0) return false;
  let shared = 0;
  for (const token of s) if (e.has(token)) shared += 1;
  // (a) subject within the entry, at most one extra token on the entry's side.
  if (shared === s.size && e.size - s.size <= 1) return true;
  // (b) the entry is the subject minus exactly one token, for subjects of three or more tokens.
  return s.size >= 3 && shared === e.size && s.size - e.size === 1;
}

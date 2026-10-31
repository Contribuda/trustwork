/** Sanctions screening matcher (SANC-003, ADR 014 decision 11): the engine rule and the optional fuzzy layer. */
export { engineRuleMatches, MIN_SCREENABLE_TOKENS } from './rule.js';
export { checkFuzzyThreshold, fuzzyRuleScore, FuzzyThresholdError, jaro, jaroWinkler } from './fuzzy.js';
export {
  ENGINE_RULE_VERSION, MATCHER_VERSION, screenedEntryTypes, screenedNamesDigest, screenNames,
  type CandidateEntry, type FoundMatch, type MatcherOptions, type ScreeningReport,
} from './screen.js';

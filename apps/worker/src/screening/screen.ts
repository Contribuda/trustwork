import type { Transaction } from '@trustwork/data';
import type { ScreeningSubjectRef, ScreeningTrigger } from '../../../../packages/contracts/src/sanctions.js';
import { MATCHER_VERSION, screenedEntryTypes, screenedNamesDigest, screenNames } from '../../../../packages/compliance/src/matching/index.js';
import { nameTokens } from '../../../../packages/compliance/src/names/index.js';
import { screeningWorker, type RecordedResult } from '../../../../packages/data/src/repositories/screening.js';
import type { ScreeningConfig } from './config.js';

/**
 * Screens one subject inside the caller's transaction (the transactional job) and records the result:
 *
 * 1. the subject's names come from the database (never from an event payload);
 * 2. with no usable baseline (missing or stale) the result is `not_screened`: money stays held, never "clear";
 * 3. otherwise candidate entries of the active versions are loaded (entries sharing a name-key token, which every
 *    engine-rule match does; with the fuzzy layer on, also entries sharing a token initial) and the matcher decides;
 * 4. the database rechecks every match against its entry, applies "decided entries are not flagged again", refuses a
 *    `clear` that is not against the active baseline versions, and updates the state, the queue and the standing.
 *
 * Nothing here logs or returns a name.
 */
export async function screenSubject(trx: Transaction, subject: ScreeningSubjectRef, trigger: ScreeningTrigger, config: ScreeningConfig): Promise<RecordedResult> {
  const { names, namesDigest } = await screeningWorker.subjectNames(trx, subject);
  const lists = await screeningWorker.listsNow(trx);
  const listVersionIds = lists.versions.map((v) => v.versionId);
  const digest = screenedNamesDigest(names);
  if (!lists.available || !lists.versions.some((v) => v.baseline)) {
    return screeningWorker.recordResult(trx, { subject, trigger, namesDigest, listVersionIds, outcome: 'not_screened', matcherVersion: MATCHER_VERSION, fuzzyThreshold: config.fuzzyThreshold, screenedNamesDigest: digest, matches: [] });
  }
  const tokens = [...new Set(names.flatMap((n) => nameTokens(n)))].sort();
  const screenable = names.some((n) => nameTokens(n).length >= 2);
  const initials = config.fuzzyThreshold === null ? [] : [...new Set(tokens.map((t) => [...t][0] as string))].sort();
  const candidates = screenable
    ? await screeningWorker.candidates(trx, { entryTypes: screenedEntryTypes(subject.kind, { vesselsAndAircraft: config.vesselsAndAircraft }), tokens, initials })
    : [];
  const report = screenNames(subject.kind, names, candidates, { fuzzyThreshold: config.fuzzyThreshold, vesselsAndAircraft: config.vesselsAndAircraft });
  return screeningWorker.recordResult(trx, {
    subject, trigger, namesDigest, listVersionIds, outcome: report.outcome, matcherVersion: report.matcherVersion, fuzzyThreshold: report.fuzzyThreshold, screenedNamesDigest: report.screenedNamesDigest,
    matches: report.matches.map((m) => ({ listCode: m.listCode, listVersionId: m.listVersionId, entryUid: m.entryUid, matchedKey: m.matchedKey, screenedName: m.screenedName, rule: m.rule, score: m.score })),
  });
}

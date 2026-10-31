import { sql } from 'kysely';
import type { Transaction } from '@trustwork/data';
import type { ScreeningOutcome, ScreeningSubjectRef } from '../../../../packages/contracts/src/sanctions.js';
import { MATCHER_VERSION, screenNames } from '../../../../packages/compliance/src/matching/index.js';
import { rescreenWorker, type DeltaItem, type FullItem, type RescreenCounts, type RescreenSubjectRow } from '../../../../packages/data/src/repositories/rescreen.js';
import type { ScreeningRescreenRunRow } from '../../../../packages/data/src/schema/rescreen.js';
import { screeningWorker } from '../../../../packages/data/src/repositories/screening.js';
import type { ScreeningConfig } from '../screening/config.js';
import type { RescreenConfig } from './config.js';
import { touchesDelta, type ActiveIndex, type VersionCache } from './entries.js';
import { deltaEligible, isCurrent, sameSettings, subjectFacts, type SubjectFacts } from './plan.js';

export const RESCREEN_BATCH_KIND = 'screening.rescreen_batch';

export interface BatchDeps {
  config: RescreenConfig;
  screening: ScreeningConfig;
  cache: VersionCache;
}

/** What one batch did; `next` asks the caller to enqueue the run's next batch (after `delaySeconds`). */
export interface BatchReport {
  readonly kind: 'idle' | 'blocked' | 'progress' | 'phase' | 'done';
  readonly runId: string;
  readonly mode: 'delta' | 'full' | null;
  readonly next: { delaySeconds: number } | null;
  readonly counts: Required<RescreenCounts>;
  /** Subjects handled per method (full, delta, current, verified), for the cohort counters. */
  readonly methods: Readonly<Record<'full' | 'delta' | 'current' | 'verified', number>>;
  readonly outcomes: Readonly<Partial<Record<ScreeningOutcome, number>>>;
  readonly run: ScreeningRescreenRunRow | null;
}

const zero = (): Required<RescreenCounts> => ({
  subjectsDone: 0, candidatesScreened: 0, screenedFull: 0, screenedDelta: 0, alreadyCurrent: 0, verified: 0, clear: 0, possibleMatch: 0, insufficientName: 0, notScreened: 0, matchesOpened: 0, batches: 0,
});
const OUTCOME_KEY: Record<ScreeningOutcome, 'clear' | 'possibleMatch' | 'insufficientName' | 'notScreened'> = {
  clear: 'clear', possible_match: 'possibleMatch', insufficient_name: 'insufficientName', not_screened: 'notScreened',
};

/** The matcher on the in-memory index: the same candidates and rule as `screenSubject` (SANC-003). */
function match(row: RescreenSubjectRow, facts: SubjectFacts, index: ActiveIndex, config: ScreeningConfig) {
  const candidates = facts.screenable ? index.candidates(facts.types, facts.tokens, facts.initials) : [];
  return screenNames(row.kind, row.names, candidates, { fuzzyThreshold: config.fuzzyThreshold, vesselsAndAircraft: config.vesselsAndAircraft });
}

/** Jobs of other kinds due now, up to a bound (backpressure: the re-screen yields to interactive work). */
async function busy(trx: Transaction, bound: number): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT 1 FROM trustwork.job WHERE state = 'queued' AND next_at <= now() AND kind <> ${RESCREEN_BATCH_KIND} LIMIT ${bound + 1}) q`.execute(trx);
  return (rows[0]?.n ?? 0) > bound;
}

/**
 * One batch of a run, inside the batch job's transaction: lock the run, read the active versions, take the next
 * subjects after the cursor, screen or skip each, record results and items, and move the cursor. A crash or an error
 * rolls all of it back, so the next attempt repeats exactly this batch and never a finished one.
 *
 * - With no usable baseline (missing or stale), nothing is recorded: the run waits (`lists_unavailable`) and money
 *   stays held for every subject not yet screened against the active versions.
 * - Delta runs: phase `candidates` screens in full the subjects whose tokens meet a key the new version added or
 *   changed; phase `all` then skips subjects already current, records a delta `clear` for those whose last `clear`
 *   provably carries over (no token in common with any key their versions lacked), and screens everyone else in full.
 * - Full runs (weekly, manual): every subject is matched; a current subject whose outcome is unchanged (`clear` or
 *   `insufficient_name` again, same matcher and settings) is counted as verified without a new result row.
 */
export async function runBatch(trx: Transaction, deps: BatchDeps, runId: string): Promise<BatchReport> {
  const counts = zero();
  const methods = { full: 0, delta: 0, current: 0, verified: 0 };
  const outcomes: Partial<Record<ScreeningOutcome, number>> = {};
  const run = await rescreenWorker.lock(trx, runId);
  const report = (kind: BatchReport['kind'], next: BatchReport['next'], row: ScreeningRescreenRunRow | null): BatchReport =>
    ({ kind, runId, mode: run?.mode ?? null, next, counts, methods, outcomes, run: row });
  if (!run || run.state !== 'running') return report('idle', null, run);
  const cursor: ScreeningSubjectRef | null = run.cursor_kind && run.cursor_id ? { kind: run.cursor_kind, id: run.cursor_id } : null;

  const lists = await screeningWorker.listsNow(trx);
  if (!lists.available || !lists.versions.some((v) => v.baseline)) {
    const row = await rescreenWorker.advance(trx, { runId, phase: null, cursor, counts: {}, finished: false, blocked: 'lists_unavailable' });
    return report('blocked', { delaySeconds: deps.config.blockedSeconds }, row);
  }
  const activeIds = lists.versions.map((v) => v.versionId).sort();
  const index = await deps.cache.active(trx, activeIds);
  const rows = await rescreenWorker.subjects(trx, cursor, deps.config.batchSize);
  counts.batches = 1;
  if (rows.length === 0) {
    if (run.phase === 'candidates') {
      const row = await rescreenWorker.advance(trx, { runId, phase: 'all', cursor: null, counts, finished: false, blocked: null });
      return report('phase', { delaySeconds: 0 }, row);
    }
    const row = await rescreenWorker.advance(trx, { runId, phase: 'all', cursor, counts, finished: true, blocked: null });
    return report('done', null, row);
  }

  const trigger = run.mode === 'delta' ? 'list_update' : 'scheduled';
  const fuzzy = deps.screening.fuzzyThreshold !== null;
  const full: { row: RescreenSubjectRow; facts: SubjectFacts }[] = [];
  const delta: { row: RescreenSubjectRow; facts: SubjectFacts }[] = [];
  const verifyFull = (row: RescreenSubjectRow, facts: SubjectFacts) => {
    const outcome = match(row, facts, index, deps.screening).outcome;
    if (outcome === row.lastOutcome && (outcome === 'clear' || outcome === 'insufficient_name') && !row.hasMatches) {
      counts.verified += 1;
      methods.verified += 1;
    } else full.push({ row, facts });
  };

  if (run.phase === 'candidates') {
    const changed = await deps.cache.delta(trx, run.previous_version_id ? [run.previous_version_id] : [], [run.list_version_id as string]);
    for (const row of rows) {
      if (isCurrent(row, activeIds)) continue;
      const facts = subjectFacts(row, deps.screening);
      if (touchesDelta(changed, facts.types, facts.tokens, fuzzy)) full.push({ row, facts });
    }
  } else {
    counts.subjectsDone = rows.length;
    for (const row of rows) {
      const facts = subjectFacts(row, deps.screening);
      if (isCurrent(row, activeIds)) {
        if (run.mode === 'full' && sameSettings(row, deps.screening)) verifyFull(row, facts);
        else if (run.mode === 'full') full.push({ row, facts });
        else {
          counts.alreadyCurrent += 1;
          methods.current += 1;
        }
        continue;
      }
      if (run.mode === 'delta' && deltaEligible(row, facts, deps.screening)) {
        const since = await deps.cache.delta(trx, row.screenedVersions, activeIds);
        if (!touchesDelta(since, facts.types, facts.tokens, fuzzy)) {
          delta.push({ row, facts });
          continue;
        }
      }
      full.push({ row, facts });
    }
  }

  if (delta.length) {
    const items: DeltaItem[] = delta.map(({ row, facts }) => ({ subject: { kind: row.kind, id: row.id }, namesDigest: row.namesDigest, screenedNamesDigest: facts.screenedNamesDigest, baseVersions: row.screenedVersions }));
    const recorded = await rescreenWorker.recordDelta(trx, { runId, listVersionIds: activeIds, matcherVersion: MATCHER_VERSION, fuzzyThreshold: deps.screening.fuzzyThreshold, items });
    const refused = new Set(recorded.refused.map((s) => `${s.kind}:${s.id}`));
    for (const entry of delta) {
      if (refused.has(`${entry.row.kind}:${entry.row.id}`)) full.push(entry);
    }
    counts.screenedDelta += recorded.recorded;
    methods.delta += recorded.recorded;
    counts.clear += recorded.recorded;
    outcomes.clear = (outcomes.clear ?? 0) + recorded.recorded;
  }

  const fullItems: FullItem[] = [];
  for (const { row, facts } of full) {
    const found = match(row, facts, index, deps.screening);
    const result = await screeningWorker.recordResult(trx, {
      subject: { kind: row.kind, id: row.id }, trigger, namesDigest: row.namesDigest, listVersionIds: activeIds, outcome: found.outcome, matcherVersion: found.matcherVersion,
      fuzzyThreshold: found.fuzzyThreshold, screenedNamesDigest: found.screenedNamesDigest,
      matches: found.matches.map((m) => ({ listCode: m.listCode, listVersionId: m.listVersionId, entryUid: m.entryUid, matchedKey: m.matchedKey, screenedName: m.screenedName, rule: m.rule, score: m.score })),
    });
    fullItems.push({ subject: { kind: row.kind, id: row.id }, resultId: result.resultId, phase: run.phase });
    counts[OUTCOME_KEY[result.outcome]] += 1;
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    counts.matchesOpened += result.opened;
    methods.full += 1;
    if (run.phase === 'candidates') counts.candidatesScreened += 1;
    else counts.screenedFull += 1;
  }
  await rescreenWorker.recordItems(trx, runId, fullItems);

  const last = rows.at(-1) as RescreenSubjectRow;
  const row = await rescreenWorker.advance(trx, { runId, phase: run.phase, cursor: { kind: last.kind, id: last.id }, counts, finished: false, blocked: null });
  const delaySeconds = (await busy(trx, deps.config.yieldReadyJobs)) ? deps.config.yieldSeconds : 0;
  return report('progress', { delaySeconds }, row);
}

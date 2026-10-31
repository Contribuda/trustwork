import { sql } from 'kysely';
import { RescreenRunSchema, type RescreenRun, type ScreeningEntryType, type ScreeningOutcome, type ScreeningSubjectRef } from '../../../contracts/src/sanctions.js';
import type { Transaction } from '../pool.js';
import type { ScreeningRescreenItemRow, ScreeningRescreenRunRow } from '../schema/rescreen.js';
import type { CommandContext } from './admin.js';

/**
 * Re-screening repository (SANC-005, migration packages/data/migrations/rescreen; ADR 014 decision 12).
 *
 * - **Worker ports** (`rescreenWorker`, worker role, inside the batch job's transaction): ask for and start runs, lock a
 *   run, read the next subjects after the cursor, read the entries of activated versions for the in-memory index,
 *   record delta clears in bulk (the database rechecks every condition after locking the subjects' states), record
 *   items for subjects screened in full, move the run forward, fail it, the watchdog and cohort progress.
 * - **Staff ports** (`rescreenStaff`, compliance officer or auditor of the node): read runs; a compliance officer under
 *   a BE-004 elevation asks for a full run (audited).
 *
 * Nothing here returns or logs a name except `subjects`, whose names go to the matcher only.
 */

export type RescreenCounts = Partial<Record<'subjectsDone' | 'candidatesScreened' | 'screenedFull' | 'screenedDelta' | 'alreadyCurrent' | 'verified' | 'clear' | 'possibleMatch'
  | 'insufficientName' | 'notScreened' | 'matchesOpened' | 'batches', number>>;

export interface RescreenSubjectRow {
  kind: 'person' | 'company';
  id: string;
  names: string[];
  namesDigest: string;
  hasState: boolean;
  stateNamesDigest: string | null;
  lastOutcome: ScreeningOutcome | null;
  screenedVersions: string[];
  hasMatches: boolean;
  lastMatcherVersion: string | null;
  lastFuzzyThreshold: number | null;
  lastScreenedNamesDigest: string | null;
}

export interface RescreenVersionFacts { versionId: string; listId: string; listCode: string; state: 'active' | 'superseded'; entryCount: number }

export interface RescreenEntryRow {
  entryUid: string;
  entryType: ScreeningEntryType;
  primaryName: string;
  programs: string[];
  nameKeys: string[];
  entryDigest: string;
}

export interface DeltaItem { subject: ScreeningSubjectRef; namesDigest: string; screenedNamesDigest: string; baseVersions: readonly string[] }
export interface FullItem { subject: ScreeningSubjectRef; resultId: string; phase: 'candidates' | 'all' }

export interface RescreenProgressRow {
  runId: string;
  trigger: ScreeningRescreenRunRow['trigger'];
  mode: ScreeningRescreenRunRow['mode'];
  state: ScreeningRescreenRunRow['state'];
  phase: ScreeningRescreenRunRow['phase'];
  subjectsTotal: number;
  subjectsDone: number;
  matchesOpened: number;
  screenedFull: number;
  screenedDelta: number;
  alreadyCurrent: number;
  verified: number;
  failures: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  elapsedSeconds: number | null;
  overdue: boolean;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

export const rescreenWorker = {
  /** Asks for a run (`list_version` once per activated version; `scheduled` answers the unfinished full run). */
  async request(trx: Transaction, input: { trigger: 'list_version' | 'scheduled'; listVersionId: string | null; windowSeconds: number }): Promise<{ runId: string; created: boolean }> {
    const { rows } = await sql<{ run_id: string; created: boolean }>`SELECT * FROM trustwork.screening_rescreen_request(${input.trigger}::text, ${input.listVersionId}::uuid, ${input.windowSeconds}::integer)`.execute(trx);
    const row = rows[0] as { run_id: string; created: boolean };
    return { runId: row.run_id, created: row.created };
  },
  /** Starts the next run when none is running (or resumes a failed one after `retryAfterSeconds`). */
  async promote(trx: Transaction, retryAfterSeconds: number): Promise<{ runId: string; needsBatch: boolean; promoted: boolean } | null> {
    const { rows } = await sql<{ run_id: string; needs_batch: boolean; promoted: boolean }>`SELECT * FROM trustwork.screening_rescreen_promote(${retryAfterSeconds}::integer)`.execute(trx);
    const row = rows[0];
    return row ? { runId: row.run_id, needsBatch: row.needs_batch, promoted: row.promoted } : null;
  },
  async lock(trx: Transaction, runId: string): Promise<ScreeningRescreenRunRow | null> {
    const { rows } = await sql<ScreeningRescreenRunRow>`SELECT * FROM trustwork.screening_rescreen_lock(${runId}::uuid)`.execute(trx);
    return rows[0] ?? null;
  },
  /** The next subjects after the cursor (companies, then persons, by id). */
  async subjects(trx: Transaction, after: ScreeningSubjectRef | null, limit: number): Promise<RescreenSubjectRow[]> {
    const { rows } = await sql<{
      kind: 'person' | 'company'; id: string; names: (string | null)[] | null; names_digest: string; has_state: boolean; state_names_digest: string | null; last_outcome: ScreeningOutcome | null;
      screened_versions: string[]; has_matches: boolean; last_matcher_version: string | null; last_fuzzy_threshold: string | null; last_screened_names_digest: string | null;
    }>`SELECT * FROM trustwork.screening_rescreen_subjects(${after?.kind ?? null}::text, ${after?.id ?? null}::uuid, ${limit}::integer)`.execute(trx);
    return rows.map((r) => ({
      kind: r.kind, id: r.id, names: (r.names ?? []).filter((n): n is string => typeof n === 'string'), namesDigest: r.names_digest, hasState: r.has_state, stateNamesDigest: r.state_names_digest,
      lastOutcome: r.last_outcome, screenedVersions: r.screened_versions ?? [], hasMatches: r.has_matches, lastMatcherVersion: r.last_matcher_version,
      lastFuzzyThreshold: num(r.last_fuzzy_threshold), lastScreenedNamesDigest: r.last_screened_names_digest,
    }));
  },
  async versions(trx: Transaction, ids: readonly string[]): Promise<RescreenVersionFacts[]> {
    const { rows } = await sql<{ version_id: string; list_id: string; list_code: string; state: 'active' | 'superseded'; entry_count: number }>`
      SELECT * FROM trustwork.screening_rescreen_versions(${[...ids]}::uuid[])`.execute(trx);
    return rows.map((r) => ({ versionId: r.version_id, listId: r.list_id, listCode: r.list_code, state: r.state, entryCount: r.entry_count }));
  },
  async entries(trx: Transaction, versionId: string): Promise<RescreenEntryRow[]> {
    const { rows } = await sql<{ entry_uid: string; entry_type: ScreeningEntryType; primary_name: string; programs: string[]; name_keys: string[]; entry_digest: string }>`
      SELECT * FROM trustwork.screening_rescreen_entries(${versionId}::uuid)`.execute(trx);
    return rows.map((r) => ({ entryUid: r.entry_uid, entryType: r.entry_type, primaryName: r.primary_name, programs: r.programs, nameKeys: r.name_keys, entryDigest: r.entry_digest }));
  },
  /** Records delta clears; answers how many and which subjects no longer qualify (the caller screens those in full). */
  async recordDelta(trx: Transaction, input: { runId: string; listVersionIds: readonly string[]; matcherVersion: string; fuzzyThreshold: number | null; items: readonly DeltaItem[] }): Promise<{ recorded: number; refused: ScreeningSubjectRef[] }> {
    const items = input.items.map((i) => ({ kind: i.subject.kind, id: i.subject.id, namesDigest: i.namesDigest, screenedNamesDigest: i.screenedNamesDigest, baseVersions: [...i.baseVersions] }));
    const { rows } = await sql<{ v: { recorded: number; refused: ScreeningSubjectRef[] } }>`SELECT trustwork.screening_rescreen_record_delta(${input.runId}::uuid, ${[...input.listVersionIds]}::uuid[],
      ${input.matcherVersion}::text, ${input.fuzzyThreshold}::numeric, ${JSON.stringify(items)}::jsonb) AS v`.execute(trx);
    const v = rows[0]?.v as { recorded: number; refused: ScreeningSubjectRef[] };
    return { recorded: Number(v.recorded), refused: v.refused };
  },
  async recordItems(trx: Transaction, runId: string, items: readonly FullItem[]): Promise<number> {
    if (items.length === 0) return 0;
    const payload = items.map((i) => ({ kind: i.subject.kind, id: i.subject.id, resultId: i.resultId, phase: i.phase }));
    const { rows } = await sql<{ v: number }>`SELECT trustwork.screening_rescreen_record_items(${runId}::uuid, ${JSON.stringify(payload)}::jsonb) AS v`.execute(trx);
    return Number(rows[0]?.v ?? 0);
  },
  async advance(trx: Transaction, input: { runId: string; phase: 'candidates' | 'all' | null; cursor: ScreeningSubjectRef | null; counts: RescreenCounts; finished: boolean; blocked: 'lists_unavailable' | null }): Promise<ScreeningRescreenRunRow> {
    const counts = Object.fromEntries(Object.entries(input.counts).filter(([, v]) => typeof v === 'number' && v > 0));
    const { rows } = await sql<ScreeningRescreenRunRow>`SELECT * FROM trustwork.screening_rescreen_advance(${input.runId}::uuid, ${input.phase}::text, ${input.cursor?.kind ?? null}::text,
      ${input.cursor?.id ?? null}::uuid, ${JSON.stringify(counts)}::jsonb, ${input.finished}::boolean, ${input.blocked}::text)`.execute(trx);
    return rows[0] as ScreeningRescreenRunRow;
  },
  async fail(trx: Transaction, runId: string, error: string): Promise<ScreeningRescreenRunRow> {
    const { rows } = await sql<ScreeningRescreenRunRow>`SELECT * FROM trustwork.screening_rescreen_fail(${runId}::uuid, ${error}::text)`.execute(trx);
    return rows[0] as ScreeningRescreenRunRow;
  },
  /** The watchdog: lost batch chains fail; runs past their window raise one overdue alert. */
  async watch(trx: Transaction): Promise<{ runId: string; alert: 'failed' | 'overdue' }[]> {
    const { rows } = await sql<{ run_id: string; alert: 'failed' | 'overdue' }>`SELECT * FROM trustwork.screening_rescreen_watch()`.execute(trx);
    return rows.map((r) => ({ runId: r.run_id, alert: r.alert }));
  },
  /** The latest run of each trigger, for the cohort gauges. */
  async progress(trx: Transaction): Promise<RescreenProgressRow[]> {
    const { rows } = await sql<{
      run_id: string; trigger: RescreenProgressRow['trigger']; mode: RescreenProgressRow['mode']; state: RescreenProgressRow['state']; phase: RescreenProgressRow['phase']; subjects_total: number;
      subjects_done: number; matches_opened: number; screened_full: number; screened_delta: number; already_current: number; verified: number; failures: number; started_at: Date | null;
      finished_at: Date | null; elapsed_seconds: string | null; overdue: boolean;
    }>`SELECT * FROM trustwork.screening_rescreen_progress()`.execute(trx);
    return rows.map((r) => ({
      runId: r.run_id, trigger: r.trigger, mode: r.mode, state: r.state, phase: r.phase, subjectsTotal: r.subjects_total, subjectsDone: r.subjects_done, matchesOpened: r.matches_opened,
      screenedFull: r.screened_full, screenedDelta: r.screened_delta, alreadyCurrent: r.already_current, verified: r.verified, failures: r.failures, startedAt: r.started_at,
      finishedAt: r.finished_at, elapsedSeconds: num(r.elapsed_seconds), overdue: r.overdue,
    }));
  },
};

/** The staff view of a run (contract `RescreenRunSchema`). */
export function rescreenRunView(row: ScreeningRescreenRunRow): RescreenRun {
  return RescreenRunSchema.parse({
    id: row.id, trigger: row.trigger, mode: row.mode, listVersionId: row.list_version_id, previousVersionId: row.previous_version_id, requestedBy: row.requested_by, state: row.state,
    phase: row.phase, blockedReason: row.blocked_reason, windowSeconds: row.window_seconds, subjectsTotal: row.subjects_total, subjectsDone: row.subjects_done,
    candidatesScreened: row.candidates_screened, screenedFull: row.screened_full, screenedDelta: row.screened_delta, alreadyCurrent: row.already_current, verified: row.verified,
    outcomes: { clear: row.outcome_clear, possibleMatch: row.outcome_possible_match, insufficientName: row.outcome_insufficient_name, notScreened: row.outcome_not_screened },
    matchesOpened: row.matches_opened, failures: row.failures, resumed: row.resumed, overdue: row.overdue_alerted_at !== null, queuedAt: row.queued_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null, finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  });
}

export const rescreenStaff = {
  /** Runs, newest first (compliance officers and auditors of the node; everyone else reads nothing). */
  async runs(trx: Transaction, limit = 50): Promise<RescreenRun[]> {
    const rows = await trx.selectFrom('screening_rescreen_run').selectAll().orderBy('queued_at', 'desc').orderBy('id', 'desc').limit(Math.min(Math.max(limit, 1), 500)).execute();
    return rows.map(rescreenRunView);
  },
  items(trx: Transaction, runId: string, limit = 500): Promise<ScreeningRescreenItemRow[]> {
    return trx.selectFrom('screening_rescreen_item').selectAll().where('run_id', '=', runId).orderBy('recorded_at').orderBy('id').limit(Math.min(Math.max(limit, 1), 5000)).execute();
  },
  /** A compliance officer of the node asks for a full run now (answers the unfinished full run when one exists). */
  async requestRun(trx: Transaction, ctx: CommandContext, input: { reason: string; windowSeconds: number }): Promise<RescreenRun> {
    const { rows } = await sql<ScreeningRescreenRunRow>`SELECT * FROM trustwork.screening_rescreen_request_manual(${JSON.stringify(ctx)}::jsonb, ${input.reason}::text, ${input.windowSeconds}::integer)`.execute(trx);
    return rescreenRunView(rows[0] as ScreeningRescreenRunRow);
  },
};

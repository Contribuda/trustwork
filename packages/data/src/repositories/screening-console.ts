import { sql } from 'kysely';
import type { RescreenRun } from '../../../contracts/src/sanctions.js';
import type { Transaction } from '../pool.js';
import { AGGREGATE_MIN_COHORT } from '../../../contracts/src/hub.js';
import { ScreeningConsoleRunSchema, ScreeningListsOverviewSchema, ScreeningVersionSummarySchema } from '../../../contracts/src/sanctions.js';
import { screeningFreshness, screeningListsStaff } from './screening-lists.js';
import type { ScreeningListVersionRow } from '../schema/screening-lists.js';

export function screeningVersionSummary(row: ScreeningListVersionRow) {
  return ScreeningVersionSummarySchema.parse({
    id: row.id, version: row.version, state: row.state, mode: row.mode,
    publishedOn: row.published_on ? `${row.published_on.getFullYear()}-${String(row.published_on.getMonth() + 1).padStart(2, '0')}-${String(row.published_on.getDate()).padStart(2, '0')}` : null,
    fetchedAt: row.fetched_at.toISOString(), entryCount: row.entry_count, digest: row.digest,
    activatedAt: row.activated_at?.toISOString() ?? null,
  });
}

/** Caller must pass the existing jurisdiction staff gate before calling the SECURITY DEFINER freshness port. */
export async function screeningListsOverview(trx: Transaction) {
  const lists = await screeningListsStaff.lists(trx);
  const availability = await screeningFreshness.availability(trx);
  const freshness = availability.lists;
  const versionIds = freshness.flatMap((item) => item.activeVersionId ? [item.activeVersionId] : []);
  const versions = versionIds.length ? await trx.selectFrom('screening_list_version').selectAll()
    .where('id', 'in', versionIds).execute() : [];
  return ScreeningListsOverviewSchema.parse({
    checkedAt: availability.checkedAt, available: availability.available,
    items: lists.map((list) => ({
      id: list.id, code: list.code, baseline: list.baseline, hubId: list.hub_id, mode: list.mode, status: list.status,
      freshness: freshness.find((item) => item.listId === list.id),
      activeVersion: versions.find((version) => version.list_id === list.id) ? screeningVersionSummary(versions.find((version) => version.list_id === list.id)!) : null,
    })),
  });
}

/** Operational run durations, never a hub cohort. Suppression happens in SQL before rows leave the repository.
 * Distinct recorded person ids prove the minimum; company ids and event counts never stand in for principals.
 */
export async function screeningRunDurations(trx: Transaction) {
  const { rows } = await sql<{ run_id: string; seconds: number }>`
    SELECT r.id AS run_id, extract(epoch FROM (r.finished_at - r.started_at))::float8 AS seconds
    FROM trustwork.screening_rescreen_run r
    JOIN trustwork.screening_rescreen_item i ON i.run_id = r.id
    WHERE r.started_at IS NOT NULL AND r.finished_at >= r.started_at
    GROUP BY r.id
    HAVING count(DISTINCT i.subject_person_id) >= ${AGGREGATE_MIN_COHORT}
    ORDER BY r.finished_at DESC, r.id LIMIT 50
  `.execute(trx);
  return rows.map((row) => ({ runId: row.run_id, seconds: row.seconds }));
}

/** Both GET and command responses use this projection; raw counters cannot bypass cohort suppression. */
export async function screeningConsoleRuns(trx: Transaction, runs: readonly RescreenRun[]) {
  const cohorts = runs.length ? await trx.selectFrom('screening_rescreen_item')
    .select(['run_id', sql<string>`count(DISTINCT subject_person_id)`.as('principals')])
    .where('run_id', 'in', runs.map((run) => run.id)).groupBy('run_id').execute() : [];
  return runs.map((run) => ScreeningConsoleRunSchema.parse({
    id: run.id, state: run.state, queuedAt: run.queuedAt, overdue: run.overdue, blockedReason: run.blockedReason,
    progress: Number(cohorts.find((cohort) => cohort.run_id === run.id)?.principals ?? 0) >= AGGREGATE_MIN_COHORT
      && run.subjectsDone >= AGGREGATE_MIN_COHORT && run.subjectsTotal >= AGGREGATE_MIN_COHORT
      ? { subjectsDone: run.subjectsDone, subjectsTotal: run.subjectsTotal } : null,
  }));
}

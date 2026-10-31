import { sql } from 'kysely';
import {
  screeningAvailability, ScreeningListFreshnessSchema,
  type ListIngestOutcome, type ListSanity, type ScreeningAvailability, type ScreeningListEntry, type ScreeningListFreshness, type ScreeningListMode, type ScreeningListStatus,
} from '../../../contracts/src/sanctions.js';
import type { Transaction } from '../pool.js';
import type { ScreeningListEntryRow, ScreeningListRow, ScreeningListVersionRow } from '../schema/screening-lists.js';
import type { CommandContext } from './admin.js';

/**
 * Screening lists repository (SANC-002, migration packages/data/migrations/screening-lists; ADR 014 decisions 10 and 11).
 *
 * - **Freshness** (`screeningFreshness`), for the worker, the console and the money and commitment gates (SANC-004):
 *   per-list states and `availability`, which is false while a baseline list is missing or stale. A gate that cannot
 *   read it must refuse.
 * - **Worker ports** (`screeningListWorker`), on the worker role inside one transaction: lock a list, stage a version,
 *   write its entries in batches, activate (the database rechecks count and digest and appends the outbox event) or
 *   reject, and record the attempt.
 * - **Staff ports** (`screeningListsStaff`), under `withPrincipal` with a `CommandContext` (BE-004 elevation): read
 *   lists and versions as a compliance officer or auditor; pause or resume an additional list (never a baseline one);
 *   confirm a version whose entry count dropped beyond the list's share.
 */

export interface LockedScreeningList {
  id: string;
  hubId: string | null;
  code: string;
  adapter: string;
  mode: ScreeningListMode;
  sourceUrl: string;
  status: ScreeningListStatus;
  baseline: boolean;
  maxDropShare: number;
  minEntries: number;
  active: { versionId: string; digest: string; entryCount: number } | null;
  staged: { versionId: string; digest: string } | null;
}

export type ActivationOutcome = 'activated' | 'needs_confirmation' | 'rejected';

/** Entries per `screening_list_add_entries` call (the function accepts at most 2000). */
export const ENTRY_BATCH = 1000;

interface FreshnessRow {
  list_id: string;
  hub_id: string | null;
  code: string;
  baseline: boolean;
  status: ScreeningListStatus;
  state: string;
  active_version_id: string | null;
  published_on: Date | string | null;
  last_checked_at: Date | null;
  age_seconds: string | number | null;
  warn_after_seconds: string | number;
  stale_after_seconds: string | number;
}

const isoDate = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // A `date` column arrives as local midnight; read it back in local time.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

function freshnessOf(row: FreshnessRow): ScreeningListFreshness {
  return ScreeningListFreshnessSchema.parse({
    listId: row.list_id,
    hubId: row.hub_id,
    code: row.code,
    baseline: row.baseline,
    status: row.status,
    state: row.state,
    activeVersionId: row.active_version_id,
    publishedOn: isoDate(row.published_on),
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    ageSeconds: row.age_seconds === null ? null : Number(row.age_seconds),
    warnAfterSeconds: Number(row.warn_after_seconds),
    staleAfterSeconds: Number(row.stale_after_seconds),
  });
}

export const screeningFreshness = {
  /**
   * Freshness of every list at `at` (default now). The database never evaluates a time before now, so a caller can
   * only make a list look older (the clock tests pass a later time).
   */
  async lists(trx: Transaction, at?: Date): Promise<ScreeningListFreshness[]> {
    const { rows } = await sql<FreshnessRow>`SELECT * FROM trustwork.screening_list_freshness(${at ?? null}::timestamptz)`.execute(trx);
    return rows.map(freshnessOf);
  },
  /** What the gates read: available only while every baseline list is fresh or in its warning period. */
  async availability(trx: Transaction, at?: Date): Promise<ScreeningAvailability> {
    const { rows } = await sql<FreshnessRow & { checked_at: Date }>`SELECT f.*, greatest(coalesce(${at ?? null}::timestamptz, now()), now()) AS checked_at FROM trustwork.screening_list_freshness(${at ?? null}::timestamptz) f`.execute(trx);
    const checkedAt = rows[0]?.checked_at ?? at ?? new Date();
    return screeningAvailability(rows.map(freshnessOf), checkedAt);
  },
  /** The database's own answer (`screening_available()`), for callers that need only the boolean. */
  async available(trx: Transaction, at?: Date): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.screening_available(${at ?? null}::timestamptz) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
};

export const screeningListWorker = {
  /** Lists due for an attempt that have no ingestion job queued or running. */
  async due(trx: Transaction, limit = 20): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`SELECT id FROM trustwork.screening_list_due(${limit}::integer) AS id`.execute(trx);
    return rows.map((r) => r.id);
  },
  /** Locks the list for this transaction and returns it with its active and staged versions, or null. */
  async lock(trx: Transaction, listId: string): Promise<LockedScreeningList | null> {
    const { rows } = await sql<{
      id: string; hub_id: string | null; code: string; adapter: string; mode: ScreeningListMode; source_url: string; status: ScreeningListStatus; baseline: boolean;
      max_drop_share: string; min_entries: number; active_version_id: string | null; active_digest: string | null; active_entry_count: number | null;
      staged_version_id: string | null; staged_digest: string | null;
    }>`SELECT * FROM trustwork.screening_list_lock(${listId}::uuid)`.execute(trx);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id, hubId: row.hub_id, code: row.code, adapter: row.adapter, mode: row.mode, sourceUrl: row.source_url, status: row.status, baseline: row.baseline,
      maxDropShare: Number(row.max_drop_share), minEntries: row.min_entries,
      active: row.active_version_id ? { versionId: row.active_version_id, digest: row.active_digest as string, entryCount: row.active_entry_count as number } : null,
      staged: row.staged_version_id ? { versionId: row.staged_version_id, digest: row.staged_digest as string } : null,
    };
  },
  async recordAttempt(trx: Transaction, input: { listId: string; outcome: ListIngestOutcome; error: string | null; confirmedAt: Date | null }): Promise<void> {
    await sql`SELECT trustwork.screening_list_record_attempt(${input.listId}::uuid, ${input.outcome}::text, ${input.error}::text, ${input.confirmedAt}::timestamptz)`.execute(trx);
  },
  /** Stages a version and writes its entries; returns the version id. */
  async stage(trx: Transaction, input: {
    listId: string; publishedOn: string | null; fetchedAt: Date; mode: ScreeningListMode; sourceDigest: string; digest: string; sanity: ListSanity; entries: readonly ScreeningListEntry[];
  }): Promise<string> {
    const { rows } = await sql<{ id: string }>`SELECT trustwork.screening_list_stage(${input.listId}::uuid, ${input.publishedOn}::date, ${input.fetchedAt}::timestamptz, ${input.mode}::text,
      ${input.sourceDigest}::text, ${input.entries.length}::integer, ${input.digest}::text, ${JSON.stringify(input.sanity)}::jsonb) AS id`.execute(trx);
    const versionId = rows[0]?.id as string;
    for (let at = 0; at < input.entries.length; at += ENTRY_BATCH) {
      const batch = input.entries.slice(at, at + ENTRY_BATCH).map((e) => ({
        entry_uid: e.entryUid, entry_type: e.entryType, primary_name: e.primaryName, programs: e.programs, name_keys: e.nameKeys, attributes: e.attributes, entry_digest: e.entryDigest,
      }));
      await sql`SELECT trustwork.screening_list_add_entries(${versionId}::uuid, ${JSON.stringify(batch)}::jsonb)`.execute(trx);
    }
    return versionId;
  },
  async activate(trx: Transaction, versionId: string): Promise<ActivationOutcome> {
    const { rows } = await sql<{ v: ActivationOutcome }>`SELECT trustwork.screening_list_activate(${versionId}::uuid) AS v`.execute(trx);
    return rows[0]?.v as ActivationOutcome;
  },
  async reject(trx: Transaction, versionId: string, reason: string): Promise<void> {
    await sql`SELECT trustwork.screening_list_reject(${versionId}::uuid, ${reason}::text)`.execute(trx);
  },
};

export const screeningListsStaff = {
  /** Lists visible to the caller (compliance officers and auditors of the node; nobody else sees any). */
  lists(trx: Transaction): Promise<ScreeningListRow[]> {
    return trx.selectFrom('screening_list').selectAll().orderBy('baseline', 'desc').orderBy('code').execute();
  },
  versions(trx: Transaction, listId: string, limit = 50): Promise<ScreeningListVersionRow[]> {
    return trx.selectFrom('screening_list_version').selectAll().where('list_id', '=', listId).orderBy('version', 'desc').limit(limit).execute();
  },
  entries(trx: Transaction, versionId: string, limit = 200): Promise<ScreeningListEntryRow[]> {
    return trx.selectFrom('screening_list_entry').selectAll().where('list_version_id', '=', versionId).orderBy('entry_uid').limit(limit).execute();
  },
  /** Pauses or resumes an additional list as a compliance officer of the node; a baseline list refuses (`screening.baseline_list`). */
  async setStatus(trx: Transaction, ctx: CommandContext, input: { listId: string; status: ScreeningListStatus; reason: string }): Promise<ScreeningListRow> {
    const { rows } = await sql<ScreeningListRow>`SELECT * FROM trustwork.screening_list_set_status(${JSON.stringify(ctx)}::jsonb, ${input.listId}::uuid, ${input.status}::text, ${input.reason}::text)`.execute(trx);
    return rows[0] as ScreeningListRow;
  },
  /** Activates a staged version waiting for confirmation (entry count dropped beyond the share), audited. */
  async confirmVersion(trx: Transaction, ctx: CommandContext, input: { versionId: string; reason: string }): Promise<ActivationOutcome> {
    const { rows } = await sql<{ v: ActivationOutcome }>`SELECT trustwork.screening_list_confirm_version(${JSON.stringify(ctx)}::jsonb, ${input.versionId}::uuid, ${input.reason}::text) AS v`.execute(trx);
    return rows[0]?.v as ActivationOutcome;
  },
};

import { checkListSanity, type ListIngestOutcome } from '../../../../packages/contracts/src/sanctions.js';
import { findListAdapter, listDigest, MalformedListError, type ParsedList } from '../../../../packages/compliance/src/lists/index.js';
import { screeningListWorker } from '../../../../packages/data/src/repositories/screening-lists.js';
import type { Transaction } from '@trustwork/data';
import { ListSourceError, type ListSource } from './sources.js';

export interface IngestReport {
  readonly listId: string;
  readonly code: string | null;
  readonly outcome: ListIngestOutcome;
  readonly versionId: string | null;
  /** Short, list-level reason (never personal data: the lists are published government data). */
  readonly error: string | null;
}

export interface IngestDeps {
  readonly sources: Readonly<Record<'fake' | 'file' | 'live', ListSource>>;
}

const short = (text: string): string => text.slice(0, 300);

/**
 * One ingestion of one list, inside the caller's transaction (the transactional job): lock the list, obtain the
 * export, parse it, and then either confirm the active content (unchanged digest), or stage a new version with its
 * sanity check and let the database activate it (count and digest rechecked), keep it waiting for a person (count
 * dropped beyond the share) or reject it. A missing, malformed or truncated export never touches the active version.
 * The attempt and its outcome are recorded on the list in the same transaction.
 */
export async function ingestList(trx: Transaction, listId: string, deps: IngestDeps, signal: AbortSignal): Promise<IngestReport> {
  const list = await screeningListWorker.lock(trx, listId);
  if (!list) return { listId, code: null, outcome: 'failed', versionId: null, error: 'list_not_found' };
  const finish = async (outcome: ListIngestOutcome, error: string | null, versionId: string | null, confirmedAt: Date | null = null): Promise<IngestReport> => {
    await screeningListWorker.recordAttempt(trx, { listId, outcome, error: error === null ? null : short(error), confirmedAt });
    return { listId, code: list.code, outcome, versionId, error };
  };
  if (list.status !== 'active') return finish('refused', 'list_paused', null);
  const adapter = findListAdapter(list.adapter);
  if (!adapter) return finish('refused', `unknown_adapter:${list.adapter}`, null);

  let obtained;
  try {
    obtained = await deps.sources[list.mode].obtain(list, adapter, signal);
  } catch (error) {
    if (error instanceof ListSourceError) return finish(error.outcome, `${error.code}: ${error.message}`, null);
    throw error;
  }

  let parsed: ParsedList;
  try {
    parsed = adapter.parse(obtained.text);
  } catch (error) {
    if (error instanceof MalformedListError) return finish('malformed', error.message, null);
    throw error;
  }
  const digest = listDigest(parsed.entries);
  if (list.active && list.active.digest === digest) return finish('unchanged', null, list.active.versionId, obtained.obtainedAt);
  if (list.staged && list.staged.digest === digest) return finish('needs_confirmation', 'the staged version still waits for a compliance officer', list.staged.versionId);

  const sanity = checkListSanity({ parsedCount: parsed.entries.length, declaredCount: parsed.declaredCount, previousCount: list.active?.entryCount ?? null, maxDropShare: list.maxDropShare, minEntries: list.minEntries });
  const versionId = await screeningListWorker.stage(trx, {
    listId, publishedOn: parsed.publishedOn, fetchedAt: obtained.obtainedAt, mode: list.mode, sourceDigest: obtained.sourceDigest, digest, sanity, entries: parsed.entries,
  });
  const outcome = await screeningListWorker.activate(trx, versionId);
  if (outcome === 'activated') return finish('activated', null, versionId);
  if (outcome === 'needs_confirmation') return finish('needs_confirmation', `entry count dropped by ${Math.round((sanity.dropShare ?? 0) * 100)}%, more than the list allows; a compliance officer must confirm`, versionId);
  return finish('rejected', sanity.reasons.join(',') || 'entries_mismatch', versionId);
}

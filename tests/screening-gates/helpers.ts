import { sql } from 'kysely';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { listDigest, parseOfacSlsXml, renderOfacSlsXml, sourceDigest, type FakeListEntry } from '../../packages/compliance/src/lists/index.js';
import { checkListSanity, type ScreeningSubjectRef } from '../../packages/contracts/src/sanctions.js';
import { screeningListWorker } from '../../packages/data/src/repositories/screening-lists.js';
import { screenSubject } from '../../apps/worker/src/screening/index.js';
import type { ScreeningConfig } from '../../apps/worker/src/screening/config.js';

/**
 * Screening fixtures for suites that bind commitments or move money (SANC-004). The gates refuse every subject that is
 * not screened `clear` against fresh baseline lists, so a suite that sends quotes, accepts terms or places orders first
 * activates synthetic baseline lists and screens its parties through the real worker path (`screenSubject`, the
 * database rechecks every result). Every list entry here is invented and labelled synthetic; none is, or is meant to
 * resemble, a listed person or company. Everything runs on the owner connection in maintenance transactions (tests
 * only); the shortcuts that move a match or a hold directly are fixtures for the gate's inputs, never product paths.
 */
export const SYNTHETIC_SDN: FakeListEntry[] = [
  { uid: '940001', type: 'individual', firstName: 'Zorvan Q', lastName: 'EXAMPLETON', programs: ['SYNTHETIC-A'] },
  { uid: '940002', type: 'entity', lastName: 'NORTHWIND SYNTHETIC SUPPLY LLC', programs: ['SYNTHETIC-C'] },
];
export const SYNTHETIC_CONS: FakeListEntry[] = [{ uid: '950001', type: 'individual', firstName: 'Petra', lastName: 'SAMPLEWOOD', programs: ['SYNTHETIC-D'] }];
/** Names that match the synthetic entries by the engine rule. */
export const LISTED_PERSON_NAME = 'Zorvan Q Exampleton';
export const LISTED_COMPANY_NAME = 'Northwind Synthetic Supply LLC';
const CONFIG: ScreeningConfig = { fuzzyThreshold: null, vesselsAndAircraft: false, sweepBatch: 500 };

const owner = <T>(admin: DataPool, fn: Parameters<typeof withMaintenance<T>>[1]) => withMaintenance(admin, fn);

/** Stages and activates one version of a baseline list inside the caller's transaction (it locks the list row). */
export async function stageAndActivate(trx: Transaction, code: 'ofac-sdn' | 'ofac-cons', entries: readonly FakeListEntry[], publishedOn = '2026-10-20'): Promise<string> {
  const parsed = parseOfacSlsXml(renderOfacSlsXml({ publishedOn, entries }));
  const list = await sql<{ id: string }>`SELECT id FROM trustwork.screening_list WHERE code = ${code} AND baseline`.execute(trx);
  const listId = list.rows[0]?.id as string;
  await sql`UPDATE trustwork.screening_list SET min_entries = 1, max_drop_share = 0.99 WHERE id = ${listId}::uuid`.execute(trx);
  const locked = await screeningListWorker.lock(trx, listId);
  const sanity = checkListSanity({ parsedCount: parsed.entries.length, declaredCount: parsed.declaredCount, previousCount: locked?.active?.entryCount ?? null, maxDropShare: 0.99, minEntries: 1 });
  const versionId = await screeningListWorker.stage(trx, {
    listId, publishedOn: parsed.publishedOn, fetchedAt: new Date(), mode: 'file', sourceDigest: sourceDigest(listDigest(parsed.entries)), digest: listDigest(parsed.entries), sanity, entries: parsed.entries,
  });
  const outcome = await screeningListWorker.activate(trx, versionId);
  if (outcome !== 'activated') throw new Error(`list version not activated: ${outcome}`);
  return versionId;
}
export function activateBaselineList(admin: DataPool, code: 'ofac-sdn' | 'ofac-cons', entries: readonly FakeListEntry[], publishedOn = '2026-10-20'): Promise<string> {
  return owner(admin, (trx) => stageAndActivate(trx, code, entries, publishedOn));
}

/** Both baseline lists active and fresh, unless they already are. */
export async function activateBaseline(admin: DataPool): Promise<void> {
  const { rows } = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM trustwork.screening_list l JOIN trustwork.screening_list_version v ON v.list_id = l.id AND v.state = 'active' WHERE l.baseline");
  if (Number(rows[0]?.n ?? 0) >= 2) return;
  await activateBaselineList(admin, 'ofac-sdn', SYNTHETIC_SDN);
  await activateBaselineList(admin, 'ofac-cons', SYNTHETIC_CONS);
}

/** One screening through the worker's own code path (the database rechecks it). */
export function screen(admin: DataPool, subject: ScreeningSubjectRef, trigger: 'registration' | 'counterparty' | 'payee' | 'name_change' | 'scheduled' = 'registration') {
  return owner(admin, (trx) => screenSubject(trx, subject, trigger, CONFIG));
}

/**
 * Activates the baseline (if needed) and screens every person and company of the database. A subject whose name is a
 * single word stays `insufficient_name` (and a gate refuses it); the counts are returned for diagnostics.
 */
export async function screenEveryoneClear(admin: DataPool): Promise<Record<string, number>> {
  await activateBaseline(admin);
  const { rows } = await admin.query<{ kind: 'person' | 'company'; id: string }>("SELECT 'person' AS kind, id FROM trustwork.person UNION ALL SELECT 'company', id FROM trustwork.company ORDER BY 1, 2");
  const counts: Record<string, number> = {};
  for (const subject of rows) {
    const { outcome } = await screen(admin, subject);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

/** Renames a subject (the database appends the rename event) without screening it. */
export async function rename(admin: DataPool, subject: ScreeningSubjectRef, name: string): Promise<void> {
  await owner(admin, (trx) => (subject.kind === 'person'
    ? sql`UPDATE trustwork.person SET display_name = ${name} WHERE id = ${subject.id}::uuid`
    : sql`UPDATE trustwork.company SET display_name = ${name} WHERE id = ${subject.id}::uuid`).execute(trx));
}

/** Fixture: moves every unresolved match of the subject along the allowed transitions to `confirmed` or `not_same_person`, then recomputes its state. */
export async function decideMatches(admin: DataPool, subject: ScreeningSubjectRef, to: 'confirmed' | 'not_same_person'): Promise<void> {
  await owner(admin, async (trx) => {
    const col = subject.kind === 'person' ? sql.raw('subject_person_id') : sql.raw('subject_company_id');
    if (to === 'confirmed') await sql`UPDATE trustwork.screening_match SET state = 'confirmed', decided_at = now() WHERE ${col} = ${subject.id}::uuid AND state = 'open'`.execute(trx);
    else {
      await sql`UPDATE trustwork.screening_match SET state = 'appeal' WHERE ${col} = ${subject.id}::uuid AND state = 'confirmed'`.execute(trx);
      await sql`UPDATE trustwork.screening_match SET state = 'pending_reversal' WHERE ${col} = ${subject.id}::uuid AND state = 'appeal'`.execute(trx);
      await sql`UPDATE trustwork.screening_match SET state = 'pending_second' WHERE ${col} = ${subject.id}::uuid AND state = 'open'`.execute(trx);
      await sql`UPDATE trustwork.screening_match SET state = 'not_same_person', decided_at = now() WHERE ${col} = ${subject.id}::uuid AND state IN ('pending_second', 'pending_reversal')`.execute(trx);
    }
    await sql`SELECT trustwork.screening_recompute(s.id) FROM trustwork.screening_subject_state s WHERE s.${col} = ${subject.id}::uuid`.execute(trx);
  });
}

/** Fixture: an open jurisdiction hold of a person (source staff_report), as a sighting would leave it. */
export async function holdPerson(admin: DataPool, personId: string, place = 'CU'): Promise<void> {
  await owner(admin, (trx) => sql`INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset) VALUES (${personId}::uuid, ${place}, 'staff_report', 'fixture')
    ON CONFLICT (person_id) WHERE cleared_at IS NULL DO NOTHING`.execute(trx));
}
/** Fixture: clears a person's open hold (by another person, with a reason and an evidence category). */
export async function clearHold(admin: DataPool, personId: string, clearedBy: string): Promise<void> {
  await owner(admin, (trx) => sql`UPDATE trustwork.jurisdiction_hold SET cleared_at = now(), cleared_by = ${clearedBy}::uuid, clear_reason = 'fixture: not in a restricted place', clear_evidence = 'other'
    WHERE person_id = ${personId}::uuid AND cleared_at IS NULL`.execute(trx));
}

/** Fixture: the baseline lists' content last confirmed long ago (stale) or now (fresh). */
export async function setBaselineStale(admin: DataPool, stale: boolean): Promise<void> {
  await owner(admin, (trx) => (stale
    ? sql`UPDATE trustwork.screening_list SET last_checked_at = now() - interval '30 days' WHERE baseline`
    : sql`UPDATE trustwork.screening_list SET last_checked_at = now() WHERE baseline`).execute(trx));
}

/** A new version of the consolidated baseline list: every earlier `clear` is due for re-screening (`rescreen_due`). */
export const nextConsEntries = (uid: string): FakeListEntry[] => [...SYNTHETIC_CONS, { uid, type: 'individual', firstName: 'Ansel', lastName: 'MOCKRIDGE', programs: ['SYNTHETIC-D'] }];
export function newBaselineVersion(admin: DataPool, uid: string): Promise<string> {
  return activateBaselineList(admin, 'ofac-cons', nextConsEntries(uid), '2026-10-27');
}

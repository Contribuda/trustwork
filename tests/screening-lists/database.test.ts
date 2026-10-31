import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { parseOfacSlsXml, listDigest, sourceDigest } from '../../packages/compliance/src/lists/index.js';
import { checkListSanity } from '../../packages/contracts/src/sanctions.js';
import { screeningFreshness, screeningListsStaff, screeningListWorker } from '../../packages/data/src/repositories/screening-lists.js';
import { TABLE_COLUMNS } from '../../packages/data/src/schema/screening-lists.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects, settle } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { baselineIds, complianceWorld, fixture } from './helpers.js';

const env = await provisionWorkerDatabase('screening_lists_db');
const DAY = 86_400_000;

/**
 * SANC-002 persistence on real PostgreSQL with the runtime, worker and owner roles: the baseline lists cannot be
 * paused or deleted by anyone or through the console path, versions and entries are immutable, activation rechecks
 * what was written, and freshness follows the clock so a stale baseline makes screening unavailable.
 */
test('SANC-002 screening lists: baseline guard rails, immutable versions, console paths, freshness', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const runtime = env.apiPool;
  const worker = env.workerPool(4);
  const { w, as, elevate, owner } = await complianceWorld(admin, runtime);
  const p = w.people;
  const ids = await baselineIds(admin);
  const sdn = parseOfacSlsXml(fixture('ofac-sdn-synthetic.xml'));
  const cons = parseOfacSlsXml(fixture('ofac-cons-synthetic.xml'));
  // The seeded minimums are for the real exports; the synthetic fixtures are small.
  await owner((trx) => trx.updateTable('screening_list').set({ min_entries: 1 }).where('baseline', '=', true).execute());

  const stage = (listId: string, list = sdn, options: { entries?: typeof sdn.entries; entryCount?: number; fetchedAt?: Date } = {}) => tx(worker, async (trx) => {
    const entries = options.entries ?? list.entries;
    const locked = await screeningListWorker.lock(trx, listId);
    const sanity = checkListSanity({ parsedCount: options.entryCount ?? list.entries.length, declaredCount: list.declaredCount, previousCount: locked?.active?.entryCount ?? null, maxDropShare: locked?.maxDropShare ?? 0.1, minEntries: 1 });
    const versionId = await screeningListWorker.stage(trx, { listId, publishedOn: list.publishedOn, fetchedAt: options.fetchedAt ?? new Date(), mode: 'file', sourceDigest: sourceDigest(listDigest(list.entries)), digest: listDigest(list.entries), sanity, entries });
    return versionId;
  });
  const activate = (versionId: string) => tx(worker, (trx) => screeningListWorker.activate(trx, versionId));

  await t.test('two baseline lists are seeded in file mode; with no version screening is unavailable', async () => {
    const lists = await withMaintenance(admin, (trx) => trx.selectFrom('screening_list').selectAll().orderBy('code').execute());
    assert.deepEqual(lists.map((l) => [l.code, l.baseline, l.mode, l.status, l.adapter, l.hub_id]), [['ofac-cons', true, 'file', 'active', 'ofac-sls-xml', null], ['ofac-sdn', true, 'file', 'active', 'ofac-sls-xml', null]]);
    const availability = await tx(runtime, (trx) => screeningFreshness.availability(trx));
    assert.equal(availability.available, false);
    assert.deepEqual(availability.reasons.map((r) => `${r.reason}:${r.code}`).sort(), ['baseline_missing:ofac-cons', 'baseline_missing:ofac-sdn']);
    assert.equal(await tx(worker, (trx) => screeningFreshness.available(trx)), false, 'the worker reads the same answer');
  });

  await t.test('the runtime role cannot write, pause, delete or truncate lists, versions or entries; only compliance staff read', async () => {
    const statements = [
      `UPDATE trustwork.screening_list SET status = 'paused' WHERE id = '${ids.sdn}'`,
      `DELETE FROM trustwork.screening_list WHERE id = '${ids.sdn}'`,
      "INSERT INTO trustwork.screening_list (code, name, authority, source_url, adapter, mode, cadence, warn_after, stale_after, baseline) VALUES ('x-list', 'x', 'x', 'https://example.invalid', 'ofac-sls-xml', 'file', '1 day', '2 days', '3 days', true)",
      'TRUNCATE trustwork.screening_list',
      'DELETE FROM trustwork.screening_list_version',
      'DELETE FROM trustwork.screening_list_entry',
      "UPDATE trustwork.screening_list_version SET state = 'superseded'",
    ];
    for (const statement of statements) {
      await rejects(runtime.query(statement), '42501');
      await rejects(as(p.moderator, (trx) => sql.raw(statement).execute(trx)), '42501');
    }
    assert.equal((await as(p.customer, (trx) => screeningListsStaff.lists(trx))).length, 0, 'a participant reads nothing');
    assert.equal((await as(p.agent, (trx) => screeningListsStaff.lists(trx))).length, 0, 'staff without a compliance role read nothing');
    assert.equal((await as(p.auditor, (trx) => screeningListsStaff.lists(trx))).length, 2);
    assert.equal((await as(p.moderator, (trx) => screeningListsStaff.lists(trx))).length, 2);
    // The worker has no table grant; the runtime role cannot run the worker entry points; the worker cannot run console commands.
    await rejects(worker.query('SELECT * FROM trustwork.screening_list'), '42501');
    await rejects(runtime.query('SELECT trustwork.screening_list_activate($1)', [ids.sdn]), '42501');
    await rejects(runtime.query('SELECT * FROM trustwork.screening_list_lock($1)', [ids.sdn]), '42501');
    await rejects(runtime.query("SELECT trustwork.screening_list_record_attempt($1, 'unchanged', NULL, now())", [ids.sdn]), '42501');
    await rejects(worker.query("SELECT trustwork.screening_list_set_status('{}'::jsonb, $1, 'paused', 'x')", [ids.sdn]), '42501');
  });

  await t.test('no role, the owner included, can pause, delete, rescope or loosen a baseline list', async () => {
    await rejects(owner((trx) => trx.updateTable('screening_list').set({ status: 'paused' }).where('id', '=', ids.sdn).execute()), '23514', 'screening.baseline_list');
    await rejects(owner((trx) => trx.deleteFrom('screening_list').where('id', '=', ids.cons).execute()), '23514', 'screening.baseline_list');
    await rejects(owner((trx) => trx.updateTable('screening_list').set({ code: 'renamed' }).where('id', '=', ids.sdn).execute()), '23514', 'screening.list_immutable');
    await rejects(owner((trx) => trx.updateTable('screening_list').set({ hub_id: w.hubId }).where('id', '=', ids.sdn).execute()), '23514', 'screening.list_immutable');
    await rejects(owner((trx) => trx.updateTable('screening_list').set({ adapter: 'other-adapter' }).where('id', '=', ids.sdn).execute()), '23514', 'screening.baseline_list');
    await rejects(owner((trx) => trx.updateTable('screening_list').set({ stale_after: '15 days' }).where('id', '=', ids.sdn).execute()), '23514');
    await rejects(admin.query('TRUNCATE trustwork.screening_list CASCADE'), '23000');
  });

  let hubList = '';
  await t.test('console path: a compliance officer under an elevation pauses an additional list, never a baseline list; audited', async () => {
    hubList = (await owner((trx) => trx.insertInto('screening_list').values({
      hub_id: w.hubId, code: 'synthetic-national', name: 'Synthetic national list', authority: 'Synthetic authority', source_url: 'https://example.invalid/list.xml', adapter: 'ofac-sls-xml',
      mode: 'file', cadence: '1 day', warn_after: '3 days', stale_after: '20 days', max_drop_share: '0.2',
    }).returning('id').executeTakeFirstOrThrow())).id;
    const officer = await elevate(p.moderator);
    await rejects(as(p.moderator, (trx) => screeningListsStaff.setStatus(trx, officer, { listId: ids.sdn, status: 'paused', reason: 'Synthetic: try to pause the baseline' })), '42501', 'screening.baseline_list');
    await rejects(as(p.moderator, (trx) => screeningListsStaff.setStatus(trx, officer, { listId: ids.cons, status: 'paused', reason: 'Synthetic' })), '42501', 'screening.baseline_list');
    const auditorCtx = await elevate(p.auditor);
    await rejects(as(p.auditor, (trx) => screeningListsStaff.setStatus(trx, auditorCtx, { listId: hubList, status: 'paused', reason: 'Synthetic' })), '42501', 'admin.forbidden');
    await rejects(as(p.moderator, (trx) => screeningListsStaff.setStatus(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'req-x', reasonCode: 'x', reasonText: 'x' }, { listId: hubList, status: 'paused', reason: 'Synthetic' })), '42501', 'admin.elevation_required');
    await rejects(as(p.moderator, (trx) => screeningListsStaff.setStatus(trx, officer, { listId: hubList, status: 'paused', reason: ' ' })), '22023', 'screening.reason_required');
    const paused = await as(p.moderator, (trx) => screeningListsStaff.setStatus(trx, officer, { listId: hubList, status: 'paused', reason: 'Synthetic: source moved' }));
    assert.equal(paused.status, 'paused');
    const audit = await admin.query<{ actor_person_id: string; permission: string }>("SELECT actor_person_id, permission FROM trustwork.admin_audit_event WHERE action = 'screening.list_status_set' AND object_id = $1", [hubList]);
    assert.deepEqual(audit.rows, [{ actor_person_id: p.moderator, permission: 'admin.screening.lists.manage' }]);
    const states = await tx(runtime, (trx) => screeningFreshness.lists(trx));
    assert.equal(states.find((s) => s.listId === hubList)?.state, 'paused');
    await as(p.moderator, (trx) => screeningListsStaff.setStatus(trx, officer, { listId: hubList, status: 'active', reason: 'Synthetic: source back' }));
    const baselineRows = await admin.query<{ status: string }>('SELECT status FROM trustwork.screening_list WHERE baseline');
    assert.ok(baselineRows.rows.every((r) => r.status === 'active'), 'the baseline lists stayed active');
  });

  let sdnV1 = '';
  await t.test('a staged version activates only when the written entries match its count and digest; versions and entries never change', async () => {
    const partial = await stage(ids.sdn, sdn, { entries: sdn.entries.slice(0, 4) });
    assert.equal(await activate(partial), 'rejected', 'two entries missing: the database refuses to activate');
    const row = (await admin.query<{ state: string; rejected_reason: string }>('SELECT state, rejected_reason FROM trustwork.screening_list_version WHERE id = $1', [partial])).rows[0];
    assert.deepEqual(row, { state: 'rejected', rejected_reason: 'entries_mismatch' });
    sdnV1 = await stage(ids.sdn);
    assert.equal(await activate(sdnV1), 'activated');
    const event = await admin.query<{ type: string; payload: { listCode: string; versionId: string; baseline: boolean; entryCount: number; previousVersionId: string | null } }>(
      "SELECT type, payload FROM trustwork.outbox_event WHERE aggregate_kind = 'screening_list' AND aggregate_id = $1", [ids.sdn]);
    assert.equal(event.rows.length, 1);
    assert.equal(event.rows[0]?.type, 'screening.list_version_activated');
    assert.deepEqual([event.rows[0]?.payload.listCode, event.rows[0]?.payload.versionId, event.rows[0]?.payload.baseline, event.rows[0]?.payload.entryCount, event.rows[0]?.payload.previousVersionId], ['ofac-sdn', sdnV1, true, 6, null]);
    await rejects(owner((trx) => trx.updateTable('screening_list_version').set({ digest: '0'.repeat(64) }).where('id', '=', sdnV1).execute()), '23514', 'screening.version_immutable');
    await rejects(owner((trx) => trx.updateTable('screening_list_version').set({ state: 'staged' }).where('id', '=', sdnV1).execute()), '23514', 'screening.version_transition');
    await rejects(owner((trx) => trx.deleteFrom('screening_list_version').where('id', '=', sdnV1).execute()), '23514', 'screening.version_permanent');
    await rejects(owner((trx) => trx.updateTable('screening_list_entry').set({ primary_name: 'rewritten' }).where('list_version_id', '=', sdnV1).execute()), '23514', 'screening.entry_permanent');
    await rejects(owner((trx) => trx.deleteFrom('screening_list_entry').where('list_version_id', '=', sdnV1).execute()), '23514', 'screening.entry_permanent');
    await rejects(tx(worker, (trx) => screeningListWorker.reject(trx, sdnV1, 'late')), '23514', 'screening.version_not_staged');
    await rejects(admin.query("SELECT trustwork.screening_list_add_entries($1, '[{\"entry_uid\":\"999\",\"entry_type\":\"entity\",\"primary_name\":\"Late Synthetic\",\"name_keys\":[\"late synthetic\"],\"entry_digest\":\"" + 'a'.repeat(64) + "\"}]'::jsonb)", [sdnV1]), '23514', 'screening.version_not_staged');
    const columns = await admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = 'screening_list_entry'");
    assert.deepEqual(columns.rows.map((r) => r.column_name).sort(), [...TABLE_COLUMNS.screening_list_entry].sort());
    const entries = await as(p.auditor, (trx) => screeningListsStaff.entries(trx, sdnV1));
    assert.deepEqual(entries.find((e) => e.entry_uid === '910001')?.name_keys, ['anna demonova testova', 'anna testova']);
  });

  await t.test('one active and one staged version per list, even when two stagings race', async () => {
    const outcomes = await Promise.all([settle(stage(ids.cons, cons)), settle(stage(ids.cons, cons))]);
    assert.deepEqual(outcomes, [null, null], 'the list lock serialises the two stagings');
    const states = await admin.query<{ state: string; rejected_reason: string | null }>('SELECT state, rejected_reason FROM trustwork.screening_list_version WHERE list_id = $1 ORDER BY version', [ids.cons]);
    assert.deepEqual(states.rows, [{ state: 'rejected', rejected_reason: 'replaced' }, { state: 'staged', rejected_reason: null }], 'the later staging replaced the earlier one');
    const staged = (await admin.query<{ id: string }>("SELECT id FROM trustwork.screening_list_version WHERE list_id = $1 AND state = 'staged'", [ids.cons])).rows[0]?.id as string;
    const raced = await Promise.all([settle(activate(staged)), settle(activate(staged))]);
    assert.equal(raced.filter((r) => r === null).length, 1, 'exactly one activation');
    assert.equal(raced.find((r) => r !== null)?.hint, 'screening.version_not_staged');
    const active = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.screening_list_version WHERE list_id = $1 AND state = 'active'", [ids.cons]);
    assert.equal(active.rows[0]?.n, 1);
  });

  await t.test('a drop beyond the share waits staged; only a compliance officer confirms it, audited', async () => {
    const reduced = parseOfacSlsXml(fixture('ofac-sdn-synthetic.xml').replace(/<sdnEntry>\s*<uid>910004<\/uid>[\s\S]*?<\/sdnEntry>\s*<sdnEntry>\s*<uid>910005<\/uid>[\s\S]*?<\/sdnEntry>/, '').replace('<Record_Count>6</Record_Count>', '<Record_Count>4</Record_Count>'));
    assert.equal(reduced.entries.length, 4);
    const version = await stage(ids.sdn, reduced);
    assert.equal(await activate(version), 'needs_confirmation');
    assert.equal((await admin.query<{ id: string }>("SELECT id FROM trustwork.screening_list_version WHERE list_id = $1 AND state = 'active'", [ids.sdn])).rows[0]?.id, sdnV1, 'the previous version stays active');
    const auditorCtx = await elevate(p.auditor);
    await rejects(as(p.auditor, (trx) => screeningListsStaff.confirmVersion(trx, auditorCtx, { versionId: version, reason: 'Synthetic' })), '42501', 'admin.forbidden');
    await rejects(as(p.moderator, (trx) => screeningListsStaff.confirmVersion(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'r', reasonCode: 'x', reasonText: 'x' }, { versionId: version, reason: 'x' })), '42501', 'admin.elevation_required');
    const officer = await elevate(p.lead);
    await rejects(as(p.lead, (trx) => screeningListsStaff.confirmVersion(trx, officer, { versionId: sdnV1, reason: 'Synthetic' })), '23514', 'screening.confirmation_not_needed');
    assert.equal(await as(p.lead, (trx) => screeningListsStaff.confirmVersion(trx, officer, { versionId: version, reason: 'Synthetic: two entries were delisted in this publication' })), 'activated');
    const row = (await admin.query<{ state: string; activated_by: string; activation_reason: string }>('SELECT state, activated_by, activation_reason FROM trustwork.screening_list_version WHERE id = $1', [version])).rows[0];
    assert.deepEqual(row, { state: 'active', activated_by: p.lead, activation_reason: 'Synthetic: two entries were delisted in this publication' });
    assert.equal((await admin.query<{ state: string }>('SELECT state FROM trustwork.screening_list_version WHERE id = $1', [sdnV1])).rows[0]?.state, 'superseded');
    const audit = await admin.query<{ actor_person_id: string; permission: string }>("SELECT actor_person_id, permission FROM trustwork.admin_audit_event WHERE action = 'screening.list_version_confirmed' AND object_id = $1", [version]);
    assert.deepEqual(audit.rows, [{ actor_person_id: p.lead, permission: 'admin.screening.lists.confirm' }]);
    const event = await admin.query<{ payload: { confirmedBy: string; previousVersionId: string } }>("SELECT payload FROM trustwork.outbox_event WHERE aggregate_kind = 'screening_list' AND payload->>'versionId' = $1", [version]);
    assert.equal(event.rows[0]?.payload.confirmedBy, p.lead);
    assert.equal(event.rows[0]?.payload.previousVersionId, sdnV1);
  });

  await t.test('clock: both baseline lists active makes screening available; past the stale age it is unavailable again', async () => {
    const now = Date.now();
    assert.equal(await tx(runtime, (trx) => screeningFreshness.available(trx)), true);
    const later = (days: number) => new Date(now + days * DAY);
    const warning = await tx(runtime, (trx) => screeningFreshness.availability(trx, later(4)));
    assert.equal(warning.available, true);
    assert.ok(warning.lists.filter((l) => l.baseline).every((l) => l.state === 'warning'));
    const stale = await tx(runtime, (trx) => screeningFreshness.availability(trx, later(8)));
    assert.equal(stale.available, false);
    assert.deepEqual(stale.reasons.map((r) => `${r.reason}:${r.code}`).sort(), ['baseline_stale:ofac-cons', 'baseline_stale:ofac-sdn']);
    assert.equal(await tx(runtime, (trx) => screeningFreshness.available(trx, later(8))), false, 'the database function agrees');
    assert.equal(stale.lists.find((l) => l.listId === hubList)?.state, 'missing', 'the additional list has no version, which does not decide availability');
    // A caller cannot make a list look younger by asking about the past.
    await owner((trx) => trx.updateTable('screening_list').set({ last_checked_at: new Date(now - 10 * DAY) }).where('id', '=', ids.sdn).execute());
    const past = await tx(runtime, (trx) => screeningFreshness.availability(trx, new Date(now - 9 * DAY)));
    assert.equal(past.lists.find((l) => l.code === 'ofac-sdn')?.state, 'stale');
    assert.equal(past.available, false);
    // A confirmation from the source moves the clock forward again, never backwards and never past now.
    await tx(worker, (trx) => screeningListWorker.recordAttempt(trx, { listId: ids.sdn, outcome: 'unchanged', error: null, confirmedAt: new Date(now + DAY) }));
    const checked = (await admin.query<{ last_checked_at: Date }>('SELECT last_checked_at FROM trustwork.screening_list WHERE id = $1', [ids.sdn])).rows[0]?.last_checked_at as Date;
    assert.ok(checked.getTime() <= Date.now() + 1000 && checked.getTime() >= now - 1000);
    await tx(worker, (trx) => screeningListWorker.recordAttempt(trx, { listId: ids.sdn, outcome: 'unchanged', error: null, confirmedAt: new Date(now - 5 * DAY) }));
    assert.equal(((await admin.query<{ last_checked_at: Date }>('SELECT last_checked_at FROM trustwork.screening_list WHERE id = $1', [ids.sdn])).rows[0]?.last_checked_at as Date).getTime(), checked.getTime());
    assert.equal(await tx(runtime, (trx) => screeningFreshness.available(trx)), true);
  });
});

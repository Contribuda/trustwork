import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { principalFor } from '../data/helpers/seed.js';
import { externalCounterparties, supplierAssessments, supplierRecords } from '../../packages/data/src/repositories/supplier-base.js';
import { as, count, fails, fields, seedWorld, syncKernel, uuid, type World } from './helpers.js';

/**
 * PRC-003 under the real runtime role (FORCE RLS, owner-run commands, no mocks): who may maintain the base, link rules
 * that read only the public claim status, restricted regions, visibility (the supplier, other buyers and members of
 * other companies see nothing), one record per supplier, the forward-only move to a claimed company, frozen
 * assessments that can never be a reputation input, the supplier's narrow view of a shared assessment, no outbox
 * event from any command, and concurrent writes resolving once.
 */
const h = await startHarness('supplier_base_db');

test('supplier base database: authority, links, visibility, assessments, no events and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await syncKernel(h.db.admin);
  const w: World = await seedWorld(h, 'db');
  const outboxBefore = await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event');
  const counterparty = (p: 'ada' | 'rita' | 'mia' | 'sam' | 'otto', name: string, company = w.buyer) =>
    as(h, w, p, (trx) => externalCounterparties.create(trx, { companyId: company, name, identifiers: [{ kind: 'us_ein', value: '00-0000001' }], contacts: [{ role: 'sales', channel: 'email', value: 'sales@example.invalid' }], source: 'manual' }));

  await t.test('authority: administrators and holders of procurement.suppliers.manage maintain; others are refused', async () => {
    await fails(counterparty('mia', 'Synthetic Refused One'), 'supplier_base.not_authorised');
    await fails(counterparty('otto', 'Synthetic Refused Two'), 'supplier_base.not_authorised');
    await fails(counterparty('sam', 'Synthetic Refused Three'), 'supplier_base.not_authorised');
    await fails(as(h, w, 'mia', (trx) => supplierRecords.create(trx, { companyId: w.buyer, link: { kind: 'company', id: w.supplier }, ...fields() })), 'supplier_base.not_authorised');
    const byAdmin = await counterparty('ada', 'Synthetic Timber Yard');
    const byGrant = await counterparty('rita', 'Synthetic Steel Works');
    assert.equal(byAdmin.source, 'manual');
    assert.equal(byGrant.owner_company_id, w.buyer);
    // The runtime role writes nothing directly and never deletes.
    await fails(as(h, w, 'ada', (trx) => trx.insertInto('supplier_record').values({ owner_company_id: w.buyer, linked_company_id: w.supplier, created_by_person_id: w.people.ada }).execute()), '42501');
    await fails(as(h, w, 'ada', (trx) => trx.updateTable('external_counterparty').set({ name: 'Synthetic Renamed' }).where('id', '=', byAdmin.id).execute()), '42501');
    await fails(as(h, w, 'ada', (trx) => trx.deleteFrom('external_counterparty').where('id', '=', byAdmin.id).execute()), '42501');
    await fails(withMaintenance(h.db.admin, (trx) => trx.deleteFrom('external_counterparty').where('id', '=', byAdmin.id).execute()), 'supplier_base.record_permanent');
  });

  await t.test('links: a platform company must be claimed or verified, a sourced record unclaimed, a counterparty the buyer\'s own; regions are never restricted', async () => {
    const create = (link: { kind: 'company' | 'sourced_company' | 'external_counterparty'; id: string }, over = {}) => as(h, w, 'ada', (trx) => supplierRecords.create(trx, { companyId: w.buyer, link, ...fields(over) }));
    await fails(create({ kind: 'company', id: w.sourced }), 'supplier_base.invalid_link');
    await fails(create({ kind: 'sourced_company', id: w.supplier }), 'supplier_base.invalid_link');
    await fails(create({ kind: 'company', id: w.buyer }), 'supplier_base.invalid_link');
    await fails(create({ kind: 'company', id: uuid() }), 'supplier_base.not_found');
    // The other buyer's administrator maintains its own base; its counterparty is not ours to link.
    const ottoOwn = await counterparty('otto', 'Synthetic Elsewhere Counterparty', w.otherBuyer);
    await fails(create({ kind: 'external_counterparty', id: ottoOwn.id }), 'supplier_base.not_found');
    await fails(create({ kind: 'company', id: w.supplier }, { regions: ['RU'] }), 'supplier_base.restricted_place');
    await fails(create({ kind: 'company', id: w.supplier }, { regions: ['UA-43'] }), 'supplier_base.restricted_place');
    await fails(create({ kind: 'company', id: w.supplier }, { regions: ['texas'] }), 'supplier_base.invalid_region');
    await fails(create({ kind: 'company', id: w.supplier }, { onboarding: [{ key: 'ofac', kind: 'screening', documentTypeKey: null, state: 'complete' }] }), '23514');
    const record = await create({ kind: 'company', id: w.supplier }, { status: 'preferred', regions: ['US-TX'], internalNotes: 'PRIVATE-NOTE slow on paperwork', onboarding: [{ key: 'w9', kind: 'document', documentTypeKey: 'us.irs.w9', state: 'received' }] });
    assert.equal(record.linked_company_id, w.supplier);
    assert.equal(record.status, 'preferred');
    // Nothing was written to the supplier's company row.
    const company = await h.db.admin.query<{ revision: number; claim_status: string }>('SELECT revision, claim_status FROM trustwork.company WHERE id = $1', [w.supplier]);
    assert.deepEqual(company.rows[0], { revision: 1, claim_status: 'claimed' });
    await fails(create({ kind: 'company', id: w.supplier }), 'supplier_base.already_listed');
    const sourced = await create({ kind: 'sourced_company', id: w.sourced }, { status: 'prospect' });
    assert.equal(sourced.linked_sourced_company_id, w.sourced);
  });

  await t.test('visibility: members of the buying company only; the supplier, other buyers and other companies see nothing', async () => {
    const seen = async (p: 'ada' | 'rita' | 'mia' | 'sam' | 'sid' | 'otto') => as(h, w, p, async (trx) => ({
      records: (await trx.selectFrom('supplier_record').select('id').execute()).length,
      counterparties: (await trx.selectFrom('external_counterparty').select('id').execute()).length,
    }));
    const buyerView = await seen('mia');
    assert.ok(buyerView.records >= 2 && buyerView.counterparties >= 2, JSON.stringify(buyerView));
    assert.deepEqual(await seen('rita'), buyerView);
    assert.deepEqual(await seen('sam'), { records: 0, counterparties: 0 });
    assert.deepEqual(await seen('sid'), { records: 0, counterparties: 0 });
    assert.deepEqual(await seen('otto'), { records: 0, counterparties: 1 });
    // A former member sees nothing.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: w.people.ada, ended_reason: 'Synthetic: left the company' }).where('person_id', '=', w.people.mia).execute());
    const formerPrincipal = await principalFor(h.db.admin, w.people.mia);
    assert.equal(await withPrincipal(h.pool, formerPrincipal, async (trx) => (await trx.selectFrom('supplier_record').select('id').execute()).length), 0);
  });

  await t.test('forward-only links: a counterparty or a sourced record moves to the claimed company, never back', async () => {
    const cp = await counterparty('ada', 'Synthetic Gravel Joins Later');
    const record = await as(h, w, 'ada', (trx) => supplierRecords.create(trx, { companyId: w.buyer, link: { kind: 'external_counterparty', id: cp.id }, ...fields({ status: 'approved' }) }));
    await fails(as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: record.id, companyId: w.sourced, expectedRevision: record.revision })), 'supplier_base.invalid_link');
    await fails(as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: record.id, companyId: w.supplier, expectedRevision: record.revision })), 'supplier_base.already_listed');
    // The sourced company is claimed by its owners: the sourced record moves to it, and only to it.
    const sourcedRecord = (await h.db.admin.query<{ id: string; revision: number }>('SELECT id, revision FROM trustwork.supplier_record WHERE linked_sourced_company_id = $1', [w.sourced])).rows[0]!;
    await fails(as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: sourcedRecord.id, companyId: w.sourced, expectedRevision: sourcedRecord.revision })), 'supplier_base.invalid_link');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('company').set({ claim_status: 'claimed' }).where('id', '=', w.sourced).execute());
    await fails(as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: sourcedRecord.id, companyId: w.otherBuyer, expectedRevision: sourcedRecord.revision })), 'supplier_base.invalid_link');
    const moved = await as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: sourcedRecord.id, companyId: w.sourced, expectedRevision: sourcedRecord.revision }));
    assert.equal(moved.linked_company_id, w.sourced);
    assert.equal(moved.linked_sourced_company_id, null);
    // Now the counterparty can move to the same company? No: one record per supplier.
    await fails(as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: record.id, companyId: w.sourced, expectedRevision: record.revision })), 'supplier_base.already_listed');
    const linked = await as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: record.id, companyId: w.otherBuyer, expectedRevision: record.revision }));
    assert.equal(linked.linked_company_id, w.otherBuyer);
    const cpAfter = await h.db.admin.query<{ claimed_company_id: string }>('SELECT claimed_company_id FROM trustwork.external_counterparty WHERE id = $1', [cp.id]);
    assert.equal(cpAfter.rows[0]?.claimed_company_id, w.otherBuyer);
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('supplier_record').set({ linked_company_id: null, external_counterparty_id: cp.id }).where('id', '=', record.id).execute()), 'supplier_base.invalid_link');
    await fails(as(h, w, 'ada', (trx) => supplierRecords.linkClaimed(trx, { id: record.id, companyId: w.supplier, expectedRevision: linked.revision })), 'supplier_base.invalid_link');
  });

  await t.test('assessments: drafts freeze when recorded, never a reputation input, shared only with a platform company that may answer once', async () => {
    const record = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.supplier_record WHERE owner_company_id = $1 AND linked_company_id = $2', [w.buyer, w.supplier])).rows[0]!;
    const scores = [{ criterion: 'on_time', value: 4, evidenceRefs: [] }, { criterion: 'quality', value: 3, evidenceRefs: [uuid()] }];
    await fails(as(h, w, 'mia', (trx) => supplierAssessments.draft(trx, { supplierRecordId: record.id, from: '2026-07-01', to: '2026-09-30', criteriaVersion: 1, scores })), 'supplier_base.not_found');
    await fails(as(h, w, 'ada', (trx) => supplierAssessments.draft(trx, { supplierRecordId: record.id, from: '2026-07-01', to: '2026-09-30', criteriaVersion: 1, scores: [{ criterion: 'on_time', value: 7, evidenceRefs: [] }] })), '23514');
    const draft = await as(h, w, 'rita', (trx) => supplierAssessments.draft(trx, { supplierRecordId: record.id, from: '2026-07-01', to: '2026-09-30', criteriaVersion: 1, scores }));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.reputation_input, false);
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('supplier_assessment').set({ reputation_input: true } as never).where('id', '=', draft.id).execute()), '23514');
    const shared = await as(h, w, 'ada', (trx) => supplierAssessments.record(trx, { id: draft.id, share: true, expectedRevision: draft.revision }));
    assert.equal(shared.status, 'recorded');
    assert.equal(shared.shared_company_id, w.supplier);
    await fails(as(h, w, 'ada', (trx) => supplierAssessments.record(trx, { id: draft.id, share: false, expectedRevision: shared.revision })), 'supplier_base.invalid_transition');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('supplier_assessment').set({ scores: JSON.stringify([{ criterion: 'on_time', value: 5, evidenceRefs: [] }]) } as never).where('id', '=', draft.id).execute()), 'supplier_base.frozen');

    // A counterparty has nobody on the platform to share with.
    const cpRecord = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.supplier_record WHERE owner_company_id = $1 AND external_counterparty_id IS NOT NULL LIMIT 1', [w.buyer])).rows[0];
    if (cpRecord) {
      const cpDraft = await as(h, w, 'ada', (trx) => supplierAssessments.draft(trx, { supplierRecordId: cpRecord.id, from: '2026-07-01', to: '2026-09-30', criteriaVersion: 1, scores }));
      await fails(as(h, w, 'ada', (trx) => supplierAssessments.record(trx, { id: cpDraft.id, share: true, expectedRevision: cpDraft.revision })), 'supplier_base.not_shareable');
      await as(h, w, 'ada', (trx) => supplierAssessments.record(trx, { id: cpDraft.id, share: false, expectedRevision: cpDraft.revision }));
    }
    // An unshared recorded assessment of the same supplier stays invisible to it.
    const privateDraft = await as(h, w, 'ada', (trx) => supplierAssessments.draft(trx, { supplierRecordId: record.id, from: '2026-04-01', to: '2026-06-30', criteriaVersion: 1, scores }));
    await as(h, w, 'ada', (trx) => supplierAssessments.record(trx, { id: privateDraft.id, share: false, expectedRevision: privateDraft.revision }));

    const samSees = await as(h, w, 'sam', (trx) => supplierAssessments.sharedWithMe(trx, 50));
    assert.deepEqual(samSees.map((r) => r.id), [draft.id]);
    assert.deepEqual(Object.keys(samSees[0]!).sort(), ['assessed_at', 'buyer_company_id', 'criteria_version', 'id', 'period_from', 'period_to', 'responded_at', 'revision', 'scores', 'supplier_response']);
    assert.equal((await as(h, w, 'sam', (trx) => trx.selectFrom('supplier_assessment').select('id').execute())).length, 0);
    assert.equal((await as(h, w, 'otto', (trx) => supplierAssessments.sharedWithMe(trx, 50))).length, 0);
    await fails(as(h, w, 'sid', (trx) => supplierAssessments.respond(trx, { id: draft.id, response: 'Synthetic answer', expectedRevision: shared.revision })), 'supplier_base.not_authorised');
    await fails(as(h, w, 'otto', (trx) => supplierAssessments.respond(trx, { id: draft.id, response: 'Synthetic answer', expectedRevision: shared.revision })), 'supplier_base.not_found');
    await fails(as(h, w, 'sam', (trx) => supplierAssessments.respond(trx, { id: privateDraft.id, response: 'Synthetic answer', expectedRevision: 2 })), 'supplier_base.not_found');
    const answered = await as(h, w, 'sam', (trx) => supplierAssessments.respond(trx, { id: draft.id, response: 'Synthetic: the July delay was a carrier strike', expectedRevision: shared.revision }));
    assert.equal(answered.supplier_response, 'Synthetic: the July delay was a carrier strike');
    await fails(as(h, w, 'sam', (trx) => supplierAssessments.respond(trx, { id: draft.id, response: 'Synthetic second answer', expectedRevision: answered.revision })), 'supplier_base.already_answered');
    // Nothing about assessments reaches a reputation table.
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.reputation_snapshot WHERE subject_company_id = $1', [w.supplier]), 0);
  });

  await t.test('concurrency: two creates of the same supplier and two changes at one revision each resolve once', async () => {
    const cp = await counterparty('ada', 'Synthetic Concurrent Supplier');
    const attempts = await Promise.allSettled([0, 1].map((i) => as(h, w, i === 0 ? 'ada' : 'rita', (trx) => supplierRecords.create(trx, { companyId: w.buyer, link: { kind: 'external_counterparty', id: cp.id }, ...fields() }))));
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    const loser = attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    assert.equal((loser.reason as { hint?: string }).hint, 'supplier_base.already_listed');
    const record = (attempts.find((a) => a.status === 'fulfilled') as PromiseFulfilledResult<{ id: string; revision: number }>).value;
    const changes = await Promise.allSettled((['approved', 'on_hold'] as const).map((status, i) => as(h, w, i === 0 ? 'ada' : 'rita', (trx) => supplierRecords.update(trx, { id: record.id, expectedRevision: record.revision, ...fields({ status }) }))));
    assert.equal(changes.filter((c) => c.status === 'fulfilled').length, 1);
    assert.equal(((changes.find((c) => c.status === 'rejected') as PromiseRejectedResult).reason as { hint?: string }).hint, 'supplier_base.revision_conflict');
    const after = await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.supplier_record WHERE id = $1', [record.id]);
    assert.equal(after.rows[0]?.revision, record.revision + 1);
    // The same counterparty name twice in one base: one wins.
    const names = await Promise.allSettled([0, 1].map(() => counterparty('ada', 'Synthetic Twin Name')));
    assert.equal(names.filter((n) => n.status === 'fulfilled').length, 1);
  });

  await t.test('no outbox event: no notification, feed or index can learn that a supplier is listed', async () => {
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event'), outboxBefore);
    const payloads = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE payload::text LIKE '%' || $1::text || '%' OR aggregate_id::text = $2::text", [w.supplier, w.supplier]);
    assert.equal(payloads.rows[0]?.n, 0);
    // The policy helper answers only for the caller's own company.
    assert.equal(await as(h, w, 'sam', async (trx) => (await sql<{ v: boolean }>`SELECT trustwork.supplier_base_member(${w.buyer}::uuid) AS v`.execute(trx)).rows[0]?.v), false);
    assert.equal(await as(h, w, 'rita', (trx) => supplierRecords.mayManage(trx, w.buyer)), true);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { SupplierBaseService } from '../../apps/api/src/modules/supplier-base/supplier-base.service.js';
import { AllowListSupplierBaseMandates } from '../../apps/api/src/modules/supplier-base/mandates.js';
import { sanctionsScreening } from '../../apps/api/src/modules/supplier-base/screening.js';
import { FEDERATED_OBJECT_KINDS, GLOBAL_ID_KINDS, payloadProblems } from '../../packages/contracts/src/federation.js';
import { SourceKindSchema } from '../../packages/contracts/src/retrieval.js';
import { SUPPLIER_BASE_PRIVATE_FIELDS } from '../../packages/contracts/src/supply/suppliers.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { count, ok, seedDeal, seedWorld, signIn, syncKernel, uuid, xlsx, type Person, type World } from './helpers.js';

/**
 * PRC-003 through HTTP, against the acceptance criteria:
 * 1. A supplier never learns it is listed, its status or the notes: forbidden-field tests across every projection the
 *    supplier, other buyers and anonymous visitors can reach, the directory (the search surface), notifications (no
 *    outbox event, no mail) and federation (no federated kind; every buyer-side response carries a private marker the
 *    federation backstop refuses).
 * 2. An import never creates a directory member, a claim or a public record.
 * 3. Assessments never enter reputation snapshots.
 * Plus the HTTP journey, the supplier card from the buyer's own records, screening through SANC-003's port failing
 * closed, and agent parity under mandates.
 */
const h = await startHarness('supplier_base_api');

interface RecordView { audience: string; record: { id: string; status: string; revision: number; linkedCompanyId: string | null; externalCounterpartyId: string | null; internalNotes: string | null } }
interface CounterpartyView { audience: string; counterparty: { id: string; name: string; source: string; revision: number } }
interface AssessmentView { audience: string; assessment: { id: string; revision: number; state: string; sharedWithSupplier: boolean; reputationInput: false } }
interface CardView { audience: string; card: { history: { agreements: number; orders: number }; onTimeRate: string | null; publicFacts: { counterpartyStatus: string }; onboardingComplete: boolean; status: string }; coverage: Record<string, string>; screening: string; publicEntry: { id: string } | null }
interface ImportView { audience: string; outcome: string; rows: number; created: number; wouldCreate: number; skipped: { rowNumber: number; reason: string }[]; errors: { rowNumber: number; column: string; code: string }[]; recordIds: string[] }

const PRIVATE_NOTE = 'PRIVATE-NOTE-7f3c late twice, keep on hold';
const PRIVATE_TERMS = 'PRIVATE-TERMS Net 75 negotiated';
let keys = 0;
/** Commands that carry the idempotency key in the body send the same key in the header. */
const send = (client: Client, url: string, body: Record<string, unknown>) => {
  const key = `supplier-base-${++keys}`;
  return client.post(url, { ...body, idempotencyKey: key }, { idempotencyKey: key });
};
const text = (r: Response) => JSON.stringify(r.body);

test('supplier base API: journey, privacy across projections, search, notifications and federation, import, card, screening, snapshots and agents', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await syncKernel(h.db.admin);
  const w: World = await seedWorld(h, 'api');
  const clients = {} as Record<Person, Client>;
  for (const p of ['ada', 'rita', 'mia', 'sam', 'sid', 'otto'] as const) clients[p] = await signIn(h, p, 'api');
  const { ada, rita, mia, sam, sid, otto } = clients;
  const anonymous = h.client();

  // What the supplier, others and the public can see before the buyer lists anybody.
  const publicSurface = async () => ({
    companiesAnon: text(await anonymous.get('/v1/companies?limit=100')),
    companiesSam: text(await sam.get('/v1/companies?limit=100')),
    reputation: JSON.stringify(ok<Record<string, unknown>>(await anonymous.get(`/v1/reputation/companies/${w.supplier}`))),
    samBase: text(await sam.get('/v1/supplier-base/suppliers')),
    samShared: text(await sam.get('/v1/supplier-base/shared-assessments')),
  });
  const snapshotBefore = ok<{ inputsDigest: string; summary: unknown }>(await sam.post('/v1/reputation/snapshots', { subject: { kind: 'company', id: w.supplier } }), 201);
  const before = await publicSurface();
  const outboxBefore = await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event');
  const mailBefore = await count(h.db.admin, 'SELECT 1 FROM trustwork.mail_delivery');
  const companiesBefore = await count(h.db.admin, 'SELECT 1 FROM trustwork.company');

  let supplierRecord = '';
  let sharedAssessment = '';
  await t.test('journey: a member with procurement.suppliers.manage lists a platform supplier, changes it, assesses it; others are refused', async () => {
    const create = { supplierRecordId: null, link: { kind: 'company', id: w.supplier }, status: 'preferred', expectedRevision: 1, regions: ['US-TX'], categories: ['lumber'], internalNotes: PRIVATE_NOTE, defaultPaymentTerms: PRIVATE_TERMS };
    expectError(await send(mia, '/v1/supplier-base/suppliers', create), 403, 'access.forbidden');
    expectError(await send(sid, '/v1/supplier-base/suppliers', { ...create, link: { kind: 'company', id: w.buyer } }), 403, 'access.forbidden');
    expectError(await send(rita, '/v1/supplier-base/suppliers', { ...create, regions: ['RU-MOW'] }), 422, 'validation.schema');
    expectError(await send(rita, '/v1/supplier-base/suppliers', { ...create, link: { kind: 'sourced_company', id: w.supplier } }), 422, 'validation.schema');
    expectError(await rita.post('/v1/supplier-base/suppliers', { ...create, idempotencyKey: 'body-key' }, { idempotencyKey: 'header-key' }), 422, 'validation.schema');
    const created = ok<RecordView>(await send(rita, '/v1/supplier-base/suppliers', create));
    assert.equal(created.audience, 'party_private');
    assert.equal(created.record.status, 'preferred');
    supplierRecord = created.record.id;
    expectError(await send(ada, '/v1/supplier-base/suppliers', create), 409, 'validation.revision_conflict');
    // A status change keeps the notes; a stale revision is refused.
    const held = ok<RecordView>(await send(ada, '/v1/supplier-base/suppliers', { supplierRecordId: supplierRecord, link: create.link, status: 'on_hold', expectedRevision: created.record.revision }));
    assert.equal(held.record.status, 'on_hold');
    assert.equal(held.record.internalNotes, PRIVATE_NOTE);
    expectError(await send(ada, '/v1/supplier-base/suppliers', { supplierRecordId: supplierRecord, link: create.link, status: 'blocked', expectedRevision: created.record.revision }), 409, 'validation.revision_conflict');
    expectError(await send(ada, '/v1/supplier-base/suppliers', { supplierRecordId: supplierRecord, link: { kind: 'external_counterparty', id: uuid() }, status: 'blocked', expectedRevision: held.record.revision }), 422, 'validation.schema');
    const blocked = ok<RecordView>(await send(ada, '/v1/supplier-base/suppliers', { supplierRecordId: supplierRecord, link: create.link, status: 'blocked', expectedRevision: held.record.revision }));
    assert.equal(blocked.record.status, 'blocked');
    // Reads: members of the buying company; 404 for the supplier, the other buyer and members without a company.
    assert.equal(ok<RecordView>(await mia.get(`/v1/supplier-base/suppliers/${supplierRecord}`)).record.id, supplierRecord);
    for (const outsider of [sam, sid, otto]) {
      expectError(await outsider.get(`/v1/supplier-base/suppliers/${supplierRecord}`), 404, 'access.not_found');
      expectError(await outsider.get(`/v1/supplier-base/suppliers/${supplierRecord}/card`), 404, 'access.not_found');
      expectError(await outsider.get(`/v1/supplier-base/suppliers/${supplierRecord}/assessments`), 404, 'access.not_found');
    }
    expectError(await anonymous.get(`/v1/supplier-base/suppliers/${supplierRecord}`), 401, 'auth.session_invalid');
    assert.deepEqual(ok<{ items: unknown[] }>(await otto.get('/v1/supplier-base/suppliers')).items, []);

    const draft = ok<AssessmentView>(await rita.post(`/v1/supplier-base/suppliers/${supplierRecord}/assessments`, {
      supplierRecordId: supplierRecord, criteriaVersion: 1, period: { from: '2026-07-01', to: '2026-09-30' }, scores: [{ criterion: 'on_time', value: 2, evidenceRefs: [] }, { criterion: 'quality', value: 4, evidenceRefs: [] }],
    }), 201);
    assert.equal(draft.assessment.state, 'draft');
    assert.equal(draft.assessment.reputationInput, false);
    const recorded = ok<AssessmentView>(await send(ada, `/v1/supplier-base/assessments/${draft.assessment.id}/record`, { supplierRecordId: supplierRecord, assessmentDraftId: draft.assessment.id, shareWithSupplier: true, expectedRevision: draft.assessment.revision }));
    assert.equal(recorded.assessment.state, 'recorded');
    assert.equal(recorded.assessment.sharedWithSupplier, true);
    sharedAssessment = recorded.assessment.id;
    const unshared = ok<AssessmentView>(await rita.post(`/v1/supplier-base/suppliers/${supplierRecord}/assessments`, {
      supplierRecordId: supplierRecord, criteriaVersion: 1, period: { from: '2026-04-01', to: '2026-06-30' }, scores: [{ criterion: 'on_time', value: 1, evidenceRefs: [] }],
    }), 201);
    ok(await send(ada, `/v1/supplier-base/assessments/${unshared.assessment.id}/record`, { supplierRecordId: supplierRecord, assessmentDraftId: unshared.assessment.id, shareWithSupplier: false, expectedRevision: unshared.assessment.revision }));
    assert.equal(ok<{ items: unknown[] }>(await mia.get(`/v1/supplier-base/suppliers/${supplierRecord}/assessments`)).items.length, 2);
  });

  await t.test('acceptance 1: the supplier never learns it is listed, its status or the notes (projections, search, notifications, federation)', async () => {
    // The supplier's own view of the shared assessment: the assessment, never the record.
    const shared = ok<{ audience: string; items: Record<string, unknown>[] }>(await sam.get('/v1/supplier-base/shared-assessments'));
    assert.equal(shared.audience, 'shared_party');
    assert.deepEqual(shared.items.map((i) => i.id), [sharedAssessment]);
    assert.deepEqual(Object.keys(shared.items[0]!).sort(), ['assessedAt', 'audience', 'buyerCompanyId', 'criteriaVersion', 'id', 'period', 'respondedAt', 'revision', 'scores', 'supplierResponse']);
    const sharedText = JSON.stringify(shared);
    for (const forbidden of [PRIVATE_NOTE, PRIVATE_TERMS, supplierRecord, 'blocked', 'on_hold', 'preferred', 'US-TX', 'lumber']) assert.ok(!sharedText.includes(forbidden), `shared view leaks ${forbidden}`);
    for (const field of SUPPLIER_BASE_PRIVATE_FIELDS.filter((f) => f !== 'scores')) assert.ok(!sharedText.includes(`"${field}"`), `shared view carries ${field}`);
    // Every other projection the supplier, another buyer or the public can reach is exactly as before.
    const after = await publicSurface();
    assert.equal(after.companiesAnon, before.companiesAnon, 'the directory (search surface) is unchanged for the public');
    assert.equal(after.companiesSam, before.companiesSam, 'the directory is unchanged for the supplier');
    assert.equal(after.reputation, before.reputation, 'the public reputation summary is unchanged');
    assert.equal(after.samBase, before.samBase, 'the supplier\'s own (empty) base is unchanged');
    for (const r of [await sam.get(`/v1/companies/by-handle/none-such`), await sid.get('/v1/supplier-base/shared-assessments'), await otto.get('/v1/supplier-base/counterparties')]) {
      for (const forbidden of [PRIVATE_NOTE, PRIVATE_TERMS, supplierRecord, '"blocked"']) assert.ok(!text(r).includes(forbidden), `a supplier-side response leaks ${forbidden}`);
    }
    // Search: no supplier-base source kind exists for retrieval; the directory carries no private field.
    assert.ok(!SourceKindSchema.options.some((k) => /supplier|counterparty|assessment/.test(k)));
    assert.ok(!after.companiesAnon.includes(PRIVATE_NOTE) && !after.companiesAnon.includes('"status"'));
    // Notifications: no outbox event, no mail.
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event'), outboxBefore);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.mail_delivery'), mailBefore);
    const notificationTable = (await h.db.admin.query<{ t: string | null }>("SELECT to_regclass('trustwork.notification')::text AS t")).rows[0]?.t;
    if (notificationTable) assert.equal(await count(h.db.admin, `SELECT 1 FROM ${notificationTable} n WHERE n::text LIKE '%' || $1 || '%'`, [supplierRecord]), 0);
    // Federation: no federated or global-id kind for the supplier base; every buyer-side response is refused by the backstop.
    for (const kind of [...FEDERATED_OBJECT_KINDS, ...GLOBAL_ID_KINDS]) assert.ok(!/supplier_record|counterparty|supplier_assessment/.test(kind), kind);
    for (const url of [`/v1/supplier-base/suppliers/${supplierRecord}`, '/v1/supplier-base/suppliers', `/v1/supplier-base/suppliers/${supplierRecord}/card`, `/v1/supplier-base/suppliers/${supplierRecord}/assessments`, '/v1/supplier-base/counterparties']) {
      const problems = payloadProblems(ok(await ada.get(url)));
      assert.ok(problems.some((p) => p.reason === 'private_marker'), `${url} would cross a node boundary`);
    }
    // The supplier's public entry, the federation source of its company_profile, passes the backstop and carries nothing private.
    const entry = JSON.parse(after.companiesAnon).items.find((i: { id: string }) => i.id === w.supplier);
    assert.deepEqual(payloadProblems(entry), []);
    assert.ok(!JSON.stringify(entry).includes(PRIVATE_NOTE));
  });

  await t.test('acceptance 3: assessments never enter reputation snapshots', async () => {
    const answered = ok<{ supplierResponse: string; revision: number }>(await sam.post(`/v1/supplier-base/shared-assessments/${sharedAssessment}/respond`, { response: 'Synthetic: the carrier strike delayed July', expectedRevision: 2 }));
    assert.equal(answered.supplierResponse, 'Synthetic: the carrier strike delayed July');
    expectError(await sid.post(`/v1/supplier-base/shared-assessments/${sharedAssessment}/respond`, { response: 'Synthetic', expectedRevision: answered.revision }), 403, 'access.forbidden');
    const snapshotAfter = ok<{ inputsDigest: string; summary: unknown }>(await sam.post('/v1/reputation/snapshots', { subject: { kind: 'company', id: w.supplier } }), 201);
    assert.equal(snapshotAfter.inputsDigest, snapshotBefore.inputsDigest, 'the same evidence gives the same snapshot: assessments are not evidence');
    assert.deepEqual(snapshotAfter.summary, snapshotBefore.summary);
    // Structurally: no reputation code reads the supplier base.
    const root = join(import.meta.dirname, '../../apps/api/src/modules');
    for (const dir of ['trust', 'execution']) {
      for (const file of readdirSync(join(root, dir))) {
        const source = readFileSync(join(root, dir, file), 'utf8');
        assert.ok(!/supplier_assessment|supplierAssessments|supplier-base/.test(source), `${dir}/${file} reads the supplier base`);
      }
    }
  });

  await t.test('card: figures from the buyer\'s own records with honest coverage, public facts only, screening through SANC-003 failing closed', async () => {
    await seedDeal(h.db.admin, w, w.supplier);
    await seedDeal(h.db.admin, w, w.supplier, 'declined');
    const adaCard = ok<CardView>(await ada.get(`/v1/supplier-base/suppliers/${supplierRecord}/card`));
    assert.equal(adaCard.audience, 'party_private');
    assert.deepEqual(adaCard.card.history.agreements, 1);
    assert.deepEqual(adaCard.card.history.orders, 2);
    assert.equal(adaCard.coverage.agreements, 'counted');
    assert.equal(adaCard.coverage.receipts, 'not_available');
    assert.equal(adaCard.card.onTimeRate, null);
    assert.equal(adaCard.card.publicFacts.counterpartyStatus, 'claimed');
    assert.equal(adaCard.publicEntry?.id, w.supplier);
    assert.equal(adaCard.screening, 'cannot_transact_now', 'an unscreened company cannot transact');
    const ritaCard = ok<CardView>(await rita.get(`/v1/supplier-base/suppliers/${supplierRecord}/card`));
    assert.equal(ritaCard.card.history.agreements, 0);
    assert.equal(ritaCard.coverage.agreements, 'not_permitted', 'without company.deals.manage the person reads no agreement');
    // A screening item is complete only when the port says clear; an unreadable state fails closed.
    const recordNow = ok<RecordView>(await ada.get(`/v1/supplier-base/suppliers/${supplierRecord}`));
    ok(await send(ada, '/v1/supplier-base/suppliers', { supplierRecordId: supplierRecord, link: { kind: 'company', id: w.supplier }, status: 'approved', expectedRevision: recordNow.record.revision, onboarding: [{ key: 'screening', kind: 'screening', documentTypeKey: null, state: 'missing' }] }));
    const stateOf = async (client: Client): Promise<RequestState> => {
      const resolved = await h.services().principals.resolve(client.sessionCookie as string);
      assert.ok(resolved);
      return { requestId: `supplier-base-${uuid()}`, principal: resolved.principal, session: resolved.session, sessionTokenHash: null, client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    };
    const failing = new SupplierBaseService(h.created.ctx!, h.services().principals, new AllowListSupplierBaseMandates([]), { canTransact: async () => { throw new Error('screening unavailable'); } });
    const failedCard = await failing.card(await stateOf(ada), supplierRecord);
    assert.equal(failedCard.screening, 'unavailable');
    assert.equal(failedCard.card.onboardingComplete, false);
    const clearing = new SupplierBaseService(h.created.ctx!, h.services().principals, new AllowListSupplierBaseMandates([]), { canTransact: async () => true });
    const clearCard = await clearing.card(await stateOf(ada), supplierRecord);
    assert.equal(clearCard.screening, 'clear');
    assert.equal(clearCard.card.onboardingComplete, true);
    assert.equal((await new SupplierBaseService(h.created.ctx!, h.services().principals, new AllowListSupplierBaseMandates([]), sanctionsScreening).card(await stateOf(ada), supplierRecord)).screening, 'cannot_transact_now');
  });

  await t.test('acceptance 2: an import never creates a directory member, a claim or a public record', async () => {
    const counts = async () => ({
      companies: await count(h.db.admin, 'SELECT 1 FROM trustwork.company'),
      memberships: await count(h.db.admin, 'SELECT 1 FROM trustwork.membership'),
      handles: await count(h.db.admin, 'SELECT 1 FROM trustwork.directory_handle'),
      claimed: await count(h.db.admin, "SELECT 1 FROM trustwork.company WHERE claim_status <> 'unclaimed'"),
      persons: await count(h.db.admin, 'SELECT 1 FROM trustwork.person'),
      grants: await count(h.db.admin, 'SELECT 1 FROM trustwork.permission_grant'),
      snapshots: await count(h.db.admin, 'SELECT 1 FROM trustwork.reputation_snapshot'),
      outbox: await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event'),
    });
    const start = await counts();
    assert.equal(start.companies, companiesBefore);
    const csv = 'Name,identifier_kind,identifier_value,email,categories,regions,status,payment_terms,notes\n'
      + 'Synthetic Imported Concrete LLC,us_ein,00-0000002,orders@example.invalid,concrete;rebar,US-CA,approved,Net 30,PRIVATE-IMPORT-NOTE\n'
      + '"Synthetic Imported ""Quoted"" Hardware",,,,hardware,US-NV,,,\n';
    expectError(await mia.post('/v1/supplier-base/import', { file: { format: 'csv', text: csv } }), 403, 'access.forbidden');
    const preview = ok<ImportView>(await rita.post('/v1/supplier-base/import', { file: { format: 'csv', text: csv }, dryRun: true }));
    assert.equal(preview.outcome, 'previewed');
    assert.equal(preview.wouldCreate, 2);
    assert.deepEqual(await counts(), start);
    const imported = ok<ImportView>(await rita.post('/v1/supplier-base/import', { file: { format: 'csv', text: csv } }));
    assert.equal(imported.outcome, 'imported');
    assert.equal(imported.created, 2);
    const again = ok<ImportView>(await rita.post('/v1/supplier-base/import', { file: { format: 'csv', text: csv } }));
    assert.equal(again.created, 0);
    assert.deepEqual(again.skipped.map((s) => s.reason), ['already_listed', 'already_listed']);
    const book = xlsx([['name', 'regions', 'status', 'notes'], ['Synthetic Workbook Plumbing Supply', 'US-AZ', 'prospect', 'from a workbook'], ['Synthetic Workbook Electric', 'US-NM;US-TX', 'preferred', '']]);
    const fromXlsx = ok<ImportView>(await rita.post('/v1/supplier-base/import', { file: { format: 'xlsx', base64: book.toString('base64') } }));
    assert.equal(fromXlsx.created, 2, JSON.stringify(fromXlsx));
    // A file with a bad row creates nothing; a restricted region refuses the whole file.
    const bad = ok<ImportView>(await rita.post('/v1/supplier-base/import', { file: { format: 'csv', text: 'name,status,colour\nSynthetic Bad Row,unknown_status,red\n' } }));
    assert.equal(bad.outcome, 'rejected');
    assert.ok(bad.errors.some((e) => e.code === 'import.unknown_column'));
    const badRow = ok<ImportView>(await rita.post('/v1/supplier-base/import', { file: { format: 'csv', text: 'name,status\nSynthetic Good Row,approved\nSynthetic Bad Status,sometimes\n' } }));
    assert.deepEqual(badRow.errors, [{ rowNumber: 3, column: 'status', code: 'import.invalid_value' }]);
    assert.equal(badRow.created, 0);
    expectError(await rita.post('/v1/supplier-base/import', { file: { format: 'csv', text: 'name,regions\nSynthetic Restricted Supplier,IR\n' } }), 422, 'validation.schema');
    expectError(await rita.post('/v1/supplier-base/import', { file: { format: 'xlsx', base64: Buffer.from('not a workbook at all, just text').toString('base64') } }), 422, 'validation.schema');
    const end = await counts();
    assert.deepEqual(end, start, 'no company, membership, handle, claim, person, grant, snapshot or event was created');
    // The imported suppliers are private external counterparties and never appear in the directory.
    const cps = ok<{ items: { name: string; source: string }[] }>(await rita.get('/v1/supplier-base/counterparties?limit=100'));
    assert.deepEqual(cps.items.filter((c) => c.name.startsWith('Synthetic Imported') || c.name.startsWith('Synthetic Workbook')).map((c) => c.source), ['import', 'import', 'import', 'import']);
    assert.ok(cps.items.some((c) => c.name === 'Synthetic Imported "Quoted" Hardware'));
    const directoryNow = text(await anonymous.get('/v1/companies?limit=100'));
    assert.equal(directoryNow, before.companiesAnon);
    assert.ok(!directoryNow.includes('Synthetic Imported') && !directoryNow.includes('PRIVATE-IMPORT-NOTE'));
    expectError(await sam.get(`/v1/supplier-base/suppliers/${imported.recordIds[0]}`), 404, 'access.not_found');
    const importedCard = ok<CardView>(await ada.get(`/v1/supplier-base/suppliers/${imported.recordIds[0]}/card`));
    assert.equal(importedCard.card.publicFacts.counterpartyStatus, 'external');
    assert.equal(importedCard.screening, 'not_screenable');
    assert.equal(importedCard.coverage.agreements, 'not_applicable');
    assert.equal(importedCard.publicEntry, null);
  });

  await t.test('counterparties: created and changed by managers, sharing refused, and the move to the claimed company', async () => {
    const cp = ok<CounterpartyView>(await rita.post('/v1/supplier-base/counterparties', { name: 'Synthetic Manual Roofing', identifiers: [{ kind: 'us_ein', value: '00-0000003' }], contacts: [{ role: 'sales', channel: 'phone', value: '+1 555 0100' }] }), 201);
    assert.equal(cp.counterparty.source, 'manual');
    expectError(await mia.post('/v1/supplier-base/counterparties', { name: 'Synthetic Refused' }), 403, 'access.forbidden');
    expectError(await rita.post('/v1/supplier-base/counterparties', { name: 'synthetic   manual roofing' }), 409, 'validation.revision_conflict');
    const renamed = ok<CounterpartyView>(await send(rita, `/v1/supplier-base/counterparties/${cp.counterparty.id}`, { name: 'Synthetic Manual Roofing Inc', expectedRevision: cp.counterparty.revision }));
    assert.equal(renamed.counterparty.name, 'Synthetic Manual Roofing Inc');
    expectError(await sam.get(`/v1/supplier-base/counterparties/${cp.counterparty.id}`), 404, 'access.not_found');
    const record = ok<RecordView>(await send(rita, '/v1/supplier-base/suppliers', { supplierRecordId: null, link: { kind: 'external_counterparty', id: cp.counterparty.id }, status: 'approved', expectedRevision: 1 }));
    const draft = ok<AssessmentView>(await rita.post(`/v1/supplier-base/suppliers/${record.record.id}/assessments`, { supplierRecordId: record.record.id, criteriaVersion: 1, period: { from: '2026-01-01', to: '2026-03-31' }, scores: [{ criterion: 'on_time', value: 5, evidenceRefs: [] }] }), 201);
    expectError(await send(rita, `/v1/supplier-base/assessments/${draft.assessment.id}/record`, { supplierRecordId: record.record.id, assessmentDraftId: draft.assessment.id, shareWithSupplier: true, expectedRevision: draft.assessment.revision }), 422, 'validation.schema');
    // The roofer joins the platform as the other buyer's company? It is claimed: the buyer links it; nothing reaches that company.
    const otherBefore = text(await otto.get('/v1/supplier-base/shared-assessments'));
    const moved = ok<RecordView>(await send(rita, '/v1/supplier-base/suppliers', { supplierRecordId: record.record.id, link: { kind: 'company', id: w.otherBuyer }, status: 'approved', expectedRevision: record.record.revision }));
    assert.equal(moved.record.linkedCompanyId, w.otherBuyer);
    assert.equal(moved.record.externalCounterpartyId, null);
    assert.equal(text(await otto.get('/v1/supplier-base/shared-assessments')), otherBefore);
    expectError(await otto.get(`/v1/supplier-base/suppliers/${record.record.id}`), 404, 'access.not_found');
  });

  await t.test('agents: the same use cases under maintain_records, prepare and communicate mandates; blocking stays with the person', async () => {
    // (Acceptance 3 computed a reputation snapshot, which appends its own trust event; count from here.)
    const outboxAtStart = await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event');
    const stateOf = async (client: Client): Promise<RequestState> => {
      const resolved = await h.services().principals.resolve(client.sessionCookie as string);
      assert.ok(resolved);
      return { requestId: `supplier-base-agent-${uuid()}`, principal: resolved.principal, session: resolved.session, sessionTokenHash: null, client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    };
    const ritaMandate = uuid();
    const mandates = new AllowListSupplierBaseMandates([{ personId: w.people.rita, mandateId: ritaMandate, action: 'maintain_records' }, { personId: w.people.rita, mandateId: ritaMandate, action: 'prepare' }]);
    const service = new SupplierBaseService(h.created.ctx!, h.services().principals, mandates, sanctionsScreening);
    const ritaState = await stateOf(rita);
    const agent = { via: 'agent' as const, mandateId: ritaMandate };
    const cp = await service.createCounterparty(ritaState, { name: 'Synthetic Agent Added Supplier', identifiers: [], contacts: [], actor: agent });
    assert.equal(cp.counterparty.source, 'manual');
    const rec = await service.maintain(ritaState, { supplierRecordId: null, link: { kind: 'external_counterparty', id: cp.counterparty.id }, status: 'prospect', expectedRevision: 1, idempotencyKey: 'agent-1', actor: agent });
    await assert.rejects(service.maintain(ritaState, { supplierRecordId: rec.record.id, link: { kind: 'external_counterparty', id: cp.counterparty.id }, status: 'blocked', expectedRevision: rec.record.revision, idempotencyKey: 'agent-2', actor: agent }),
      (e: { code?: string; details?: { reason?: string } }) => e.code === 'access.mandate_scope' && e.details?.reason === 'confirmation_required');
    await assert.rejects(service.maintain(ritaState, { supplierRecordId: rec.record.id, link: { kind: 'external_counterparty', id: cp.counterparty.id }, status: 'approved', expectedRevision: rec.record.revision, idempotencyKey: 'agent-3', actor: { via: 'agent', mandateId: uuid() } }),
      (e: { code?: string }) => e.code === 'access.mandate_scope');
    const draft = await service.draftAssessment(ritaState, rec.record.id, { supplierRecordId: rec.record.id, criteriaVersion: 1, period: { from: '2026-01-01', to: '2026-01-31' }, scores: [{ criterion: 'quality', value: 3, evidenceRefs: [] }], actor: agent });
    assert.equal(draft.assessment.state, 'draft');
    await assert.rejects(service.respond(await stateOf(sam), sharedAssessment, { response: 'Synthetic', expectedRevision: 3, actor: { via: 'agent', mandateId: uuid() } }), (e: { code?: string }) => e.code === 'access.mandate_scope');
    assert.deepEqual(mandates.checks.map((c) => [c.action, c.context.kind, c.context.id === w.buyer || c.context.id === w.supplier]),
      [['maintain_records', 'company', true], ['maintain_records', 'company', true], ['maintain_records', 'company', true], ['maintain_records', 'company', true], ['prepare', 'company', true], ['communicate', 'company', true]]);
    // Nothing the agent did produced an event either.
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.outbox_event'), outboxAtStart);
  });
});

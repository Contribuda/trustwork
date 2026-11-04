import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { BuyerQuoteView, SellerQuoteView } from '../../packages/contracts/src/deals.js';
import type { BidLevelSheetPayload, BidLevelSheetVersion } from '../../packages/contracts/src/supply/sourcing.js';
import { SKIP_REASON, startHarness, type Client } from '../backend/helpers/app.js';
import { amendRfq, as, company, count, fails, ok, PERSON, publishRfq, quotePayload, refused, rfqPayload, seedWorld, sendQuote, signIn, usd } from './helpers.js';

/**
 * PRC-004 levelling through HTTP on real PostgreSQL under the runtime role: sheets pin quote versions by id and digest,
 * stale versions are non-comparable, buyer adjustments stay separate and labelled, a frozen version never changes, and a
 * sheet never reaches a seller (forbidden-field tests over every seller read, the tables, the outbox and the audit).
 * Eligibility shows pass, fail or unknown; invitation candidates are ordered the same with and without paid entitlements.
 */
const h = await startHarness('sourcing_levelling');

type SheetView = { audience: string; version: BidLevelSheetVersion; revision: number; totals: { columnKey: string; quoted: { minorUnits: string }; adjustments: { minorUnits: string }; levelled: { minorUnits: string } | null }[]; columnsChangedSince: string[] };
type Template = { rfqVersionId: string; payload: BidLevelSheetPayload };
type EventView = { seal: { sealed: boolean; sealedUntil: string | null }; eligibility: { revision: number } | null; sheet: { currentVersionId: string | null; versions: SheetView[] } | null };
type Candidate = { supplierRecordId: string; party: { id: string } | null; eligibility: string; invited: boolean; status: string; rules: { rule: { kind: string }; result: string; source: string }[] };

const RISK_NOTE = 'PRIVATE-risk-allowance-source';
const FORBIDDEN_KEYS = ['columns', 'cells', 'adjustments', 'levelled', 'normalizedQuantity', 'conversionRuleRef', 'exchangeRateSnapshot', 'rules', 'eligibility'];

test('levelling sheets and eligibility', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w = await seedWorld(h, 'level');
  const [ada, rita, dana, mia, sam, tess, otto] = [await signIn(h, 'ada', 'level'), await signIn(h, 'rita', 'level'), await signIn(h, 'dana', 'level'), await signIn(h, 'mia', 'level'), await signIn(h, 'sam', 'level'), await signIn(h, 'tess', 'level'), await signIn(h, 'otto', 'level')];
  const anonymous = h.client();
  const [a, b, c] = [company(w.supplierA), company(w.supplierB), company(w.supplierC)];
  const buyer = company(w.buyer);

  const newEvent = async () => {
    const rfq = await publishRfq(ada, buyer, rfqPayload(), [a, b, c]);
    const [qa, qb] = [await sendQuote(sam, rfq, a, quotePayload('3000')), await sendQuote(tess, rfq, b, quotePayload('2800', { laying: '60000' }))];
    return { rfq, qa, qb };
  };
  const template = async (client: Client, rfqId: string) => ok<Template>(await client.get(`/v1/sourcing/rfqs/${rfqId}/level-sheet/template`));
  const draftBody = (rfq: OwnerRfqView, payload: BidLevelSheetPayload) => ({ rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, payload });
  const draft = (client: Client, rfq: OwnerRfqView, payload: BidLevelSheetPayload) => client.post(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/versions`, draftBody(rfq, payload));
  const freeze = (client: Client, view: SheetView) => client.post(`/v1/sourcing/level-sheet-versions/${view.version.id}/freeze`, { digest: view.version.digest, expectedRevision: view.revision });

  const event = await newEvent();
  const base = (await template(rita, event.rfq.rfq.id)).payload;
  const columnOf = (quote: SellerQuoteView, payload = base) => payload.columns.find((col) => col.kind === 'quote_version' && col.quoteVersionId === quote.versions.find((v) => v.status === 'sent')!.id)!;
  const withAdjustment: BidLevelSheetPayload = { ...base, adjustments: [{ columnKey: columnOf(event.qa).key, rfqLineKey: 'laying', kind: 'risk_allowance', label: 'buyer_estimate', amount: usd('12345'), source: RISK_NOTE }] };

  await t.test('the template repeats every sent quote exactly and invents nothing', () => {
    assert.equal(base.columns.length, 2);
    assert.ok(base.columns.every((col) => col.comparable));
    assert.equal(base.cells.length, 4);
    assert.deepEqual(base.adjustments, []);
    const cell = base.cells.find((x) => x.columnKey === columnOf(event.qa).key && x.rfqLineKey === 'pavers')!;
    assert.deepEqual([cell.unitPrice, cell.lineTotal, cell.normalizedQuantity], [usd('3000'), usd('30000'), { value: '10', unit: 'm2' }]);
  });

  await t.test('negative authorization: only the buyer side reads, and only runners write', async () => {
    const url = `/v1/sourcing/rfqs/${event.rfq.rfq.id}`;
    refused(await anonymous.get(url), 401, 'auth.session_invalid');
    for (const outsider of [sam, tess, otto, mia]) {
      refused(await outsider.get(url), 404, 'access.not_found');
      refused(await outsider.get(`${url}/level-sheet/template`), 404, 'access.not_found');
      refused(await outsider.get(`${url}/candidates`), 404, 'access.not_found');
      refused(await draft(outsider, event.rfq, withAdjustment), 404, 'access.not_found');
    }
    ok(await dana.get(url));
    refused(await draft(dana, event.rfq, withAdjustment), 403, 'access.forbidden', 'not_authorised');
    refused(await dana.post(`${url}/eligibility`, { rules: [], expectedRevision: null }), 403, 'access.forbidden', 'not_authorised');
    refused(await rita.post(`${url}/level-sheet/versions`, { ...draftBody(event.rfq, withAdjustment), actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
  });

  await t.test('pins are checked: a changed price, a dropped line or a foreign digest is refused; comparable comes from the server', async () => {
    const cheaper = { ...base, cells: base.cells.map((x, i) => (i === 0 ? { ...x, unitPrice: usd('1') } : x)) };
    refused(await draft(rita, event.rfq, cheaper), 422, 'validation.schema', 'cell_differs_from_quote');
    refused(await draft(rita, event.rfq, { ...base, cells: base.cells.slice(1) }), 422, 'validation.schema', 'cell_missing');
    const quantity = { ...base, cells: base.cells.map((x, i) => (i === 0 ? { ...x, normalizedQuantity: { value: '9', unit: 'm2' } } : x)) };
    refused(await draft(rita, event.rfq, quantity), 422, 'validation.schema', 'cell_differs_from_quote');
    const foreign = { ...base, columns: base.columns.map((col, i) => (i === 0 && col.kind === 'quote_version' ? { ...col, digest: { ...col.digest, value: 'a'.repeat(64) } } : col)) };
    refused(await draft(rita, event.rfq, foreign), 409, 'commercial.digest_mismatch', 'pin_mismatch');
    const captured = { ...base, cells: [], columns: [{ kind: 'captured_quote', key: 'captured', intakeDocumentId: 'doc', extractionReviewId: 'review', comparable: true, staleReason: null }] };
    refused(await draft(rita, event.rfq, captured as BidLevelSheetPayload), 422, 'validation.schema', 'captured_quote_unavailable');
  });

  let frozen: SheetView;
  await t.test('adjustments stay separate and labelled; totals are exact; the quote is untouched', async () => {
    const opened = ok<SheetView>(await draft(rita, event.rfq, withAdjustment), 201);
    assert.equal(opened.version.status, 'draft');
    const [totalA, totalB] = [opened.totals.find((x) => x.columnKey === columnOf(event.qa).key)!, opened.totals.find((x) => x.columnKey === columnOf(event.qb).key)!];
    assert.deepEqual([totalA.quoted.minorUnits, totalA.adjustments.minorUnits, totalA.levelled?.minorUnits], ['80000', '12345', '92345']);
    assert.deepEqual([totalB.quoted.minorUnits, totalB.adjustments.minorUnits, totalB.levelled?.minorUnits], ['88000', '0', '88000']);
    assert.equal(opened.version.payload.adjustments[0]?.label, 'buyer_estimate');
    const seen = ok<BuyerQuoteView>(await ada.get(`/v1/quotes/${event.qa.quote.id}`));
    assert.equal(seen.versions.at(-1)?.totals.gross.minorUnits, '80000', 'an adjustment never alters a quote');

    refused(await draft(rita, event.rfq, withAdjustment), 409, 'validation.revision_conflict', 'draft_exists');
    refused(await rita.post(`/v1/sourcing/level-sheet-versions/${opened.version.id}`, { payload: withAdjustment, expectedRevision: opened.revision + 1 }), 409, 'validation.revision_conflict', 'revision_conflict');
    refused(await rita.post(`/v1/sourcing/level-sheet-versions/${opened.version.id}/freeze`, { digest: { ...opened.version.digest, value: 'b'.repeat(64) }, expectedRevision: opened.revision }), 409, 'validation.revision_conflict', 'digest_mismatch');
    frozen = ok<SheetView>(await freeze(rita, opened));
    assert.equal(frozen.version.status, 'frozen');
  });

  await t.test('a frozen version never changes, for the API or the owner role; a newer one supersedes it', async () => {
    refused(await rita.post(`/v1/sourcing/level-sheet-versions/${frozen.version.id}`, { payload: base, expectedRevision: frozen.revision }), 409, 'commercial.version_immutable', 'frozen');
    await fails(withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.bid_level_sheet_version SET digest = ${'c'.repeat(64)} WHERE id = ${frozen.version.id}::uuid`.execute(trx)), 'commercial.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => sql`DELETE FROM trustwork.bid_level_sheet_version WHERE id = ${frozen.version.id}::uuid`.execute(trx)), 'commerce.retained');
    const next = ok<SheetView>(await draft(rita, event.rfq, base), 201);
    assert.equal(next.version.version, 2);
    const newer = ok<SheetView>(await freeze(rita, next));
    const after = ok<EventView>(await rita.get(`/v1/sourcing/rfqs/${event.rfq.rfq.id}`));
    assert.equal(after.sheet?.currentVersionId, newer.version.id);
    assert.deepEqual(after.sheet?.versions.map((v) => v.version.status), ['superseded', 'frozen']);
  });

  await t.test('stale quote versions are non-comparable: an amendment marks them, whatever the client claims', async () => {
    const amended = await newEvent();
    const before = (await template(rita, amended.rfq.rfq.id)).payload;
    const pending = ok<SheetView>(await draft(rita, amended.rfq, before), 201);
    const rfq = await amendRfq(ada, amended.rfq, rfqPayload({ quantity: '100' }));
    refused(await freeze(rita, pending), 409, 'commercial.rfq_version_not_current', 'rfq_version_not_current');
    const stale = (await template(rita, rfq.rfq.id)).payload;
    assert.ok(stale.columns.every((col) => !col.comparable && col.staleReason === 'rfq_amended'));
    const claims = { ...stale, columns: stale.columns.map((col) => ({ ...col, comparable: true, staleReason: null })) };
    const saved = ok<SheetView>(await rita.post(`/v1/sourcing/level-sheet-versions/${pending.version.id}`, { payload: claims, expectedRevision: pending.revision }));
    assert.ok(saved.version.payload.columns.every((col) => !col.comparable), 'the server derives the flag');
    assert.ok(saved.totals.every((x) => x.levelled === null), 'a non-comparable column has no levelled total');
    await fails(as(h, w, 'rita', (trx) => sql`SELECT trustwork.sourcing_save_draft(${pending.version.id}::uuid, ${JSON.stringify(before)}::jsonb, ${'d'.repeat(64)}::text, ${saved.revision}::integer, NULL::text)`.execute(trx)), 'sourcing.stale_comparable');
  });

  await t.test('a quote that goes stale after a save blocks the freeze until the draft is saved again', async () => {
    const racing = await newEvent();
    const payload = (await template(rita, racing.rfq.rfq.id)).payload;
    const pending = ok<SheetView>(await draft(rita, racing.rfq, payload), 201);
    const quote = ok<SellerQuoteView>(await sam.get(`/v1/quotes/${racing.qa.quote.id}`));
    ok<SellerQuoteView>(await sam.post(`/v1/quotes/${quote.quote.id}/withdraw`, { expectedRevision: quote.quote.revision, reason: 'Stock sold out', actor: PERSON }));
    const seen = ok<SheetView>(await rita.get(`/v1/sourcing/level-sheet-versions/${pending.version.id}`));
    assert.deepEqual(seen.columnsChangedSince, [columnOf(racing.qa, payload).key]);
    refused(await freeze(rita, seen), 409, 'commercial.stale_version', 'stale_comparable');
  });

  await t.test('a sealed RFQ is not levelled: nobody levels what nobody may read', async () => {
    const sealed = await publishRfq(ada, buyer, rfqPayload({ sealed: true }), [a]);
    await sendQuote(sam, sealed, a, quotePayload('3000'));
    refused(await rita.get(`/v1/sourcing/rfqs/${sealed.rfq.id}/level-sheet/template`), 403, 'access.forbidden', 'sealed_until_deadline');
    refused(await draft(rita, sealed, base), 403, 'access.forbidden', 'sealed_until_deadline');
    const view = ok<EventView>(await rita.get(`/v1/sourcing/rfqs/${sealed.rfq.id}`));
    assert.deepEqual(view.seal, { sealed: true, sealedUntil: '2027-02-15T17:00:00.000Z' });
    await fails(as(h, w, 'rita', (trx) => sql`SELECT trustwork.sourcing_open_draft(${sealed.rfq.id}::uuid, ${sealed.rfq.currentVersionId}::uuid, ${JSON.stringify(base)}::jsonb, ${'e'.repeat(64)}::text, NULL::text)`.execute(trx)), 'sourcing.sealed');
  });

  await t.test('a draft cannot be saved or frozen once an amendment seals the RFQ', async () => {
    const e = await newEvent();
    const payload = (await template(rita, e.rfq.rfq.id)).payload;
    const pending = ok<SheetView>(await draft(rita, e.rfq, payload), 201);
    await amendRfq(ada, e.rfq, rfqPayload({ sealed: true }));
    refused(await freeze(rita, pending), 403, 'access.forbidden', 'sealed_until_deadline');
    refused(await rita.post(`/v1/sourcing/level-sheet-versions/${pending.version.id}`, { payload, expectedRevision: pending.revision }), 403, 'access.forbidden', 'sealed_until_deadline');
    await fails(as(h, w, 'rita', (trx) => sql`SELECT trustwork.sourcing_save_draft(${pending.version.id}::uuid, ${JSON.stringify(payload)}::jsonb, ${'e'.repeat(64)}::text, ${pending.revision}::integer, NULL::text)`.execute(trx)), 'sourcing.sealed');
  });

  await t.test('a person who owns an RFQ levels it too, but has no supplier base', async () => {
    const own = await publishRfq(otto, { kind: 'person', id: w.people.otto }, rfqPayload(), [a]);
    await sendQuote(sam, own, a, quotePayload('3000'));
    const payload = (await template(otto, own.rfq.id)).payload;
    ok<SheetView>(await draft(otto, own, payload), 201);
    refused(await otto.get(`/v1/sourcing/rfqs/${own.rfq.id}/candidates`), 422, 'validation.schema', 'company_buyer_required');
  });

  await t.test('forbidden fields: a sheet never reaches a seller, a table read, the outbox or the audit trail', async () => {
    const rfqId = event.rfq.rfq.id;
    const reads = [await sam.get(`/v1/rfqs/${rfqId}`), await sam.get(`/v1/quotes/${event.qa.quote.id}`), await sam.get('/v1/quotes'), await sam.get('/v1/rfq-invitations'), await sam.get('/v1/agreements')];
    const json = JSON.stringify(reads.map((r) => r.body));
    for (const key of FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached a seller`);
    for (const secret of [RISK_NOTE, '12345', '92345', frozen.version.id, frozen.version.digest.value]) assert.ok(!json.includes(secret), `${secret} reached a seller`);
    assert.ok(!JSON.stringify(ok(await tess.get(`/v1/quotes/${event.qb.quote.id}`))).includes(event.qa.quote.id), 'a seller never sees another bid');
    refused(await sam.get(`/v1/sourcing/level-sheet-versions/${frozen.version.id}`), 404, 'access.not_found');

    for (const person of ['sam', 'otto', 'mia'] as const) {
      const rows: { sheets: number; versions: number } = await as(h, w, person, async (trx) => ({
        sheets: (await trx.selectFrom('bid_level_sheet').selectAll().execute()).filter((s) => s.rfq_id === rfqId).length,
        versions: (await trx.selectFrom('bid_level_sheet_version').selectAll().execute()).filter((s) => s.rfq_id === rfqId).length,
      }));
      assert.deepEqual(rows, { sheets: 0, versions: 0 }, person);
    }
    await fails(as(h, w, 'ada', (trx) => sql`INSERT INTO trustwork.bid_level_sheet (rfq_id, owner_company_id, created_by_person_id) VALUES (${rfqId}::uuid, ${w.buyer}::uuid, ${w.people.ada}::uuid)`.execute(trx)), '42501');
    await fails(as(h, w, 'ada', (trx) => sql`UPDATE trustwork.bid_level_sheet_version SET digest = ${'f'.repeat(64)} WHERE id = ${frozen.version.id}::uuid`.execute(trx)), '42501');

    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.outbox_event WHERE type LIKE 'sourcing.%' OR payload::text LIKE '%' || $1 || '%'", [frozen.version.id]), 0, 'no outbox event names a sheet');
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.audit_event WHERE action LIKE 'sourcing.%' AND (basis::text LIKE '%12345%' OR basis::text LIKE '%' || $1 || '%')", [RISK_NOTE]), 0, 'the audit trail carries no estimate');
    assert.ok(await count(h.db.admin, "SELECT 1 FROM trustwork.audit_event WHERE action = 'sourcing.sheet_frozen'") > 0);
  });

  await t.test('concurrent first drafts create one sheet and one draft; concurrent freezes resolve once', async () => {
    const racing = await newEvent();
    const payload = (await template(rita, racing.rfq.rfq.id)).payload;
    const first = await Promise.all([draft(rita, racing.rfq, payload), draft(ada, racing.rfq, payload)]);
    assert.deepEqual(first.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.bid_level_sheet_version WHERE rfq_id = $1', [racing.rfq.rfq.id]), 1);
    const opened = first.find((r) => r.status === 201)!.body as SheetView;
    const second = await Promise.all([freeze(rita, opened), freeze(ada, opened)]);
    assert.deepEqual(second.map((r) => r.status).sort(), [200, 409]);
  });

  /* ---------- Eligibility and invitation candidates ---------- */
  const url = `/v1/sourcing/rfqs/${event.rfq.rfq.id}`;
  const addSupplier = async (client: Client, id: string, status: string, regions: string[]) => {
    const key = randomUUID();
    return ok<{ record: { id: string } }>(await client.post('/v1/supplier-base/suppliers', { supplierRecordId: null, link: { kind: 'company', id }, status, regions, expectedRevision: 1, idempotencyKey: key }, { idempotencyKey: key }));
  };

  await t.test('eligibility shows pass, fail and unknown; unknown is not failure; blocked suppliers are not offered', async () => {
    await addSupplier(ada, w.supplierA, 'approved', ['US-CA']);
    await addSupplier(ada, w.supplierB, 'preferred', ['US-TX']);
    await addSupplier(ada, w.supplierC, 'prospect', []);
    await addSupplier(ada, w.otherBuyer, 'blocked', ['US-CA']);
    refused(await rita.post(`${url}/eligibility`, { rules: [], expectedRevision: 5 }), 409, 'validation.revision_conflict', 'revision_conflict');
    const saved = ok<{ revision: number }>(await rita.post(`${url}/eligibility`, { rules: [{ kind: 'region', regions: ['US-CA'] }, { kind: 'screening_clear' }], expectedRevision: null }));
    ok(await rita.post(`${url}/eligibility`, { expectedRevision: saved.revision, rules: [{ kind: 'region', regions: ['US-CA'] }, { kind: 'screening_clear' }, { kind: 'licence_category', category: 'paving' }, { kind: 'insurance_minimum', amount: usd('100000000') }, { kind: 'prequalification_section', section: 'safety' }] }));

    const { candidates } = ok<{ candidates: Candidate[] }>(await rita.get(`${url}/candidates`));
    assert.deepEqual(candidates.map((x) => x.party?.id), [w.supplierA, w.supplierC, w.supplierB], 'a failed rule goes last; the blocked supplier is absent');
    const [first, second, last] = candidates as [Candidate, Candidate, Candidate];
    assert.deepEqual([first.eligibility, second.eligibility, last.eligibility], ['unknown', 'unknown', 'fail']);
    assert.deepEqual(first.rules.map((r) => [r.rule.kind, r.result, r.source]), [
      ['region', 'pass', 'supplier_record'], ['screening_clear', 'pass', 'screening'], ['licence_category', 'unknown', 'not_available'],
      ['insurance_minimum', 'unknown', 'not_available'], ['prequalification_section', 'unknown', 'not_available'],
    ], 'without a passport the evidence rules stay unknown');
    assert.equal(second.rules[0]?.result, 'unknown', 'a record without regions is unknown, never failed');
    assert.ok(candidates.every((x) => x.invited));
  });

  await t.test('the order of invitation candidates is identical with and without paid entitlements', async () => {
    const before = ok(await rita.get(`${url}/candidates`));
    await withMaintenance(h.db.admin, async (trx) => {
      const hub = '00000000-0000-4000-8000-00000000c001';
      const offer = await trx.insertInto('offer').values({ hub_id: hub, code: 'premium_supplier', name: 'Premium', kind: 'plan', status: 'active', created_by: w.people.ada }).returning('id').executeTakeFirstOrThrow();
      // Payment is made to favour the supplier that would otherwise come last.
      for (const owner of [w.supplierB, w.supplierC]) {
        const account = await trx.insertInto('billing_account').values({ hub_id: hub, owner_company_id: owner, owner_person_id: null, currency: 'USD', created_by: w.people.ada }).returning('id').executeTakeFirstOrThrow();
        for (const source of ['sponsorship', 'credit'] as const) {
          await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, module_code: 'procurement', limits: JSON.stringify({ priority: 1, boost: 10 }), valid_from: new Date('2026-10-01T00:00:00Z'), source }).execute();
        }
      }
    });
    assert.ok(await count(h.db.admin, 'SELECT 1 FROM trustwork.entitlement') >= 4);
    assert.deepEqual(ok(await rita.get(`${url}/candidates`)), before, 'identical results and order with and without payment');
  });
});

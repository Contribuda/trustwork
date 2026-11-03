import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import type { OwnerRfqView, SupplierRfqView } from '../../packages/contracts/src/commerce.js';
import type { BuyerQuoteView, QuoteComparison, SellerQuoteView } from '../../packages/contracts/src/deals.js';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { amendRfq, as, company, draftQuote, ok, PERSON, publishRfq, quotePayload, refused, rfqPayload, seedWorld, sendQuote, signIn, usd } from './helpers.js';

/**
 * ADR 027 on real PostgreSQL under the runtime role and through the HTTP API: while the seal holds the buyer side reads
 * no sent quote version, line or tax determination; nothing the buyer does lifts it early; after the deadline the bids
 * open, no late bid competes with them, and negotiation on an opened bid stays possible.
 */
const h = await startHarness('sourcing_sealed');
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };

test('sealed RFQs', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w = await seedWorld(h, 'sealed');
  const [ada, sam, tess, otto] = [await signIn(h, 'ada', 'sealed'), await signIn(h, 'sam', 'sealed'), await signIn(h, 'tess', 'sealed'), await signIn(h, 'otto', 'sealed')];
  const [a, b] = [company(w.supplierA), company(w.supplierB)];
  const buyer = company(w.buyer);
  const seen = (person: 'ada' | 'sam' | 'otto', rfqId: string) => as(h, w, person, async (trx) => {
    const { rows } = await sql<{ versions: number; lines: number; taxes: number }>`SELECT
      (SELECT count(*)::int FROM trustwork.quote_version v WHERE v.rfq_id = ${rfqId}::uuid AND v.status <> 'draft') AS versions,
      (SELECT count(*)::int FROM trustwork.quote_line l JOIN trustwork.quote q ON q.id = l.quote_id WHERE q.rfq_id = ${rfqId}::uuid) AS lines,
      (SELECT count(*)::int FROM trustwork.tax_determination d JOIN trustwork.quote q ON q.id = d.quote_id WHERE q.rfq_id = ${rfqId}::uuid) AS taxes`.execute(trx);
    return rows[0]!;
  });
  const comparison = async (rfqId: string) => ok<QuoteComparison>(await ada.get(`/v1/rfqs/${rfqId}/comparison?mode=current`));

  const rfq = await publishRfq(ada, buyer, rfqPayload({ sealed: true }), [a, b]);
  const quote = await sendQuote(sam, rfq, a, quotePayload('3000'));
  const sent = quote.versions.find((v) => v.status === 'sent')!;

  await t.test('suppliers see the setting in the version they were invited to', async () => {
    const view = ok<SupplierRfqView>(await sam.get(`/v1/rfqs/${rfq.rfq.id}`));
    assert.equal(view.versions.at(-1)?.payload.sealedUntilDeadline, true);
  });

  await t.test('during the seal the buyer side reads no version, line or tax determination, in the database or the API', async () => {
    assert.deepEqual(await seen('ada', rfq.rfq.id), { versions: 0, lines: 0, taxes: 0 });
    assert.deepEqual(await seen('otto', rfq.rfq.id), { versions: 0, lines: 0, taxes: 0 });
    assert.deepEqual(await seen('sam', rfq.rfq.id), { versions: 1, lines: 2, taxes: 2 }, 'the seller reads its own quote');
    const view = ok<BuyerQuoteView>(await ada.get(`/v1/quotes/${quote.quote.id}`));
    assert.deepEqual(view.versions, []);
    assert.equal(JSON.stringify(view).includes('30000'), false, 'no total in the envelope');
    const compared = await comparison(rfq.rfq.id);
    assert.deepEqual(compared.entries, []);
    assert.deepEqual(compared.historical, []);
    refused(await otto.get(`/v1/quotes/${quote.quote.id}`), 404, 'access.not_found');
  });

  await t.test('the buyer cannot act on a sealed bid: acceptance and amendment requests fail as if the version did not exist', async () => {
    const current = rfq.versions.find((v) => v.id === rfq.rfq.currentVersionId)!;
    refused(await ada.post('/v1/agreements', {
      rfqId: rfq.rfq.id, quoteVersion: { id: sent.id, version: sent.version, digest: sent.digest }, rfqVersion: { id: current.id, version: current.version, digest: current.digest }, expectedRevision: quote.quote.revision,
      electronicRecords: CONSENT, actor: PERSON,
    }), 404, 'access.not_found');
    const asked = await ada.post(`/v1/quotes/${quote.quote.id}/amendment-requests`, { quoteVersionId: sent.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2900'), reason: 'Volume discount' }], targetTotal: null, actor: PERSON });
    assert.ok(asked.status >= 400 && asked.status < 500, JSON.stringify(asked.body));
  });

  await t.test('amending away the flag, moving the deadline back or closing the RFQ lifts nothing', async () => {
    const closing = await publishRfq(ada, buyer, rfqPayload({ sealed: true }), [a]);
    await sendQuote(sam, closing, a, quotePayload('3100'));
    const past = new Date(Date.now() - 3600_000).toISOString();
    const amended = await amendRfq(ada, closing, rfqPayload({ deadline: past }));
    assert.equal(amended.versions.find((v) => v.id === amended.rfq.currentVersionId)?.payload.sealedUntilDeadline, undefined);
    assert.equal((await seen('ada', closing.rfq.id)).versions, 0, 'the first version still seals until its deadline');
    ok(await ada.post(`/v1/rfqs/${closing.rfq.id}/close`, { outcome: 'cancelled', expectedRevision: amended.rfq.revision, reason: 'Project on hold' }));
    assert.equal((await seen('ada', closing.rfq.id)).versions, 0, 'cancelling opens nothing');
  });

  await t.test('an amendment that moves the deadline forward extends the seal, even when it drops the flag', async () => {
    const soon = new Date(Date.now() + 6000).toISOString();
    const extended = await publishRfq(ada, buyer, rfqPayload({ sealed: true, deadline: soon }), [a]);
    await sendQuote(sam, extended, a, quotePayload('3200'));
    await amendRfq(ada, extended, rfqPayload({ deadline: '2027-02-15T17:00:00.000Z' }));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(soon) - Date.now()) + 200));
    assert.equal((await seen('ada', extended.rfq.id)).versions, 0);
  });

  await t.test('an RFQ that is not sealed, or sealed false, behaves as it always did', async () => {
    for (const payload of [rfqPayload(), rfqPayload({ sealed: false })]) {
      const open = await publishRfq(ada, buyer, payload, [a]);
      await sendQuote(sam, open, a, quotePayload('3300'));
      assert.equal((await seen('ada', open.rfq.id)).versions, 1);
      assert.equal((await comparison(open.rfq.id)).entries.length, 1);
    }
  });

  await t.test('after the deadline the bids open; a late bid is refused; an answer to an amendment request is not', async () => {
    const deadline = new Date(Date.now() + 8000).toISOString();
    const timed = await publishRfq(ada, buyer, rfqPayload({ sealed: true, deadline }), [a, b]);
    const bid = await sendQuote(sam, timed, a, quotePayload('3000'));
    const late = await draftQuote(tess, timed, b, quotePayload('2500'));
    assert.equal((await seen('ada', timed.rfq.id)).versions, 0);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()) + 200));

    assert.equal((await seen('ada', timed.rfq.id)).versions, 1, 'the bid opens');
    assert.equal(ok<BuyerQuoteView>(await ada.get(`/v1/quotes/${bid.quote.id}`)).versions.length, 1);
    assert.equal((await comparison(timed.rfq.id)).entries.length, 1);

    refused(await tess.post(`/v1/quotes/${late.quote.id}/send`, { quoteId: late.quote.id, version: 1, expectedRevision: late.quote.revision, actor: PERSON }), 409, 'commercial.quote_not_acceptable', 'sealed_deadline_passed');

    const current = bid.versions.find((v) => v.status === 'sent')!;
    const asked = ok<BuyerQuoteView>(await ada.post(`/v1/quotes/${bid.quote.id}/amendment-requests`, { quoteVersionId: current.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2900'), reason: 'Volume discount' }], targetTotal: null, actor: PERSON }), 201);
    const request = asked.amendmentRequests.at(-1)!;
    let answer = ok<SellerQuoteView>(await sam.get(`/v1/quotes/${bid.quote.id}`));
    answer = ok<SellerQuoteView>(await sam.post(`/v1/quotes/${bid.quote.id}/versions`, { expectedRevision: answer.quote.revision, rfqVersionId: timed.rfq.currentVersionId, payload: quotePayload('2900'), answersAmendmentRequestId: request.id, actor: PERSON }), 201);
    answer = ok<SellerQuoteView>(await sam.post(`/v1/quotes/${bid.quote.id}/send`, { quoteId: bid.quote.id, version: 2, expectedRevision: answer.quote.revision, actor: PERSON }));
    assert.equal(answer.versions.find((v) => v.version === 2)?.status, 'sent');

    // The request is answered: it does not open a door for another late version.
    answer = ok<SellerQuoteView>(await sam.post(`/v1/quotes/${bid.quote.id}/versions`, { expectedRevision: answer.quote.revision, rfqVersionId: timed.rfq.currentVersionId, payload: quotePayload('2800'), answersAmendmentRequestId: null, actor: PERSON }), 201);
    refused(await sam.post(`/v1/quotes/${bid.quote.id}/send`, { quoteId: bid.quote.id, version: 3, expectedRevision: answer.quote.revision, actor: PERSON }), 409, 'commercial.quote_not_acceptable', 'sealed_deadline_passed');

    // The round is closed: the buyer read A's price and cannot reopen the bidding for anybody.
    const closed = ok<OwnerRfqView>(await ada.get(`/v1/rfqs/${timed.rfq.id}`));
    refused(await ada.post(`/v1/rfqs/${timed.rfq.id}/invitations`, { rfqId: timed.rfq.id, rfqVersionId: closed.rfq.currentVersionId, party: company(w.supplierC), channel: 'platform', actor: PERSON }), 422, 'validation.schema', 'sealed_round_closed');
    let amended = ok<OwnerRfqView>(await ada.post(`/v1/rfqs/${timed.rfq.id}/versions`, { expectedRevision: closed.rfq.revision, amendmentReason: 'One more round', actor: PERSON }), 201);
    const draft = amended.versions.find((v) => v.status === 'draft')!;
    amended = ok<OwnerRfqView>(await ada.post(`/v1/rfqs/${timed.rfq.id}/versions/${draft.id}`, { expectedRevision: amended.rfq.revision, payload: rfqPayload({ sealed: true, deadline: '2027-02-15T17:00:00.000Z' }), actor: PERSON }));
    refused(await ada.post(`/v1/rfqs/${timed.rfq.id}/publish`, { rfqId: timed.rfq.id, version: draft.version, expectedRevision: amended.rfq.revision, amendmentReason: 'One more round', actor: PERSON }), 422, 'validation.schema', 'sealed_round_closed');
    assert.equal((await seen('ada', timed.rfq.id)).versions, 2, 'no re-seal: the opened bids stay open');

    // Naming another bidder's request on one's own draft opens nothing either.
    await as(h, w, 'tess', (trx) => sql`UPDATE trustwork.quote_version SET answers_amendment_request_id = ${request.id}::uuid WHERE quote_id = ${late.quote.id}::uuid`.execute(trx));
    const relinked = ok<SellerQuoteView>(await tess.get(`/v1/quotes/${late.quote.id}`));
    refused(await tess.post(`/v1/quotes/${late.quote.id}/send`, { quoteId: late.quote.id, version: 1, expectedRevision: relinked.quote.revision, actor: PERSON }), 409, 'commercial.quote_not_acceptable', 'sealed_deadline_passed');
  });

  await t.test('a sealed version needs a deadline still ahead', async () => {
    const payload = rfqPayload({ sealed: true, deadline: new Date(Date.now() - 1000).toISOString() });
    const draft = ok<OwnerRfqView>(await ada.post('/v1/rfqs', { owner: buyer, projectId: null, payload, category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: PERSON }), 201);
    refused(await ada.post(`/v1/rfqs/${draft.rfq.id}/publish`, { rfqId: draft.rfq.id, version: 1, expectedRevision: draft.rfq.revision, amendmentReason: null, actor: PERSON }), 422, 'validation.schema', 'sealed_round_closed');
  });

  await t.test('the date of a seal is told only to those who read the setting; the bit that RLS reads is the same for everybody', async () => {
    const until = (person: 'ada' | 'sam' | 'otto') => as(h, w, person, async (trx) => (await sql<{ until: Date | null; sealed: boolean }>`SELECT trustwork.sourcing_sealed_until(${rfq.rfq.id}::uuid) AS until, trustwork.sourcing_sealed(${rfq.rfq.id}::uuid) AS sealed`.execute(trx)).rows[0]!);
    assert.equal((await until('ada')).until?.toISOString(), '2027-02-15T17:00:00.000Z');
    assert.equal((await until('sam')).until?.toISOString(), '2027-02-15T17:00:00.000Z');
    assert.deepEqual(await until('otto'), { until: null, sealed: true });
  });

  await t.test('the owner of an RFQ view keeps reading its own setting', async () => {
    const view = ok<OwnerRfqView>(await ada.get(`/v1/rfqs/${rfq.rfq.id}`));
    assert.equal(view.versions.at(-1)?.payload.sealedUntilDeadline, true);
  });
});

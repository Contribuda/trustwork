import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../../packages/data/src/repositories/kernel.js';
import { budgets } from '../../../packages/data/src/repositories/billing.js';
import type { OwnerRfqView } from '../../../packages/contracts/src/commerce.js';
import {
  BUYER_FORBIDDEN_KEYS, DEAL_EVENT_PAYLOAD_KEYS, SELLER_FORBIDDEN_KEYS, type BuyerAgreementView, type BuyerQuoteView, type QuoteComparison, type SellerAgreementView, type SellerQuoteView,
} from '../../../packages/contracts/src/deals.js';
import { SalesService } from '../../../apps/api/src/modules/sales/sales.service.js';
import { AllowListDealMandates } from '../../../apps/api/src/modules/sales/mandates.js';
import { SellerStatedTax } from '../../../apps/api/src/modules/sales/tax.js';
import { TransactionsService } from '../../../apps/api/src/modules/transactions/transactions.service.js';
import { ConfiguredElectronicRecords, electronicRecordsFromPack } from '../../../apps/api/src/modules/transactions/electronic-records.js';
import type { RequestState } from '../../../apps/api/src/common/request.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../../backend/helpers/app.js';
import { login, seedPersonas } from '../../backend/helpers/personas.js';
import { principalFor } from '../../data/helpers/seed.js';

/**
 * COM-002 through the HTTP API (real database, runtime role, CSRF, idempotency): invited sellers draft and send quote
 * versions pinned to the current RFQ version; the buyer compares only versions pinned to the current version (a quote
 * for quantity 10 in v1 is never compared or accepted as quantity 100 in v2); negotiation through structured amendment
 * requests; acceptance with consent to electronic records and identical digests on both sides; orders with a
 * transaction-budget reservation; seller acceptance; order changes; negative authorization, forbidden fields and
 * values for every counterparty read and outbox payload, agents bounded by mandates and private constraints, and
 * concurrent and duplicate acceptance.
 */
const h = await startHarness('transactions_api');

const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const PERSON = { via: 'person' as const };
const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
const RFQ_PAYLOAD = (quantity: string) => ({
  title: 'Patio pavers and laying', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: 'Net 30', acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [
    { lineId: 'pavers', kind: 'goods', description: 'Concrete pavers, grey', specification: { thickness: '60 mm' }, quantity: { value: quantity, unit: 'm2' }, alternativesAllowed: true },
    { lineId: 'laying', kind: 'works', description: 'Lay the pavers', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  ],
});
const BUYER_PRIVATE = { budgetCeiling: usd('9000000'), evaluationWeights: { price: '0.7' }, internalNotes: 'PRIVATE-buyer-ceiling-note', shortlist: [] as unknown[] };
const SELLER_PRIVATE = { floorPrices: { q1: usd('2800') }, marginTargets: { q1: '0.2' }, costBasis: { q1: usd('2100') }, negotiationNotes: 'PRIVATE-seller-floor-note' };
const BUYER_SECRETS = ['9000000', 'PRIVATE-buyer', 'budgetCeiling', 'evaluationWeights', 'internalNotes', 'shortlist', 'PRIVATE-approval'];
const SELLER_SECRETS = ['PRIVATE-seller', '2800', '2100', 'floorPrices', 'costBasis', 'marginTargets', 'negotiationNotes', 'PRIVATE-crew'];
function quotePayload(quantity: string, unitPrice = '3000', extra: { offering?: boolean } = {}) {
  const goods = BigInt(quantity) * BigInt(unitPrice);
  const total = goods + 50000n;
  return {
    currency: 'USD', paymentTerms: 'Net 30', validity: { until: '2027-06-01T00:00:00.000Z' }, exclusions: ['Permits and inspections'], attachments: [],
    deliveryTerms: { milestones: [{ description: 'Delivery and laying', due: bdate('2027-03-20') }], location: 'Site, San Diego County' },
    totals: { net: usd(total.toString()), tax: usd('0'), gross: usd(total.toString()) },
    lines: [
      { lineId: 'q1', rfqLineId: 'pavers', kind: 'goods', specSnapshot: { thickness: '60 mm' }, offeringVersionRef: extra.offering ? { offeringId: 'offering-demo-1', version: 1 } : null, quantity: { value: quantity, unit: 'm2' }, unitPrice: usd(unitPrice), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd(goods.toString()), substitution: null, options: [] },
      { lineId: 'q2', rfqLineId: 'laying', kind: 'works', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'ls' }, unitPrice: usd('50000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd('50000'), substitution: null, options: [] },
    ],
  };
}
function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
function noLeak(value: unknown, keys: readonly string[], secrets: readonly string[]): void {
  // Ids, digests and timestamps are random; strip them so a secret number inside one is not mistaken for a leak.
  const json = JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/\b[0-9a-f]{32,}\b/gi, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '');
  for (const key of keys) assert.ok(!json.includes(`"${key}"`), `${key} leaked: ${json.slice(0, 400)}`);
  for (const secret of secrets) assert.ok(!json.includes(secret), `${secret} leaked: ${json.slice(0, 400)}`);
}
const refOf = (v: { id: string; version: number; digest: { algorithm: 'trustwork-digest-1'; value: string } | null }) => ({ id: v.id, version: v.version, digest: v.digest! });

test('transactions API: quotes, comparison, negotiation, acceptance, orders and changes with negative authorization and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const as = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, anna, boris, carl, xenia] = [await as('petr'), await as('anna'), await as('boris'), await as('carl'), await as('xenia')];
  const anonymous = h.client();
  const supplier = { kind: 'company' as const, id: seed.companies.supplier };
  const carlParty = { kind: 'person' as const, id: seed.people.carl };
  const grantBudget = async (limit: string) => withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.petr), (trx) => budgets.grant(trx, {
    kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: limit, currency: 'USD',
  }));
  const stateOf = async (client: Client, requestId: string): Promise<RequestState> => {
    const token = client.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    return { requestId, principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
  };
  /** A published RFQ of Petr's with the buyer-private ceiling, and invitations for the given parties. */
  const publishRfq = async (quantity: string, invitees: { kind: 'person' | 'company'; id: string }[]) => {
    let rfq = ok<OwnerRfqView>(await petr.post('/v1/rfqs', { owner: { kind: 'person', id: seed.people.petr }, projectId: null, payload: RFQ_PAYLOAD(quantity), category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: BUYER_PRIVATE, source: null, actor: PERSON }), 201);
    rfq = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: PERSON }));
    for (const party of invitees) ok(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party, channel: 'platform', actor: PERSON }), 201);
    return ok<OwnerRfqView>(await petr.get(`/v1/rfqs/${rfq.rfq.id}`));
  };
  const createAndSend = async (client: Client, rfq: OwnerRfqView, seller: { kind: 'person' | 'company'; id: string }, payload: ReturnType<typeof quotePayload>, privateConstraint: typeof SELLER_PRIVATE | null = null) => {
    const created = ok<SellerQuoteView>(await client.post('/v1/quotes', { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller, payload, privateConstraint, actor: PERSON }), 201);
    return ok<SellerQuoteView>(await client.post(`/v1/quotes/${created.quote.id}/send`, { quoteId: created.quote.id, version: 1, expectedRevision: created.quote.revision, actor: PERSON }));
  };
  const amend = async (rfq: OwnerRfqView, quantity: string) => {
    let r = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/versions`, { expectedRevision: rfq.rfq.revision, amendmentReason: 'Quantity changed', actor: PERSON }), 201);
    const draft = r.versions.find((v) => v.status === 'draft')!;
    r = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/versions/${draft.id}`, { expectedRevision: r.rfq.revision, payload: RFQ_PAYLOAD(quantity), actor: PERSON }));
    return ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: draft.version, expectedRevision: r.rfq.revision, amendmentReason: 'Quantity changed', actor: PERSON }));
  };
  const currentRef = (rfq: OwnerRfqView) => refOf(rfq.versions.find((v) => v.id === rfq.rfq.currentVersionId)!);

  /* ---------- Quotes ---------- */
  let rfq = await publishRfq('10', [supplier, carlParty]);
  let borisQuote: SellerQuoteView;
  let carlQuote: SellerQuoteView;
  await t.test('quotes: only an invited seller drafts against the current version; the buyer never sees drafts or the seller private constraint', async () => {
    const body = { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller: supplier, payload: quotePayload('10', '3000', { offering: true }), privateConstraint: SELLER_PRIVATE, actor: PERSON };
    expectError(await anonymous.post('/v1/quotes', body, { idempotencyKey: null }), 401, 'auth.session_invalid');
    expectError(await anna.post('/v1/quotes', { ...body, seller: { kind: 'company', id: seed.companies.mixed } }), 404, 'access.not_found');
    expectError(await boris.post('/v1/quotes', { ...body, seller: carlParty }), 403, 'access.forbidden');
    expectError(await xenia.post('/v1/quotes', { ...body, seller: { kind: 'person', id: seed.people.xenia } }), 404, 'access.not_found');
    expectError(await boris.post('/v1/quotes', { ...body, rfqVersionId: rfq.versions[0]!.id.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }), 409, 'commercial.rfq_version_not_current');
    expectError(await boris.post('/v1/quotes', { ...body, payload: { ...quotePayload('10'), lines: quotePayload('10').lines.map((l) => (l.lineId === 'q2' ? { ...l, rfqLineId: 'no-such-line' } : l)) } }), 422, 'validation.schema');
    expectError(await boris.post('/v1/quotes', { ...body, payload: { ...quotePayload('10'), totals: { ...quotePayload('10').totals, gross: usd('1') } } }), 422, 'validation.schema');
    expectError(await boris.post('/v1/quotes', { ...body, actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    borisQuote = ok<SellerQuoteView>(await boris.post('/v1/quotes', body), 201);
    assert.equal(borisQuote.quote.status, 'draft');
    assert.deepEqual(borisQuote.privateConstraint.floorPrices, SELLER_PRIVATE.floorPrices);
    expectError(await boris.post('/v1/quotes', body), 409, 'validation.revision_conflict');
    const buyerView = ok<BuyerQuoteView>(await petr.get(`/v1/quotes/${borisQuote.quote.id}`));
    assert.equal(buyerView.projection, 'shared_party');
    assert.deepEqual(buyerView.versions, [], 'drafts never reach the buyer');
    noLeak(buyerView, BUYER_FORBIDDEN_KEYS, SELLER_SECRETS);
    for (const outsider of [anna, xenia, carl]) expectError(await outsider.get(`/v1/quotes/${borisQuote.quote.id}`), 404, 'access.not_found');
    expectError(await anonymous.get(`/v1/quotes/${borisQuote.quote.id}`), 404, 'access.not_found');
    expectError(await petr.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: 1, expectedRevision: borisQuote.quote.revision, actor: PERSON }), 403, 'access.forbidden');
    expectError(await boris.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: 1, expectedRevision: borisQuote.quote.revision + 1, actor: PERSON }), 409, 'validation.revision_conflict');
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: 1, expectedRevision: borisQuote.quote.revision, actor: PERSON }));
    const v1 = borisQuote.versions[0]!;
    assert.equal(v1.status, 'sent');
    assert.equal(v1.digest?.algorithm, 'trustwork-digest-1');
    assert.equal(v1.rfqVersion.id, rfq.rfq.currentVersionId);
    expectError(await boris.post(`/v1/quotes/${borisQuote.quote.id}/versions/${v1.id}`, { expectedRevision: borisQuote.quote.revision, payload: quotePayload('11'), actor: PERSON }), 409, 'commercial.version_immutable');
    const invitations = ok<{ invitations: { invitation: { status: string; rfqId: string } }[] }>(await boris.get('/v1/rfq-invitations'));
    assert.equal(invitations.invitations.find((i) => i.invitation.rfqId === rfq.rfq.id)?.invitation.status, 'responded', 'sending a quote records the response');
    const shared = ok<BuyerQuoteView>(await petr.get(`/v1/quotes/${borisQuote.quote.id}`));
    assert.equal(shared.versions.length, 1);
    noLeak(shared, BUYER_FORBIDDEN_KEYS, SELLER_SECRETS);
    carlQuote = await createAndSend(carl, rfq, carlParty, quotePayload('10', '2900'));
    noLeak(ok(await carl.get(`/v1/quotes/${carlQuote.quote.id}`)), ['budgetCeiling'], [...BUYER_SECRETS]);
    expectError(await carl.get(`/v1/quotes/${borisQuote.quote.id}`), 404, 'access.not_found');
  });

  await t.test('comparison: the buyer compares sent versions pinned to the current RFQ version, line by line, without ranking or private data', async () => {
    expectError(await boris.get(`/v1/rfqs/${rfq.rfq.id}/comparison`), 404, 'access.not_found');
    expectError(await anna.get(`/v1/rfqs/${rfq.rfq.id}/comparison`), 404, 'access.not_found');
    const comparison = ok<QuoteComparison>(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison`));
    assert.equal(comparison.entries.length, 2);
    assert.ok(comparison.entries.every((e) => e.comparableTotal !== null && e.lines.every((l) => l.match === 'matched')));
    assert.deepEqual(comparison.entries.find((e) => e.quoteId === carlQuote.quote.id)?.comparableTotal?.gross, usd('79000'));
    assert.deepEqual(comparison.entries[0]?.exclusions, ['Permits and inspections']);
    noLeak(comparison, [...BUYER_FORBIDDEN_KEYS, 'rank', 'score'], SELLER_SECRETS);
  });

  /* ---------- The amendment: quantity 10 in v1, 100 in v2 ---------- */
  await t.test('an old quote for quantity 10 in v1 is neither compared nor accepted as quantity 100 in v2', async () => {
    const v1Ref = currentRef(rfq);
    rfq = await amend(rfq, '100');
    const v2Ref = currentRef(rfq);
    const comparison = ok<QuoteComparison>(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison`));
    assert.deepEqual(comparison.entries, [], 'no quote answers v2 yet');
    assert.deepEqual(comparison.historical.map((e) => e.staleReason).sort(), ['rfq_amended', 'rfq_amended']);
    assert.ok(!JSON.stringify(comparison.historical).includes('comparableTotal'), 'historical mode shows no totals');
    const sharedCarl = ok<BuyerQuoteView>(await petr.get(`/v1/quotes/${carlQuote.quote.id}`));
    assert.equal(sharedCarl.quote.staleReason, 'rfq_amended');
    const carlV1 = refOf(sharedCarl.versions[0]!);
    for (const rfqVersion of [v2Ref, v1Ref]) {
      expectError(await petr.post('/v1/agreements', { rfqId: rfq.rfq.id, quoteVersion: carlV1, rfqVersion, expectedRevision: sharedCarl.quote.revision, electronicRecords: CONSENT, actor: PERSON }), 409, 'commercial.stale_version');
    }
    // The amendment flagged the quote too (its envelope revision moved). The seller answers v2 only after its invitation is revalidated.
    borisQuote = ok<SellerQuoteView>(await boris.get(`/v1/quotes/${borisQuote.quote.id}`));
    assert.equal(borisQuote.quote.staleReason, 'rfq_amended');
    expectError(await boris.post(`/v1/quotes/${borisQuote.quote.id}/versions`, { expectedRevision: borisQuote.quote.revision, rfqVersionId: v2Ref.id, payload: quotePayload('100'), answersAmendmentRequestId: null, actor: PERSON }), 409, 'commercial.rfq_version_not_current');
    const stale = rfq.invitations.find((i) => i.party.id === supplier.id && i.staleReason === 'rfq_amended')!;
    ok(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations/${stale.id}/revalidate`, { actor: PERSON }), 201);
    borisQuote = ok<SellerQuoteView>(await boris.get(`/v1/quotes/${borisQuote.quote.id}`));
    // A v2 answer that still offers 10 is listed with an explicit exclusion and no total.
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/versions`, { expectedRevision: borisQuote.quote.revision, rfqVersionId: v2Ref.id, payload: quotePayload('10'), answersAmendmentRequestId: null, actor: PERSON }), 201);
    assert.equal(borisQuote.versions.at(-1)?.revalidatedFrom, 1);
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: 2, expectedRevision: borisQuote.quote.revision, actor: PERSON }));
    assert.equal(borisQuote.quote.staleReason, null);
    let current = ok<QuoteComparison>(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison?mode=current`));
    const entry = current.entries[0]!;
    assert.equal(entry.lines.find((l) => l.rfqLineId === 'pavers')?.match, 'quantity_differs');
    assert.equal(entry.comparableTotal, null);
    assert.deepEqual(entry.notTotalledBecause, ['scope_mismatch']);
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/versions`, { expectedRevision: borisQuote.quote.revision, rfqVersionId: v2Ref.id, payload: quotePayload('100'), answersAmendmentRequestId: null, actor: PERSON }), 201);
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: 3, expectedRevision: borisQuote.quote.revision, actor: PERSON }));
    current = ok<QuoteComparison>(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison`));
    assert.deepEqual(current.entries.map((e) => e.version.version), [3], 'only the version pinned to v2 and still sent is compared');
    assert.deepEqual(current.entries[0]?.comparableTotal?.gross, usd('350000'));
    const historical = ok<QuoteComparison>(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison?mode=historical`));
    assert.equal(historical.entries.length, 0);
    assert.equal(historical.historical.length, 4);
  });

  /* ---------- Negotiation ---------- */
  await t.test('negotiation: structured amendment requests on exact lines; the answer is a new version; only the buyer side asks', async () => {
    const current = borisQuote.versions.find((v) => v.status === 'sent')!;
    const request = { quoteVersionId: current.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2900'), reason: 'Volume discount' }], targetTotal: usd('340000'), actor: PERSON };
    expectError(await boris.post(`/v1/quotes/${borisQuote.quote.id}/amendment-requests`, request), 403, 'access.forbidden');
    expectError(await carl.post(`/v1/quotes/${borisQuote.quote.id}/amendment-requests`, request), 404, 'access.not_found');
    expectError(await petr.post(`/v1/quotes/${borisQuote.quote.id}/amendment-requests`, { ...request, changes: [{ lineId: 'q9', quantity: null, targetUnitPrice: usd('1'), reason: null }] }), 422, 'validation.schema');
    expectError(await petr.post(`/v1/quotes/${borisQuote.quote.id}/amendment-requests`, { ...request, actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    const asked = ok<BuyerQuoteView>(await petr.post(`/v1/quotes/${borisQuote.quote.id}/amendment-requests`, request), 201);
    const open = asked.amendmentRequests.find((r) => r.status === 'open')!;
    assert.deepEqual(asked.rounds.map((r) => r.proposal.kind), ['quote_version', 'quote_version', 'quote_version', 'amendment_request']);
    noLeak(asked, BUYER_FORBIDDEN_KEYS, SELLER_SECRETS);
    borisQuote = ok<SellerQuoteView>(await boris.get(`/v1/quotes/${borisQuote.quote.id}`));
    noLeak(borisQuote, ['budgetCeiling', 'evaluationWeights', 'internalNotes', 'shortlist'], BUYER_SECRETS);
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/versions`, { expectedRevision: borisQuote.quote.revision, rfqVersionId: rfq.rfq.currentVersionId, payload: quotePayload('100', '2900'), answersAmendmentRequestId: open.id, actor: PERSON }), 201);
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: 4, expectedRevision: borisQuote.quote.revision, actor: PERSON }));
    assert.equal(borisQuote.amendmentRequests[0]?.status, 'answered');
    assert.equal(borisQuote.amendmentRequests[0]?.answeredByVersion, 4);
    assert.equal(borisQuote.rounds.length, 5);
  });

  await t.test('agents negotiate only within mandates and never past the private floor or ceiling; chat text never authorizes', async () => {
    const sellerState = await stateOf(boris, 'deals-agent-seller');
    const buyerState = await stateOf(petr, 'deals-agent-buyer');
    const mandates = new AllowListDealMandates([
      { personId: seed.people.boris, mandateId: 'mandate-demo-sell', action: 'prepare' }, { personId: seed.people.boris, mandateId: 'mandate-demo-sell', action: 'send_quote' },
      { personId: seed.people.petr, mandateId: 'mandate-demo-buy', action: 'negotiate', ceiling: usd('20000000') },
    ]);
    const sales = new SalesService(h.created.ctx!, h.services().principals, h.services().participations, mandates, new SellerStatedTax());
    const agent = { via: 'agent' as const, mandateId: 'mandate-demo-sell' };
    let view = await sales.openVersion(borisQuote.quote.id, { expectedRevision: borisQuote.quote.revision, rfqVersionId: rfq.rfq.currentVersionId!, payload: quotePayload('100', '2500') as never, answersAmendmentRequestId: null, actor: agent }, sellerState);
    await assert.rejects(sales.send(view.quote.id, { quoteId: view.quote.id, version: 5, expectedRevision: view.quote.revision, actor: agent }, sellerState), (e: { code?: string; details?: { reason?: string } }) => e.code === 'access.mandate_scope' && e.details?.reason === 'outside_private_constraints', 'below the floor');
    await assert.rejects(sales.send(view.quote.id, { quoteId: view.quote.id, version: 5, expectedRevision: view.quote.revision, actor: { via: 'agent', mandateId: 'mandate-other' } }, sellerState), (e: { code?: string }) => e.code === 'access.mandate_scope');
    view = await sales.saveDraft(view.quote.id, view.versions.at(-1)!.id, { expectedRevision: view.quote.revision, payload: quotePayload('100', '2850') as never, actor: agent }, sellerState);
    view = await sales.send(view.quote.id, { quoteId: view.quote.id, version: 5, expectedRevision: view.quote.revision, actor: agent }, sellerState);
    assert.deepEqual(view.versions.at(-1)?.sentBy, { personId: seed.people.boris, mandateId: 'mandate-demo-sell' });
    const shared = ok<BuyerQuoteView>(await petr.get(`/v1/quotes/${view.quote.id}`));
    noLeak(shared, ['sentBy', 'mandateId'], ['mandate-demo-sell']);
    const buyerAgent = { via: 'agent' as const, mandateId: 'mandate-demo-buy' };
    const sent = view.versions.at(-1)!;
    await assert.rejects(sales.requestAmendment(view.quote.id, { quoteVersionId: sent.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2900'), reason: null }], targetTotal: usd('9500000'), actor: buyerAgent }, buyerState),
      (e: { code?: string; message?: string }) => e.code === 'access.mandate_scope' && !String(e.message).includes('9000000'), 'above the private ceiling, without naming it');
    const asked = await sales.requestAmendment(view.quote.id, { quoteVersionId: sent.id, changes: [{ lineId: 'q1', quantity: null, targetUnitPrice: usd('2800'), reason: 'Match the market' }], targetTotal: usd('330000'), actor: buyerAgent }, buyerState);
    assert.equal(asked.amendmentRequests.at(-1)?.status, 'open');
    ok(await petr.post(`/v1/quotes/${view.quote.id}/amendment-requests/${asked.amendmentRequests.at(-1)!.id}/withdraw`, { reason: 'Accepting as is' }));
    borisQuote = ok<SellerQuoteView>(await boris.get(`/v1/quotes/${view.quote.id}`));
  });

  /* ---------- Acceptance ---------- */
  let agreement: BuyerAgreementView;
  await t.test('acceptance: the buyer side only, with consent to electronic records; duplicates are refused; both sides hold the same digest', async () => {
    const shared = ok<BuyerQuoteView>(await petr.get(`/v1/quotes/${borisQuote.quote.id}`));
    const latest = shared.versions.find((v) => v.status === 'sent')!;
    const body = { rfqId: rfq.rfq.id, quoteVersion: refOf(latest), rfqVersion: currentRef(rfq), expectedRevision: shared.quote.revision, electronicRecords: CONSENT, actor: PERSON };
    expectError(await petr.post('/v1/agreements', { ...body, electronicRecords: null }), 422, 'validation.schema');
    expectError(await petr.post('/v1/agreements', { ...body, electronicRecords: { consented: true, disclosureKey: 'some.other.v9' } }), 422, 'validation.schema');
    expectError(await boris.post('/v1/agreements', body), 403, 'access.forbidden');
    expectError(await anna.post('/v1/agreements', body), 404, 'access.not_found');
    expectError(await petr.post('/v1/agreements', { ...body, quoteVersion: { ...body.quoteVersion, digest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) } } }), 409, 'commercial.digest_mismatch');
    expectError(await petr.post('/v1/agreements', { ...body, expectedRevision: body.expectedRevision + 7 }), 409, 'validation.revision_conflict');
    expectError(await petr.post('/v1/agreements', { ...body, actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    agreement = ok<BuyerAgreementView>(await petr.post('/v1/agreements', body), 201);
    assert.equal(agreement.agreement.status, 'accepted_by_buyer');
    assert.equal(agreement.agreement.termsKind, 'rfq_quote');
    assert.deepEqual(agreement.agreement.acceptedTerms.quoteVersion, body.quoteVersion);
    assert.deepEqual(agreement.events.map((e) => [e.kind, e.electronicRecords?.disclosureKey]), [['buyer_accepts_terms', CONSENT.disclosureKey]]);
    expectError(await petr.post('/v1/agreements', body), 409, 'validation.revision_conflict');
    const sellerSide = ok<SellerAgreementView>(await boris.get(`/v1/agreements/${agreement.agreement.id}`));
    assert.equal(sellerSide.side, 'seller');
    assert.deepEqual(sellerSide.agreement.acceptedTerms, agreement.agreement.acceptedTerms, 'accepted terms are identical for both parties by digest');
    for (const outsider of [anna, xenia, carl]) expectError(await outsider.get(`/v1/agreements/${agreement.agreement.id}`), 404, 'access.not_found');
    expectError(await anonymous.get(`/v1/agreements/${agreement.agreement.id}`), 404, 'access.not_found');
    expectError(await boris.post(`/v1/quotes/${borisQuote.quote.id}/withdraw`, { expectedRevision: borisQuote.quote.revision, reason: 'Changed my mind', actor: PERSON }), 409, 'validation.revision_conflict');
  });

  await t.test('private halves never cross', async () => {
    agreement = ok<BuyerAgreementView>(await petr.post(`/v1/agreements/${agreement.agreement.id}/private`, { side: 'buyer', expectedRevision: agreement.privateRevision, approvalRefs: ['PRIVATE-approval-7'], notes: 'PRIVATE-buyer-agreement-note' }));
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/private`, { side: 'seller', expectedRevision: 1, fulfilmentPlan: [], notes: 'x' }), 403, 'access.forbidden');
    expectError(await boris.post(`/v1/agreements/${agreement.agreement.id}/private`, { side: 'buyer', expectedRevision: 1, approvalRefs: [], notes: 'x' }), 403, 'access.forbidden');
    const seller = ok<SellerAgreementView>(await boris.post(`/v1/agreements/${agreement.agreement.id}/private`, { side: 'seller', expectedRevision: 1, fulfilmentPlan: [{ step: 'PRIVATE-crew-schedule', internalOwnerPersonId: seed.people.boris }], notes: null }));
    assert.equal(seller.agreement.sellerPrivate.fulfilmentPlan[0]?.step, 'PRIVATE-crew-schedule');
    noLeak(seller, SELLER_FORBIDDEN_KEYS, BUYER_SECRETS);
    const buyer = ok<BuyerAgreementView>(await petr.get(`/v1/agreements/${agreement.agreement.id}`));
    assert.deepEqual(buyer.agreement.buyerPrivate.approvalRefs, ['PRIVATE-approval-7']);
    noLeak(buyer, BUYER_FORBIDDEN_KEYS, SELLER_SECRETS);
  });

  /* ---------- Orders ---------- */
  let order: BuyerAgreementView['orders'][number];
  await t.test('orders: commit_order on the buyer side, money from the immutable quote, an atomic transaction-budget reservation, no platform charge', async () => {
    const quoteVersion = agreement.agreement.acceptedTerms.quoteVersion;
    const rfqVersion = agreement.agreement.acceptedTerms.rfqVersion;
    const small = await grantBudget('1000');
    const budget = await grantBudget('100000000');
    const body = { action: 'place_order', context: { kind: 'rfq', id: rfq.rfq.id }, agreementId: agreement.agreement.id, quoteVersion, rfqVersion, expectedRevision: agreement.agreement.revision, transactionBudgetId: budget, platformBudgetId: null, externalReference: 'PO-2027-0042', actor: PERSON };
    expectError(await boris.post(`/v1/agreements/${agreement.agreement.id}/orders`, body), 403, 'access.forbidden');
    expectError(await anna.post(`/v1/agreements/${agreement.agreement.id}/orders`, body), 404, 'access.not_found');
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, { ...body, platformBudgetId: budget }), 422, 'validation.schema');
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, { ...body, quoteVersion: borisQuote.versions[0]!.digest ? refOf(borisQuote.versions[0]!) : quoteVersion }), 409, 'commercial.digest_mismatch');
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, { ...body, transactionBudgetId: small }), 409, 'commercial.budget_insufficient');
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, { ...body, actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    const placed = ok<BuyerAgreementView>(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, body), 201);
    order = placed.orders[0]!;
    assert.equal(order.status, 'placed');
    assert.ok(order.reservationId, 'the buyer sees its reservation');
    assert.deepEqual(order.acceptedTermsDigest, agreement.agreement.acceptedTerms.digest);
    assert.equal(placed.agreement.buyerPrivate.transactionBudgetId, budget);
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/orders`, body), 409, 'validation.revision_conflict');
    const sellerSide = ok<SellerAgreementView>(await boris.get(`/v1/agreements/${agreement.agreement.id}`));
    assert.equal(sellerSide.orders.length, 1);
    noLeak(sellerSide, SELLER_FORBIDDEN_KEYS, [...BUYER_SECRETS, budget, order.reservationId!]);
    agreement = placed;
  });

  await t.test('seller acceptance: the seller states the agreement digest; obligations follow; the quote becomes accepted', async () => {
    const seller = ok<SellerAgreementView>(await boris.get(`/v1/agreements/${agreement.agreement.id}`));
    const body = { expectedRevision: seller.agreement.revision, acceptedTermsDigest: seller.agreement.acceptedTerms.digest, electronicRecords: CONSENT, actor: PERSON };
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/accept`, body), 403, 'access.forbidden');
    expectError(await boris.post(`/v1/agreements/${agreement.agreement.id}/accept`, { ...body, acceptedTermsDigest: { algorithm: 'trustwork-digest-1', value: 'b'.repeat(64) } }), 409, 'commercial.digest_mismatch');
    expectError(await boris.post(`/v1/agreements/${agreement.agreement.id}/accept`, { ...body, electronicRecords: null }), 422, 'validation.schema');
    expectError(await boris.post(`/v1/agreements/${agreement.agreement.id}/accept`, { ...body, actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    const accepted = ok<SellerAgreementView>(await boris.post(`/v1/agreements/${agreement.agreement.id}/accept`, body));
    assert.equal(accepted.agreement.status, 'accepted_by_both');
    assert.equal(accepted.orders[0]?.status, 'accepted');
    assert.deepEqual(accepted.events.map((e) => e.kind), ['buyer_accepts_terms', 'seller_accepts_order']);
    assert.ok(accepted.events.every((e) => e.acceptedTermsDigest.value === accepted.agreement.acceptedTerms.digest.value), 'both acceptance events carry the agreement digest');
    assert.deepEqual(accepted.agreement.obligations.map((o) => [o.party.id, o.kind]), [[supplier.id, 'deliver'], [supplier.id, 'perform'], [seed.people.petr, 'pay'], [seed.people.petr, 'accept']]);
    assert.equal(accepted.agreement.obligations[0]?.due, '2027-03-20T07:00:00.000Z', 'the milestone business day in San Diego');
    noLeak(accepted, SELLER_FORBIDDEN_KEYS, BUYER_SECRETS);
    const buyer = ok<BuyerAgreementView>(await petr.get(`/v1/agreements/${agreement.agreement.id}`));
    assert.deepEqual(buyer.agreement.acceptedTerms.digest, accepted.agreement.acceptedTerms.digest);
    noLeak(buyer, BUYER_FORBIDDEN_KEYS, SELLER_SECRETS);
    assert.equal(ok<SellerQuoteView>(await boris.get(`/v1/quotes/${borisQuote.quote.id}`)).quote.status, 'accepted');
    expectError(await petr.post(`/v1/agreements/${agreement.agreement.id}/withdraw`, { expectedRevision: buyer.agreement.revision, reason: 'Too late', actor: PERSON }), 422, 'validation.schema');
    expectError(await petr.post(`/v1/orders/${order.id}/cancel`, { expectedRevision: buyer.orders[0]!.revision, reason: 'Too late', actor: PERSON }), 422, 'validation.schema');
    agreement = buyer;
  });

  await t.test('order changes: a newer sent version agreed by both supersedes the agreement; a higher total reserves the difference', async () => {
    borisQuote = ok<SellerQuoteView>(await boris.get(`/v1/quotes/${borisQuote.quote.id}`));
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/versions`, { expectedRevision: borisQuote.quote.revision, rfqVersionId: rfq.rfq.currentVersionId, payload: quotePayload('100', '3100'), answersAmendmentRequestId: null, actor: PERSON }), 201);
    const next = borisQuote.versions.at(-1)!;
    borisQuote = ok<SellerQuoteView>(await boris.post(`/v1/quotes/${borisQuote.quote.id}/send`, { quoteId: borisQuote.quote.id, version: next.version, expectedRevision: borisQuote.quote.revision, actor: PERSON }));
    const sent = borisQuote.versions.at(-1)!;
    expectError(await anna.post(`/v1/orders/${order.id}/changes`, { expectedRevision: 1, quoteVersion: refOf(sent), transactionBudgetId: null, actor: PERSON }), 404, 'access.not_found');
    const sellerView = ok<SellerAgreementView>(await boris.get(`/v1/agreements/${agreement.agreement.id}`));
    const proposed = ok<SellerAgreementView>(await boris.post(`/v1/orders/${order.id}/changes`, { expectedRevision: sellerView.orders[0]!.revision, quoteVersion: refOf(sent), transactionBudgetId: null, actor: PERSON }), 201);
    const change = proposed.orderChanges[0]!;
    assert.equal(change.status, 'proposed');
    expectError(await boris.post(`/v1/orders/${order.id}/changes/${change.id}`, { expectedRevision: change.revision, decision: 'accept', transactionBudgetId: null, reason: null, actor: PERSON }), 403, 'access.forbidden');
    expectError(await petr.post(`/v1/orders/${order.id}/changes/${change.id}`, { expectedRevision: change.revision, decision: 'accept', transactionBudgetId: null, reason: null, actor: PERSON }), 403, 'commercial.authority_missing');
    const budget = await grantBudget('5000000');
    const changed = ok<BuyerAgreementView>(await petr.post(`/v1/orders/${order.id}/changes/${change.id}`, { expectedRevision: change.revision, decision: 'accept', transactionBudgetId: budget, reason: null, actor: PERSON }));
    assert.equal(changed.agreement.status, 'accepted_by_both');
    assert.notEqual(changed.agreement.id, agreement.agreement.id);
    assert.equal(changed.agreement.acceptedTerms.quoteVersion.id, sent.id);
    assert.equal(changed.orders[0]?.status, 'changed');
    assert.deepEqual(changed.orders[0]?.acceptedTermsDigest, changed.agreement.acceptedTerms.digest);
    const old = ok<BuyerAgreementView>(await petr.get(`/v1/agreements/${agreement.agreement.id}`));
    assert.equal(old.agreement.status, 'superseded');
    assert.equal(old.agreement.supersededBy, changed.agreement.id);
    const sellerNew = ok<SellerAgreementView>(await boris.get(`/v1/agreements/${changed.agreement.id}`));
    assert.deepEqual(sellerNew.agreement.acceptedTerms.digest, changed.agreement.acceptedTerms.digest);
    noLeak(sellerNew, SELLER_FORBIDDEN_KEYS, [...BUYER_SECRETS, budget]);
  });

  /* ---------- Concurrency, decline, cancel ---------- */
  await t.test('concurrent acceptance of two different quotes and duplicate acceptance: exactly one agreement; decline and cancel release authority', async () => {
    const race = await publishRfq('20', [supplier, carlParty]);
    const a = await createAndSend(boris, race, supplier, quotePayload('20'));
    const b = await createAndSend(carl, race, carlParty, quotePayload('20', '2950'));
    const accept = (client: Client, quote: SellerQuoteView, key: string) => client.post('/v1/agreements', {
      rfqId: race.rfq.id, quoteVersion: refOf(quote.versions[0]!), rfqVersion: currentRef(race), expectedRevision: quote.quote.revision, electronicRecords: CONSENT, actor: PERSON,
    }, { idempotencyKey: key });
    const results = await Promise.all([accept(petr, a, 'race-a'), accept(petr, b, 'race-b'), accept(petr, a, 'race-a-again')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(results.map((r) => r.body)));
    const winner = results.find((r) => r.status === 201)!.body as BuyerAgreementView;
    const count = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('agreement').select('id').where('rfq_id', '=', race.rfq.id).execute());
    assert.equal(count.length, 1);
    const budget = await grantBudget('10000000');
    const placed = ok<BuyerAgreementView>(await petr.post(`/v1/agreements/${winner.agreement.id}/orders`, {
      action: 'place_order', context: { kind: 'rfq', id: race.rfq.id }, agreementId: winner.agreement.id, quoteVersion: winner.agreement.acceptedTerms.quoteVersion, rfqVersion: winner.agreement.acceptedTerms.rfqVersion,
      expectedRevision: winner.agreement.revision, transactionBudgetId: budget, platformBudgetId: null, externalReference: null, actor: PERSON,
    }), 201);
    const sellerClient = winner.agreement.parties.seller.kind === 'company' ? boris : carl;
    const sellerView = ok<SellerAgreementView>(await sellerClient.get(`/v1/agreements/${winner.agreement.id}`));
    const declined = ok<SellerAgreementView>(await sellerClient.post(`/v1/agreements/${winner.agreement.id}/decline`, { expectedRevision: sellerView.agreement.revision, reason: 'Crew unavailable', actor: PERSON }));
    assert.equal(declined.agreement.status, 'declined');
    assert.equal(declined.orders[0]?.status, 'cancelled');
    const reservationId = placed.orders[0]!.reservationId!;
    const held = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('reservation').select('state').where('id', '=', reservationId).executeTakeFirstOrThrow());
    assert.equal(held.state, 'reserved', 'the seller has no authority over the buyer budget');
    const buyerView = ok<BuyerAgreementView>(await petr.get(`/v1/agreements/${winner.agreement.id}`));
    ok(await petr.post(`/v1/orders/${placed.orders[0]!.id}/cancel`, { expectedRevision: buyerView.orders[0]!.revision, reason: 'Seller declined', actor: PERSON }));
    const released = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('reservation').select('state').where('id', '=', reservationId).executeTakeFirstOrThrow());
    assert.equal(released.state, 'released');
    // After a decline the RFQ is open for another acceptance.
    const other = winner.agreement.parties.seller.kind === 'company' ? b : a;
    const second = ok<BuyerAgreementView>(await accept(petr, ok<SellerQuoteView>(await (other === a ? boris : carl).get(`/v1/quotes/${other.quote.id}`)), 'race-second'), 201);
    const withdrawn = ok<BuyerAgreementView>(await petr.post(`/v1/agreements/${second.agreement.id}/withdraw`, { expectedRevision: second.agreement.revision, reason: 'Budget moved', actor: PERSON }));
    assert.equal(withdrawn.agreement.status, 'withdrawn');
  });

  await t.test('electronic records: a US hub cites ESIGN and UETA from the country pack in the acceptance event', async () => {
    const policy = electronicRecordsFromPack('US');
    assert.deepEqual(policy, { required: true, disclosureKey: 'us.electronic-records.v1', basis: ['US:eSignature/esign-act', 'US:eSignature/ueta'] });
    assert.equal(electronicRecordsFromPack('ZZ').disclosureKey, 'trustwork.electronic-records.v1');
    const usHub = new TransactionsService(h.created.ctx!, h.services().principals, h.services().participations, new AllowListDealMandates([]), new ConfiguredElectronicRecords(policy));
    const fresh = await publishRfq('5', [carlParty]);
    const quote = await createAndSend(carl, fresh, carlParty, quotePayload('5'));
    const state = await stateOf(petr, 'deals-us-hub');
    const input = { rfqId: fresh.rfq.id, quoteVersion: refOf(quote.versions[0]!), rfqVersion: currentRef(fresh), expectedRevision: quote.quote.revision, actor: PERSON };
    await assert.rejects(usHub.acceptTerms({ ...input, electronicRecords: CONSENT }, 'us-hub-1', state), (e: { code?: string; details?: { disclosureKey?: string } }) => e.code === 'validation.schema' && e.details?.disclosureKey === 'us.electronic-records.v1');
    const accepted = await usHub.acceptTerms({ ...input, electronicRecords: { consented: true, disclosureKey: 'us.electronic-records.v1' } }, 'us-hub-2', state);
    assert.deepEqual(accepted.events[0]?.electronicRecords, { disclosureKey: 'us.electronic-records.v1', basis: ['US:eSignature/esign-act', 'US:eSignature/ueta'] });
  });

  await t.test('outbox events carry identifiers only; audit rows never hold private values', async () => {
    const rows = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('outbox_event').select(['type', 'payload']).where('aggregate_kind', 'in', ['quote', 'agreement', 'order']).execute());
    assert.ok(rows.length >= 20);
    for (const row of rows) {
      for (const key of Object.keys(row.payload as object)) assert.ok((DEAL_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key), `${row.type}: ${key} is not an identifier`);
      noLeak(row.payload, [...BUYER_FORBIDDEN_KEYS, ...SELLER_FORBIDDEN_KEYS], [...BUYER_SECRETS, ...SELLER_SECRETS]);
    }
    const audits = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('audit_event').select(['action', 'basis']).where('object_kind', 'in', ['quote', 'agreement', 'order']).execute());
    for (const row of audits) noLeak(row.basis, ['floorPrices', 'costBasis', 'negotiationNotes', 'fulfilmentPlan', 'approvalRefs'], [...SELLER_SECRETS, ...BUYER_SECRETS]);
  });

  await t.test('payment never reorders a comparison: identical with and without entitlements or sponsorship', async () => {
    const before = ok(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison?mode=historical`));
    await withMaintenance(h.db.admin, async (trx) => {
      const hub = '00000000-0000-4000-8000-00000000c002';
      const offer = await trx.insertInto('offer').values({ hub_id: hub, code: 'premium_supplier_deals', name: 'Premium', kind: 'plan', status: 'active', created_by: seed.people.anna }).returning('id').executeTakeFirstOrThrow();
      for (const owner of [{ owner_company_id: seed.companies.supplier, owner_person_id: null }, { owner_company_id: null, owner_person_id: seed.people.carl }]) {
        const account = await trx.insertInto('billing_account').values({ hub_id: hub, ...owner, currency: 'USD', created_by: seed.people.anna }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, module_code: 'sales', limits: JSON.stringify({ priority: 1, boost: 10 }), valid_from: new Date('2026-10-01T00:00:00Z'), source: 'sponsorship' }).execute();
      }
    });
    assert.deepEqual(ok(await petr.get(`/v1/rfqs/${rfq.rfq.id}/comparison?mode=historical`)), before);
  });
});

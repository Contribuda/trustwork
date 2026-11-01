import assert from 'node:assert/strict';
import { sql } from 'kysely';
import type { Transaction } from '@trustwork/data';
import { computeQuoteVersionDigest, computeAgreementDigest, type QuoteVersionPayload } from '@trustwork/contracts';
import { quotes, quoteVersions, quoteLines, taxDeterminations, agreements, acceptanceEvents, orders } from '../../../packages/data/src/repositories/transactions.js';
import { rfqVersions, rfqs } from '../../../packages/data/src/repositories/commerce.js';
import { budgets, reservations } from '../../../packages/data/src/repositories/billing.js';

type As = <T>(person: string, fn: (trx: Transaction) => Promise<T>) => Promise<T>;
/** Actual owner commands, immutable versions, line projection and digest; no disabled commerce trigger. */
export const sendSyntheticQuote = (as: As, seller: string, quoteId: string) => as(seller, async trx => {
  const q = await quotes.lock(trx, quoteId); assert.ok(q?.invitation_id);
  const current = await sql<{ current_version_id: string }>`SELECT current_version_id FROM trustwork.rfq WHERE id=${q.rfq_id}::uuid`.execute(trx);
  const rv = await rfqVersions.get(trx, current.rows[0]!.current_version_id); assert.ok(rv?.digest);
  const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
  const payload: QuoteVersionPayload = { currency: 'USD', paymentTerms: 'Synthetic terms', validity: { until: '2099-01-01T00:00:00.000Z' }, exclusions: [], attachments: [],
    deliveryTerms: { milestones: [], location: 'Synthetic site' }, totals: { net: money('100'), tax: money('0'), gross: money('100') },
    lines: [{ lineId: 'q1', rfqLineId: 'synthetic', kind: 'goods', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'm2' }, unitPrice: money('100'),
      tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: money('0'), lineTotal: money('100'), substitution: null, options: [] }] };
  const draft = await quoteVersions.insertDraft(trx, { quote_id: q.id, version: 1, rfq_id: q.rfq_id, rfq_version_id: rv.id, rfq_version: rv.version, rfq_version_digest: rv.digest,
    payload, drafted_by_person_id: seller, revalidated_from: null, answers_amendment_request_id: null });
  const tax = await taxDeterminations.insertMany(trx, q.id, draft.id, seller, [{ line_id: 'q1', jurisdiction: 'synthetic', rule_ref: 'synthetic.none', rate: null, included: false, taxability: 'not_applicable', exemption_ref: null, provider: 'seller_stated' }]);
  await quoteLines.insertMany(trx, q.id, draft.id, [{ position: 0, line_id: 'q1', rfq_line_id: 'synthetic', kind: 'goods', spec_snapshot: {}, offering_ref: null, offering_version: null,
    quantity_value: '1', quantity_unit: 'm2', currency: 'USD', unit_price_minor: '100', tax_determination_id: tax[0]!.id, tax_amount_minor: '0', line_total_minor: '100' }]);
  const digest = computeQuoteVersionDigest({ id: rv.id, version: rv.version, digest: { algorithm: 'trustwork-digest-1', value: rv.digest } }, payload).value;
  const sent = await quoteVersions.send(trx, draft.id, { digest, personId: seller, via: 'person', mandateId: null, validUntil: payload.validity.until, at: new Date() }); assert.ok(sent);
  await quotes.setCurrent(trx, q.id, { status: 'sent', current_version: sent.version, current_version_id: sent.id, invitation_id: q.invitation_id, clearStale: true });
  return sent;
});
export const acceptSyntheticQuote = (as: As, buyer: string, quoteId: string) => as(buyer, async trx => {
  const q = await quotes.get(trx, quoteId); assert.ok(q?.current_version_id);
  const r = await rfqs.lock(trx, q.rfq_id); assert.ok(r?.current_version_id);
  const qv = await quoteVersions.get(trx, q.current_version_id), rv = await rfqVersions.get(trx, r.current_version_id); assert.ok(qv?.digest && rv?.digest);
  const digest = computeAgreementDigest({ id: qv.id, version: qv.version, digest: { algorithm: 'trustwork-digest-1', value: qv.digest } }, { id: rv.id, version: rv.version, digest: { algorithm: 'trustwork-digest-1', value: rv.digest } }).value;
  const a = await agreements.insert(trx, { buyer_person_id: q.buyer_person_id, buyer_company_id: q.buyer_company_id, seller_person_id: q.seller_person_id, seller_company_id: q.seller_company_id,
    rfq_id: r.id, quote_id: q.id, quote_version_id: qv.id, rfq_version_id: rv.id, offer_version: qv.version, offer_digest: qv.digest, request_version: rv.version, request_digest: rv.digest,
    accepted_terms_digest: digest, status: 'accepted_by_buyer', supersedes_id: null, created_by_person_id: buyer });
  await acceptanceEvents.insert(trx, { agreement_id: a.id, kind: 'buyer_accepts_terms', terms_kind: a.terms_kind, quote_version_id: a.quote_version_id, rfq_version_id: a.rfq_version_id,
    offer_version: a.offer_version, offer_digest: a.offer_digest, request_version: a.request_version, request_digest: a.request_digest, accepted_terms_digest: a.accepted_terms_digest,
    actor_person_id: buyer, on_behalf_person_id: q.buyer_person_id, on_behalf_company_id: q.buyer_company_id, via: 'person', mandate_id: null,
    transaction_budget_id: null, reservation_id: null, platform_budget_id: null, e_records_required: false, e_records_disclosure_key: null, e_records_basis: [], e_records_consented_at: null,
    reason: null, idempotency_key: `synthetic.accept.${a.id}` });
  return a;
});
/** Real local BILL budget/reservation fixtures; no payment-source record or external provider. */
export const placeSyntheticOrder = (as: As, buyer: string, agreementId: string) => as(buyer, async trx => {
  const a = await agreements.lock(trx, agreementId); assert.ok(a?.rfq_id);
  const budgetId = await budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null,
    periodFrom: new Date(Date.now() - 3600000).toISOString(), periodTo: new Date(Date.now() + 86400000).toISOString(), limitMinor: '1000', currency: 'USD' });
  const reservation = await reservations.reserve(trx, { budgetId, kind: 'transaction', amountMinor: '100', currency: 'USD', actionIntentId: a.id, correlationKey: `order:${a.id}:synthetic.${budgetId}`, projectId: null, ttlSeconds: 3600 });
  return orders.insert(trx, { agreement_id: a.id, accepted_terms_digest: a.accepted_terms_digest, context_kind: 'rfq', context_id: a.rfq_id,
    external_reference: null, amount_minor: '100', currency: 'USD', transaction_budget_id: budgetId, reservation_id: reservation.id,
    placed_by_person_id: buyer, placed_via: 'person', placed_mandate_id: null });
});

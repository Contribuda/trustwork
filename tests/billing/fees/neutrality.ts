import { compareQuotes } from '../../../packages/contracts/src/deals.js';
import { computeAgreementDigest, computeDigest, type QuoteVersionPayload } from '@trustwork/contracts';
import { computeReputation, type ReputationInputs } from '../../../apps/api/src/modules/trust/method.js';

/** Non-empty synthetic commercial and reputation inputs, evaluated by the actual production functions. */
export function neutralOutputs(personId: string) {
  const digest = (value: string) => computeDigest({ synthetic: value });
  const ref = (id: string) => ({ id, version: 1, digest: digest(id) });
  const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
  const rfq = { ...ref('synthetic-rfq'), payload: {
    title: 'Synthetic neutral RFQ', currency: 'USD', responseDeadline: '2029-06-01T00:00:00Z', attachments: [], acceptanceCriteria: 'Synthetic criteria', paymentTermsRequested: null,
    lines: [{ lineId: 'synthetic-line', kind: 'goods' as const, description: 'Synthetic item', specification: {}, quantity: { value: '1', unit: 'm2' }, alternativesAllowed: false }],
    deliveryTerms: { location: { region: 'US-CA' }, window: { from: { date: '2029-06-01', timeZone: 'UTC' }, to: { date: '2029-06-02', timeZone: 'UTC' } } },
  } };
  const quote = (amount: string): QuoteVersionPayload => ({
    currency: 'USD', paymentTerms: 'Synthetic terms', validity: { until: '2029-06-01T00:00:00Z' }, exclusions: [], attachments: [],
    deliveryTerms: { milestones: [], location: 'Synthetic site' }, totals: { net: money(amount), tax: money('0'), gross: money(amount) },
    lines: [{ lineId: 'synthetic-quote-line', rfqLineId: 'synthetic-line', kind: 'goods', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'm2' },
      unitPrice: money(amount), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: money('0'), lineTotal: money(amount), substitution: null, options: [] }],
  });
  const now = new Date('2029-01-01T00:00:00Z');
  const inputs: ReputationInputs = { subject: { kind: 'person', id: personId }, observations: ['a','b','c'].map((id) => ({
    id: 'synthetic-'+id, dimension: 'timing', outcome: 'on_time', excludedReason: null, lateDays: 0, createdAt: now.toISOString(), dispute: null, appeal: null,
  })), defects: [], reviews: [], owed: [] };
  return {
    comparison: compareQuotes({ rfqId: rfq.id, mode: 'current', currentRfqVersion: rfq, now, versions: ['100','200'].map((amount) => ({
      quoteId: 'synthetic-'+amount, seller: { kind: 'person', id: personId }, version: ref('synthetic-'+amount), rfqVersion: rfq, status: 'sent', payload: quote(amount),
    })) }),
    reputation: computeReputation(inputs, now),
    acceptanceDigest: computeAgreementDigest(ref('synthetic-100'), ref('synthetic-rfq')),
  };
}

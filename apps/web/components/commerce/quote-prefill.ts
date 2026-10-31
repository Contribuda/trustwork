import type { QuoteVersionPayload, RfqVersionPayload } from '@trustwork/contracts/client';
import { lineAmounts, totals, type TaxKind } from './quote-math';

const DAY = 86_400_000;

/**
 * The payload of a new quote draft answering an exact RFQ version (WEB-002): every RFQ line is answered once, with the
 * buyer's specification, kind, quantity and unit copied (the seller never re-enters them, WCAG 2.2 3.3.7). A previous
 * version's prices, taxes, substitutions and terms carry over by RFQ line id (amendments keep line ids); quantities
 * always follow the new RFQ version, so a quote for 10 never silently becomes a quote for 12. Totals are exact.
 */
export function prefillQuotePayload(rfq: RfqVersionPayload, previous: QuoteVersionPayload | null, now: number = Date.now()): QuoteVersionPayload {
  const currency = previous?.currency ?? rfq.currency;
  const lines = rfq.lines.map((rl) => {
    const before = previous?.lines.find((l) => l.rfqLineId === rl.lineId || l.substitution?.forRfqLineId === rl.lineId);
    const price = before && before.unitPrice.currency === currency ? before.unitPrice.minorUnits : '0';
    const tax: TaxKind = before?.tax.kind ?? 'none';
    const rate = tax === 'none' ? null : (before?.tax.ratePercent ?? '0');
    const amounts = lineAmounts({ unitPriceMinor: price, quantity: rl.quantity.value, tax, ratePercent: rate, currency });
    return {
      lineId: before?.lineId ?? `q-${rl.lineId}`.slice(0, 128),
      rfqLineId: before?.substitution ? null : rl.lineId,
      kind: rl.kind,
      specSnapshot: before?.substitution ? before.specSnapshot : { ...rl.specification },
      offeringVersionRef: null,
      quantity: { ...rl.quantity },
      unitPrice: { minorUnits: price, currency },
      tax: { kind: tax, ratePercent: rate, included: false },
      ...amounts,
      substitution: before?.substitution ? { ...before.substitution, forRfqLineId: rl.lineId } : null,
      options: [],
    };
  });
  const deadline = Date.parse(rfq.responseDeadline);
  const carried = previous && Date.parse(previous.validity.until) > now ? previous.validity.until : null;
  const until = carried ?? new Date(Math.max(Number.isFinite(deadline) ? deadline : now, now) + 30 * DAY).toISOString();
  return {
    currency,
    lines,
    totals: totals(lines, currency),
    deliveryTerms: previous?.deliveryTerms ?? { milestones: [], location: rfq.deliveryTerms.location.region },
    paymentTerms: previous?.paymentTerms ?? rfq.paymentTermsRequested ?? '',
    validity: { until },
    exclusions: previous?.exclusions ?? [],
    attachments: [],
  };
}

import { computeDigest, sumMoney, type Digest, type Money, type QuoteVersionPayload } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { compareDecimal } from '../../../../../packages/contracts/src/common/quantity.js';
import { feedbackBand, type AwardDecision, type BidLevelSheetPayload, type QuoteVersionRow, type SupplierStatus } from './deps.js';

/**
 * Pure award rules (PRC-004). An agreement binds a whole quote version (COM-002), so an award selects whole quote
 * versions: a split award is several suppliers each awarded everything their version quotes. Awarding part of a version,
 * or a share below 1, is refused at proposal; the supplier first sends a revised version for exactly the awarded lines.
 */
type Selection = AwardDecision['selection'];
type Reasons = AwardDecision['reasons'];

export function awardDigest(input: { rfqId: string; sheetVersionId: string; sheetDigest: string; selection: Selection; reasons: Reasons }): Digest {
  return computeDigest({ kind: 'trustwork.award_decision', version: 1, ...input });
}

export function checkSelection(selection: Selection, versions: ReadonlyMap<string, QuoteVersionRow>): void {
  const refuse = (reason: string, message: string): never => { throw new ApiError('validation.schema', message, { reason }); };
  const seenVersions = new Set<string>();
  const seenLines = new Set<string>();
  for (const item of selection) {
    if (seenVersions.has(item.quoteVersionId)) refuse('selection_duplicate', 'a quote version is selected once');
    seenVersions.add(item.quoteVersionId);
    const row = versions.get(item.quoteVersionId);
    if (!row) throw new ApiError('commercial.digest_mismatch', 'the selection names a sent version of a quote on this RFQ', { reason: 'pin_mismatch' });
    const quoted = new Set((row.payload as QuoteVersionPayload).lines.flatMap((l) => (l.rfqLineId === null ? [] : [l.rfqLineId])));
    const whole = quoted.size === new Set(item.rfqLineKeys).size && item.rfqLineKeys.every((k) => quoted.has(k));
    if (!whole || compareDecimal(item.share, '1') !== 0) refuse('partial_award_unavailable', 'an award binds a whole quote version: ask the supplier for a revised version covering exactly the awarded lines');
    for (const key of item.rfqLineKeys) {
      if (seenLines.has(key)) refuse('line_awarded_twice', 'a line is awarded to one supplier');
      seenLines.add(key);
    }
  }
}

/**
 * What the approval route weighs: the exact gross of the selected versions in their own currency. A sheet's exchange rate
 * is the buyer's own input, for display only, and never reaches a route. Selected versions in different currencies have
 * no one amount, so the answer is null and every amount condition holds (`conditionHolds` fails closed); so does a
 * condition in another currency than the award.
 */
export function awardAmount(selection: Selection, versions: ReadonlyMap<string, QuoteVersionRow>): Money | null {
  const totals = selection.map((item) => ((versions.get(item.quoteVersionId) as QuoteVersionRow).payload as QuoteVersionPayload).totals.gross);
  const currency = totals[0]?.currency;
  return currency !== undefined && totals.every((t) => t.currency === currency) ? sumMoney(totals, currency) : null;
}

/**
 * The status a route's `supplier_status_in` condition reads. The facts hold one status, so it is the status all selected
 * suppliers share. Anything else is unknown (null), which makes every such step apply: a split of two statuses, where any
 * one status could miss a step that names the other, or a selected supplier the buyer's base does not hold.
 */
export function sharedStatus(statuses: readonly (SupplierStatus | null)[]): SupplierStatus | null {
  const first = statuses[0] ?? null;
  return statuses.every((s) => s === first) ? first : null;
}

const OUTCOME_REASONS = new Set(['price', 'lead_time', 'scope', 'eligibility']);
export type Feedback = Record<string, { band: ReturnType<typeof feedbackBand> | null; reason: string | null }>;

/**
 * Banded feedback for not-awarded bidders, keyed by the recipient's id: where the supplier's own total stood relative to
 * the awarded total, and the first award reason a notice may name. A column that was not comparable, or a total in another
 * currency than the award, gets no band: a band is never computed with the buyer's own exchange rate. The totals
 * themselves stay here and never reach the notice.
 */
export function outcomeFeedback(input: { sheet: BidLevelSheetPayload; awardedVersionIds: readonly string[]; versions: ReadonlyMap<string, QuoteVersionRow>; sellerOf: (row: QuoteVersionRow) => string | undefined; reasons: Reasons }): Feedback {
  const awarded = new Set(input.awardedVersionIds);
  const awardedTotal = awardAmount(input.awardedVersionIds.map((id) => ({ quoteVersionId: id, rfqLineKeys: [], share: '1' })), input.versions);
  if (awardedTotal === null) return {};
  const reason = input.reasons.find((r) => OUTCOME_REASONS.has(r.category))?.category ?? null;
  const out: Feedback = {};
  for (const column of input.sheet.columns) {
    if (column.kind !== 'quote_version' || !column.comparable || awarded.has(column.quoteVersionId)) continue;
    const row = input.versions.get(column.quoteVersionId);
    const seller = row ? input.sellerOf(row) : undefined;
    const total = row ? (row.payload as QuoteVersionPayload).totals.gross : null;
    if (seller && total && total.currency === awardedTotal.currency) out[seller] = { band: feedbackBand(total, awardedTotal), reason };
  }
  return out;
}

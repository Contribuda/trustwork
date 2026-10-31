import { z } from 'zod';
import { PartySchema } from '../access.js';
import { DigestSchema } from '../common/digest-schema.js';
import { IdSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { ExchangeRateSnapshotSchema, MoneySchema, NonNegativeMoneySchema, sumMoney, type Money } from '../common/money.js';
import { VersionNumberSchema } from '../common/version.js';
import { ConfidenceSchema, KeySchema, NonNegativeQuantitySchema, transitionGuard } from './common.js';

/**
 * Sourcing events on top of RFQs and quotes (PRC-004): buyer-private levelling sheets over pinned quote versions,
 * award decisions through approval routes, and outcome notices that by construction carry no price and no competitor.
 */

export const BidLevelSheetStatusSchema = z.enum(['draft', 'frozen', 'superseded']);
export type BidLevelSheetStatus = z.infer<typeof BidLevelSheetStatusSchema>;
export const BID_LEVEL_SHEET_TRANSITIONS: Readonly<Record<BidLevelSheetStatus, readonly BidLevelSheetStatus[]>> = { draft: ['frozen'], frozen: ['superseded'], superseded: [] };
export const bidLevelSheetTransitionAllowed = transitionGuard(BID_LEVEL_SHEET_TRANSITIONS);

/** A column pins one quote version by id and digest, or one captured off-platform quote by its intake review. */
export const LevelColumnSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('quote_version'), key: KeySchema, quoteVersionId: IdSchema, version: VersionNumberSchema, digest: DigestSchema, comparable: z.boolean(), staleReason: z.enum(['rfq_amended', 'rfq_closed']).nullable() }),
  z.strictObject({ kind: z.literal('captured_quote'), key: KeySchema, intakeDocumentId: IdSchema, extractionReviewId: IdSchema, comparable: z.boolean(), staleReason: z.null() }),
]).refine((c) => c.staleReason === null || !c.comparable, { message: 'a stale quote version is non-comparable', path: ['comparable'] });

export const LevelCellSchema = z.strictObject({
  columnKey: KeySchema,
  rfqLineKey: KeySchema,
  normalizedQuantity: NonNegativeQuantitySchema.nullable(),
  /** Cites the unit-catalogue or product conversion used; null when no conversion was needed. */
  conversionRuleRef: IdSchema.nullable(),
  unitPrice: NonNegativeMoneySchema.nullable(),
  lineTotal: NonNegativeMoneySchema.nullable(),
  excluded: z.boolean(),
  alternate: z.boolean(),
  leadTimeDays: z.int().min(0).max(3650).nullable(),
  /** Embodied carbon in kg CO2e from product EPDs (PRC-020), when known. */
  carbonKgCo2e: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).nullable(),
}).refine((c) => !c.excluded || c.lineTotal === null, { message: 'an excluded line has no total', path: ['lineTotal'] });

/** A buyer estimate, labelled as such with its source. It never alters a quote. */
export const BuyerAdjustmentSchema = z.strictObject({
  columnKey: KeySchema,
  rfqLineKey: KeySchema.nullable(),
  kind: z.enum(['plug_for_exclusion', 'risk_allowance', 'other']),
  label: z.literal('buyer_estimate'),
  amount: MoneySchema,
  source: ShortTextSchema,
});

export const BidLevelSheetPayloadSchema = z.strictObject({
  columns: z.array(LevelColumnSchema).min(1).max(50),
  cells: z.array(LevelCellSchema).max(20_000),
  adjustments: z.array(BuyerAdjustmentSchema).max(500),
  currency: z.string().regex(/^[A-Z]{3}$/),
  exchangeRateSnapshot: ExchangeRateSnapshotSchema.nullable(),
}).refine((p) => new Set(p.columns.map((c) => c.key)).size === p.columns.length, { message: 'column keys are unique', path: ['columns'] })
  .refine((p) => { const keys = new Set(p.columns.map((c) => c.key)); return p.cells.every((c) => keys.has(c.columnKey)) && p.adjustments.every((a) => keys.has(a.columnKey)); }, { message: 'cells and adjustments reference columns', path: ['cells'] })
  .refine((p) => p.cells.every((c) => (c.lineTotal === null || c.lineTotal.currency === p.currency) && (c.unitPrice === null || c.unitPrice.currency === p.currency)) && p.adjustments.every((a) => a.amount.currency === p.currency), { message: 'one sheet currency (convert with the dated snapshot first)', path: ['currency'] })
  .refine((p) => new Set(p.cells.map((c) => `${c.columnKey}/${c.rfqLineKey}`)).size === p.cells.length, { message: 'one cell per column and line', path: ['cells'] });
export type BidLevelSheetPayload = z.infer<typeof BidLevelSheetPayloadSchema>;

export const BidLevelSheetSchema = z.strictObject({ id: IdSchema, rfqId: IdSchema, owner: PartySchema, currentVersionId: IdSchema.nullable() });
export const BidLevelSheetVersionSchema = z.strictObject({
  id: IdSchema,
  sheetId: IdSchema,
  version: VersionNumberSchema,
  rfqVersionId: IdSchema,
  status: BidLevelSheetStatusSchema,
  payload: BidLevelSheetPayloadSchema,
  digest: DigestSchema,
  preparedBy: IdSchema,
  mandateId: IdSchema.nullable(),
});
export type BidLevelSheetVersion = z.infer<typeof BidLevelSheetVersionSchema>;

/** Exact totals per column: quoted total, adjustments (labelled) and levelled total. Non-comparable columns get `null` levelled totals. */
export function levelSheetTotals(payload: BidLevelSheetPayload): { columnKey: string; quoted: Money; adjustments: Money; levelled: Money | null }[] {
  const p = BidLevelSheetPayloadSchema.parse(payload);
  return p.columns.map((col) => {
    const quoted = sumMoney(p.cells.filter((c) => c.columnKey === col.key && c.lineTotal !== null).map((c) => c.lineTotal!), p.currency);
    const adjustments = sumMoney(p.adjustments.filter((a) => a.columnKey === col.key).map((a) => a.amount), p.currency);
    return { columnKey: col.key, quoted, adjustments, levelled: col.comparable ? sumMoney([quoted, adjustments], p.currency) : null };
  });
}

/* ---------- Award decisions ---------- */

export const AwardDecisionStatusSchema = z.enum(['proposed', 'in_approval', 'approved', 'rejected', 'executed', 'cancelled']);
export type AwardDecisionStatus = z.infer<typeof AwardDecisionStatusSchema>;
export const AWARD_DECISION_TRANSITIONS: Readonly<Record<AwardDecisionStatus, readonly AwardDecisionStatus[]>> = {
  proposed: ['in_approval'], in_approval: ['approved', 'rejected'], approved: ['executed', 'cancelled'], rejected: [], executed: [], cancelled: [],
};
export const awardDecisionTransitionAllowed = transitionGuard(AWARD_DECISION_TRANSITIONS);

export const AwardReasonCategorySchema = z.enum(['price', 'lead_time', 'scope', 'eligibility', 'quality', 'other']);

export const AwardDecisionSchema = z.strictObject({
  id: IdSchema,
  rfqId: IdSchema,
  bidLevelSheetVersionId: IdSchema,
  /** Whole or by line (split awards). `share` is the fraction of the line quantity awarded. */
  selection: z.array(z.strictObject({ quoteVersionId: IdSchema, rfqLineKeys: z.array(KeySchema).min(1), share: ConfidenceSchema })).min(1).max(50),
  reasons: z.array(z.strictObject({ category: AwardReasonCategorySchema, text: ShortTextSchema })).min(1).max(20),
  approvalRequestId: IdSchema.nullable(),
  status: AwardDecisionStatusSchema,
  /** Execution happens only through the agreement and order commands (COM-002) with authority and budget reservation. */
  agreementIds: z.array(IdSchema),
}).refine((a) => a.status === 'proposed' || a.approvalRequestId !== null, { message: 'an award goes through an approval request', path: ['approvalRequestId'] })
  .refine((a) => (a.status === 'executed') === (a.agreementIds.length > 0), { message: 'agreements exist exactly when executed', path: ['agreementIds'] });
export type AwardDecision = z.infer<typeof AwardDecisionSchema>;

/* ---------- Outcome notices ---------- */

export const FeedbackBandSchema = z.enum(['within_5pct', 'within_15pct', 'above_15pct']);
export const OutcomeReasonCategorySchema = z.enum(['price', 'lead_time', 'scope', 'eligibility']);

/**
 * Sent to every invitee. Strict and minimal by construction: no amount, price, line, total, competitor, winner or other
 * bidder field exists. A band and a reason category appear only for a not-awarded supplier, only after award and only
 * when the buyer opted in for this sourcing event.
 */
export const BidOutcomeNoticeSchema = z.strictObject({
  id: IdSchema,
  rfqId: IdSchema,
  recipient: PartySchema,
  outcome: z.enum(['awarded', 'not_awarded', 'cancelled']),
  feedbackBand: FeedbackBandSchema.nullable(),
  reasonCategory: OutcomeReasonCategorySchema.nullable(),
  buyerOptedInToFeedback: z.boolean(),
  sentAt: TimestampSchema,
}).refine((n) => (n.feedbackBand === null && n.reasonCategory === null) || (n.outcome === 'not_awarded' && n.buyerOptedInToFeedback), { message: 'feedback only for a not-awarded supplier with the buyer opt-in', path: ['feedbackBand'] });
export type BidOutcomeNotice = z.infer<typeof BidOutcomeNoticeSchema>;

/** Band of a not-awarded total relative to the awarded total, computed exactly (the totals themselves never leave the buyer). */
export function feedbackBand(bidTotal: Money, awardedTotal: Money): z.infer<typeof FeedbackBandSchema> {
  if (bidTotal.currency !== awardedTotal.currency) throw new Error('feedbackBand needs one currency');
  const bid = BigInt(bidTotal.minorUnits);
  const won = BigInt(awardedTotal.minorUnits);
  if (won <= 0n) return 'above_15pct';
  const diff = bid > won ? bid - won : won - bid;
  if (diff * 100n <= won * 5n) return 'within_5pct';
  if (diff * 100n <= won * 15n) return 'within_15pct';
  return 'above_15pct';
}

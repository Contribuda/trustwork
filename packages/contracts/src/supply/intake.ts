import { z } from 'zod';
import { PartySchema } from '../access.js';
import { Sha256HexSchema } from '../common/digest-schema.js';
import { IdSchema, TimestampSchema } from '../common/ids.js';
import { compareDecimal } from '../common/quantity.js';
import { ExactFactorSchema } from '../common/units.js';
import { ConfidenceSchema, LocatorSchema, transitionGuard } from './common.js';

/**
 * AI document intake (PRC-005). Documents are untrusted data: extraction drafts records and never approves, pays,
 * orders, changes a payee or contacts anyone. The only path from a document to a record is a person's review.
 */

export const IntakeDocumentKindSchema = z.enum(['quote', 'invoice', 'credit_note', 'delivery_note', 'price_list', 'takeoff', 'requisition_sheet', 'certificate', 'other']);
export type IntakeDocumentKind = z.infer<typeof IntakeDocumentKindSchema>;
export const IntakeChannelSchema = z.enum(['upload', 'email', 'e_document', 'mobile_photo', 'api']);

export const INTAKE_STATUSES = ['received', 'duplicate_suspected', 'extracting', 'extraction_failed', 'awaiting_review', 'accepted', 'discarded'] as const;
export const IntakeStatusSchema = z.enum(INTAKE_STATUSES);
export type IntakeStatus = z.infer<typeof IntakeStatusSchema>;
/**
 * `received → extracting → awaiting_review → accepted | discarded`, with `duplicate_suspected` checked before any
 * extraction cost and `extraction_failed` (retry or manual entry). Nothing reaches `accepted` without `awaiting_review`.
 */
export const INTAKE_TRANSITIONS: Readonly<Record<IntakeStatus, readonly IntakeStatus[]>> = {
  received: ['duplicate_suspected', 'extracting', 'awaiting_review', 'discarded'],
  duplicate_suspected: ['extracting', 'discarded'],
  extracting: ['awaiting_review', 'extraction_failed'],
  extraction_failed: ['extracting', 'awaiting_review', 'discarded'],
  awaiting_review: ['accepted', 'discarded'],
  accepted: [], discarded: [],
};
export const intakeTransitionAllowed = transitionGuard(INTAKE_TRANSITIONS);

/** What the sender claims to be. Always labelled untrusted; it never identifies a payee or authorizes anything. */
export const SenderClaimSchema = z.strictObject({
  trust: z.literal('untrusted'),
  displayName: z.string().max(200).nullable(),
  emailDomain: z.string().regex(/^[a-z0-9.-]{1,253}$/).nullable(),
  networkParticipantId: z.string().max(120).nullable(),
});

export const IntakeDocumentSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  fileId: IdSchema,
  kind: IntakeDocumentKindSchema,
  channel: IntakeChannelSchema,
  contentDigest: Sha256HexSchema,
  senderClaim: SenderClaimSchema,
  status: IntakeStatusSchema,
  duplicateOfId: IdSchema.nullable(),
  /** The draft created by the accepted review, if any. */
  result: z.strictObject({ kind: z.enum(['captured_quote', 'trade_invoice', 'goods_receipt', 'requisition', 'price_list', 'takeoff']), id: IdSchema }).nullable(),
  receivedAt: TimestampSchema,
}).refine((d) => d.status === 'accepted' || d.result === null, { message: 'only an accepted review creates a draft', path: ['result'] })
  .refine((d) => d.status !== 'duplicate_suspected' || d.duplicateOfId !== null, { message: 'a suspected duplicate names the original', path: ['duplicateOfId'] });
export type IntakeDocument = z.infer<typeof IntakeDocumentSchema>;

/** Every field carries a value, a confidence and a locator. Values are strings: extraction never produces numbers or commands. */
export const ExtractedFieldSchema = z.strictObject({ value: z.string().max(2000).nullable(), confidence: ConfidenceSchema, locator: LocatorSchema.nullable() })
  .refine((f) => f.value === null || f.locator !== null, { message: 'an extracted value cites where it came from', path: ['locator'] });
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;
const FieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const ExtractionRunSchema = z.strictObject({
  id: IdSchema,
  intakeDocumentId: IdSchema,
  engine: z.enum(['structured_parser', 'template', 'model']),
  modelRouteId: IdSchema.nullable(),
  adapterVersion: z.string().min(1).max(40),
  fields: z.record(FieldNameSchema, ExtractedFieldSchema),
  lines: z.array(z.record(FieldNameSchema, ExtractedFieldSchema)).max(5000),
  pagesProcessed: z.int().min(0).max(100_000),
  usageRecordId: IdSchema.nullable(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
}).refine((r) => (r.engine === 'model') === (r.modelRouteId !== null), { message: 'a model run names its model route (egress per the hub matrix)', path: ['modelRouteId'] });
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;

/** The person's review: the only path from a document to a record. It creates drafts, never approvals or payments. */
export const ExtractionReviewSchema = z.strictObject({
  id: IdSchema,
  intakeDocumentId: IdSchema,
  extractionRunId: IdSchema.nullable(),
  corrections: z.record(FieldNameSchema, z.string().max(2000).nullable()),
  reviewedByPersonId: IdSchema,
  reviewedVia: z.literal('first_party'),
  acceptedAt: TimestampSchema,
  created: z.strictObject({ kind: z.enum(['captured_quote', 'trade_invoice', 'goods_receipt', 'requisition', 'price_list', 'takeoff']), id: IdSchema, state: z.literal('draft') }).nullable(),
});
export type ExtractionReview = z.infer<typeof ExtractionReviewSchema>;

/** Fields below the company's threshold must be touched by the reviewer. No threshold lets intake approve anything. */
export function fieldsNeedingTouch(fields: Readonly<Record<string, ExtractedField>>, threshold: string): string[] {
  ConfidenceSchema.parse(threshold);
  return Object.entries(fields).filter(([, f]) => compareDecimal(f.confidence, threshold) < 0).map(([name]) => name).sort();
}

export const LineMatchKindSchema = z.enum(['exact', 'equivalent', 'substitute_proposed', 'unmatched']);
export const LineMatchSchema = z.strictObject({
  id: IdSchema,
  source: z.strictObject({ kind: z.enum(['intake_document', 'trade_invoice_version']), id: IdSchema }),
  lineNo: z.int().min(1),
  target: z.strictObject({ kind: z.enum(['rfq_line', 'quote_line', 'order_line', 'offering_version', 'product_entry', 'stock_item']), id: IdSchema }).nullable(),
  matchKind: LineMatchKindSchema,
  equivalenceRuleVersionId: IdSchema.nullable(),
  unitConversion: z.strictObject({ from: z.string().min(1).max(16), to: z.string().min(1).max(16), factor: ExactFactorSchema, ruleRef: IdSchema }).nullable(),
  confidence: ConfidenceSchema,
  confirmedBy: IdSchema.nullable(),
}).refine((m) => (m.matchKind === 'unmatched') === (m.target === null), { message: 'unmatched exactly when there is no target', path: ['target'] })
  .refine((m) => (m.matchKind === 'equivalent') === (m.equivalenceRuleVersionId !== null), { message: 'an equivalent match cites its rule', path: ['equivalenceRuleVersionId'] });
export type LineMatch = z.infer<typeof LineMatchSchema>;

export const DiscrepancyKindIntakeSchema = z.enum([
  'price_differs', 'quantity_exceeds_ordered', 'quantity_exceeds_received', 'unit_differs', 'tax_differs', 'total_mismatch', 'terms_differ', 'payee_differs', 'possible_duplicate',
]);
export const DiscrepancySchema = z.strictObject({
  kind: DiscrepancyKindIntakeSchema,
  lineNo: z.int().min(1).nullable(),
  expected: z.string().max(200).nullable(),
  found: z.string().max(200).nullable(),
  /** `payee_differs` always raises a payment risk signal; the document never changes a payee. */
  raisesRiskSignal: z.boolean(),
}).refine((d) => d.kind !== 'payee_differs' || d.raisesRiskSignal, { message: 'a differing payee raises a risk signal', path: ['raisesRiskSignal'] });

import { z } from 'zod';
import { PartySchema } from '../access.js';
import { DigestSchema } from '../common/digest-schema.js';
import { BusinessDateSchema, IdSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { MoneySchema, NonNegativeMoneySchema } from '../common/money.js';
import { compareDecimal, decimalToScaled, QuantitySchema, type Quantity } from '../common/quantity.js';
import { VersionNumberSchema } from '../common/version.js';
import { KeySchema, multiplyDecimalByMinorUnits, NonNegativeDecimalSchema, NonNegativeQuantitySchema, subtractDecimals, sumDecimals } from './common.js';

/**
 * Trade invoices between participants (or from an external supplier to a participant), tolerance policies and the
 * exact two-, three- and four-way match (PRC-010). Distinct from billing `invoice`, which is the hub's own fee invoice.
 */

export const TRADE_INVOICE_STATUSES = [
  'received', 'in_review', 'duplicate_suspected', 'exception', 'matched', 'in_approval', 'approved', 'scheduled', 'partially_paid', 'paid', 'payment_unknown', 'disputed', 'rejected', 'credited', 'cancelled',
] as const;
export const TradeInvoiceStatusSchema = z.enum(TRADE_INVOICE_STATUSES);
export type TradeInvoiceStatus = z.infer<typeof TradeInvoiceStatusSchema>;
/**
 * docs/data/lifecycles.md (trade invoice diagram). `cancelled` is the issuer withdrawing an invoice before it is
 * matched. `payment_unknown` only reconciles; it never goes back to a retry by itself.
 */
export const TRADE_INVOICE_TRANSITIONS: Readonly<Record<TradeInvoiceStatus, readonly TradeInvoiceStatus[]>> = {
  received: ['in_review', 'cancelled'],
  in_review: ['duplicate_suspected', 'exception', 'matched', 'cancelled'],
  duplicate_suspected: ['in_review', 'rejected'],
  exception: ['in_review', 'cancelled'],
  matched: ['in_approval'],
  in_approval: ['approved', 'rejected'],
  approved: ['scheduled', 'disputed'],
  disputed: ['approved'],
  scheduled: ['paid', 'partially_paid', 'payment_unknown'],
  partially_paid: ['paid'],
  payment_unknown: ['paid', 'scheduled'],
  paid: ['credited'],
  rejected: [], credited: [], cancelled: [],
};
/** An open payment risk signal blocks `in_approval → approved` and `approved → scheduled`. */
export function tradeInvoiceTransitionAllowed(from: TradeInvoiceStatus, to: TradeInvoiceStatus, facts: { openRiskSignals: number } = { openRiskSignals: 0 }): boolean {
  if (!TRADE_INVOICE_TRANSITIONS[from].includes(to)) return false;
  if (facts.openRiskSignals > 0 && ((from === 'in_approval' && to === 'approved') || (from === 'approved' && to === 'scheduled'))) return false;
  return true;
}

export const TradeInvoiceSchema = z.strictObject({
  id: IdSchema,
  /** Exactly one issuer: a platform party or an external counterparty of the recipient. */
  issuer: PartySchema.nullable(),
  externalCounterpartyId: IdSchema.nullable(),
  recipient: PartySchema,
  number: z.string().min(1).max(80),
  basis: z.strictObject({ kind: z.enum(['order', 'external_order', 'agreement', 'pay_application', 'milestone']), id: IdSchema }),
  origin: z.enum(['platform', 'e_document', 'intake']),
  status: TradeInvoiceStatusSchema,
  currentVersionId: IdSchema,
  duplicateOf: IdSchema.nullable(),
  eDocumentExchangeId: IdSchema.nullable(),
}).refine((i) => (i.issuer === null) !== (i.externalCounterpartyId === null), { message: 'exactly one issuer', path: ['issuer'] })
  .refine((i) => i.status !== 'duplicate_suspected' || i.duplicateOf !== null, { message: 'a suspected duplicate names the original', path: ['duplicateOf'] });
export type TradeInvoice = z.infer<typeof TradeInvoiceSchema>;

export const TradeInvoiceLineSchema = z.strictObject({
  lineNo: z.int().min(1).max(10_000),
  orderLineRef: KeySchema.nullable(),
  description: ShortTextSchema,
  quantity: QuantitySchema,
  unitPrice: MoneySchema,
  taxDeterminationId: IdSchema.nullable(),
  taxAmount: MoneySchema,
  lineTotal: MoneySchema,
});
export type TradeInvoiceLine = z.infer<typeof TradeInvoiceLineSchema>;

export const TradeInvoiceVersionSchema = z.strictObject({
  id: IdSchema,
  tradeInvoiceId: IdSchema,
  version: VersionNumberSchema,
  kind: z.enum(['invoice', 'credit_note', 'replacement']),
  correctsVersionId: IdSchema.nullable(),
  payload: z.strictObject({
    lines: z.array(TradeInvoiceLineSchema).min(1).max(5000),
    total: MoneySchema,
    taxTotal: MoneySchema,
    dueDate: BusinessDateSchema.nullable(),
    paymentTerms: ShortTextSchema.nullable(),
    /** The verified payee account of the issuer; a bank account written in the document is never used. */
    payeeAccountId: IdSchema.nullable(),
  }).refine((p) => p.lines.every((l) => l.unitPrice.currency === p.total.currency && l.taxAmount.currency === p.total.currency && l.lineTotal.currency === p.total.currency) && p.taxTotal.currency === p.total.currency, { message: 'one invoice currency', path: ['total'] })
    .refine((p) => new Set(p.lines.map((l) => l.lineNo)).size === p.lines.length, { message: 'line numbers are unique', path: ['lines'] }),
  digest: DigestSchema,
  issuedAt: TimestampSchema,
}).refine((v) => (v.kind === 'invoice') === (v.correctsVersionId === null), { message: 'credit notes and replacements reference the corrected version', path: ['correctsVersionId'] });
export type TradeInvoiceVersion = z.infer<typeof TradeInvoiceVersionSchema>;

/** Arithmetic consistency of a version (exact): line totals, tax total and grand total. A mismatch is a discrepancy, not a schema error. */
export function invoiceArithmeticMismatches(payload: TradeInvoiceVersion['payload']): string[] {
  const out: string[] = [];
  let net = 0n;
  let tax = 0n;
  for (const l of payload.lines) {
    const expected = multiplyDecimalByMinorUnits(l.quantity.value, l.unitPrice.minorUnits);
    if (expected !== BigInt(l.lineTotal.minorUnits)) out.push(`line ${l.lineNo}: total`);
    net += BigInt(l.lineTotal.minorUnits);
    tax += BigInt(l.taxAmount.minorUnits);
  }
  if (tax !== BigInt(payload.taxTotal.minorUnits)) out.push('tax total');
  if (net + tax !== BigInt(payload.total.minorUnits)) out.push('grand total');
  return out;
}

/* ---------- Tolerance policies ---------- */

/**
 * A limit on over-billing. Every non-null limit must hold (the stricter one wins); with both limits null the
 * tolerance is zero. Percentages are of the expected amount or quantity.
 */
export const MoneyToleranceSchema = z.strictObject({ percent: NonNegativeDecimalSchema.nullable(), absolute: NonNegativeMoneySchema.nullable() });
export const QuantityToleranceSchema = z.strictObject({ percent: NonNegativeDecimalSchema.nullable(), absolute: NonNegativeDecimalSchema.nullable() });
export const MatchTolerancePolicyPayloadSchema = z.strictObject({
  price: MoneyToleranceSchema,
  quantity: QuantityToleranceSchema,
  tax: MoneyToleranceSchema,
  invoiceTotal: MoneyToleranceSchema,
});
export type MatchTolerancePolicyPayload = z.infer<typeof MatchTolerancePolicyPayloadSchema>;

export const MatchTolerancePolicyVersionSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema.nullable(),
  /** Hub template when `owner` is null. */
  hubId: IdSchema.nullable(),
  version: VersionNumberSchema,
  payload: MatchTolerancePolicyPayloadSchema,
  status: z.enum(['draft', 'active', 'superseded']),
}).refine((p) => (p.owner === null) !== (p.hubId === null), { message: 'a company policy or a hub template', path: ['owner'] });

/* ---------- Three-way match ---------- */

export const MatchModeSchema = z.enum(['two_way', 'three_way', 'four_way']);
export const MatchLineResultSchema = z.enum(['matched', 'within_tolerance', 'price_variance', 'quantity_variance', 'tax_variance', 'no_receipt', 'no_acceptance', 'no_order']);
export type MatchLineResult = z.infer<typeof MatchLineResultSchema>;

export const MatchLineInputSchema = z.strictObject({
  lineNo: z.int().min(1),
  mode: MatchModeSchema,
  order: z.strictObject({ orderLineRef: KeySchema, quantity: NonNegativeQuantitySchema, unitPrice: NonNegativeMoneySchema }).nullable(),
  /** Receipt lines in the order line's unit. */
  receipts: z.array(z.strictObject({ receiptLineRef: IdSchema, received: NonNegativeDecimalSchema, accepted: NonNegativeDecimalSchema })),
  /** Four-way: whether an acceptance record exists where the agreement requires inspection. */
  acceptanceRecorded: z.boolean(),
  /** Quantity of this order line already invoiced on earlier invoices. */
  previouslyInvoiced: NonNegativeDecimalSchema,
  invoiced: z.strictObject({ quantity: NonNegativeQuantitySchema, unitPrice: NonNegativeMoneySchema, taxAmount: NonNegativeMoneySchema, expectedTax: NonNegativeMoneySchema }),
});
export type MatchLineInput = z.infer<typeof MatchLineInputSchema>;

export type MatchLineOutcome = {
  lineNo: number;
  result: MatchLineResult;
  expectedQuantity: Quantity | null;
  quantityOver: string;
  priceOverMinorUnits: string;
  taxOverMinorUnits: string;
};
export type MatchOutcome = { lines: MatchLineOutcome[]; overall: 'matched' | 'within_tolerance' | 'exception'; invoiceOverMinorUnits: string };

/** `over <= absolute` and `over * 100 <= percent * base` for every non-null limit, computed exactly on scaled integers. */
function within(over: string, base: string, percent: string | null, absolute: string | null): boolean {
  if (compareDecimal(over, '0') <= 0) return true;
  if (percent === null && absolute === null) return false;
  if (absolute !== null && compareDecimal(over, absolute) > 0) return false;
  if (percent !== null) {
    const [o, b, p] = [decimalToScaled(over), decimalToScaled(base), decimalToScaled(percent)];
    const lhs = o.scaled * 100n * 10n ** BigInt(b.scale + p.scale);
    const rhs = p.scaled * b.scaled * 10n ** BigInt(o.scale);
    if (lhs > rhs) return false;
  }
  return true;
}
const positive = (d: string) => (compareDecimal(d, '0') > 0 ? d : '0');
const normalize = (d: string) => (compareDecimal(d, '0') === 0 ? '0' : d);

/**
 * Exact match of one invoice against orders and receipts. Over-billing beyond the policy is a variance; billing at or
 * under the agreed price and the available quantity matches. Units or currencies that differ fail closed (variance).
 * Two-way compares with the ordered quantity (services, non-receivable lines), three-way with the accepted quantity,
 * four-way additionally requires the acceptance record. A suspected duplicate makes the whole invoice an exception.
 */
export function threeWayMatch(lines: readonly MatchLineInput[], policy: MatchTolerancePolicyPayload, options: { duplicateSuspected: boolean } = { duplicateSuspected: false }): MatchOutcome {
  const pol = MatchTolerancePolicyPayloadSchema.parse(policy);
  let invoiced = 0n;
  let expectedTotal = 0n;
  const out = lines.map((raw): MatchLineOutcome => {
    const l = MatchLineInputSchema.parse(raw);
    const base = { lineNo: l.lineNo, expectedQuantity: null, quantityOver: '0', priceOverMinorUnits: '0', taxOverMinorUnits: '0' };
    invoiced += multiplyDecimalByMinorUnits(l.invoiced.quantity.value, l.invoiced.unitPrice.minorUnits) + BigInt(l.invoiced.taxAmount.minorUnits);
    if (l.order === null) return { ...base, result: 'no_order' };
    const unit = l.order.quantity.unit;
    const received = sumDecimals(l.receipts.map((r) => r.received));
    const accepted = sumDecimals(l.receipts.map((r) => r.accepted));
    if (l.mode !== 'two_way' && (l.receipts.length === 0 || compareDecimal(received, '0') === 0)) return { ...base, result: 'no_receipt' };
    if (l.mode === 'four_way' && !l.acceptanceRecorded) return { ...base, result: 'no_acceptance' };
    const basisQuantity = l.mode === 'two_way' ? l.order.quantity.value : accepted;
    const available = positive(subtractDecimals(basisQuantity, l.previouslyInvoiced));
    const expectedQuantity = { value: normalize(available), unit };
    const quantityOver = l.invoiced.quantity.unit === unit ? normalize(positive(subtractDecimals(l.invoiced.quantity.value, available))) : l.invoiced.quantity.value;
    const sameCurrency = l.invoiced.unitPrice.currency === l.order.unitPrice.currency && l.invoiced.taxAmount.currency === l.order.unitPrice.currency && l.invoiced.expectedTax.currency === l.order.unitPrice.currency;
    const priceOver = BigInt(l.invoiced.unitPrice.minorUnits) - BigInt(l.order.unitPrice.minorUnits);
    const taxOver = BigInt(l.invoiced.taxAmount.minorUnits) - BigInt(l.invoiced.expectedTax.minorUnits);
    const priceOverMinorUnits = (priceOver > 0n ? priceOver : 0n).toString();
    const taxOverMinorUnits = (taxOver > 0n ? taxOver : 0n).toString();
    const billable = compareDecimal(l.invoiced.quantity.value, available) < 0 ? l.invoiced.quantity.value : available;
    expectedTotal += multiplyDecimalByMinorUnits(billable, l.order.unitPrice.minorUnits) + BigInt(l.invoiced.expectedTax.minorUnits);
    const filled = { ...base, expectedQuantity, quantityOver, priceOverMinorUnits, taxOverMinorUnits };
    if (l.invoiced.quantity.unit !== unit || !within(quantityOver, available, pol.quantity.percent, pol.quantity.absolute)) return { ...filled, result: 'quantity_variance' };
    const priceAbs = pol.price.absolute && pol.price.absolute.currency === l.order.unitPrice.currency ? pol.price.absolute.minorUnits : pol.price.absolute ? '0' : null;
    if (!sameCurrency || !within(priceOverMinorUnits, l.order.unitPrice.minorUnits, pol.price.percent, priceAbs)) return { ...filled, result: 'price_variance' };
    const taxAbs = pol.tax.absolute && pol.tax.absolute.currency === l.order.unitPrice.currency ? pol.tax.absolute.minorUnits : pol.tax.absolute ? '0' : null;
    if (!within(taxOverMinorUnits, l.invoiced.expectedTax.minorUnits, pol.tax.percent, taxAbs)) return { ...filled, result: 'tax_variance' };
    const exact = compareDecimal(quantityOver, '0') === 0 && priceOver <= 0n && taxOver <= 0n;
    return { ...filled, result: exact ? 'matched' : 'within_tolerance' };
  });
  const over = invoiced - expectedTotal;
  const invoiceOverMinorUnits = (over > 0n ? over : 0n).toString();
  const currency = lines.find((l) => l.order !== null)?.order?.unitPrice.currency;
  const totalAbs = pol.invoiceTotal.absolute && pol.invoiceTotal.absolute.currency === currency ? pol.invoiceTotal.absolute.minorUnits : pol.invoiceTotal.absolute ? '0' : null;
  const totalWithin = within(invoiceOverMinorUnits, (expectedTotal > 0n ? expectedTotal : 0n).toString(), pol.invoiceTotal.percent, totalAbs);
  const failed = out.some((l) => l.result !== 'matched' && l.result !== 'within_tolerance');
  const overall = options.duplicateSuspected || failed || !totalWithin ? 'exception' : out.every((l) => l.result === 'matched') && over <= 0n ? 'matched' : 'within_tolerance';
  return { lines: out, overall, invoiceOverMinorUnits };
}

/** Stored result of a match run (append-only; recomputed on any new receipt, credit note or version). */
export const InvoiceMatchSchema = z.strictObject({
  id: IdSchema,
  tradeInvoiceVersionId: IdSchema,
  tolerancePolicyVersionId: IdSchema,
  lines: z.array(z.strictObject({ lineNo: z.int().min(1), orderLineRef: KeySchema.nullable(), receiptLineRefs: z.array(IdSchema), result: MatchLineResultSchema })),
  overall: z.enum(['matched', 'within_tolerance', 'exception']),
  duplicateSuspected: z.boolean(),
  computedAt: TimestampSchema,
}).refine((m) => !m.duplicateSuspected || m.overall === 'exception', { message: 'a suspected duplicate is an exception', path: ['overall'] });

/** Duplicate detection key: same issuer and normalized invoice number (case, spaces, punctuation and leading zeros of digit runs ignored). */
export function normalizedInvoiceNumber(n: string): string {
  return n.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(^|[A-Z])0+(?=\d)/g, '$1');
}

/** What the supplier sees of its own invoice: status and dates, never approvers, budgets or match notes. */
export const SupplierInvoiceStatusViewSchema = z.strictObject({
  tradeInvoiceId: IdSchema,
  number: z.string().min(1).max(80),
  status: z.enum(['received', 'in_review', 'approved', 'scheduled', 'paid', 'disputed', 'rejected', 'credited']),
  scheduledFor: BusinessDateSchema.nullable(),
  paidOn: BusinessDateSchema.nullable(),
  disputeReasonCategory: z.enum(['price', 'quantity', 'quality', 'documents', 'other']).nullable(),
});
const SUPPLIER_STATUS: Readonly<Record<TradeInvoiceStatus, z.infer<typeof SupplierInvoiceStatusViewSchema>['status']>> = {
  received: 'received', in_review: 'in_review', duplicate_suspected: 'in_review', exception: 'in_review', matched: 'in_review', in_approval: 'in_review',
  approved: 'approved', scheduled: 'scheduled', partially_paid: 'scheduled', payment_unknown: 'scheduled', paid: 'paid', disputed: 'disputed', rejected: 'rejected', credited: 'credited', cancelled: 'rejected',
};
/** Projection for the issuer: internal states (duplicate suspicion, exceptions, approvals) collapse to "in review". */
export function toSupplierInvoiceStatusView(i: TradeInvoice, dates: { scheduledFor: z.infer<typeof BusinessDateSchema> | null; paidOn: z.infer<typeof BusinessDateSchema> | null; disputeReasonCategory: z.infer<typeof SupplierInvoiceStatusViewSchema>['disputeReasonCategory'] }) {
  return SupplierInvoiceStatusViewSchema.parse({ tradeInvoiceId: i.id, number: i.number, status: SUPPLIER_STATUS[i.status], ...dates });
}

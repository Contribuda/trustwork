import { z } from 'zod';
import { PartySchema } from '../access.js';
import { DigestSchema } from '../common/digest-schema.js';
import { BusinessDateSchema, IdSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { compareMoney, NonNegativeMoneySchema, sumMoney, type Money } from '../common/money.js';
import { compareDecimal } from '../common/quantity.js';
import { EvidenceRefsSchema, KeySchema, NonNegativeQuantitySchema, PositiveQuantitySchema, sumDecimals, transitionGuard } from './common.js';

/**
 * Purchase-order extensions (PRC-002, PRC-004, PRC-008): framework terms and call-offs, external orders for suppliers
 * that are not on the platform, dispatch notices and order-line balances. Platform orders stay `order` rows (COM-002).
 */

/**
 * Terms of a framework agreement: rates and maximum quantities or value for a period. Proposed extension
 * `agreement.terms_kind = framework` (integrator request); defined here so that call-offs can be checked now.
 */
export const FrameworkTermsSchema = z.strictObject({
  agreementId: IdSchema,
  period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  lines: z.array(z.strictObject({ lineKey: KeySchema, unitRate: NonNegativeMoneySchema, maxQuantity: PositiveQuantitySchema.nullable() })).min(1).max(500),
  maxValue: NonNegativeMoneySchema.nullable(),
}).refine((f) => f.period.to >= f.period.from, { message: 'period ends after it starts', path: ['period'] })
  .refine((f) => new Set(f.lines.map((l) => l.lineKey)).size === f.lines.length, { message: 'line keys are unique', path: ['lines'] });
export type FrameworkTerms = z.infer<typeof FrameworkTermsSchema>;

export const CallOffLineSchema = z.strictObject({ lineKey: KeySchema, quantity: PositiveQuantitySchema, amount: NonNegativeMoneySchema });
export const CallOffSchema = z.strictObject({
  id: IdSchema,
  frameworkAgreementId: IdSchema,
  orderId: IdSchema.nullable(),
  lines: z.array(CallOffLineSchema).min(1).max(500),
  status: z.enum(['draft', 'placed', 'accepted', 'cancelled', 'fulfilled']),
  reservationId: IdSchema.nullable(),
}).refine((c) => c.status === 'draft' || c.status === 'cancelled' || c.reservationId !== null, { message: 'a placed call-off reserves the transaction budget', path: ['reservationId'] });
export type CallOff = z.infer<typeof CallOffSchema>;

/**
 * Serialized check: a new call-off plus the active earlier ones never exceed the framework's maximum quantity per
 * line or its maximum value. Lines not in the framework, other units or currencies fail closed.
 */
export function callOffWithinFramework(terms: FrameworkTerms, earlier: readonly z.infer<typeof CallOffSchema>[], next: z.infer<typeof CallOffSchema>): boolean {
  const active = [...earlier.filter((c) => c.status !== 'cancelled' && c.id !== next.id), next];
  for (const line of next.lines) {
    const frame = terms.lines.find((l) => l.lineKey === line.lineKey);
    if (!frame || line.amount.currency !== frame.unitRate.currency) return false;
    if (frame.maxQuantity !== null) {
      const used = active.flatMap((c) => c.lines.filter((l) => l.lineKey === line.lineKey).map((l) => l.quantity));
      if (used.some((q) => q.unit !== frame.maxQuantity!.unit)) return false;
      if (compareDecimal(sumDecimals(used.map((q) => q.value)), frame.maxQuantity.value) > 0) return false;
    }
  }
  if (terms.maxValue !== null) {
    const amounts: Money[] = active.flatMap((c) => c.lines.map((l) => l.amount));
    if (amounts.some((a) => a.currency !== terms.maxValue!.currency)) return false;
    if (compareMoney(sumMoney(amounts, terms.maxValue.currency), terms.maxValue) > 0) return false;
  }
  return true;
}

export const ExternalOrderStatusSchema = z.enum(['draft', 'sent', 'acknowledged', 'partially_received', 'received', 'closed', 'cancelled']);
export type ExternalOrderStatus = z.infer<typeof ExternalOrderStatusSchema>;
/** `draft → sent → acknowledged → partially_received → received → closed`, or `cancelled` before goods arrive. */
export const EXTERNAL_ORDER_TRANSITIONS: Readonly<Record<ExternalOrderStatus, readonly ExternalOrderStatus[]>> = {
  draft: ['sent', 'cancelled'],
  sent: ['acknowledged', 'partially_received', 'received', 'cancelled'],
  acknowledged: ['partially_received', 'received', 'cancelled'],
  partially_received: ['received'],
  received: ['closed'],
  closed: [], cancelled: [],
};
export const externalOrderTransitionAllowed = transitionGuard(EXTERNAL_ORDER_TRANSITIONS);

export const ExternalOrderLineSchema = z.strictObject({ lineKey: KeySchema, description: ShortTextSchema, quantity: PositiveQuantitySchema, unitPrice: NonNegativeMoneySchema, costCodeId: IdSchema.nullable() });

/** A buyer-private record of an order to an off-platform supplier. Never a platform transaction; never reputation for anyone. */
export const ExternalOrderSchema = z.strictObject({
  id: IdSchema,
  ownerCompanyId: IdSchema,
  supplierRecordId: IdSchema,
  externalCounterpartyId: IdSchema,
  payload: z.strictObject({ lines: z.array(ExternalOrderLineSchema).min(1).max(500), deliveryLocationId: IdSchema.nullable(), neededBy: BusinessDateSchema.nullable(), terms: ShortTextSchema.nullable() }),
  digest: DigestSchema,
  sentVia: z.strictObject({ kind: z.enum(['message', 'export']), id: IdSchema }).nullable(),
  acknowledgementEvidenceRefs: EvidenceRefsSchema,
  reservationId: IdSchema.nullable(),
  platformTransaction: z.literal(false),
  reputationEffect: z.literal('none'),
  status: ExternalOrderStatusSchema,
}).refine((o) => o.status === 'draft' || o.status === 'cancelled' || (o.reservationId !== null && o.sentVia !== null), { message: 'a sent external order reserves the budget and records how it was sent', path: ['reservationId'] })
  .refine((o) => !['acknowledged'].includes(o.status) || o.acknowledgementEvidenceRefs.length > 0, { message: 'an acknowledgement is evidenced', path: ['acknowledgementEvidenceRefs'] });
export type ExternalOrder = z.infer<typeof ExternalOrderSchema>;

/** A seller's assertion that goods left; not a receipt. */
export const DispatchNoticeSchema = z.strictObject({
  id: IdSchema,
  orderId: IdSchema,
  seller: PartySchema,
  lines: z.array(z.strictObject({ orderLineRef: KeySchema, quantity: PositiveQuantitySchema })).min(1).max(500),
  carrier: z.string().min(1).max(120).nullable(),
  trackingRef: z.string().min(1).max(120).nullable(),
  expectedArrival: BusinessDateSchema.nullable(),
  documentRefs: EvidenceRefsSchema,
  sentAt: TimestampSchema,
});

/** Derived view (no table): balances of one order line, all in the order line's unit. */
export const OrderLineBalanceSchema = z.strictObject({
  orderLineRef: KeySchema,
  ordered: NonNegativeQuantitySchema,
  dispatched: NonNegativeQuantitySchema,
  received: NonNegativeQuantitySchema,
  accepted: NonNegativeQuantitySchema,
  invoiced: NonNegativeQuantitySchema,
  returned: NonNegativeQuantitySchema,
  open: NonNegativeQuantitySchema,
}).refine((b) => new Set([b.ordered, b.dispatched, b.received, b.accepted, b.invoiced, b.returned, b.open].map((q) => q.unit)).size === 1, { message: 'one unit per balance', path: ['ordered'] })
  .refine((b) => compareDecimal(b.accepted.value, b.received.value) <= 0, { message: 'accepted within received', path: ['accepted'] });

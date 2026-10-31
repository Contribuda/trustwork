import { z } from 'zod';
import { IanaTimeZoneSchema, IdSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { compareDecimal } from '../common/quantity.js';
import { PartySchema } from '../access.js';
import { EvidenceRefsSchema, KeySchema, NonNegativeQuantitySchema, PositiveQuantitySchema, sumDecimals, transitionGuard } from './common.js';

/**
 * Goods receipts, discrepancies, delivery coordination and returns (PRC-008, PRC-016). A receipt is not quality
 * acceptance (that stays `confirm_execution`, human-only). Offline capture keeps device and server time; corrections
 * append. Photo location and site addresses never appear in a public projection.
 */

export const DiscrepancyKindSchema = z.enum(['none', 'short', 'over', 'damaged', 'wrong_item', 'late', 'documents_missing']);
export type DiscrepancyKind = z.infer<typeof DiscrepancyKindSchema>;

export const GoodsReceiptLineSchema = z.strictObject({
  orderLineRef: KeySchema,
  received: NonNegativeQuantitySchema,
  accepted: NonNegativeQuantitySchema,
  rejected: NonNegativeQuantitySchema,
  discrepancy: DiscrepancyKindSchema,
  note: ShortTextSchema.nullable(),
  evidenceRefs: EvidenceRefsSchema,
}).refine((l) => l.received.unit === l.accepted.unit && l.received.unit === l.rejected.unit, { message: 'one unit per line', path: ['accepted'] })
  .refine((l) => l.received.unit !== l.accepted.unit || compareDecimal(sumDecimals([l.accepted.value, l.rejected.value]), l.received.value) === 0, { message: 'accepted plus rejected equals received', path: ['rejected'] })
  .refine((l) => compareDecimal(l.rejected.value, '0') === 0 || l.discrepancy !== 'none', { message: 'a rejected quantity names its discrepancy', path: ['discrepancy'] });
export type GoodsReceiptLine = z.infer<typeof GoodsReceiptLineSchema>;

export const GoodsReceiptStatusSchema = z.enum(['draft', 'recorded', 'corrected']);
export type GoodsReceiptStatus = z.infer<typeof GoodsReceiptStatusSchema>;
/** `draft → recorded`; a correction is a new receipt (`corrects_id`) and the corrected one becomes `corrected`. */
export const GOODS_RECEIPT_TRANSITIONS: Readonly<Record<GoodsReceiptStatus, readonly GoodsReceiptStatus[]>> = { draft: ['recorded'], recorded: ['corrected'], corrected: [] };
export const goodsReceiptTransitionAllowed = transitionGuard(GOODS_RECEIPT_TRANSITIONS);

export const GoodsReceiptSchema = z.strictObject({
  id: IdSchema,
  stockLocationId: IdSchema,
  basis: z.strictObject({ kind: z.enum(['order', 'external_order', 'stock_transfer', 'supplier_return']), id: IdSchema }),
  dispatchNoticeId: IdSchema.nullable(),
  receivedByPersonId: IdSchema,
  /** Client-generated id for offline capture; duplicates collapse on it. */
  clientId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  deviceTime: TimestampSchema,
  serverTime: TimestampSchema,
  /** Timing evidence uses server time unless a person confirms the device time. */
  deviceTimeConfirmedBy: IdSchema.nullable(),
  photoRefs: EvidenceRefsSchema,
  deliveryNoteIntakeId: IdSchema.nullable(),
  acceptanceRecordId: IdSchema.nullable(),
  lines: z.array(GoodsReceiptLineSchema).min(1).max(500),
  status: GoodsReceiptStatusSchema,
  correctsId: IdSchema.nullable(),
}).refine((r) => r.correctsId !== r.id, { message: 'a receipt cannot correct itself', path: ['correctsId'] });
export type GoodsReceipt = z.infer<typeof GoodsReceiptSchema>;

/** The time used as timing evidence. */
export function receiptEvidenceTime(r: Pick<GoodsReceipt, 'deviceTime' | 'serverTime' | 'deviceTimeConfirmedBy'>): string {
  return r.deviceTimeConfirmedBy !== null ? r.deviceTime : r.serverTime;
}

export const SiteLogisticsProfileSchema = z.strictObject({
  id: IdSchema,
  stockLocationId: IdSchema,
  accessHours: z.array(z.strictObject({ weekday: z.int().min(1).max(7), from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })).max(21),
  timeZone: IanaTimeZoneSchema,
  gateInstructions: ShortTextSchema.nullable(),
  vehicleLimits: z.strictObject({ maxLengthM: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).nullable(), maxWeightT: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).nullable() }),
  safetyRequirements: ShortTextSchema.nullable(),
  contactRole: z.string().min(1).max(80),
  /** Revealed only to suppliers with an accepted order to this location. */
  shareAfter: z.literal('order_accepted'),
});

export const SiteResourceSchema = z.strictObject({ id: IdSchema, stockLocationId: IdSchema, kind: z.enum(['crane', 'hoist', 'loading_bay', 'forklift', 'other']), name: z.string().min(1).max(120), status: z.enum(['available', 'out_of_service', 'retired']) });

export const DeliverySlotStatusSchema = z.enum(['proposed', 'confirmed', 'moved', 'cancelled', 'used', 'missed']);
export const DeliverySlotSchema = z.strictObject({
  id: IdSchema,
  stockLocationId: IdSchema,
  orderId: IdSchema.nullable(),
  startsAt: TimestampSchema,
  endsAt: TimestampSchema,
  timeZone: IanaTimeZoneSchema,
  resourceIds: z.array(IdSchema).max(10),
  proposedBy: PartySchema,
  status: DeliverySlotStatusSchema,
}).refine((s) => Date.parse(s.endsAt) > Date.parse(s.startsAt), { message: 'a slot ends after it starts', path: ['endsAt'] });
export type DeliverySlot = z.infer<typeof DeliverySlotSchema>;

/** A booking of one site resource; bookings of the same resource never overlap (an exclusion constraint in storage). */
export const SiteResourceBookingSchema = z.strictObject({ id: IdSchema, siteResourceId: IdSchema, deliverySlotId: IdSchema, startsAt: TimestampSchema, endsAt: TimestampSchema, status: z.enum(['held', 'confirmed', 'released']) })
  .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), { message: 'a booking ends after it starts', path: ['endsAt'] });
export type SiteResourceBooking = z.infer<typeof SiteResourceBookingSchema>;

/** Half-open intervals: back-to-back bookings do not overlap; released bookings never block. */
export function bookingsOverlap(a: SiteResourceBooking, b: SiteResourceBooking): boolean {
  if (a.siteResourceId !== b.siteResourceId || a.status === 'released' || b.status === 'released' || a.id === b.id) return false;
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

export const SupplierReturnStatusSchema = z.enum(['requested', 'authorized', 'shipped', 'received_by_supplier', 'credited', 'rejected']);
export type SupplierReturnStatus = z.infer<typeof SupplierReturnStatusSchema>;
export const SUPPLIER_RETURN_TRANSITIONS: Readonly<Record<SupplierReturnStatus, readonly SupplierReturnStatus[]>> = {
  requested: ['authorized', 'rejected'], authorized: ['shipped'], shipped: ['received_by_supplier'], received_by_supplier: ['credited'], credited: [], rejected: [],
};
export const supplierReturnTransitionAllowed = transitionGuard(SUPPLIER_RETURN_TRANSITIONS);

export const SupplierReturnSchema = z.strictObject({
  id: IdSchema,
  basis: z.strictObject({ kind: z.enum(['order', 'external_order']), id: IdSchema }),
  lines: z.array(z.strictObject({ orderLineRef: KeySchema, quantity: PositiveQuantitySchema, reason: DiscrepancyKindSchema.exclude(['none']) })).min(1).max(500),
  reason: ShortTextSchema,
  status: SupplierReturnStatusSchema,
  creditNoteRef: IdSchema.nullable(),
}).refine((r) => (r.status === 'credited') === (r.creditNoteRef !== null), { message: 'a credited return names its credit note', path: ['creditNoteRef'] });

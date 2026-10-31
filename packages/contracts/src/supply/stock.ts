import { z } from 'zod';
import { PartySchema } from '../access.js';
import { IdSchema, NameSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { NonNegativeMoneySchema } from '../common/money.js';
import { compareDecimal, QuantitySchema, UnitCodeSchema, type Quantity } from '../common/quantity.js';
import { KeySchema, MaterialRefSchema, NonNegativeQuantitySchema, PositiveQuantitySchema, RegionCodeSchema, StepTermsSchema, sumDecimals, transitionGuard } from './common.js';

/**
 * Site stock, movements and transfers (PRC-009). Movements are append-only; balances are computed. `recordedBy` exists
 * for audit only and no function in this file aggregates by person (no surveillance of employees).
 */

export const StockLocationSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  kind: z.enum(['site', 'warehouse', 'yard', 'vehicle']),
  projectId: IdSchema.nullable(),
  name: NameSchema,
  /** Region of the location (never a restricted place); the street address is private and lives in `address`. */
  region: RegionCodeSchema,
  address: z.strictObject({ lines: z.array(z.string().min(1).max(200)).min(1).max(4), postalCode: z.string().max(20).nullable(), locality: z.string().min(1).max(120) }).nullable(),
  status: z.enum(['active', 'closed']),
});
export type StockLocation = z.infer<typeof StockLocationSchema>;

/** Restricted places (RU, UA-43, UA-40, UA-14, UA-09, CU, IR, KP) are never offered; the caller passes the country-pack check. */
export function stockLocationAllowed(location: Pick<StockLocation, 'region'>, isRestricted: (code: string) => boolean): boolean {
  const country = location.region.slice(0, 2);
  return !isRestricted(country) && !isRestricted(location.region);
}

export const StockItemSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  materialRef: MaterialRefSchema.nullable(),
  stepTerms: StepTermsSchema,
  description: ShortTextSchema,
  baseUnit: UnitCodeSchema,
  lotTracking: z.boolean(),
  reorderPoints: z.array(z.strictObject({ stockLocationId: IdSchema, minimum: NonNegativeQuantitySchema, reorderQuantity: PositiveQuantitySchema })).max(100),
}).refine((i) => i.reorderPoints.every((r) => r.minimum.unit === i.baseUnit && r.reorderQuantity.unit === i.baseUnit), { message: 'reorder points use the base unit', path: ['reorderPoints'] });
export type StockItem = z.infer<typeof StockItemSchema>;

export const StockMovementKindSchema = z.enum(['receipt', 'issue_to_work', 'transfer_out', 'transfer_in', 'return_to_supplier', 'adjustment', 'write_off', 'surplus_listed', 'surplus_sold']);
export type StockMovementKind = z.infer<typeof StockMovementKindSchema>;
/** Which side of a movement names a location: `to` adds to that location, `from` removes from it. */
const MOVEMENT_SIDES: Readonly<Record<StockMovementKind, { from: boolean; to: boolean }>> = {
  receipt: { from: false, to: true }, transfer_in: { from: false, to: true },
  issue_to_work: { from: true, to: false }, transfer_out: { from: true, to: false }, return_to_supplier: { from: true, to: false }, write_off: { from: true, to: false }, surplus_sold: { from: true, to: false },
  /** Adjustments carry a signed quantity at one location (`to`). */
  adjustment: { from: false, to: true },
  /** Listing surplus does not move stock; it marks it for the surplus exchange (`from` is the location). */
  surplus_listed: { from: true, to: false },
};

/** Field set without the cross-field rules (used to derive commands). */
export const StockMovementFieldsSchema = z.strictObject({
  id: IdSchema,
  stockItemId: IdSchema,
  fromLocationId: IdSchema.nullable(),
  toLocationId: IdSchema.nullable(),
  quantity: QuantitySchema,
  kind: StockMovementKindSchema,
  source: z.strictObject({ kind: z.enum(['goods_receipt', 'stock_transfer', 'supplier_return', 'requisition', 'manual', 'surplus_offering']), id: IdSchema }),
  costCodeId: IdSchema.nullable(),
  planItemKey: KeySchema.nullable(),
  unitCost: NonNegativeMoneySchema.nullable(),
  lot: z.string().min(1).max(80).nullable(),
  reason: ShortTextSchema.nullable(),
  /** Audit only; never aggregated per person. */
  recordedByPersonId: IdSchema,
  occurredAt: TimestampSchema,
});
type MovementRuleInput = Pick<z.infer<typeof StockMovementFieldsSchema>, 'fromLocationId' | 'toLocationId' | 'quantity' | 'kind' | 'reason' | 'costCodeId' | 'planItemKey'>;
/** Cross-field rules of a movement; empty when valid. */
export function stockMovementViolations(m: MovementRuleInput): string[] {
  const out: string[] = [];
  if ((m.fromLocationId !== null) !== MOVEMENT_SIDES[m.kind].from || (m.toLocationId !== null) !== MOVEMENT_SIDES[m.kind].to) out.push('locations match the movement kind');
  if (m.kind === 'adjustment' ? compareDecimal(m.quantity.value, '0') === 0 : compareDecimal(m.quantity.value, '0') <= 0) out.push('quantities are positive (adjustments signed and non-zero)');
  if ((m.kind === 'adjustment' || m.kind === 'write_off') && m.reason === null) out.push('adjustments and write-offs give a reason');
  if (m.kind === 'issue_to_work' && m.costCodeId === null && m.planItemKey === null) out.push('an issue to work names a cost code or plan item');
  return out;
}
export const StockMovementSchema = StockMovementFieldsSchema.superRefine((m, ctx) => {
  for (const message of stockMovementViolations(m)) ctx.addIssue({ code: 'custom', message, path: [] });
});
export type StockMovement = z.infer<typeof StockMovementSchema>;

/** Exact balance of one item at one location from its append-only movements. Units other than the base unit fail closed. */
export function stockBalance(movements: readonly StockMovement[], stockItemId: string, locationId: string, baseUnit: string): Quantity {
  const signed: string[] = [];
  for (const m of movements) {
    if (m.stockItemId !== stockItemId || m.kind === 'surplus_listed') continue;
    const into = m.toLocationId === locationId;
    const out = m.fromLocationId === locationId;
    if (!into && !out) continue;
    if (m.quantity.unit !== baseUnit) throw new Error(`stock movement ${m.id} is not in the base unit ${baseUnit}`);
    signed.push(into ? m.quantity.value : m.quantity.value.startsWith('-') ? m.quantity.value.slice(1) : `-${m.quantity.value}`);
  }
  const total = sumDecimals(signed);
  return { value: /^-?0(\.0+)?$/.test(total) ? '0' : total, unit: baseUnit };
}

export const StockTransferStatusSchema = z.enum(['requested', 'approved', 'dispatched', 'received', 'cancelled']);
export type StockTransferStatus = z.infer<typeof StockTransferStatusSchema>;
export const STOCK_TRANSFER_TRANSITIONS: Readonly<Record<StockTransferStatus, readonly StockTransferStatus[]>> = {
  requested: ['approved', 'dispatched', 'cancelled'], approved: ['dispatched', 'cancelled'], dispatched: ['received'], received: [], cancelled: [],
};
export const stockTransferTransitionAllowed = transitionGuard(STOCK_TRANSFER_TRANSITIONS);

export const StockTransferSchema = z.strictObject({
  id: IdSchema,
  fromLocationId: IdSchema,
  toLocationId: IdSchema,
  lines: z.array(z.strictObject({ stockItemId: IdSchema, quantity: PositiveQuantitySchema, requisitionLineKey: KeySchema.nullable() })).min(1).max(500),
  approvalRequestId: IdSchema.nullable(),
  status: StockTransferStatusSchema,
}).refine((t) => t.fromLocationId !== t.toLocationId, { message: 'a transfer moves between two locations', path: ['toLocationId'] });

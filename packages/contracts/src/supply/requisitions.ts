import { z } from 'zod';
import { PartySchema } from '../access.js';
import { DigestSchema } from '../common/digest-schema.js';
import { BusinessDateSchema, IdSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from '../common/ids.js';
import { NonNegativeMoneySchema } from '../common/money.js';
import { compareDecimal, DecimalSchema, UnitCodeSchema, type Quantity } from '../common/quantity.js';
import { VersionNumberSchema } from '../common/version.js';
import { KeySchema, LocatorSchema, MaterialRefSchema, PositiveQuantitySchema, PrioritySchema, RecorderSchema, StepTermSchema, StepTermsSchema, sumQuantities, transitionGuard } from './common.js';

/**
 * Requisitions: versioned internal requests inside one company (or one person's project), and the rule that decides
 * how a plan item turns into buying (ADR 012 decision 37).
 */

export const REQUISITION_STATUSES = ['draft', 'submitted', 'in_approval', 'approved', 'rejected', 'returned', 'sourcing', 'partially_fulfilled', 'fulfilled', 'cancelled'] as const;
export const RequisitionStatusSchema = z.enum(REQUISITION_STATUSES);
export type RequisitionStatus = z.infer<typeof RequisitionStatusSchema>;
/**
 * docs/data/lifecycles.md: `draft → submitted → in_approval → approved | rejected | returned`, `returned → draft`,
 * `approved → sourcing → partially_fulfilled → fulfilled`, `sourcing → fulfilled`, `cancelled` from approved or sourcing.
 * `in_approval → submitted` is the handbook rule "editing after submission creates a new version and supersedes pending
 * approvals": the new frozen version is submitted again. Rejected, fulfilled and cancelled are terminal.
 */
export const REQUISITION_TRANSITIONS: Readonly<Record<RequisitionStatus, readonly RequisitionStatus[]>> = {
  draft: ['submitted'],
  submitted: ['in_approval'],
  in_approval: ['approved', 'rejected', 'returned', 'submitted'],
  returned: ['draft'],
  approved: ['sourcing', 'cancelled'],
  sourcing: ['partially_fulfilled', 'fulfilled', 'cancelled'],
  partially_fulfilled: ['fulfilled'],
  rejected: [], fulfilled: [], cancelled: [],
};
export const requisitionTransitionAllowed = transitionGuard(REQUISITION_TRANSITIONS);

export const RequisitionSourceSchema = z.enum(['manual', 'import', 'plan', 'photo', 'reorder', 'assistant']);

export const RequisitionLineSchema = z.strictObject({
  /** Stable across versions so that allocations and approvals follow a line. */
  lineKey: KeySchema,
  description: ShortTextSchema,
  stepTerms: StepTermsSchema,
  materialRef: MaterialRefSchema.nullable(),
  quantity: PositiveQuantitySchema,
  alternativesAllowed: z.boolean(),
  /** Optional estimate, always labelled "estimate" in the interface. */
  estimate: NonNegativeMoneySchema.nullable(),
  neededBy: BusinessDateSchema.nullable(),
  costCodeId: IdSchema.nullable(),
  planItemKey: KeySchema.nullable(),
  extractionLocator: LocatorSchema.nullable(),
});
export type RequisitionLine = z.infer<typeof RequisitionLineSchema>;

export const RequisitionVersionPayloadSchema = z.strictObject({
  lines: z.array(RequisitionLineSchema).min(1).max(500),
  deliveryLocationId: IdSchema.nullable(),
  notes: TextSchema.nullable(),
}).refine((p) => new Set(p.lines.map((l) => l.lineKey)).size === p.lines.length, { message: 'line keys are unique', path: ['lines'] })
  .refine((p) => { const cur = new Set(p.lines.flatMap((l) => (l.estimate ? [l.estimate.currency] : []))); return cur.size <= 1; }, { message: 'estimates share one currency', path: ['lines'] });

/** Frozen once submitted; approvals bind its digest. */
export const RequisitionVersionSchema = z.strictObject({
  id: IdSchema,
  requisitionId: IdSchema,
  version: VersionNumberSchema,
  payload: RequisitionVersionPayloadSchema,
  digest: DigestSchema,
  submittedBy: IdSchema,
  submittedAt: TimestampSchema,
});
export type RequisitionVersion = z.infer<typeof RequisitionVersionSchema>;

export const RequisitionSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  projectId: IdSchema.nullable(),
  stockLocationId: IdSchema.nullable(),
  requestedByPersonId: IdSchema,
  costCodeId: IdSchema.nullable(),
  priority: PrioritySchema,
  neededBy: BusinessDateSchema.nullable(),
  source: RequisitionSourceSchema,
  status: RequisitionStatusSchema,
  currentVersionId: IdSchema.nullable(),
  /** A flag beside the status (like `rfq_amended`), never a status. */
  staleReason: z.literal('plan_changed').nullable(),
  revision: RevisionSchema,
}).refine((r) => r.status === 'draft' || r.currentVersionId !== null, { message: 'a submitted requisition has a frozen version', path: ['currentVersionId'] });
export type Requisition = z.infer<typeof RequisitionSchema>;

export const AllocationTargetKindSchema = z.enum(['need_line', 'rfq_line', 'order_line', 'call_off_line', 'external_order_line', 'stock_transfer_line', 'task_request']);
export const AllocationStatusSchema = z.enum(['planned', 'sourcing', 'ordered', 'received', 'cancelled']);

export const RequisitionAllocationSchema = z.strictObject({
  id: IdSchema,
  requisitionId: IdSchema,
  lineKey: KeySchema,
  allocated: PositiveQuantitySchema,
  target: z.strictObject({ kind: AllocationTargetKindSchema, id: IdSchema }),
  status: AllocationStatusSchema,
  allocatedBy: RecorderSchema,
  allocatedAt: TimestampSchema,
});
export type RequisitionAllocation = z.infer<typeof RequisitionAllocationSchema>;

/**
 * The serialized check of PRC-002: active (not cancelled) allocations of a line never exceed the requested quantity.
 * Units must match exactly; a different unit fails closed.
 */
export function allocationsWithinRequested(requested: Quantity, allocations: readonly Pick<RequisitionAllocation, 'allocated' | 'status'>[]): boolean {
  const active = allocations.filter((a) => a.status !== 'cancelled').map((a) => a.allocated);
  if (active.some((q) => q.unit !== requested.unit)) return false;
  return compareDecimal(sumQuantities(active, requested.unit).value, requested.value) <= 0;
}

/** One row of the published CSV or XLSX template, after header mapping. Imports create drafts only. */
export const RequisitionImportRowSchema = z.strictObject({
  rowNumber: z.int().min(2).max(100_000),
  description: ShortTextSchema,
  stepTerm: StepTermSchema.nullable(),
  catalogueRef: IdSchema.nullable(),
  quantity: DecimalSchema,
  unit: UnitCodeSchema,
  neededBy: z.iso.date().nullable(),
  locationCode: z.string().min(1).max(80).nullable(),
  costCode: z.string().min(1).max(80).nullable(),
  notes: z.string().max(2000).nullable(),
});
export const RequisitionImportRowErrorSchema = z.strictObject({ rowNumber: z.int().min(1), column: z.string().min(1).max(80), code: z.string().regex(/^[a-z][a-z_.]{2,80}$/) });

/* ---------- From plan item to buying (ADR 012 decision 37) ---------- */

export const BuyerProfileSchema = z.enum(['consumer', 'small_owner', 'company_without_routes', 'company_with_routes']);
export type BuyerProfile = z.infer<typeof BuyerProfileSchema>;
export const PlanItemPurchaseKindSchema = z.enum(['works', 'goods', 'services']);
export type PlanItemPurchaseKind = z.infer<typeof PlanItemPurchaseKindSchema>;
export const BuyingPathSchema = z.enum(['task', 'rfq', 'requisition']);
export type BuyingPath = z.infer<typeof BuyingPathSchema>;

/**
 * ADR 012 decision 37: for a consumer or a small owner, works become tasks and goods become RFQs; inside a company with
 * approval routes every purchase starts as a requisition (which may later produce an RFQ or a task). Services follow
 * works (tasks are scoped requests for execution). A company without routes buys like a small owner; its default route
 * "the owner approves" is still available through requisitions when the company switches them on.
 */
export function buyingPathFor(buyer: BuyerProfile, kind: PlanItemPurchaseKind): BuyingPath {
  if (buyer === 'company_with_routes') return 'requisition';
  return kind === 'goods' ? 'rfq' : 'task';
}

/** The path a plan item took. A plan item has at most one active path; switching paths needs the old one closed first. */
export const PlanItemBuyingPathSchema = z.strictObject({
  projectId: IdSchema,
  planItemKey: KeySchema,
  planVersionId: IdSchema,
  path: BuyingPathSchema,
  targetId: IdSchema,
  status: z.enum(['active', 'closed']),
  recordedAt: TimestampSchema,
});
export type PlanItemBuyingPath = z.infer<typeof PlanItemBuyingPathSchema>;
export const PlanItemBuyingPathsSchema = z.array(PlanItemBuyingPathSchema).refine((xs) => {
  const active = xs.filter((x) => x.status === 'active').map((x) => `${x.projectId}/${x.planItemKey}`);
  return new Set(active).size === active.length;
}, 'a plan item takes one path at a time');

import { z } from 'zod';
import { DecimalSchema } from './common/quantity.js';
import { MeterSchema } from './agent-catalog.js';
import { unitMargin } from './hub.js';

/**
 * Agent usage prices (AGT-004, ADR 010 decision 25). A sale price is a `PriceVersion` (billing.ts) of its own offer, so
 * activation, no back-dating, no overlap and acceptance are the BILL-001 rules; these schemas add the subject, the exact
 * unit price and the cost beside it. Cost is information and never a price: a markup is computed once, when the version
 * is drafted, and stored as a fixed number with the cost record it used.
 */
const Id = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime();
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Reason = z.string().min(1).max(500);
const NonNegativeDecimal = DecimalSchema.refine((v) => !v.startsWith('-'), { message: 'a unit price is not negative' });
const ModuleKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const CapabilityId = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100);

export const METERED_UNITS = ['thousand_tokens', 'action', 'deliverable', 'api_call'] as const;
export const MeteredUnitSchema = z.enum(METERED_UNITS);
export type MeteredUnit = z.infer<typeof MeteredUnitSchema>;
export const CostBasisSchema = z.enum(['model_list_price', 'measured_average', 'contract']);

/** What a price applies to. A catalogue model is priced per direction; `meter` is the hub-wide rate of one meter. */
export const MeteredSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('module'), key: ModuleKey, meter: MeterSchema }),
  z.strictObject({ kind: z.literal('capability'), key: CapabilityId, meter: MeterSchema }),
  z.strictObject({ kind: z.literal('model'), key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/), direction: z.enum(['input', 'output']), meter: z.literal('model_tokens') }),
  z.strictObject({ kind: z.literal('meter'), key: MeterSchema, meter: MeterSchema }),
]).refine((s) => s.kind !== 'meter' || s.key === s.meter, { message: 'a meter rate names its own meter', path: ['key'] });
export type MeteredSubject = z.infer<typeof MeteredSubjectSchema>;

/** Flat: the operator types the sale price. Markup: a percentage; the engine computes the price, never the caller. */
export const MeteredPriceBasisSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('flat'), salePerUnitMinor: NonNegativeDecimal }),
  z.strictObject({ kind: z.literal('markup'), percent: z.int().min(0).max(1000) }),
]);
/** Strict terms: no field can name a participant, a rank, a match or a reputation input. */
export const MeteredPriceDraftTermsSchema = z.strictObject({
  subject: MeteredSubjectSchema,
  currency: Currency,
  basis: MeteredPriceBasisSchema,
  effectiveFrom: Timestamp,
  effectiveTo: Timestamp.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
}).refine((t) => t.effectiveTo === null || Date.parse(t.effectiveTo) > Date.parse(t.effectiveFrom), { message: 'the interval must be positive', path: ['effectiveTo'] });
export type MeteredPriceDraftTerms = z.infer<typeof MeteredPriceDraftTermsSchema>;
export const DraftMeteredPriceSchema = z.strictObject({ reason: Reason, terms: MeteredPriceDraftTermsSchema });
export const ActivateMeteredPriceSchema = z.strictObject({ reason: Reason, digest: Digest, approvalId: Id });
export const CancelMeteredPriceSchema = z.strictObject({ reason: Reason });

const CostSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('module'), key: ModuleKey, meter: MeterSchema }),
  z.strictObject({ kind: z.literal('capability'), key: CapabilityId, meter: MeterSchema }),
  z.strictObject({ kind: z.literal('meter'), key: MeterSchema, meter: MeterSchema }),
]);
/** Catalogue model costs are KEYS-001 `model_pricing` records; this is the cost of every other priced unit. */
export const MeteredCostInputSchema = z.strictObject({ subject: CostSubjectSchema, currency: Currency, costPerUnitMinor: NonNegativeDecimal, basis: CostBasisSchema, observedAt: Timestamp });
export type MeteredCostInput = z.infer<typeof MeteredCostInputSchema>;
export const RecordMeteredCostSchema = z.strictObject({ reason: Reason, cost: MeteredCostInputSchema });
export const MeteredCostRecordSchema = z.strictObject({ id: Id, version: z.int().positive(), costPerUnitMinor: NonNegativeDecimal, currency: Currency, basis: CostBasisSchema, observedAt: Timestamp });
export type MeteredCostRecord = z.infer<typeof MeteredCostRecordSchema>;

/** Stored terms; the digest of the second-person approval binds exactly these. */
export const MeteredPriceTermsSchema = z.strictObject({
  subject: MeteredSubjectSchema,
  unit: MeteredUnitSchema,
  currency: Currency,
  salePerUnitMinor: NonNegativeDecimal,
  /** The same price as a whole number of minor units for `perUnits` units. */
  amountMinor: z.string().regex(/^(0|[1-9]\d*)$/),
  perUnits: z.int().positive(),
  basis: z.enum(['flat', 'markup']),
  markupPercent: z.int().min(0).max(1000).nullable(),
  costPerUnitMinor: NonNegativeDecimal,
  costBasis: CostBasisSchema,
  modelPricingId: Id.nullable(),
  costRecordId: Id.nullable(),
  effectiveFrom: Timestamp,
  effectiveTo: Timestamp.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
});
/** Staff projection only: it carries cost. Acceptances are a bare count of payers of this version, never who they are. */
const StoredMeteredPriceSchema = z.strictObject({
  id: Id,
  hubId: Id,
  offerId: Id,
  version: z.int().positive(),
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
  digest: Digest,
  terms: MeteredPriceTermsSchema,
  draftedBy: Id,
  activatedBy: Id.nullable(),
  acceptances: z.int().min(0),
  /** Present when a newer cost record exists. It offers a new draft; it never changes this version. */
  currentCost: z.strictObject({
    costPerUnitMinor: NonNegativeDecimal,
    costBasis: CostBasisSchema,
    modelPricingId: Id.nullable(),
    costRecordId: Id.nullable(),
    observedAt: Timestamp,
    suggestedSalePerUnitMinor: NonNegativeDecimal.nullable(),
  }).nullable(),
});
export const MeteredPriceVersionSchema = StoredMeteredPriceSchema.extend({
  /** Sale minus the cost stored on this version; negative means the hub subsidises the unit. */
  marginPerUnitMinor: DecimalSchema,
  /** Sale minus the newest cost record, or null when the stored cost is still the newest. */
  currentMarginPerUnitMinor: DecimalSchema.nullable(),
});
export type MeteredPriceVersion = z.infer<typeof MeteredPriceVersionSchema>;
/** Adds the recomputed margins to a stored row. Exact decimals; no number type touches a price. */
export function meteredPriceView(stored: unknown): MeteredPriceVersion {
  const row = StoredMeteredPriceSchema.parse(stored);
  const margin = (cost: string) => unitMargin({ costPricePerUnitMinor: cost, salePricePerUnitMinor: row.terms.salePerUnitMinor });
  return MeteredPriceVersionSchema.parse({ ...row, marginPerUnitMinor: margin(row.terms.costPerUnitMinor), currentMarginPerUnitMinor: row.currentCost ? margin(row.currentCost.costPerUnitMinor) : null });
}

/** The allowlisted row of the public reader; no cost, basis, staff or payer field exists on it. */
export const PublicMeteredPriceRowSchema = z.strictObject({
  id: Id,
  version: z.int().positive(),
  offerId: Id,
  code: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['module', 'capability', 'model', 'meter']),
  key: z.string().min(1),
  direction: z.enum(['input', 'output']).nullable(),
  meter: MeterSchema,
  unit: MeteredUnitSchema,
  currency: Currency,
  amountMinor: z.string().regex(/^(0|[1-9]\d*)$/),
  perUnits: z.int().positive(),
  salePerUnitMinor: NonNegativeDecimal,
  effectiveFrom: Timestamp,
  effectiveTo: Timestamp.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
});
export type PublicMeteredPriceRow = z.infer<typeof PublicMeteredPriceRowSchema>;

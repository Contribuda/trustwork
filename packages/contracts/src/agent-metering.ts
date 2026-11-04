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

/* ---------- Metered steps, quota windows and usage ---------- */

const MinorText = z.string().regex(/^(0|[1-9]\d*)$/);
const Units = z.int().min(0);
export const QUOTA_STOP_REASONS = ['no_price', 'price_not_accepted', 'no_budget', 'budget_insufficient'] as const;
/** Why a job stopped at its quota. Each one is a question for the principal, never a debt. */
export const QuotaStopReasonSchema = z.enum(QUOTA_STOP_REASONS);
export type QuotaStopReason = z.infer<typeof QuotaStopReasonSchema>;

/** One step an owning module meters itself. Hub, person and run come from trusted state, never from a request body. */
export const MeteredStepInputSchema = z.strictObject({
  hubId: Id,
  principal: z.strictObject({ kind: z.enum(['person', 'company']), id: Id }),
  moduleKey: ModuleKey,
  capabilityId: CapabilityId.nullable(),
  runId: Id,
  runStepId: Id,
  attemptId: Id,
  connectionId: Id.nullable(),
  meter: MeterSchema,
  providerClass: z.enum(['local', 'in_country', 'hosted_external']).nullable(),
  estimatedUnits: Units,
  budgetId: Id.nullable(),
  projectId: Id.nullable(),
});
export type MeteredStepInput = z.infer<typeof MeteredStepInputSchema>;
export const MeteredStepDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('stopped'), reason: QuotaStopReasonSchema, replayed: z.boolean(), beyondUnits: Units, estimateMinor: MinorText, currency: Currency }),
  z.strictObject({
    decision: z.enum(['admitted', 'already_charged', 'closed', 'open']), replayed: z.boolean(), stepId: Id, state: z.enum(['admitted', 'outcome_unknown', 'succeeded', 'failed']),
    withinUnits: Units, beyondUnits: Units, estimateMinor: MinorText, chargedMinor: MinorText, currency: Currency, reservationId: Id.nullable(), priced: z.boolean(), usageRecordId: Id.nullable(),
  }),
]);
export type MeteredStepDecision = z.infer<typeof MeteredStepDecisionSchema>;
/** What a person sees before an expensive run: money and simple counts, from the version they accepted. */
export const MeteredEstimateSchema = z.strictObject({
  withinUnits: Units, beyondUnits: Units, estimateMinor: MinorText, currency: Currency, stop: QuotaStopReasonSchema.nullable(), priced: z.boolean(), quotaDefined: z.boolean(),
});
export type MeteredEstimate = z.infer<typeof MeteredEstimateSchema>;
export const MeteredEstimateQuerySchema = z.strictObject({
  moduleKey: ModuleKey, capabilityId: CapabilityId.optional(), meter: MeterSchema, units: z.coerce.number().int().min(0).max(1_000_000_000), budgetId: Id.optional(), forCompany: z.enum(['true', 'false']).optional(),
});
/** The principal's own view. Nothing here is shown to anyone else; a plan is never in another party's projection. */
export const AgentUsageViewSchema = z.strictObject({
  planKey: z.string(),
  windows: z.array(z.strictObject({ moduleKey: ModuleKey, meter: MeterSchema, window: z.enum(['day', 'week', 'month']), windowStart: Timestamp, windowEnd: Timestamp, limitUnits: MinorText, usedUnits: MinorText, heldUnits: MinorText })),
  /** Decisions waiting: reached 80 or 100 percent of a window. */
  notices: z.array(z.strictObject({ moduleKey: ModuleKey, meter: MeterSchema, window: z.enum(['day', 'week', 'month']), threshold: z.union([z.literal(80), z.literal(100)]), at: Timestamp })),
  steps: z.array(z.strictObject({ id: Id, runId: Id, moduleKey: ModuleKey, capabilityId: CapabilityId.nullable(), meter: MeterSchema, state: z.enum(['admitted', 'outcome_unknown', 'succeeded', 'failed']), units: MinorText.nullable(), chargedMinor: MinorText, currency: Currency, at: Timestamp })),
});
export type AgentUsageView = z.infer<typeof AgentUsageViewSchema>;
/** A person accepts one exact version. An agent, a connection or chat text never does: this is a first-party session route. */
export const AcceptMeteredPriceSchema = z.strictObject({ acceptanceTextVersion: z.string().min(1).max(40), amountMinor: MinorText, currency: Currency, forCompany: z.boolean() });
export const ReconcileMeteredStepSchema = z.strictObject({ reason: Reason, result: z.enum(['succeeded', 'failed']), units: Units.nullable(), evidence: z.string().min(1).max(200) })
  .refine((r) => r.result === 'failed' || r.units !== null, { message: 'a success names its units', path: ['units'] });

/* ---------- Agent plan versions and credit packs ---------- */

const PlanKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).refine((k) => k !== 'free', { message: 'free is the absence of a plan' });
const PriceTerms = z.strictObject({ amountMinor: MinorText, currency: Currency, effectiveFrom: Timestamp, effectiveTo: Timestamp.nullable(), acceptanceTextVersion: z.string().min(1).max(40) })
  .refine((t) => t.effectiveTo === null || Date.parse(t.effectiveTo) > Date.parse(t.effectiveFrom), { message: 'the interval must be positive', path: ['effectiveTo'] });
/** Capacity only. The strict schema has no field for a protection limit, a rank, a match or a reputation input. */
export const AgentPlanTermsSchema = z.strictObject({
  planKey: PlanKey,
  name: z.string().min(1).max(200),
  plan: z.strictObject({
    payerKind: z.enum(['person', 'company']),
    moduleKeys: z.array(ModuleKey).min(1),
    includedQuota: z.array(z.strictObject({ moduleKey: ModuleKey, meter: MeterSchema, units: MinorText, window: z.enum(['day', 'week', 'month']) })),
    connections: z.int().min(1).max(20),
    channels: z.int().min(0).max(50),
    representativeIncluded: z.boolean(),
  }),
  price: PriceTerms,
});
export type AgentPlanTerms = z.infer<typeof AgentPlanTermsSchema>;
export const DraftAgentPlanSchema = z.strictObject({ reason: Reason, terms: AgentPlanTermsSchema });
export const AgentPlanVersionViewSchema = z.strictObject({
  id: Id, offerId: Id, planKey: z.string(), version: z.int().positive(), status: z.enum(['draft', 'active', 'superseded', 'cancelled']), digest: Digest, plan: z.record(z.string(), z.unknown()),
  priceVersionId: Id, amountMinor: MinorText, currency: Currency, effectiveFrom: Timestamp, effectiveTo: Timestamp.nullable(), acceptanceTextVersion: z.string(), draftedBy: Id, activatedBy: Id.nullable(),
});
export type AgentPlanVersionView = z.infer<typeof AgentPlanVersionViewSchema>;
/** ADR 012 decision 33: validity and refund policy are shown before purchase; expiring credits carry a reminder. */
export const CreditPackTermsSchema = z.strictObject({
  packKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1).max(200),
  amountMinor: MinorText,
  currency: Currency,
  creditsMinor: MinorText.refine((v) => v !== '0', { message: 'a pack carries credits' }),
  validityDays: z.int().min(30).max(3650).nullable(),
  reminderDays: z.int().min(7).max(90).nullable(),
  refundPolicyVersion: z.int().min(1),
  effectiveFrom: Timestamp,
  effectiveTo: Timestamp.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
}).refine((p) => p.validityDays === null || p.reminderDays !== null, { message: 'expiring credits carry a reminder', path: ['reminderDays'] });
export type CreditPackTerms = z.infer<typeof CreditPackTermsSchema>;
export const DraftCreditPackSchema = z.strictObject({ reason: Reason, terms: CreditPackTermsSchema });
const PackRow = {
  id: Id, offerId: Id, version: z.int().positive(), amountMinor: MinorText, currency: Currency, creditsMinor: MinorText, validityDays: z.int().nullable(), reminderDays: z.int().nullable(),
  refundPolicyVersion: z.int().positive(), effectiveFrom: Timestamp, effectiveTo: Timestamp.nullable(), acceptanceTextVersion: z.string(),
};
export const CreditPackVersionViewSchema = z.strictObject({ ...PackRow, packKey: z.string(), status: z.enum(['draft', 'active', 'superseded', 'cancelled']), digest: Digest, draftedBy: Id, activatedBy: Id.nullable() });
export type CreditPackVersionView = z.infer<typeof CreditPackVersionViewSchema>;
export const PublicCreditPackRowSchema = z.strictObject({ ...PackRow, code: z.string(), name: z.string() });
export type PublicCreditPackRow = z.infer<typeof PublicCreditPackRowSchema>;
export const ActivateVersionSchema = ActivateMeteredPriceSchema;

import { z } from 'zod';
import { MarketplaceFeeKindSchema } from './hub.js';
import { MeterSchema } from './agent-catalog.js';

const Id = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime();
const Minor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine((v) => BigInt(v) <= 9223372036854775807n);
/** Strict fee terms cannot carry participant-specific rates or discovery controls. */
export const FeeTermsSchema = z.strictObject({
  kind: MarketplaceFeeKindSchema,
  categoryKey: z.string().min(2).max(61).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  basisPoints: z.int().min(0).max(10000).nullable(),
  fixedMinor: Minor.nullable(),
  payer: z.enum(['buyer', 'seller']),
  effectiveFrom: Timestamp,
  effectiveTo: Timestamp.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
}).refine((v) => v.basisPoints !== null || v.fixedMinor !== null, 'a published amount is required')
  .refine((v) => v.categoryKey === null || ['consultation', 'task'].includes(v.kind), 'categories apply to consultations and tasks')
  .refine((v) => v.effectiveTo === null || Date.parse(v.effectiveTo) > Date.parse(v.effectiveFrom), 'the interval must be positive');
export type FeeTerms = z.infer<typeof FeeTermsSchema>;
export const DraftFeeSchema = z.strictObject({ reason: z.string().min(1).max(500), terms: FeeTermsSchema });
export const ActivateFeeSchema = z.strictObject({ reason: z.string().min(1).max(500), digest: Digest, approvalId: Id });
export const PublicFeeSchema = z.strictObject({ id: Id, hubId: Id, version: z.int().positive(), digest: Digest, terms: FeeTermsSchema });
export type PublicFee = z.infer<typeof PublicFeeSchema>;
/** Explicit read projection: no provider costs, staff identities, approvals, budgets or payer data. */
export const PublicPriceSchema = z.strictObject({
  id: Id, version: z.int().positive(), kind: z.enum(['plan', 'model', 'capability', 'credit_pack', 'deliverable', 'verification_fee', 'agent_module']),
  code: z.string().min(1), currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: Minor,
  effectiveFrom: Timestamp, effectiveTo: Timestamp.nullable(),
  validity: z.string().nullable(),
  planVersion: z.strictObject({ id: Id, version: z.int().positive() }).nullable(),
  disclosure: z.strictObject({
    offerId: Id, name: z.string().min(1), acceptanceTextVersion: z.string().min(1),
    plan: z.strictObject({
      payerKind: z.enum(['person', 'company']), moduleKeys: z.array(z.string()),
      includedQuota: z.array(z.strictObject({ moduleKey: z.string(), meter: z.string(), units: Minor, window: z.string() })),
      connections: z.int().nonnegative(), channels: z.int().nonnegative(), representativeIncluded: z.boolean(),
    }).nullable(),
    digest: Digest.optional(),
    sale: z.strictObject({ modelId: z.string().min(1).nullable(), capabilityId: z.string().min(1).nullable(), meter: MeterSchema, perUnits: Minor }).nullable().optional(),
    creditPack: z.strictObject({ creditMinor: Minor, validityDays: z.int().positive().nullable(), expiryNoticeDays: z.int().positive().nullable(), refundPolicyVersion: z.string().min(1) }).nullable().optional(),
    /** `effectiveTo` above is the effective end; `digest` covers the signed end, kept here so it stays verifiable. */
    supersededBy: z.strictObject({ versionId: Id, at: Timestamp, signedEffectiveTo: Timestamp.nullable() }).nullable().optional(),
    /** Agent usage price (AGT-004): `amountMinor` is the price of `perUnits` units; no cost field exists here. */
    metered: z.strictObject({
      key: z.string().min(1), direction: z.enum(['input', 'output']).nullable(), meter: z.string().min(1),
      unit: z.enum(['thousand_tokens', 'action', 'deliverable', 'api_call']), perUnits: z.int().positive(),
      salePerUnitMinor: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/),
    }).optional(),
  }).optional(),
});
export type PublicPrice = z.infer<typeof PublicPriceSchema>;
const PositiveMinor = Minor.refine((v) => BigInt(v) > 0n, 'must be positive');
const SaleBase = {
  code: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/), name: z.string().trim().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: Minor,
  effectiveFrom: Timestamp, effectiveTo: Timestamp.nullable(), acceptanceTextVersion: z.string().min(1).max(40),
};
const CapabilityId = z.string().max(100).regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
/**
 * Participant sale prices (ADR 010 decision 25) and credit packs (ADR 012 decision 33). A sale price is never a provider
 * cost, and these strict objects are the payment-neutrality boundary: no key can reach ranking, matching, recommendations
 * or reputation, and none names a participant. `validityDays: null` means the credits do not expire; any expiry needs
 * advance notice shorter than the validity, so credits never expire silently.
 */
export const SalePriceTermsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model'), ...SaleBase, modelId: z.string().min(1).max(200), meter: MeterSchema, perUnits: PositiveMinor }),
  z.strictObject({ kind: z.literal('capability'), ...SaleBase, capabilityId: CapabilityId, meter: MeterSchema, perUnits: PositiveMinor }),
  z.strictObject({ kind: z.literal('credit_pack'), ...SaleBase, creditMinor: PositiveMinor, validityDays: z.int().min(1).max(3650).nullable(), expiryNoticeDays: z.int().min(1).max(365).nullable(), refundPolicyVersion: z.string().min(1).max(40) }),
]).refine((v) => v.effectiveTo === null || Date.parse(v.effectiveTo) > Date.parse(v.effectiveFrom), 'the interval must be positive')
  .refine((v) => v.kind !== 'credit_pack' || ((v.validityDays === null) === (v.expiryNoticeDays === null) && (v.validityDays === null || v.expiryNoticeDays! < v.validityDays)), 'an expiry needs advance notice shorter than the validity');
export type SalePriceTerms = z.infer<typeof SalePriceTermsSchema>;
export const DraftSalePriceSchema = z.strictObject({ reason: z.string().min(1).max(500), terms: SalePriceTermsSchema });
/**
 * `digest` is the version digest. The second person approves the activation digest, which also binds `supersedes`: the
 * exact version this one replaces, or null. The replaced version keeps its signed end date; its effective end is derived.
 */
export const ActivateSalePriceSchema = z.strictObject({ reason: z.string().min(1).max(500), digest: Digest, approvalId: Id, supersedes: Id.nullable().default(null) });
/** `activationDigest` is what a second person approves to activate this version without superseding another. */
export const SalePriceVersionSchema = z.strictObject({ id: Id, hubId: Id, version: z.int().positive(), digest: Digest, activationDigest: Digest, terms: SalePriceTermsSchema });
export type SalePriceVersion = z.infer<typeof SalePriceVersionSchema>;
const StaffLifecycle = { status: z.enum(['draft', 'active', 'superseded', 'cancelled']), draftedBy: Id, activatedBy: Id.nullable(), activatedAt: Timestamp.nullable() };
/** Staff projections for the console. They name staff, so they are served only under the matching `admin.*` permissions. */
export const StaffSalePriceSchema = z.strictObject({
  id: Id, hubId: Id, version: z.int().positive(), digest: Digest, activationDigest: Digest, terms: SalePriceTermsSchema, ...StaffLifecycle,
  supersededBy: Id.nullable(), supersededAt: Timestamp.nullable(), effectiveEnd: Timestamp.nullable(),
  /** For a draft: the versions it may supersede, each with the exact digest a second person would approve. */
  supersedable: z.array(z.strictObject({ versionId: Id, activationDigest: Digest })),
});
export type StaffSalePrice = z.infer<typeof StaffSalePriceSchema>;
export const StaffFeeSchema = z.strictObject({ id: Id, hubId: Id, version: z.int().positive(), digest: Digest, terms: FeeTermsSchema, ...StaffLifecycle });
export type StaffFee = z.infer<typeof StaffFeeSchema>;
const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
/**
 * Referral programme terms (ADR 018, ADR 025 decision 21). The strict object is the payment-neutrality boundary: it has no
 * key that could reach ranking, matching, recommendations or reputation, and no participant-specific reward. A reward is a
 * platform credit, never cash. `publicTerms` holds the operator's own text per hub language; activation needs all of them.
 */
export const ReferralTermsSchema = z.strictObject({
  programmeKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  eligibleParties: z.enum(['person', 'company', 'person_or_company']),
  rewardKind: z.literal('platform_credit'),
  currency: z.string().regex(/^[A-Z]{3}$/),
  referrerRewardMinor: Minor, refereeRewardMinor: Minor,
  maxRewardsPerReferrer: z.int().min(1).max(1000).nullable(),
  effectiveFrom: Timestamp, effectiveTo: Timestamp.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
  publicTerms: z.record(Locale, z.string().trim().min(1).max(4000)).refine((v) => Object.keys(v).length > 0, 'public terms are required'),
}).refine((v) => v.effectiveTo === null || Date.parse(v.effectiveTo) > Date.parse(v.effectiveFrom), 'the interval must be positive');
export type ReferralTerms = z.infer<typeof ReferralTermsSchema>;
/** `legalReviewRef` names the counsel review of these terms; it is approved with them and is never public. */
export const DraftReferralSchema = z.strictObject({ reason: z.string().min(1).max(500), terms: ReferralTermsSchema, legalReviewRef: z.string().trim().min(1).max(200) });
export const ActivateReferralSchema = ActivateFeeSchema;
export const WithdrawReferralSchema = z.strictObject({ reason: z.string().min(1).max(500), digest: Digest });
export const PublicReferralSchema = z.strictObject({ id: Id, hubId: Id, version: z.int().positive(), digest: Digest, terms: ReferralTermsSchema });
export type PublicReferral = z.infer<typeof PublicReferralSchema>;
/** Staff projection for the console. It names staff, so it is served only under `admin.growth.referrals.*`. */
export const StaffReferralSchema = z.strictObject({
  id: Id, hubId: Id, version: z.int().positive(), digest: Digest, terms: ReferralTermsSchema, status: z.enum(['draft', 'active', 'withdrawn']),
  legalReviewRef: z.string().min(1), draftedBy: Id, activatedBy: Id.nullable(), activatedAt: Timestamp.nullable(), withdrawnAt: Timestamp.nullable(),
});
export type StaffReferral = z.infer<typeof StaffReferralSchema>;
export const PublicPricingSchema = z.strictObject({
  hubId: Id.nullable(), fees: z.array(PublicFeeSchema), prices: z.array(PublicPriceSchema),
  /** Absent in older responses. An empty array with `coverage.sections.referrals: available` means the hub runs no programme. */
  referrals: z.array(PublicReferralSchema).optional(),
  unavailable: z.array(z.enum(['fees', 'plans', 'models', 'capabilities', 'credit_packs', 'referrals'])),
  coverage: z.strictObject({
    generatedAt: Timestamp,
    sections: z.strictObject({
      fees: z.enum(['available', 'unavailable', 'error']), plans: z.enum(['available', 'unavailable', 'error']),
      services: z.enum(['available', 'unavailable', 'error']), models: z.enum(['available', 'unavailable', 'error']),
      capabilities: z.enum(['available', 'unavailable', 'error']), credit_packs: z.enum(['available', 'unavailable', 'error']),
      referrals: z.enum(['available', 'unavailable', 'error']).optional(),
    }),
  }).optional(),
});
export type PublicPricing = z.infer<typeof PublicPricingSchema>;
export const FeeConfirmationSchema = z.strictObject({ disclosureId: Id, digest: Digest });

export const FeeDisclosureSchema = z.strictObject({
  id: Id, digest: Digest,
  snapshot: z.strictObject({
    scopeId: Id, sourceDigest: Digest, sourceHubId: Id, side: z.enum(['buyer', 'seller']),
    buyerFee: PublicFeeSchema, sellerFee: PublicFeeSchema,
  }),
});
export type FeeDisclosure = z.infer<typeof FeeDisclosureSchema>;

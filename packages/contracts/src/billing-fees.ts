import { z } from 'zod';
import { MarketplaceFeeKindSchema } from './hub.js';

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
});
export type PublicPrice = z.infer<typeof PublicPriceSchema>;
export const PublicPricingSchema = z.strictObject({
  hubId: Id.nullable(), fees: z.array(PublicFeeSchema), prices: z.array(PublicPriceSchema),
  unavailable: z.array(z.enum(['fees', 'plans', 'models', 'capabilities', 'credit_packs'])),
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

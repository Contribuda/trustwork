import { z } from 'zod';
import { CategoryCodeSchema } from '../agent-catalog.js';
import { IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from '../common/ids.js';
import { NonNegativeMoneySchema } from '../common/money.js';
import { ConfidenceSchema, EvidenceRefsSchema, KeySchema, RegionCodeSchema } from './common.js';

/**
 * The company's private supplier base (PRC-003). Every schema here is buyer-private (`party_private` of the buying
 * company): a supplier never learns it is listed, which status it has or what the buyer wrote, and none of it reaches
 * search, notifications, reputation, federation or hub statistics. External counterparties are not platform members.
 */

export const SupplierStatusSchema = z.enum(['prospect', 'approved', 'preferred', 'on_hold', 'blocked', 'archived']);
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;

/** Country-pack identifier kinds, for example `us_ein`; the value is private to the buyer. */
export const CounterpartyIdentifierSchema = z.strictObject({ kind: z.string().regex(/^[a-z]{2}_[a-z0-9_]{2,40}$/), value: z.string().min(1).max(80) });

export const OnboardingItemSchema = z.strictObject({
  key: KeySchema,
  kind: z.enum(['document', 'screening', 'payee_verification']),
  documentTypeKey: z.string().regex(/^[a-z0-9_.-]{2,80}$/).nullable(),
  state: z.enum(['missing', 'received', 'in_review', 'complete', 'expired']),
});

export const SupplierRecordSchema = z.strictObject({
  id: IdSchema,
  ownerCompanyId: IdSchema,
  /** Exactly one link: a platform company (claimed or verified), a sourced directory record, or an external counterparty. */
  linkedCompanyId: IdSchema.nullable(),
  linkedSourcedCompanyId: IdSchema.nullable(),
  externalCounterpartyId: IdSchema.nullable(),
  status: SupplierStatusSchema,
  categories: z.array(CategoryCodeSchema).max(50),
  regions: z.array(RegionCodeSchema).max(50),
  internalNotes: TextSchema.nullable(),
  defaultPaymentTerms: ShortTextSchema.nullable(),
  onboarding: z.array(OnboardingItemSchema).max(50),
  revision: RevisionSchema,
}).refine((r) => [r.linkedCompanyId, r.linkedSourcedCompanyId, r.externalCounterpartyId].filter((x) => x !== null).length === 1, { message: 'a supplier record links exactly one company, sourced record or external counterparty', path: ['linkedCompanyId'] });
export type SupplierRecord = z.infer<typeof SupplierRecordSchema>;

export const ExternalCounterpartySchema = z.strictObject({
  id: IdSchema,
  ownerCompanyId: IdSchema,
  name: NameSchema,
  identifiers: z.array(CounterpartyIdentifierSchema).max(10),
  /** Private contacts; outreach only through the buyer's own channel grant. */
  contacts: z.array(z.strictObject({ role: z.string().min(1).max(80), channel: z.enum(['email', 'phone', 'postal']), value: z.string().min(1).max(300) })).max(20),
  source: z.enum(['manual', 'import', 'document']),
  /** Set when the company later joins and the buyer links the claimed page; nothing private moves into the public projection. */
  claimedCompanyId: IdSchema.nullable(),
  revision: RevisionSchema,
});
export type ExternalCounterparty = z.infer<typeof ExternalCounterpartySchema>;

export const SupplierAssessmentSchema = z.strictObject({
  id: IdSchema,
  supplierRecordId: IdSchema,
  period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  criteriaVersion: z.int().min(1),
  scores: z.array(z.strictObject({ criterion: KeySchema, value: z.int().min(0).max(5), evidenceRefs: EvidenceRefsSchema })).min(1).max(30),
  assessedByPersonId: IdSchema,
  sharedWithSupplier: z.boolean(),
  supplierResponse: TextSchema.nullable(),
  /** Assessments never feed reputation snapshots; only a review tied to a real agreement does, through the review rules. */
  reputationInput: z.literal(false),
  assessedAt: TimestampSchema,
}).refine((a) => a.sharedWithSupplier || a.supplierResponse === null, { message: 'only a shared assessment has a supplier response', path: ['supplierResponse'] });
export type SupplierAssessment = z.infer<typeof SupplierAssessmentSchema>;

/** Figures from the buyer's own records only; never another buyer's data. */
export const SupplierOwnHistorySchema = z.strictObject({
  agreements: z.int().min(0),
  orders: z.int().min(0),
  receipts: z.int().min(0),
  receiptsOnTime: z.int().min(0),
  discrepancies: z.int().min(0),
  matchExceptions: z.int().min(0),
  openInvoices: z.int().min(0),
  openInvoiceAmount: NonNegativeMoneySchema.nullable(),
  documentsExpiringWithin30Days: z.int().min(0),
}).refine((h) => h.receiptsOnTime <= h.receipts, { message: 'on-time receipts within receipts', path: ['receiptsOnTime'] });

/** Public facts read from the supplier's public projection only (claimed or verified status, public reputation snapshot). */
export const SupplierPublicFactsSchema = z.strictObject({
  counterpartyStatus: z.enum(['sourced', 'claimed', 'verified', 'external']),
  reputationSnapshotId: IdSchema.nullable(),
  dueDiligencePackId: IdSchema.nullable(),
});

/** Buyer-private supplier card: the record, own history and public facts side by side. Layer `party_private` of the buyer. */
export const SupplierCardSchema = z.strictObject({
  audience: z.literal('party_private'),
  ownerCompanyId: IdSchema,
  supplierRecordId: IdSchema,
  status: SupplierStatusSchema,
  categories: z.array(CategoryCodeSchema),
  regions: z.array(RegionCodeSchema),
  onTimeRate: ConfidenceSchema.nullable(),
  history: SupplierOwnHistorySchema,
  publicFacts: SupplierPublicFactsSchema,
  onboardingComplete: z.boolean(),
});
export type SupplierCard = z.infer<typeof SupplierCardSchema>;

/** Computes the buyer-private card. The on-time rate is exact to six digits (rounded down) and `null` without receipts. */
export function toSupplierCard(record: SupplierRecord, history: z.infer<typeof SupplierOwnHistorySchema>, publicFacts: z.infer<typeof SupplierPublicFactsSchema>): SupplierCard {
  const r = SupplierRecordSchema.parse(record);
  const h = SupplierOwnHistorySchema.parse(history);
  let onTimeRate: string | null = null;
  if (h.receipts > 0) {
    const micro = (BigInt(h.receiptsOnTime) * 1_000_000n) / BigInt(h.receipts);
    const whole = micro / 1_000_000n;
    const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    onTimeRate = frac ? `${whole}.${frac}` : `${whole}`;
  }
  return SupplierCardSchema.parse({
    audience: 'party_private', ownerCompanyId: r.ownerCompanyId, supplierRecordId: r.id, status: r.status, categories: r.categories, regions: r.regions,
    onTimeRate, history: h, publicFacts, onboardingComplete: r.onboarding.every((i) => i.state === 'complete'),
  });
}

/** Fields of the supplier base that never appear in any projection outside the buying company (forbidden-field tests). */
export const SUPPLIER_BASE_PRIVATE_FIELDS = ['status', 'internalNotes', 'defaultPaymentTerms', 'onboarding', 'scores', 'contacts', 'identifiers'] as const;

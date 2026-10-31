import { z } from 'zod';
import { PartySchema } from './access.js';
import { DigestSchema } from './common/digest-schema.js';
import { IdempotencyKeySchema } from './common/idempotency.js';
import { IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { MoneySchema } from './common/money.js';
import { pickFields } from './common/projection.js';
import { QuantitySchema } from './common/quantity.js';
import { VersionRefSchema } from './common/version.js';

type VersionRef = z.infer<typeof VersionRefSchema>;

/** Agreement digest input: exactly the two version refs, computed once at creation; acceptance events are never digest input. Computation: `server/commercial.ts`. */
export function agreementDigestInput(quoteVersion: VersionRef, rfqVersion: VersionRef) {
  return { quoteVersion: VersionRefSchema.parse(quoteVersion), rfqVersion: VersionRefSchema.parse(rfqVersion) };
}

export const ActorSchema = z.strictObject({
  personId: IdSchema,
  onBehalfOf: PartySchema,
  mandate: z.strictObject({ id: IdSchema, revision: RevisionSchema }).nullable(),
  approval: z.strictObject({ id: IdSchema, actionDigest: DigestSchema }).nullable(),
});
export const AcceptanceEventKindSchema = z.enum(['buyer_selects', 'buyer_accepts_terms', 'seller_accepts_order', 'seller_declines', 'withdrawn']);
/** Structural shape (client-safe). `AcceptanceEventSchema` in `server/commercial.ts` adds the digest-equality refinement. */
export const AcceptanceEventRecordSchema = z.strictObject({
  id: IdSchema,
  agreementId: IdSchema,
  kind: AcceptanceEventKindSchema,
  quoteVersion: VersionRefSchema,
  rfqVersion: VersionRefSchema,
  acceptedTermsDigest: DigestSchema,
  actor: ActorSchema,
  authority: z.strictObject({ transactionBudgetId: IdSchema.nullable(), reservationId: IdSchema.nullable(), platformBudgetId: IdSchema.nullable() }),
  occurredAt: TimestampSchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type AcceptanceEvent = z.infer<typeof AcceptanceEventRecordSchema>;

export const AgreementStatusSchema = z.enum(['proposed', 'accepted_by_buyer', 'accepted_by_both', 'declined', 'withdrawn', 'superseded']);
export const ObligationSchema = z.strictObject({ party: PartySchema, kind: z.enum(['deliver', 'perform', 'pay', 'accept']), due: TimestampSchema.nullable(), amount: MoneySchema.nullable(), scope: QuantitySchema.nullable() });
/** Shared agreement record (client-safe). Party-private data lives in separate records below; `AgreementSchema` in `server/commercial.ts` adds the digest refinement. */
export const AgreementRecordSchema = z.strictObject({
  id: IdSchema,
  parties: z.strictObject({ buyer: PartySchema, seller: PartySchema }),
  acceptedTerms: z.strictObject({ quoteVersion: VersionRefSchema, rfqVersion: VersionRefSchema, digest: DigestSchema }),
  acceptanceEventIds: z.array(IdSchema),
  status: AgreementStatusSchema,
  supersededBy: IdSchema.nullable(),
  obligations: z.array(ObligationSchema),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Agreement = z.infer<typeof AgreementRecordSchema>;

/** party_private (buyer): budget and approval references; never joined into the shared or seller view. */
export const AgreementBuyerPrivateSchema = z.strictObject({
  agreementId: IdSchema,
  ownerParty: PartySchema,
  transactionBudgetId: IdSchema.nullable(),
  approvalRefs: z.array(IdSchema),
  notes: ShortTextSchema.nullable(),
  revision: RevisionSchema,
});
export type AgreementBuyerPrivate = z.infer<typeof AgreementBuyerPrivateSchema>;
/** party_private (seller): fulfilment internals; never joined into the shared or buyer view. */
export const AgreementSellerPrivateSchema = z.strictObject({
  agreementId: IdSchema,
  ownerParty: PartySchema,
  fulfilmentPlan: z.array(z.strictObject({ step: ShortTextSchema, internalOwnerPersonId: IdSchema })),
  notes: ShortTextSchema.nullable(),
  revision: RevisionSchema,
});
export type AgreementSellerPrivate = z.infer<typeof AgreementSellerPrivateSchema>;

export const AgreementBuyerViewSchema = z.strictObject({ agreement: AgreementRecordSchema, buyerPrivate: AgreementBuyerPrivateSchema });
export const AgreementSellerViewSchema = z.strictObject({ agreement: AgreementRecordSchema, sellerPrivate: AgreementSellerPrivateSchema });

export const SharedAgreementSchema = z.strictObject({
  id: IdSchema,
  parties: AgreementRecordSchema.shape.parties,
  acceptedTerms: AgreementRecordSchema.shape.acceptedTerms,
  acceptanceEventIds: z.array(IdSchema),
  status: AgreementStatusSchema,
  supersededBy: IdSchema.nullable(),
  obligations: z.array(ObligationSchema),
  revision: RevisionSchema,
});
export type SharedAgreement = z.infer<typeof SharedAgreementSchema>;
/** shared_party: accepted terms, parties, obligations, status and history; no budgets, approvals or fulfilment internals. */
export function toSharedAgreement(agreement: Agreement): SharedAgreement {
  return SharedAgreementSchema.parse(pickFields(agreement, ['id', 'parties', 'acceptedTerms', 'acceptanceEventIds', 'status', 'supersededBy', 'obligations', 'revision']));
}
export const BuyerAgreementSchema = SharedAgreementSchema.extend({ buyerPrivate: AgreementBuyerPrivateSchema.omit({ agreementId: true, ownerParty: true, revision: true }) });
export const SellerAgreementSchema = SharedAgreementSchema.extend({ sellerPrivate: AgreementSellerPrivateSchema.omit({ agreementId: true, ownerParty: true, revision: true }) });
/** party_private (buyer): shared projection plus the buyer's own budget/approval references; nothing from the seller side. */
export function toBuyerAgreement(view: z.infer<typeof AgreementBuyerViewSchema>) {
  return BuyerAgreementSchema.parse({ ...toSharedAgreement(view.agreement), buyerPrivate: pickFields(view.buyerPrivate, ['transactionBudgetId', 'approvalRefs', 'notes']) });
}
/** party_private (seller): shared projection plus the seller's own fulfilment plan; nothing from the buyer side. */
export function toSellerAgreement(view: z.infer<typeof AgreementSellerViewSchema>) {
  return SellerAgreementSchema.parse({ ...toSharedAgreement(view.agreement), sellerPrivate: pickFields(view.sellerPrivate, ['fulfilmentPlan', 'notes']) });
}
/** Agreements are never public. */
export function toPublicAgreement(): null {
  return null;
}

export const OrderStatusSchema = z.enum(['placed', 'accepted', 'changed', 'cancelled', 'fulfilled']);
export const OrderSchema = z.strictObject({
  id: IdSchema,
  agreementId: IdSchema,
  acceptedTermsDigest: DigestSchema,
  status: OrderStatusSchema,
  externalReference: z.string().max(200).nullable(),
  reservationId: IdSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Order = z.infer<typeof OrderSchema>;

/** Server derives the principal from the session/delegation and obtains money from the immutable quote, never from the client. */
export const PlaceOrderCommandSchema = z.strictObject({
  action: z.literal('place_order'),
  context: z.strictObject({ kind: z.enum(['project', 'rfq']), id: IdSchema }),
  agreementId: IdSchema,
  quoteVersion: VersionRefSchema,
  rfqVersion: VersionRefSchema,
  expectedRevision: RevisionSchema,
  mandateId: IdSchema.nullable(),
  mandateRevision: RevisionSchema.nullable(),
  transactionBudgetId: IdSchema,
  /** Nullable only when no platform charge occurs. */
  platformBudgetId: IdSchema.nullable(),
  idempotencyKey: IdempotencyKeySchema,
});
export type PlaceOrderCommand = z.infer<typeof PlaceOrderCommandSchema>;
export const AcceptTermsCommandSchema = z.strictObject({ rfqId: IdSchema, quoteVersion: VersionRefSchema, rfqVersion: VersionRefSchema, expectedRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema });

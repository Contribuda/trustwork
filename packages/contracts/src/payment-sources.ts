import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema } from './common/money.js';
import { PaymentBindingSchema, PaymentMinorSchema, PaymentReferenceSchema } from './payments.js';

/** ADR024 bounded local allocation. No operational issuer or permission is granted by these declarations. */
export const PAYMENT_SOURCE_SECOND_PERSON_ACTIONS = ['payments.register_source_adapter', 'payments.accept_participant_binding', 'payments.activate_account_binding'] as const;
export const PAYMENT_SOURCE_PERMISSIONS = ['admin.payments.adapters.propose', 'admin.payments.adapters.activate',
  'admin.payments.participant_binding.propose', 'admin.payments.participant_binding.accept',
  'admin.payments.account_binding.propose', 'admin.payments.account_binding.review', 'admin.payments.sources.revoke'] as const;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Country = z.string().regex(/^[A-Z]{2}$/);
/** The first slice requires an attested subdivision; a country cannot prove an unknown subdivision clear. */
const Place = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
export const PaymentAdapterRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1), hubId: IdSchema, connectionId: IdSchema,
  fact: z.enum(['identity_link', 'account', 'publisher']), implementationDigest: Digest,
  algorithm: z.literal('ed25519'), keyId: PaymentReferenceSchema, publicKey: z.string().min(32).max(1024),
  evidenceMode: z.literal('synthetic'), expiresAt: TimestampSchema,
});
export type PaymentAdapterRegistration = z.infer<typeof PaymentAdapterRegistrationSchema>;
export const PaymentSourceChallengeCommandSchema = z.strictObject({
  hubId: IdSchema, connectionId: IdSchema, identityRegistrationId: IdSchema,
  accountRegistrationId: IdSchema.nullable(), purpose: z.enum(['payment_participant', 'payment_account']),
}).refine((v) => (v.purpose === 'payment_account') === (v.accountRegistrationId !== null), { message: 'account purpose requires its registered issuer' });
export type PaymentSourceChallengeCommand = z.infer<typeof PaymentSourceChallengeCommandSchema>;
export const PaymentSourceChallengeViewSchema = z.strictObject({
  id: IdSchema, nonce: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: TimestampSchema,
  purpose: z.enum(['payment_participant', 'payment_account']),
});
const Envelope = {
  schemaVersion: z.literal(1), registrationId: IdSchema, challengeId: IdSchema, nonceDigest: Digest,
  audience: IdSchema, personId: IdSchema, sessionId: IdSchema, personEpoch: z.number().int().nonnegative(),
  purpose: z.enum(['payment_participant', 'payment_account']), evidenceMode: z.literal('synthetic'),
  issuedAt: TimestampSchema, expiresAt: TimestampSchema,
};
/** Only a registered identity-link issuer attests the exact verified subject AND external entity correlation. */
export const PaymentIdentityAssertionSchema = z.strictObject({
  ...Envelope, fact: z.literal('identity_link'), verifiedSubjectRef: PaymentReferenceSchema,
  residenceCountry: Country, residencePlace: Place,
  connectionId: IdSchema, providerEntityRef: PaymentReferenceSchema.nullable(),
}).refine((v) => v.residencePlace.startsWith(`${v.residenceCountry}-`) &&
  (v.purpose === 'payment_account') === (v.providerEntityRef !== null), { message: 'exact place and independent entity linkage required' });
/** Authenticated account evidence proves provider-owned facts, never an arbitrary callback party ID. */
export const PaymentAccountAssertionSchema = z.strictObject({
  ...Envelope, fact: z.literal('account'), purpose: z.literal('payment_account'),
  identityRegistrationId: IdSchema, verifiedSubjectRef: PaymentReferenceSchema,
  connectionId: IdSchema, connectionDigest: Digest, providerEntityRef: PaymentReferenceSchema,
  accountRef: PaymentReferenceSchema, accountCountry: Country, accountPlace: Place,
  capabilities: z.array(z.enum(['payments', 'payouts'])).min(1).max(2), status: z.literal('active'),
}).refine((v) => v.accountPlace.startsWith(`${v.accountCountry}-`), { message: 'account country does not establish an unknown subdivision' });
/** An issuer may withdraw only its own exact immutable assertion; this never supplies replacement facts. */
export const PaymentSourceWithdrawalSchema = z.strictObject({ schemaVersion: z.literal(1), fact: z.literal('withdrawal'),
  issuerFact: z.enum(['identity_link', 'account']), registrationId: IdSchema, audience: IdSchema,
  recordId: IdSchema, digest: Digest, issuedAt: TimestampSchema, evidenceMode: z.literal('synthetic') });
export const PaymentSourceAssertionSchema = z.union([PaymentIdentityAssertionSchema, PaymentAccountAssertionSchema, PaymentSourceWithdrawalSchema]);
export type PaymentSourceAssertion = z.infer<typeof PaymentSourceAssertionSchema>;
export const PaymentAuthorizationDraftCommandSchema = z.strictObject({
  agreementId: IdSchema, payerBindingId: IdSchema, payeeBindingId: IdSchema,
  accountBindingId: IdSchema, publisherRegistrationId: IdSchema, rail: PaymentBindingSchema.shape.rail,
});
export const PaymentAuthorizationAcceptCommandSchema = z.strictObject({ digest: Digest });
/** Deliberate private projection: no identity subject, account/entity reference, signature, name or location. */
export const PaymentAuthorizationViewSchema = z.strictObject({
  id: IdSchema, digest: Digest, agreementId: IdSchema, payerId: IdSchema, payeeId: IdSchema,
  amountMinor: PaymentMinorSchema, currency: CurrencySchema, hubId: IdSchema,
  rail: PaymentBindingSchema.shape.rail, accountBindingId: IdSchema, expiresAt: TimestampSchema,
  payerAccepted: z.boolean(), payeeAccepted: z.boolean(), published: z.boolean(),
});
export type PaymentAuthorizationView = z.infer<typeof PaymentAuthorizationViewSchema>;
export const PaymentSourceOwnBindingsSchema = z.array(z.strictObject({ participantBindingId: IdSchema, accountBindingId: IdSchema.nullable(), accepted: z.boolean() }));
export const PaymentSourceReviewMaterialSchema = z.strictObject({ id: IdSchema, hubId: IdSchema,
  action: z.enum(['payments.accept_participant_binding', 'payments.activate_account_binding']), digest: Digest, evidenceMode: z.literal('synthetic') });
export const PaymentSourceReviewCommandSchema = z.strictObject({ reason: z.string().min(1).max(500) });
export const PaymentSourceActivateCommandSchema = PaymentSourceReviewCommandSchema.extend({ approvalId: IdSchema });
export const PaymentSourceRevokeCommandSchema = z.strictObject({ kind: z.enum(['identity', 'participant', 'account', 'authorization']) });

export const PaymentSourceStaffRevokeCommandSchema = PaymentSourceReviewCommandSchema.extend({ kind: z.enum(['registration', 'review', 'source']) });

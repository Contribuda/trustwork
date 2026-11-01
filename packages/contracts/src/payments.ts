import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema } from './common/money.js';
import { PartySchema } from './access.js';

/** PAY-001: amounts are exact minor units. No decimal rounding or exchange rates enter settlement. */
export const PaymentMinorSchema = z.string().regex(/^[1-9]\d{0,17}$/);
export const PaymentReferenceSchema = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.:-]+$/);
export const PaymentKindSchema = z.enum(['create', 'confirm', 'refund', 'payout', 'connected_account']);
export const PaymentStateSchema = z.enum(['outside_platform', 'queued', 'requires_confirmation', 'pending_customer_action', 'outcome_unknown', 'succeeded', 'failed']);
export type PaymentState = z.infer<typeof PaymentStateSchema>;
export type PaymentKind = z.infer<typeof PaymentKindSchema>;

/** Only the owning projection produces this binding; it is never a participant command body. */
export const PaymentBindingSchema = z.strictObject({
  agreementId: IdSchema,
  agreementDigest: z.string().regex(/^[a-f0-9]{64}$/),
  offerVersion: z.number().int().positive(),
  requestVersion: z.number().int().positive(),
  payer: PartySchema,
  payee: PartySchema,
  collectingHubId: IdSchema,
  payerHubId: IdSchema,
  payeeHubId: IdSchema,
  payerCountry: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/),
  payeeCountry: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/),
  currency: CurrencySchema,
  amountMinor: PaymentMinorSchema,
  connectionId: IdSchema,
  connectedAccountRef: PaymentReferenceSchema,
  rail: z.enum(['card', 'ach', 'push_to_phone', 'qr', 'provider_escrow']),
  evidenceMode: z.enum(['synthetic', 'licensed_provider']),
});
export type PaymentBinding = z.infer<typeof PaymentBindingSchema>;

/** No caller-selected party, place, hub, amount, account or provider. */
export const CreatePaymentCommandSchema = z.strictObject({ agreementId: IdSchema, budgetId: IdSchema });
export const PaymentActionCommandSchema = z.strictObject({ paymentId: IdSchema });
export const PaymentJobSchema = z.strictObject({ operationId: IdSchema });

/** An adapter verifies the sender before this shape is accepted, including callbacks on terminal operations. */
export const PaymentEvidenceSchema = z.strictObject({
  eventId: PaymentReferenceSchema,
  operationId: IdSchema,
  connectionId: IdSchema,
  kind: PaymentKindSchema,
  providerRef: PaymentReferenceSchema,
  originalProviderRef: PaymentReferenceSchema.nullable(),
  connectedAccountRef: PaymentReferenceSchema,
  amountMinor: PaymentMinorSchema,
  currency: CurrencySchema,
  state: z.enum(['requires_confirmation', 'pending_customer_action', 'succeeded', 'failed', 'outcome_unknown']),
  customerActionDeadline: TimestampSchema.nullable(),
  evidenceMode: z.enum(['synthetic', 'licensed_provider']),
});
export type PaymentEvidence = z.infer<typeof PaymentEvidenceSchema>;
export interface PaymentInstruction {
  operationId: string;
  kind: PaymentKind;
  binding: PaymentBinding;
  originalProviderRef: string | null;
}

/** Reordered pending notices cannot regress terminal state. Conflicting final evidence is quarantined. */
export function paymentTransition(current: PaymentState, incoming: PaymentEvidence['state']): 'apply' | 'ignore' | 'conflict' {
  if (current === 'succeeded' || current === 'failed') {
    if (incoming === 'succeeded' || incoming === 'failed') return incoming === current ? 'ignore' : 'conflict';
    return 'ignore';
  }
  if (current === incoming) return 'ignore';
  if (current === 'pending_customer_action' && incoming === 'requires_confirmation') return 'ignore';
  // Uncertainty can only end with authoritative provider evidence, never a local deadline.
  return 'apply';
}

export const PaymentViewSchema = z.strictObject({
  id: IdSchema,
  agreementId: IdSchema,
  state: PaymentStateSchema,
  amountMinor: PaymentMinorSchema,
  currency: CurrencySchema,
  funds: z.enum(['synthetic_no_money_moves', 'provider_evidence_only']),
});

export type PaymentView = z.infer<typeof PaymentViewSchema>;

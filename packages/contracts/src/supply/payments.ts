import { z } from 'zod';
import { PartySchema } from '../access.js';
import { DigestSchema, Sha256HexSchema } from '../common/digest-schema.js';
import { BusinessDateSchema, IdSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { compareMoney, NonNegativeMoneySchema, sumMoney, type Money } from '../common/money.js';
import { VersionNumberSchema } from '../common/version.js';
import { EvidenceRefsSchema, transitionGuard } from './common.js';

/**
 * Payment proposals, instructions and payee protection (PRC-011). Trustwork and hub operators never hold, pool or route
 * money (ADR 010 decision 20): an instruction is executed only by the hub's licensed provider or recorded as paid
 * outside the platform with evidence. No schema here has a field for a bank account number (R46, ADR 012 decision 34:
 * no bank payment file exports for now).
 */

/** ADR 012 decision 34: a supplier's bank-detail change starts a waiting period of three business days by default (hub setting, never shorter). */
export const PAYEE_COOLING_OFF_DEFAULT_BUSINESS_DAYS = 3 as const;
export const PAYEE_COOLING_OFF_MINIMUM_BUSINESS_DAYS = 3 as const;

/* ---------- Payee accounts ---------- */

export const PayeeAccountStatusSchema = z.enum(['pending_verification', 'cooling_off', 'active', 'suspended', 'superseded', 'rejected']);
export type PayeeAccountStatus = z.infer<typeof PayeeAccountStatusSchema>;
/** `pending_verification → cooling_off → active`, `active → superseded | suspended`; verification can fail (`rejected`). */
export const PAYEE_ACCOUNT_TRANSITIONS: Readonly<Record<PayeeAccountStatus, readonly PayeeAccountStatus[]>> = {
  pending_verification: ['cooling_off', 'rejected'],
  cooling_off: ['active', 'rejected'],
  active: ['superseded', 'suspended'],
  suspended: [], superseded: [], rejected: [],
};
export const payeeAccountTransitionAllowed = transitionGuard(PAYEE_ACCOUNT_TRANSITIONS);

export const PayeeVerificationSchema = z.strictObject({ method: z.enum(['provider_validation', 'callback', 'micro_deposit']), byPersonId: IdSchema.nullable(), at: TimestampSchema, outcome: z.enum(['passed', 'failed']) });

/**
 * A receiving account as a provider token: masked display (last digits only), a keyed fingerprint for change detection
 * and verification history. Strict, so an account number, routing number or IBAN field cannot be added.
 */
export const PayeeAccountSchema = z.strictObject({
  id: IdSchema,
  holder: PartySchema.nullable(),
  /** For a supplier that is not on the platform, the buyer tokenizes the account through the provider's hosted form. */
  externalCounterpartyId: IdSchema.nullable(),
  providerConnectionId: IdSchema,
  tokenRef: IdSchema,
  maskedDisplay: z.string().regex(/^[*•]{2,8}\d{2,4}$/, 'masked display: a few mask characters and at most four digits'),
  fingerprint: Sha256HexSchema,
  verification: z.array(PayeeVerificationSchema).max(20),
  usableFrom: TimestampSchema.nullable(),
  status: PayeeAccountStatusSchema,
  createdAt: TimestampSchema,
}).refine((a) => (a.holder === null) !== (a.externalCounterpartyId === null), { message: 'a holder party or an external counterparty', path: ['holder'] })
  .refine((a) => !['cooling_off', 'active'].includes(a.status) || a.usableFrom !== null, { message: 'a verified account records when it becomes usable', path: ['usableFrom'] });
export type PayeeAccount = z.infer<typeof PayeeAccountSchema>;

export const PayeeChangeStatusSchema = z.enum(['requested', 'verifying', 'cooling_off', 'active', 'rejected']);
export type PayeeChangeStatus = z.infer<typeof PayeeChangeStatusSchema>;
export const PAYEE_CHANGE_TRANSITIONS: Readonly<Record<PayeeChangeStatus, readonly PayeeChangeStatus[]>> = {
  requested: ['verifying', 'rejected'], verifying: ['cooling_off', 'rejected'], cooling_off: ['active', 'rejected'], active: [], rejected: [],
};
export const payeeChangeTransitionAllowed = transitionGuard(PAYEE_CHANGE_TRANSITIONS);

export const PayeeChangeRequestSchema = z.strictObject({
  id: IdSchema,
  payeeAccountId: IdSchema,
  previousPayeeAccountId: IdSchema.nullable(),
  requestedVia: z.enum(['company_account', 'document', 'email', 'agent']),
  requestedByPersonId: IdSchema.nullable(),
  /** Second factor used by the supplier's member holding `company.billing.manage`. */
  stepUp: z.boolean(),
  /** Out-of-band callback to a contact the buyer had on file before the change. */
  callback: z.strictObject({ contactOnFileBeforeChange: z.literal(true), calledByPersonId: IdSchema, at: TimestampSchema, outcome: z.enum(['confirmed', 'not_confirmed', 'unreachable']) }).nullable(),
  riskSignalId: IdSchema.nullable(),
  status: PayeeChangeStatusSchema,
  requestedAt: TimestampSchema,
}).refine((r) => r.requestedVia === 'company_account' || (r.status === 'rejected' && r.riskSignalId !== null), { message: 'a change through a document, e-mail or agent is rejected and raises a risk signal', path: ['status'] })
  .refine((r) => r.requestedVia !== 'company_account' || (r.requestedByPersonId !== null && r.stepUp), { message: 'only a person of the supplier company with a second factor changes payee details', path: ['stepUp'] })
  .refine((r) => !['cooling_off', 'active'].includes(r.status) || r.callback?.outcome === 'confirmed', { message: 'a confirmed callback precedes the cooling-off period', path: ['callback'] });
export type PayeeChangeRequest = z.infer<typeof PayeeChangeRequestSchema>;

/** Adds business days (Monday to Friday, skipping the given holidays) to a date; ISO dates in and out. */
export function addBusinessDays(startDate: string, businessDays: number, holidays: readonly string[] = []): string {
  if (!Number.isInteger(businessDays) || businessDays < 0) throw new RangeError('business days are a non-negative integer');
  const skip = new Set(holidays);
  const d = new Date(`${z.iso.date().parse(startDate)}T00:00:00Z`);
  let left = businessDays;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6 && !skip.has(d.toISOString().slice(0, 10))) left--;
  }
  return d.toISOString().slice(0, 10);
}
/** First local business date on which a changed payee may be paid. Shorter periods than the engine minimum fail. */
export function coolingOffEndsOn(changeVerifiedOn: string, businessDays: number = PAYEE_COOLING_OFF_DEFAULT_BUSINESS_DAYS, holidays: readonly string[] = []): string {
  if (businessDays < PAYEE_COOLING_OFF_MINIMUM_BUSINESS_DAYS) throw new RangeError('the cooling-off period is never shorter than the engine minimum');
  return addBusinessDays(changeVerifiedOn, businessDays, holidays);
}

/* ---------- Risk signals ---------- */

export const PaymentRiskSignalKindSchema = z.enum(['duplicate_invoice', 'bank_detail_change', 'first_payment_new_details', 'lookalike_sender', 'urgency_language', 'amount_anomaly', 'invoice_without_order']);
export const PaymentRiskSignalStatusSchema = z.enum(['open', 'cleared', 'confirmed']);
export type PaymentRiskSignalStatus = z.infer<typeof PaymentRiskSignalStatusSchema>;
export const PAYMENT_RISK_SIGNAL_TRANSITIONS: Readonly<Record<PaymentRiskSignalStatus, readonly PaymentRiskSignalStatus[]>> = { open: ['cleared', 'confirmed'], cleared: [], confirmed: [] };
export const paymentRiskSignalTransitionAllowed = transitionGuard(PAYMENT_RISK_SIGNAL_TRANSITIONS);

export const PaymentRiskSignalSchema = z.strictObject({
  id: IdSchema,
  subject: z.strictObject({ kind: z.enum(['trade_invoice', 'payee_account', 'intake_document', 'message', 'payment_instruction']), id: IdSchema }),
  kind: PaymentRiskSignalKindSchema,
  evidence: z.array(z.strictObject({ label: z.string().regex(/^[a-z][a-z_]{2,60}$/), value: z.string().max(500) })).max(20),
  status: PaymentRiskSignalStatusSchema,
  /** Clearing is human-only: a person on the first-party surface, with a reason. */
  decidedBy: z.strictObject({ kind: z.literal('person'), personId: IdSchema, via: z.literal('first_party') }).nullable(),
  reason: ShortTextSchema.nullable(),
  raisedAt: TimestampSchema,
}).refine((s) => (s.status === 'open') === (s.decidedBy === null) && (s.status === 'open') === (s.reason === null), { message: 'a decided signal records the person and the reason', path: ['decidedBy'] });
export type PaymentRiskSignal = z.infer<typeof PaymentRiskSignalSchema>;

/** The person who changed or verified the payee details never clears a signal about them. */
export function riskSignalClearAllowed(signal: Pick<PaymentRiskSignal, 'status'>, deciderPersonId: string, payeeChangedOrVerifiedBy: readonly string[]): boolean {
  return signal.status === 'open' && !payeeChangedOrVerifiedBy.includes(deciderPersonId);
}

/* ---------- Proposals and instructions ---------- */

export const PaymentProposalStatusSchema = z.enum(['draft', 'proposed', 'in_approval', 'approved', 'executing', 'completed', 'partially_failed', 'cancelled']);
export type PaymentProposalStatus = z.infer<typeof PaymentProposalStatusSchema>;
export const PAYMENT_PROPOSAL_TRANSITIONS: Readonly<Record<PaymentProposalStatus, readonly PaymentProposalStatus[]>> = {
  draft: ['proposed', 'cancelled'], proposed: ['in_approval', 'cancelled'], in_approval: ['approved', 'cancelled'], approved: ['executing', 'cancelled'],
  executing: ['completed', 'partially_failed'], completed: [], partially_failed: [], cancelled: [],
};
export const paymentProposalTransitionAllowed = transitionGuard(PAYMENT_PROPOSAL_TRANSITIONS);

export const PaymentProposalItemSchema = z.strictObject({
  target: z.strictObject({ kind: z.enum(['trade_invoice', 'pay_application', 'milestone']), id: IdSchema }),
  amount: NonNegativeMoneySchema,
  scheduledFor: BusinessDateSchema,
  earlyPaymentDiscount: NonNegativeMoneySchema.nullable(),
  payeeAccountId: IdSchema,
});
export const PaymentProposalSchema = z.strictObject({ id: IdSchema, owner: PartySchema, currentVersionId: IdSchema.nullable(), status: PaymentProposalStatusSchema });
export const PaymentProposalVersionSchema = z.strictObject({
  id: IdSchema,
  proposalId: IdSchema,
  version: VersionNumberSchema,
  payload: z.strictObject({
    items: z.array(PaymentProposalItemSchema).min(1).max(1000),
    /** The funding `transaction` budget. */
    fundingBudgetId: IdSchema,
  }).refine((p) => new Set(p.items.map((i) => i.amount.currency)).size === 1, { message: 'one proposal currency', path: ['items'] })
    .refine((p) => new Set(p.items.map((i) => `${i.target.kind}/${i.target.id}`)).size === p.items.length, { message: 'each target once per proposal', path: ['items'] }),
  digest: DigestSchema,
  preparedBy: IdSchema,
  approvalRequestId: IdSchema.nullable(),
});
export type PaymentProposalVersion = z.infer<typeof PaymentProposalVersionSchema>;

export const PaymentInstructionStateSchema = z.enum(['scheduled', 'submitted', 'pending', 'succeeded', 'failed', 'outcome_unknown', 'reconciling', 'external_recorded']);
export type PaymentInstructionState = z.infer<typeof PaymentInstructionStateSchema>;
/**
 * `scheduled → submitted → pending → succeeded | failed`, `submitted | pending → outcome_unknown → reconciling →
 * succeeded | failed`, or `external_recorded` with evidence. An unknown outcome is reconciled, never retried blindly.
 */
export const PAYMENT_INSTRUCTION_TRANSITIONS: Readonly<Record<PaymentInstructionState, readonly PaymentInstructionState[]>> = {
  scheduled: ['submitted', 'external_recorded'],
  submitted: ['pending', 'succeeded', 'failed', 'outcome_unknown'],
  pending: ['succeeded', 'failed', 'outcome_unknown'],
  outcome_unknown: ['reconciling'],
  reconciling: ['succeeded', 'failed'],
  succeeded: [], failed: [], external_recorded: [],
};
export const paymentInstructionTransitionAllowed = transitionGuard(PAYMENT_INSTRUCTION_TRANSITIONS);

export const PaymentInstructionSchema = z.strictObject({
  id: IdSchema,
  proposalVersionId: IdSchema,
  target: z.strictObject({ kind: z.enum(['trade_invoice', 'pay_application', 'milestone']), id: IdSchema }),
  payeeAccountId: IdSchema,
  amount: NonNegativeMoneySchema,
  scheduledFor: BusinessDateSchema,
  /** `provider`: the hub's licensed provider executes it. `external_recorded`: paid from the company's own bank, recorded with evidence. */
  mode: z.enum(['provider', 'external_recorded']),
  providerConnectionId: IdSchema.nullable(),
  actionIntentId: IdSchema.nullable(),
  /** Billing `payment` with the proposed purpose `trade_invoice`. */
  paymentId: IdSchema.nullable(),
  evidenceRefs: EvidenceRefsSchema,
  state: PaymentInstructionStateSchema,
}).refine((i) => i.mode === 'provider' ? i.providerConnectionId !== null && i.actionIntentId !== null && i.state !== 'external_recorded' : i.providerConnectionId === null && ['scheduled', 'external_recorded'].includes(i.state), { message: 'provider instructions go through the provider port; external ones are only recorded', path: ['mode'] })
  .refine((i) => i.state !== 'external_recorded' || i.evidenceRefs.length > 0, { message: 'an external payment is recorded with evidence', path: ['evidenceRefs'] });
export type PaymentInstruction = z.infer<typeof PaymentInstructionSchema>;

/** Serialized check: instructions never exceed the target's open amount (failed instructions do not count). */
export function instructionsWithinOpenAmount(openAmount: Money, instructions: readonly Pick<PaymentInstruction, 'amount' | 'state'>[]): boolean {
  const counted = instructions.filter((i) => i.state !== 'failed').map((i) => i.amount);
  if (counted.some((a) => a.currency !== openAmount.currency)) return false;
  return compareMoney(sumMoney(counted, openAmount.currency), openAmount) <= 0;
}

export type ReleaseFacts = {
  invoiceStatus: 'approved' | 'scheduled' | 'other';
  invoiceMatched: boolean;
  proposalApproved: boolean;
  payeeStatus: PayeeAccountStatus;
  /** First local business date the payee may be paid (`coolingOffEndsOn`), and today's local business date. */
  payeeUsableOn: string;
  today: string;
  /** Local date of the payee's last bank-detail change, if any. */
  payeeLastChangedOn: string | null;
  openRiskSignals: number;
  withinOpenAmount: boolean;
};
export type ReleaseBlocker = 'proposal_not_approved' | 'invoice_not_approved' | 'invoice_not_matched' | 'payee_not_active' | 'payee_cooling_off' | 'open_risk_signal' | 'above_open_amount';

/** Reasons a payment cannot be released by anyone (person or agent). Empty when release may proceed. */
export function releaseBlockers(f: ReleaseFacts): ReleaseBlocker[] {
  const out: ReleaseBlocker[] = [];
  if (!f.proposalApproved) out.push('proposal_not_approved');
  if (f.invoiceStatus === 'other') out.push('invoice_not_approved');
  if (!f.invoiceMatched) out.push('invoice_not_matched');
  if (f.payeeStatus !== 'active') out.push(f.payeeStatus === 'cooling_off' ? 'payee_cooling_off' : 'payee_not_active');
  if (f.today < f.payeeUsableOn) out.push('payee_cooling_off');
  if (f.openRiskSignals > 0) out.push('open_risk_signal');
  if (!f.withinOpenAmount) out.push('above_open_amount');
  return [...new Set(out)];
}

/**
 * ADR 012 decision 34: an agent may release without asking only where the hub switched the option on (off by default),
 * only for matched invoices, only to payees whose bank details have not changed for the hub's waiting period, and
 * never with any release blocker. Otherwise the person confirms each release.
 */
export function agentMayReleaseWithoutAsking(f: ReleaseFacts, hub: { autoReleaseEnabled: boolean; payeeUnchangedDays: number }): boolean {
  if (!hub.autoReleaseEnabled || releaseBlockers(f).length > 0 || !f.invoiceMatched) return false;
  if (f.payeeLastChangedOn === null) return true;
  const days = (Date.parse(`${f.today}T00:00:00Z`) - Date.parse(`${f.payeeLastChangedOn}T00:00:00Z`)) / 86_400_000;
  return days >= hub.payeeUnchangedDays;
}

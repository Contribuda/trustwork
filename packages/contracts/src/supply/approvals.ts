import { z } from 'zod';
import { PartySchema } from '../access.js';
import { FirstPartyConfirmationSchema } from '../agent-catalog.js';
import { DigestSchema } from '../common/digest-schema.js';
import { IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { compareMoney, MoneySchema, NonNegativeMoneySchema, type Money } from '../common/money.js';
import { VersionNumberSchema } from '../common/version.js';
import { CategoryCodeSchema } from '../agent-catalog.js';
import { KeySchema, transitionGuard } from './common.js';

/**
 * Approval routes, requests, decisions and delegation (PRC-001 builds on these). Approvals are human decisions: the
 * mandate action `approve` is human-only, an `ApprovalDecision` carries a first-party person and no mandate, connection
 * or extension field, and nothing is approved by silence (timeouts escalate, never approve).
 */

export const APPROVAL_SUBJECT_KINDS = [
  'requisition', 'award', 'order', 'order_change', 'trade_invoice', 'payment_proposal', 'document', 'substitution', 'budget_change', 'payee_change', 'supplier_status',
] as const;
export const ApprovalSubjectKindSchema = z.enum(APPROVAL_SUBJECT_KINDS);
export type ApprovalSubjectKind = z.infer<typeof ApprovalSubjectKindSchema>;

/** Conditions that decide whether a step applies. Structured only: free text cannot route an approval. */
export const ApprovalConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('amount_above'), amount: NonNegativeMoneySchema }),
  z.strictObject({ kind: z.literal('amount_at_most'), amount: NonNegativeMoneySchema }),
  z.strictObject({ kind: z.literal('category_in'), categories: z.array(CategoryCodeSchema).min(1).max(50) }),
  z.strictObject({ kind: z.literal('project_in'), projectIds: z.array(IdSchema).min(1).max(200) }),
  z.strictObject({ kind: z.literal('cost_code_in'), costCodeIds: z.array(IdSchema).min(1).max(200) }),
  z.strictObject({ kind: z.literal('supplier_status_in'), statuses: z.array(z.enum(['prospect', 'approved', 'preferred', 'on_hold', 'blocked', 'archived'])).min(1) }),
  z.strictObject({ kind: z.literal('risk_signal_present') }),
  z.strictObject({ kind: z.literal('documents_incomplete') }),
]);
export type ApprovalCondition = z.infer<typeof ApprovalConditionSchema>;

/** Who may decide a step. Approving is not a permission on its own: the selector picks people who hold the right. */
export const ApproverSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('permission_holders'), permission: z.string().regex(/^procurement\.[a-z_.]+$/), scope: z.enum(['project', 'company']) }),
  z.strictObject({ kind: z.literal('named_person'), personId: IdSchema }),
  z.strictObject({ kind: z.literal('project_leader') }),
  z.strictObject({ kind: z.literal('any_of'), personIds: z.array(IdSchema).min(2).max(20) }),
]);
export type ApproverSelector = z.infer<typeof ApproverSelectorSchema>;

/** After a timeout the step goes to the next person; there is deliberately no "approve" or "skip" escalation. */
export const ApprovalEscalationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('next_selector'), selector: ApproverSelectorSchema }),
  z.strictObject({ kind: z.literal('route_owner') }),
]);

export const ApprovalStepSchema = z.strictObject({
  key: KeySchema,
  /** Steps with the same order run in parallel; lower orders run first. */
  order: z.int().min(1).max(50),
  conditions: z.array(ApprovalConditionSchema).max(20),
  selector: ApproverSelectorSchema,
  quorum: z.int().min(1).max(10),
  timeoutHours: z.int().min(1).max(24 * 60),
  escalation: ApprovalEscalationSchema,
}).refine((s) => s.selector.kind !== 'named_person' || s.quorum === 1, { message: 'a named person is a quorum of one', path: ['quorum'] })
  .refine((s) => s.selector.kind !== 'any_of' || s.quorum <= s.selector.personIds.length, { message: 'quorum within the listed people', path: ['quorum'] });
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;

/**
 * Built-in segregation-of-duties rules. They are not route data: a route has no field that could switch them off.
 * Listed here so that the interface can explain them and tests can enumerate them.
 */
export const SOD_RULES = [
  'requester_never_approves_own_subject',
  'payee_changer_never_approves_payment_to_payee',
  'payee_verifier_never_alone_approves_first_payment',
  'receiver_never_alone_approves_matching_invoice_above_threshold',
  'preparer_never_alone_approves_payment_proposal',
] as const;
export type SodRule = (typeof SOD_RULES)[number];

export const ApprovalRoutePayloadSchema = z.strictObject({
  steps: z.array(ApprovalStepSchema).min(1).max(20),
  /** Company threshold above which the person who recorded a receipt cannot alone approve the matching invoice. */
  receiverSoleApprovalThreshold: NonNegativeMoneySchema.nullable(),
}).refine((p) => new Set(p.steps.map((s) => s.key)).size === p.steps.length, { message: 'step keys are unique', path: ['steps'] });

export const ApprovalRouteStatusSchema = z.enum(['draft', 'active', 'superseded']);
export const APPROVAL_ROUTE_TRANSITIONS = { draft: ['active'], active: ['superseded'], superseded: [] } as const satisfies Record<z.infer<typeof ApprovalRouteStatusSchema>, readonly string[]>;
export const approvalRouteTransitionAllowed = transitionGuard<z.infer<typeof ApprovalRouteStatusSchema>>(APPROVAL_ROUTE_TRANSITIONS);

export const ApprovalRouteVersionSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  subjectKind: ApprovalSubjectKindSchema,
  version: VersionNumberSchema,
  payload: ApprovalRoutePayloadSchema,
  digest: DigestSchema,
  templateKey: KeySchema.nullable(),
  templateVersion: VersionNumberSchema.nullable(),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  /** A hub may require a second person to activate (`procurement` hub settings). */
  secondPersonRequired: z.boolean(),
  status: ApprovalRouteStatusSchema,
}).refine((r) => (r.templateKey === null) === (r.templateVersion === null), { message: 'template key and version go together', path: ['templateVersion'] })
  .refine((r) => (r.status === 'draft') === (r.activatedBy === null) && (r.activatedBy === null) === (r.activatedAt === null), { message: 'activation is recorded exactly when the version left draft', path: ['activatedBy'] })
  .refine((r) => !r.secondPersonRequired || r.activatedBy === null || r.activatedBy !== r.draftedBy, { message: 'a second person activates the route', path: ['activatedBy'] });
export type ApprovalRouteVersion = z.infer<typeof ApprovalRouteVersionSchema>;

/* ---------- Requests ---------- */

export const APPROVAL_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'returned', 'withdrawn', 'expired', 'superseded'] as const;
export const ApprovalRequestStatusSchema = z.enum(APPROVAL_REQUEST_STATUSES);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;
/** Lifecycles: `pending → approved | rejected | returned | withdrawn | expired | superseded`; every outcome is terminal. `expired` escalates, it never approves. */
export const APPROVAL_REQUEST_TRANSITIONS: Readonly<Record<ApprovalRequestStatus, readonly ApprovalRequestStatus[]>> = {
  pending: ['approved', 'rejected', 'returned', 'withdrawn', 'expired', 'superseded'],
  approved: [], rejected: [], returned: [], withdrawn: [], expired: [], superseded: [],
};
export const approvalTransitionAllowed = transitionGuard(APPROVAL_REQUEST_TRANSITIONS);

export const SubjectRefSchema = z.strictObject({ kind: ApprovalSubjectKindSchema, id: IdSchema });

export const ApprovalRequestSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  subject: SubjectRefSchema,
  /** Binds the exact frozen subject version; a new version supersedes this request. */
  subjectVersionId: IdSchema,
  subjectDigest: DigestSchema,
  routeVersionId: IdSchema,
  currentStep: KeySchema,
  requestedByPersonId: IdSchema,
  amount: MoneySchema.nullable(),
  status: ApprovalRequestStatusSchema,
  createdAt: TimestampSchema,
  revision: RevisionSchema,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * One person's decision on one step. Append-only. There is no mandate, connection, extension or agent field: the decider
 * is a person on the first-party surface, confirmed by the first-party form (`approve` is human-only).
 */
export const ApprovalDecisionSchema = z.strictObject({
  id: IdSchema,
  approvalRequestId: IdSchema,
  step: KeySchema,
  approverPersonId: IdSchema,
  onBehalf: PartySchema,
  delegatedFromPersonId: IdSchema.nullable(),
  delegationId: IdSchema.nullable(),
  decision: z.enum(['approve', 'reject', 'return']),
  /** Must equal the request's subject digest; a decision on another version is void. */
  subjectDigest: DigestSchema,
  reason: ShortTextSchema.nullable(),
  confirmation: FirstPartyConfirmationSchema,
  decidedAt: TimestampSchema,
}).refine((d) => d.confirmation.personId === d.approverPersonId, { message: 'the approver confirms on the first-party form', path: ['confirmation'] })
  .refine((d) => d.decision === 'approve' || d.reason !== null, { message: 'rejecting or returning needs a reason', path: ['reason'] })
  .refine((d) => (d.delegatedFromPersonId === null) === (d.delegationId === null), { message: 'a delegated decision names its delegation', path: ['delegationId'] })
  .refine((d) => d.delegatedFromPersonId !== d.approverPersonId, { message: 'a person does not delegate to themselves', path: ['delegatedFromPersonId'] });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** A decision counts only for the request's current digest. */
export function decisionBindsRequest(decision: Pick<ApprovalDecision, 'approvalRequestId' | 'subjectDigest'>, request: Pick<ApprovalRequest, 'id' | 'subjectDigest' | 'status'>): boolean {
  return decision.approvalRequestId === request.id && request.status === 'pending'
    && decision.subjectDigest.algorithm === request.subjectDigest.algorithm && decision.subjectDigest.value === request.subjectDigest.value;
}

/* ---------- Delegation ---------- */

export const ApprovalDelegationSchema = z.strictObject({
  id: IdSchema,
  companyId: IdSchema,
  delegatorPersonId: IdSchema,
  delegatePersonId: IdSchema,
  subjectKinds: z.array(ApprovalSubjectKindSchema).min(1),
  limit: NonNegativeMoneySchema.nullable(),
  validFrom: TimestampSchema,
  validUntil: TimestampSchema,
  status: z.enum(['active', 'ended', 'revoked']),
}).refine((d) => d.delegatorPersonId !== d.delegatePersonId, { message: 'delegate to someone else', path: ['delegatePersonId'] })
  .refine((d) => new Set(d.subjectKinds).size === d.subjectKinds.length, { message: 'subject kinds are distinct', path: ['subjectKinds'] })
  .refine((d) => Date.parse(d.validUntil) > Date.parse(d.validFrom), { message: 'delegation ends after it starts', path: ['validUntil'] });
export type ApprovalDelegation = z.infer<typeof ApprovalDelegationSchema>;

/**
 * Whether a delegation lets the delegate decide this subject now. The delegator's own right is checked separately by
 * the caller (`delegatorMayDecide`): a delegation never exceeds the delegator's rights, and it ends with membership.
 */
export function delegationCovers(d: ApprovalDelegation, input: { subjectKind: ApprovalSubjectKind; amount: Money | null; at: Date; delegatorMayDecide: boolean; bothMembersActive: boolean }): boolean {
  const t = input.at.getTime();
  if (d.status !== 'active' || !input.delegatorMayDecide || !input.bothMembersActive) return false;
  if (!(t >= Date.parse(d.validFrom) && t < Date.parse(d.validUntil))) return false;
  if (!d.subjectKinds.includes(input.subjectKind)) return false;
  if (d.limit !== null) {
    if (input.amount === null || input.amount.currency !== d.limit.currency) return false;
    if (compareMoney(input.amount, d.limit) > 0) return false;
  }
  return true;
}

/* ---------- Segregation of duties ---------- */

export type SodInput = {
  subjectKind: ApprovalSubjectKind;
  approverPersonId: string;
  requesterPersonId: string;
  /** Distinct other people who have already approved (or will co-approve) this request. */
  coApproverPersonIds: readonly string[];
  /** Payment subjects: people who changed or verified the payee's bank details. */
  payeeChangedByPersonIds?: readonly string[];
  payeeVerifiedByPersonIds?: readonly string[];
  firstPaymentToPayee?: boolean;
  /** Trade invoices: people who recorded the matched receipts, the invoice amount and the company threshold. */
  receiptRecordedByPersonIds?: readonly string[];
  amount?: Money | null;
  receiverSoleApprovalThreshold?: Money | null;
  /** Payment proposals: who prepared the proposal. */
  proposalPreparedByPersonId?: string | null;
  /** Number of company members eligible to approve this subject at all. */
  eligibleApproverCount: number;
};
export type SodResult = { kind: 'ok' } | { kind: 'violation'; rule: SodRule } | { kind: 'sole_person_flag'; rule: SodRule };

const PAYMENT_SUBJECTS: readonly ApprovalSubjectKind[] = ['payment_proposal', 'trade_invoice'];

/**
 * The built-in segregation-of-duties check. A route cannot disable it. A company with exactly one eligible approver
 * gets `sole_person_flag` (an explicit warning and an audit flag) instead of a silent bypass; anyone else gets
 * `violation` and cannot decide.
 */
export function sodViolation(input: SodInput): SodResult {
  const alone = input.coApproverPersonIds.filter((p) => p !== input.approverPersonId).length === 0;
  const broken = ((): SodRule | null => {
    if (input.approverPersonId === input.requesterPersonId) return 'requester_never_approves_own_subject';
    if (PAYMENT_SUBJECTS.includes(input.subjectKind) && (input.payeeChangedByPersonIds ?? []).includes(input.approverPersonId)) return 'payee_changer_never_approves_payment_to_payee';
    if (input.subjectKind === 'payment_proposal' && input.firstPaymentToPayee === true && alone && (input.payeeVerifiedByPersonIds ?? []).includes(input.approverPersonId)) return 'payee_verifier_never_alone_approves_first_payment';
    if (input.subjectKind === 'trade_invoice' && alone && (input.receiptRecordedByPersonIds ?? []).includes(input.approverPersonId)) {
      const threshold = input.receiverSoleApprovalThreshold ?? null;
      const amount = input.amount ?? null;
      // Unknown amount or a threshold in another currency fails closed.
      if (threshold === null || amount === null || amount.currency !== threshold.currency || compareMoney(amount, threshold) > 0) return 'receiver_never_alone_approves_matching_invoice_above_threshold';
    }
    if (input.subjectKind === 'payment_proposal' && alone && input.proposalPreparedByPersonId === input.approverPersonId) return 'preparer_never_alone_approves_payment_proposal';
    return null;
  })();
  if (broken === null) return { kind: 'ok' };
  return input.eligibleApproverCount === 1 ? { kind: 'sole_person_flag', rule: broken } : { kind: 'violation', rule: broken };
}

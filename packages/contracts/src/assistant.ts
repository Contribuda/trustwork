import { z } from 'zod';
import { PartySchema } from './access.js';
import { DigestSchema } from './common/digest-schema.js';
import { IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { MoneySchema, type Money } from './common/money.js';

/* ---------- Existing pure delegation example (kept for apps/worker and tests) ---------- */
export type PlannedAction = {
  action: 'prepare' | 'send_quote' | 'place_order' | 'accept_order';
  contextId: string;
  amount: Money;
};
export type Delegation = {
  actions: readonly PlannedAction['action'][];
  contextId: string;
  expiresAt: string;
  revoked: boolean;
  ceiling: Money;
};
// Demonstrates a pure fail-closed policy. Durable reservations and object ACLs are still required.
export function evaluateDelegation(grant: Delegation, request: PlannedAction, now: Date): 'allow' | 'deny' {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(grant.expiresAt))) return 'deny';
  if (grant.revoked || Date.parse(grant.expiresAt) <= now.getTime()) return 'deny';
  if (!grant.actions.includes(request.action) || grant.contextId !== request.contextId) return 'deny';
  if (!/^[A-Z]{3}$/.test(request.amount.currency) || grant.ceiling.currency !== request.amount.currency) return 'deny';
  if (![request.amount.minorUnits, grant.ceiling.minorUnits].every((v) => /^(0|[1-9][0-9]*)$/.test(v))) return 'deny';
  return BigInt(request.amount.minorUnits) <= BigInt(grant.ceiling.minorUnits) ? 'allow' : 'deny';
}

/* ---------- Frozen mandate / run / outcome contracts ---------- */
export const MandateActionSchema = z.enum(['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'place_order', 'accept_order', 'generate_deliverable']);
export const MandateStatusSchema = z.enum(['draft', 'active', 'suspended', 'revoked', 'expired']);
export type MandateStatus = z.infer<typeof MandateStatusSchema>;
/** Structured authority: principal, actions, contexts, limits, conditions, expiry, revision. Chat text never changes it. */
export const MandateSchema = z.strictObject({
  id: IdSchema,
  principal: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  actions: z.array(MandateActionSchema).min(1),
  contexts: z.array(z.strictObject({ kind: z.enum(['project', 'rfq', 'quote', 'agreement']), id: IdSchema })).min(1),
  limits: z.strictObject({ ceiling: MoneySchema, perActionCeiling: MoneySchema.nullable(), transactionBudgetId: IdSchema.nullable(), platformBudgetId: IdSchema.nullable() }),
  conditions: z.array(ShortTextSchema),
  validUntil: TimestampSchema,
  status: MandateStatusSchema,
  revision: RevisionSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type Mandate = z.infer<typeof MandateSchema>;
const MANDATE_TRANSITIONS: Record<MandateStatus, readonly MandateStatus[]> = {
  draft: ['active'],
  active: ['active', 'suspended', 'revoked', 'expired'],
  suspended: ['active', 'revoked', 'expired'],
  revoked: [],
  expired: [],
};
export function mandateTransitionAllowed(from: MandateStatus, to: MandateStatus): boolean {
  return MANDATE_TRANSITIONS[from].includes(to);
}

/** Approval binds an exact action digest; a changed digest invalidates it independently of mandate state. */
export const ApprovalSchema = z.strictObject({
  id: IdSchema,
  actionIntentId: IdSchema,
  actionDigest: DigestSchema,
  approverPersonId: IdSchema,
  approvedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
export function approvalValid(approval: Approval, actionDigest: { value: string }, now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && approval.revokedAt === null && approval.actionDigest.value === actionDigest.value && Date.parse(approval.expiresAt) > t;
}

export const ACTION_STATES = ['proposed', 'authorized', 'reserved', 'queued', 'executing', 'pending', 'succeeded', 'failed', 'outcome_unknown', 'reconciling', 'revoked'] as const;
export const ActionStateSchema = z.enum(ACTION_STATES);
export type ActionState = z.infer<typeof ActionStateSchema>;
/** Lifecycle from docs/data/lifecycles.md; `outcome_unknown` never releases money or triggers a duplicate order. */
const ACTION_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  proposed: ['authorized', 'revoked'],
  authorized: ['reserved', 'revoked'],
  reserved: ['queued', 'revoked'],
  queued: ['executing', 'revoked'],
  executing: ['pending', 'succeeded', 'failed', 'outcome_unknown'],
  pending: ['succeeded', 'failed', 'outcome_unknown'],
  outcome_unknown: ['reconciling'],
  reconciling: ['succeeded', 'failed', 'outcome_unknown'],
  failed: ['queued'],
  succeeded: [],
  revoked: [],
};
export function actionTransitionAllowed(from: ActionState, to: ActionState, options: { safelyRetryable?: boolean } = {}): boolean {
  if (from === 'failed' && to === 'queued') return options.safelyRetryable === true;
  return ACTION_TRANSITIONS[from].includes(to);
}

/** External outcomes are three distinct states; crash reconciliation is a separate record, not a fourth outcome. */
export const ExternalOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unknown'), reason: z.enum(['timeout', 'crash', 'lease_expired', 'ambiguous_response']), observedAt: TimestampSchema }),
  z.strictObject({ kind: z.literal('acknowledged'), providerReference: z.string().min(1).max(200), observedAt: TimestampSchema }),
  z.strictObject({ kind: z.literal('final'), result: z.enum(['succeeded', 'failed']), providerReference: z.string().max(200).nullable(), evidence: z.string().min(1).max(2000), observedAt: TimestampSchema }),
]);
export type ExternalOutcome = z.infer<typeof ExternalOutcomeSchema>;
type OutcomeKind = ExternalOutcome['kind'];
const OUTCOME_TRANSITIONS: Record<OutcomeKind, readonly OutcomeKind[]> = { unknown: ['acknowledged', 'final'], acknowledged: ['final', 'unknown'], final: [] };
/** `unknown -> final` is allowed only through a reconciliation record for this exact intent and attempt that names the lookup evidence. */
export function outcomeTransitionAllowed(from: OutcomeKind, to: OutcomeKind, action: { actionIntentId: string; attemptId: string }, via: { reconciliation?: Reconciliation } = {}): boolean {
  if (!OUTCOME_TRANSITIONS[from].includes(to)) return false;
  if (from === 'unknown' && to === 'final') {
    const r = via.reconciliation;
    return r !== undefined && r.outcome.kind === 'final' && r.actionIntentId === action.actionIntentId && r.attemptId === action.attemptId;
  }
  return true;
}
export const ReconciliationSchema = z.strictObject({
  id: IdSchema,
  actionIntentId: IdSchema,
  attemptId: IdSchema,
  operationId: IdSchema,
  lookupReference: z.string().min(1).max(200),
  outcome: ExternalOutcomeSchema,
  reconciledBy: z.enum(['worker', 'staff']),
  reconciledAt: TimestampSchema,
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;
export const ActionIntentSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  mandate: z.strictObject({ id: IdSchema, revision: RevisionSchema }),
  action: MandateActionSchema,
  context: z.strictObject({ kind: z.enum(['project', 'rfq', 'quote', 'agreement']), id: IdSchema }),
  amount: MoneySchema.nullable(),
  /** Digest over the exact proposed action; approvals bind it. */
  actionDigest: DigestSchema,
  state: ActionStateSchema,
  reservationId: IdSchema.nullable(),
  attemptCount: z.int().min(0),
  effectCorrelationKey: z.string().min(1).max(200),
  outcome: ExternalOutcomeSchema.nullable(),
  revision: RevisionSchema,
});
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

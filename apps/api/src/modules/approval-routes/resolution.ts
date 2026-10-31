import { z } from 'zod';
import { CategoryCodeSchema, compareMoney, IdSchema, type Money } from '../../deps/contracts.js';
import { ApprovalRoutePayloadSchema, computeDigest, SupplierStatusSchema, type ApprovalCondition, type ApprovalSubjectKind } from './deps.js';

/**
 * Pure route resolution (PRC-001 step 2): which steps of a route version apply to one subject version. Conditions are
 * structured only (free text never routes an approval) and fail closed: an unknown amount or an amount in another
 * currency makes an amount condition hold, so the step applies and a person looks at it. Selectors, quorum, timeouts
 * and escalation are resolved in SQL (`approval_selector_matches`, `approval_escalate_request`) at decision time.
 */

/** Facts of the subject version that conditions and the segregation-of-duties rules read. Set by the subject's module. */
export const ApprovalSubjectFactsSchema = z.strictObject({
  categories: z.array(CategoryCodeSchema).max(50).default([]),
  projectId: z.uuid().nullable().default(null),
  costCodeIds: z.array(IdSchema).max(200).default([]),
  supplierStatus: SupplierStatusSchema.nullable().default(null),
  riskSignalPresent: z.boolean().default(false),
  documentsIncomplete: z.boolean().default(false),
  /** Payment subjects: people who changed, and who verified, the payee's bank details. */
  payeeChangedByPersonIds: z.array(z.uuid()).max(20).default([]),
  payeeVerifiedByPersonIds: z.array(z.uuid()).max(20).default([]),
  firstPaymentToPayee: z.boolean().default(false),
  /** Trade invoices: people who recorded the matched receipts. */
  receiptRecordedByPersonIds: z.array(z.uuid()).max(50).default([]),
  /** Payment proposals: who prepared the proposal. */
  proposalPreparedByPersonId: z.uuid().nullable().default(null),
});
export type ApprovalSubjectFacts = z.infer<typeof ApprovalSubjectFactsSchema>;
type RoutePayload = z.infer<typeof ApprovalRoutePayloadSchema>;

export interface ResolutionSubject { facts: ApprovalSubjectFacts; amount: Money | null }

export function conditionHolds(condition: ApprovalCondition, subject: ResolutionSubject): boolean {
  const { facts, amount } = subject;
  switch (condition.kind) {
    case 'amount_above':
      return amount === null || amount.currency !== condition.amount.currency || compareMoney(amount, condition.amount) > 0;
    case 'amount_at_most':
      return amount === null || amount.currency !== condition.amount.currency || compareMoney(amount, condition.amount) <= 0;
    case 'category_in':
      return facts.categories.some((c) => condition.categories.includes(c));
    case 'project_in':
      return facts.projectId !== null && condition.projectIds.includes(facts.projectId);
    case 'cost_code_in':
      return facts.costCodeIds.some((c) => condition.costCodeIds.includes(c));
    case 'supplier_status_in':
      return facts.supplierStatus !== null && condition.statuses.includes(facts.supplierStatus);
    case 'risk_signal_present':
      return facts.riskSignalPresent;
    case 'documents_incomplete':
      return facts.documentsIncomplete;
  }
}

/** Keys of the steps whose every condition holds. An empty result means the subject cannot be submitted on this route. */
export function applicableStepKeys(payload: RoutePayload, subject: ResolutionSubject): string[] {
  return payload.steps.filter((step) => step.conditions.every((c) => conditionHolds(c, subject))).map((step) => step.key);
}

/** `trustwork-digest-1` of a route version: what the activating person reviewed. */
export function routeDigest(input: { ownerCompanyId: string; subjectKind: ApprovalSubjectKind; payload: RoutePayload; templateKey: string | null; templateVersion: number | null }) {
  return computeDigest({ kind: 'approval_route_version', version: 1, ownerCompanyId: input.ownerCompanyId, subjectKind: input.subjectKind, payload: input.payload, templateKey: input.templateKey, templateVersion: input.templateVersion });
}

/**
 * Engine route templates (hub templates arrive with HUBC-011). A company starts from one and adapts it; templates
 * contain no customer data and name permissions, never people. Defaults follow the US reference hub (USD).
 */
export interface ApprovalRouteTemplate { key: string; version: number; labelKey: string; payload: RoutePayload }
const DECIDE = 'procurement.approval.decide';
export const APPROVAL_ROUTE_TEMPLATES: readonly ApprovalRouteTemplate[] = [
  {
    key: 'owner_approves', version: 1, labelKey: 'approvals.template.ownerApproves',
    payload: ApprovalRoutePayloadSchema.parse({
      steps: [{ key: 'owner', order: 1, conditions: [], selector: { kind: 'permission_holders', permission: DECIDE, scope: 'company' }, quorum: 1, timeoutHours: 72, escalation: { kind: 'route_owner' } }],
      receiverSoleApprovalThreshold: null,
    }),
  },
  {
    key: 'project_manager_then_director', version: 1, labelKey: 'approvals.template.projectManagerThenDirector',
    payload: ApprovalRoutePayloadSchema.parse({
      steps: [
        { key: 'project_manager', order: 1, conditions: [], selector: { kind: 'permission_holders', permission: DECIDE, scope: 'project' }, quorum: 1, timeoutHours: 48, escalation: { kind: 'next_selector', selector: { kind: 'permission_holders', permission: DECIDE, scope: 'company' } } },
        { key: 'commercial_director', order: 2, conditions: [{ kind: 'amount_above', amount: { minorUnits: '2500000', currency: 'USD' } }], selector: { kind: 'permission_holders', permission: 'procurement.approval.decide_above_limit', scope: 'company' }, quorum: 1, timeoutHours: 72, escalation: { kind: 'route_owner' } },
      ],
      receiverSoleApprovalThreshold: { minorUnits: '500000', currency: 'USD' },
    }),
  },
];
export function templateOf(key: string): ApprovalRouteTemplate | undefined {
  return APPROVAL_ROUTE_TEMPLATES.find((t) => t.key === key);
}

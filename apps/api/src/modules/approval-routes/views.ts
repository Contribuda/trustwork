import { DIGEST_ALGORITHM, type Money } from '../../deps/contracts.js';
import {
  ApprovalDecisionSchema, ApprovalDelegationSchema, ApprovalRequestSchema, ApprovalRouteVersionSchema,
  type ApprovalDecision, type ApprovalDecisionRow, type ApprovalDelegation, type ApprovalDelegationRow, type ApprovalRequest, type ApprovalRequestRow,
  type ApprovalRequestStepRow, type ApprovalRouteVersion, type ApprovalRouteVersionRow, type SodRule,
} from './deps.js';

/** Row -> contract projections. Every view is parsed by its frozen contract schema, so a drift fails loudly. */
const iso = (d: Date | string): string => new Date(d).toISOString();
const digest = (value: string) => ({ algorithm: DIGEST_ALGORITHM, value });
const money = (minor: string | null, currency: string | null): Money | null => (minor === null || currency === null ? null : { minorUnits: String(minor), currency });

export function routeView(row: ApprovalRouteVersionRow): ApprovalRouteVersion {
  return ApprovalRouteVersionSchema.parse({
    id: row.id, owner: { kind: 'company', id: row.owner_company_id }, subjectKind: row.subject_kind, version: row.version, payload: row.payload, digest: digest(row.digest),
    templateKey: row.template_key, templateVersion: row.template_version, draftedBy: row.drafted_by, activatedBy: row.activated_by, activatedAt: row.activated_at ? iso(row.activated_at) : null,
    secondPersonRequired: row.second_person_required, status: row.status,
  });
}

export function requestView(row: ApprovalRequestRow): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: row.id, owner: { kind: 'company', id: row.owner_company_id }, subject: { kind: row.subject_kind, id: row.subject_id }, subjectVersionId: row.subject_version_id,
    subjectDigest: digest(row.subject_digest), routeVersionId: row.route_version_id, currentStep: row.current_step, requestedByPersonId: row.requested_by_person_id,
    amount: money(row.amount_minor, row.currency), status: row.status, createdAt: iso(row.submitted_at), revision: row.revision,
  });
}

export interface StepView { key: string; order: number; status: ApprovalRequestStepRow['status']; quorum: number; approvals: number; dueAt: string | null; escalated: boolean; selector: unknown }
export function stepView(row: ApprovalRequestStepRow): StepView {
  return { key: row.step_key, order: row.step_order, status: row.status, quorum: row.quorum, approvals: row.approvals, dueAt: row.due_at ? iso(row.due_at) : null, escalated: row.escalation_level === 1, selector: row.selector };
}

/** The contract decision plus the audit flag a sole eligible approver leaves behind (never a silent bypass). */
export type DecisionView = ApprovalDecision & { sodFlag: SodRule | null; escalated: boolean };
export function decisionView(row: ApprovalDecisionRow): DecisionView {
  const core = ApprovalDecisionSchema.parse({
    id: row.id, approvalRequestId: row.approval_request_id, step: row.step_key, approverPersonId: row.approver_person_id, onBehalf: { kind: 'company', id: row.on_behalf_company_id },
    delegatedFromPersonId: row.delegated_from_person_id, delegationId: row.delegation_id, decision: row.decision, subjectDigest: digest(row.subject_digest), reason: row.reason,
    confirmation: { via: row.confirmation_via, personId: row.approver_person_id, at: iso(row.decided_at), stepUp: row.step_up }, decidedAt: iso(row.decided_at),
  });
  return { ...core, sodFlag: (row.sod_flag as SodRule | null) ?? null, escalated: row.escalation_level === 1 };
}

/** `ended` once the window passed, even before the sweep marks it. */
export function delegationView(row: ApprovalDelegationRow, now: Date): ApprovalDelegation {
  const status = row.status === 'active' && new Date(row.valid_until).getTime() <= now.getTime() ? 'ended' : row.status;
  return ApprovalDelegationSchema.parse({
    id: row.id, companyId: row.company_id, delegatorPersonId: row.delegator_person_id, delegatePersonId: row.delegate_person_id, subjectKinds: row.subject_kinds,
    limit: money(row.limit_minor, row.limit_currency), validFrom: iso(row.valid_from), validUntil: iso(row.valid_until), status,
  });
}

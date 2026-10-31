import { DigestSchema, MoneySchema, type Digest, type Money } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import { ApprovalRoutePayloadSchema, approvalRequests, approvalRoutes, type ApprovalRequest, type ApprovalSubjectKind } from './deps.js';
import { approvalRefusal } from './errors.js';
import { ApprovalSubjectFactsSchema, applicableStepKeys, type ApprovalSubjectFacts } from './resolution.js';
import { requestView } from './views.js';

/**
 * The port subject modules call inside their own request transaction (requisitions, awards, orders, trade invoices,
 * payment proposals, documents, substitutions, budget changes, payee and supplier-status changes). The caller is the
 * requester, signed in as a member of the owner company, and passes the frozen subject version id and its digest.
 * A new version supersedes the pending request; a decision binds the digest; the outcome arrives as the outbox event
 * `approval.request_closed` (identifiers only).
 */
export interface SubmitForApprovalInput {
  companyId: string;
  subject: { kind: ApprovalSubjectKind; id: string };
  subjectVersionId: string;
  subjectDigest: Digest;
  amount: Money | null;
  facts: Partial<ApprovalSubjectFacts>;
}

export async function submitForApproval(trx: Transaction, input: SubmitForApprovalInput, now: Date): Promise<ApprovalRequest> {
  const digest = DigestSchema.parse(input.subjectDigest);
  const amount = input.amount === null ? null : MoneySchema.parse(input.amount);
  const facts = ApprovalSubjectFactsSchema.parse(input.facts);
  const route = await approvalRoutes.active(trx, input.companyId, input.subject.kind);
  if (!route) throw new ApiError('validation.schema', `no active approval route for ${input.subject.kind}`, { reason: 'no_active_route' });
  const payload = ApprovalRoutePayloadSchema.parse(route.payload);
  const stepKeys = applicableStepKeys(payload, { facts, amount });
  try {
    const row = await approvalRequests.submit(trx, {
      companyId: input.companyId, subjectKind: input.subject.kind, subjectId: input.subject.id, subjectVersionId: input.subjectVersionId, subjectDigest: digest.value,
      amount, projectId: facts.projectId, facts, routeVersionId: route.id, stepKeys, now,
    });
    return requestView(row);
  } catch (error) {
    approvalRefusal(error);
  }
}

/** A new subject version without resubmitting: every pending request of another version becomes `superseded`. */
export async function supersedePendingApprovals(trx: Transaction, input: { subject: { kind: ApprovalSubjectKind; id: string }; newVersionId: string }, now: Date): Promise<number> {
  try {
    return await approvalRequests.supersede(trx, { subjectKind: input.subject.kind, subjectId: input.subject.id, newVersionId: input.newVersionId, now });
  } catch (error) {
    approvalRefusal(error);
  }
}

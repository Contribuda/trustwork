import { computeDigest, type Digest } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import { ApprovalRoutePayloadSchema, approvalRequests, approvalRoutes, type ApprovalRequest } from '../approval-routes/deps.js';
import { submitForApproval } from '../approval-routes/port.js';
import { applicableStepKeys } from '../approval-routes/resolution.js';
import type { SupplierRecordRow, SupplierStatus } from './deps.js';

/**
 * Supplier status changes through the company's approval route of subject kind `supplier_status` (PRC-001). When the
 * company has an active route whose steps apply to the new status (`supplier_status_in` and the other structured
 * conditions), the change is not applied: it is submitted for approval, bound to the record's current revision and a
 * digest of the change, and applied later by a maintainer who names the approved request. A change no step applies to,
 * or a company without such a route, applies at once. Nothing here reaches the supplier: the request and its outbox
 * events name the private record only.
 */
export function statusChangeDigest(record: Pick<SupplierRecordRow, 'id' | 'revision' | 'status'>, to: SupplierStatus): Digest {
  return computeDigest({ kind: 'trustwork.supplier_status_change', version: 1, supplierRecordId: record.id, revision: record.revision, from: record.status, to });
}

/** The active route's steps for this change, or null when no approval is needed. */
export async function statusRoute(trx: Transaction, companyId: string, to: SupplierStatus, categories: readonly string[]): Promise<{ routeId: string } | null> {
  const route = await approvalRoutes.active(trx, companyId, 'supplier_status');
  if (!route) return null;
  const steps = applicableStepKeys(ApprovalRoutePayloadSchema.parse(route.payload), { facts: { ...EMPTY_FACTS, supplierStatus: to, categories: [...categories] }, amount: null });
  return steps.length > 0 ? { routeId: route.id } : null;
}

const EMPTY_FACTS = {
  categories: [] as string[], projectId: null, costCodeIds: [] as string[], supplierStatus: null, riskSignalPresent: false, documentsIncomplete: false,
  payeeChangedByPersonIds: [] as string[], payeeVerifiedByPersonIds: [] as string[], firstPaymentToPayee: false, receiptRecordedByPersonIds: [] as string[], proposalPreparedByPersonId: null,
};

export async function submitStatusChange(trx: Transaction, companyId: string, record: SupplierRecordRow, to: SupplierStatus, now: Date): Promise<ApprovalRequest> {
  return submitForApproval(trx, {
    companyId, subject: { kind: 'supplier_status', id: record.id }, subjectVersionId: crypto.randomUUID(), subjectDigest: statusChangeDigest(record, to), amount: null,
    facts: { supplierStatus: to, categories: [...record.categories] },
  }, now);
}

/** The approved request must name this record, this change and the record exactly as it is now. */
export async function requireApprovedChange(trx: Transaction, requestId: string, record: SupplierRecordRow, to: SupplierStatus): Promise<void> {
  const request = await approvalRequests.get(trx, requestId);
  if (!request || request.subject_kind !== 'supplier_status' || request.subject_id !== record.id) throw new ApiError('access.not_found', 'no approval request for this supplier record', { reason: 'approval_not_found' });
  if (request.status !== 'approved') throw new ApiError('access.forbidden', 'the status change waits for its approval', { reason: 'approval_pending', approvalStatus: request.status });
  if (request.subject_digest !== statusChangeDigest(record, to).value) throw new ApiError('access.approval_digest_mismatch', 'the record or the change differs from what was approved', { reason: 'digest_mismatch' });
}


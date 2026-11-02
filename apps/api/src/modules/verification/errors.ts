import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';

/**
 * Refusals of the HUB-003 commands (SQLSTATE plus a hint) as contract error codes. The hint travels in
 * `details.reason`; existence never leaks (`admin.not_found` is `access.not_found`).
 */
const FORBIDDEN = new Set(['admin.forbidden', 'admin.elevation_required', 'access.no_principal']);
const CONFLICT = new Set(['verification.revision_conflict', 'verification.invalid_transition']);
const APPROVAL: Readonly<Record<string, ErrorCode>> = {
  'admin.approval_required': 'access.second_approver_required', 'admin.self_approval': 'access.second_approver_required', 'admin.not_requester': 'access.second_approver_required',
  'admin.approval_mismatch': 'access.approval_digest_mismatch', 'admin.approval_consumed': 'access.second_approver_required', 'admin.approval_not_approved': 'access.second_approver_required',
  'admin.approval_expired': 'access.second_approver_required',
};
interface PgError { code?: string; hint?: string; constraint?: string }

export function verificationRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  const hint = pg.hint ?? '';
  if (hint === 'admin.not_found') return new ApiError('access.not_found', 'access.not_found');
  if (hint === 'admin.context_invalid') return new ApiError('validation.schema', 'a staff reason is required', { reason: 'context_invalid' });
  if (hint in APPROVAL) return new ApiError(APPROVAL[hint] as ErrorCode, hint, { reason: hint.replace(/^admin\./, '') });
  const reason = hint.replace(/^(admin|access|verification)\./, '');
  if (FORBIDDEN.has(hint)) return new ApiError('access.forbidden', reason, { reason, ...(hint === 'admin.elevation_required' ? { required: 'elevation' } : hint === 'admin.forbidden' ? { required: 'permission' } : {}) });
  if (CONFLICT.has(hint)) return new ApiError('validation.revision_conflict', reason, { reason });
  if (hint.startsWith('verification.')) return new ApiError('validation.schema', reason, { reason });
  if (pg.code === '23505') return new ApiError('validation.revision_conflict', 'a conflicting record already exists', { reason: 'duplicate', constraint: pg.constraint ?? null });
  if (pg.code === '23514') return new ApiError('validation.schema', 'the record breaks a verification rule', { reason: 'constraint', constraint: pg.constraint ?? null });
  return null;
}

export function isAuthorityRefusal(refusal: ApiError): boolean {
  return ['access.forbidden', 'access.second_approver_required', 'access.approval_digest_mismatch'].includes(refusal.code);
}

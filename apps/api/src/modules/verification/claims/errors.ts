import type { ErrorCode } from '../../../deps/contracts.js';
import { ApiError } from '../../../common/errors.js';

/**
 * Refusals of the CLM-001 commands (SQLSTATE plus a hint) as contract error codes. The hint travels in `details.reason`;
 * existence never leaks (`admin.not_found` and `access.not_found` are one answer).
 */
const FORBIDDEN = new Set(['admin.forbidden', 'admin.elevation_required', 'access.no_principal', 'claims.own_claim', 'claims.verified_login_required']);
const CONFLICT = new Set(['claims.revision_conflict', 'claims.invalid_transition', 'claims.already_claiming', 'claims.already_managing', 'claims.dispute_open']);
const SECOND_PERSON: ErrorCode = 'access.second_approver_required';
interface PgError { code?: string; hint?: string; constraint?: string }

export function claimsRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  const hint = pg.hint ?? '';
  if (hint === 'admin.not_found' || hint === 'access.not_found') return new ApiError('access.not_found', 'access.not_found');
  if (hint === 'admin.context_invalid') return new ApiError('validation.schema', 'a staff reason is required', { reason: 'context_invalid' });
  const reason = hint.replace(/^(admin|access|claims)\./, '');
  if (hint === 'claims.second_person_required') return new ApiError(SECOND_PERSON, reason, { reason });
  if (FORBIDDEN.has(hint)) return new ApiError('access.forbidden', reason, { reason, ...(hint === 'admin.elevation_required' ? { required: 'elevation' } : hint === 'admin.forbidden' ? { required: 'permission' } : {}) });
  if (CONFLICT.has(hint)) return new ApiError('validation.revision_conflict', reason, { reason });
  if (hint.startsWith('claims.')) return new ApiError('validation.schema', reason, { reason });
  if (pg.code === '23505') return new ApiError('validation.revision_conflict', 'a conflicting record already exists', { reason: 'duplicate', constraint: pg.constraint ?? null });
  if (pg.code === '23514') return new ApiError('validation.schema', 'the record breaks a claim rule', { reason: 'constraint', constraint: pg.constraint ?? null });
  return null;
}

export function isAuthorityRefusal(refusal: ApiError): boolean {
  return ['access.forbidden', SECOND_PERSON].includes(refusal.code);
}

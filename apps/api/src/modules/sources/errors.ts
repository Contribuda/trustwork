import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';

/**
 * Refusals of the SRC-001 and DATA-002 commands (SQLSTATE plus a hint) as contract error codes. The hint travels in
 * `details.reason` (an English machine code; the console explains it from the `sources` locale namespace, key
 * `sources.refusal.<reason>`). Existence never leaks: `admin.not_found` is `access.not_found`.
 */
const FORBIDDEN = new Set(['admin.forbidden', 'admin.elevation_required', 'access.no_principal', 'sources.self_activation', 'sources.self_review']);
const CONFLICT = new Set([
  'sources.revision_conflict', 'sources.batch_decided', 'sources.item_decided', 'sources.link_decided', 'sources.invalid_transition', 'sources.source_closed', 'sources.taken_down',
  'sources.source_not_active', 'sources.batch_not_activated', 'sources.fresh_check_required',
]);
const APPROVAL: Readonly<Record<string, ErrorCode>> = {
  'admin.self_approval': 'access.second_approver_required',
  'admin.approval_required': 'access.approval_required',
  'admin.approval_expired': 'access.approval_required',
  'admin.approval_consumed': 'access.approval_required',
  'admin.approval_not_approved': 'access.approval_required',
  'admin.not_requester': 'access.approval_required',
  'admin.approval_mismatch': 'access.approval_digest_mismatch',
};

interface PgError { code?: string; hint?: string; constraint?: string }

/** The contract error for a database refusal, or null when the error is not one of these refusals. */
export function sourcesRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  const hint = pg.hint ?? '';
  if (hint === 'admin.not_found') return new ApiError('access.not_found', 'access.not_found');
  if (hint === 'admin.context_invalid') return new ApiError('validation.schema', 'a staff reason is required', { reason: 'context_invalid' });
  if (hint in APPROVAL) return new ApiError(APPROVAL[hint] as ErrorCode, hint, { reason: hint.replace(/^admin\./, '') });
  const reason = hint.replace(/^(admin|access|sources|validation)\./, '');
  if (FORBIDDEN.has(hint)) {
    return new ApiError('access.forbidden', reason, { reason, ...(hint === 'admin.elevation_required' ? { required: 'elevation' } : hint === 'admin.forbidden' ? { required: 'permission' } : {}) });
  }
  if (CONFLICT.has(hint)) return new ApiError('validation.revision_conflict', reason, { reason });
  if (hint.startsWith('sources.') || hint === 'validation.not_canonicalizable') return new ApiError('validation.schema', reason, { reason });
  if (pg.code === '23503') return new ApiError('validation.schema', 'a referenced record does not exist', { reason: 'unknown_reference' });
  if (pg.code === '23505') return new ApiError('validation.revision_conflict', 'a conflicting record already exists', { reason: 'duplicate', constraint: pg.constraint ?? null });
  if (pg.code === '23514') return new ApiError('validation.schema', 'the record breaks a registry rule', { reason: 'constraint', constraint: pg.constraint ?? null });
  return null;
}

/** Refusals of authority that are recorded as `denied` audit rows (not shape errors or missing objects). */
export function isAuthorityRefusal(refusal: ApiError): boolean {
  return ['access.forbidden', 'access.second_approver_required', 'access.approval_required', 'access.approval_digest_mismatch'].includes(refusal.code);
}

import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';

/**
 * Refusals of the DATA-002 commands (SQLSTATE plus an `admin.*` hint) as contract error codes. The hint travels in
 * `details.reason` (an English machine code, never a value), so the console can show the specific explanation from its
 * locale files. Existence never leaks: every `admin.not_found` is `access.not_found`.
 */
const HINTS: Readonly<Record<string, { code: ErrorCode; required?: string }>> = {
  'admin.not_found': { code: 'access.not_found' },
  'admin.forbidden': { code: 'access.forbidden', required: 'permission' },
  'admin.elevation_required': { code: 'access.forbidden', required: 'elevation' },
  'admin.conflict_of_interest': { code: 'access.forbidden' },
  'admin.sanction_level_not_allowed': { code: 'access.forbidden', required: 'permission' },
  'admin.self_grant': { code: 'access.forbidden' },
  'admin.self_approval': { code: 'access.second_approver_required' },
  'admin.same_decider': { code: 'access.second_approver_required' },
  'admin.approval_required': { code: 'access.approval_required' },
  'admin.approval_expired': { code: 'access.approval_required' },
  'admin.approval_consumed': { code: 'access.approval_required' },
  'admin.approval_not_approved': { code: 'access.approval_required' },
  'admin.not_requester': { code: 'access.approval_required' },
  'admin.approval_mismatch': { code: 'access.approval_digest_mismatch' },
  'access.approval_digest_mismatch': { code: 'access.approval_digest_mismatch' },
  'admin.grant_mismatch': { code: 'access.approval_digest_mismatch' },
  'admin.approval_not_pending': { code: 'validation.revision_conflict' },
  'admin.grant_not_requested': { code: 'validation.revision_conflict' },
  'admin.invalid_transition': { code: 'validation.revision_conflict' },
  'admin.case_closed': { code: 'validation.revision_conflict' },
  'admin.incident_not_open': { code: 'validation.revision_conflict' },
  'admin.context_invalid': { code: 'validation.schema' },
  'admin.role_scope': { code: 'validation.schema' },
  'admin.breakglass_too_long': { code: 'validation.schema' },
  'admin.grant_too_long': { code: 'validation.schema' },
  'admin.approval_too_long': { code: 'validation.schema' },
  'admin.unknown_action': { code: 'validation.schema' },
  'admin.sod_conflict': { code: 'validation.schema' },
  'admin.case_mismatch': { code: 'validation.schema' },
  'admin.report_mismatch': { code: 'validation.schema' },
  'admin.assignee_invalid': { code: 'validation.schema' },
  'admin.immutable': { code: 'validation.schema' },
  'admin.bootstrap_closed': { code: 'validation.schema' },
  'admin.appeal_kind_not_supported': { code: 'validation.schema' },
  'validation.not_canonicalizable': { code: 'validation.not_canonicalizable' },
};

interface PgError { code?: string; hint?: string }

/** The contract error for a database refusal, or null when the error is not an administration refusal. */
export function adminRefusal(error: unknown): ApiError | null {
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  // A role without a released definition, an unknown hub or person: the reference does not exist.
  if (pg.code === '23503') return new ApiError('validation.schema', 'validation.schema', { reason: 'unknown_reference' });
  if (typeof pg.hint !== 'string') return null;
  const mapped = HINTS[pg.hint];
  if (!mapped) return null;
  const reason = pg.hint.replace(/^(admin|access|validation)\./, '');
  return new ApiError(mapped.code, mapped.code, { reason, ...(mapped.required ? { required: mapped.required } : {}) });
}

/** True for refusals that are worth a `denied` audit row (authority refusals, not shape errors or missing objects). */
export function isAuthorityRefusal(error: unknown): boolean {
  const refusal = error instanceof ApiError ? error : adminRefusal(error);
  return refusal !== null && ['access.forbidden', 'access.second_approver_required', 'access.approval_required', 'access.approval_digest_mismatch'].includes(refusal.code);
}

export function rethrowAdmin(error: unknown): never {
  throw adminRefusal(error) ?? error;
}

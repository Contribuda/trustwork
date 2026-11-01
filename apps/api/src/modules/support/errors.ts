import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';

/**
 * Refusals of the support commands (SQLSTATE plus a `support.*`, `admin.*` or `second_factor.*` hint) as contract error
 * codes. The hint travels in `details.reason` as an English machine code, never a value, so the console explains it
 * from its locale files. Existence never leaks: every "not found" is `access.not_found`.
 */
const HINTS: Readonly<Record<string, { code: ErrorCode; required?: string }>> = {
  'admin.not_found': { code: 'access.not_found' },
  'access.no_principal': { code: 'auth.session_invalid' },
  'admin.forbidden': { code: 'access.forbidden', required: 'permission' },
  'admin.elevation_required': { code: 'access.forbidden', required: 'elevation' },
  'admin.conflict_of_interest': { code: 'access.forbidden' },
  'admin.not_requester': { code: 'access.forbidden' },
  'admin.self_approval': { code: 'access.second_approver_required' },
  'admin.approval_required': { code: 'access.approval_required' },
  'admin.approval_expired': { code: 'access.approval_required' },
  'admin.approval_consumed': { code: 'access.approval_required' },
  'admin.approval_not_approved': { code: 'access.approval_required' },
  'admin.approval_mismatch': { code: 'access.approval_digest_mismatch' },
  'support.cooling_off': { code: 'access.forbidden' },
  'support.evidence_required': { code: 'validation.schema' },
  'support.case_required': { code: 'validation.schema' },
  'support.address_unavailable': { code: 'validation.schema' },
  'support.nothing_to_verify': { code: 'validation.revision_conflict' },
  'support.rate_limited': { code: 'validation.revision_conflict' },
  'support.reset_open': { code: 'validation.revision_conflict' },
  'admin.invalid_transition': { code: 'validation.revision_conflict' },
  'admin.case_closed': { code: 'validation.revision_conflict' },
  'admin.case_mismatch': { code: 'validation.schema' },
  'admin.context_invalid': { code: 'validation.schema' },
  'admin.unknown_action': { code: 'validation.schema' },
  'admin.assignee_invalid': { code: 'validation.schema' },
  'admin.immutable': { code: 'validation.schema' },
  'second_factor.reset_state': { code: 'validation.revision_conflict' },
  'second_factor.reset_cooling_off': { code: 'access.forbidden' },
  'second_factor.reset_not_found': { code: 'access.not_found' },
  'second_factor.reset_second_person': { code: 'access.second_approver_required' },
  'validation.not_canonicalizable': { code: 'validation.not_canonicalizable' },
};

interface PgError { code?: string; hint?: string; constraint?: string }

/** The contract error for a database refusal, or null when the error is not a support refusal. */
export function supportRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  if (pg.code === '23505' && pg.constraint === 'account_service_action_one_open') return new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'action_open' });
  if (pg.code === '23503') return new ApiError('validation.schema', 'validation.schema', { reason: 'unknown_reference' });
  if (typeof pg.hint !== 'string') return null;
  const mapped = HINTS[pg.hint];
  if (!mapped) return null;
  const reason = pg.hint.replace(/^(admin|access|support|second_factor|validation)\./, '');
  return new ApiError(mapped.code, mapped.code, { reason, ...(mapped.required ? { required: mapped.required } : {}) });
}

export function rethrowSupport(error: unknown): never {
  throw supportRefusal(error) ?? error;
}

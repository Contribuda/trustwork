import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { SecretStoreError } from './secret-store.js';

/**
 * Refusals of the KEYS-001 and DATA-002 commands (SQLSTATE plus a hint) as contract error codes. The reason travels in
 * `details.reason` (an English machine code the console explains from `providers.reasons.<code>`) and refused places in
 * `details.items`. Existence never leaks: `admin.not_found` is `access.not_found`. This module never imports
 * platform-admin, so the administration hints it meets are listed here too.
 */
const HINTS: Readonly<Record<string, ErrorCode>> = {
  'admin.not_found': 'access.not_found',
  'admin.forbidden': 'access.forbidden',
  'admin.elevation_required': 'access.forbidden',
  'access.no_principal': 'access.forbidden',
  'admin.self_approval': 'access.second_approver_required',
  'admin.approval_required': 'access.approval_required',
  'admin.approval_expired': 'access.approval_required',
  'admin.approval_consumed': 'access.approval_required',
  'admin.approval_not_approved': 'access.approval_required',
  'admin.not_requester': 'access.approval_required',
  'admin.approval_mismatch': 'access.approval_digest_mismatch',
  'admin.context_invalid': 'validation.schema',
  'admin.immutable': 'validation.schema',
  'admin.invalid_transition': 'validation.revision_conflict',
  'validation.not_canonicalizable': 'validation.not_canonicalizable',
  'providers.drafter_cannot_activate': 'access.second_approver_required',
  'providers.revision_conflict': 'validation.revision_conflict',
  'providers.invalid_transition': 'validation.revision_conflict',
  'providers.kill_engaged': 'validation.revision_conflict',
  'providers.kill_not_engaged': 'validation.revision_conflict',
  'providers.decision_unknown': 'access.not_found',
};

interface PgError { code?: string; hint?: string; detail?: string; constraint?: string }

/** The contract error for a refusal, or null when the error is not one of them. */
export function providersRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof SecretStoreError) {
    return new ApiError('validation.schema', 'the secret store cannot serve this request', { reason: error.code === 'unconfigured' ? 'secret_store_unconfigured' : error.code === 'unreadable' || error.code === 'kek_mismatch' ? 'secret_unreadable' : 'secret_not_found' });
  }
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  if (pg.code === '23503') return new ApiError('validation.schema', 'validation.schema', { reason: 'unknown_reference' });
  if (pg.code === '22003') return new ApiError('validation.schema', 'validation.schema', { reason: 'out_of_range' });
  if (pg.code === '23505' && !pg.hint) return new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'duplicate' });
  if (pg.code === '23514' && !pg.hint) return new ApiError('validation.schema', 'validation.schema', { reason: 'constraint', constraint: pg.constraint ?? null });
  if (typeof pg.hint !== 'string') return null;
  const code = HINTS[pg.hint] ?? (pg.hint.startsWith('providers.') ? 'validation.schema' : undefined);
  if (!code) return null;
  const reason = pg.hint.replace(/^(admin|access|validation|providers)\./, '');
  const items = pg.detail ? pg.detail.split(',').filter(Boolean) : undefined;
  return new ApiError(code, code, { reason, ...(items ? { items } : {}), ...(pg.hint === 'admin.elevation_required' ? { required: 'elevation' } : pg.hint === 'admin.forbidden' ? { required: 'permission' } : {}) });
}

/** Refusals of authority that are recorded as `denied` audit rows (not shape errors or missing objects). */
export function isAuthorityRefusal(refusal: ApiError): boolean {
  return ['access.forbidden', 'access.second_approver_required', 'access.approval_required', 'access.approval_digest_mismatch'].includes(refusal.code);
}

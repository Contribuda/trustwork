import { ZodError } from 'zod';
import { ErrorCodeSchema, errorEnvelope, httpStatusFor, type ErrorCode, type ErrorEnvelope } from '../deps/contracts.js';
import { PrincipalError } from '../deps/data.js';

/** Application error carrying a frozen contract code; the filter renders the envelope and the fixed HTTP status. */
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string = code, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
  }
  get status(): number {
    return httpStatusFor(this.code);
  }
}

/**
 * Codes not yet in the frozen contract (requested from FND-002): `internal.error` for unexpected failures and
 * `auth.email_taken` for an e-mail change to an address that is already bound. The body keeps the envelope shape.
 */
export type LocalErrorCode = 'internal.error' | 'auth.email_taken' | 'jurisdiction.restricted' | 'auth.jurisdiction_hold'
  | 'screening.review_pending' | 'screening.unavailable' | 'commercial.counterparty_unavailable';
/**
 * `jurisdiction.restricted` and `auth.jurisdiction_hold` are the gate's codes (SANC-001, `JURISDICTION_ERROR_STATUS`);
 * `screening.review_pending`, `screening.unavailable` and `commercial.counterparty_unavailable` are the money and
 * commitment gates' codes (SANC-004, `SCREENING_GATE_ERROR_STATUS`).
 */
const LOCAL_STATUS: Record<LocalErrorCode, number> = {
  'internal.error': 500, 'auth.email_taken': 409, 'jurisdiction.restricted': 451, 'auth.jurisdiction_hold': 403,
  'screening.review_pending': 403, 'screening.unavailable': 409, 'commercial.counterparty_unavailable': 409,
};
export class LocalApiError extends Error {
  constructor(readonly code: LocalErrorCode, message: string = code, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'LocalApiError';
  }
  get status(): number {
    return LOCAL_STATUS[this.code];
  }
}
export interface RenderedError { status: number; body: ErrorEnvelope | { code: LocalErrorCode; message: string; details?: Record<string, unknown>; requestId: string } }

/** Database hints raised by SECURITY DEFINER commands and triggers, mapped to contract codes. */
const HINT_CODES: Record<string, ErrorCode> = {
  'membership.permission_missing': 'membership.permission_missing',
  'membership.last_administrator': 'membership.last_administrator',
  'membership.ended': 'membership.ended',
  'membership.activation_not_authorised': 'access.forbidden',
  'membership.self_promotion': 'access.forbidden',
  'membership.invalid_transition': 'validation.schema',
  'membership.immutable_parties': 'validation.schema',
  'access.self_amplification': 'access.forbidden',
  'access.immutable_parties': 'validation.schema',
  'access.revocation_final': 'validation.schema',
  'projects.transfer_consent_required': 'commercial.transfer_consent_pending',
  'projects.transfer_not_authorised': 'access.not_found',
  'projects.transfer_expired': 'commercial.transfer_consent_pending',
  'projects.transfer_consent_not_recipient': 'access.forbidden',
  'projects.transfer_withdraw_not_proposer': 'access.forbidden',
  'projects.transfer_apply_required': 'validation.schema',
  'projects.invalid_transfer_transition': 'validation.schema',
  'projects.transfer_immutable': 'validation.schema',
  'audit.append_only': 'validation.schema',
};

interface PgError { code?: string; hint?: string; constraint?: string; message?: string }

/** Converts any thrown value into the rendered error; secrets and SQL text never reach the body. */
export function renderError(error: unknown, requestId: string): RenderedError {
  if (error instanceof ApiError) {
    return { status: error.status, body: errorEnvelope(error.code, requestId, error.message, error.details) };
  }
  if (error instanceof LocalApiError) return { status: error.status, body: error.details ? { code: error.code, message: error.message, details: error.details, requestId } : { code: error.code, message: error.message, requestId } };
  if (error instanceof ZodError) {
    const unknown = error.issues.find((i) => i.code === 'unrecognized_keys');
    const code: ErrorCode = unknown ? 'validation.unknown_field' : 'validation.schema';
    const issues = error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), code: i.code }));
    return { status: httpStatusFor(code), body: errorEnvelope(code, requestId, 'request does not match the contract schema', { issues }) };
  }
  if (error instanceof PrincipalError) {
    if (error.code === 'access.stale_epoch') return { status: 409, body: errorEnvelope('validation.revision_conflict', requestId, 'authorization changed during the request; retry') };
    return { status: 401, body: errorEnvelope('auth.session_invalid', requestId, 'no valid principal') };
  }
  const pg = error as PgError;
  if (pg && typeof pg.code === 'string') {
    if (pg.hint && HINT_CODES[pg.hint]) {
      const code = HINT_CODES[pg.hint] as ErrorCode;
      return { status: httpStatusFor(code), body: errorEnvelope(code, requestId, code, { hint: pg.hint }) };
    }
    if (pg.code === '28000') return { status: 401, body: errorEnvelope('auth.session_invalid', requestId, 'no valid principal') };
    if (pg.code === '23505' && pg.constraint === 'membership_one_active_employer') return { status: 409, body: errorEnvelope('membership.already_employed', requestId, 'membership.already_employed') };
    if (pg.code === '23505' && pg.constraint === 'email_binding_email_normalized_key') return { status: 409, body: { code: 'auth.email_taken', message: 'this e-mail address is already bound to an account', requestId } };
    if (pg.code === '23505' && pg.constraint === 'credential_provider_subject') return { status: 409, body: errorEnvelope('auth.provider.already_linked', requestId, 'auth.provider.already_linked') };
    if (pg.code === '23505') return { status: 409, body: errorEnvelope('validation.revision_conflict', requestId, 'a conflicting record already exists', { constraint: pg.constraint ?? null }) };
    if (pg.code === '42501') return { status: 403, body: errorEnvelope('access.forbidden', requestId, 'access.forbidden') };
    if (pg.code === '22P02' || pg.code === '23514' || pg.code === '23000') return { status: 422, body: errorEnvelope('validation.schema', requestId, 'request rejected by a database constraint') };
  }
  return { status: 500, body: { code: 'internal.error', message: 'internal error', requestId } };
}

export function isErrorCode(value: string): value is ErrorCode {
  return ErrorCodeSchema.safeParse(value).success;
}

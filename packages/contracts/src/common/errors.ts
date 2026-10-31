import { z } from 'zod';
import { RequestIdSchema } from './ids.js';

/**
 * Stable English machine codes. The web maps a code to the locale key `ru.error.<code>`; contracts carry no Russian text.
 * Namespaces: auth.*, access.*, commercial.*, membership.*, validation.*.
 */
export const ERROR_CODES = [
  'auth.invalid_credentials',
  'auth.throttled',
  'auth.step_up_required',
  'auth.email_unverified',
  'auth.session_invalid',
  'auth.csrf_rejected',
  'auth.password.rejected',
  'auth.provider.already_linked',
  'auth.provider.state_mismatch',
  'auth.recovery.on_hold',
  'access.not_found',
  'access.forbidden',
  'access.participation_expired',
  'access.mandate_revoked',
  'access.mandate_scope',
  'access.staff_no_case',
  'access.approval_required',
  'access.approval_digest_mismatch',
  'access.second_approver_required',
  'commercial.version_immutable',
  'commercial.rfq_version_not_current',
  'commercial.rfq_version_mismatch',
  'commercial.stale_version',
  'commercial.digest_mismatch',
  'commercial.totals_mismatch',
  'commercial.currency_mismatch',
  'commercial.quote_not_acceptable',
  'commercial.quote_expired',
  'commercial.budget_insufficient',
  'commercial.authority_missing',
  'commercial.outcome_unknown',
  'commercial.transfer_consent_pending',
  'membership.already_employed',
  'membership.last_administrator',
  'membership.invitation_expired',
  'membership.ended',
  'membership.permission_missing',
  'validation.schema',
  'validation.unknown_field',
  'validation.revision_conflict',
  'validation.idempotency_conflict',
  'validation.idempotency_in_progress',
  'validation.unit_mismatch',
  'validation.not_canonicalizable',
  'validation.payload_too_large',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Error envelope returned by every `/v1/*` failure. `details` never carries private values or foreign-object existence hints. */
export const ErrorEnvelopeSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(500),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: RequestIdSchema,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

const STATUS: Record<ErrorCode, number> = {
  'auth.invalid_credentials': 401,
  'auth.throttled': 429,
  'auth.step_up_required': 403,
  'auth.email_unverified': 403,
  'auth.session_invalid': 401,
  'auth.csrf_rejected': 403,
  'auth.password.rejected': 422,
  'auth.provider.already_linked': 409,
  'auth.provider.state_mismatch': 400,
  /** Recovery accepted but held (corporate-mailbox hold): a conflict with the hold policy, surfaced as 409 so clients never treat it as success. */
  'auth.recovery.on_hold': 409,
  'access.not_found': 404,
  'access.forbidden': 403,
  'access.participation_expired': 403,
  'access.mandate_revoked': 403,
  'access.mandate_scope': 403,
  'access.staff_no_case': 404,
  'access.approval_required': 403,
  'access.approval_digest_mismatch': 409,
  'access.second_approver_required': 403,
  'commercial.version_immutable': 409,
  'commercial.rfq_version_not_current': 409,
  'commercial.rfq_version_mismatch': 409,
  'commercial.stale_version': 409,
  'commercial.digest_mismatch': 409,
  'commercial.totals_mismatch': 422,
  'commercial.currency_mismatch': 422,
  'commercial.quote_not_acceptable': 409,
  'commercial.quote_expired': 409,
  'commercial.budget_insufficient': 409,
  'commercial.authority_missing': 403,
  'commercial.outcome_unknown': 409,
  'commercial.transfer_consent_pending': 409,
  'membership.already_employed': 409,
  'membership.last_administrator': 409,
  'membership.invitation_expired': 410,
  'membership.ended': 403,
  'membership.permission_missing': 403,
  'validation.schema': 422,
  'validation.unknown_field': 422,
  'validation.revision_conflict': 409,
  'validation.idempotency_conflict': 409,
  'validation.idempotency_in_progress': 409,
  'validation.unit_mismatch': 422,
  'validation.not_canonicalizable': 422,
  'validation.payload_too_large': 413,
};
export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code];
}

/** Disclosure rule: `not_found` whenever existence is not already known to the principal, otherwise `forbidden`. */
export function disclosureCode(existenceKnownToPrincipal: boolean): 'access.not_found' | 'access.forbidden' {
  return existenceKnownToPrincipal ? 'access.forbidden' : 'access.not_found';
}
export function errorEnvelope(code: ErrorCode, requestId: string, message: string = code, details?: Record<string, unknown>): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse(details ? { code, message, details, requestId } : { code, message, requestId });
}

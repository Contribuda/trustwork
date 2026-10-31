import { z } from 'zod';
import {
  DEFAULT_PASSWORD_POLICY,
  ErrorEnvelopeSchema,
  LoginCommandSchema,
  RecoveryCompleteCommandSchema,
  RecoveryRequestCommandSchema,
  SignupCommandSchema,
  errorEnvelope,
  httpStatusFor,
  type ErrorCode,
  type ErrorEnvelope,
} from '@trustwork/contracts/client';

/**
 * Fake in-memory auth adapter behind the Next route handlers (`/api/auth/*`). It validates payloads with
 * the frozen contract schemas and answers with contract error envelopes; it never creates a session,
 * an account or sends mail. The real `/v1/auth/*` API exists (BE-001) but these handlers do not call it yet;
 * WEB-004 replaces them with the live sign-up, verification, login and recovery flows.
 *
 * Field-level validation issues are reported as `details.fields[{ path, code }]` so the UI can map them
 * to localized copy in the reader's language; `details` never echoes submitted values.
 */

export type FieldIssue = { path: string; code: 'required' | 'format' | 'too_short' | 'too_long' | 'invalid' };
export type AdapterResponse = { status: number; body: ErrorEnvelope | Record<string, unknown> };

const THROTTLE_LIMIT = 5;
const THROTTLE_WINDOW_MS = 10 * 60_000;
/** The only recovery token the demo recognises (never issued anywhere; documented for the reviewer). */
export const DEMO_RECOVERY_TOKEN = 'demo-recovery-token-0001';

const attempts = new Map<string, number[]>();
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `web-fake-${Date.now().toString(36)}-${requestCounter}`;
}

function fail(code: ErrorCode, details?: Record<string, unknown>): AdapterResponse {
  return { status: httpStatusFor(code), body: errorEnvelope(code, requestId(), code, details) };
}

function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '_';
    if (issue.code === 'invalid_type' && 'received' in issue && (issue as { received?: string }).received === 'undefined') return { path, code: 'required' };
    if (issue.code === 'invalid_type') return { path, code: 'invalid' };
    if (issue.code === 'too_small') return { path, code: (issue as { minimum?: number }).minimum === 1 ? 'required' : 'too_short' };
    if (issue.code === 'too_big') return { path, code: 'too_long' };
    if (issue.code === 'invalid_format') return { path, code: 'format' };
    if (issue.code === 'unrecognized_keys') return { path, code: 'invalid' };
    return { path, code: 'invalid' };
  });
}

function validate<T>(schema: z.ZodType<T>, payload: unknown): { ok: true; value: T } | { ok: false; response: AdapterResponse } {
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, value: result.data };
  const fields = toFieldIssues(result.error);
  const unknown = result.error.issues.some((i) => i.code === 'unrecognized_keys');
  return { ok: false, response: fail(unknown ? 'validation.unknown_field' : 'validation.schema', { fields }) };
}

export const fakeAuth = {
  policy: DEFAULT_PASSWORD_POLICY,

  login(payload: unknown): AdapterResponse {
    const parsed = validate(LoginCommandSchema, payload);
    if (!parsed.ok) return parsed.response;
    const now = Date.now();
    const recent = (attempts.get(parsed.value.email) ?? []).filter((at) => now - at < THROTTLE_WINDOW_MS);
    if (recent.length >= THROTTLE_LIMIT) {
      const retryAfterSeconds = Math.ceil((THROTTLE_WINDOW_MS - (now - recent[0]!)) / 1000);
      return fail('auth.throttled', { retryAfterSeconds });
    }
    attempts.set(parsed.value.email, [...recent, now]);
    // No credentials exist in the demo store: every well-formed attempt is rejected the way a real backend would.
    return fail('auth.invalid_credentials');
  },

  signup(payload: unknown): AdapterResponse {
    const parsed = validate(SignupCommandSchema, payload);
    if (!parsed.ok) return parsed.response;
    // A real backend issues no session before e-mail verification; the demo creates nothing and sends nothing.
    return fail('auth.email_unverified', { demo: 'no_account_created' });
  },

  recoverRequest(payload: unknown): AdapterResponse {
    const parsed = validate(RecoveryRequestCommandSchema, payload);
    if (!parsed.ok) return parsed.response;
    // Neutral acknowledgement regardless of whether the address exists (never discloses accounts).
    return { status: 202, body: { accepted: true, demo: 'no_email_sent', requestId: requestId() } };
  },

  recoverReset(payload: unknown): AdapterResponse {
    const parsed = validate(RecoveryCompleteCommandSchema, payload);
    if (!parsed.ok) {
      const envelope = parsed.response.body as ErrorEnvelope;
      const fields = (envelope.details?.fields as FieldIssue[] | undefined) ?? [];
      if (fields.some((f) => f.path === 'newPassword')) return fail('auth.password.rejected', { fields: fields.filter((f) => f.path === 'newPassword'), minLength: DEFAULT_PASSWORD_POLICY.minLength });
      return parsed.response;
    }
    if (parsed.value.token !== DEMO_RECOVERY_TOKEN) return fail('access.not_found');
    // The demo cannot change a password; it answers with the contract's recovery hold state instead of a fake success.
    return fail('auth.recovery.on_hold', { demo: 'no_password_changed' });
  },

  /** Token pre-check for the reset page (server side, before rendering the form). */
  tokenState(token: string): 'valid' | 'invalid' {
    return token === DEMO_RECOVERY_TOKEN ? 'valid' : 'invalid';
  },
};

export function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return ErrorEnvelopeSchema.safeParse(body).success;
}

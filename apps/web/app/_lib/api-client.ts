import type { z } from 'zod';
import { CSRF_HEADER, IDEMPOTENCY_KEY_HEADER } from '@trustwork/contracts/client';
import { withBase } from './base-path';

/**
 * Browser-side client of the live API (WEB-004). Every call goes to the same-origin `/v1/*` route (rewritten to the
 * API, see next.config.ts), so the session cookie travels with it and the browser adds `Sec-Fetch-Site: same-origin`.
 * Mutations carry the contract CSRF header `X-Trustwork-Request: 1`; authenticated mutations carry an
 * `Idempotency-Key` that the caller keeps for retries of the same submission and renews after a success.
 * Error envelopes are passed through untouched so forms map `code` and field issues to locale keys; a response that
 * is not an envelope (proxy error, API down) becomes `internal.error`, never a raw status or message.
 */
export type FieldIssueCode = 'required' | 'format' | 'too_short' | 'too_long' | 'invalid';
export type FieldIssue = { path: string; code: FieldIssueCode };
export type ErrorEnvelopeLike = { code: string; message: string; details?: Record<string, unknown>; requestId: string };
export type ApiResult = { kind: 'ok'; status: number; body: Record<string, unknown> } | { kind: 'error'; status: number; error: ErrorEnvelopeLike } | { kind: 'network' };

/** A fresh key for one logical submission (retries of the same submission reuse it). */
export function newIdempotencyKey(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-${random}`;
}

export interface PostOptions {
  /** Required by the API on authenticated mutations; omit for the pre-session auth routes. */
  idempotencyKey?: string;
}

export async function postJson(path: `/v1/${string}`, payload: Record<string, unknown> | null, options: PostOptions = {}): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: 'application/json', [CSRF_HEADER]: '1' };
  if (payload !== null) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  try {
    const response = await fetch(withBase(path), { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store', ...(payload !== null ? { body: JSON.stringify(payload) } : {}) });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (response.ok) return { kind: 'ok', status: response.status, body };
    if (typeof body.code === 'string' && typeof body.requestId === 'string') return { kind: 'error', status: response.status, error: body as unknown as ErrorEnvelopeLike };
    return { kind: 'error', status: response.status, error: { code: 'internal.error', message: 'unexpected response', requestId: 'none' } };
  } catch {
    return { kind: 'network' };
  }
}

/** Zod issue codes (client validation and the API's `details.issues`) mapped to the field codes the forms translate. */
function fieldCode(issue: { code: string; minimum?: unknown; input?: unknown }): FieldIssueCode {
  if (issue.code === 'invalid_type') return issue.input === undefined ? 'required' : 'invalid';
  if (issue.code === 'too_small') return issue.minimum === 1 ? 'required' : 'too_short';
  if (issue.code === 'too_big') return 'too_long';
  if (issue.code === 'invalid_format') return 'format';
  return 'invalid';
}

/**
 * Validates a command against its frozen contract schema in the browser before it is sent, so field errors appear
 * without a round trip. The same schema runs again on the server; this is a convenience, never the check.
 */
export function validateCommand<T>(schema: z.ZodType<T>, payload: unknown): { ok: true; value: T } | { ok: false; error: ErrorEnvelopeLike } {
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, value: result.data };
  const fields = result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.') || '_', code: fieldCode(issue as { code: string; minimum?: unknown; input?: unknown }) }));
  const unknown = result.error.issues.some((i) => i.code === 'unrecognized_keys');
  return { ok: false, error: { code: unknown ? 'validation.unknown_field' : 'validation.schema', message: 'client validation', details: { fields }, requestId: 'client' } };
}

/** Field issues of an envelope: client validation (`details.fields`) or the API's schema failure (`details.issues`). */
export function fieldIssues(error: ErrorEnvelopeLike): FieldIssue[] {
  const fields = error.details?.fields;
  if (Array.isArray(fields)) return fields as FieldIssue[];
  const issues = error.details?.issues;
  if (Array.isArray(issues)) {
    return issues
      .filter((i): i is { path: string; code: string } => !!i && typeof (i as { path?: unknown }).path === 'string' && typeof (i as { code?: unknown }).code === 'string')
      .map((i) => ({ path: i.path || '_', code: fieldCode({ code: i.code }) }));
  }
  // Directory handle problems answer `validation.schema` with `{ field, reason }` (BE-003).
  const field = error.details?.field;
  if (typeof field === 'string') return [{ path: field, code: 'invalid' }];
  return [];
}

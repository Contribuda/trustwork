/**
 * Browser-side helper for the auth route handlers: posts JSON with the contract CSRF header and
 * returns either the parsed body or a network failure. Error envelopes are passed through untouched so
 * forms map `code` + `details.fields` to locale keys.
 */
export type FieldIssue = { path: string; code: 'required' | 'format' | 'too_short' | 'too_long' | 'invalid' };
export type ErrorEnvelopeLike = { code: string; message: string; details?: Record<string, unknown>; requestId: string };
export type ApiResult = { kind: 'ok'; status: number; body: Record<string, unknown> } | { kind: 'error'; status: number; error: ErrorEnvelopeLike } | { kind: 'network' };

import { withBase } from './base-path';

export async function postJson(url: string, payload: Record<string, unknown>): Promise<ApiResult> {
  try {
    const response = await fetch(withBase(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Trustwork-Request': '1' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { kind: 'ok', status: response.status, body };
    if (typeof body.code === 'string' && typeof body.requestId === 'string') return { kind: 'error', status: response.status, error: body as unknown as ErrorEnvelopeLike };
    return { kind: 'error', status: response.status, error: { code: 'validation.schema', message: 'unexpected', requestId: 'none' } };
  } catch {
    return { kind: 'network' };
  }
}

export function fieldIssues(error: ErrorEnvelopeLike): FieldIssue[] {
  const fields = error.details?.fields;
  return Array.isArray(fields) ? (fields as FieldIssue[]) : [];
}

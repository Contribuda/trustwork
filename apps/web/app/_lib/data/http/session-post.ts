import { CSRF_HEADER, IDEMPOTENCY_KEY_HEADER } from '@trustwork/contracts/client';
import { apiOrigin } from './config';
import { SESSION_COOKIE_NAMES } from './transport';

export type SessionPostAnswer = { status: number; code: string | null; body: unknown };

/**
 * A mutation from a server action: the visitor's session cookie, the CSRF header, the browser's own `Origin` (the API's
 * CSRF guard compares it with its public origin; a server action is same-origin by construction) and the idempotency
 * key. It never rejects for an HTTP answer. Network failures and timeouts answer 503, which the caller shows as an
 * error. Pages that use it need no client JavaScript for the form.
 */
export async function sessionPost(path: `/v1/${string}`, body: Record<string, unknown>, idempotencyKey: string): Promise<SessionPostAnswer> {
  const { cookies, headers } = await import('next/headers');
  const session = (await cookies()).getAll().filter((c) => (SESSION_COOKIE_NAMES as readonly string[]).includes(c.name) && c.value);
  const origin = (await headers()).get('origin');
  const send: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', [CSRF_HEADER]: '1', [IDEMPOTENCY_KEY_HEADER]: idempotencyKey };
  if (session.length) send.cookie = session.map((c) => `${c.name}=${c.value}`).join('; ');
  if (origin) send.origin = origin;
  try {
    const response = await fetch(`${apiOrigin()}${path}`, { method: 'POST', headers: send, body: JSON.stringify(body), cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const envelope = (await response.json().catch(() => null)) as { code?: unknown } | null;
    return { status: response.status, code: typeof envelope?.code === 'string' ? envelope.code : null, body: envelope };
  } catch {
    return { status: 503, code: null, body: null };
  }
}

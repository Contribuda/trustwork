import { SESSION_COOKIE } from '@trustwork/contracts/client';
import { apiOrigin } from './config';

/**
 * Server-side transport of the live API adapter: `GET /v1/*` against the API origin with the visitor's session
 * cookie, `Cache-Control: no-store`, a bounded timeout and the contract error envelope. Mutations never go through
 * here: the browser sends them to the same-origin `/v1/*` route (rewritten to the API), where the CSRF header,
 * fetch metadata and `Idempotency-Key` are checked against the visitor's own request.
 */

/** Session cookie names the API may use: `__Host-sr_session`, or `sr_session` on plain-HTTP development hosts. */
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE, SESSION_COOKIE.replace('__Host-', '')] as const;

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId: string | null) {
    super(`API ${status} ${code}`);
    this.name = 'ApiFailure';
  }
}

export type CookieSource = () => Promise<Array<{ name: string; value: string }>>;
export type FetchLike = (input: string, init: { method: 'GET'; headers: Record<string, string>; cache: 'no-store'; signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface Transport {
  /**
   * Parsed JSON body of a 2xx answer, `null` for 404 `access.not_found`; every other answer throws `ApiFailure`.
   * `anonymous` reads send no cookie at all (public pages render exactly what every visitor sees).
   */
  get(path: `/v1/${string}`, options?: { anonymous?: boolean }): Promise<unknown | null>;
  /** Whether the visitor's request carries a session cookie at all (an invalid one included). */
  hasSession(): Promise<boolean>;
}

export interface TransportOptions {
  origin?: () => string;
  fetch?: FetchLike;
  cookies?: CookieSource;
  timeoutMs?: number;
}

/** Cookies of the current request (Next server components and route handlers). */
async function requestCookies(): Promise<Array<{ name: string; value: string }>> {
  const { cookies } = await import('next/headers');
  return (await cookies()).getAll();
}

export function createTransport(options: TransportOptions = {}): Transport {
  const origin = options.origin ?? (() => apiOrigin());
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const cookieSource = options.cookies ?? requestCookies;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function sessionCookies(): Promise<string | null> {
    const all = await cookieSource();
    const forwarded = all.filter((c) => (SESSION_COOKIE_NAMES as readonly string[]).includes(c.name) && c.value);
    return forwarded.length ? forwarded.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  }

  return {
    async get(path, getOptions = {}) {
      const headers: Record<string, string> = { accept: 'application/json' };
      const cookie = getOptions.anonymous ? null : await sessionCookies();
      if (cookie) headers.cookie = cookie;
      const response = await doFetch(`${origin()}${path}`, { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      const body = await response.json().catch(() => null);
      if (response.status >= 200 && response.status < 300) return body;
      const envelope = body && typeof body === 'object' ? (body as { code?: unknown; requestId?: unknown }) : {};
      const code = typeof envelope.code === 'string' ? envelope.code : 'internal.error';
      if (response.status === 404 && code === 'access.not_found') return null;
      throw new ApiFailure(response.status, code, typeof envelope.requestId === 'string' ? envelope.requestId : null);
    },
    async hasSession() {
      return (await sessionCookies()) !== null;
    },
  };
}

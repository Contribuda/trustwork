import { CSRF_HEADER, IDEMPOTENCY_KEY_HEADER } from '@trustwork/contracts/client';
import { apiOrigin } from '@/app/_lib/data/http/config';
import { createTransport, SESSION_COOKIE_NAMES } from '@/app/_lib/data/http/transport';
import { siteUrl } from '@/app/_lib/site';
import { createApiConsolePort, type ConsoleApi } from './api-adapter';
import { consolePort as choose } from './index';
import type { ConsoleDataPort } from './port';

/** Engine version shown on the node card (apps/web/package.json). */
const ENGINE_VERSION = '0.1.0';

let live: ConsoleDataPort | null = null;

/**
 * A staff mutation from a server action: the visitor's session cookie, the CSRF header, the browser's own `Origin`
 * (the API's CSRF guard compares it with its public origin; a server action is same-origin by construction) and the
 * idempotency key. Network failures and timeouts answer 503, which the console shows as an error.
 */
async function post(path: `/v1/${string}`, body: Record<string, unknown>, idempotencyKey: string): Promise<{ status: number; code: string | null }> {
  const { cookies, headers } = await import('next/headers');
  const session = (await cookies()).getAll().filter((c) => (SESSION_COOKIE_NAMES as readonly string[]).includes(c.name) && c.value);
  const origin = (await headers()).get('origin');
  const send: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', [CSRF_HEADER]: '1', [IDEMPOTENCY_KEY_HEADER]: idempotencyKey };
  if (session.length) send.cookie = session.map((c) => `${c.name}=${c.value}`).join('; ');
  if (origin) send.origin = origin;
  try {
    const response = await fetch(`${apiOrigin()}${path}`, { method: 'POST', headers: send, body: JSON.stringify(body), cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const envelope = (await response.json().catch(() => null)) as { code?: unknown } | null;
    return { status: response.status, code: typeof envelope?.code === 'string' ? envelope.code : null };
  } catch {
    return { status: 503, code: null };
  }
}

/**
 * The console's adapter for this server process (HUBC-007): demo mode serves the synthetic fixtures; live mode reads
 * the API with the visitor's session cookie and sends the wired commands. The site host is read when a page renders
 * (CFG-001).
 */
export function consolePort(demoEnabled: boolean): ConsoleDataPort {
  if (!live) {
    const transport = createTransport();
    const api: ConsoleApi = { get: (path) => transport.get(path), post };
    live = createApiConsolePort({ api, siteHost: () => new URL(siteUrl()).hostname, engineVersion: ENGINE_VERSION });
  }
  return choose(demoEnabled, live);
}

export type * from './port';

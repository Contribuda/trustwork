import { SETUP_TOKEN_HEADER, SetupViewSchema, type SetupView } from '../../../../../../packages/contracts/src/hub-setup.js';
import { apiOrigin } from '@/app/_lib/data/http/config';
import { SESSION_COOKIE_NAMES } from '@/app/_lib/data/http/transport';

/**
 * Live setup wizard (HUB-004): the server-side read of `GET /v1/setup` with the one-time token in its header and the
 * visitor's session cookie (once the founding administrator is signed in). Null for an unknown, expired or used token,
 * after setup finished, or when the API cannot be reached: the wizard then renders "not found", like the demo.
 */
export async function readSetupView(token: string): Promise<SetupView | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { cookies } = await import('next/headers');
  const session = (await cookies()).getAll().filter((c) => (SESSION_COOKIE_NAMES as readonly string[]).includes(c.name) && c.value);
  const headers: Record<string, string> = { accept: 'application/json', [SETUP_TOKEN_HEADER]: token };
  if (session.length) headers.cookie = session.map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    const response = await fetch(`${apiOrigin()}/v1/setup`, { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (response.status !== 200) return null;
    const parsed = SetupViewSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

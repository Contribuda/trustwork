import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@trustwork/contracts/client';
import { data, type AuthenticatedPrincipal, type Principal } from './data';
import { LIVE_CONTEXT, demoModeEnabled, resolveDemoContext, withDemo, type DemoContext, type SearchParamsInput } from './persona';

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Session cookie names the API may set (`__Host-sr_session`, or `sr_session` on plain-HTTP development hosts). */
const SESSION_COOKIES = [SESSION_COOKIE, SESSION_COOKIE.replace('__Host-', '')];

/**
 * Resolves the request principal. Demo mode: the persona from the search params (pages only; layouts cannot read
 * the URL). Live mode (WEB-004): the API session behind the visitor's cookie; the search params are never read, so
 * `?persona=` cannot change who the visitor is.
 */
export async function getPrincipal(searchParams: PageSearchParams | SearchParamsInput | undefined): Promise<Principal> {
  if (!demoModeEnabled()) {
    const person = await data.principalFor(LIVE_CONTEXT);
    return person ?? { kind: 'anonymous', persona: 'anonymous', demo: LIVE_CONTEXT };
  }
  const params = searchParams instanceof Promise ? await searchParams : searchParams;
  const demo = resolveDemoContext(params, undefined, true);
  const person = await data.principalFor(demo);
  return person ?? { kind: 'anonymous', persona: 'anonymous', demo: { ...demo, persona: 'anonymous' } };
}

/** Whether the visitor sent a session cookie (live mode): an anonymous result then means the session has ended. */
async function hadSession(): Promise<boolean> {
  const jar = await cookies();
  return SESSION_COOKIES.some((name) => Boolean(jar.get(name)?.value));
}

/**
 * Workspace gate: anonymous visitors are sent to `/login?next=` (with `reason=expired` when a live session cookie
 * was present but is no longer valid); the demo scenario `error` throws so error boundaries render.
 */
export async function requirePrincipal(searchParams: PageSearchParams | undefined, nextPath: string): Promise<AuthenticatedPrincipal> {
  const principal = await getPrincipal(searchParams);
  if (principal.kind !== 'person') {
    const expired = !demoModeEnabled() && (await hadSession());
    redirect(`/login?next=${encodeURIComponent(nextPath)}${expired ? '&reason=expired' : ''}`);
  }
  applyScenario(principal.demo);
  return principal;
}

/** Demo scenarios: `error` throws before data loads; `loading` delays data so streaming skeletons stay visible. Live mode has none. */
export function applyScenario(demo: DemoContext): void {
  if (demo.scenario === 'error') throw new Error('Demo scenario: simulated data failure');
}

export async function scenarioDelay(demo: DemoContext): Promise<void> {
  if (demo.scenario === 'loading') await new Promise((resolve) => setTimeout(resolve, 6000));
}

export function hrefFor(principal: Principal | DemoContext, path: string): string {
  const demo = 'demo' in principal ? principal.demo : principal;
  return withDemo(path, demo);
}

import { redirect } from 'next/navigation';
import { data, type AuthenticatedPrincipal, type Principal } from './data';
import { resolveDemoContext, withDemo, type DemoContext, type SearchParamsInput } from './persona';

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Resolves the demo principal for a request from its search params (pages only; layouts cannot read the URL). */
export async function getPrincipal(searchParams: PageSearchParams | SearchParamsInput | undefined): Promise<Principal> {
  const params = searchParams instanceof Promise ? await searchParams : searchParams;
  const demo = resolveDemoContext(params);
  const person = data.principalFor(demo);
  return person ?? { kind: 'anonymous', persona: 'anonymous', demo: { ...demo, persona: 'anonymous' } };
}

/** Workspace gate: anonymous visitors are sent to `/login?next=`; the demo scenario `error` throws so error boundaries render. */
export async function requirePrincipal(searchParams: PageSearchParams | undefined, nextPath: string): Promise<AuthenticatedPrincipal> {
  const principal = await getPrincipal(searchParams);
  if (principal.kind !== 'person') redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  applyScenario(principal.demo);
  return principal;
}

/** Demo scenarios: `error` throws before data loads; `loading` delays data so streaming skeletons stay visible. */
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

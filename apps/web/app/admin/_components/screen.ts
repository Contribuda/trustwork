import type { ReactNode } from 'react';
import type { HubContext } from './context';

/**
 * What the console route passes a screen besides the context: the path below the section (`support/cases/sc-1` gives
 * the cases screen `['sc-1']`) and the query without the demo persona and scenario (filters, lookups). Both are
 * untrusted input: a screen validates them and renders "not found" for anything it does not know.
 */
export type ScreenRoute = { rest: readonly string[]; query: Readonly<Record<string, string>> };

/**
 * One hub console screen (ADM-002). Screens live in their section folders (`hubs/[hub]/<group>/<section>/_screen.tsx`)
 * and are served by the single console route `hubs/[hub]/[[...section]]`, so the console ships one client page chunk
 * instead of one per section. A section may still get its own route later; a static route takes precedence.
 *
 * `accepts` lets a screen serve addresses below its section (detail pages such as `support/cases/[case]`, HUBC-004):
 * the route asks it whether the remaining segments name something it renders; without it only the exact section path
 * exists.
 */
export type Screen = {
  group: string;
  id: string;
  title: () => string;
  accepts?: (rest: readonly string[]) => boolean;
  render: (ctx: HubContext, route: ScreenRoute) => ReactNode | Promise<ReactNode>;
};

import type { ReactNode } from 'react';
import type { HubContext } from './context';

/**
 * One hub console screen (ADM-002). Screens live in their section folders (`hubs/[hub]/<group>/<section>/_screen.tsx`)
 * and are served by the single console route `hubs/[hub]/[[...section]]`, so the console ships one client page chunk
 * instead of one per section. A section may still get its own route later; a static route takes precedence.
 */
export type Screen = {
  group: string;
  id: string;
  title: () => string;
  render: (ctx: HubContext) => ReactNode | Promise<ReactNode>;
};

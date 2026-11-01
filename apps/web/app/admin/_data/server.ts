import { createTransport } from '@/app/_lib/data/http/transport';
import { siteUrl } from '@/app/_lib/site';
import { createApiConsolePort } from './api-adapter';
import { consolePort as choose } from './index';
import type { ConsoleDataPort } from './port';

/** Engine version shown on the node card (apps/web/package.json). */
const ENGINE_VERSION = '0.1.0';

let live: ConsoleDataPort | null = null;

/**
 * The console's adapter for this server process (HUBC-007): demo mode serves the synthetic fixtures; live mode reads
 * the API with the visitor's session cookie. The site host is read when a page renders (CFG-001).
 */
export function consolePort(demoEnabled: boolean): ConsoleDataPort {
  live ??= createApiConsolePort({ api: createTransport(), siteHost: () => new URL(siteUrl()).hostname, engineVersion: ENGINE_VERSION });
  return choose(demoEnabled, live);
}

export type * from './port';

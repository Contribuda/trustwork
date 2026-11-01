import { fixtureConsolePort } from './fixture-adapter.js';
import type { ConsoleDataPort } from './port.js';
import { unavailableConsolePort } from './unavailable-adapter.js';

/**
 * The console's adapter choice: demo mode serves the synthetic fixtures; live mode serves the adapter it is given.
 * Server code uses `consolePort` from `./server` (HUBC-007), which passes the API adapter; this module carries no
 * network code so tests import it directly, and without a live adapter it serves nothing (the unavailable adapter).
 */
export function consolePort(demoEnabled: boolean, live: ConsoleDataPort = unavailableConsolePort): ConsoleDataPort {
  return demoEnabled ? fixtureConsolePort : live;
}

export type * from './port.js';

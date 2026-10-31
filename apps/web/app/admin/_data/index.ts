import { fixtureConsolePort } from './fixture-adapter.js';
import type { ConsoleDataPort } from './port.js';
import { unavailableConsolePort } from './unavailable-adapter.js';

/**
 * The console's adapter for this process: demo mode serves the synthetic fixtures; live mode has no console backend
 * yet and serves nothing (HUBC-007 adds the API adapter here).
 */
export function consolePort(demoEnabled: boolean): ConsoleDataPort {
  return demoEnabled ? fixtureConsolePort : unavailableConsolePort;
}

export type * from './port.js';

import type { ConsoleDataPort } from './port.js';

/**
 * Live mode before the console backends exist (ADM-001, HUB-001, HUB-004, HUBC-007). No staff authority is served by
 * the API yet, so nobody is a console viewer: every console route renders "not found" and every command answers
 * `not_found`. No fixture is reachable from this adapter.
 */
export const unavailableConsolePort: ConsoleDataPort = {
  source: 'unavailable',
  now: () => new Date(),
  viewer: async () => null,
  node: async () => null,
  hubs: async () => [],
  hub: async () => null,
  access: async () => ({ roles: [], permissions: [] }),
  rolesGranting: async () => [],
  people: async () => [],
  overview: async () => null,
  approvals: async () => ({ requests: [], decisions: [] }),
  legal: async () => ({ operator: null, documents: [] }),
  residency: async () => null,
  localAdditions: async () => [],
  taxonomy: async () => [],
  brandChecks: async () => [],
  setup: async () => null,
  command: async () => ({ status: 'not_found' }),
};

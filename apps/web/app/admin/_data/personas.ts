import { STAFF_PERSONAS } from '../_fixtures/staff.js';

/**
 * Demo staff personas and scenarios of the console (ADM-002). Like the workspace's `?persona=` (persona.ts), they are
 * read from the query only when demo mode is on; with demo mode off this module returns nothing, so a query string can
 * never choose who the viewer is. Server actions receive the same values as hidden form fields and apply the same rule.
 */
export const STAFF_PERSONA_IDS = Object.keys(STAFF_PERSONAS) as Array<keyof typeof STAFF_PERSONAS>;
export type StaffPersonaId = keyof typeof STAFF_PERSONAS;

/** The workspace scenarios plus the console's own (docs/engine/hub-console/README.md, "Data"). */
export const ADMIN_SCENARIOS = ['default', 'error', 'offline', 'loading', 'maintenance', 'kill-switch-engaged', 'elevation-required'] as const;
export type AdminScenario = (typeof ADMIN_SCENARIOS)[number];

export type ConsoleRequest = { demo: true; persona: StaffPersonaId | null; scenario: AdminScenario } | { demo: false };

export function isStaffPersona(value: unknown): value is StaffPersonaId {
  return typeof value === 'string' && Object.hasOwn(STAFF_PERSONAS, value);
}

export function isAdminScenario(value: unknown): value is AdminScenario {
  return typeof value === 'string' && (ADMIN_SCENARIOS as readonly string[]).includes(value);
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams | FormData | undefined;

function read(params: Params, name: string): string | undefined {
  if (!params) return undefined;
  if (params instanceof URLSearchParams || params instanceof FormData) {
    const value = params.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The console request of a page or a server action. Demo off: `{ demo: false }`, the parameters are never read.
 * Demo on: the staff persona (null when absent or unknown, which renders "not found" like an anonymous visitor) and
 * the scenario.
 */
export function resolveConsoleRequest(params: Params, demoEnabled: boolean): ConsoleRequest {
  if (!demoEnabled) return { demo: false };
  const persona = read(params, 'persona');
  const scenario = read(params, 'scenario');
  return { demo: true, persona: isStaffPersona(persona) ? persona : null, scenario: isAdminScenario(scenario) ? scenario : 'default' };
}

/** Appends the demo persona and scenario so console navigation keeps them; live links stay unchanged. */
export function consoleHref(path: string, request: ConsoleRequest, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (request.demo && request.persona) params.set('persona', request.persona);
  if (request.demo && request.scenario !== 'default') params.set('scenario', request.scenario);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  if (!query) return path;
  const [base, hash] = path.split('#');
  return `${base}${base?.includes('?') ? '&' : '?'}${query}${hash ? `#${hash}` : ''}`;
}

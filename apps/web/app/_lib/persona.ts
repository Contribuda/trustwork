/**
 * Demo principal switch (WEB-001) and the demo-mode switch (WEB-004).
 *
 * `TRUSTWORK_DEMO_MODE=1` (server environment, read at request time) turns the demo on: synthetic fixtures behind
 * the data boundary and a "persona" that selects which synthetic principal the screens render for, so every
 * contract state can be exercised without a backend (the hosted preview). With demo mode off (the default) the app
 * runs on the live `/v1/*` API: the principal is the session, `?persona=`, `?scenario=` and
 * `TRUSTWORK_DEMO_PERSONA` are refused (ignored, never read) and no fixture reaches a page.
 *
 * Demo resolution order: `?persona=` query (per request) > `TRUSTWORK_DEMO_PERSONA` environment variable
 * (process default) > `anonymous`. The switch is cookie-less by design; links inside the workspace carry the query
 * parameter only when it differs from the process default.
 */

export const PERSONAS = ['anonymous', 'reader', 'mixed', 'owner'] as const;
export type Persona = (typeof PERSONAS)[number];

export const SCENARIOS = ['default', 'error', 'offline', 'loading'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type SearchParamsInput = Record<string, string | string[] | undefined> | URLSearchParams;

const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Whether this deployment runs the demo (fixtures and the persona switch). Server only: client components receive
 * the decision as a prop from their server parent, never from the environment.
 */
export function demoModeEnabled(env: Record<string, string | undefined> | undefined = typeof process !== 'undefined' ? process.env : undefined): boolean {
  const raw = env?.TRUSTWORK_DEMO_MODE?.trim().toLowerCase();
  return raw !== undefined && ON.has(raw);
}

export function isPersona(value: unknown): value is Persona {
  return typeof value === 'string' && (PERSONAS as readonly string[]).includes(value);
}

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

/** Process-level default persona (server only); `anonymous` when unset, invalid or when demo mode is off. */
export function defaultPersona(enabled: boolean = demoModeEnabled()): Persona {
  if (!enabled) return 'anonymous';
  const env = typeof process !== 'undefined' ? process.env.TRUSTWORK_DEMO_PERSONA : undefined;
  return isPersona(env) ? env : 'anonymous';
}

function readParam(params: SearchParamsInput | undefined, name: string): string | undefined {
  if (!params) return undefined;
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

export type DemoContext = { persona: Persona; scenario: Scenario; fromQuery: boolean; defaultPersona: Persona };

/** The context of every request when demo mode is off: no persona, no scenario, nothing read from the query. */
export const LIVE_CONTEXT: DemoContext = Object.freeze({ persona: 'anonymous', scenario: 'default', fromQuery: false, defaultPersona: 'anonymous' }) as DemoContext;

/**
 * Resolves the demo context of a request. With `enabled` false (live mode) the query is never read and the result is
 * always `LIVE_CONTEXT`, so `?persona=` and `?scenario=` cannot influence a page. Client components pass the
 * server's decision explicitly; server code relies on the default.
 */
export function resolveDemoContext(params: SearchParamsInput | undefined, fallback?: Persona, enabled: boolean = demoModeEnabled()): DemoContext {
  if (!enabled) return LIVE_CONTEXT;
  const base = fallback ?? defaultPersona(true);
  const raw = readParam(params, 'persona');
  const persona = isPersona(raw) ? raw : base;
  const rawScenario = readParam(params, 'scenario');
  return { persona, scenario: isScenario(rawScenario) ? rawScenario : 'default', fromQuery: isPersona(raw), defaultPersona: base };
}

/** Appends the persona (and scenario) query so demo navigation keeps the selected principal; live links stay unchanged. */
export function withDemo(href: string, ctx: Pick<DemoContext, 'persona' | 'defaultPersona'> & { scenario?: Scenario }): string {
  const params: string[] = [];
  if (ctx.persona !== ctx.defaultPersona) params.push(`persona=${ctx.persona}`);
  if (ctx.scenario && ctx.scenario !== 'default') params.push(`scenario=${ctx.scenario}`);
  if (!params.length) return href;
  const [path, hash] = href.split('#');
  const joiner = path?.includes('?') ? '&' : '?';
  return `${path}${joiner}${params.join('&')}${hash ? `#${hash}` : ''}`;
}

/**
 * Demo principal switch (WEB-001). There is no backend and no session: a "persona" selects which
 * synthetic fixture principal the screens render for, so every contract state can be exercised.
 *
 * Resolution order: `?persona=` query (per request) > `TRUSTWORK_DEMO_PERSONA` environment variable
 * (process default) > `anonymous`. The switch is cookie-less by design; links inside the workspace
 * carry the query parameter only when it differs from the process default. BE-001 replaces this
 * with the real session principal behind the same `Principal` shape.
 */

export const PERSONAS = ['anonymous', 'reader', 'mixed', 'owner'] as const;
export type Persona = (typeof PERSONAS)[number];

export const SCENARIOS = ['default', 'error', 'offline', 'loading'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type SearchParamsInput = Record<string, string | string[] | undefined> | URLSearchParams;

export function isPersona(value: unknown): value is Persona {
  return typeof value === 'string' && (PERSONAS as readonly string[]).includes(value);
}

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

/** Process-level default persona (server only); `anonymous` when unset or invalid. */
export function defaultPersona(): Persona {
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

export function resolveDemoContext(params: SearchParamsInput | undefined, fallback: Persona = defaultPersona()): DemoContext {
  const raw = readParam(params, 'persona');
  const persona = isPersona(raw) ? raw : fallback;
  const rawScenario = readParam(params, 'scenario');
  return { persona, scenario: isScenario(rawScenario) ? rawScenario : 'default', fromQuery: isPersona(raw), defaultPersona: fallback };
}

/** Appends the persona (and scenario) query so demo navigation keeps the selected principal. */
export function withDemo(href: string, ctx: Pick<DemoContext, 'persona' | 'defaultPersona'> & { scenario?: Scenario }): string {
  const params: string[] = [];
  if (ctx.persona !== ctx.defaultPersona) params.push(`persona=${ctx.persona}`);
  if (ctx.scenario && ctx.scenario !== 'default') params.push(`scenario=${ctx.scenario}`);
  if (!params.length) return href;
  const [path, hash] = href.split('#');
  const joiner = path?.includes('?') ? '&' : '?';
  return `${path}${joiner}${params.join('&')}${hash ? `#${hash}` : ''}`;
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESTRICTED } from '@trustwork/country-packs';
import {
  JURISDICTION_ERROR_STATUS, jurisdictionGateFromEnv, restrictedPlaces, SESSION_COOKIE, unconfiguredGate,
  type JurisdictionGate, type JurisdictionGateDescription, type Sighting,
} from '@trustwork/contracts/client';

/**
 * The web door of the jurisdiction gate (SANC-001, ADR 014 decisions 6 to 8). `apps/web/proxy.ts` asks it first, before
 * any page, server action or same-origin `/v1/*` call runs:
 *
 * - a page request (GET or HEAD, HTML, not a server action) from a restricted place renders `/restricted` in place, in
 *   the visitor's language; anything else is answered 451 with `jurisdiction.restricted`;
 * - the only open path is the refusal page itself (Next assets and icons never reach the proxy);
 * - when the refused request carries a session cookie, the proxy relays it to the API (`/v1/jurisdiction/sighting`,
 *   with the visitor's address in `X-Forwarded-For`) so the API's gate, the single writer of holds, can hold the
 *   person; the API must trust this hop (`API_TRUSTED_PROXY_HOPS`, already required for rate limits). A failed relay
 *   never opens the door.
 *
 * Configuration is the API's (`TRUSTWORK_JURISDICTION_GATE` and friends, see `jurisdictionGateFromEnv`); the restricted
 * places are the authoritative country-pack list. Without a mode the web logs once and serves (the API refuses to
 * start in production without one, and every write and session passes it); a mode that cannot be built fails closed:
 * every request except the refusal page is answered 503.
 */

/** The client address: `X-Real-IP` set by the edge, else the last `X-Forwarded-For` entry (the hop the edge appended). */
export function clientAddressOf(get: (name: string) => string | null): string | null {
  const real = get('x-real-ip')?.trim();
  if (real) return real;
  const chain = get('x-forwarded-for');
  if (!chain) return null;
  const entries = chain.split(',').map((s) => s.trim()).filter(Boolean);
  return entries[entries.length - 1] ?? null;
}

export const JURISDICTION_REFUSAL_PATH = '/restricted';
const OPEN_PATHS = new Set([JURISDICTION_REFUSAL_PATH]);
export const jurisdictionOpenPath = (pathname: string): boolean => OPEN_PATHS.has(pathname.replace(/\/$/, '') || '/');

type GateState = { gate: JurisdictionGate; broken: false } | { gate: null; broken: true };
let cached: GateState | null = null;

/** Builds (once per process) the gate from the environment; exported for tests with an explicit environment. */
export function webJurisdictionGate(env: Readonly<Record<string, string | undefined>> = process.env, reset = false): GateState {
  if (cached && !reset) return cached;
  try {
    const gate = jurisdictionGateFromEnv(env, {
      restricted: restrictedPlaces(RESTRICTED.places.map((p) => p.code)),
      production: env.NODE_ENV === 'production',
      requireMode: false,
      readJson: (path) => JSON.parse(readFileSync(path, 'utf8')),
      joinPath: join,
    });
    if (gate.mode === 'unconfigured' && env.NODE_ENV === 'production') console.warn(JSON.stringify({ level: 'warn', event: 'jurisdiction.gate_unconfigured', message: 'TRUSTWORK_JURISDICTION_GATE is not set: the web door serves every place; the API gate still refuses' }));
    cached = { gate, broken: false };
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'jurisdiction.gate_invalid', message: error instanceof Error ? error.message : 'invalid jurisdiction gate configuration' }));
    cached = { gate: null, broken: true };
  }
  return cached;
}

/** The gate's description for the refusal page (dataset and attribution), never a range or an address. */
export function jurisdictionGateDescription(): JurisdictionGateDescription {
  const state = webJurisdictionGate();
  return (state.gate ?? unconfiguredGate()).describe();
}

export type WebGateDecision =
  | { kind: 'pass' }
  | { kind: 'refuse_page'; sighting: Sighting }
  | { kind: 'refuse_call'; sighting: Sighting; status: number; body: { code: 'jurisdiction.restricted'; message: string } }
  | { kind: 'unavailable'; status: 503; body: { code: 'internal.error'; message: string } };

export interface WebGateRequest {
  method: string;
  pathname: string;
  header(name: string): string | null;
}

/** Pure decision for one request (the proxy turns it into a response). */
export function decideWebRequest(request: WebGateRequest, state: GateState = webJurisdictionGate()): WebGateDecision {
  if (jurisdictionOpenPath(request.pathname)) return { kind: 'pass' };
  if (state.broken) return { kind: 'unavailable', status: 503, body: { code: 'internal.error', message: 'temporarily unavailable' } };
  const sighting = state.gate.decide({ address: clientAddressOf(request.header), header: request.header });
  if (!sighting) return { kind: 'pass' };
  const method = request.method.toUpperCase();
  const page = (method === 'GET' || method === 'HEAD') && !request.pathname.startsWith('/v1/') && !request.header('next-action') && (request.header('accept') ?? '').includes('text/html');
  if (page) return { kind: 'refuse_page', sighting };
  return { kind: 'refuse_call', sighting, status: JURISDICTION_ERROR_STATUS['jurisdiction.restricted'], body: { code: 'jurisdiction.restricted', message: 'This service is not available in your location.' } };
}

const SESSION_COOKIES = [SESSION_COOKIE, SESSION_COOKIE.replace('__Host-', '')];

/** The session cookie pair of a Cookie header, or null: only the session travels to the API, nothing else. */
export function sessionCookieOf(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name && SESSION_COOKIES.includes(name) && rest.join('=')) return `${name}=${rest.join('=')}`;
  }
  return null;
}

/** API origin for the relay: `TRUSTWORK_API_ORIGIN`, or the local API outside production; null when unknown. */
export function relayOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const raw = env.TRUSTWORK_API_ORIGIN?.trim();
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }
  return env.NODE_ENV === 'production' ? null : 'http://127.0.0.1:3001';
}

/**
 * Relays a refused visitor's session to the API so its gate holds the person. Best effort with a short timeout: the
 * refusal stands whatever happens, and the address goes only to the API, never to a log.
 */
export async function relaySighting(input: { cookieHeader: string | null; address: string | null; requestId?: string }, options: { origin?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<'relayed' | 'skipped' | 'failed'> {
  const session = sessionCookieOf(input.cookieHeader);
  const origin = options.origin === undefined ? relayOrigin() : options.origin;
  if (!session || !input.address || !origin) return 'skipped';
  try {
    const response = await (options.fetch ?? fetch)(`${origin}/v1/jurisdiction/sighting`, {
      method: 'GET',
      headers: { cookie: session, 'x-forwarded-for': input.address, accept: 'application/json', ...(input.requestId ? { 'x-request-id': input.requestId } : {}) },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    return response.status === 451 || response.status === 204 || response.status === 403 ? 'relayed' : 'failed';
  } catch {
    return 'failed';
  }
}

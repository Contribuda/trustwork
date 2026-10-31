import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigError } from '../../config.js';
import type { DataPool } from '../../deps/data.js';
import type { RequestState, TrustworkRequest } from '../../common/request.js';
import {
  JURISDICTION_ERROR_STATUS, jurisdictionGateFromEnv, JurisdictionGateConfigError, jurisdictionGateStore, restrictedPlaces,
  type JurisdictionErrorCode, type JurisdictionGate, type RestrictedPlaces,
} from './deps.js';

/**
 * The API's jurisdiction gate (SANC-001, ADR 014 decisions 6 to 8): the same rule as the web proxy, where every write
 * lands, so a path a front forgot is still closed.
 *
 * Every request except the health probes passes `decide` with the client address Fastify derived under the configured
 * trusted proxies (`API_TRUSTED_PROXY_HOPS`, `API_TRUSTED_PROXIES`; never a client-chosen header). A request from a
 * restricted place is answered 451 `jurisdiction.restricted`; when it carries a live session, the session's person is
 * held first. A request whose session belongs to a held person is answered 403 `auth.jurisdiction_hold` wherever it
 * comes from. The address is never logged or stored: log lines and records name the place and the dataset.
 */

/** Paths that answer whoever asks: the platform's probes. Provider webhooks and unsubscribe links join this list when they exist. */
const OPEN_PATHS = new Set(['/health', '/health/live', '/health/ready']);
export function jurisdictionOpenPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return OPEN_PATHS.has(path);
}

/** The authoritative restricted places: the synced kernel table, else the country-pack file in a source checkout. */
export async function loadRestrictedPlaces(pool: DataPool, log?: { warn(event: string, fields?: Record<string, unknown>): void }, root: string | null = findRepositoryRoot()): Promise<RestrictedPlaces> {
  let synced: string[] = [];
  try {
    synced = await jurisdictionGateStore.restrictedPlaces(pool);
  } catch {
    // The database is not reachable at start: fall back to the authoritative file below (never to an empty list).
    log?.warn('jurisdiction.restricted_places_unreadable', { message: 'the synced restricted places could not be read at start; using the country-pack file if present' });
  }
  if (synced.length) return restrictedPlaces(synced);
  const file = root ? join(root, 'packages', 'country-packs', 'packs', 'restricted.json') : null;
  if (file && existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { places: { code: string }[] };
    return restrictedPlaces(parsed.places.map((p) => p.code));
  }
  throw new ConfigError(['the restricted places are not synced into the database (run the kernel sync, packages/data/bin/kernel-sync.mjs)']);
}

function findRepositoryRoot(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'packages', 'country-packs', 'packs', 'restricted.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Builds the gate from the environment; production refuses an unset mode and the fake adapter (exit 78 in main). */
export function jurisdictionGateFor(env: NodeJS.ProcessEnv, restricted: RestrictedPlaces, production: boolean): JurisdictionGate {
  try {
    return jurisdictionGateFromEnv(env, { restricted, production, requireMode: production, readJson: (path) => JSON.parse(readFileSync(path, 'utf8')), joinPath: join });
  } catch (error) {
    if (error instanceof JurisdictionGateConfigError) throw new ConfigError([error.message]);
    throw error;
  }
}

export interface JurisdictionHookDeps {
  gate: JurisdictionGate;
  pool: DataPool;
  log: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void; error(event: string, fields?: Record<string, unknown>): void };
}

function refuse(reply: FastifyReply, request: FastifyRequest, code: JurisdictionErrorCode | 'internal.error', message: string): FastifyReply {
  const status = code === 'internal.error' ? 503 : JURISDICTION_ERROR_STATUS[code];
  return reply.code(status).header('Cache-Control', 'no-store').type('application/json; charset=utf-8').send({ code, message, requestId: String(request.id) });
}

/** The `onRequest` hook body; it runs after the identity hook attached the request state. */
export function jurisdictionHook(deps: JurisdictionHookDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (jurisdictionOpenPath(request.url)) return;
    const state: RequestState | undefined = (request as TrustworkRequest).trustwork;
    const tokenHash = state?.sessionTokenHash ?? null;
    const sighting = deps.gate.decide({ address: request.ip, header: (name) => {
      const value = request.headers[name.toLowerCase()];
      return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null;
    } });
    if (sighting) {
      let held = false;
      if (tokenHash && state?.session) {
        try {
          held = await jurisdictionGateStore.holdSession(deps.pool, { tokenHashHex: tokenHash, place: sighting.place, source: deps.gate.mode === 'edge_header' ? 'edge_header' : 'geolocation', dataset: sighting.dataset });
        } catch (error) {
          // The refusal stands without the hold; the next request tries again.
          deps.log.error('jurisdiction.hold_failed', { err: error });
        }
      }
      try {
        await jurisdictionGateStore.countRefusal(deps.pool, { place: sighting.place, door: 'api', held });
      } catch (error) {
        deps.log.warn('jurisdiction.count_failed', { err: error });
      }
      deps.log.info('jurisdiction.refused', { place: sighting.place, dataset: sighting.dataset, held });
      return refuse(reply, request, 'jurisdiction.restricted', 'This service is not available in your location.');
    }
    if (tokenHash && state?.session) {
      let personHeld: boolean;
      try {
        personHeld = await jurisdictionGateStore.sessionHeld(deps.pool, tokenHash);
      } catch (error) {
        deps.log.error('jurisdiction.check_failed', { err: error });
        return refuse(reply, request, 'internal.error', 'temporarily unavailable');
      }
      if (personHeld) return refuse(reply, request, 'auth.jurisdiction_hold', 'This account is paused for a location check.');
    }
  };
}

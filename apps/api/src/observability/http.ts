import type { LoggerService } from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config.js';
import { principalPseudonym, type Logger } from './logger.js';
import type { Telemetry, TraceContext } from './telemetry.js';

/**
 * HTTP instrumentation: security headers on every response, one structured log line per request (request id,
 * principal pseudonym, route pattern, status, latency, trace id and, for failures, the error with its stack) and
 * the request span/metric. Raw URLs, query strings, headers and bodies are never logged: the route is the
 * registered pattern (`/v1/projects/:id`), so tokens in paths or queries cannot leak.
 */
const STATE = Symbol('trustwork.observability');
interface ObservedRequest {
  startedHr: bigint;
  trace: TraceContext | null;
  error: unknown;
}
type Observed = FastifyRequest & { [STATE]?: ObservedRequest };

/** Called by the error filter (and Fastify's `onError`) so the request line carries the failure; there is no second line. */
export function recordRequestError(request: FastifyRequest, error: unknown): void {
  const state = (request as Observed)[STATE];
  if (state && state.error === undefined) state.error = error;
}

/** API response headers. The API serves JSON only, so the CSP forbids everything and framing. HSTS only over https. */
export function apiSecurityHeaders(config: Pick<ApiConfig, 'publicOrigin' | 'securityHeaders'>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (config.publicOrigin.startsWith('https://') && config.securityHeaders.hstsMaxAgeSeconds > 0) {
    headers['Strict-Transport-Security'] = `max-age=${config.securityHeaders.hstsMaxAgeSeconds}; includeSubDomains`;
  }
  return headers;
}

const QUIET_ROUTES = new Set(['/health', '/health/live', '/health/ready']);

export interface InstrumentOptions {
  config: ApiConfig;
  logger: Logger;
  telemetry: Telemetry;
}

export function instrumentHttp(fastify: FastifyInstance, { config, logger, telemetry }: InstrumentOptions): void {
  const headers = apiSecurityHeaders(config);
  fastify.addHook('onRequest', async (request, reply) => {
    (request as Observed)[STATE] = { startedHr: process.hrtime.bigint(), trace: telemetry.startRequest(request.headers.traceparent), error: undefined };
    reply.headers(headers);
  });
  fastify.addHook('onError', async (request, _reply, error) => {
    recordRequestError(request, error);
  });
  fastify.addHook('onResponse', async (request, reply) => {
    const state = (request as Observed)[STATE];
    if (!state) return;
    const status = reply.statusCode;
    const route = request.routeOptions?.url ?? '<unmatched>';
    const durationMs = Math.round(Number(process.hrtime.bigint() - state.startedHr) / 1e4) / 100;
    telemetry.endRequest(state.trace, state.startedHr, { method: request.method, route, status, requestId: String(request.id) });
    // Probes are frequent: a healthy probe is debug and a failing readiness probe (503) a warning, not an error line per poll.
    const level = QUIET_ROUTES.has(route) ? (status >= 500 ? 'warn' : 'debug') : status >= 500 ? 'error' : 'info';
    if (!logger.enabled(level)) return;
    const personId = (request as FastifyRequest & { trustwork?: { principal?: { personId?: string } | null } }).trustwork?.principal?.personId ?? null;
    logger[level]('http.request', {
      requestId: String(request.id),
      method: request.method,
      route,
      status,
      durationMs,
      principal: principalPseudonym(config.log.pseudonymKey, personId),
      ...(state.trace ? { traceId: state.trace.traceId, spanId: state.trace.spanId } : {}),
      ...(state.error !== undefined && status >= 500 ? { err: state.error } : {}),
    });
  });
  fastify.addHook('onClose', async () => {
    await telemetry.shutdown();
  });
}

/** Nest's framework messages (bootstrap failures, unhandled errors outside filters) as structured lines. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  private write(level: 'debug' | 'info' | 'warn' | 'error', message: unknown, rest: unknown[]) {
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    const stack = level === 'error' && typeof rest[0] === 'string' && rest[0].includes('\n') ? rest[0] : undefined;
    this.logger[level]('nest.message', {
      message: message instanceof Error ? message.message : typeof message === 'string' ? message : 'non-string message',
      ...(context ? { context } : {}),
      ...(message instanceof Error ? { err: message } : stack ? { err: { type: 'Error', message: 'nest error', stack } } : {}),
    });
  }
  /** Nest's `log` level is framework chatter (route mapping, module init): debug. */
  log(message: unknown, ...rest: unknown[]) { this.write('debug', message, rest); }
  error(message: unknown, ...rest: unknown[]) { this.write('error', message, rest); }
  warn(message: unknown, ...rest: unknown[]) { this.write('warn', message, rest); }
  debug(message: unknown, ...rest: unknown[]) { this.write('debug', message, rest); }
  verbose(message: unknown, ...rest: unknown[]) { this.write('debug', message, rest); }
}

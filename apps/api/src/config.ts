import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { DEFAULT_PASSWORD_POLICY, STEP_UP_FRESHNESS_MS } from './deps/contracts.js';

/**
 * Runtime configuration of the API process. Every value is explicit (no `.env` is loaded implicitly) and is
 * validated by one Zod schema; defaults are the integrator decisions of BE-001 and the H01–H11 defaults where the
 * human has not decided yet. With `NODE_ENV=production` the process refuses to boot without a flow secret, an
 * `https` public origin and secure cookies (OPS-001). Error messages name variables, never their values.
 */
export interface ApiConfig {
  host: string;
  port: number;
  /** Exact public origin the browser loads the app from; mutations must prove same-origin against it. */
  publicOrigin: string;
  /** Path the provider callback redirects to (relative to the public origin). */
  authReturnPath: string;
  cookies: { secure: boolean; hostPrefix: boolean };
  session: { idleMs: number; absoluteMs: number; stepUpMs: number; touchIntervalMs: number };
  password: { minLength: number; maxLength: number; memoryCost: number; timeCost: number; parallelism: number };
  tokens: { verifyEmailMs: number; recoveryMs: number; emailChangeMs: number; invitationMs: number };
  lockout: { windowSeconds: number; accountThreshold: number; ipThreshold: number; disableThreshold: number; disableWindowSeconds: number; retentionSeconds: number };
  rateLimit: { authPerMinute: number };
  idempotency: { retentionMs: number };
  /** `disabled` (default): no provider routes; `fake`: scriptable adapters (never in production); `live`: openid-client adapters. */
  providers: { mode: 'disabled' | 'fake' | 'live'; google: OidcClientConfig | null; apple: OidcClientConfig | null };
  production: boolean;
  /** HMAC key for the pre-login flow cookie; required in production, generated per process only in development. */
  flowSecret: Buffer;
  termsVersion: string;
  /** Runtime pool limits; the two timeouts are sent as connection parameters so a hung statement or transaction cannot pin a connection. */
  database: { poolMax: number; statementTimeoutMs: number; idleInTransactionTimeoutMs: number; connectionTimeoutMs: number };
  /**
   * Which `X-Forwarded-For` hops are trusted. `hops: 0` and no address list (default) ignore the header entirely; the
   * client address is the socket peer. Never "trust everything".
   */
  proxy: { hops: number; addresses: string[] };
  log: { level: LogLevelName; /** Key for principal pseudonyms in logs (derived from the flow secret unless set). */ pseudonymKey: Buffer };
  /** OpenTelemetry-compatible export (OTLP/HTTP JSON). `endpoint: null` means a no-op: nothing is buffered or sent. */
  telemetry: { endpoint: string | null; headers: Record<string, string>; serviceName: string; exportIntervalMs: number; traceSampleRatio: number };
  readiness: { timeoutMs: number; /** Directory with the migration files this build expects; null = discovered next to the sources. */ migrationsDir: string | null };
  /**
   * Exact `Strict-Transport-Security` value from `TRUSTWORK_HSTS`, or null (default: no HSTS header). HSTS pins the
   * whole host (and with `includeSubDomains` every subdomain) to HTTPS, which is the domain operator's decision: set
   * it only when the app owns the whole host, never for an app served under a path of someone else's domain.
   */
  securityHeaders: { hsts: string | null };
}
export interface OidcClientConfig { clientId: string; clientSecret: string }
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

/** Configuration refused at startup; `issues` name variables and rules, never values. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid API configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const optionalString = z.string().optional().transform((v) => (v === undefined || v === '' ? undefined : v));
const integer = (fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}) =>
  z.string().optional().transform((raw, ctx) => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
      return z.NEVER;
    }
    return value;
  });
const boolean = (fallback: boolean) =>
  z.string().optional().transform((raw, ctx) => {
    if (raw === undefined || raw === '') return fallback;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    ctx.addIssue({ code: 'custom', message: 'must be true/false' });
    return z.NEVER;
  });
const ratio = (fallback: number) =>
  z.string().optional().transform((raw, ctx) => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      ctx.addIssue({ code: 'custom', message: 'must be a number between 0 and 1' });
      return z.NEVER;
    }
    return value;
  });

/** IPv4/IPv6 address or CIDR (`10.0.0.0/8`, `fd00::/8`); the names `loopback`, `linklocal`, `uniquelocal` of proxy-addr are accepted too. */
function isProxyAddress(entry: string): boolean {
  if (entry === 'loopback' || entry === 'linklocal' || entry === 'uniquelocal') return true;
  const [address, prefix, extra] = entry.split('/');
  if (extra !== undefined || !address) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128) && /^\d+$/.test(prefix);
}

/** `max-age=<seconds>` optionally followed by `includeSubDomains` and/or `preload` (RFC 6797), nothing else. */
export function isHstsValue(value: string): boolean {
  return /^max-age=\d{1,10}(\s*;\s*(includeSubDomains|preload))*\s*;?$/i.test(value.trim());
}

/** `key1=value1,key2=value2` (OTEL_EXPORTER_OTLP_HEADERS format, values URL-encoded). */
function parseHeaderList(raw: string | undefined): Record<string, string> | null {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    if (!pair.trim()) continue;
    const at = pair.indexOf('=');
    if (at <= 0) return null;
    const key = pair.slice(0, at).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) return null;
    try {
      headers[key.toLowerCase()] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      return null;
    }
  }
  return headers;
}

const EnvSchema = z.object({
  NODE_ENV: optionalString,
  API_HOST: optionalString,
  API_PORT: integer(3001, { max: 65_535 }),
  PUBLIC_ORIGIN: optionalString,
  AUTH_RETURN_PATH: optionalString,
  API_INSECURE_COOKIES: boolean(false),
  AUTH_FLOW_SECRET: optionalString,
  AUTH_PROVIDER_MODE: z.enum(['disabled', 'fake', 'live']).optional().or(z.literal('').transform(() => undefined)),
  GOOGLE_CLIENT_ID: optionalString, GOOGLE_CLIENT_SECRET: optionalString,
  APPLE_CLIENT_ID: optionalString, APPLE_CLIENT_SECRET: optionalString,
  SESSION_IDLE_MINUTES: integer(30, { min: 1 }),
  SESSION_ABSOLUTE_HOURS: integer(12, { min: 1 }),
  SESSION_STEP_UP_MINUTES: optionalString.pipe(z.string().regex(/^\d+$/, 'must be a non-negative integer').optional()),
  PASSWORD_MIN_LENGTH: integer(DEFAULT_PASSWORD_POLICY.minLength, { min: 1, max: DEFAULT_PASSWORD_POLICY.maxLength }),
  ARGON2_MEMORY_KIB: integer(19_456, { min: 1 }),
  ARGON2_TIME_COST: integer(2, { min: 1 }),
  ARGON2_PARALLELISM: integer(1, { min: 1 }),
  TOKEN_VERIFY_EMAIL_HOURS: integer(24), TOKEN_RECOVERY_MINUTES: integer(30), TOKEN_EMAIL_CHANGE_HOURS: integer(24), TOKEN_INVITATION_DAYS: integer(7),
  AUTH_LOCKOUT_WINDOW_MINUTES: integer(15), AUTH_LOCKOUT_THRESHOLD: integer(5), AUTH_LOCKOUT_IP_THRESHOLD: integer(50), AUTH_DISABLE_THRESHOLD: integer(100),
  AUTH_RATE_LIMIT_PER_MINUTE: integer(60, { min: 1 }),
  IDEMPOTENCY_RETENTION_HOURS: integer(24),
  TERMS_VERSION: optionalString,
  API_DB_POOL_MAX: integer(10, { min: 1, max: 1_000 }),
  API_DB_STATEMENT_TIMEOUT_MS: integer(15_000, { min: 1 }),
  API_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: integer(30_000, { min: 1 }),
  API_DB_CONNECT_TIMEOUT_MS: integer(5_000, { min: 1 }),
  API_TRUST_PROXY: optionalString,
  API_TRUSTED_PROXY_HOPS: integer(0, { max: 10 }),
  API_TRUSTED_PROXIES: optionalString,
  API_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().or(z.literal('').transform(() => undefined)),
  API_LOG_PSEUDONYM_SECRET: optionalString,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  OTEL_EXPORTER_OTLP_HEADERS: optionalString,
  OTEL_SERVICE_NAME: optionalString,
  OTEL_METRIC_EXPORT_INTERVAL: integer(60_000, { min: 1_000 }),
  OTEL_TRACES_SAMPLER_ARG: ratio(1),
  API_READINESS_TIMEOUT_MS: integer(2_000, { min: 100, max: 60_000 }),
  API_MIGRATIONS_DIR: optionalString,
  TRUSTWORK_HSTS: optionalString,
});

function hexKey(raw: string | undefined, name: string, issues: string[]): Buffer | null {
  if (raw === undefined) return null;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(raw)) {
    issues.push(`${name} must be hex`);
    return null;
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length < 32) issues.push(`${name} must be at least 32 bytes of hex`);
  return key;
}

function originOf(raw: string, issues: string[]): URL | null {
  try {
    const url = new URL(raw);
    if (url.origin === 'null' || url.origin !== raw.replace(/\/$/, '')) {
      issues.push('PUBLIC_ORIGIN must be a bare origin (scheme://host[:port]) without path, query or credentials');
      return null;
    }
    return url;
  } catch {
    issues.push('PUBLIC_ORIGIN must be an absolute URL');
    return null;
  }
}

/**
 * Parses and validates the process environment. Throws `ConfigError` listing every problem at once. Production
 * (`NODE_ENV=production`) additionally requires `AUTH_FLOW_SECRET`, an `https` `PUBLIC_ORIGIN` and secure cookies
 * and refuses fake providers.
 */
export function apiConfigFromEnv(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'environment'} ${i.message}`));
  const e = parsed.data;
  const issues: string[] = [];
  const production = e.NODE_ENV === 'production';
  const host = e.API_HOST ?? '127.0.0.1';
  const port = e.API_PORT;
  const insecure = e.API_INSECURE_COOKIES;

  const providedSecret = hexKey(e.AUTH_FLOW_SECRET, 'AUTH_FLOW_SECRET', issues);
  const mode = e.AUTH_PROVIDER_MODE ?? 'disabled';
  const publicOrigin = (e.PUBLIC_ORIGIN ?? `http://${host.includes(':') ? `[${host}]` : host}:${port}`).replace(/\/$/, '');
  const origin = originOf(publicOrigin, issues);

  if (production) {
    if (!e.AUTH_FLOW_SECRET) issues.push('AUTH_FLOW_SECRET is required with NODE_ENV=production (a per-process key breaks provider callbacks across replicas)');
    if (!e.PUBLIC_ORIGIN) issues.push('PUBLIC_ORIGIN is required with NODE_ENV=production');
    else if (origin && origin.protocol !== 'https:') issues.push('PUBLIC_ORIGIN must use https with NODE_ENV=production');
    if (insecure) issues.push('API_INSECURE_COOKIES is not allowed with NODE_ENV=production (cookies must be Secure with the __Host- prefix)');
    if (mode === 'fake') issues.push('AUTH_PROVIDER_MODE=fake is not allowed with NODE_ENV=production');
  }
  if (e.API_TRUST_PROXY !== undefined) issues.push('API_TRUST_PROXY (trust every hop) was removed; set API_TRUSTED_PROXY_HOPS or API_TRUSTED_PROXIES');
  const proxyAddresses = (e.API_TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of proxyAddresses) if (!isProxyAddress(entry)) issues.push('API_TRUSTED_PROXIES must list IP addresses or CIDR ranges');
  if (proxyAddresses.length && e.API_TRUSTED_PROXY_HOPS > 0) issues.push('set either API_TRUSTED_PROXY_HOPS or API_TRUSTED_PROXIES, not both');
  if (e.SESSION_STEP_UP_MINUTES !== undefined && Number(e.SESSION_STEP_UP_MINUTES) < 1) issues.push('SESSION_STEP_UP_MINUTES must be at least 1');

  let telemetryEndpoint: string | null = null;
  if (e.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const url = new URL(e.OTEL_EXPORTER_OTLP_ENDPOINT);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
      if (url.username || url.password) issues.push('OTEL_EXPORTER_OTLP_ENDPOINT must not embed credentials (use OTEL_EXPORTER_OTLP_HEADERS)');
      telemetryEndpoint = url.toString().replace(/\/$/, '');
    } catch {
      issues.push('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL');
    }
  }
  const telemetryHeaders = parseHeaderList(e.OTEL_EXPORTER_OTLP_HEADERS);
  if (telemetryHeaders === null) issues.push('OTEL_EXPORTER_OTLP_HEADERS must be a comma-separated list of key=value pairs');
  const pseudonymSecret = hexKey(e.API_LOG_PSEUDONYM_SECRET, 'API_LOG_PSEUDONYM_SECRET', issues);
  if (e.TRUSTWORK_HSTS !== undefined && !isHstsValue(e.TRUSTWORK_HSTS)) issues.push('TRUSTWORK_HSTS must be a Strict-Transport-Security value: max-age=<seconds>[; includeSubDomains][; preload]');
  if (issues.length) throw new ConfigError(issues);

  const flowSecret = providedSecret ?? randomBytes(32);
  const client = (id: string | undefined, secret: string | undefined): OidcClientConfig | null => (id && secret ? { clientId: id, clientSecret: secret } : null);
  return {
    host,
    port,
    publicOrigin,
    authReturnPath: e.AUTH_RETURN_PATH ?? '/',
    cookies: { secure: !insecure, hostPrefix: !insecure },
    session: {
      idleMs: e.SESSION_IDLE_MINUTES * 60_000,
      absoluteMs: e.SESSION_ABSOLUTE_HOURS * 3_600_000,
      stepUpMs: e.SESSION_STEP_UP_MINUTES !== undefined ? Number(e.SESSION_STEP_UP_MINUTES) * 60_000 : STEP_UP_FRESHNESS_MS,
      touchIntervalMs: 5 * 60_000,
    },
    password: {
      minLength: e.PASSWORD_MIN_LENGTH,
      maxLength: DEFAULT_PASSWORD_POLICY.maxLength,
      memoryCost: e.ARGON2_MEMORY_KIB,
      timeCost: e.ARGON2_TIME_COST,
      parallelism: e.ARGON2_PARALLELISM,
    },
    tokens: {
      verifyEmailMs: e.TOKEN_VERIFY_EMAIL_HOURS * 3_600_000,
      recoveryMs: e.TOKEN_RECOVERY_MINUTES * 60_000,
      emailChangeMs: e.TOKEN_EMAIL_CHANGE_HOURS * 3_600_000,
      invitationMs: e.TOKEN_INVITATION_DAYS * 86_400_000,
    },
    lockout: {
      windowSeconds: e.AUTH_LOCKOUT_WINDOW_MINUTES * 60,
      accountThreshold: e.AUTH_LOCKOUT_THRESHOLD,
      ipThreshold: e.AUTH_LOCKOUT_IP_THRESHOLD,
      disableThreshold: e.AUTH_DISABLE_THRESHOLD,
      disableWindowSeconds: 24 * 3_600,
      retentionSeconds: 24 * 3_600,
    },
    rateLimit: { authPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE },
    idempotency: { retentionMs: e.IDEMPOTENCY_RETENTION_HOURS * 3_600_000 },
    providers: { mode, google: client(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET), apple: client(e.APPLE_CLIENT_ID, e.APPLE_CLIENT_SECRET) },
    production,
    flowSecret,
    termsVersion: e.TERMS_VERSION ?? 'draft-2026-10',
    database: {
      poolMax: e.API_DB_POOL_MAX,
      statementTimeoutMs: e.API_DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: e.API_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      connectionTimeoutMs: e.API_DB_CONNECT_TIMEOUT_MS,
    },
    proxy: { hops: e.API_TRUSTED_PROXY_HOPS, addresses: proxyAddresses },
    log: {
      level: e.API_LOG_LEVEL ?? 'info',
      pseudonymKey: pseudonymSecret ?? createHmac('sha256', flowSecret).update('trustwork.log-pseudonym.v1').digest(),
    },
    telemetry: {
      endpoint: telemetryEndpoint,
      headers: telemetryHeaders ?? {},
      serviceName: e.OTEL_SERVICE_NAME ?? 'trustwork-api',
      exportIntervalMs: e.OTEL_METRIC_EXPORT_INTERVAL,
      traceSampleRatio: e.OTEL_TRACES_SAMPLER_ARG,
    },
    readiness: { timeoutMs: e.API_READINESS_TIMEOUT_MS, migrationsDir: e.API_MIGRATIONS_DIR ?? null },
    securityHeaders: { hsts: e.TRUSTWORK_HSTS?.trim() ?? null },
  };
}

/**
 * Fastify `trustProxy` value: an address list, a hop predicate (hop 0 is the socket peer, so `hops: 1` trusts only
 * the directly connected proxy and takes the address it appended), or `false` (ignore forwarding headers).
 */
export function trustProxySetting(config: Pick<ApiConfig, 'proxy'>): string[] | ((address: string, hop: number) => boolean) | false {
  if (config.proxy.addresses.length) return config.proxy.addresses;
  const hops = config.proxy.hops;
  return hops > 0 ? (_address: string, hop: number) => hop < hops : false;
}

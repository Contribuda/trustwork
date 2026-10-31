import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { apiConfigFromEnv, trustProxySetting, type ApiConfig } from './config.js';
import { health, IdSchema, REQUEST_ID_HEADER } from './deps/contracts.js';
import { AdmissionGate, createPool, databaseConfigFromEnv, mailSecretKeyFromEnv, type DataPool } from './deps/data.js';
import { AppModule } from './app.module.js';
import { AuthGuard } from './common/auth.guard.js';
import { CsrfGuard } from './common/csrf.guard.js';
import { ErrorFilter } from './common/error.filter.js';
import { ApiError } from './common/errors.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import type { AppContext } from './modules/identity/context.js';
import { buildIdentityServices, type IdentityServices } from './modules/identity/identity.module.js';
import { filesOptionsFromEnv, type FilesModuleOptions } from './modules/files/files.module.js';
import { GoogleOidcProvider } from './modules/identity/providers/google.js';
import { AppleSignInProvider } from './modules/identity/providers/apple.js';
import { OutboxMail } from './modules/identity/mail.js';
import { secondFactorKeyFromEnv } from './modules/identity/second-factor/secrets.js';
import { FakeOidcProvider, noStaffRoles, RecordingMandateRevocation, systemClock, type Clock, type MailOutbox, type MandateRevocationPort, type OidcProviderPort, type StaffRoleResolver } from './modules/identity/ports.js';
import { createReadinessProbe, discoverMigrationsDir, registerHealthRoutes, type ReadinessProbe } from './observability/health.js';
import { instrumentHttp, NestJsonLogger } from './observability/http.js';
import { createLogger, messageLogger, type Logger, type LogSink } from './observability/logger.js';
import { createTelemetry, type Telemetry, type TelemetryExporter } from './observability/telemetry.js';

export interface CreateAppOptions {
  config?: Partial<ApiConfig>;
  env?: NodeJS.ProcessEnv;
  /** Runtime pool (a login role that is a member of trustwork_app). Without it only /health is served. */
  pool?: DataPool | null;
  clock?: Clock;
  /** Mail intents recorder; defaults to the outbox with `MAIL_SECRET_KEY` (MAIL-001). */
  mail?: MailOutbox;
  providers?: Partial<Record<'google' | 'apple', OidcProviderPort | null>>;
  mandates?: MandateRevocationPort;
  staffRoles?: StaffRoleResolver;
  /** Destination of the structured JSON log lines (default: stdout). */
  logSink?: LogSink;
  /**
   * Deprecated (kept so existing callers compile): without `logSink`, receives only the error-level structured lines
   * as `log(line)`; every other line is dropped. New code passes `logSink`.
   */
  log?: (message: string, error?: unknown) => void;
  /** Telemetry exporter override (tests pass the recording fake); default OTLP/HTTP JSON when configured, else no-op. */
  telemetryExporter?: TelemetryExporter;
  /** `fetch` used by the OTLP exporter (tests pass a fake; the default is the global fetch). */
  telemetryFetch?: typeof fetch;
  /** Key sealing TOTP secrets and keying recovery-code hashes (BE-004); default from `SECOND_FACTOR_SECRET_KEY`. */
  secondFactorKey?: Buffer;
  /** Files module (FILE-001): blob store, URL lifetimes and mandate port; default from `FILES_*` (off unless configured). */
  files?: FilesModuleOptions;
}
export interface CreatedApp {
  app: NestFastifyApplication;
  fastify: FastifyInstance;
  config: ApiConfig;
  ctx: AppContext | null;
  services: IdentityServices | null;
  logger: Logger;
  telemetry: Telemetry;
  readiness: ReadinessProbe;
  close(): Promise<void>;
}

/** Runtime role sanity: the API refuses a superuser or BYPASSRLS connection (RLS would be meaningless). */
export async function assertRuntimeRole(pool: DataPool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const row = rows[0];
  if (!row || row.rolsuper || row.rolbypassrls) throw new Error(`API_DATABASE_URL must use a restricted runtime role (member of trustwork_app), got ${row?.rolname ?? 'unknown'} superuser=${row?.rolsuper} bypassrls=${row?.rolbypassrls}`);
}

export async function createApp(options: CreateAppOptions = {}): Promise<CreatedApp> {
  const env = options.env ?? process.env;
  const config: ApiConfig = { ...apiConfigFromEnv(env), ...options.config };
  const legacy = options.log;
  const sink: LogSink | undefined = options.logSink ?? (legacy ? (line) => { if (line.includes('"level":"error"')) legacy(line); } : undefined);
  const logger = createLogger({ level: config.log.level, ...(sink ? { sink } : {}) });
  const log = messageLogger(logger);
  const telemetry = createTelemetry(config.telemetry, {
    ...(options.telemetryExporter ? { exporter: options.telemetryExporter } : {}),
    ...(options.telemetryFetch ? { fetch: options.telemetryFetch } : {}),
    // A collector outage is reported at most once a minute instead of on every export attempt.
    onError: (() => {
      let last = 0;
      return (error: unknown) => {
        if (Date.now() - last < 60_000) return;
        last = Date.now();
        logger.warn('telemetry.export_failed', { err: error });
      };
    })(),
  });
  let pool: DataPool | null = options.pool ?? null;
  const ownsPool = pool === null && options.pool === undefined && Boolean(env.API_DATABASE_URL || env.DATABASE_URL);
  if (ownsPool) {
    pool = createPool({
      ...databaseConfigFromEnv({ ...env, DATABASE_URL: env.API_DATABASE_URL ?? env.DATABASE_URL }, 'trustwork-api'),
      max: config.database.poolMax,
      statement_timeout: config.database.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.database.idleInTransactionTimeoutMs,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
    });
    pool.on('error', (error) => logger.error('db.pool_error', { err: error }));
    try {
      await assertRuntimeRole(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }
  if (pool) {
    const observed = pool;
    telemetry.observeGauge('db.client.connection.count', '{connection}', 'Connections of the runtime pool by state.', () => [
      { attributes: { 'db.client.connection.state': 'idle' }, value: observed.idleCount },
      { attributes: { 'db.client.connection.state': 'used' }, value: observed.totalCount - observed.idleCount },
    ]);
    telemetry.observeGauge('db.client.connection.pending_requests', '{request}', 'Requests waiting for a runtime pool connection.', () => [{ attributes: {}, value: observed.waitingCount }]);
  }
  const clock = options.clock ?? systemClock;
  const providerFor = (name: 'google' | 'apple'): OidcProviderPort | null => {
    if (options.providers && name in options.providers) return config.providers.mode === 'disabled' ? null : (options.providers[name] ?? null);
    if (config.providers.mode === 'disabled') return null;
    if (config.providers.mode === 'fake') return new FakeOidcProvider(name);
    const client = config.providers[name];
    if (!client) return null;
    return name === 'google' ? new GoogleOidcProvider(client) : new AppleSignInProvider(client);
  };
  const ctx: AppContext | null = pool ? {
    config, pool, clock,
    mail: options.mail ?? new OutboxMail(mailSecretKeyFromEnv(env)),
    providers: { google: providerFor('google'), apple: providerFor('apple') },
    mandates: options.mandates ?? new RecordingMandateRevocation(),
    staffRoles: options.staffRoles ?? noStaffRoles,
    admission: new AdmissionGate(pool),
    secondFactorKey: options.secondFactorKey ?? secondFactorKeyFromEnv(env),
    log,
  } : null;
  const services = ctx ? buildIdentityServices(ctx) : null;

  const adapter = new FastifyAdapter({
    genReqId: (request: { headers: Record<string, string | string[] | undefined> }) => {
      const header = request.headers[REQUEST_ID_HEADER.toLowerCase()];
      const candidate = Array.isArray(header) ? header[0] : header;
      return candidate && IdSchema.safeParse(candidate).success ? candidate : randomUUID();
    },
    // Only configured hops/addresses are trusted for X-Forwarded-For; by default the socket peer is the client.
    trustProxy: trustProxySetting(config),
    bodyLimit: 256 * 1024,
  });
  const files = options.files ?? filesOptionsFromEnv(env);
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(ctx, services, config, files), adapter, { logger: new NestJsonLogger(logger) });
  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  instrumentHttp(fastify, { config, logger, telemetry });
  // The per-route limit must be attached before @fastify/rate-limit's own onRoute hook reads `config.rateLimit`
  // (hooks run in registration order); attached after it, the auth burst limit was silently never applied.
  fastify.addHook('onRoute', (route: RouteOptions) => {
    if (route.url.startsWith('/v1/auth/')) route.config = { ...(route.config as object), rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: 60_000 } };
  });
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyRateLimit, {
    global: false,
    keyGenerator: (request: FastifyRequest) => request.ip,
    // Thrown into the global error filter: an ApiError renders as the 429 `auth.throttled` envelope (a plain object rendered as 500).
    errorResponseBuilder: () => new ApiError('auth.throttled', 'too many requests'),
  });
  // Health routes are plain Fastify routes (no Nest controller, no guard, no rate limit).
  const readiness = createReadinessProbe({
    pool,
    migrationsDir: config.readiness.migrationsDir ?? discoverMigrationsDir(),
    timeoutMs: config.readiness.timeoutMs,
    onError: (error) => logger.warn('health.readiness_check_failed', { err: error }),
  });
  registerHealthRoutes(fastify, () => ({ ...health, externalProviders: config.providers.mode }), readiness);
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, String(request.id));
    if (request.url.startsWith('/v1/')) reply.header('Cache-Control', 'no-store');
    if (services) await services.principals.attach(request, reply);
    else (request as FastifyRequest & { trustwork?: unknown }).trustwork = { requestId: String(request.id), principal: null, session: null, sessionTokenHash: null, client: { userAgentFamily: '', ipPrefix: '', ip: request.ip } };
  });
  const reflector = app.get(Reflector);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalGuards(new CsrfGuard(reflector, config), new AuthGuard(reflector, config, () => clock.now()));
  if (ctx) app.useGlobalInterceptors(new IdempotencyInterceptor(reflector, ctx.pool, config, log, clock));
  app.enableShutdownHooks();
  await app.init();
  await fastify.ready();
  return {
    app, fastify, config, ctx, services, logger, telemetry, readiness,
    async close() {
      await app.close();
      if (pool && ownsPool) await pool.end();
    },
  };
}

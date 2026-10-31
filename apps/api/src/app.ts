import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { apiConfigFromEnv, type ApiConfig } from './config.js';
import { IdSchema, REQUEST_ID_HEADER } from './deps/contracts.js';
import { AdmissionGate, createPool, databaseConfigFromEnv, type DataPool } from './deps/data.js';
import { AppModule } from './app.module.js';
import { AuthGuard } from './common/auth.guard.js';
import { CsrfGuard } from './common/csrf.guard.js';
import { ErrorFilter } from './common/error.filter.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import type { AppContext } from './modules/identity/context.js';
import { buildIdentityServices, type IdentityServices } from './modules/identity/identity.module.js';
import { GoogleOidcProvider } from './modules/identity/providers/google.js';
import { AppleSignInProvider } from './modules/identity/providers/apple.js';
import { FakeMailbox, FakeOidcProvider, noStaffRoles, RecordingMandateRevocation, systemClock, type Clock, type MailPort, type MandateRevocationPort, type OidcProviderPort, type StaffRoleResolver } from './modules/identity/ports.js';

export interface CreateAppOptions {
  config?: Partial<ApiConfig>;
  env?: NodeJS.ProcessEnv;
  /** Runtime pool (a login role that is a member of trustwork_app). Without it only /health is served. */
  pool?: DataPool | null;
  clock?: Clock;
  mail?: MailPort;
  providers?: Partial<Record<'google' | 'apple', OidcProviderPort | null>>;
  mandates?: MandateRevocationPort;
  staffRoles?: StaffRoleResolver;
  log?: (message: string, error?: unknown) => void;
}
export interface CreatedApp {
  app: NestFastifyApplication;
  fastify: FastifyInstance;
  config: ApiConfig;
  ctx: AppContext | null;
  services: IdentityServices | null;
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
  const log = options.log ?? ((message: string, error?: unknown) => console.error(message, error instanceof Error ? error.message : error ?? ''));
  let pool: DataPool | null = options.pool ?? null;
  if (pool === null && options.pool === undefined && (env.API_DATABASE_URL || env.DATABASE_URL)) {
    pool = createPool({ ...databaseConfigFromEnv({ ...env, DATABASE_URL: env.API_DATABASE_URL ?? env.DATABASE_URL }, 'trustwork-api'), max: 10 });
    await assertRuntimeRole(pool);
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
    mail: options.mail ?? new FakeMailbox(config.providers.mode === 'fake' && env.API_LOG_MAIL === '1' ? (m) => console.log(`[mail:${m.template}] to=${m.to} ${JSON.stringify(m.params)}`) : null),
    providers: { google: providerFor('google'), apple: providerFor('apple') },
    mandates: options.mandates ?? new RecordingMandateRevocation(),
    staffRoles: options.staffRoles ?? noStaffRoles,
    admission: new AdmissionGate(pool),
    log,
  } : null;
  const services = ctx ? buildIdentityServices(ctx) : null;

  const adapter = new FastifyAdapter({
    genReqId: (request: { headers: Record<string, string | string[] | undefined> }) => {
      const header = request.headers[REQUEST_ID_HEADER.toLowerCase()];
      const candidate = Array.isArray(header) ? header[0] : header;
      return candidate && IdSchema.safeParse(candidate).success ? candidate : randomUUID();
    },
    trustProxy: env.API_TRUST_PROXY === '1',
    bodyLimit: 256 * 1024,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(ctx, services, config), adapter, { logger: ['error', 'warn'] });
  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyRateLimit, {
    global: false,
    keyGenerator: (request: FastifyRequest) => request.ip,
    errorResponseBuilder: (request: FastifyRequest) => ({ code: 'auth.throttled', message: 'too many requests', requestId: String(request.id) }),
  });
  fastify.addHook('onRoute', (route: RouteOptions) => {
    if (route.url.startsWith('/v1/auth/')) route.config = { ...(route.config as object), rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: 60_000 } };
  });
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, String(request.id));
    if (request.url.startsWith('/v1/')) reply.header('Cache-Control', 'no-store');
    if (services) await services.principals.attach(request, reply);
    else (request as FastifyRequest & { trustwork?: unknown }).trustwork = { requestId: String(request.id), principal: null, session: null, sessionTokenHash: null, client: { userAgentFamily: '', ipPrefix: '', ip: request.ip } };
  });
  const reflector = app.get(Reflector);
  app.useGlobalFilters(new ErrorFilter(log));
  app.useGlobalGuards(new CsrfGuard(reflector, config), new AuthGuard(reflector, config, () => clock.now()));
  if (ctx) app.useGlobalInterceptors(new IdempotencyInterceptor(reflector, ctx.pool, config, log));
  app.enableShutdownHooks();
  await app.init();
  await fastify.ready();
  return {
    app, fastify, config, ctx, services,
    async close() {
      await app.close();
      if (pool && options.pool === undefined) await pool.end();
    },
  };
}

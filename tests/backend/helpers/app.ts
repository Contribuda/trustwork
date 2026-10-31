import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp, type CreateAppOptions, type CreatedApp } from '../../../apps/api/src/app.js';
import type { IdentityServices } from '../../../apps/api/src/modules/identity/identity.module.js';
import { CSRF_HEADER, SESSION_COOKIE } from '@trustwork/contracts';
import { createPool, type DataPool } from '@trustwork/data';
import { FakeOidcProvider, RecordingMandateRevocation, type Clock } from '../../../apps/api/src/modules/identity/ports.js';
import { CommittedMailbox } from '../../worker/mail/helpers/committed-mailbox.js';
import { endPool, provisionTestDatabase, SKIP_REASON, type TestDatabase } from '../../data/helpers/postgres.js';

export { SKIP_REASON, createApp };

/** Adjustable clock: tests move time forward to exercise idle/absolute/step-up windows without sleeping. */
export class TestClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
  reset(): void {
    this.offsetMs = 0;
  }
}

export interface Harness {
  db: TestDatabase;
  /** Runtime pool used by the API (member of trustwork_app). */
  pool: DataPool;
  created: CreatedApp;
  /** Mail intents committed by the API (MAIL-001: mail leaves through the outbox and the worker). */
  mail: CommittedMailbox;
  google: FakeOidcProvider;
  apple: FakeOidcProvider;
  mandates: RecordingMandateRevocation;
  clock: TestClock;
  staff: Map<string, string[]>;
  client(): Client;
  services(): IdentityServices;
  close(): Promise<void>;
}

export interface Response { status: number; body: unknown; headers: Record<string, string | string[] | undefined>; cookies: { name: string; value: string }[] }
export interface RequestOptions { body?: unknown; headers?: Record<string, string>; csrf?: boolean | 'cross-site' | 'origin-only' | 'no-header'; idempotencyKey?: string | null; remoteAddress?: string }

/** HTTP client through Fastify `inject` with a cookie jar; mutations carry the CSRF header and same-origin metadata. */
export class Client {
  readonly jar = new Map<string, string>();
  private keyCounter = 0;
  constructor(private readonly created: CreatedApp) {}

  get sessionCookie(): string | null {
    return this.jar.get(SESSION_COOKIE) ?? null;
  }
  setSessionCookie(value: string | null): void {
    if (value === null) this.jar.delete(SESSION_COOKIE);
    else this.jar.set(SESSION_COOKIE, value);
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': 'trustwork-test/1.0', ...(options.headers ?? {}) };
    if (method !== 'GET' && options.csrf !== false && options.csrf !== 'no-header') headers[CSRF_HEADER] = '1';
    if (method !== 'GET') {
      if (options.csrf === 'cross-site') headers['sec-fetch-site'] = 'cross-site';
      else if (options.csrf === 'origin-only') headers.origin = this.created.config.publicOrigin;
      else if (options.csrf !== 'no-header' && options.csrf !== false) headers['sec-fetch-site'] = 'same-origin';
    }
    if (method !== 'GET' && options.idempotencyKey !== null) headers['idempotency-key'] = options.idempotencyKey ?? `test-${Date.now()}-${++this.keyCounter}`;
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await this.created.fastify.inject({ method, url, headers, ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}), ...(options.body !== undefined ? { payload: options.body as object } : {}) });
    const cookies = (response.cookies as { name: string; value: string; maxAge?: number }[]).map((c) => ({ name: c.name, value: c.value, maxAge: c.maxAge }));
    for (const c of cookies) {
      if (c.value === '' || c.maxAge === 0) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    let body: unknown = null;
    if (response.body) {
      try {
        body = JSON.parse(response.body);
      } catch {
        body = response.body;
      }
    }
    return { status: response.statusCode, body, headers: response.headers as Record<string, string | string[] | undefined>, cookies };
  }
  get(url: string, options?: RequestOptions) {
    return this.request('GET', url, options);
  }
  post(url: string, body?: unknown, options?: RequestOptions) {
    return this.request('POST', url, { ...options, ...(body !== undefined ? { body } : {}) });
  }
}

export async function startHarness(label: string, options: Partial<CreateAppOptions> = {}): Promise<Harness | null> {
  const db = await provisionTestDatabase(label);
  if (!db) return null;
  await db.migrate();
  await db.createAppLogin();
  const pool = db.teardown.watch(createPool({ ...db.appConfig, max: 8 }));
  const mailKeyHex = randomBytes(32).toString('hex');
  const mail = new CommittedMailbox(db.admin, Buffer.from(mailKeyHex, 'hex'));
  const google = new FakeOidcProvider('google');
  const apple = new FakeOidcProvider('apple');
  const mandates = new RecordingMandateRevocation();
  const clock = new TestClock();
  const staff = new Map<string, string[]>();
  const created = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_PROVIDER_MODE: 'fake', AUTH_RATE_LIMIT_PER_MINUTE: '1000', AUTH_LOCKOUT_THRESHOLD: '5', MAIL_SECRET_KEY: mailKeyHex },
    pool, clock, mandates, providers: { google, apple }, staffRoles: async (personId) => staff.get(personId) ?? [],
    // Structured API log lines: only failures are printed, so a failing test still shows the server-side stack.
    logSink: (line) => {
      if (line.includes('"level":"error"')) console.error('[api]', line);
    },
    ...options,
  });
  return {
    db, pool, created, mail, google, apple, mandates, clock, staff,
    client: () => new Client(created),
    services: () => created.services as IdentityServices,
    /** Call after every request of the file has settled: the app stops first, then its pool closes every connection, then the database is dropped. */
    async close() {
      await created.close();
      await endPool(pool).catch(() => undefined);
      await db.close();
    },
  };
}

export const admin = (h: Harness): pg.Pool => h.db.admin;
export function expectError(response: Response, status: number, code: string): void {
  const body = response.body as { code?: string };
  if (response.status !== status || body?.code !== code) throw new Error(`expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body)}`);
}

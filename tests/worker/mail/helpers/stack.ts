import { randomBytes } from 'node:crypto';
import { createApp, type CreatedApp } from '../../../../apps/api/src/app.js';
import { FakeOidcProvider } from '../../../../apps/api/src/modules/identity/ports.js';
import { buildRegistry } from '../../../../apps/worker/src/main.js';
import { createMailTransport, mailConfigFromEnv, type MailConfig, type MailTransport } from '../../../../apps/worker/src/mail/index.js';
import { Metrics, silentLogger, Worker, type WorkerConfig } from '../../../../apps/worker/src/index.js';
import type { DataPool } from '@trustwork/data';
import { Client, type Harness } from '../../../backend/helpers/app.js';
import { endPool } from '../../../data/helpers/postgres.js';
import { provisionWorkerDatabase, type WorkerTestDatabase } from '../../helpers/worker-db.js';
import { CommittedMailbox } from './committed-mailbox.js';
import { SmtpSink } from './smtp-sink.js';

export const ORIGIN = 'https://trustwork.test';

export interface MailStack {
  env: WorkerTestDatabase;
  app: CreatedApp;
  sink: SmtpSink;
  keyHex: string;
  mailbox: CommittedMailbox;
  google: FakeOidcProvider;
  client(): Client;
  /** Harness-shaped view for the backend persona helpers (they only use `db`). */
  harness: Harness;
  mailConfig(overrides?: Record<string, string>): MailConfig;
  /** A worker on its own pool with the production registry (buildRegistry) and the SMTP transport to the sink. */
  worker(options?: { mail?: Record<string, string>; config?: Partial<WorkerConfig>; transport?: MailTransport }): { worker: Worker; metrics: Metrics; transport: MailTransport };
  close(): Promise<void>;
}

/** Real PostgreSQL (API login, worker login), the API app and a local SMTP sink; null without a database backend. */
export async function startMailStack(label: string): Promise<MailStack | null> {
  const env = await provisionWorkerDatabase(label);
  if (!env) return null;
  // Every pool of this file is watched by the teardown guard and closed with endPool before the database is dropped.
  const pools: DataPool[] = [env.db.teardown.watch(env.apiPool)];
  const openWorkerPool = env.workerPool.bind(env);
  env.workerPool = (max?: number) => {
    const pool = env.db.teardown.watch(openWorkerPool(max));
    pools.push(pool);
    return pool;
  };
  const sink = await new SmtpSink().start();
  const keyHex = randomBytes(32).toString('hex');
  const google = new FakeOidcProvider('google');
  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: ORIGIN, AUTH_PROVIDER_MODE: 'fake', AUTH_RATE_LIMIT_PER_MINUTE: '10000', MAIL_SECRET_KEY: keyHex },
    pool: env.apiPool,
    providers: { google, apple: new FakeOidcProvider('apple') },
    logSink: (line) => {
      if (line.includes('"level":"error"')) console.error('[api]', line);
    },
  });
  const workers: Worker[] = [];
  const mailConfig = (overrides: Record<string, string> = {}) => mailConfigFromEnv({
    MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: String(sink.port), MAIL_SMTP_SECURITY: 'none', MAIL_SECRET_KEY: keyHex,
    MAIL_PUBLIC_ORIGIN: ORIGIN, MAIL_FROM_ADDRESS: 'no-reply@trustwork.test', MAIL_SMTP_CONNECT_TIMEOUT_MS: '300', MAIL_SMTP_COMMAND_TIMEOUT_MS: '300', MAIL_SMTP_DATA_TIMEOUT_MS: '300',
    ...overrides,
  });
  const stack: MailStack = {
    env, app, sink, keyHex, google,
    mailbox: new CommittedMailbox(env.db.admin, Buffer.from(keyHex, 'hex')),
    client: () => new Client(app),
    harness: { db: env.db } as unknown as Harness,
    mailConfig,
    worker(options = {}) {
      const pool = env.workerPool(8);
      const metrics = new Metrics();
      const mail = mailConfig(options.mail);
      const transport = options.transport ?? createMailTransport(mail);
      const registry = buildRegistry({ pool, metrics, log: silentLogger, mail, mailTransport: transport });
      const worker = new Worker({ pool, registry, metrics, config: { pollIntervalMs: 50, concurrency: 4, ...options.config }, tasks: () => [], random: () => 0 });
      workers.push(worker);
      return { worker, metrics, transport };
    },
    async close() {
      for (const worker of workers) await worker.stop(200).catch(() => undefined);
      await app.close();
      await sink.stop();
      env.db.teardown.begin();
      await Promise.all(pools.map((pool) => endPool(pool).catch(() => undefined)));
      await env.close();
    },
  };
  return stack;
}

/** Runs iterations until the outbox is drained and no job is due (jobs retrying later are left alone). */
export async function drain(worker: Worker, maxIterations = 50): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxIterations && quiet < 2; i += 1) {
    const report = await worker.runOnce({ rethrow: true });
    await worker.idle();
    quiet = report.relayed === 0 && report.leased === 0 ? quiet + 1 : 0;
  }
}

export const signupBody = (email: string, name = 'Mail Tester') => ({ name, email, password: 'correct horse battery staple 42', acceptedTermsVersion: 'draft-2026-10' });

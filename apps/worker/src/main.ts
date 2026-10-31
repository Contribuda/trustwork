import type { DataPool } from '@trustwork/data';
import { workerConfigFromEnv } from './config.js';
import { assertWorkerRole, createWorkerPool } from './db.js';
import { HandlerRegistry } from './handlers.js';
import { describeError, jsonLogger, type Logger } from './log.js';
import { assertDictionariesComplete, createMailTransport, mailConfigFromEnv, mailSettleTask, registerMail, type MailConfig, type MailTransport } from './mail/index.js';
import { Metrics, startMetricsServer, type MetricsServer } from './metrics.js';
import { expireLeasesTask, partitionsTask, sweepTask } from './scheduler.js';
import { Worker } from './worker.js';

/**
 * Worker entry point.
 *
 *   WORKER_DATABASE_URL=postgresql://<worker login>@.../trustwork npm run start -w @trustwork/worker
 *
 * Domain handlers are registered here by the packages that own them: MAIL-001 mail delivery (`mail.requested`,
 * `mail.deliver`, `mail.feedback`, the `mail.settle` task); search projections and other consumers come later. Events
 * of other types are marked published and counted as `unhandled`; the rows stay in the outbox for consumers added later.
 */
export interface Domains { pool: DataPool; metrics: Metrics; log: Logger; mail: MailConfig; mailTransport: MailTransport }
export function buildRegistry(domains: Domains): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerMail(registry, { pool: domains.pool, config: domains.mail, transport: domains.mailTransport, log: domains.log, metrics: domains.metrics });
  return registry;
}

async function main(): Promise<void> {
  const log = jsonLogger();
  const { databaseUrl, config } = workerConfigFromEnv(process.env);
  const mail = mailConfigFromEnv(process.env);
  assertDictionariesComplete(mail.render.locales);
  const pool = createWorkerPool(databaseUrl, config.concurrency + 4);
  const login = await assertWorkerRole(pool);
  const metrics = new Metrics();
  const mailTransport = createMailTransport(mail);
  const registry = buildRegistry({ pool, metrics, log, mail, mailTransport });
  const worker = new Worker({
    pool, registry, config, log, metrics,
    tasks: (deps) => [expireLeasesTask(deps), sweepTask(deps), partitionsTask(deps), mailSettleTask({ pool, metrics })],
  });
  log('info', 'mail configured', { transport: mail.transport, locales: mail.render.locales.join(','), defaultLocale: mail.render.defaultLocale });
  let metricsServer: MetricsServer | null = null;
  if (config.metrics.port !== null) {
    metricsServer = await startMetricsServer(config.metrics.host, config.metrics.port, () => worker.renderMetrics());
    log('info', 'metrics listening', { host: config.metrics.host, port: metricsServer.port });
  }
  log('info', 'database role verified', { login });
  worker.start();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown requested', { signal, graceMs: config.shutdownGraceMs });
    worker.stop()
      .then(() => metricsServer?.close())
      .then(() => pool.end())
      .then(() => process.exit(0), (error: unknown) => {
        log('error', 'shutdown failed', { error: describeError(error) });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', service: 'trustwork-worker', message: 'worker failed to start', error: describeError(error) })}\n`);
    process.exit(1);
  });
}

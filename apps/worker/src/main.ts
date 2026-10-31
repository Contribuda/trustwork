import { workerConfigFromEnv } from './config.js';
import { assertWorkerRole, createWorkerPool } from './db.js';
import { HandlerRegistry } from './handlers.js';
import { describeError, jsonLogger } from './log.js';
import { startMetricsServer, type MetricsServer } from './metrics.js';
import { Worker } from './worker.js';

/**
 * Worker entry point.
 *
 *   WORKER_DATABASE_URL=postgresql://<worker login>@.../trustwork npm run start -w @trustwork/worker
 *
 * Domain handlers are registered here by the packages that own them (MAIL-001 mail delivery, search projections, …).
 * Today only the built-in outbox redelivery job is registered: events of other types are marked published and counted
 * as `unhandled`; the rows stay in the partitioned outbox for consumers added later.
 */
export function buildRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}

async function main(): Promise<void> {
  const log = jsonLogger();
  const { databaseUrl, config } = workerConfigFromEnv(process.env);
  const pool = createWorkerPool(databaseUrl, config.concurrency + 4);
  const login = await assertWorkerRole(pool);
  const worker = new Worker({ pool, registry: buildRegistry(), config, log });
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

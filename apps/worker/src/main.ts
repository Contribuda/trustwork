import type { DataPool } from '@trustwork/data';
import { workerConfigFromEnv } from './config.js';
import { assertWorkerRole, createWorkerPool } from './db.js';
import { HandlerRegistry } from './handlers.js';
import { describeError, jsonLogger, type Logger } from './log.js';
import { assertDictionariesComplete, createMailTransport, mailConfigFromEnv, mailSettleTask, registerMail, type MailConfig, type MailTransport } from './mail/index.js';
import { Metrics, startMetricsServer, type MetricsServer } from './metrics.js';
import { filesExpireUploadsTask, registerFiles, scannerFromEnv, type FilesRuntime } from './files/index.js';
import { blobStoreFromEnv } from '../../../packages/data/src/files/index.js';
import { expireLeasesTask, partitionsTask, sweepTask } from './scheduler.js';
import { assistantSweepTask, fakeEffectProviders, registerAssistant, type AssistantRuntime } from './assistant/index.js';
import { rangesAgeTask, registerScreeningLists, screeningFreshnessTask, screeningListsConfigFromEnv, screeningListsDueTask, type ScreeningListsRuntime } from './screening-lists/index.js';
import { Worker } from './worker.js';

/**
 * Worker entry point.
 *
 *   WORKER_DATABASE_URL=postgresql://<worker login>@.../trustwork npm run start -w @trustwork/worker
 *
 * Domain handlers are registered here by the packages that own them: MAIL-001 mail delivery (`mail.requested`,
 * `mail.deliver`, `mail.feedback`, the `mail.settle` task), FILE-001 files and SANC-002 screening lists
 * (`screening.list_ingest`, the `screening.lists_due`, `screening.lists_freshness` and `jurisdiction.ranges_age` tasks);
 * search projections and other consumers come later. Events of other types are marked published and counted as
 * `unhandled`; the rows stay in the outbox for consumers added later.
 */
export interface Domains { pool: DataPool; metrics: Metrics; log: Logger; mail: MailConfig; mailTransport: MailTransport; files?: Pick<FilesRuntime, 'store' | 'tombstones' | 'scanner'> | null; assistant?: AssistantRuntime | null; screeningLists?: ScreeningListsRuntime | null }
export function buildRegistry(domains: Domains): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerMail(registry, { pool: domains.pool, config: domains.mail, transport: domains.mailTransport, log: domains.log, metrics: domains.metrics });
  // FILE-001: only with configured storage (FILES_STORAGE); scans only with a configured scanner (FILES_SCANNER).
  if (domains.files) registerFiles(registry, { pool: domains.pool, log: domains.log, metrics: domains.metrics, ...domains.files });
  // AST-001: agent action dispatch and reconciliation; only fake effect providers exist (ASSISTANT_EFFECTS=fake).
  if (domains.assistant) registerAssistant(registry, domains.assistant);
  // SANC-002: sanctions list ingestion. `live` lists refuse until KEYS-001 supplies the egress fetcher and activations.
  if (domains.screeningLists) registerScreeningLists(registry, domains.screeningLists);
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
  const storage = blobStoreFromEnv(process.env);
  const files = storage ? { ...storage, scanner: scannerFromEnv(process.env) } : null;
  if (files && !files.scanner) log('warn', 'files storage configured without a scanner: uploads stay pending until FILES_SCANNER is set');
  const hubValue = process.env.TRUSTWORK_HUB_ID?.trim() ?? '';
  const hubId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hubValue) ? hubValue : null;
  const assistant: AssistantRuntime | null = process.env.ASSISTANT_EFFECTS === 'fake' ? { pool, providers: fakeEffectProviders().all, hubId, log } : null;
  const screeningLists: ScreeningListsRuntime = { pool, metrics, log, config: screeningListsConfigFromEnv(process.env) };
  const registry = buildRegistry({ pool, metrics, log, mail, mailTransport, files, assistant, screeningLists });
  const worker = new Worker({
    pool, registry, config, log, metrics,
    tasks: (deps) => [expireLeasesTask(deps), sweepTask(deps), partitionsTask(deps), mailSettleTask({ pool, metrics }), ...(files ? [filesExpireUploadsTask({ pool, store: files.store, metrics })] : []), ...(assistant ? [assistantSweepTask(assistant)] : []),
      screeningListsDueTask(screeningLists), screeningFreshnessTask(screeningLists), rangesAgeTask({ env: process.env, log, metrics })],
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

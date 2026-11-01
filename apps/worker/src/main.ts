import { blobStoreFromEnv } from '../../../packages/data/src/files/index.js';
import type { DataPool } from '@trustwork/data';
import { agentOccurrencesTask, registerAgentOccurrences } from './agent-modules/index.js';
import { assistantSweepTask, fakeEffectProviders, registerAssistant, type AssistantRuntime } from './assistant/index.js';
import { workerConfigFromEnv } from './config.js';
import { consultationRemindersTask, registerConsultationReminders, ReminderChannelFake, type ReminderRuntime } from './consultations/reminders.js';
import { registerContent } from './content/index.js';
import { assertWorkerRole, createWorkerPool } from './db.js';
import { filesExpireUploadsTask, registerFiles, scannerFromEnv, type FilesRuntime } from './files/index.js';
import { HandlerRegistry } from './handlers.js';
import { describeError, jsonLogger, type Logger } from './log.js';
import { assertDictionariesComplete, createMailTransport, mailConfigFromEnv, mailSettleTask, registerMail, type MailConfig, type MailTransport } from './mail/index.js';
import { Metrics, startMetricsServer, type MetricsServer } from './metrics.js';
import { paymentReconcileTask, registerPayments, type PaymentRuntime } from './payments/index.js';
import { startPaymentIngress } from './payments/ingress.js';
import { PaymentProviders } from './payments/provider.js';
import { providersSecretSweepTask } from './providers/index.js';
import { registerRescreen, rescreenConfigFromEnv, rescreenTickTask, rescreenWeeklyTask, type RescreenRuntime } from './rescreen/index.js';
import { expireLeasesTask, partitionsTask, sweepTask } from './scheduler.js';
import { rangesAgeTask, registerScreeningLists, screeningFreshnessTask, screeningListsConfigFromEnv, screeningListsDueTask, type ScreeningListsRuntime } from './screening-lists/index.js';
import { registerScreening, screeningConfigFromEnv, screeningSweepTask, type ScreeningRuntime } from './screening/index.js';
import { Worker } from './worker.js';

/**
 * Worker entry point.
 *
 *   WORKER_DATABASE_URL=postgresql://<worker login>@.../trustwork npm run start -w @trustwork/worker
 *
 * Domain handlers are registered here by the packages that own them: MAIL-001 mail delivery (`mail.requested`,
 * `mail.deliver`, `mail.feedback`, the `mail.settle` task), FILE-001 files, SANC-002 screening lists
 * (`screening.list_ingest`, the `screening.lists_due`, `screening.lists_freshness` and `jurisdiction.ranges_age` tasks)
 * SANC-003 screening (the trigger handlers, `screening.screen_subject` and the `screening.names_sweep` task) and SANC-005
 * re-screening (`screening.rescreen_batch`, the `screening.rescreen_tick` and `screening.rescreen_weekly` tasks) and KEYS-001
 * providers (the `providers.secrets_destroy` task);
 * search projections and other consumers come later. Events of other types are marked published and counted as
 * `unhandled`; the rows stay in the outbox for consumers added later.
 */
export interface Domains { payments?: PaymentRuntime; consultations?: ReminderRuntime | null; contentRenderer?: boolean; pool: DataPool; metrics: Metrics; log: Logger; mail: MailConfig; mailTransport: MailTransport; files?: Pick<FilesRuntime, 'store' | 'tombstones' | 'scanner'> | null; assistant?: AssistantRuntime | null; screeningLists?: ScreeningListsRuntime | null; screening?: ScreeningRuntime | null; rescreen?: RescreenRuntime | null }
export function buildRegistry(domains: Domains): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerAgentOccurrences(registry);
  // AST-001: agent action dispatch and reconciliation; only fake effect providers exist (ASSISTANT_EFFECTS=fake).
  if (domains.assistant) registerAssistant(registry, domains.assistant);
  // CONS-001: existing consultation context reminders; only a recording channel fake is configured.
  if (domains.consultations) registerConsultationReminders(registry, domains.consultations);
  if (domains.contentRenderer) registerContent(registry);
  // FILE-001: only with configured storage (FILES_STORAGE); scans only with a configured scanner (FILES_SCANNER).
  if (domains.files) registerFiles(registry, { pool: domains.pool, log: domains.log, metrics: domains.metrics, ...domains.files });
  registerMail(registry, { consultationHubId: domains.consultations?.hubId ?? null, pool: domains.pool, config: domains.mail, transport: domains.mailTransport, log: domains.log, metrics: domains.metrics });
  registerPayments(registry, domains.payments ?? { pool: domains.pool, providers: new PaymentProviders() });
  // SANC-005: re-screening of every subject on each activated list version, weekly and on a compliance officer's request.
  if (domains.rescreen) registerRescreen(registry, domains.rescreen);
  // SANC-003: screening of persons and companies; the fuzzy layer stays off unless SCREENING_FUZZY_THRESHOLD is set.
  if (domains.screening) registerScreening(registry, domains.screening);
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
  const hubId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hubValue) ? hubValue.toLowerCase() : null;
  const assistant: AssistantRuntime | null = process.env.ASSISTANT_EFFECTS === 'fake' ? { pool, providers: fakeEffectProviders().all, hubId, log } : null;
  const screeningLists: ScreeningListsRuntime = { pool, metrics, log, config: screeningListsConfigFromEnv(process.env) };
  const screening: ScreeningRuntime = { pool, metrics, log, config: screeningConfigFromEnv(process.env) };
  const rescreen: RescreenRuntime = { pool, metrics, log, config: rescreenConfigFromEnv(process.env), screening: screening.config };
  const consultations: ReminderRuntime | null = hubId ? { pool, hubId, render: mail.render, channels: new ReminderChannelFake() } : null;
  const payments: PaymentRuntime = { pool, providers: new PaymentProviders() };
  const paymentIngress = process.env.PAYMENTS_WEBHOOK_PORT ? await startPaymentIngress(payments, Number(process.env.PAYMENTS_WEBHOOK_PORT)) : null;
  const registry = buildRegistry({ payments, consultations, contentRenderer: process.env.CONTENT_PDF_RENDERER === 'local', pool, metrics, log, mail, mailTransport, files, assistant, screeningLists, screening, rescreen });
  const worker = new Worker({
    pool, registry, config, log, metrics,
    tasks: (deps) => [agentOccurrencesTask(pool), expireLeasesTask(deps), sweepTask(deps), partitionsTask(deps),
    tasks: (deps) => [paymentReconcileTask(payments), expireLeasesTask(deps), sweepTask(deps), partitionsTask(deps),
      ...(assistant ? [assistantSweepTask(assistant)] : []),
      ...(consultations ? [consultationRemindersTask(consultations)] : []),
      ...(files ? [filesExpireUploadsTask({ pool, store: files.store, metrics })] : []),
      mailSettleTask({ pool, metrics }), providersSecretSweepTask({ pool, metrics }),
      rescreenTickTask(rescreen), rescreenWeeklyTask(rescreen), screeningSweepTask(screening),
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
      .then(() => paymentIngress?.close())
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

/** Local fault-injection process: production mail handler, recording fake transport, no network provider. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createWorkerPool, HandlerRegistry, Metrics, silentLogger, Worker } from '../../../apps/worker/src/index.js';
import { mailConfigFromEnv, registerMail } from '../../../apps/worker/src/mail/index.js';
import { drain } from '../../worker/mail/helpers/stack.js';

const pool = createWorkerPool(process.env.WORKER_DATABASE_URL!, 4);
const registry = new HandlerRegistry();
registerMail(registry, {
  pool, config: mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid' }),
  metrics: new Metrics(), log: silentLogger,
  transport: { name: 'fake', maxDurationMs: 600_000, async send(mail) {
    appendFileSync(process.env.SANC_NOTICE_LEDGER!, `${mail.messageId}\n`);
    writeFileSync(process.env.SANC_NOTICE_READY!, 'effect recorded');
    return new Promise<never>(() => {});
  } },
});
setInterval(() => {}, 1_000);
const worker = new Worker({ pool, registry, config: { concurrency: 1, leaseSeconds: 2, heartbeatMs: 300 }, tasks: () => [] });
void drain(worker);

/** Separate-process recording worker. Local test credentials travel only over IPC, never logs or argv. */
import { createPool } from '@trustwork/data';
import type { PoolConfig } from 'pg';
import { buildRegistry } from '../../../apps/worker/src/main.js';
import { consultationRemindersTask, produceReminder, ReminderChannelFake } from '../../../apps/worker/src/consultations/reminders.js';
import { Scheduler } from '../../../apps/worker/src/scheduler.js';
import { inTransaction } from '../../../apps/worker/src/db.js';
import { FakeMailTransport, mailConfigFromEnv } from '../../../apps/worker/src/mail/index.js';
import { Metrics, silentLogger, Worker } from '../../../apps/worker/src/index.js';
import { drain } from '../../worker/mail/helpers/stack.js';

interface Command { id: number; action: 'init' | 'produce' | 'tick' | 'drain' | 'release' | 'close'; config?: PoolConfig; hubId?: string; reminderId?: string; holdId?: string }
let execute: ((command: Command) => Promise<unknown>) | undefined;
let release: (() => void) | undefined;
process.on('message', (command: Command) => {
  if (command.action === 'release') { release?.(); return; }
  void (async () => {
    if (command.action === 'init') {
      const pool = createPool({ ...command.config, max: 4 });
      const mail = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_RECIPIENT_LIMIT_PER_HOUR: '1000', MAIL_SEND_LIMIT_PER_MINUTE: '1000' });
      const transport = new FakeMailTransport();
      const channels = new ReminderChannelFake();
      const runtime = { pool, hubId: command.hubId!, render: mail.render, channels };
      let holdId: string | undefined;
      const barrier = async (id: string) => {
        if (id !== holdId) return;
        await new Promise<void>((resolve) => { release = resolve; process.send!({ event: 'at-effect', deliveryId: id }); });
        holdId = undefined;
      };
      const sendMail = transport.send.bind(transport);
      transport.send = async (message, signal) => { await barrier(message.headers['X-Entity-Ref-ID']!); return sendMail(message, signal); };
      const sendChannel = channels.send.bind(channels);
      channels.send = async (message) => { await barrier(message.deliveryId); return sendChannel(message); };
      const registry = buildRegistry({ pool, mail, mailTransport: transport, consultations: runtime, log: silentLogger, metrics: new Metrics() });
      const worker = new Worker({ pool, registry, metrics: new Metrics(), tasks: () => [], config: { concurrency: 1, pollIntervalMs: 10 } });
      execute = async (c) => {
        if (c.action === 'produce') return inTransaction(pool, (trx) => produceReminder(trx, runtime, c.reminderId!));
        if (c.action === 'tick') return new Scheduler({ pool, registry, config: worker.config, metrics: new Metrics(), log: silentLogger }, [consultationRemindersTask(runtime)]).tick();
        if (c.action === 'close') { await worker.stop(1000); await pool.end(); return null; }
        holdId = c.holdId;
        await drain(worker);
        return { mail: transport.sent.map((m) => ({ id: m.headers['X-Entity-Ref-ID'], text: m.text })), channels: channels.sent.map((m) => ({ id: m.deliveryId, text: m.text })) };
      };
      return null;
    }
    return execute!(command);
  })().then((result) => {
    process.send!({ id: command.id, result }, () => { if (command.action === 'close') process.disconnect(); });
  }).catch(() => { process.send!({ id: command.id, error: 'recording worker command failed' }); });
});

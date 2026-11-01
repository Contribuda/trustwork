import { randomUUID } from 'node:crypto';
import { jobs, type DataPool, type Transaction } from '@trustwork/data';
import { consultationCommunications as comms } from '../../../../packages/data/src/repositories/communications.js';
import { renderTemplateText } from '../../../../packages/contracts/src/communications.js';
import type { ChannelOutcome, OutboundChannelMessage } from '../../../api/src/modules/communications/channels.js';
import { inTransaction } from '../db.js';
import { RetryableJobError, type HandlerRegistry } from '../handlers.js';
import type { ScheduledTask } from '../scheduler.js';
import { brandFor, type RenderConfig } from '../mail/templates.js';

export const CONSULTATION_NOTIFY = 'consultation.notify';
/** Worker-owned recording fake: the worker image contains no API runtime files. Types are shared only at compile time. */
export class ReminderChannelFake {
  readonly sent: OutboundChannelMessage[] = [];
  private readonly scripted: ChannelOutcome[] = [];
  private readonly outcomes = new Map<string, ChannelOutcome>();
  script(...outcomes: ChannelOutcome[]): void { this.scripted.push(...outcomes); }
  async send(message: OutboundChannelMessage): Promise<ChannelOutcome> {
    const previous = this.outcomes.get(message.deliveryId);
    if (previous) return previous;
    const outcome = this.scripted.shift() ?? { kind: 'accepted' as const, providerRef: `fake-${randomUUID()}` };
    if (outcome.kind !== 'failed') {
      this.sent.push(message);
      this.outcomes.set(message.deliveryId, outcome);
    }
    return outcome;
  }
}
/** Only this recording adapter is supported. No real messenger provider is configured by this module. */
export interface ReminderRuntime { pool: DataPool; hubId: string; render: RenderConfig; channels: ReminderChannelFake }
/** Match COMMS-001: recipient's exact language, then its language family, then the configured hub default. */
function pickLocale(preferences: readonly string[], available: readonly string[], fallback: string): string | null {
  for (const preference of preferences) {
    const exact = available.find((tag) => tag.toLowerCase() === preference.toLowerCase());
    if (exact) return exact;
    const same = available.find((tag) => tag.split('-')[0]!.toLowerCase() === preference.split('-')[0]!.toLowerCase());
    if (same) return same;
  }
  return available.find((tag) => tag.toLowerCase() === fallback.toLowerCase()) ?? null;
}
const params = { contextKind: 'agreement', threadSubject: '', authorName: '' };
async function textFor(trx: Transaction, runtime: ReminderRuntime, languages: readonly string[]) {
  const texts = await comms.templates(trx, runtime.hubId);
  const locale = pickLocale(languages, texts.map((t) => t.locale), runtime.render.defaultLocale);
  const template = texts.find((t) => t.locale === locale);
  if (!template || !locale) return null;
  const values = { ...params, brand: brandFor(runtime.render, locale) };
  return { locale, subject: renderTemplateText(template.subject, values), body: renderTemplateText(template.body, values) };
}

/** One atomic local effect: message, preference-filtered fanout, local receipt, mail intents/jobs and sent marking. */
export async function produceReminder(trx: Transaction, runtime: ReminderRuntime, id: string): Promise<boolean> {
  if (!(await comms.forHub(trx, id, 'reminder', runtime.hubId))) return false;
  const text = await textFor(trx, runtime, [runtime.render.defaultLocale]);
  if (!text) return false; // Unactivated/incomplete governed copy leaves the durable reminder scheduled.
  const planned = await comms.produce(trx, id, runtime.hubId, text.body);
  for (const item of planned) {
    const recipientText = await textFor(trx, runtime, item.languages);
    if (!recipientText) throw new Error('active template changed during reminder production');
    if (item.channel === 'email') await comms.enqueueMail(trx, item.delivery_id, recipientText.locale, recipientText.subject, recipientText.body);
    else {
      const job = await jobs.enqueue(trx, { kind: `${CONSULTATION_NOTIFY}.${runtime.hubId}`, payload: { deliveryId: item.delivery_id } });
      await comms.channelJob(trx, item.delivery_id, job.id);
    }
  }
  return true;
}

/** The scheduled row is the durable local work item; a crash rolls back the whole effect and the next tick retries. */
export function consultationRemindersTask(runtime: ReminderRuntime): ScheduledTask {
  return {
    name: `consultation.reminders.${runtime.hubId}`, intervalSeconds: 60,
    run: async () => {
      const reconciled = await inTransaction(runtime.pool, (trx) => comms.reconcileChannels(trx));
      const due = await inTransaction(runtime.pool, (trx) => comms.due(trx, runtime.hubId));
      let attempted = 0;
      for (const id of due) if (await inTransaction(runtime.pool, (trx) => produceReminder(trx, runtime, id))) attempted++;
      return { attempted, reconciled };
    },
  };
}

export function registerConsultationReminders(registry: HandlerRegistry, runtime: ReminderRuntime): void {
  registry.onJob<{ deliveryId: string }>({
    kind: `${CONSULTATION_NOTIFY}.${runtime.hubId}`, mode: 'external',
    parse(value) {
      const id = (value as { deliveryId?: unknown } | null)?.deliveryId;
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('expected a delivery UUID');
      return { deliveryId: id };
    },
    run: async (context) => {
      const id = context.payload.deliveryId;
      if (!(await inTransaction(runtime.pool, (trx) => comms.forHub(trx, id, 'channel', runtime.hubId)))) {
        throw new RetryableJobError('consultation delivery requires its source hub worker');
      }
      const job = context.job.id;
      const fence = String(context.job.fencing_token);
      // Persist uncertainty before the adapter can run. Only reconciliation can make this leased job run again.
      const claimed = await inTransaction(runtime.pool, (trx) => comms.claimChannel(trx, id, job, fence, runtime.hubId));
      if (!claimed) {
        await inTransaction(runtime.pool, (trx) => comms.settleChannel(trx, id, job, fence, 'skipped', null));
        return;
      }
      const outcome = await inTransaction(runtime.pool, async (trx) => {
        const current = await comms.claimChannel(trx, id, job, fence, runtime.hubId);
        if (!current) { await comms.settleChannel(trx, id, job, fence, 'skipped', null); return null; }
        const text = await textFor(trx, runtime, current.languages);
        if (!text) { await comms.settleChannel(trx, id, job, fence, 'skipped', null); return null; }
        context.signal.throwIfAborted();
        // Locks keep cancellation, licence revocation, membership/grant revocation and sanctions changes ordered
        // through final dispatch. deliveryId is the stable adapter identity across explicit reconciliation.
        const result = await runtime.channels.send({ ...current, text: text.body, replyToken: null });
        await comms.settleChannel(trx, id, job, fence, result.kind === 'accepted' ? 'sent' : result.kind === 'failed' ? 'failed' : 'outcome_unknown', result.kind === 'accepted' ? result.providerRef : null);
        return result;
      });
      if (outcome?.kind === 'unknown') throw new Error('consultation channel outcome unknown; reconcile before retry');
    },
  });
}

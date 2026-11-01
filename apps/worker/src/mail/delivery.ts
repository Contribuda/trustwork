import { sql } from 'kysely';
import { consultationCommunications } from '../../../../packages/data/src/repositories/communications.js';
import { deriveMailSecretKey, inbox, jobs, MAIL_AGGREGATE, MAIL_REQUESTED, mailDeliveries, suppressions, unsealMailSecret, type DataPool, type MailDelivery, type Transaction } from '@trustwork/data';
import { inTransaction } from '../db.js';
import { PermanentJobError, RetryableJobError, type HandlerRegistry, type JobContext } from '../handlers.js';
import { describeError, type Logger } from '../log.js';
import type { Metrics } from '../metrics.js';
import type { ScheduledTask } from '../scheduler.js';
import type { MailConfig } from './config.js';
import { renderMail, TEMPLATE_SPECS, type RenderedMail } from './templates.js';
import { MailRejectedError, MailTemporaryError, type MailTransport, type OutgoingMail } from './transport.js';

export const MAIL_ENQUEUE_HANDLER = 'mail.enqueue_delivery';
export const MAIL_DELIVER_KIND = 'mail.deliver';
export const MAIL_FEEDBACK_KIND = 'mail.feedback';
export const MAIL_SETTLE_TASK = 'mail.settle';
/** Attempts of one delivery job (retryable failures only: 4xx, network, hub send rate). */
export const MAIL_DELIVER_ATTEMPTS = 8;

export const MAIL_METRICS = {
  deliveries: ['trustwork_mail_deliveries_total', 'Mail delivery attempts by template and result (sent, suppressed, rate_limited, expired, failed, retried, throttled, unknown, duplicate).'],
  feedback: ['trustwork_mail_feedback_total', 'Transport feedback receipts by kind (delivered, soft_bounce, hard_bounce, complaint, duplicate, unknown_delivery).'],
  settled: ['trustwork_mail_settled_total', 'Deliveries settled by the housekeeping task, by outcome.'],
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SMTP replies may echo the address; it never reaches a log line or a job row. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s<>()"',;:@]+@[^\s<>()"',;:@]+/g, '<address>');
}

export interface MailRuntime {
  pool: DataPool;
  config: MailConfig;
  transport: MailTransport;
  log: Logger;
  metrics: Metrics;
}

export interface DeliverPayload { deliveryId: string }
function parseDeliver(payload: unknown): DeliverPayload {
  const value = payload as Partial<DeliverPayload> | null;
  if (!value || typeof value.deliveryId !== 'string' || !UUID.test(value.deliveryId)) throw new Error('expected { deliveryId: uuid }');
  return { deliveryId: value.deliveryId };
}

/**
 * Transport feedback normalised from any provider (webhook, DSN parser, the SMTP RCPT refusal): `eventId` is the
 * provider's own event id (deduplicated in inbox_receipt), `deliveryId` comes from our Message-ID.
 */
export interface MailFeedbackEvent {
  provider: string;
  eventId: string;
  kind: 'delivered' | 'bounce' | 'complaint';
  /** For bounces: `hard` (permanent, suppresses the address) or `soft` (temporary). */
  bounce?: 'hard' | 'soft';
  deliveryId: string;
  occurredAt?: string;
}
export function parseFeedback(payload: unknown): MailFeedbackEvent {
  const value = payload as Partial<MailFeedbackEvent> | null;
  if (!value || typeof value.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,40}$/.test(value.provider)) throw new Error('feedback.provider must match [a-z][a-z0-9_-]{0,40}');
  if (typeof value.eventId !== 'string' || !/^[\x21-\x7e]{1,150}$/.test(value.eventId)) throw new Error('feedback.eventId must be 1-150 printable ASCII characters');
  if (value.kind !== 'delivered' && value.kind !== 'bounce' && value.kind !== 'complaint') throw new Error('feedback.kind must be delivered, bounce or complaint');
  if (value.kind === 'bounce' && value.bounce !== 'hard' && value.bounce !== 'soft') throw new Error('feedback.bounce must be hard or soft');
  if (typeof value.deliveryId !== 'string' || !UUID.test(value.deliveryId)) throw new Error('feedback.deliveryId must be a uuid');
  if (value.occurredAt !== undefined && (typeof value.occurredAt !== 'string' || Number.isNaN(Date.parse(value.occurredAt)))) throw new Error('feedback.occurredAt must be an ISO timestamp');
  return {
    provider: value.provider, eventId: value.eventId, kind: value.kind, deliveryId: value.deliveryId.toLowerCase(),
    ...(value.kind === 'bounce' ? { bounce: value.bounce as 'hard' | 'soft' } : {}),
    ...(value.occurredAt ? { occurredAt: value.occurredAt } : {}),
  };
}
/** `<delivery id>@domain` (with or without angle brackets) to the delivery id, or null. */
export function deliveryIdFromMessageId(messageId: string): string | null {
  const local = /^<?([^@>\s]+)@[^>\s]+>?$/.exec(messageId.trim())?.[1];
  return local && UUID.test(local) ? local.toLowerCase() : null;
}

export type FeedbackResult = 'recorded' | 'duplicate' | 'unknown_delivery';
/**
 * Records one feedback event idempotently (inbox_receipt keyed by provider and event id): the delivery keeps its most
 * severe feedback, and a hard bounce or a complaint adds the address hash to the suppression list.
 */
export async function applyFeedback(trx: Transaction, event: MailFeedbackEvent): Promise<FeedbackResult> {
  const { fresh } = await inbox.record(trx, { provider: `mail.${event.provider}`, account: 'feedback', event_id: event.eventId });
  if (!fresh) return 'duplicate';
  const delivery = await mailDeliveries.getById(trx, event.deliveryId);
  if (!delivery) return 'unknown_delivery';
  const feedback = event.kind === 'delivered' ? 'delivered' : event.kind === 'complaint' ? 'complaint' : event.bounce === 'hard' ? 'hard_bounce' : 'soft_bounce';
  await mailDeliveries.recordFeedback(trx, delivery.id, feedback, event.occurredAt ? new Date(event.occurredAt) : null);
  if (feedback === 'hard_bounce' || feedback === 'complaint') {
    await suppressions.add(trx, { addressHash: delivery.recipient_hash, reason: feedback === 'complaint' ? 'complaint' : 'bounce', source: `feedback:${event.provider}`, deliveryId: delivery.id });
  }
  return 'recorded';
}

/** Entry point for feedback sources (a provider webhook in the API, a bounce mailbox reader): queues a `mail.feedback` job. */
export async function submitMailFeedback(trx: Transaction, event: MailFeedbackEvent): Promise<void> {
  await jobs.enqueue(trx, { kind: MAIL_FEEDBACK_KIND, payload: parseFeedback(event) });
}

type Claim =
  | { kind: 'send'; delivery: MailDelivery }
  | { kind: 'skip'; result: string }
  | { kind: 'throttled' };

/**
 * Registers mail delivery on the worker:
 *
 * - outbox `mail.requested` -> `mail.enqueue_delivery`: one `mail.deliver` job per delivery (inbox receipt keyed by the
 *   delivery id, so a duplicated or redelivered intent never queues a second job);
 * - `mail.deliver` (external): claims the row under a lock (final rows, other jobs' rows, expired secrets, suppressed
 *   addresses and the per-recipient window end here), persists the attempt, renders, sends, records the outcome;
 * - `mail.feedback` (transactional): `applyFeedback`.
 */
export function registerMail(registry: HandlerRegistry, runtime: MailRuntime): void {
  const { pool, config, transport, log, metrics } = runtime;
  const key = deriveMailSecretKey(config.secretKey);
  const count = (template: string, result: string) => metrics.inc(...MAIL_METRICS.deliveries, { template, result });

  registry.onOutbox({
    name: MAIL_ENQUEUE_HANDLER,
    type: MAIL_REQUESTED,
    handle: async (event, context) => {
      if (event.aggregateKind !== MAIL_AGGREGATE || !UUID.test(event.aggregateId)) throw new PermanentJobError(`malformed ${MAIL_REQUESTED} event ${event.id}`);
      const { fresh } = await inbox.record(context.trx, { provider: 'outbox', account: MAIL_REQUESTED, event_id: event.aggregateId });
      if (!fresh) {
        count('_unknown', 'duplicate');
        return;
      }
      const job = await context.enqueue({ kind: MAIL_DELIVER_KIND, payload: { deliveryId: event.aggregateId } satisfies DeliverPayload, maxAttempts: MAIL_DELIVER_ATTEMPTS });
      await mailDeliveries.setJob(context.trx, event.aggregateId, job.id);
    },
  });

  const claim = (context: JobContext<DeliverPayload>): Promise<Claim> => inTransaction(pool, async (trx) => {
    const id = context.payload.deliveryId;
    const row = await mailDeliveries.lockForDelivery(trx, id);
    if (!row) return { kind: 'skip', result: 'missing' };
    if (row.state !== 'pending' && row.state !== 'sending') return { kind: 'skip', result: 'duplicate' };
    // Exactly one job owns a delivery: a second job for the same row (a duplicate enqueue) never sends.
    if (row.job_id && row.job_id !== context.job.id) return { kind: 'skip', result: 'duplicate' };
    if (!row.job_id) await mailDeliveries.setJob(trx, id, context.job.id);
    if (!row.recipient) {
      await mailDeliveries.markFinal(trx, id, 'failed', 'recipient missing');
      return { kind: 'skip', result: 'failed' };
    }
    const { rows } = await sql<{ expired: boolean }>`SELECT (${row.secret_expires_at}::timestamptz IS NOT NULL AND ${row.secret_expires_at}::timestamptz <= now()) AS expired`.execute(trx);
    if (rows[0]?.expired) {
      await mailDeliveries.markFinal(trx, id, 'expired');
      return { kind: 'skip', result: 'expired' };
    }
    // An unsubscribe (COMMS-001) stops non-transactional notification mail only; identity mail and transactional
    // notices still go. Bounces, complaints and legal entries stop everything.
    const suppressed = await suppressions.isSuppressed(trx, row.recipient_hash);
    const transactional = row.template !== 'notification' || row.params.transactional === 'true';
    if (suppressed && !(suppressed === 'unsubscribe' && transactional)) {
      await mailDeliveries.markFinal(trx, id, 'suppressed');
      return { kind: 'skip', result: 'suppressed' };
    }
    // A row still `sending` is a re-run after an explicit reconciliation (`queued`: confirmed not sent); it keeps its
    // place in the windows. New claims are serialised per recipient and counted against both windows.
    if (row.state === 'pending') {
      await mailDeliveries.lockRecipient(trx, row.recipient_hash);
      if (await mailDeliveries.recentClaims(trx, row.recipient_hash, 3600) >= config.limits.recipientPerHour) {
        await mailDeliveries.markFinal(trx, id, 'rate_limited');
        return { kind: 'skip', result: 'rate_limited' };
      }
      if (await mailDeliveries.recentClaims(trx, null, 60) >= config.limits.perMinute) return { kind: 'throttled' };
    }
    await mailDeliveries.markSending(trx, id, context.attemptId);
    return { kind: 'send', delivery: row };
  });

  const fail = async (delivery: MailDelivery, reason: string, cause?: unknown): Promise<never> => {
    await inTransaction(pool, (trx) => mailDeliveries.markFinal(trx, delivery.id, 'failed', reason));
    count(delivery.template, 'failed');
    throw new PermanentJobError(reason, cause === undefined ? undefined : { cause });
  };

  registry.onJob<DeliverPayload>({
    kind: MAIL_DELIVER_KIND,
    mode: 'external',
    timeoutMs: transport.maxDurationMs + 5000,
    parse: parseDeliver,
    run: async (context) => {
      const claimed = await claim(context);
      if (claimed.kind === 'throttled') {
        count('_unknown', 'throttled');
        throw new RetryableJobError('hub send rate limit reached; retrying later');
      }
      if (claimed.kind === 'skip') {
        count('_unknown', claimed.result);
        if (claimed.result !== 'duplicate' && claimed.result !== 'missing') log('info', 'mail delivery ended without sending', { deliveryId: context.payload.deliveryId, result: claimed.result });
        return;
      }
      const delivery = claimed.delivery;
      const spec = TEMPLATE_SPECS[delivery.template];
      let secret: string | null = null;
      if (spec.secret) {
        if (!delivery.sealed_secret) return fail(delivery, 'one-time token missing');
        try {
          secret = unsealMailSecret(key, delivery.id, delivery.sealed_secret);
        } catch (error) {
          return fail(delivery, 'one-time token cannot be opened (MAIL_SECRET_KEY differs from the API)', error);
        }
      }
      let rendered: RenderedMail;
      try {
        rendered = renderMail(config.render, { template: delivery.template, localePreferences: delivery.locale_preferences, params: delivery.params, secret });
      } catch (error) {
        return fail(delivery, `cannot render: ${describeError(error)}`, error);
      }
      const mail: OutgoingMail = {
        messageId: `${delivery.id}@${config.messageIdDomain}`,
        idempotencyKey: context.effectKey,
        from: { address: config.from, name: rendered.fromName },
        replyTo: config.replyTo,
        to: delivery.recipient as string,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        locale: rendered.locale,
        headers: { 'X-Entity-Ref-ID': delivery.id },
      };
      try {
        const sent = await inTransaction(pool, async (trx) => {
          if (!(await consultationCommunications.mailAllowed(trx, delivery.id))) {
            await mailDeliveries.markFinal(trx, delivery.id, 'suppressed', 'consultation access revoked');
            return false;
          }
          context.signal.throwIfAborted();
          const receipt = await transport.send(mail, context.signal);
          await mailDeliveries.markSent(trx, delivery.id, receipt.providerMessageId);
          return true;
        });
        if (!sent) { count(delivery.template, 'suppressed'); return; }
        count(delivery.template, 'sent');
        log('info', 'mail sent', { deliveryId: delivery.id, template: delivery.template, locale: rendered.locale, transport: transport.name });
      } catch (error) {
        if (error instanceof MailTemporaryError) {
          const reason = redactAddresses(error.message);
          await inTransaction(pool, (trx) => mailDeliveries.markRetry(trx, delivery.id, reason));
          count(delivery.template, 'retried');
          throw new RetryableJobError(reason);
        }
        if (error instanceof MailRejectedError) {
          const reason = redactAddresses(error.message);
          await inTransaction(pool, async (trx) => {
            await mailDeliveries.markFinal(trx, delivery.id, 'failed', reason);
            // A permanent refusal of the address at RCPT is a synchronous hard bounce.
            if (error.recipientRejected) await applyFeedback(trx, { provider: transport.name, eventId: `${delivery.id}:rcpt`, kind: 'bounce', bounce: 'hard', deliveryId: delivery.id });
          });
          count(delivery.template, 'failed');
          throw new PermanentJobError(reason);
        }
        count(delivery.template, 'unknown');
        // Unknown outcome: the row stays `sending`; the runner parks the job for reconciliation.
        throw new Error(redactAddresses(describeError(error)));
      }
    },
  });

  registry.onJob<MailFeedbackEvent>({
    kind: MAIL_FEEDBACK_KIND,
    mode: 'transactional',
    parse: parseFeedback,
    run: async (context) => {
      const result = await applyFeedback(context.trx, context.payload);
      const kind = result === 'recorded' ? (context.payload.kind === 'bounce' ? `${context.payload.bounce}_bounce` : context.payload.kind) : result;
      metrics.inc(...MAIL_METRICS.feedback, { kind });
    },
  });
}

/** Housekeeping: settles deliveries from their jobs' final states and strips personal data (see mailDeliveries.settle). */
export function mailSettleTask(runtime: Pick<MailRuntime, 'pool' | 'metrics'>, intervalSeconds = 300): ScheduledTask {
  return {
    name: MAIL_SETTLE_TASK,
    intervalSeconds,
    run: async () => {
      const report = await inTransaction(runtime.pool, (trx) => mailDeliveries.settle(trx));
      for (const [outcome, n] of Object.entries(report)) if (n > 0) runtime.metrics.inc(...MAIL_METRICS.settled, { outcome }, n);
      return report;
    },
  };
}

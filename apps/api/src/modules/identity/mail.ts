import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { deriveMailSecretKey, mailDeliveries, type Transaction } from '../../deps/data.js';
import type { MailIntent, MailOutbox } from './ports.js';

/**
 * Transactional mail leaves through the outbox (MAIL-001): a use case records the intent in the transaction of the
 * identity change (a `mail_delivery` row plus a `mail.requested` outbox event carrying the delivery id only), and the
 * worker renders and sends it. The request never waits for a mail provider, a failing provider can never fail or slow
 * it, and a rolled-back change leaves no mail behind. One-time tokens are sealed with `MAIL_SECRET_KEY` (shared with
 * the worker, never stored in the database); auth_token keeps only their SHA-256 as before.
 */
export class OutboxMail implements MailOutbox {
  private readonly key: Buffer;
  constructor(secretKey: Buffer) {
    this.key = deriveMailSecretKey(secretKey);
  }
  async record(trx: Transaction, intent: MailIntent): Promise<void> {
    await mailDeliveries.record(trx, this.key, {
      template: intent.template,
      recipient: intent.to,
      localePreferences: intent.locales ?? [],
      params: intent.params ?? {},
      ...(intent.secret ? { secret: { value: intent.secret.token, expiresAt: intent.secret.expiresAt } } : {}),
    });
  }
}

const TAG = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/i;
/**
 * Language preferences of a request from `Accept-Language`, best first: well-formed language tags only (language,
 * optional script and region), canonical case, at most six, `q=0` dropped. The worker picks the first language the
 * hub serves; mail caused by someone else (a lockout notice, an invitation) records none and uses the hub default.
 */
export function requestLocales(header: string | string[] | undefined): string[] {
  const raw = (Array.isArray(header) ? header.join(',') : header ?? '').slice(0, 512);
  const ranked: { tag: string; q: number; index: number }[] = [];
  raw.split(',').forEach((part, index) => {
    const [tagPart, ...params] = part.trim().split(';');
    const tag = tagPart?.trim() ?? '';
    if (!TAG.test(tag)) return;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0 || q > 1) return;
    let canonical: string;
    try {
      canonical = Intl.getCanonicalLocales(tag)[0] ?? tag;
    } catch {
      return;
    }
    ranked.push({ tag: canonical, q, index });
  });
  ranked.sort((a, b) => b.q - a.q || a.index - b.index);
  return [...new Set(ranked.map((r) => r.tag))].slice(0, 6);
}

/** Controller parameter: the request's language preferences (see `requestLocales`). */
export const ReqLocales = createParamDecorator((_: unknown, ctx: ExecutionContext): string[] => requestLocales(ctx.switchToHttp().getRequest<FastifyRequest>().headers['accept-language']));

/** Whole hours, minutes and days of a token lifetime for the mail templates (at least 1). */
export function hoursOf(ms: number): string {
  return String(Math.max(1, Math.round(ms / 3_600_000)));
}
export function minutesOf(ms: number): string {
  return String(Math.max(1, Math.round(ms / 60_000)));
}
export function daysOf(ms: number): string {
  return String(Math.max(1, Math.round(ms / 86_400_000)));
}

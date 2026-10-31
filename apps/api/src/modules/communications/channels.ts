import { randomUUID } from 'node:crypto';

/**
 * External channel adapters (ADR 004: every external effect goes through an adapter with a fake). COMMS-001 ships
 * fakes only: no messenger, SMS or webhook provider account is configured anywhere. Real adapters (CHAN-001) implement
 * the same port; their sends move to the worker with reconciliation of unknown outcomes.
 *
 * E-mail is not a channel adapter here: notification mail is enqueued through MAIL-001 (`comms_enqueue_mail`, the
 * worker renders and sends it).
 */
export type ChannelOutcome =
  | { kind: 'accepted'; providerRef: string }
  /** Definitely not sent (the provider refused before accepting). */
  | { kind: 'failed'; reason: string }
  /** The provider may or may not have sent it (timeout after the request left): recorded, never retried blindly. */
  | { kind: 'unknown'; reason: string };

export interface OutboundChannelMessage {
  deliveryId: string;
  provider: string;
  /** The handle from the person's channel grant (chat id, number); never logged. */
  account: string;
  text: string;
  /** Token the provider echoes with a reply (reply payload, deep link); null when replies are not allowed. */
  replyToken: string | null;
}

export interface ChannelAdapter {
  readonly providers: readonly string[];
  send(message: OutboundChannelMessage): Promise<ChannelOutcome>;
}

/** Recording fake for messengers and SMS: sends nothing; scriptable outcomes for tests. */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly sent: OutboundChannelMessage[] = [];
  private readonly scripted: ChannelOutcome[] = [];
  constructor(readonly providers: readonly string[] = ['telegram', 'whatsapp', 'sms', 'other']) {}
  /** The next sends answer these outcomes in order (then `accepted`). */
  script(...outcomes: ChannelOutcome[]): void {
    this.scripted.push(...outcomes);
  }
  async send(message: OutboundChannelMessage): Promise<ChannelOutcome> {
    const outcome = this.scripted.shift() ?? { kind: 'accepted', providerRef: `fake-${randomUUID()}` };
    if (outcome.kind !== 'failed') this.sent.push(message);
    return outcome;
  }
  /** Messages sent to one account (tests read the reply token from here). */
  to(account: string): OutboundChannelMessage[] {
    return this.sent.filter((m) => m.account === account);
  }
}

/**
 * Provider-neutral outbound mail port. The worker selects one implementation from configuration (`MAIL_TRANSPORT`):
 * `fake` (records in memory, sends nothing; the default), `log` (prints the rendered message to stdout; never in
 * production) or `smtp` (any SMTP submission server, `smtp.ts`). No provider account is created by this package.
 *
 * Outcome contract (ADR 004): a normal return means the server accepted the message. `MailTemporaryError` and
 * `MailRejectedError` are definitive answers with proof that the message was **not** accepted (retry later / never).
 * Any other error means the outcome is unknown (for example a timeout after the message body was sent); the job is
 * then parked for reconciliation instead of being sent again.
 */
export interface OutgoingMail {
  /** RFC 5322 Message-ID without angle brackets; derived from the delivery id, stable across attempts. */
  messageId: string;
  /** Stable idempotency key of the delivery job (`job:<id>`); passed to providers that deduplicate by it. */
  idempotencyKey: string;
  from: { address: string; name: string };
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  locale: string;
  /** Extra headers (ASCII names and values only). */
  headers: Readonly<Record<string, string>>;
}

export interface SendReceipt {
  /** Provider reference when the server returned one (for example the SMTP queue id), else null. */
  providerMessageId: string | null;
}

export interface MailTransport {
  readonly name: string;
  /** Upper bound of one `send`, so the job timeout can sit above it and phase-aware errors win the race. */
  readonly maxDurationMs: number;
  send(mail: OutgoingMail, signal: AbortSignal): Promise<SendReceipt>;
  close?(): Promise<void>;
}

/** Not accepted, safe to retry later (4xx reply, connection refused, timeout before the message body was sent). */
export class MailTemporaryError extends Error {
  constructor(message: string, readonly code: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailTemporaryError';
  }
}

/** Not accepted and a retry cannot help (5xx reply). `recipientRejected` marks a permanent refusal of the address. */
export class MailRejectedError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly recipientRejected = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailRejectedError';
  }
}

/** The message may or may not have been accepted (timeout or disconnect after the body was sent). */
export class MailOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailOutcomeUnknownError';
  }
}

export type FakeFailure = 'temporary' | 'rejected' | 'recipient_rejected' | 'unknown';

/**
 * Deterministic fake: records every accepted message; tests script failures per call or per recipient. It never opens
 * a network connection.
 */
export class FakeMailTransport implements MailTransport {
  readonly name = 'fake';
  readonly maxDurationMs = 1000;
  readonly sent: OutgoingMail[] = [];
  private readonly scripted: FakeFailure[] = [];
  private readonly byRecipient = new Map<string, FakeFailure>();
  private counter = 0;

  failNext(failure: FakeFailure): void {
    this.scripted.push(failure);
  }
  failFor(address: string, failure: FakeFailure): void {
    this.byRecipient.set(address, failure);
  }

  async send(mail: OutgoingMail, signal: AbortSignal): Promise<SendReceipt> {
    if (signal.aborted) throw new MailTemporaryError('aborted before sending');
    const failure = this.scripted.shift() ?? this.byRecipient.get(mail.to);
    if (failure === 'temporary') throw new MailTemporaryError('fake temporary failure', 451);
    if (failure === 'rejected') throw new MailRejectedError('fake permanent rejection', 554);
    if (failure === 'recipient_rejected') throw new MailRejectedError('fake recipient rejected', 550, true);
    if (failure === 'unknown') {
      this.sent.push(mail);
      throw new MailOutcomeUnknownError('fake ambiguous outcome after the body was sent');
    }
    this.sent.push(mail);
    this.counter += 1;
    return { providerMessageId: `fake-${this.counter}` };
  }

  /** Messages accepted for an address, oldest first. */
  to(address: string): OutgoingMail[] {
    return this.sent.filter((m) => m.to === address);
  }
}

/** Development transport: prints the rendered text part (including links) to stdout. Refused in production. */
export class LogMailTransport implements MailTransport {
  readonly name = 'log';
  readonly maxDurationMs = 1000;
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}
  async send(mail: OutgoingMail): Promise<SendReceipt> {
    this.write(`[mail] to=${mail.to} locale=${mail.locale} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    return { providerMessageId: null };
  }
}

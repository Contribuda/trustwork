import net from 'node:net';
import tls from 'node:tls';
import { AddressError, asciiAddress, renderMime } from './mime.js';
import { MailOutcomeUnknownError, MailRejectedError, MailTemporaryError, type MailTransport, type OutgoingMail, type SendReceipt } from './transport.js';

/**
 * Provider-neutral SMTP submission client (RFC 5321, RFC 3207 STARTTLS, RFC 4954 AUTH PLAIN/LOGIN) written on
 * node:net/node:tls, so any submission server works (an operator's relay, a hosted provider's SMTP endpoint, a local
 * sink in tests) without a provider SDK or a new dependency. One connection per message; no pipelining.
 *
 * Outcome mapping follows the transport contract: every failure before the final `.` of DATA is a definitive
 * not-accepted answer (4xx and network errors: temporary; 5xx: rejected, at RCPT 550/551/553: the address itself is
 * refused); a 2xx after the body is acceptance; a timeout, abort or disconnect after the body was sent is an unknown
 * outcome and is never retried blindly.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** `starttls` (default, required upgrade), `tls` (implicit TLS, port 465) or `none` (loopback or development only). */
  security: 'starttls' | 'tls' | 'none';
  auth: { user: string; password: string } | null;
  /** EHLO name. */
  clientName: string;
  /** TCP connect plus server greeting. */
  connectTimeoutMs: number;
  /** Each command reply. */
  commandTimeoutMs: number;
  /** Reply to the end of DATA (servers may scan the message first). */
  dataTimeoutMs: number;
  /** Extra trust anchors (PEM) for a private relay; certificates are always verified. */
  ca?: string | undefined;
}

export const DEFAULT_SMTP_TIMEOUTS = { connectTimeoutMs: 10_000, commandTimeoutMs: 10_000, dataTimeoutMs: 30_000 } as const;

interface Reply { code: number; lines: string[] }

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

class SmtpSession {
  private socket: net.Socket;
  private buffer = '';
  private replies: Reply[] = [];
  private partial: string[] = [];
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  bodySent = false;
  secure = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('connection closed by the server')));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024) {
      this.fail(new Error('reply too long'));
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) {
        this.fail(new Error('malformed reply line'));
        return;
      }
      this.partial.push(match[3]!);
      if (match[2] !== '-') {
        const reply = { code: Number(match[1]), lines: this.partial };
        this.partial = [];
        if (this.waiter) {
          const { resolve } = this.waiter;
          this.waiter = null;
          resolve(reply);
        } else this.replies.push(reply);
      }
    }
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  read(timeoutMs: number, signal: AbortSignal): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const onAbort = () => this.fail(new Error('aborted'));
      const timer = setTimeout(() => this.fail(new Error(`no reply within ${timeoutMs} ms`)), timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      this.waiter = {
        resolve: (reply) => {
          done();
          resolve(reply);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      };
    });
  }

  write(data: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  /** Replaces the plain socket with a verified TLS socket (STARTTLS). */
  async upgrade(options: tls.ConnectionOptions, timeoutMs: number): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ ...options, socket: plain }, () => resolve(socket));
      socket.once('error', reject);
      setTimeout(() => reject(new Error('TLS handshake timed out')), timeoutMs).unref();
    });
    this.socket = secure;
    this.secure = true;
    this.attach(secure);
  }

  close(): void {
    this.socket.destroy();
  }
}

function connect(config: SmtpConfig, signal: AbortSignal): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const tlsOptions: tls.ConnectionOptions = { host: config.host, port: config.port, servername: net.isIP(config.host) ? undefined : config.host, rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) };
    const socket = config.security === 'tls' ? tls.connect(tlsOptions) : net.connect({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timed out after ${config.connectTimeoutMs} ms`));
    }, config.connectTimeoutMs);
    const onAbort = () => {
      socket.destroy();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once(config.security === 'tls' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function dotStuff(message: string): string {
  const normalized = message.replace(/\r?\n/g, '\r\n');
  return normalized.replace(/(^|\r\n)\./g, '$1..');
}

function summary(reply: Reply): string {
  return `${reply.code} ${reply.lines.join(' ').slice(0, 200)}`;
}

export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  readonly maxDurationMs: number;

  constructor(private readonly config: SmtpConfig) {
    if (config.security === 'none' && config.auth && !isLoopbackHost(config.host)) throw new Error('SMTP credentials are never sent without TLS to a non-loopback host');
    this.maxDurationMs = config.connectTimeoutMs + config.commandTimeoutMs * 10 + config.dataTimeoutMs;
  }

  async send(mail: OutgoingMail, signal: AbortSignal): Promise<SendReceipt> {
    let from: string;
    let to: string;
    try {
      from = asciiAddress(mail.from.address);
      to = asciiAddress(mail.to);
    } catch (error) {
      throw new MailRejectedError(error instanceof AddressError ? error.message : 'invalid address', null, true);
    }
    const message = dotStuff(renderMime(mail));
    let session: SmtpSession | null = null;
    try {
      session = new SmtpSession(await connect(this.config, signal));
      session.secure = this.config.security === 'tls';
      const s = session;
      const { commandTimeoutMs } = this.config;
      const expect = async (accept: (code: number) => boolean, phase: string, timeoutMs = commandTimeoutMs): Promise<Reply> => {
        const reply = await s.read(timeoutMs, signal);
        if (accept(reply.code)) return reply;
        if (reply.code >= 500) throw new MailRejectedError(`${phase}: ${summary(reply)}`, reply.code, phase === 'RCPT' && [550, 551, 553].includes(reply.code));
        throw new MailTemporaryError(`${phase}: ${summary(reply)}`, reply.code);
      };
      const command = async (line: string, phase: string, accept: (code: number) => boolean = (c) => c >= 200 && c < 300): Promise<Reply> => {
        s.write(`${line}\r\n`);
        return expect(accept, phase);
      };
      await expect((c) => c === 220, 'greeting', this.config.connectTimeoutMs);
      let ehlo = await command(`EHLO ${this.config.clientName}`, 'EHLO');
      const extensions = () => ehlo.lines.slice(1).map((line) => line.toUpperCase());
      if (this.config.security === 'starttls') {
        if (!extensions().some((e) => e.startsWith('STARTTLS'))) throw new MailTemporaryError('server does not offer STARTTLS; refusing to send in clear text');
        await command('STARTTLS', 'STARTTLS', (c) => c === 220);
        await s.upgrade({ servername: net.isIP(this.config.host) ? undefined : this.config.host, rejectUnauthorized: true, ...(this.config.ca ? { ca: this.config.ca } : {}) }, commandTimeoutMs);
        ehlo = await command(`EHLO ${this.config.clientName}`, 'EHLO');
      }
      if (this.config.auth) {
        if (!s.secure && !isLoopbackHost(this.config.host)) throw new MailTemporaryError('refusing to authenticate without TLS');
        const auth = extensions().find((e) => e.startsWith('AUTH')) ?? '';
        const { user, password } = this.config.auth;
        if (/\bPLAIN\b/.test(auth)) {
          await command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')}`, 'AUTH');
        } else if (/\bLOGIN\b/.test(auth)) {
          await command('AUTH LOGIN', 'AUTH', (c) => c === 334);
          await command(Buffer.from(user, 'utf8').toString('base64'), 'AUTH', (c) => c === 334);
          await command(Buffer.from(password, 'utf8').toString('base64'), 'AUTH');
        } else throw new MailTemporaryError('server offers no supported AUTH mechanism (PLAIN or LOGIN)');
      }
      await command(`MAIL FROM:<${from}>`, 'MAIL');
      await command(`RCPT TO:<${to}>`, 'RCPT');
      await command('DATA', 'DATA', (c) => c === 354);
      s.write(message.endsWith('\r\n') ? message : `${message}\r\n`);
      s.write('.\r\n');
      s.bodySent = true;
      const accepted = await expect((c) => c >= 200 && c < 300, 'end of DATA', this.config.dataTimeoutMs);
      try {
        s.write('QUIT\r\n');
      } catch {
        // the message is accepted; a failing QUIT changes nothing
      }
      const text = accepted.lines.join(' ');
      const queued = /queued as\s+(\S+)/i.exec(text)?.[1] ?? null;
      return { providerMessageId: (queued ?? text).slice(0, 200) || null };
    } catch (error) {
      if (error instanceof MailRejectedError || error instanceof MailTemporaryError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (session?.bodySent) throw new MailOutcomeUnknownError(`SMTP outcome unknown after the message body was sent: ${reason}`, { cause: error });
      throw new MailTemporaryError(`SMTP not accepted: ${reason}`, null, { cause: error });
    } finally {
      session?.close();
    }
  }
}

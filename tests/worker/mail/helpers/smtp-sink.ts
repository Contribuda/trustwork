import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Local SMTP sink for tests: a small RFC 5321 server on 127.0.0.1 that records accepted messages. Modes script the
 * failure cases of the transport contract: a server that accepts the connection and never greets (stalled before any
 * effect), one that swallows the message body and never answers (stalled after the body: unknown outcome), temporary
 * and permanent refusals at RCPT. No TLS (the transport runs with `security: none` against loopback only).
 */
export type SinkMode = 'ok' | 'stall_greeting' | 'stall_after_data' | 'tempfail_rcpt' | 'reject_rcpt' | 'reject_data';

export interface SinkMessage { from: string; to: string[]; raw: string; receivedAt: number }

export class SmtpSink {
  readonly messages: SinkMessage[] = [];
  mode: SinkMode = 'ok';
  /** Recipients refused with 550 regardless of the mode. */
  readonly rejectRecipients = new Set<string>();
  auth: { user: string; password: string } | null = null;
  connections = 0;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private counter = 0;

  get port(): number {
    return (this.server?.address() as AddressInfo).port;
  }

  async start(): Promise<this> {
    this.server = net.createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  to(address: string): SinkMessage[] {
    return this.messages.filter((m) => m.to.includes(address));
  }

  private session(socket: net.Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    const mode = this.mode;
    if (mode === 'stall_greeting') return;
    const send = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    send('220 sink.test ESMTP ready');
    let buffer = '';
    let inData = false;
    let data: string[] = [];
    let from = '';
    let to: string[] = [];
    let authed = this.auth === null;
    let authLogin: 'user' | 'password' | null = null;
    let loginUser = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (mode === 'stall_after_data') {
              // Swallow the message: the client cannot know whether it was accepted.
              this.messages.push({ from, to, raw: data.join('\r\n'), receivedAt: Date.now() });
              continue;
            }
            if (mode === 'reject_data') {
              send('554 5.7.1 message refused');
              continue;
            }
            this.messages.push({ from, to, raw: data.join('\r\n'), receivedAt: Date.now() });
            this.counter += 1;
            send(`250 2.0.0 Ok: queued as SINK${this.counter}`);
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (authLogin === 'user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          authLogin = 'password';
          send('334 UGFzc3dvcmQ6');
          continue;
        }
        if (authLogin === 'password') {
          authLogin = null;
          authed = this.auth !== null && loginUser === this.auth.user && Buffer.from(line, 'base64').toString('utf8') === this.auth.password;
          send(authed ? '235 2.7.0 authenticated' : '535 5.7.8 bad credentials');
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') send(`250-sink.test greets you\r\n250-8BITMIME\r\n250${this.auth ? '-AUTH PLAIN LOGIN\r\n250' : ''} SIZE 10485760`);
        else if (verb === 'HELO') send('250 sink.test');
        else if (verb === 'AUTH') {
          const [, mechanism, initial] = line.split(' ');
          if (mechanism?.toUpperCase() === 'PLAIN' && initial) {
            const [, user, password] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
            authed = this.auth !== null && user === this.auth.user && password === this.auth.password;
            send(authed ? '235 2.7.0 authenticated' : '535 5.7.8 bad credentials');
          } else if (mechanism?.toUpperCase() === 'LOGIN') {
            authLogin = 'user';
            send('334 VXNlcm5hbWU6');
          } else send('504 5.5.4 unsupported mechanism');
        } else if (verb === 'MAIL') {
          if (!authed) {
            send('530 5.7.0 authentication required');
            continue;
          }
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          send('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (this.rejectRecipients.has(address) || mode === 'reject_rcpt') send(`550 5.1.1 <${address}>: Recipient address rejected`);
          else if (mode === 'tempfail_rcpt') send('451 4.7.1 try again later');
          else {
            to.push(address);
            send('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          data = [];
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          from = '';
          to = [];
          send('250 Ok');
        } else if (verb === 'NOOP') send('250 Ok');
        else if (verb === 'QUIT') {
          send('221 Bye');
          socket.end();
        } else send('502 5.5.2 command not recognized');
      }
    });
  }
}

export interface ParsedMessage {
  headers: Map<string, string>;
  subject: string;
  text: string;
  html: string;
}

function decodeWords(value: string): string {
  return value.replace(/\r\n\s+/g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

/** Minimal parser for the messages our MIME renderer produces (multipart/alternative, base64 UTF-8 parts). */
export function parseMessage(raw: string): ParsedMessage {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of head.split(/\r\n(?![ \t])/)) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get('content-type') ?? '')?.[1];
  if (!boundary) throw new Error('not multipart');
  const parts = body.split(`--${boundary}`).slice(1, -1);
  const decoded = (type: string) => {
    const part = parts.find((p) => p.includes(`Content-Type: ${type}`));
    if (!part) throw new Error(`no ${type} part`);
    return Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8');
  };
  return { headers, subject: decodeWords(headers.get('subject') ?? ''), text: decoded('text/plain'), html: decoded('text/html') };
}

/** Links in a text part (one per line in our templates). */
export function linksIn(text: string): URL[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map((m) => new URL(m[0]));
}

// SMTP sink of the platform release candidate (QA-002). A dependency-free RFC 5321 receiver that records every message
// the worker submits (MAIL_TRANSPORT=smtp, MAIL_SMTP_SECURITY=none on the compose network) and a small HTTP reader for
// the release journey:
//   GET /health                  200 "ok"
//   GET /messages?to=<address>   { items: [{ to, from, subject, language, text, links, receivedAt }] }, newest last
// It runs as a container next to the stack (tests/release/platform/compose.release.yaml) on the same Node image as the
// backend images, and is imported by tests/release/platform/release.test.ts, which drives it with the worker's real
// SMTP client. Nothing leaves the machine; messages live in memory only and the container keeps no volume.
import net from 'node:net';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Decodes RFC 2047 base64 encoded words (what apps/worker/src/mail/mime.ts writes for non-ASCII subjects). */
function decodeWords(value) {
  return value.replace(/\r\n[ \t]+/g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
}

/**
 * Parses the messages the worker's MIME renderer produces: headers, then a multipart/alternative body with base64
 * UTF-8 text/plain and text/html parts. Returns null for anything else (the sink still answers 250; the reader then
 * shows the message without text).
 */
export function parseMessage(raw) {
  const split = raw.indexOf('\r\n\r\n');
  if (split === -1) return null;
  const headers = new Map();
  for (const line of raw.slice(0, split).split(/\r\n(?![ \t])/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get('content-type') ?? '')?.[1];
  if (!boundary) return null;
  const parts = raw.slice(split + 4).split(`--${boundary}`).slice(1, -1);
  const part = (type) => {
    const found = parts.find((p) => new RegExp(`Content-Type: ${type}`, 'i').test(p));
    if (!found) return '';
    const start = found.indexOf('\r\n\r\n');
    return Buffer.from(found.slice(start + 4).replace(/\s+/g, ''), 'base64').toString('utf8');
  };
  return { headers, subject: decodeWords(headers.get('subject') ?? ''), language: headers.get('content-language') ?? null, text: part('text/plain'), html: part('text/html') };
}

/** Absolute links of a text part, in order. */
export function linksIn(text) {
  return [...text.matchAll(/https?:\/\/[^\s<>"]+/g)].map((m) => m[0]);
}

/** In-memory SMTP receiver. `listen(port, host)` resolves with the bound port. */
export class ReleaseSmtpSink {
  messages = [];
  #server = null;
  #sockets = new Set();
  #counter = 0;

  async listen(port = 2525, host = '0.0.0.0') {
    this.#server = net.createServer((socket) => this.#session(socket));
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, resolve);
    });
    return this.#server.address().port;
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** Messages to an address (case-insensitive), oldest first, in the reader's shape. */
  to(address) {
    const wanted = address.toLowerCase();
    return this.messages.filter((m) => m.to.some((r) => r.toLowerCase() === wanted)).map(view);
  }

  #session(socket) {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    socket.setTimeout(60_000, () => socket.destroy());
    const send = (line) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    send('220 release-sink.invalid ESMTP ready');
    let buffer = '';
    let inData = false;
    let data = [];
    let from = '';
    let to = [];
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 12 * 1024 * 1024) return socket.destroy();
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            this.#counter += 1;
            this.messages.push({ from, to, raw: data.join('\r\n'), receivedAt: new Date().toISOString() });
            send(`250 2.0.0 Ok: queued as RELEASE${this.#counter}`);
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') send('250-release-sink.invalid\r\n250-8BITMIME\r\n250 SIZE 10485760');
        else if (verb === 'HELO') send('250 release-sink.invalid');
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          send('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (!from) send('503 5.5.1 MAIL first');
          else {
            to.push(address);
            send('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          if (!to.length) send('503 5.5.1 RCPT first');
          else {
            inData = true;
            data = [];
            send('354 End data with <CR><LF>.<CR><LF>');
          }
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

function view(message) {
  const parsed = parseMessage(message.raw);
  return {
    to: message.to,
    from: message.from,
    subject: parsed?.subject ?? null,
    language: parsed?.language ?? null,
    text: parsed?.text ?? null,
    links: parsed ? linksIn(parsed.text) : [],
    receivedAt: message.receivedAt,
  };
}

/** The HTTP reader over a sink (loopback port published by compose; no write route exists). */
export function createReader(sink) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sink.invalid');
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/messages') return reply(200, { items: sink.to(url.searchParams.get('to') ?? '') });
    return reply(404, { error: 'not found' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sink = new ReleaseSmtpSink();
  const smtpPort = await sink.listen(Number(process.env.SINK_SMTP_PORT ?? 2525));
  const reader = createReader(sink);
  const httpPort = Number(process.env.SINK_HTTP_PORT ?? 8025);
  reader.listen(httpPort, '0.0.0.0');
  console.log(JSON.stringify({ msg: 'release smtp sink ready', smtpPort, httpPort }));
  const stop = () => {
    reader.close();
    void sink.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

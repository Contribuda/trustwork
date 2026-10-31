import { createHmac } from 'node:crypto';
import type { LogLevelName } from '../config.js';

/**
 * Structured JSON logs (one line per event) with redaction. Debugging logs are not the audit trail: audit events
 * stay in the database. Never logged: secrets, tokens, cookies, passwords, authorization headers, e-mail addresses,
 * IP addresses, private commercial fields (budgets, floors, prices, negotiation), request or response bodies. The
 * principal appears only as a keyed pseudonym (`principal`), never as the person id.
 */
export type LogSink = (line: string) => void;
export type LogFields = Record<string, unknown>;
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** True when lines of this level are written (lets callers skip building fields). */
  enabled(level: LogLevelName): boolean;
}
export interface LoggerOptions {
  level?: LogLevelName;
  service?: string;
  sink?: LogSink;
  clock?: () => Date;
}

const ORDER: Record<LogLevelName, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const REDACTED = '[redacted]';

/**
 * Keys whose values are never written. Matched case-insensitively against the whole key after removing `-` and `_`.
 * Private commercial terms are listed explicitly: they must not reach logs even when a handler passes them.
 */
const SECRET_KEY = /pass(word|phrase)?|secret|token|authorization|cookie|credential|apikey|privatekey|signature|session(id)?$|otp|nonce|^code$|^state$|^ip$|ipaddress|remoteaddress|forwardedfor|email|phone|^name$|displayname|address$|budget|floor|price|amount|negotiat|margin|discount|reserve|^body$|^payload$|^query$|^params$|^headers$/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/[-_]/g, ''));
}

/** Patterns scrubbed from free text (error messages and stacks may echo input or connection strings). */
const SCRUB: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]+@/gi, `$1://${REDACTED}@`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|session)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1$2${REDACTED}`],
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
  [/\b[A-Za-z0-9_-]{43,}\b/g, '[opaque]'],
];

export function scrubText(text: string): string {
  return SCRUB.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

export interface SerializedError { type: string; message: string; code?: string; stack?: string }

/** Errors keep type, code, message and stack (scrubbed); `detail`, `where`, parameters and causes with values are dropped. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      type: error.name || 'Error',
      message: scrubText(error.message),
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack ? { stack: scrubText(error.stack) } : {}),
    };
  }
  return { type: typeof error, message: scrubText(typeof error === 'string' ? error : 'non-error thrown') };
}

/** Recursively removes secret and private keys, scrubs strings, bounds depth/size and breaks cycles. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return REDACTED;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[cycle]';
  if (depth >= 6) return '[depth]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = isSecretKey(key) ? REDACTED : redact(inner, depth + 1, seen);
  return out;
}

/** Keyed, non-reversible principal pseudonym for correlating log lines of one person without naming them. */
export function principalPseudonym(key: Buffer, personId: string | null | undefined): string | null {
  if (!personId) return null;
  return `p_${createHmac('sha256', key).update(personId).digest('hex').slice(0, 20)}`;
}

/** Fields that the logger itself writes; callers cannot override them. */
const RESERVED = new Set(['time', 'level', 'service', 'event']);
/** Correlation fields produced by this process (ids, pseudonyms, route patterns); written as-is, length-capped. */
const TRUSTED = new Set(['requestId', 'traceId', 'spanId', 'principal', 'route', 'method', 'status', 'durationMs']);

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = ORDER[options.level ?? 'info'];
  const sink = options.sink ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const clock = options.clock ?? (() => new Date());
  const service = options.service ?? 'trustwork-api';
  const write = (level: LogLevelName, event: string, fields: LogFields = {}) => {
    if (ORDER[level] < threshold) return;
    const record: Record<string, unknown> = { time: clock().toISOString(), level, service, event };
    for (const [key, value] of Object.entries(fields)) {
      if (RESERVED.has(key) || value === undefined) continue;
      if (key === 'err') record.err = value instanceof Error || typeof value !== 'object' || value === null ? serializeError(value) : redact(value);
      else if (TRUSTED.has(key)) record[key] = typeof value === 'string' ? value.slice(0, 256) : typeof value === 'number' || value === null ? value : redact(value);
      else record[key] = isSecretKey(key) ? REDACTED : redact(value);
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ time: record.time, level, service, event, err: { type: 'LogError', message: 'unserializable log fields' } });
    }
    try {
      sink(line);
    } catch {
      // A failing sink must never fail a request.
    }
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    enabled: (level) => ORDER[level] >= threshold,
  };
}

/** Adapter for code that still takes `(message, error?) => void` (identity context, idempotency interceptor). */
export function messageLogger(logger: Logger, level: 'warn' | 'error' = 'warn'): (message: string, error?: unknown) => void {
  return (message, error) => logger[level]('app.message', { message, ...(error === undefined ? {} : { err: error }) });
}

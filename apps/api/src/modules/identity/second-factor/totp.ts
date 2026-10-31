import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 4226 HOTP and RFC 6238 TOTP with `node:crypto` only (no dependency). Base32 is RFC 4648 without padding, the
 * form authenticator apps expect in `otpauth://` URIs.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP value for `counter` (dynamic truncation, `digits` decimal digits, zero-padded). */
export function hotp(secret: Buffer, counter: number, digits = 6, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(nowMs: number, periodSeconds = 30): number {
  return Math.floor(nowMs / 1000 / periodSeconds);
}

export function totp(secret: Buffer, nowMs: number, options: { digits?: number; periodSeconds?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {}): string {
  return hotp(secret, timeStep(nowMs, options.periodSeconds), options.digits, options.algorithm);
}

/**
 * Finds the time step whose code equals `code` within `window` steps of now and is later than `lastUsedStep`
 * (replay protection: a code is never accepted twice, nor an earlier code of the same window after a later one).
 * Every candidate is compared in constant time. Returns the step, or null.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, options: { window: number; periodSeconds: number; digits: number; lastUsedStep: number | null }): number | null {
  if (!/^\d+$/.test(code) || code.length !== options.digits) return null;
  const current = timeStep(nowMs, options.periodSeconds);
  const given = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let step = current - options.window; step <= current + options.window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step, options.digits), 'utf8');
    if (timingSafeEqual(expected, given) && (options.lastUsedStep === null || step > options.lastUsedStep) && matched === null) matched = step;
  }
  return matched;
}

/** Key Uri Format understood by authenticator apps: issuer and account label, SHA-1, 6 digits, 30 seconds. */
export function otpauthUri(input: { issuer: string; account: string; secret: string; digits: number; periodSeconds: number }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({ secret: input.secret, issuer: input.issuer, algorithm: 'SHA1', digits: String(input.digits), period: String(input.periodSeconds) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

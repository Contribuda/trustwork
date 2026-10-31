import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit CSPRNG token, base64url for cookies and links; only its SHA-256 is stored. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
/** Lockout subjects are hashed so the failure table never stores addresses or IPs in clear. */
export function subjectHash(kind: 'account' | 'ip', value: string): string {
  return sha256Hex(`${kind}:${value}`);
}

/** Coarse client data for the sessions list: first user-agent product token and a /24 (IPv4) or /64 (IPv6) prefix. */
export function userAgentFamily(userAgent: string | undefined): string {
  const first = (userAgent ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^\w./-]/g, '').slice(0, 100);
}
export function ipPrefix(ip: string | undefined): string {
  if (!ip) return '';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, 4).join(':')}::/64`.slice(0, 64);
  }
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.0/24` : ip.slice(0, 64);
}

/** Pre-login flow state (OAuth state/nonce/PKCE verifier, link mode) lives in an HMAC-signed, short-lived cookie. */
export interface FlowState { provider: 'google' | 'apple'; mode: 'login' | 'link'; state: string; nonce: string; codeVerifier: string; personId: string | null; sessionId: string | null; exp: number }
export function signFlow(secret: Buffer, flow: FlowState): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
export function verifyFlow(secret: Buffer, cookie: string, now: Date): FlowState | null {
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = cookie.slice(0, dot);
  const mac = Buffer.from(cookie.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FlowState;
    if (typeof flow.exp !== 'number' || flow.exp <= now.getTime()) return null;
    return flow;
  } catch {
    return null;
  }
}
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

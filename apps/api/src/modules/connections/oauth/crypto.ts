import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque credentials of the authorization server. Every value is 256 bits from the CSPRNG, base64url, with a short
 * prefix so secret scanners recognise leaked values (`twac_` code, `twat_` access token, `twrt_` refresh token,
 * `twdc_` dynamic client id). Only the SHA-256 of a code or token is stored or logged-free compared; never the value.
 */
export type CredentialKind = 'code' | 'access' | 'refresh' | 'client';
const PREFIX: Record<CredentialKind, string> = { code: 'twac_', access: 'twat_', refresh: 'twrt_', client: 'twdc_' };

export function newCredential(kind: CredentialKind): string {
  return `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
}
export function credentialKindOf(value: string): CredentialKind | null {
  for (const [kind, prefix] of Object.entries(PREFIX) as [CredentialKind, string][]) if (value.startsWith(prefix) && /^[A-Za-z0-9_-]{48,60}$/.test(value)) return kind;
  return null;
}
export function hashCredential(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** RFC 7636: a verifier is 43 to 128 unreserved characters; the only method is S256. */
export const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * The validated authorization request handed to the first-party consent page: HMAC-signed with a key derived from the
 * flow secret, short-lived, and verified again when the person decides (the page cannot change the client, the
 * redirect URI, the resource, the PKCE challenge or widen the scopes).
 */
export interface AuthorizationRequest {
  v: 1;
  clientId: string;
  redirectUri: string;
  /** The registered redirect URI the presented one matched (the consent key; differs only by a loopback port). */
  registeredRedirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  surface: 'participant' | 'admin';
  scopes: string[];
  dpopJkt: string | null;
  exp: number;
}
const keyOf = (secret: Buffer) => createHmac('sha256', secret).update('trustwork.mcp.authorization-request.v1').digest();

export function signRequest(secret: Buffer, request: AuthorizationRequest): string {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', keyOf(secret)).update(payload).digest('base64url')}`;
}
export function verifyRequest(secret: Buffer, handle: string, now: Date): AuthorizationRequest | null {
  if (handle.length > 8_000) return null;
  const dot = handle.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = handle.slice(0, dot);
  const expected = createHmac('sha256', keyOf(secret)).update(payload).digest();
  const given = Buffer.from(handle.slice(dot + 1), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthorizationRequest;
    if (parsed.v !== 1 || typeof parsed.exp !== 'number' || parsed.exp * 1000 <= now.getTime()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Bounded in-memory replay cache for DPoP proof and client assertion `jti` values within their acceptance window. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 50_000) {}
  /** True the first time `key` is seen before `expiresAtMs`; false on a replay. */
  claim(key: string, expiresAtMs: number, nowMs: number): boolean {
    if (this.seen.size >= this.max) for (const [k, exp] of this.seen) if (exp <= nowMs || this.seen.size >= this.max) this.seen.delete(k);
    const known = this.seen.get(key);
    if (known !== undefined && known > nowMs) return false;
    this.seen.set(key, expiresAtMs);
    return true;
  }
}

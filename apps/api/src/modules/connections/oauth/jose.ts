import { createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { ReplayCache } from './crypto.js';

/**
 * The few JOSE operations the authorization server needs, on node:crypto only (no new dependency):
 * - compact JWS verification for ES256, EdDSA (Ed25519) and RS256 with a public JWK;
 * - RFC 7638 JWK thumbprints;
 * - RFC 9449 DPoP proofs (token endpoint and resource requests);
 * - RFC 7523 `private_key_jwt` client assertions for pre-registered confidential clients.
 */
export class JoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoseError';
  }
}

export const DPOP_ALGS = ['ES256', 'EdDSA'] as const;
export const ASSERTION_ALGS = ['ES256', 'EdDSA', 'RS256'] as const;
type Alg = (typeof ASSERTION_ALGS)[number];

interface Jws { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: Buffer; signature: Buffer }
function decode(token: string): Jws {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8_192) throw new JoseError('not a compact JWS');
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') throw new Error('shape');
    return { header, payload, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), signature: Buffer.from(parts[2]!, 'base64url') };
  } catch {
    throw new JoseError('malformed JWS');
  }
}

function publicKey(jwk: Record<string, unknown>, alg: Alg): KeyObject {
  if ('d' in jwk || 'p' in jwk || 'k' in jwk) throw new JoseError('the key is not a public key');
  const ok = (alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256') || (alg === 'EdDSA' && jwk.kty === 'OKP' && jwk.crv === 'Ed25519') || (alg === 'RS256' && jwk.kty === 'RSA');
  if (!ok) throw new JoseError('key type does not match the algorithm');
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    if (alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new JoseError('RSA keys are at least 2048 bits');
    return key;
  } catch (error) {
    if (error instanceof JoseError) throw error;
    throw new JoseError('invalid public key');
  }
}

function verifySignature(jws: Jws, key: KeyObject, alg: Alg): boolean {
  if (alg === 'ES256') return verify('sha256', jws.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
  if (alg === 'EdDSA') return verify(null, jws.signingInput, key, jws.signature);
  return verify('sha256', jws.signingInput, key, jws.signature);
}

/** RFC 7638 thumbprint (base64url SHA-256 of the required members in lexicographic order). */
export function jwkThumbprint(jwk: Record<string, unknown>): string {
  let members: Record<string, unknown>;
  if (jwk.kty === 'EC') members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  else if (jwk.kty === 'OKP') members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  else if (jwk.kty === 'RSA') members = { e: jwk.e, kty: jwk.kty, n: jwk.n };
  else throw new JoseError('unsupported key type');
  if (Object.values(members).some((v) => typeof v !== 'string')) throw new JoseError('incomplete key');
  return createHash('sha256').update(JSON.stringify(members), 'utf8').digest('base64url');
}

/** The URL a DPoP proof's `htu` is compared with: scheme, host and path, without query and fragment (RFC 9449 section 4.3). */
export function htuOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

export interface DpopCheck { method: string; url: string; now: Date; replay: ReplayCache; accessToken?: string; maxAgeSeconds?: number }
/** Verifies a DPoP proof and returns the thumbprint of its key. Throws `JoseError` on any failure. */
export function verifyDpopProof(proof: string, check: DpopCheck): string {
  const jws = decode(proof);
  const { header, payload } = jws;
  if (header.typ !== 'dpop+jwt') throw new JoseError('typ must be dpop+jwt');
  const alg = header.alg;
  if (typeof alg !== 'string' || !(DPOP_ALGS as readonly string[]).includes(alg)) throw new JoseError('unsupported DPoP algorithm');
  if (!header.jwk || typeof header.jwk !== 'object') throw new JoseError('the proof carries its public key');
  const jwk = header.jwk as Record<string, unknown>;
  const key = publicKey(jwk, alg as Alg);
  if (!verifySignature(jws, key, alg as Alg)) throw new JoseError('bad DPoP signature');
  if (payload.htm !== check.method.toUpperCase()) throw new JoseError('htm mismatch');
  if (typeof payload.htu !== 'string') throw new JoseError('htu missing');
  let htu: string;
  try {
    htu = htuOf(payload.htu);
  } catch {
    throw new JoseError('htu malformed');
  }
  if (htu !== htuOf(check.url)) throw new JoseError('htu mismatch');
  const iat = payload.iat;
  const maxAge = check.maxAgeSeconds ?? 60;
  const nowS = Math.floor(check.now.getTime() / 1000);
  if (typeof iat !== 'number' || Math.abs(nowS - iat) > maxAge) throw new JoseError('iat outside the acceptance window');
  if (typeof payload.jti !== 'string' || payload.jti.length < 8 || payload.jti.length > 200) throw new JoseError('jti missing');
  if (check.accessToken !== undefined) {
    const ath = createHash('sha256').update(check.accessToken, 'ascii').digest('base64url');
    if (payload.ath !== ath) throw new JoseError('ath mismatch');
  }
  const jkt = jwkThumbprint(jwk);
  if (!check.replay.claim(`dpop:${jkt}:${payload.jti}`, (iat + maxAge) * 1000 + 1000, check.now.getTime())) throw new JoseError('DPoP proof replayed');
  return jkt;
}

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export interface AssertionCheck { clientId: string; audiences: readonly string[]; jwks: { keys: Record<string, unknown>[] }; now: Date; replay: ReplayCache }
/** RFC 7523 client authentication: iss = sub = client id, aud names the issuer or the endpoint, short-lived, single-use. */
export function verifyClientAssertion(assertion: string, check: AssertionCheck): void {
  const jws = decode(assertion);
  const alg = jws.header.alg;
  if (typeof alg !== 'string' || !(ASSERTION_ALGS as readonly string[]).includes(alg)) throw new JoseError('unsupported assertion algorithm');
  const kid = jws.header.kid;
  const candidates = check.jwks.keys.filter((k) => kid === undefined || k.kid === kid);
  const verified = candidates.some((k) => {
    try {
      return verifySignature(jws, publicKey(k, alg as Alg), alg as Alg);
    } catch {
      return false;
    }
  });
  if (!verified) throw new JoseError('bad assertion signature');
  const p = jws.payload;
  if (p.iss !== check.clientId || p.sub !== check.clientId) throw new JoseError('iss and sub are the client id');
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.some((a) => typeof a === 'string' && check.audiences.includes(a))) throw new JoseError('aud mismatch');
  const nowS = Math.floor(check.now.getTime() / 1000);
  if (typeof p.exp !== 'number' || p.exp <= nowS || p.exp > nowS + 300) throw new JoseError('exp outside the five-minute window');
  if (typeof p.jti !== 'string' || p.jti.length < 8 || p.jti.length > 200) throw new JoseError('jti missing');
  if (!check.replay.claim(`assertion:${check.clientId}:${p.jti}`, p.exp * 1000 + 1000, check.now.getTime())) throw new JoseError('assertion replayed');
}

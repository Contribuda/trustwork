import { randomBytes } from 'node:crypto';
import {
  contentDigestField, HTTP_COVERED_COMPONENTS, HTTP_SIGNATURE_MAX_AGE_SECONDS, httpSignatureBase, httpSignatureFields, httpSignatureProblems, keyForSignature,
  parseContentDigestField, parseHttpSignatureFields, toBase64Url, type Ed25519Sign, type FederationErrorCode, type HttpSignatureParams, type NodeKey,
} from './deps.js';
import { sha256, verifyEd25519 } from './crypto.js';

/**
 * RFC 9421 HTTP message signatures and RFC 9530 content digests for the mesh (protocol section 6.2). The contracts
 * build the signature base and parse the fields; this file applies them to real messages:
 *
 * - `signRequest` and `signResponse` produce the `Content-Digest`, `Signature-Input` and `Signature` fields for the
 *   node's own messages (a request with a body carries a fresh nonce);
 * - `verifySignedMessage` checks a received message: the body matches its digest, the expected components are covered,
 *   the window and clock skew hold, a nonce is present where required, the key label names a key of the sender's manifest
 *   valid at `created` (not retired, not compromised), the Ed25519 signature verifies, and only then the nonce is recorded
 *   and a repeat refused.
 *
 * Every refusal is a protocol error code; no address and no signature material is echoed.
 */
export const CONTENT_TYPE = 'application/json';
/** Header fields of a signed message (lowercase names); a request without a body has no digest or content type. */
export type SignedFields = Record<string, string> & { 'signature-input': string; signature: string };
export interface Signer { keyId: string; sign: Ed25519Sign }

function params(keyId: string, nowSeconds: number, nonce: string | null): HttpSignatureParams {
  return { created: nowSeconds, expires: nowSeconds + HTTP_SIGNATURE_MAX_AGE_SECONDS, keyid: keyId, nonce };
}
export function freshNonce(): string {
  return toBase64Url(randomBytes(24));
}

/** Signs a request; `body` is the exact bytes that will be sent (JCS form), or null for a request without a body. */
export function signRequest(input: { method: string; targetUri: string; body: Uint8Array | null; signer: Signer; now: Date }): SignedFields {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const components = input.body ? HTTP_COVERED_COMPONENTS.requestWithBody : HTTP_COVERED_COMPONENTS.requestWithoutBody;
  const digest = input.body ? contentDigestField(sha256(input.body)) : null;
  const p = params(input.signer.keyId, nowSeconds, input.body ? freshNonce() : null);
  const base = httpSignatureBase({
    method: input.method, targetUri: input.targetUri,
    field: (name) => (name === 'content-digest' ? digest : name === 'content-type' ? CONTENT_TYPE : null),
  }, components, p);
  const fields = httpSignatureFields(components, p, input.signer.sign(new TextEncoder().encode(base)));
  return { ...(digest ? { 'content-digest': digest, 'content-type': CONTENT_TYPE } : {}), 'signature-input': fields.signatureInput, signature: fields.signature };
}

/** Signs a response over `@status`, the content digest of `body` and the content type. */
export function signResponse(input: { status: number; body: Uint8Array; signer: Signer; now: Date }): SignedFields {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const digest = contentDigestField(sha256(input.body));
  const p = params(input.signer.keyId, nowSeconds, null);
  const base = httpSignatureBase({ status: input.status, field: (name) => (name === 'content-digest' ? digest : name === 'content-type' ? CONTENT_TYPE : null) }, HTTP_COVERED_COMPONENTS.response, p);
  const fields = httpSignatureFields(HTTP_COVERED_COMPONENTS.response, p, input.signer.sign(new TextEncoder().encode(base)));
  return { 'content-digest': digest, 'content-type': CONTENT_TYPE, 'signature-input': fields.signatureInput, signature: fields.signature };
}

export interface ReceivedMessage {
  /** Request: method and target URI as the receiver reconstructs it (`https://<own host><path>`). Response: status. */
  method?: string;
  targetUri?: string;
  status?: number;
  /** Lowercase header lookup; returns the single value or null. */
  header(name: string): string | null;
  /** The exact body bytes received, or null for a message without a body. */
  body: Uint8Array | null;
}
export type Verification =
  | { ok: true; keyId: string; nonce: string | null; expiresAt: Date }
  | { ok: false; code: FederationErrorCode; reason: string };

/** Which nonces were seen: returns true when `(keyId, nonce)` is new and now remembered until `expiresAt`. */
export type NonceStore = (keyId: string, nonce: string, expiresAt: Date) => Promise<boolean>;

const refuse = (code: FederationErrorCode, reason: string): Verification => ({ ok: false, code, reason });

/**
 * Verifies a received request or response against the sender's key chain. The order of checks is fixed: fields, body
 * digest, coverage and window, key selection, replay, signature. A missing key label is `federation.key_unknown`, which
 * callers answer by refreshing the sender's manifest once before refusing.
 */
export type ParsedSignature = NonNullable<ReturnType<typeof parseHttpSignatureFields>>;
/**
 * Everything a receiver checks before it needs the sender's keys: the body digest and content type, the covered
 * components, the window and clock skew, and the nonce where required. Running these first means no unknown key label
 * can cost the receiver a fetch of the sender's manifest for a message that is malformed, stale or tampered.
 */
export function checkMessageShape(message: ReceivedMessage, parsed: ParsedSignature, now: Date): Verification | null {
  const isResponse = message.status !== undefined;
  const expected = isResponse ? HTTP_COVERED_COMPONENTS.response : message.body ? HTTP_COVERED_COMPONENTS.requestWithBody : HTTP_COVERED_COMPONENTS.requestWithoutBody;
  const digestField = message.header('content-digest');
  if (message.body) {
    const declared = digestField ? parseContentDigestField(digestField) : null;
    if (!declared) return refuse('federation.digest_mismatch', 'content_digest_missing');
    const actual = sha256(message.body);
    if (Buffer.compare(Buffer.from(declared), Buffer.from(actual)) !== 0) return refuse('federation.digest_mismatch', 'content_digest_mismatch');
    const contentType = message.header('content-type');
    if (!contentType || !contentType.toLowerCase().startsWith(CONTENT_TYPE)) return refuse('federation.signature_invalid', 'content_type');
  } else if (!isResponse && digestField) {
    return refuse('federation.digest_mismatch', 'digest_without_body');
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const problems = httpSignatureProblems(parsed, expected, nowSeconds);
  if (problems.includes('components')) return refuse('federation.signature_invalid', 'components_not_covered');
  if (problems.includes('window')) return refuse('federation.signature_invalid', 'window');
  if (problems.includes('clock_skew')) return refuse('federation.clock_skew', 'outside_window');
  if (!isResponse && problems.includes('nonce_missing')) return refuse('federation.signature_invalid', 'nonce_missing');
  return null;
}

export async function verifySignedMessage(message: ReceivedMessage, keys: readonly NodeKey[], now: Date, nonces: NonceStore | null): Promise<Verification> {
  const signatureInput = message.header('signature-input');
  const signature = message.header('signature');
  if (!signatureInput || !signature) return refuse('federation.signature_invalid', 'unsigned');
  const parsed = parseHttpSignatureFields(signatureInput, signature);
  if (!parsed) return refuse('federation.signature_invalid', 'signature_fields_malformed');
  const isResponse = message.status !== undefined;
  const shape = checkMessageShape(message, parsed, now);
  if (shape) return shape;
  const createdAt = new Date(parsed.params.created * 1000).toISOString();
  const selected = keyForSignature(keys, parsed.params.keyid, createdAt);
  if (!selected.ok) return refuse(selected.code, selected.code === 'federation.key_unknown' ? 'key_unknown' : 'key_revoked');
  const expiresAt = new Date(parsed.params.expires * 1000);
  let base: string;
  try {
    base = httpSignatureBase({
      ...(message.method !== undefined ? { method: message.method } : {}), ...(message.targetUri !== undefined ? { targetUri: message.targetUri } : {}),
      ...(message.status !== undefined ? { status: message.status } : {}), field: (name) => message.header(name),
    }, parsed.components, parsed.params);
  } catch {
    return refuse('federation.signature_invalid', 'base_incomplete');
  }
  const publicKey = Buffer.from(selected.key.publicKey, 'base64url');
  if (!verifyEd25519(new Uint8Array(publicKey), new TextEncoder().encode(base), parsed.signature)) return refuse('federation.signature_invalid', 'signature_mismatch');
  // The nonce is remembered only for a signature that verified: a forged request cannot poison the sender's nonces.
  if (!isResponse && parsed.params.nonce !== null && nonces) {
    const fresh = await nonces(parsed.params.keyid, parsed.params.nonce, expiresAt);
    if (!fresh) return refuse('federation.replay', 'nonce_seen');
  }
  return { ok: true, keyId: parsed.params.keyid, nonce: parsed.params.nonce, expiresAt };
}

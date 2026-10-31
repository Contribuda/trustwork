import { canonicalize } from '../../../packages/contracts/src/common/canonical.js';
import { utf8Decode } from '../../../packages/contracts/src/common/encoding.js';
import {
  HTTP_COVERED_COMPONENTS,
  MESH_PROTOCOL,
  contentDigestField,
  httpSignatureBase,
  httpSignatureFields,
  objectSigningInput,
  rotationStatementFor,
  type HttpSignatureParams,
  type SignaturePurpose,
} from '../../../packages/contracts/src/federation.js';
import {
  CITY,
  NATIONAL,
  NODE_SIGNERS,
  NOW,
  RFC8032,
  computeDigest,
  dealEnvelope,
  envelope,
  manifest,
  nationalKeyChain,
  publicKeyB64,
  sha256,
  toHex,
  tombstone,
} from './fixtures.js';

/*
 * Conformance vectors of trustwork-mesh/1 (FED-000). Everything here is deterministic: JCS is canonical, SHA-256 is a
 * function and Ed25519 signatures (RFC 8032) are deterministic, so the committed JSON files are reproduced byte for
 * byte by `buildVectors()`. Regenerate with:
 *
 *   node --import tsx tests/federation/protocol/generate-vectors.ts
 *
 * and review the diff: a changed vector is a protocol change and needs an ADR (federation chapter, "Open questions").
 */

export const VECTOR_FILES = ['digests.json', 'signatures.json', 'http-signatures.json'] as const;
export type VectorFile = (typeof VECTOR_FILES)[number];

function digestVector(name: string, description: string, input: unknown) {
  const canonical = canonicalize(input);
  return { name, description, input, canonical, digest: computeDigest(input) };
}

function signatureVector(name: string, description: string, purpose: SignaturePurpose, document: Record<string, unknown> & { signature: { keyId: string; value: string } }, publicKey: string) {
  const { signature, ...rest } = document;
  const input = objectSigningInput(purpose, rest, { algorithm: 'ed25519', keyId: signature.keyId });
  return { name, description, purpose, keyId: signature.keyId, publicKey, signingInput: utf8Decode(input), signingInputSha256: toHex(sha256(input)), signature: signature.value, document };
}

function httpVector(
  name: string,
  description: string,
  message: { method?: string; targetUri?: string; status?: number; headers: Record<string, string>; body: string | null },
  components: readonly string[],
  params: HttpSignatureParams,
  signer: { sign: (m: Uint8Array) => Uint8Array },
  publicKey: string,
) {
  const lower = Object.fromEntries(Object.entries(message.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const base = httpSignatureBase({ method: message.method, targetUri: message.targetUri, status: message.status, field: (n) => lower[n] ?? null }, components, params);
  const signature = signer.sign(new TextEncoder().encode(base));
  const fields = httpSignatureFields(components, params, signature);
  return { name, description, publicKey, message, components, params, signatureBase: base, signatureInput: fields.signatureInput, signature: fields.signature };
}

export function buildVectors(): Record<VectorFile, unknown> {
  const publication = envelope();
  const quote = dealEnvelope();
  const digests = {
    protocol: MESH_PROTOCOL,
    algorithm: 'trustwork-digest-1 = lowercase hex SHA-256 of the UTF-8 bytes of RFC 8785 (JCS) canonical JSON',
    vectors: [
      digestVector('empty-object', 'The empty payload.', {}),
      digestVector('key-order-and-escapes', 'Keys sorted by UTF-16 code units, JSON.stringify escaping, integers, nested arrays, non-ASCII kept as is (NFC applied before).', {
        z: 1, a: [true, null, 'line\nbreak', { y: 'tab\t', b: '"quoted"' }], 'é': 'Café', '€': 'euro', '\u{1F3D7}': 'crane', num: 100, neg: -7,
      }),
      digestVector('publication-payload', 'The public payload of the publication envelope in signatures.json.', publication.payload),
      digestVector('quote-version-payload', 'The shared_party payload of the quote version envelope in signatures.json.', quote.payload),
    ],
  };

  const chain = nationalKeyChain();
  const k2 = chain[1]!;
  const rotation = { ...rotationStatementFor(NATIONAL, chain[0]!, k2), signature: k2.rotation!.signature };
  const signatures = {
    protocol: MESH_PROTOCOL,
    algorithm: 'Ed25519 (RFC 8032) over UTF-8("trustwork-mesh/1" LF purpose LF JCS(document with signature = {algorithm, keyId}))',
    keys: {
      note: 'RFC 8032 section 7.1 test keys; public test data, never node keys.',
      [`${NATIONAL}#k1`]: { publicKey: publicKeyB64(RFC8032.test1), rfc8032: 'TEST 1' },
      [`${NATIONAL}#k2`]: { publicKey: publicKeyB64(RFC8032.test2), rfc8032: 'TEST 2' },
      [`${CITY}#a1`]: { publicKey: publicKeyB64(RFC8032.test3), rfc8032: 'TEST 3' },
    },
    vectors: [
      signatureVector('key-rotation', 'k1 hands over to k2; signed by the previous key k1.', 'key_rotation', rotation, publicKeyB64(RFC8032.test1)),
      signatureVector('manifest', 'The national node manifest, signed with its current key k2.', 'manifest', manifest() as never, publicKeyB64(RFC8032.test2)),
      signatureVector('envelope-public-publication', 'A public editorial publication (CC BY 4.0) from the national node.', 'envelope', publication as never, publicKeyB64(RFC8032.test2)),
      signatureVector('envelope-shared-party-quote', 'A shared_party quote version from the city node to the parties\' nodes.', 'envelope', quote as never, publicKeyB64(RFC8032.test3)),
      signatureVector('tombstone-unpublished', 'An unpublication tombstone for the publication, applied within 72 hours.', 'tombstone', tombstone() as never, publicKeyB64(RFC8032.test2)),
    ],
  };

  const created = Date.parse(NOW) / 1000;
  const delivery = { protocol: MESH_PROTOCOL, deliveryId: 'dlv-0001', senderNode: CITY, recipientNode: NATIONAL, sentAt: NOW, item: { type: 'envelope', envelope: quote } };
  const body = canonicalize(delivery);
  const feedBody = canonicalize({ protocol: MESH_PROTOCOL, node: NATIONAL, stream: 'publications', after: null, items: [{ type: 'envelope', envelope: publication }], next: null, generatedAt: NOW });
  const city = NODE_SIGNERS[CITY]!;
  const national = NODE_SIGNERS[NATIONAL]!;
  const http = {
    protocol: MESH_PROTOCOL,
    algorithm: 'RFC 9421 HTTP Message Signatures, label "tw", alg "ed25519", tag "trustwork-mesh/1"; Content-Digest per RFC 9530 (sha-256)',
    vectors: [
      httpVector(
        'inbox-post',
        'The city node pushes the quote version to the national node inbox.',
        { method: 'POST', targetUri: `https://${NATIONAL}/federation/v1/inbox`, headers: { 'Content-Type': 'application/json', 'Content-Digest': contentDigestField(sha256(body)) }, body },
        HTTP_COVERED_COMPONENTS.requestWithBody,
        { created, expires: created + 300, keyid: city.keyId, nonce: 'bm9uY2Utb2YtdGhlLWluYm94LXZlY3Rvcg' },
        city,
        publicKeyB64(RFC8032.test3),
      ),
      httpVector(
        'feed-get',
        'The city node pulls the national publications feed.',
        { method: 'GET', targetUri: `https://${NATIONAL}/federation/v1/feeds/publications?after=c1`, headers: {}, body: null },
        HTTP_COVERED_COMPONENTS.requestWithoutBody,
        { created, expires: created + 300, keyid: city.keyId, nonce: null },
        city,
        publicKeyB64(RFC8032.test3),
      ),
      httpVector(
        'feed-response',
        'The national node answers the feed request with one envelope.',
        { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Digest': contentDigestField(sha256(feedBody)) }, body: feedBody },
        HTTP_COVERED_COMPONENTS.response,
        { created, expires: created + 300, keyid: national.keyId, nonce: null },
        national,
        publicKeyB64(RFC8032.test2),
      ),
    ],
  };
  return { 'digests.json': digests, 'signatures.json': signatures, 'http-signatures.json': http };
}

/** The exact file text: two-space JSON with a final newline. */
export function vectorFileText(content: unknown): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

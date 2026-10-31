import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../../../packages/contracts/src/common/canonical.js';
import { verifyDigest } from '../../../packages/contracts/src/common/digest.js';
import { toBase64Url, utf8Encode } from '../../../packages/contracts/src/common/encoding.js';
import {
  FederatedEnvelopeSchema,
  FederationTombstoneSchema,
  KeyRotationStatementSchema,
  envelopeDigestInput,
  httpSignatureBase,
  keyForSignature,
  nodeManifestSchema,
  objectSigningInput,
  parseContentDigestField,
  parseHttpSignatureFields,
  verifyDocumentSignature,
  verifyManifestSignatures,
  type ObjectSignature,
  type SignaturePurpose,
} from '../../../packages/contracts/src/federation.js';
import {
  RFC8032,
  RFC8032_TEST1_EMPTY_SIGNATURE,
  b64urlToBytes,
  computeDigest,
  derivedPublicKey,
  nationalKeyChain,
  publicKeyB64,
  restricted,
  sha256,
  signerFor,
  toHex,
  verifyEd25519,
} from './fixtures.js';
import { VECTOR_FILES, buildVectors, vectorFileText } from './vectors.js';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), 'vectors');
const load = (file: string) => JSON.parse(readFileSync(resolve(directory, file), 'utf8'));

interface DigestVector { name: string; input: unknown; canonical: string; digest: { algorithm: string; value: string } }
interface SignatureVector { name: string; purpose: SignaturePurpose; keyId: string; publicKey: string; signingInput: string; signingInputSha256: string; signature: string; document: Record<string, unknown> & { signature: ObjectSignature } }
interface HttpVector {
  name: string; publicKey: string; components: string[]; signatureBase: string; signatureInput: string; signature: string;
  params: { created: number; expires: number; keyid: string; nonce: string | null };
  message: { method?: string; targetUri?: string; status?: number; headers: Record<string, string>; body: string | null };
}

test('the Ed25519 adapter used by the vectors is RFC 8032 conformant (TEST 1, empty message; derived public keys)', () => {
  const signature = signerFor(RFC8032.test1)(new Uint8Array());
  assert.equal(toHex(signature), RFC8032_TEST1_EMPTY_SIGNATURE);
  for (const key of Object.values(RFC8032)) assert.equal(derivedPublicKey(key), publicKeyB64(key));
});

test('the committed vector files are exactly what the generator produces (deterministic, reviewed protocol)', () => {
  const built = buildVectors();
  for (const file of VECTOR_FILES) assert.equal(readFileSync(resolve(directory, file), 'utf8'), vectorFileText(built[file]), `${file} drifted: regenerate and review`);
});

test('digest vectors: canonical JSON and trustwork-digest-1 recompute and verify', () => {
  const { vectors } = load('digests.json') as { vectors: DigestVector[] };
  assert.equal(vectors.length, 4);
  for (const v of vectors) {
    assert.equal(canonicalize(v.input), v.canonical, v.name);
    assert.equal(toHex(sha256(utf8Encode(v.canonical))), v.digest.value, v.name);
    assert.deepEqual(computeDigest(v.input), v.digest, v.name);
    assert.ok(verifyDigest(v.input, v.digest as never), v.name);
  }
  const empty = vectors.find((v) => v.name === 'empty-object')!;
  assert.equal(empty.digest.value, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 'SHA-256 of "{}"');
  const order = vectors.find((v) => v.name === 'key-order-and-escapes')!;
  assert.ok(order.canonical.startsWith('{"a":[true,null,"line\\nbreak",{"b":"\\"quoted\\"","y":"tab\\t"}],"neg":-7,"num":100,"z":1,'), order.canonical);
});

test('signature vectors: signing input, its hash and the Ed25519 signature verify against the published key', () => {
  const { vectors } = load('signatures.json') as { vectors: SignatureVector[] };
  assert.deepEqual(vectors.map((v) => v.name), ['key-rotation', 'manifest', 'envelope-public-publication', 'envelope-shared-party-quote', 'tombstone-unpublished']);
  for (const v of vectors) {
    const { signature, ...rest } = v.document;
    const input = objectSigningInput(v.purpose, rest, { algorithm: 'ed25519', keyId: v.keyId });
    assert.equal(new TextDecoder().decode(input), v.signingInput, v.name);
    assert.ok(v.signingInput.startsWith(`trustwork-mesh/1\n${v.purpose.replace(/-/g, '_')}\n{`), v.name);
    assert.equal(toHex(sha256(input)), v.signingInputSha256, v.name);
    assert.equal(signature.value, v.signature, v.name);
    assert.ok(verifyEd25519(b64urlToBytes(v.publicKey), input, b64urlToBytes(v.signature)), `${v.name} verifies`);
    assert.ok(verifyDocumentSignature(v.purpose, v.document, v.publicKey, verifyEd25519), `${v.name} verifies through the contract`);
  }
});

test('signature vectors: the documents are valid protocol documents and envelope digests match their payloads', () => {
  const byName = Object.fromEntries((load('signatures.json') as { vectors: SignatureVector[] }).vectors.map((v) => [v.name, v.document]));
  const manifest = nodeManifestSchema(restricted).parse(byName['manifest']);
  assert.ok(verifyManifestSignatures(manifest, verifyEd25519));
  const rotation: Record<string, unknown> = { ...byName['key-rotation']! };
  delete rotation['signature'];
  KeyRotationStatementSchema.parse(rotation);
  for (const name of ['envelope-public-publication', 'envelope-shared-party-quote']) {
    const envelope = FederatedEnvelopeSchema.parse(byName[name]);
    assert.ok(verifyDigest(envelopeDigestInput(envelope), envelope.digest), `${name} digest`);
  }
  FederationTombstoneSchema.parse(byName['tombstone-unpublished']);
});

test('negative vectors: a changed payload, a changed signature, another purpose or another key never verify', () => {
  const { vectors } = load('signatures.json') as { vectors: SignatureVector[] };
  const publication = vectors.find((v) => v.name === 'envelope-public-publication')!;
  const doc = structuredClone(publication.document) as Record<string, unknown> & { signature: ObjectSignature; payload: Record<string, unknown>; digest: { algorithm: 'trustwork-digest-1'; value: string } };

  const tamperedPayload = { ...doc, payload: { ...doc.payload, title: 'Changed on the way' } };
  assert.equal(verifyDigest(envelopeDigestInput(tamperedPayload), doc.digest), false, 'digest no longer matches');
  assert.equal(verifyDocumentSignature('envelope', tamperedPayload, publication.publicKey, verifyEd25519), false, 'signature no longer matches');

  const flipped = b64urlToBytes(doc.signature.value);
  flipped[0] = flipped[0]! ^ 0x01;
  assert.equal(verifyDocumentSignature('envelope', { ...doc, signature: { ...doc.signature, value: toBase64Url(flipped) } }, publication.publicKey, verifyEd25519), false);
  assert.equal(verifyDocumentSignature('tombstone', doc, publication.publicKey, verifyEd25519), false, 'purpose is bound');
  assert.equal(verifyDocumentSignature('envelope', doc, publicKeyB64(RFC8032.test1), verifyEd25519), false, 'another key');
  assert.equal(verifyDocumentSignature('envelope', { ...doc, signature: { ...doc.signature, keyId: 'k1' } }, publication.publicKey, verifyEd25519), false, 'key label is bound');
  assert.equal(verifyDocumentSignature('envelope', { ...doc, projection: 'owner_private' }, publication.publicKey, verifyEd25519), false);
});

test('key rotation: signatures by the retired key stay valid for their time, later ones and compromised ones are refused', () => {
  const chain = nationalKeyChain();
  assert.deepEqual(keyForSignature(chain, 'k1', '2026-09-30T23:59:59.000Z'), { ok: true, key: chain[0] });
  assert.deepEqual(keyForSignature(chain, 'k1', '2026-10-01T00:00:00.000Z'), { ok: false, code: 'federation.key_revoked' });
  assert.deepEqual(keyForSignature(chain, 'k2', '2026-09-30T00:00:00.000Z'), { ok: false, code: 'federation.key_unknown' });
  assert.deepEqual(keyForSignature(chain, 'k2', '2026-11-02T08:00:00.000Z'), { ok: true, key: chain[1] });
  assert.deepEqual(keyForSignature(chain, 'k9', '2026-11-02T08:00:00.000Z'), { ok: false, code: 'federation.key_unknown' });
  const compromised = [{ ...chain[0]!, revocation: { compromisedSince: '2026-08-15T00:00:00.000Z', revokedAt: '2026-10-01T00:00:00.000Z' } }, chain[1]!];
  assert.deepEqual(keyForSignature(compromised, 'k1', '2026-08-14T23:59:59.000Z'), { ok: true, key: compromised[0] });
  assert.deepEqual(keyForSignature(compromised, 'k1', '2026-08-15T00:00:00.000Z'), { ok: false, code: 'federation.key_revoked' });
});

test('HTTP signature vectors: content digest, signature base and RFC 9421 fields recompute and verify', () => {
  const { vectors } = load('http-signatures.json') as { vectors: HttpVector[] };
  assert.deepEqual(vectors.map((v) => v.name), ['inbox-post', 'feed-get', 'feed-response']);
  for (const v of vectors) {
    const headers = Object.fromEntries(Object.entries(v.message.headers).map(([k, value]) => [k.toLowerCase(), value]));
    if (v.message.body !== null) {
      const digest = parseContentDigestField(headers['content-digest']!);
      assert.ok(digest, v.name);
      assert.equal(toHex(digest), toHex(sha256(v.message.body)), `${v.name} content digest`);
    }
    const parsed = parseHttpSignatureFields(v.signatureInput, v.signature);
    assert.ok(parsed, v.name);
    assert.deepEqual(parsed.components, v.components);
    assert.deepEqual(parsed.params, v.params);
    const base = httpSignatureBase({ method: v.message.method, targetUri: v.message.targetUri, status: v.message.status, field: (n) => headers[n] ?? null }, parsed.components, parsed.params);
    assert.equal(base, v.signatureBase, v.name);
    assert.ok(verifyEd25519(b64urlToBytes(v.publicKey), utf8Encode(base), parsed.signature), `${v.name} verifies`);
    // A body changed in transit breaks the content digest; a changed target breaks the signature.
    if (v.message.body !== null) assert.notEqual(toHex(sha256(`${v.message.body} `)), toHex(parseContentDigestField(headers['content-digest']!)!));
    if (v.message.targetUri) {
      const moved = httpSignatureBase({ method: v.message.method, targetUri: v.message.targetUri.replace('build.', 'evil.'), field: (n) => headers[n] ?? null }, parsed.components, parsed.params);
      assert.equal(verifyEd25519(b64urlToBytes(v.publicKey), utf8Encode(moved), parsed.signature), false, `${v.name} bound to its target`);
    }
  }
  const post = vectors[0]!;
  assert.equal(post.signatureBase.split('\n')[0], '"@method": POST');
  assert.ok(post.signatureInput.startsWith('tw=("@method" "@target-uri" "content-digest" "content-type");created=1793606400;expires=1793606700;keyid="a1";alg="ed25519";nonce="'));
});

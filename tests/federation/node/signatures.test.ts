import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../../../packages/contracts/src/common/canonical.js';
import { utf8Encode } from '../../../packages/contracts/src/common/encoding.js';
import { HTTP_SIGNATURE_MAX_AGE_SECONDS, signDocument, verifyDocumentSignature, type NodeKey } from '../../../packages/contracts/src/federation.js';
import { fakeNodeKeySealer, generateNodeKey, NodeSeed, verifyEd25519 } from '../../../apps/api/src/modules/federation/node/crypto.js';
import { signRequest, signResponse, verifySignedMessage, type ReceivedMessage } from '../../../apps/api/src/modules/federation/node/http-signatures.js';
import { cityKeyChain, nationalKeyChain, NODE_SIGNERS, RFC8032, RFC8032_TEST1_EMPTY_SIGNATURE, signerFor, toHex } from '../protocol/fixtures.js';
import { forgedSigner } from './helpers.js';

/*
 * The node's crypto adapter and HTTP message signature layer, without a database: keys never serialize, the sealer
 * round-trips a seed only for its own node and key, and a received message is refused when unsigned, forged, replayed,
 * expired, signed by an unknown or revoked key, or carrying a body that does not match its digest.
 */
const NOW = new Date('2026-11-02T08:00:00.000Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const TARGET = 'https://sandiego.example.org/federation/v1/handshake';
const body = utf8Encode(canonicalize({ protocol: 'trustwork-mesh/1', hello: 'peer' }));
const city = cityKeyChain();
const citySigner = NODE_SIGNERS['austin.example.org']!;

function received(fields: Record<string, string>, overrides: Partial<ReceivedMessage> & { drop?: string[] } = {}): ReceivedMessage {
  const headers = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of overrides.drop ?? []) headers.delete(name);
  return { method: 'POST', targetUri: TARGET, body, ...overrides, header: (name) => headers.get(name.toLowerCase()) ?? null };
}
/** A nonce store that remembers what it saw. */
function nonceStore() {
  const seen = new Set<string>();
  return async (keyId: string, nonce: string) => {
    const key = `${keyId}|${nonce}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

test('the adapter is a conformant Ed25519: RFC 8032 TEST 1 reproduces the published signature and a seed never serializes', () => {
  const seed = new NodeSeed(Buffer.from(RFC8032.test1.secret, 'hex'));
  assert.equal(toHex(seed.publicKey()), RFC8032.test1.public);
  assert.equal(toHex(seed.signer()(new Uint8Array())), RFC8032_TEST1_EMPTY_SIGNATURE);
  assert.equal(String(seed), '[node seed]');
  assert.equal(JSON.stringify({ seed }), '{"seed":"[node seed]"}');
  assert.ok(!JSON.stringify(seed).includes(RFC8032.test1.secret));
  const generated = generateNodeKey();
  assert.match(generated.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(verifyEd25519(generated.seed.publicKey(), body, generated.seed.signer()(body)));
  generated.seed.destroy();
});

test('the sealer opens a seed only for the node and key it was sealed for', async () => {
  const sealer = fakeNodeKeySealer();
  const { seed } = generateNodeKey();
  const sealed = await sealer.seal(seed, '11111111-1111-4111-8111-111111111111', 'k1');
  assert.ok(!Buffer.from(sealed.ciphertext).equals(seed.bytes()), 'the ciphertext is not the seed');
  const opened = await sealer.open(sealed, '11111111-1111-4111-8111-111111111111', 'k1');
  assert.deepEqual(opened.publicKey(), seed.publicKey());
  await assert.rejects(sealer.open(sealed, '11111111-1111-4111-8111-111111111111', 'k2'), /unreadable/);
  await assert.rejects(sealer.open(sealed, '22222222-2222-4222-8222-222222222222', 'k1'), /unreadable/);
  await assert.rejects(sealer.open({ ...sealed, kekId: 'kms:other' }, '11111111-1111-4111-8111-111111111111', 'k1'), /kek_mismatch/);
  seed.destroy();
});

test('object signatures: a document signed with one purpose never verifies as another, and a forged key fails', () => {
  const doc = { protocol: 'trustwork-mesh/1', statement: 'synthetic' };
  const signed = signDocument('manifest', doc, 'a1', citySigner.sign);
  assert.ok(verifyDocumentSignature('manifest', signed, city[0]!.publicKey, verifyEd25519));
  assert.ok(!verifyDocumentSignature('envelope', signed, city[0]!.publicKey, verifyEd25519));
  assert.ok(!verifyDocumentSignature('manifest', { ...signed, statement: 'tampered' }, city[0]!.publicKey, verifyEd25519));
  assert.ok(!verifyDocumentSignature('manifest', signed, nationalKeyChain()[0]!.publicKey, verifyEd25519));
});

test('HTTP signatures: a correctly signed request verifies; unsigned, forged, tampered, replayed and expired ones are refused', async () => {
  const fields = signRequest({ method: 'POST', targetUri: TARGET, body, signer: citySigner, now: NOW });
  assert.match(fields['signature-input'], /^tw=\("@method" "@target-uri" "content-digest" "content-type"\);created=\d+;expires=\d+;keyid="a1";alg="ed25519";nonce="[A-Za-z0-9_-]+";tag="trustwork-mesh\/1"$/);
  const nonces = nonceStore();
  const ok = await verifySignedMessage(received(fields), city, NOW, nonces);
  assert.deepEqual(ok, { ok: true, keyId: 'a1', nonce: /nonce="([^"]+)"/.exec(fields['signature-input'])![1], expiresAt: new Date((nowSeconds + HTTP_SIGNATURE_MAX_AGE_SECONDS) * 1000) });

  // Replay: the same (key, nonce) a second time.
  const replay = await verifySignedMessage(received(fields), city, NOW, nonces);
  assert.deepEqual(replay, { ok: false, code: 'federation.replay', reason: 'nonce_seen' });
  // Unsigned.
  assert.deepEqual(await verifySignedMessage(received(fields, { drop: ['signature'] }), city, NOW, nonceStore()), { ok: false, code: 'federation.signature_invalid', reason: 'unsigned' });
  // Forged: another key under the peer's label.
  const forged = signRequest({ method: 'POST', targetUri: TARGET, body, signer: forgedSigner, now: NOW });
  assert.deepEqual(await verifySignedMessage(received(forged), city, NOW, nonceStore()), { ok: false, code: 'federation.signature_invalid', reason: 'signature_mismatch' });
  // Tampered body: the digest no longer matches.
  assert.deepEqual(await verifySignedMessage(received(fields, { body: utf8Encode('{"hello":"other"}') }), city, NOW, nonceStore()), { ok: false, code: 'federation.digest_mismatch', reason: 'content_digest_mismatch' });
  // A body swapped together with its digest: the signature covers the digest.
  const other = utf8Encode('{"hello":"other"}');
  const swapped = { ...fields, 'content-digest': signRequest({ method: 'POST', targetUri: TARGET, body: other, signer: citySigner, now: NOW })['content-digest']! };
  assert.deepEqual(await verifySignedMessage(received(swapped, { body: other }), city, NOW, nonceStore()), { ok: false, code: 'federation.signature_invalid', reason: 'signature_mismatch' });
  // Another target: the signature binds the URI.
  assert.deepEqual(await verifySignedMessage(received(fields, { targetUri: 'https://other.example.org/federation/v1/handshake' }), city, NOW, nonceStore()), { ok: false, code: 'federation.signature_invalid', reason: 'signature_mismatch' });
  // Expired: verified 10 minutes later.
  assert.deepEqual(await verifySignedMessage(received(fields), city, new Date(NOW.getTime() + 10 * 60_000), nonceStore()), { ok: false, code: 'federation.clock_skew', reason: 'outside_window' });
  // From the future beyond the skew.
  assert.deepEqual(await verifySignedMessage(received(fields), city, new Date(NOW.getTime() - 2 * 60_000), nonceStore()), { ok: false, code: 'federation.clock_skew', reason: 'outside_window' });
  // Unknown key label and a key compromised before the signature.
  assert.deepEqual(await verifySignedMessage(received(fields), nationalKeyChain(), NOW, nonceStore()), { ok: false, code: 'federation.key_unknown', reason: 'key_unknown' });
  const compromised: NodeKey[] = [{ ...city[0]!, retiredAt: '2026-12-01T00:00:00.000Z', revocation: { compromisedSince: '2026-11-01T00:00:00.000Z', revokedAt: '2026-11-03T00:00:00.000Z' } }];
  assert.deepEqual(await verifySignedMessage(received(fields), compromised, NOW, nonceStore()), { ok: false, code: 'federation.key_revoked', reason: 'key_revoked' });
  // A request with a body but no nonce.
  const noNonce = { ...fields, 'signature-input': fields['signature-input'].replace(/;nonce="[^"]+"/, '') };
  assert.deepEqual(await verifySignedMessage(received(noNonce), city, NOW, nonceStore()), { ok: false, code: 'federation.signature_invalid', reason: 'nonce_missing' });
});

test('HTTP signatures: responses are signed over status, digest and content type', async () => {
  const fields = signResponse({ status: 200, body, signer: citySigner, now: NOW });
  const headers = new Map(Object.entries(fields).map(([k, v]) => [k, v]));
  const message: ReceivedMessage = { status: 200, body, header: (name) => headers.get(name.toLowerCase()) ?? null };
  assert.equal((await verifySignedMessage(message, city, NOW, null)).ok, true);
  assert.deepEqual(await verifySignedMessage({ ...message, status: 451 }, city, NOW, null), { ok: false, code: 'federation.signature_invalid', reason: 'signature_mismatch' });
  const nationalSigner = { keyId: 'k2', sign: signerFor(RFC8032.test2) };
  const wrongKey = signResponse({ status: 200, body, signer: nationalSigner, now: NOW });
  const wrongHeaders = new Map(Object.entries(wrongKey));
  assert.deepEqual(await verifySignedMessage({ status: 200, body, header: (name) => wrongHeaders.get(name.toLowerCase()) ?? null }, city, NOW, null), { ok: false, code: 'federation.key_unknown', reason: 'key_unknown' });
});

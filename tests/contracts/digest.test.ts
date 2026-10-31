import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDigest, digestEquals, DigestSchema, verifyDigest, DIGEST_ALGORITHM } from '../../packages/contracts/src/common/digest.js';
import { VersionRefSchema, sameVersion } from '../../packages/contracts/src/common/version.js';

test('trustwork-digest-1 is lowercase hex sha-256 over canonical bytes', () => {
  const d = computeDigest({});
  assert.equal(d.algorithm, DIGEST_ALGORITHM);
  // sha256("{}")
  assert.equal(d.value, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.ok(DigestSchema.safeParse(d).success);
  assert.equal(computeDigest({ b: '1', a: '2' }).value, computeDigest({ a: '2', b: '1' }).value);
});
test('quantity 10 and 100 produce different digests; attachment hash change changes the digest', () => {
  const base = { lines: [{ quantity: { value: '10', unit: 'pcs' } }], attachments: [{ evidenceArtifactId: 'a', hash: 'h1' }] };
  const qty100 = { ...base, lines: [{ quantity: { value: '100', unit: 'pcs' } }] };
  const otherHash = { ...base, attachments: [{ evidenceArtifactId: 'a', hash: 'h2' }] };
  assert.notEqual(computeDigest(base).value, computeDigest(qty100).value);
  assert.notEqual(computeDigest(base).value, computeDigest(otherHash).value);
});
test('verifyDigest accepts the recorded digest and rejects tampering or malformed digests', () => {
  const input = { payload: { title: 'x' } };
  const recorded = computeDigest(input);
  assert.ok(verifyDigest(input, recorded));
  assert.equal(verifyDigest({ payload: { title: 'y' } }, recorded), false);
  assert.equal(verifyDigest(input, { ...recorded, value: recorded.value.toUpperCase() }), false);
  assert.equal(verifyDigest(input, { algorithm: 'sha256' as never, value: recorded.value }), false);
  assert.ok(digestEquals(recorded, { ...recorded }));
});
test('VersionRef pins by id; digest does not decide identity', () => {
  const d = computeDigest({ payload: 1 });
  const a = VersionRefSchema.parse({ id: 'rfq-v1', version: 1, digest: d });
  const b = { id: 'rfq-v3', version: 3, digest: d };
  assert.equal(sameVersion(a, b), false);
  assert.equal(sameVersion(a, { ...a, digest: computeDigest({ payload: 2 }) }), true);
  for (const bad of [
    { id: 'x', version: 0, digest: d },
    { id: 'x', version: 1.5, digest: d },
    { id: 'x', version: '1', digest: d },
    { id: '', version: 1, digest: d },
    { id: 'x', version: 1, digest: { algorithm: 'trustwork-digest-1', value: 'short' } },
  ]) {
    assert.equal(VersionRefSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

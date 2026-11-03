import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '../../packages/contracts/src/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../packages/contracts/fixtures/rfq-amendment.json', import.meta.url), 'utf8'));
const [v1] = fixture.records.RfqVersion.map((v: unknown) => c.RfqVersionSchema.parse(v)) as [c.RfqVersion];

/** ADR 027: the key is additive. Every digest recorded before it exists stays valid; a sealed payload binds the setting. */
test('a payload without sealedUntilDeadline digests exactly as before, and parsing adds no key', () => {
  assert.ok(c.verifyRfqVersionDigest(v1), 'the recorded fixture digest still verifies');
  assert.equal('sealedUntilDeadline' in c.RfqVersionPayloadSchema.parse(v1.payload), false);
});

test('the setting is part of the digest: sealing a payload changes it, and a changed setting no longer verifies', () => {
  const sealed = { ...v1.payload, sealedUntilDeadline: true };
  assert.equal(c.RfqVersionPayloadSchema.parse(sealed).sealedUntilDeadline, true);
  assert.equal(c.verifyRfqVersionDigest({ ...v1, payload: sealed }), false);
  assert.equal(c.RfqVersionPayloadSchema.safeParse({ ...v1.payload, sealedUntilDeadline: 'yes' }).success, false);
});

test('suppliers read the setting in the shared version', () => {
  const shared = c.toSharedRfqVersion({ ...v1, payload: { ...v1.payload, sealedUntilDeadline: true } });
  assert.equal(shared?.payload.sealedUntilDeadline, true);
});

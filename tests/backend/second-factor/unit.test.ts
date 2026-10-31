import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, timeStep, totp } from '../../../apps/api/src/modules/identity/second-factor/totp.js';
import {
  DEVELOPMENT_SECOND_FACTOR_KEY, deriveSecondFactorKeys, newRecoveryCode, openTotpSecret, recoveryCodeHash, SealedSecretError, sealTotpSecret, secondFactorKeyFromEnv,
} from '../../../apps/api/src/modules/identity/second-factor/secrets.js';
import { normalizeRecoveryCode, RECOVERY_CODE_ALPHABET } from '../../../packages/contracts/src/second-factor.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

test('HOTP matches the RFC 4226 appendix D test values', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((value, counter) => assert.equal(hotp(RFC_SECRET, counter), value));
});

test('TOTP matches the RFC 6238 appendix B SHA-1 test values (8 digits)', () => {
  const vectors: [number, string][] = [[59, '94287082'], [1_111_111_109, '07081804'], [1_111_111_111, '14050471'], [1_234_567_890, '89005924'], [2_000_000_000, '69279037'], [20_000_000_000, '65353130']];
  for (const [seconds, value] of vectors) assert.equal(totp(RFC_SECRET, seconds * 1000, { digits: 8 }), value, `T=${seconds}`);
  assert.equal(totp(RFC_SECRET, 59_000), '287082', 'six digits are the last six of the same value');
});

test('base32 round-trips (RFC 4648 vectors, no padding)', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Encode(Buffer.from('f')), 'MY');
  assert.deepEqual(base32Decode('MZXW6YTBOI'), Buffer.from('foobar'));
  const secret = randomBytes(20);
  const encoded = base32Encode(secret);
  assert.match(encoded, /^[A-Z2-7]{32}$/);
  assert.deepEqual(base32Decode(encoded.toLowerCase()), secret);
  assert.throws(() => base32Decode('M1'), /invalid base32/);
});

test('matchTotp: one step of tolerance, never a step at or before the last accepted one', () => {
  const secret = randomBytes(20);
  const now = 1_800_000_000_000;
  const step = timeStep(now);
  const options = { window: 1, periodSeconds: 30, digits: 6, lastUsedStep: null };
  assert.equal(matchTotp(secret, totp(secret, now), now, options), step);
  assert.equal(matchTotp(secret, totp(secret, now - 30_000), now, options), step - 1);
  assert.equal(matchTotp(secret, totp(secret, now + 30_000), now, options), step + 1);
  assert.equal(matchTotp(secret, totp(secret, now - 60_000), now, options), null, 'outside the window');
  assert.equal(matchTotp(secret, totp(secret, now), now, { ...options, lastUsedStep: step }), null, 'replay of the same step');
  assert.equal(matchTotp(secret, totp(secret, now - 30_000), now, { ...options, lastUsedStep: step }), null, 'an earlier code after a later one');
  assert.equal(matchTotp(secret, 'abcdef', now, options), null);
  assert.equal(matchTotp(secret, '12345', now, options), null);
});

test('otpauth URI follows the key URI format', () => {
  const uri = new URL(otpauthUri({ issuer: 'hub.example', account: 'a@b.example', secret: 'JBSWY3DPEHPK3PXP', digits: 6, periodSeconds: 30 }));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.host, 'totp');
  assert.equal(decodeURIComponent(uri.pathname), '/hub.example:a@b.example');
  assert.equal(uri.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(uri.searchParams.get('issuer'), 'hub.example');
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
});

test('sealed TOTP secrets open only for their own factor and person, under the same key', () => {
  const keys = deriveSecondFactorKeys(randomBytes(32));
  const secret = randomBytes(20);
  const sealed = sealTotpSecret(keys, 'factor-1', 'person-1', secret);
  assert.ok(!sealed.includes(secret));
  assert.deepEqual(openTotpSecret(keys, 'factor-1', 'person-1', sealed), secret);
  assert.throws(() => openTotpSecret(keys, 'factor-2', 'person-1', sealed), SealedSecretError);
  assert.throws(() => openTotpSecret(keys, 'factor-1', 'person-2', sealed), SealedSecretError);
  assert.throws(() => openTotpSecret(deriveSecondFactorKeys(randomBytes(32)), 'factor-1', 'person-1', sealed), SealedSecretError);
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => openTotpSecret(keys, 'factor-1', 'person-1', tampered), SealedSecretError);
  assert.notDeepEqual(sealTotpSecret(keys, 'factor-1', 'person-1', secret), sealed, 'a fresh nonce every time');
});

test('the second-factor key is required in production and never the development key there', () => {
  assert.throws(() => secondFactorKeyFromEnv({ NODE_ENV: 'production' }), /required in production/);
  assert.throws(() => secondFactorKeyFromEnv({ NODE_ENV: 'production', SECOND_FACTOR_SECRET_KEY: DEVELOPMENT_SECOND_FACTOR_KEY.toString('hex') }), /development key/);
  assert.throws(() => secondFactorKeyFromEnv({ SECOND_FACTOR_SECRET_KEY: 'abcd' }), /at least 32 bytes/);
  assert.deepEqual(secondFactorKeyFromEnv({}), DEVELOPMENT_SECOND_FACTOR_KEY);
  const key = randomBytes(32);
  assert.deepEqual(secondFactorKeyFromEnv({ NODE_ENV: 'production', SECOND_FACTOR_SECRET_KEY: key.toString('hex') }), key);
});

test('recovery codes: 80 bits from the unambiguous alphabet, keyed hashes bound to the person', () => {
  const codes = Array.from({ length: 200 }, () => newRecoveryCode());
  assert.equal(new Set(codes.map((c) => c.normalized)).size, 200);
  for (const code of codes) {
    assert.match(code.display, /^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){3}$/);
    assert.equal(normalizeRecoveryCode(code.display.toUpperCase()), code.normalized);
    assert.equal(normalizeRecoveryCode(code.display.replaceAll('-', ' ')), code.normalized);
  }
  assert.equal(RECOVERY_CODE_ALPHABET.length, 32);
  assert.equal(normalizeRecoveryCode('abcd-efgh-ijkm-npq'), null, 'too short');
  assert.equal(normalizeRecoveryCode('abcd-efgh-ijkm-npql'), null, 'l is not in the alphabet');
  const keys = deriveSecondFactorKeys(randomBytes(32));
  const a = recoveryCodeHash(keys, 'person-1', codes[0]!.normalized);
  assert.equal(a.length, 32);
  assert.notDeepEqual(recoveryCodeHash(keys, 'person-2', codes[0]!.normalized), a);
  assert.notDeepEqual(recoveryCodeHash(deriveSecondFactorKeys(randomBytes(32)), 'person-1', codes[0]!.normalized), a);
});

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { RECOVERY_CODE_ALPHABET, RECOVERY_CODE_SYMBOLS, formatRecoveryCode } from './deps.js';

/**
 * Key custody for second factors. `SECOND_FACTOR_SECRET_KEY` (hex, at least 32 bytes) is held by the API only (not
 * the worker, not the database); two subkeys are derived from it with HKDF: one seals TOTP secrets (AES-256-GCM, the
 * additional data binds the ciphertext to its factor and person, so a sealed secret copied to another row does not
 * open), the other keys the recovery-code hashes (HMAC-SHA256, so a database copy alone cannot be brute-forced).
 * Production refuses to start without the key; development and tests use a fixed, public development key.
 */
export const DEVELOPMENT_SECOND_FACTOR_KEY = createHash('sha256').update('trustwork-development-second-factor-key-not-for-production', 'utf8').digest();
const SEAL_VERSION = 1;

export function secondFactorKeyFromEnv(env: { NODE_ENV?: string | undefined; SECOND_FACTOR_SECRET_KEY?: string | undefined }): Buffer {
  const production = env.NODE_ENV === 'production';
  const raw = env.SECOND_FACTOR_SECRET_KEY?.trim();
  if (!raw) {
    if (production) throw new Error('SECOND_FACTOR_SECRET_KEY is required in production (hex, at least 32 bytes, API only)');
    return DEVELOPMENT_SECOND_FACTOR_KEY;
  }
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw)) throw new Error('SECOND_FACTOR_SECRET_KEY must be hex of at least 32 bytes');
  const key = Buffer.from(raw, 'hex');
  if (production && key.equals(DEVELOPMENT_SECOND_FACTOR_KEY)) throw new Error('SECOND_FACTOR_SECRET_KEY must not be the development key in production');
  return key;
}

export interface SecondFactorKeys { seal: Buffer; recovery: Buffer }
export function deriveSecondFactorKeys(configured: Buffer): SecondFactorKeys {
  if (configured.length < 32) throw new RangeError('second factor key must be at least 32 bytes');
  return {
    seal: Buffer.from(hkdfSync('sha256', configured, Buffer.alloc(0), 'trustwork totp secret v1', 32)),
    recovery: Buffer.from(hkdfSync('sha256', configured, Buffer.alloc(0), 'trustwork recovery code v1', 32)),
  };
}

function aad(factorId: string, personId: string): Buffer {
  return Buffer.from(`trustwork-totp-v1:${factorId}:${personId}`, 'utf8');
}
export function sealTotpSecret(keys: SecondFactorKeys, factorId: string, personId: string, secret: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.seal, nonce);
  cipher.setAAD(aad(factorId, personId));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, cipher.getAuthTag(), body]);
}
export class SealedSecretError extends Error {
  constructor() {
    super('sealed second-factor secret cannot be opened');
    this.name = 'SealedSecretError';
  }
}
export function openTotpSecret(keys: SecondFactorKeys, factorId: string, personId: string, sealed: Buffer): Buffer {
  if (sealed.length < 1 + 12 + 16 + 1 || sealed[0] !== SEAL_VERSION) throw new SealedSecretError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.seal, sealed.subarray(1, 13));
    decipher.setAAD(aad(factorId, personId));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  } catch {
    throw new SealedSecretError();
  }
}

/** Keyed hash of a normalized recovery code, bound to its person. */
export function recoveryCodeHash(keys: SecondFactorKeys, personId: string, normalized: string): Buffer {
  return createHmac('sha256', keys.recovery).update(`trustwork-recovery-v1:${personId}:${normalized}`, 'utf8').digest();
}

/** A fresh recovery code: 16 symbols from the 32-symbol alphabet (80 bits), unbiased, in display form. */
export function newRecoveryCode(): { display: string; normalized: string } {
  let normalized = '';
  for (let i = 0; i < RECOVERY_CODE_SYMBOLS; i++) normalized += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  return { display: formatRecoveryCode(normalized), normalized };
}

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { inspect } from 'node:util';

/**
 * Secret store port of KEYS-001 (docs/engine/hub-console/providers-and-models.md, section "Secret storage").
 *
 * Envelope encryption: every secret value is sealed with a fresh 256-bit data key (AES-256-GCM); the data key is
 * wrapped by the node's key-encryption key (KEK). The database stores only the ciphertext, the wrapped data key and
 * the KEK identifier; the KEK lives in the environment (`TRUSTWORK_KEK`, or a mounted file `TRUSTWORK_KEK_FILE`) or in
 * an external KMS or Vault behind `KmsClient`. Plaintext exists only in the memory of the process that seals it or
 * calls an adapter, and only inside a `SecretValue`, which renders as "[secret]" in logs, JSON and inspection.
 *
 * Fingerprints are an HMAC of the value under a key derived from the KEK (HKDF), truncated to 12 hex characters: staff
 * see that a rotation happened without learning anything that helps guess the value.
 */

/** A secret value in memory. It never serializes: `String()`, `JSON.stringify` and `util.inspect` all print "[secret]". */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** The plaintext, for an adapter call only. Never log, store or return it. */
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[secret]';
  }
  toJSON(): string {
    return '[secret]';
  }
  [inspect.custom](): string {
    return '[secret]';
  }
}

/** Wraps and unwraps data keys with the node's key-encryption key. */
export interface KeyEncryptionPort {
  readonly kekId: string;
  /** `context` binds the wrapped key to its owner (connection and version); unwrapping with another context fails. */
  wrap(dataKey: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, kekId: string, context: string): Promise<Buffer>;
}

/** An external KMS or Vault transit key (adapter interface; no real client ships with the engine). */
export interface KmsClient {
  readonly keyId: string;
  /** `context` is the encryption context (additional authenticated data) the KMS binds to the ciphertext. */
  encrypt(plaintext: Buffer, context: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer, context: string): Promise<Buffer>;
}

const GCM_IV = 12;
const GCM_TAG = 16;
function gcmSeal(key: Buffer, plaintext: Buffer, aad: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(GCM_IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}
function gcmOpen(key: Buffer, sealed: { iv: Buffer; tag: Buffer; ciphertext: Buffer }, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/** The KEK from the environment (minimum production setup; a KMS or Vault is the recommended one). */
export class LocalKeyEncryption implements KeyEncryptionPort {
  readonly kekId: string;
  readonly #kek: Buffer;
  constructor(kek: Buffer) {
    if (kek.length !== 32) throw new Error('the key-encryption key is 32 bytes');
    this.#kek = Buffer.from(kek);
    this.kekId = `local:${createHash('sha256').update('trustwork-kek-id').update(kek).digest('hex').slice(0, 16)}`;
  }
  async wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    const { iv, tag, ciphertext } = gcmSeal(this.#kek, dataKey, `${this.kekId}|${context}`);
    return Buffer.concat([iv, tag, ciphertext]);
  }
  async unwrap(wrapped: Buffer, kekId: string, context: string): Promise<Buffer> {
    if (kekId !== this.kekId) throw new SecretStoreError('kek_mismatch');
    return gcmOpen(this.#kek, { iv: wrapped.subarray(0, GCM_IV), tag: wrapped.subarray(GCM_IV, GCM_IV + GCM_TAG), ciphertext: wrapped.subarray(GCM_IV + GCM_TAG) }, `${kekId}|${context}`);
  }
  /** The fingerprint key, derived so that it is never the KEK itself. */
  fingerprintKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', this.#kek, Buffer.alloc(0), Buffer.from('trustwork-secret-fingerprint', 'utf8'), 32));
  }
}

/** Data keys wrapped by an external KMS or Vault transit key. */
export class KmsKeyEncryption implements KeyEncryptionPort {
  readonly kekId: string;
  constructor(private readonly client: KmsClient) {
    this.kekId = `kms:${client.keyId}`;
  }
  wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    return this.client.encrypt(dataKey, context);
  }
  async unwrap(wrapped: Buffer, kekId: string, context: string): Promise<Buffer> {
    if (kekId !== this.kekId) throw new SecretStoreError('kek_mismatch');
    return this.client.decrypt(wrapped, context);
  }
}

/** Deterministic in-process stand-in for a KMS (tests and demos): no network, no account. */
export class FakeKms implements KmsClient {
  readonly calls: ('encrypt' | 'decrypt')[] = [];
  readonly #key = randomBytes(32);
  constructor(readonly keyId = 'fake-kms-key') {}
  async encrypt(plaintext: Buffer, context: string): Promise<Buffer> {
    this.calls.push('encrypt');
    const { iv, tag, ciphertext } = gcmSeal(this.#key, plaintext, `${this.keyId}|${context}`);
    return Buffer.concat([iv, tag, ciphertext]);
  }
  async decrypt(ciphertext: Buffer, context: string): Promise<Buffer> {
    this.calls.push('decrypt');
    return gcmOpen(this.#key, { iv: ciphertext.subarray(0, GCM_IV), tag: ciphertext.subarray(GCM_IV, GCM_IV + GCM_TAG), ciphertext: ciphertext.subarray(GCM_IV + GCM_TAG) }, `${this.keyId}|${context}`);
  }
}

export type SecretStoreErrorCode = 'unconfigured' | 'kek_mismatch' | 'store_unavailable' | 'ref_invalid' | 'unreadable';
/** A refusal of the secret store; its message never contains a value. */
export class SecretStoreError extends Error {
  constructor(readonly code: SecretStoreErrorCode) {
    super(`secret store: ${code}`);
    this.name = 'SecretStoreError';
  }
}

export interface SealedSecret { fingerprint: string; ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedKey: Buffer; kekId: string; version: number }
/** The owner a sealed secret is bound to: its connection and its version (slot). */
export interface SecretBinding { connectionId: string; version: number }
const AAD = 'trustwork-provider-secret-v1';
/**
 * The additional authenticated data of both the ciphertext and the wrapped data key: a sealed row copied to another
 * connection or another version fails to open, so database write access alone cannot send a key to another endpoint.
 */
export function bindingContext(b: SecretBinding): string {
  if (!/^[0-9a-f-]{36}$/i.test(b.connectionId) || !Number.isInteger(b.version) || b.version < 1) throw new SecretStoreError('ref_invalid');
  return `connection:${b.connectionId.toLowerCase()}:v${b.version}`;
}

/** Seals and opens provider secrets (envelope encryption) and computes keyed fingerprints. */
export class SecretSealer {
  readonly #fingerprintKey: Buffer;
  constructor(private readonly kek: KeyEncryptionPort, fingerprintKey: Buffer) {
    if (fingerprintKey.length < 32) throw new Error('the fingerprint key is at least 32 bytes');
    this.#fingerprintKey = Buffer.from(fingerprintKey);
  }
  fingerprint(value: SecretValue): string {
    return createHmac('sha256', this.#fingerprintKey).update(value.reveal(), 'utf8').digest('hex').slice(0, 12);
  }
  async seal(value: SecretValue, binding: SecretBinding): Promise<SealedSecret> {
    const context = bindingContext(binding);
    const dataKey = randomBytes(32);
    try {
      const { iv, tag, ciphertext } = gcmSeal(dataKey, Buffer.from(value.reveal(), 'utf8'), `${AAD}|${context}`);
      return { fingerprint: this.fingerprint(value), ciphertext, iv, authTag: tag, wrappedKey: await this.kek.wrap(dataKey, context), kekId: this.kek.kekId, version: binding.version };
    } finally {
      dataKey.fill(0);
    }
  }
  /** Opens a sealed secret for exactly the owner it was sealed for; anything else (moved, swapped, tampered) is `unreadable`. */
  async open(sealed: { ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedKey: Buffer; kekId: string }, binding: SecretBinding): Promise<SecretValue> {
    const context = bindingContext(binding);
    let dataKey: Buffer;
    try {
      dataKey = await this.kek.unwrap(sealed.wrappedKey, sealed.kekId, context);
    } catch (error) {
      throw error instanceof SecretStoreError && error.code === 'kek_mismatch' ? error : new SecretStoreError('unreadable');
    }
    try {
      return new SecretValue(gcmOpen(dataKey, { iv: sealed.iv, tag: sealed.authTag, ciphertext: sealed.ciphertext }, `${AAD}|${context}`).toString('utf8'));
    } catch {
      throw new SecretStoreError('unreadable');
    } finally {
      dataKey.fill(0);
    }
  }
}

const PLACEHOLDER = /change[_-]?me|placeholder|example|^0+$|^(.)\1+$/i;
/** Parses a 32-byte key given as 64 hex characters or base64; placeholders are refused (setup wizard check). */
export function parseKek(value: string | undefined): Buffer | null {
  const v = value?.trim() ?? '';
  if (!v || PLACEHOLDER.test(v)) return null;
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : /^[A-Za-z0-9+/]{43}=?$/.test(v) ? Buffer.from(v, 'base64') : null;
  if (!key || key.length !== 32 || key.every((b) => b === key[0])) return null;
  return key;
}

/**
 * The sealer from the environment: `TRUSTWORK_KEK` (or `TRUSTWORK_KEK_FILE`, a mounted file holding it). Null when no
 * usable KEK is configured; secret writes then refuse with `secret_store_unconfigured` and nothing is stored.
 */
export function secretSealerFromEnv(env: NodeJS.ProcessEnv): SecretSealer | null {
  let raw = env.TRUSTWORK_KEK;
  if (!raw && env.TRUSTWORK_KEK_FILE) {
    try {
      raw = readFileSync(env.TRUSTWORK_KEK_FILE, 'utf8');
    } catch {
      return null;
    }
  }
  const kek = parseKek(raw);
  if (!kek) return null;
  const local = new LocalKeyEncryption(kek);
  kek.fill(0);
  return new SecretSealer(local, local.fingerprintKey());
}

/** A KMS-backed sealer; the fingerprint key comes from the environment (`TRUSTWORK_SECRET_FINGERPRINT_KEY`). */
export function kmsSecretSealer(client: KmsClient, fingerprintKey: Buffer): SecretSealer {
  return new SecretSealer(new KmsKeyEncryption(client), fingerprintKey);
}

/**
 * Secrets that live outside the database, named by a HUB-001 credential reference (`provider_credential_ref`):
 * `env` reads an environment variable, `file` a file under `TRUSTWORK_SECRET_DIR`, and `external_kms` /
 * `external_vault` go through a `VaultClient` adapter (none ships with the engine; `FakeVault` for tests).
 */
export interface VaultClient { read(ref: string): Promise<SecretValue> }
export class FakeVault implements VaultClient {
  constructor(private readonly values: Readonly<Record<string, string>> = {}) {}
  async read(ref: string): Promise<SecretValue> {
    const value = this.values[ref];
    if (value === undefined) throw new SecretStoreError('store_unavailable');
    return new SecretValue(value);
  }
}
export class ExternalSecretReader {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly vault: VaultClient | null = null) {}
  async read(store: string, ref: string): Promise<SecretValue> {
    if (store === 'env') {
      if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(ref)) throw new SecretStoreError('ref_invalid');
      const value = this.env[ref];
      if (!value) throw new SecretStoreError('store_unavailable');
      return new SecretValue(value.trim());
    }
    if (store === 'file') {
      const dir = this.env.TRUSTWORK_SECRET_DIR;
      if (!dir || isAbsolute(ref) || normalize(ref).split(sep).includes('..')) throw new SecretStoreError('ref_invalid');
      try {
        return new SecretValue(readFileSync(resolve(dir, ref), 'utf8').trim());
      } catch {
        throw new SecretStoreError('store_unavailable');
      }
    }
    if ((store === 'external_kms' || store === 'external_vault') && this.vault) return this.vault.read(ref);
    throw new SecretStoreError('store_unavailable');
  }
}

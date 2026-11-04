import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { inspect } from 'node:util';
import { FakeKms, KmsKeyEncryption, LocalKeyEncryption, parseKek, type KeyEncryptionPort, type KmsClient } from '../../providers/secret-store.js';
import { fromBase64Url, toBase64Url, type Ed25519Sign, type Ed25519Verify, type SealedSeed } from './deps.js';

/**
 * The node's Ed25519 crypto adapter (FED-001). The contracts build the exact bytes to sign or verify; this file holds
 * the only code that touches a private seed:
 *
 * - `generateNodeKey` makes a fresh key pair and returns the public key with the seed wrapped in a `NodeSeed`, which
 *   never serializes (`String()`, `JSON.stringify` and `util.inspect` print "[node seed]");
 * - `NodeKeySealer` seals a seed for the database with a fresh AES-256-GCM data key wrapped by the node's key-encryption
 *   key (KEYS-001 envelope encryption, same KEK, own additional authenticated data), and opens sealed material only into
 *   memory for a signature;
 * - `verifyEd25519` is the verifier port every protocol check uses.
 *
 * No private key is ever stored in plain text, logged or returned by an endpoint; tests use generated keys and the
 * published RFC 8032 test vectors, never a node's key.
 */

/** PKCS#8 header of an Ed25519 private key (RFC 8410): the seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A 32-byte Ed25519 seed in memory; it never serializes. */
export class NodeSeed {
  readonly #seed: Buffer;
  constructor(seed: Buffer) {
    if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
    this.#seed = Buffer.from(seed);
  }
  /** The raw public key (32 bytes) derived from the seed. */
  publicKey(): Uint8Array {
    const jwk = createPublicKey(this.privateKey()).export({ format: 'jwk' }) as { x: string };
    return fromBase64Url(jwk.x) as Uint8Array;
  }
  /** The signer port over this seed. */
  signer(): Ed25519Sign {
    const key = this.privateKey();
    return (message) => new Uint8Array(cryptoSign(null, message, key));
  }
  /** For sealing only: the bytes, copied; the caller zeroes its copy. */
  bytes(): Buffer {
    return Buffer.from(this.#seed);
  }
  /** Forgets the seed. */
  destroy(): void {
    this.#seed.fill(0);
  }
  private privateKey() {
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, this.#seed]), format: 'der', type: 'pkcs8' });
  }
  toString(): string {
    return '[node seed]';
  }
  toJSON(): string {
    return '[node seed]';
  }
  [inspect.custom](): string {
    return '[node seed]';
  }
}

/** A fresh Ed25519 key pair: the base64url public key and the seed in memory. */
export function generateNodeKey(): { publicKey: string; seed: NodeSeed } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const seed = new NodeSeed(Buffer.from(fromBase64Url(jwk.d) as Uint8Array));
  return { publicKey: jwk.x, seed };
}

export const verifyEd25519: Ed25519Verify = (publicKey, message, signature) => {
  try {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(publicKey) }, format: 'jwk' });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
};

export const sha256 = (bytes: Uint8Array | string): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());

const AAD = 'trustwork-node-key-v1';
const GCM_IV = 12;
export type NodeKeySealerErrorCode = 'unconfigured' | 'kek_mismatch' | 'unreadable';
export class NodeKeySealerError extends Error {
  constructor(readonly code: NodeKeySealerErrorCode) {
    super(`node key sealer: ${code}`);
    this.name = 'NodeKeySealerError';
  }
}
/** The additional authenticated data binds a sealed seed to its node and key label: a row copied elsewhere does not open. */
function context(nodeId: string, keyId: string): string {
  return `node:${nodeId.toLowerCase()}:key:${keyId}`;
}

/** Seals and opens node seeds with the node's key-encryption key. */
export class NodeKeySealer {
  constructor(private readonly kek: KeyEncryptionPort) {}
  get kekId(): string {
    return this.kek.kekId;
  }
  async seal(seed: NodeSeed, nodeId: string, keyId: string): Promise<SealedSeed> {
    const dataKey = randomBytes(32);
    const plaintext = seed.bytes();
    try {
      const iv = randomBytes(GCM_IV);
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
      cipher.setAAD(Buffer.from(`${AAD}|${context(nodeId, keyId)}`, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { ciphertext, iv, authTag: cipher.getAuthTag(), wrappedKey: await this.kek.wrap(dataKey, context(nodeId, keyId)), kekId: this.kek.kekId };
    } finally {
      dataKey.fill(0);
      plaintext.fill(0);
    }
  }
  /** Opens sealed material for exactly the node and key it was sealed for. */
  async open(sealed: { ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedKey: Buffer; kekId: string }, nodeId: string, keyId: string): Promise<NodeSeed> {
    let dataKey: Buffer;
    try {
      dataKey = await this.kek.unwrap(sealed.wrappedKey, sealed.kekId, context(nodeId, keyId));
    } catch (error) {
      throw (error as { code?: string }).code === 'kek_mismatch' ? new NodeKeySealerError('kek_mismatch') : new NodeKeySealerError('unreadable');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.iv);
      decipher.setAAD(Buffer.from(`${AAD}|${context(nodeId, keyId)}`, 'utf8'));
      decipher.setAuthTag(sealed.authTag);
      const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
      const seed = new NodeSeed(plaintext);
      plaintext.fill(0);
      return seed;
    } catch {
      throw new NodeKeySealerError('unreadable');
    } finally {
      dataKey.fill(0);
    }
  }
}

/** The sealer from the environment (`TRUSTWORK_KEK` or `TRUSTWORK_KEK_FILE`), or null when no usable KEK is configured. */
export function nodeKeySealerFromEnv(env: NodeJS.ProcessEnv, readFile: (path: string) => string): NodeKeySealer | null {
  let raw = env.TRUSTWORK_KEK;
  if (!raw && env.TRUSTWORK_KEK_FILE) {
    try {
      raw = readFile(env.TRUSTWORK_KEK_FILE);
    } catch {
      return null;
    }
  }
  const kek = parseKek(raw);
  if (!kek) return null;
  const local = new LocalKeyEncryption(kek);
  kek.fill(0);
  return new NodeKeySealer(local);
}
/** A sealer over an external KMS (adapter interface; no real client ships with the engine). */
export function kmsNodeKeySealer(client: KmsClient): NodeKeySealer {
  return new NodeKeySealer(new KmsKeyEncryption(client));
}
/** Tests and demos: a sealer over the deterministic in-process KMS stand-in (no network, no account). */
export function fakeNodeKeySealer(): NodeKeySealer {
  return new NodeKeySealer(new KmsKeyEncryption(new FakeKms('fake-node-kek')));
}

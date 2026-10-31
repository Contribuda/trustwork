import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Envelope format of every object the backup tooling writes to a target (OPS-003): base backup parts, WAL segments,
 * logical dumps, object copies, partition archives and manifests. Nothing reaches a target unencrypted.
 *
 *   "TWB1" | key id length (1 byte) | key id (ASCII) | nonce (12 bytes) | AES-256-GCM ciphertext | tag (16 bytes)
 *
 * The plaintext is gzip-compressed before encryption (WAL segments are mostly zero padding). The additional
 * authenticated data binds each object to its key in the target, so a part cannot be swapped for another part or
 * replayed under another name without failing authentication. The data key is derived from the operator's backup key
 * with HKDF, so the configured secret itself never touches a cipher directly.
 */
export const ENVELOPE_MAGIC = Buffer.from('TWB1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Upper bound of one decrypted object (parts are far smaller; bounds a corrupted or hostile stream). */
export const MAX_PLAINTEXT_BYTES = 1024 * 1024 * 1024;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface BackupKey {
  /** Recorded in every envelope and manifest; lets an operator rotate keys and still read older backups. */
  id: string;
  /** Derived AES-256 data key (never the configured secret). */
  dataKey: Buffer;
}

export class BackupCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

/** Derives the data key from 32 or more bytes of operator secret. */
export function deriveBackupKey(id: string, secret: Buffer): BackupKey {
  if (!KEY_ID.test(id)) throw new BackupCryptoError('backup key id must be 1-64 characters of [A-Za-z0-9._-]');
  if (secret.length < 32) throw new BackupCryptoError('backup key must hold at least 32 bytes');
  const dataKey = Buffer.from(hkdfSync('sha256', secret, Buffer.from('trustwork-backup-v1', 'ascii'), Buffer.from(id, 'ascii'), 32));
  return { id, dataKey };
}

export interface BackupKeyEnv {
  BACKUP_ENCRYPTION_KEY?: string | undefined;
  BACKUP_KEY_ID?: string | undefined;
}

/**
 * The key from the environment: BACKUP_ENCRYPTION_KEY is 64 hex characters or base64 of at least 32 bytes, supplied by
 * the operator's secret store (never committed, never logged). BACKUP_KEY_ID names it (default `primary`). Additional
 * read-only keys for older backups use BACKUP_ENCRYPTION_KEY_<ID> (see keyringFromEnv).
 */
export function backupKeyFromEnv(env: BackupKeyEnv): BackupKey {
  const raw = env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) throw new BackupCryptoError('BACKUP_ENCRYPTION_KEY is required (64 hex characters or base64 of 32+ bytes)');
  return deriveBackupKey(env.BACKUP_KEY_ID?.trim() || 'primary', decodeSecret(raw));
}

/** Every key the environment offers for reading: the current one plus BACKUP_ENCRYPTION_KEY_<ID> entries. */
export function keyringFromEnv(env: Record<string, string | undefined>): Keyring {
  const ring = new Keyring(backupKeyFromEnv(env));
  for (const [name, value] of Object.entries(env)) {
    const match = /^BACKUP_ENCRYPTION_KEY_([A-Za-z0-9._-]{1,64})$/.exec(name);
    if (match && value?.trim()) ring.add(deriveBackupKey(match[1] as string, decodeSecret(value.trim())));
  }
  return ring;
}

function decodeSecret(raw: string): Buffer {
  const bytes = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (bytes.length < 32) throw new BackupCryptoError('backup key must hold at least 32 bytes');
  return bytes;
}

/** Generates a fresh random secret (hex) for drills and tests; production keys come from the operator. */
export function generateBackupSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Writes with the current key, reads with any key it holds. */
export class Keyring {
  private readonly keys = new Map<string, BackupKey>();
  constructor(readonly current: BackupKey) {
    this.keys.set(current.id, current);
  }
  add(key: BackupKey): this {
    if (!this.keys.has(key.id)) this.keys.set(key.id, key);
    return this;
  }
  get(id: string): BackupKey | undefined {
    return this.keys.get(id);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Compresses and encrypts `plaintext` bound to `aad` (the object key in the target). */
export function seal(key: BackupKey, plaintext: Uint8Array, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.dataKey, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(gzipSync(plaintext, { level: 6 })), cipher.final()]);
  const id = Buffer.from(key.id, 'ascii');
  return Buffer.concat([ENVELOPE_MAGIC, Buffer.from([id.length]), id, nonce, body, cipher.getAuthTag()]);
}

/** The key id an envelope was written with (no decryption). */
export function envelopeKeyId(sealed: Uint8Array): string {
  const buf = Buffer.from(sealed);
  if (buf.length < ENVELOPE_MAGIC.length + 1 || !buf.subarray(0, 4).equals(ENVELOPE_MAGIC)) throw new BackupCryptoError('not a backup envelope');
  const idLength = buf[4] as number;
  return buf.subarray(5, 5 + idLength).toString('ascii');
}

/** Authenticates, decrypts and decompresses; any tampering, a wrong key or a wrong `aad` throws. */
export function open(ring: Keyring | BackupKey, sealed: Uint8Array, aad: string): Buffer {
  const buf = Buffer.from(sealed);
  const keyId = envelopeKeyId(buf);
  const key = ring instanceof Keyring ? ring.get(keyId) : ring.id === keyId ? ring : undefined;
  if (!key) throw new BackupCryptoError(`no backup key with id ${keyId}`);
  const start = 5 + Buffer.byteLength(keyId, 'ascii');
  if (buf.length < start + NONCE_BYTES + TAG_BYTES) throw new BackupCryptoError('truncated backup envelope');
  const nonce = buf.subarray(start, start + NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key.dataKey, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  let compressed: Buffer;
  try {
    compressed = Buffer.concat([decipher.update(buf.subarray(start + NONCE_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new BackupCryptoError('backup envelope failed authentication (wrong key, wrong object or tampered)');
  }
  return gunzipSync(compressed, { maxOutputLength: MAX_PLAINTEXT_BYTES });
}

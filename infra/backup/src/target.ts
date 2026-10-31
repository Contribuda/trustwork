import { FilesystemBlobStore } from '../../../packages/data/src/files/filesystem.js';
import { S3BlobStore } from '../../../packages/data/src/files/s3.js';
import type { BlobStore } from '../../../packages/data/src/files/blob-store.js';
import { open, seal, sha256Hex, type BackupKey, type Keyring } from './crypto.js';

/**
 * Backup target port (OPS-003): where encrypted backup objects go. It is the object-storage port of FILE-001 reduced
 * to the calls backups need, so the same two adapters serve: `S3BackupTarget` for any S3-compatible service the
 * operator provisions (off-host: another provider, region or account than the database) and `FilesystemBackupTarget`,
 * the local fake for drills and tests. No adapter creates a provider account or a bucket; the operator supplies the
 * bucket and credentials through the environment. Every object is sealed (crypto.ts) before it reaches the target.
 */
export type BackupTargetStore = Pick<BlobStore, 'head' | 'read' | 'put' | 'delete' | 'list'>;

export interface BackupTarget {
  readonly kind: 'filesystem' | 's3';
  /** True when the target is outside the database host (recorded in every BackupRecord). */
  readonly offHost: boolean;
  readonly store: BackupTargetStore;
}

/** Largest single object the tooling reads back (parts are smaller; see PART_BYTES in backup.ts). */
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

export interface BackupTargetEnv {
  NODE_ENV?: string | undefined;
  BACKUP_TARGET?: string | undefined;
  BACKUP_FS_ROOT?: string | undefined;
  BACKUP_S3_ENDPOINT?: string | undefined;
  BACKUP_S3_BUCKET?: string | undefined;
  BACKUP_S3_REGION?: string | undefined;
  BACKUP_S3_ACCESS_KEY_ID?: string | undefined;
  BACKUP_S3_SECRET_ACCESS_KEY?: string | undefined;
  BACKUP_S3_VIRTUAL_HOSTED?: string | undefined;
}

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupConfigError';
  }
}

/**
 * | Variable | Meaning |
 * |---|---|
 * | `BACKUP_TARGET` | `filesystem` (the local fake; refused with `NODE_ENV=production`) or `s3` |
 * | `BACKUP_FS_ROOT` | Directory of the filesystem target |
 * | `BACKUP_S3_ENDPOINT` / `BACKUP_S3_BUCKET` / `BACKUP_S3_REGION` | The operator's off-host bucket |
 * | `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | Credentials from the operator's secret store (write-only keys recommended) |
 * | `BACKUP_S3_VIRTUAL_HOSTED` | `1` for `<bucket>.<host>` addressing |
 */
export function backupTargetFromEnv(env: BackupTargetEnv): BackupTarget {
  const mode = (env.BACKUP_TARGET ?? '').trim();
  if (mode === 'filesystem') {
    if (env.NODE_ENV === 'production') throw new BackupConfigError('BACKUP_TARGET=filesystem is the local fake and is refused with NODE_ENV=production');
    if (!env.BACKUP_FS_ROOT) throw new BackupConfigError('BACKUP_TARGET=filesystem needs BACKUP_FS_ROOT');
    return filesystemTarget(env.BACKUP_FS_ROOT);
  }
  if (mode === 's3') {
    const required = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((name) => !env[name]);
    if (missing.length) throw new BackupConfigError(`BACKUP_TARGET=s3 needs ${missing.join(', ')}`);
    return {
      kind: 's3',
      offHost: true,
      store: new S3BlobStore({
        endpoint: env.BACKUP_S3_ENDPOINT as string,
        bucket: env.BACKUP_S3_BUCKET as string,
        region: env.BACKUP_S3_REGION ?? 'us-east-1',
        accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID as string,
        secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY as string,
        virtualHosted: env.BACKUP_S3_VIRTUAL_HOSTED === '1',
        timeoutMs: 120_000,
      }),
    };
  }
  throw new BackupConfigError(`BACKUP_TARGET must be filesystem or s3 (got ${mode || 'nothing'})`);
}

/** The local fake: a directory, recorded honestly as not off-host. */
export function filesystemTarget(root: string, bucket = 'trustwork-backups'): BackupTarget {
  return { kind: 'filesystem', offHost: false, store: new FilesystemBlobStore({ root, bucket }) };
}

/** Seals and stores one object; returns the digests recorded in manifests. */
export async function putSealed(target: BackupTarget, key: BackupKey, objectKey: string, plaintext: Uint8Array, contentType = 'application/octet-stream'): Promise<{ bytes: number; sha256: string; sealedBytes: number; sealedSha256: string }> {
  const sealed = seal(key, plaintext, objectKey);
  await target.store.put(objectKey, sealed, contentType);
  const head = await target.store.head(objectKey);
  if (!head || head.bytes !== sealed.length) throw new BackupConfigError(`backup target did not keep ${objectKey} (size check failed)`);
  return { bytes: plaintext.length, sha256: sha256Hex(plaintext), sealedBytes: sealed.length, sealedSha256: sha256Hex(sealed) };
}

/** Reads and opens one object; null when missing. Optionally checks the plaintext digest. */
export async function getSealed(target: BackupTarget, ring: Keyring | BackupKey, objectKey: string, expectedSha256?: string): Promise<Buffer | null> {
  const sealed = await target.store.read(objectKey, MAX_OBJECT_BYTES);
  if (!sealed) return null;
  const plaintext = open(ring, sealed, objectKey);
  if (expectedSha256 !== undefined && sha256Hex(plaintext) !== expectedSha256) throw new BackupConfigError(`digest mismatch for ${objectKey}`);
  return plaintext;
}

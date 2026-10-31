import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStoreError, type BlobStore } from './blob-store.js';
import { FilesystemBlobStore } from './filesystem.js';
import { S3BlobStore } from './s3.js';
import { TombstoneLedger } from './tombstones.js';

/**
 * Storage configuration shared by the API and the worker (FILE-001). Off unless configured:
 *
 * | Variable | Meaning |
 * |---|---|
 * | `FILES_STORAGE` | `disabled` (default), `filesystem` (the fake; refused with `NODE_ENV=production`) or `s3` |
 * | `FILES_FS_ROOT` | Directory of the filesystem fake (default `<tmp>/trustwork-files`) |
 * | `FILES_S3_ENDPOINT` | Origin the API and worker use, for example `http://storage:8333` |
 * | `FILES_S3_PUBLIC_ENDPOINT` | Origin browsers use for signed URLs (default: the endpoint) |
 * | `FILES_S3_BUCKET` / `FILES_TOMBSTONE_BUCKET` | Bucket of the files; bucket of the tombstone ledger (default: the files bucket, prefix `tombstones/`) |
 * | `FILES_S3_REGION` | Signing region (default `us-east-1`) |
 * | `FILES_S3_ACCESS_KEY_ID` / `FILES_S3_SECRET_ACCESS_KEY` | Credentials created by the operator (never by this code) |
 * | `FILES_S3_VIRTUAL_HOSTED` | `1` for `<bucket>.<host>` addressing instead of path style |
 */
export interface FilesStorageEnv {
  NODE_ENV?: string | undefined;
  FILES_STORAGE?: string | undefined;
  FILES_FS_ROOT?: string | undefined;
  FILES_S3_ENDPOINT?: string | undefined;
  FILES_S3_PUBLIC_ENDPOINT?: string | undefined;
  FILES_S3_BUCKET?: string | undefined;
  FILES_TOMBSTONE_BUCKET?: string | undefined;
  FILES_S3_REGION?: string | undefined;
  FILES_S3_ACCESS_KEY_ID?: string | undefined;
  FILES_S3_SECRET_ACCESS_KEY?: string | undefined;
  FILES_S3_VIRTUAL_HOSTED?: string | undefined;
}
export interface FilesStorageConfig { store: BlobStore; tombstones: TombstoneLedger }

/** The configured storage, or null when files are disabled. Throws on an incomplete or unsafe configuration. */
export function blobStoreFromEnv(env: FilesStorageEnv): FilesStorageConfig | null {
  const mode = (env.FILES_STORAGE ?? 'disabled').trim();
  if (mode === 'disabled' || mode === '') return null;
  if (mode === 'filesystem') {
    if (env.NODE_ENV === 'production') throw new BlobStoreError('FILES_STORAGE=filesystem is a test fake and is refused with NODE_ENV=production');
    const root = env.FILES_FS_ROOT ?? join(tmpdir(), 'trustwork-files');
    const store = new FilesystemBlobStore({ root });
    return { store, tombstones: new TombstoneLedger(new FilesystemBlobStore({ root, bucket: 'trustwork-tombstones' })) };
  }
  if (mode === 's3') {
    const required = ['FILES_S3_ENDPOINT', 'FILES_S3_BUCKET', 'FILES_S3_ACCESS_KEY_ID', 'FILES_S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((name) => !env[name]);
    if (missing.length > 0) throw new BlobStoreError(`FILES_STORAGE=s3 needs ${missing.join(', ')}`);
    const base = {
      endpoint: env.FILES_S3_ENDPOINT as string,
      ...(env.FILES_S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.FILES_S3_PUBLIC_ENDPOINT } : {}),
      region: env.FILES_S3_REGION ?? 'us-east-1',
      accessKeyId: env.FILES_S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY as string,
      virtualHosted: env.FILES_S3_VIRTUAL_HOSTED === '1',
    };
    const store = new S3BlobStore({ ...base, bucket: env.FILES_S3_BUCKET as string });
    const ledgerStore = env.FILES_TOMBSTONE_BUCKET ? new S3BlobStore({ ...base, bucket: env.FILES_TOMBSTONE_BUCKET }) : store;
    return { store, tombstones: new TombstoneLedger(ledgerStore) };
  }
  throw new BlobStoreError(`FILES_STORAGE must be disabled, filesystem or s3 (got ${mode})`);
}

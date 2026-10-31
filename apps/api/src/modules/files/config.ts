import { blobStoreFromEnv, boundedTtl, type BlobStore, type FilesStorageEnv } from './deps.js';
import type { FileMandatePort } from './mandates.js';

/**
 * Options of the files module (FILE-001). Without a blob store the module is not mounted and `/v1/files/*` is not found:
 * files are off unless the operator configures storage (`FILES_STORAGE`, see packages/data/src/files/config.ts).
 */
export interface FilesModuleOptions {
  store: BlobStore | null;
  /** Lifetime of a signed upload URL in seconds, bounded to SIGNED_URL_TTL.upload (default 300). */
  uploadTtlSeconds?: number;
  /** Lifetime of a signed download URL in seconds, bounded to SIGNED_URL_TTL.download (default 60). */
  downloadTtlSeconds?: number;
  mandates?: FileMandatePort;
}

export interface FilesEnv extends FilesStorageEnv {
  FILES_UPLOAD_URL_TTL_SECONDS?: string | undefined;
  FILES_DOWNLOAD_URL_TTL_SECONDS?: string | undefined;
}

const seconds = (value: string | undefined): number | undefined => (value && /^\d{1,6}$/.test(value) ? Number(value) : undefined);

export function filesOptionsFromEnv(env: FilesEnv): FilesModuleOptions {
  const storage = blobStoreFromEnv(env);
  const upload = seconds(env.FILES_UPLOAD_URL_TTL_SECONDS);
  const download = seconds(env.FILES_DOWNLOAD_URL_TTL_SECONDS);
  return {
    store: storage?.store ?? null,
    ...(upload !== undefined ? { uploadTtlSeconds: boundedTtl('upload', upload) } : {}),
    ...(download !== undefined ? { downloadTtlSeconds: boundedTtl('download', download) } : {}),
  };
}

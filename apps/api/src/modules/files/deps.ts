/**
 * Relative re-exports of the files slice (FILE-001). The module imports its contract, repository and storage files
 * directly so the shared package entries (`packages/contracts/src/client.ts`, `packages/data/src/index.ts`) stay
 * untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/files.js';
export { files, type FileRow } from '../../../../../packages/data/src/repositories/files.js';
export {
  blobStoreFromEnv, BlobStoreError, FilesystemBlobStore, S3BlobStore, TombstoneLedger,
  type BlobStore, type FilesStorageConfig, type FilesStorageEnv, type SignedBlobRequest,
} from '../../../../../packages/data/src/files/index.js';

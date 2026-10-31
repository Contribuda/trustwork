/**
 * Object storage port (FILE-001). The API signs short-lived requests with it; the worker reads, copies and deletes
 * through it. Two adapters: `S3BlobStore` (any S3-compatible service; the compose stack runs SeaweedFS) and
 * `FilesystemBlobStore` (the fake: local directory plus an HMAC-signed URL scheme it verifies itself, so tests can
 * exercise expiry and forgery without a provider). No adapter creates an account or a bucket in a provider; buckets are
 * provisioned by the operator (`ensureBucket` exists for the local stack and tests only).
 *
 * Keys come from the server (never from a client) and match STORAGE_KEY: the same rule as the kernel column.
 */
export const STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.=-]{0,511}$/;
export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY.test(key) || key.includes('..')) throw new BlobStoreError(`invalid storage key`);
}

export interface SignedBlobRequest {
  method: 'PUT' | 'GET';
  url: string;
  /** Headers the client must send unchanged (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}
export interface PresignPutInput { contentType: string; contentLength: number; expiresInSeconds: number; now: Date }
export interface PresignGetInput { expiresInSeconds: number; now: Date; contentType: string; disposition: 'inline' | 'attachment' }
export interface BlobHead { bytes: number; contentType: string | null }

export interface BlobStore {
  readonly kind: 's3' | 'filesystem';
  presignPut(key: string, input: PresignPutInput): SignedBlobRequest;
  presignGet(key: string, input: PresignGetInput): SignedBlobRequest;
  head(key: string, signal?: AbortSignal): Promise<BlobHead | null>;
  /** The whole object, refused with `BlobTooLargeError` above `maxBytes`; null when missing. */
  read(key: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Server-side copy; `BlobNotFoundError` when the source is missing. Copying identical bytes again is harmless. */
  copy(fromKey: string, toKey: string, signal?: AbortSignal): Promise<void>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string, signal?: AbortSignal): Promise<void>;
  /** Keys under a prefix, in lexical order. */
  list(prefix: string, signal?: AbortSignal): Promise<string[]>;
}

/** A definitive refusal (bad key, bad request, access denied): retrying does not help. */
export class BlobStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BlobStoreError';
  }
}
/** The store could not be reached or answered 5xx/429: no effect is known to have happened; safe to retry. */
export class BlobStoreUnavailableError extends BlobStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BlobStoreUnavailableError';
  }
}
export class BlobNotFoundError extends BlobStoreError {
  constructor(message = 'object not found') {
    super(message);
    this.name = 'BlobNotFoundError';
  }
}
export class BlobTooLargeError extends BlobStoreError {
  constructor(readonly limit: number) {
    super(`object exceeds ${limit} bytes`);
    this.name = 'BlobTooLargeError';
  }
}

/** `Content-Disposition` for a download: never a client-supplied file name (no header injection, no personal data). */
export function contentDisposition(disposition: 'inline' | 'attachment'): string {
  return disposition === 'inline' ? 'inline' : 'attachment; filename="file"';
}

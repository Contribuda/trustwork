import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertStorageKey, BlobNotFoundError, BlobStoreError, BlobTooLargeError, contentDisposition, type BlobHead, type BlobStore, type PresignGetInput, type PresignPutInput, type SignedBlobRequest } from './blob-store.js';

/**
 * The storage fake (FILE-001): objects are files under `root`; signed URLs use the `fake-storage:` scheme with an HMAC
 * over method, key, expiry and the signed headers. `acceptPut`/`acceptGet` play the provider's part: they refuse an
 * expired, forged or altered URL and a body whose length or type differs from what was signed. For tests and
 * development only; never a production adapter (the API refuses it with NODE_ENV=production).
 */
export interface FilesystemBlobStoreOptions {
  root: string;
  /** Bucket name shown in URLs (several fakes can share a root). */
  bucket?: string;
  /** HMAC key of the URL scheme; random per instance by default. */
  signingKey?: Buffer;
}

export class SignedUrlRejectedError extends BlobStoreError {
  constructor(readonly reason: 'expired' | 'signature' | 'method' | 'headers' | 'malformed') {
    super(`signed URL rejected: ${reason}`);
    this.name = 'SignedUrlRejectedError';
  }
}

export class FilesystemBlobStore implements BlobStore {
  readonly kind = 'filesystem' as const;
  readonly root: string;
  readonly bucket: string;
  private readonly key: Buffer;
  /** Every operation, for assertions in tests (key and verb only). */
  readonly operations: { op: string; key: string }[] = [];

  constructor(options: FilesystemBlobStoreOptions) {
    this.root = resolve(options.root);
    this.bucket = options.bucket ?? 'trustwork-files';
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket)) throw new BlobStoreError('invalid bucket name');
    this.key = options.signingKey ?? randomBytes(32);
  }

  private path(key: string): string {
    assertStorageKey(key);
    const full = resolve(this.root, this.bucket, ...key.split('/'));
    const rel = relative(resolve(this.root, this.bucket), full);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new BlobStoreError('invalid storage key');
    return full;
  }

  private sign(method: string, key: string, expires: number, headers: Record<string, string>): string {
    const canonical = [method, this.bucket, key, String(expires), ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`)].join('\n');
    return createHmac('sha256', this.key).update(canonical).digest('hex');
  }

  private presign(method: 'PUT' | 'GET', key: string, expiresInSeconds: number, now: Date, signed: Record<string, string>, extra: Record<string, string>): SignedBlobRequest {
    assertStorageKey(key);
    const expires = Math.floor(now.getTime() / 1000) + expiresInSeconds;
    const url = new URL(`fake-storage://${this.bucket}/${key}`);
    url.searchParams.set('method', method);
    url.searchParams.set('expires', String(expires));
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    url.searchParams.set('signature', this.sign(method, key, expires, { ...signed, ...extra }));
    return { method, url: url.toString(), headers: signed, expiresAt: new Date(expires * 1000) };
  }

  presignPut(key: string, input: PresignPutInput): SignedBlobRequest {
    return this.presign('PUT', key, input.expiresInSeconds, input.now, { 'content-length': String(input.contentLength), 'content-type': input.contentType }, {});
  }

  presignGet(key: string, input: PresignGetInput): SignedBlobRequest {
    return this.presign('GET', key, input.expiresInSeconds, input.now, {}, { 'response-content-type': input.contentType, 'response-content-disposition': contentDisposition(input.disposition) });
  }

  /** Verifies a signed URL like a provider would; returns the storage key. */
  verify(rawUrl: string, method: 'PUT' | 'GET', now: Date, headers: Record<string, string> = {}): string {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SignedUrlRejectedError('malformed');
    }
    if (url.protocol !== 'fake-storage:' || url.host !== this.bucket) throw new SignedUrlRejectedError('malformed');
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const signature = url.searchParams.get('signature') ?? '';
    const expires = Number(url.searchParams.get('expires'));
    if (url.searchParams.get('method') !== method) throw new SignedUrlRejectedError('method');
    const extra: Record<string, string> = {};
    for (const name of ['response-content-type', 'response-content-disposition']) {
      const value = url.searchParams.get(name);
      if (value !== null) extra[name] = value;
    }
    const signedHeaders: Record<string, string> = {};
    if (method === 'PUT') {
      signedHeaders['content-length'] = headers['content-length'] ?? '';
      signedHeaders['content-type'] = headers['content-type'] ?? '';
    }
    const expected = Buffer.from(this.sign(method, key, expires, { ...signedHeaders, ...extra }), 'hex');
    const given = Buffer.from(/^[a-f0-9]{64}$/.test(signature) ? signature : '00', 'hex');
    if (!Number.isFinite(expires) || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new SignedUrlRejectedError(method === 'PUT' ? 'headers' : 'signature');
    }
    if (Math.floor(now.getTime() / 1000) > expires) throw new SignedUrlRejectedError('expired');
    assertStorageKey(key);
    return key;
  }

  /** The provider side of a signed PUT: refuses an expired or altered URL and a body that does not match the signed length. */
  async acceptPut(rawUrl: string, body: Uint8Array, headers: Record<string, string>, now: Date): Promise<void> {
    const key = this.verify(rawUrl, 'PUT', now, headers);
    if (Number(headers['content-length']) !== body.byteLength) throw new SignedUrlRejectedError('headers');
    await this.put(key, body);
  }

  /** The provider side of a signed GET. */
  async acceptGet(rawUrl: string, now: Date): Promise<{ body: Uint8Array; contentType: string | null; disposition: string | null }> {
    const key = this.verify(rawUrl, 'GET', now);
    const url = new URL(rawUrl);
    const body = await this.read(key, Number.MAX_SAFE_INTEGER);
    if (!body) throw new BlobNotFoundError();
    return { body, contentType: url.searchParams.get('response-content-type'), disposition: url.searchParams.get('response-content-disposition') };
  }

  async head(key: string): Promise<BlobHead | null> {
    this.operations.push({ op: 'head', key });
    try {
      const info = await stat(this.path(key));
      return info.isFile() ? { bytes: info.size, contentType: null } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array | null> {
    this.operations.push({ op: 'read', key });
    const head = await this.head(key);
    if (!head) return null;
    if (head.bytes > maxBytes) throw new BlobTooLargeError(maxBytes);
    return new Uint8Array(await readFile(this.path(key)));
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.operations.push({ op: 'put', key });
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Write then rename: a reader never sees a partial object.
    const temp = `${target}.${randomBytes(6).toString('hex')}.partial`;
    await writeFile(temp, body);
    await rename(temp, target);
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    this.operations.push({ op: 'copy', key: `${fromKey}->${toKey}` });
    const body = await this.read(fromKey, Number.MAX_SAFE_INTEGER);
    if (!body) throw new BlobNotFoundError();
    await this.put(toKey, body);
  }

  async delete(key: string): Promise<void> {
    this.operations.push({ op: 'delete', key });
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const base = resolve(this.root, this.bucket);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !entry.name.endsWith('.partial')) out.push(relative(base, full).split(sep).join('/'));
      }
    };
    await walk(base);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
}

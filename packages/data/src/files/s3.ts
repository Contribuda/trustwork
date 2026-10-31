import { createHash } from 'node:crypto';
import { assertStorageKey, BlobNotFoundError, BlobStoreError, BlobStoreUnavailableError, BlobTooLargeError, contentDisposition, type BlobHead, type BlobStore, type PresignGetInput, type PresignPutInput, type SignedBlobRequest } from './blob-store.js';
import { EMPTY_SHA256, presignUrl, signHeaders, uriEncode, UNSIGNED_PAYLOAD, type SigV4Credentials } from './sigv4.js';

/**
 * S3-compatible adapter (FILE-001) over `fetch` and SigV4: AWS S3, SeaweedFS (the compose stack), Cloudflare R2, MinIO
 * and similar services. Configuration only, never a provider account: the operator creates the bucket and the
 * credentials and passes them through the environment (`FILES_S3_*`, docs in apps/api/src/modules/files/README.md).
 *
 * `endpoint` is where the API and the worker reach the service; `publicEndpoint` (default: the same) is the origin
 * browsers use for signed URLs, which is part of each signature (for example `http://localhost:8333` while the
 * containers talk to `http://storage:8333`). Path-style addressing by default (`/<bucket>/<key>`).
 */
export interface S3BlobStoreConfig {
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Virtual-hosted style (`<bucket>.<host>`) instead of path style. */
  virtualHosted?: boolean;
  /** Per-request time limit for server-side calls (default 30 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Clock for request signatures (tests). */
  now?: () => Date;
}

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly credentials: SigV4Credentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly config: S3BlobStoreConfig) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new BlobStoreError('invalid bucket name');
    for (const origin of [config.endpoint, config.publicEndpoint ?? config.endpoint]) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BlobStoreError('storage endpoint must be http(s)');
      if (url.pathname !== '/' || url.search || url.username || url.password) throw new BlobStoreError('storage endpoint is an origin without path, query or credentials');
    }
    if (!config.accessKeyId || !config.secretAccessKey) throw new BlobStoreError('storage credentials are missing');
    this.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: 's3' };
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  private objectUrl(key: string, origin: string): URL {
    const base = new URL(origin);
    if (this.config.virtualHosted) return new URL(`${base.protocol}//${this.config.bucket}.${base.host}/${uriEncode(key, true)}`);
    return new URL(`${base.protocol}//${base.host}/${this.config.bucket}/${uriEncode(key, true)}`);
  }
  private bucketUrl(origin: string): URL {
    const base = new URL(origin);
    return this.config.virtualHosted ? new URL(`${base.protocol}//${this.config.bucket}.${base.host}/`) : new URL(`${base.protocol}//${base.host}/${this.config.bucket}`);
  }

  presignPut(key: string, input: PresignPutInput): SignedBlobRequest {
    assertStorageKey(key);
    const headers = { 'content-length': String(input.contentLength), 'content-type': input.contentType };
    const url = presignUrl(this.credentials, { method: 'PUT', url: this.objectUrl(key, this.config.publicEndpoint ?? this.config.endpoint), headers }, input.now, input.expiresInSeconds);
    return { method: 'PUT', url: url.toString(), headers, expiresAt: new Date(input.now.getTime() + input.expiresInSeconds * 1000) };
  }

  presignGet(key: string, input: PresignGetInput): SignedBlobRequest {
    assertStorageKey(key);
    const target = this.objectUrl(key, this.config.publicEndpoint ?? this.config.endpoint);
    target.searchParams.set('response-content-type', input.contentType);
    target.searchParams.set('response-content-disposition', contentDisposition(input.disposition));
    const url = presignUrl(this.credentials, { method: 'GET', url: target }, input.now, input.expiresInSeconds);
    return { method: 'GET', url: url.toString(), headers: {}, expiresAt: new Date(input.now.getTime() + input.expiresInSeconds * 1000) };
  }

  /** One signed server-side request. Network failures, 429 and 5xx are `BlobStoreUnavailableError` (retryable). */
  private async send(method: string, url: URL, options: { body?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal | undefined } = {}): Promise<Response> {
    const payloadHash = options.body ? createHash('sha256').update(options.body).digest('hex') : method === 'GET' || method === 'HEAD' || method === 'DELETE' ? EMPTY_SHA256 : UNSIGNED_PAYLOAD;
    const headers = signHeaders(this.credentials, { method, url, headers: options.headers ?? {}, payloadHash }, this.now());
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, ...(options.body ? { body: new Uint8Array(options.body) } : {}), signal, redirect: 'error' });
    } catch (error) {
      throw new BlobStoreUnavailableError(`storage request failed: ${(error as Error).name}`, { cause: error });
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new BlobStoreUnavailableError(`storage answered ${response.status}`);
    }
    return response;
  }

  private async expectOk(response: Response, what: string): Promise<void> {
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const text = (await response.text().catch(() => '')).slice(0, 300);
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? 'unknown';
    if (response.status === 404) throw new BlobNotFoundError(`${what}: ${code}`);
    throw new BlobStoreError(`${what} failed with ${response.status} ${code}`);
  }

  async head(key: string, signal?: AbortSignal): Promise<BlobHead | null> {
    assertStorageKey(key);
    const response = await this.send('HEAD', this.objectUrl(key, this.config.endpoint), { signal });
    if (response.status === 404) return null;
    await this.expectOk(response, 'head');
    return { bytes: Number(response.headers.get('content-length') ?? '0'), contentType: response.headers.get('content-type') };
  }

  async read(key: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    assertStorageKey(key);
    const response = await this.send('GET', this.objectUrl(key, this.config.endpoint), { signal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await this.expectOk(response, 'read');
      return null;
    }
    const declared = Number(response.headers.get('content-length') ?? 'NaN');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new BlobTooLargeError(maxBytes);
    }
    // Bounded read: stop as soon as the limit is passed, whatever the declared length said.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BlobTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void> {
    assertStorageKey(key);
    const response = await this.send('PUT', this.objectUrl(key, this.config.endpoint), { body, headers: { 'content-type': contentType }, signal });
    await this.expectOk(response, 'put');
  }

  async copy(fromKey: string, toKey: string, signal?: AbortSignal): Promise<void> {
    assertStorageKey(fromKey);
    assertStorageKey(toKey);
    const source = `/${this.config.bucket}/${uriEncode(fromKey, true)}`;
    const response = await this.send('PUT', this.objectUrl(toKey, this.config.endpoint), { headers: { 'x-amz-copy-source': source }, signal });
    // CopyObject may answer 200 with an <Error> body.
    if (response.ok) {
      const text = await response.text().catch(() => '');
      if (/<Error>/.test(text)) {
        const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? 'unknown';
        if (code === 'NoSuchKey') throw new BlobNotFoundError(`copy: ${code}`);
        throw new BlobStoreUnavailableError(`copy failed: ${code}`);
      }
      return;
    }
    await this.expectOk(response, 'copy');
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    assertStorageKey(key);
    const response = await this.send('DELETE', this.objectUrl(key, this.config.endpoint), { signal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await this.expectOk(response, 'delete');
  }

  async list(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const url = this.bucketUrl(this.config.endpoint);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const response = await this.send('GET', url, { signal });
      if (!response.ok) await this.expectOk(response, 'list');
      const text = await response.text();
      for (const match of text.matchAll(/<Key>([^<]{1,1024})<\/Key>/g)) keys.push(decodeXml(match[1] as string));
      token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? (/<NextContinuationToken>([^<]{1,1024})<\/NextContinuationToken>/.exec(text)?.[1] ?? null) : null;
      if (token) token = decodeXml(token);
    } while (token);
    return keys.sort();
  }

  /** Local stack and tests only: creates the bucket when missing. Production buckets are provisioned by the operator. */
  async ensureBucket(signal?: AbortSignal): Promise<void> {
    const head = await this.send('HEAD', this.bucketUrl(this.config.endpoint), { signal });
    await head.body?.cancel().catch(() => undefined);
    if (head.ok) return;
    const response = await this.send('PUT', this.bucketUrl(this.config.endpoint), { signal });
    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await this.expectOk(response, 'create bucket');
  }
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

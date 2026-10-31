import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blobStoreFromEnv, BlobNotFoundError, BlobStoreError, BlobStoreUnavailableError, BlobTooLargeError, FilesystemBlobStore, S3BlobStore, SignedUrlRejectedError, TombstoneLedger,
} from '../../packages/data/src/files/index.js';
import { scannerFromEnv } from '../../apps/worker/src/files/scanner.js';
import { filesOptionsFromEnv } from '../../apps/api/src/modules/files/config.js';
import { sha } from './helpers.js';

/**
 * FILE-001 storage port: the filesystem fake (and its signed-URL scheme), the S3-compatible adapter against a recording
 * fake `fetch` (request shapes, error classes, bounded reads), the tombstone ledger and the configuration guards. The S3
 * adapter against a real S3-compatible service (the compose stack's SeaweedFS) runs in s3-integration.test.ts.
 */
const now = new Date('2026-11-01T10:00:00Z');

test('filesystem fake: objects, listing, copy, idempotent delete and refused keys', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trustwork-fs-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new FilesystemBlobStore({ root });
  await store.put('files/u/a', new TextEncoder().encode('hello'));
  assert.deepEqual(await store.head('files/u/a'), { bytes: 5, contentType: null });
  assert.equal(new TextDecoder().decode((await store.read('files/u/a', 5))!), 'hello');
  await assert.rejects(store.read('files/u/a', 4), BlobTooLargeError);
  assert.equal(await store.read('files/u/missing', 10), null);
  await store.copy('files/u/a', 'files/c/b');
  await assert.rejects(store.copy('files/u/missing', 'files/c/x'), BlobNotFoundError);
  assert.deepEqual(await store.list('files/'), ['files/c/b', 'files/u/a']);
  await store.delete('files/u/a');
  await store.delete('files/u/a');
  assert.equal(await store.head('files/u/a'), null);
  for (const key of ['../escape', 'files/../../etc/passwd', '/absolute', 'files/u/a b', '', 'files\\u']) {
    assert.throws(() => store.presignGet(key, { expiresInSeconds: 60, now, contentType: 'text/plain', disposition: 'attachment' }), BlobStoreError, key);
    await assert.rejects(store.put(key, new Uint8Array(1)), BlobStoreError, key);
  }
});

test('filesystem fake: signed URLs are verified like a provider would (method, expiry, signature, signed headers)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trustwork-fs-sign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new FilesystemBlobStore({ root });
  const other = new FilesystemBlobStore({ root });
  const body = new TextEncoder().encode('0123456789');
  const put = store.presignPut('files/u/signed', { contentType: 'text/plain', contentLength: 10, expiresInSeconds: 60, now });
  assert.equal(put.expiresAt.toISOString(), '2026-11-01T10:01:00.000Z');
  await assert.rejects(other.acceptPut(put.url, body, put.headers, now), (e: unknown) => e instanceof SignedUrlRejectedError && e.reason === 'headers', 'a URL signed by another key');
  await assert.rejects(store.acceptPut(put.url, body, put.headers, new Date(now.getTime() + 61_000)), (e: unknown) => e instanceof SignedUrlRejectedError && e.reason === 'expired');
  await assert.rejects(store.acceptPut(put.url.replace('method=PUT', 'method=GET'), body, put.headers, now), SignedUrlRejectedError);
  await store.acceptPut(put.url, body, put.headers, now);
  const get = store.presignGet('files/u/signed', { expiresInSeconds: 30, now, contentType: 'text/plain', disposition: 'attachment' });
  const fetched = await store.acceptGet(get.url, new Date(now.getTime() + 30_000));
  assert.equal(new TextDecoder().decode(fetched.body), '0123456789');
  assert.equal(fetched.disposition, 'attachment; filename="file"');
  await assert.rejects(store.acceptGet(get.url, new Date(now.getTime() + 31_000)), (e: unknown) => e instanceof SignedUrlRejectedError && e.reason === 'expired');
  const tampered = new URL(get.url);
  tampered.searchParams.set('response-content-type', 'text/html');
  await assert.rejects(store.acceptGet(tampered.toString(), now), (e: unknown) => e instanceof SignedUrlRejectedError && e.reason === 'signature');
  await assert.rejects(store.acceptGet('https://evil.example/files/u/signed', now), SignedUrlRejectedError);
});

test('tombstone ledger: one record per artifact, kept on rewrite, listed for replay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trustwork-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new TombstoneLedger(new FilesystemBlobStore({ root, bucket: 'trustwork-tombstones' }));
  const id = '0b5f2c1e-3f4a-4d2b-9c8e-1a2b3c4d5e6f';
  await ledger.record({ v: 1, artifactId: id, storageKey: 'files/u/x', reason: 'deleted', privacyRequestId: null, recordedAt: '2026-11-01T10:00:00.000Z' });
  await ledger.record({ v: 1, artifactId: id, storageKey: 'files/u/x', reason: 'deleted', privacyRequestId: null, recordedAt: '2026-11-02T10:00:00.000Z' });
  assert.equal((await ledger.get(id) as { recordedAt: string }).recordedAt, '2026-11-01T10:00:00.000Z', 'the first record stays');
  assert.equal((await ledger.all()).length, 1);
  await assert.rejects(ledger.record({ v: 1, artifactId: '../x', storageKey: 'k', reason: 'deleted', privacyRequestId: null, recordedAt: '2026-11-01T10:00:00.000Z' }), BlobStoreError);
});

interface Call { method: string; url: string; headers: Record<string, string>; body: Uint8Array | null }
function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method: init?.method ?? 'GET', url: String(input), headers, body: init?.body ? new Uint8Array(init.body as ArrayBuffer) : null };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}
const config = { endpoint: 'http://storage:8333', publicEndpoint: 'http://localhost:8333', bucket: 'trustwork-files', region: 'us-east-1', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret', now: () => now };

test('S3 adapter: request shapes, signatures and the public endpoint of signed URLs', async () => {
  const objects = new Map<string, Uint8Array>();
  const { fetch, calls } = fakeFetch((call) => {
    const url = new URL(call.url);
    assert.match(call.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=local-test-key\/20261101\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    assert.equal(url.origin, 'http://storage:8333', 'server-side calls use the internal endpoint');
    const key = url.pathname.replace('/trustwork-files/', '');
    if (call.method === 'PUT' && call.headers['x-amz-copy-source']) {
      const from = call.headers['x-amz-copy-source'].replace('/trustwork-files/', '');
      const body = objects.get(from);
      if (!body) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      objects.set(key, body);
      return new Response('<CopyObjectResult/>', { status: 200 });
    }
    if (call.method === 'PUT') {
      assert.equal(call.headers['x-amz-content-sha256'], sha(call.body!), 'server-side uploads sign the payload hash');
      objects.set(key, call.body!);
      return new Response(null, { status: 200 });
    }
    if (call.method === 'HEAD') return objects.has(key) ? new Response(null, { status: 200, headers: { 'content-length': String(objects.get(key)!.byteLength), 'content-type': 'text/plain' } }) : new Response(null, { status: 404 });
    if (call.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (call.method === 'GET' && url.pathname === '/trustwork-files') {
      const token = url.searchParams.get('continuation-token');
      const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      const page = token ? keys.slice(1) : keys.slice(0, 1);
      const more = !token && keys.length > 1;
      return new Response(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? '<NextContinuationToken>t&amp;1</NextContinuationToken>' : ''}</ListBucketResult>`, { status: 200 });
    }
    const body = objects.get(key);
    return body ? new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.byteLength) } }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  });
  const store = new S3BlobStore({ ...config, fetch });
  await store.put('files/u/a', new TextEncoder().encode('hello'), 'text/plain');
  assert.deepEqual(await store.head('files/u/a'), { bytes: 5, contentType: 'text/plain' });
  assert.equal(new TextDecoder().decode((await store.read('files/u/a', 10))!), 'hello');
  await assert.rejects(store.read('files/u/a', 4), BlobTooLargeError);
  await store.copy('files/u/a', 'files/c/b');
  await assert.rejects(store.copy('files/u/missing', 'files/c/x'), BlobNotFoundError);
  assert.deepEqual(await store.list('files/'), ['files/c/b', 'files/u/a'], 'pages are followed');
  assert.equal(calls.filter((c) => c.url.includes('continuation-token=t%261')).length, 1, 'the continuation token is decoded and re-encoded');
  await store.delete('files/u/a');
  assert.equal(await store.read('files/u/a', 10), null);
  assert.equal(await store.head('files/u/a'), null);

  const put = store.presignPut('files/u/z', { contentType: 'image/png', contentLength: 42, expiresInSeconds: 300, now });
  const putUrl = new URL(put.url);
  assert.equal(putUrl.origin, 'http://localhost:8333', 'browsers get the public endpoint');
  assert.equal(putUrl.pathname, '/trustwork-files/files/u/z');
  assert.equal(putUrl.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(putUrl.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.deepEqual(put.headers, { 'content-length': '42', 'content-type': 'image/png' });
  assert.equal(put.expiresAt.toISOString(), '2026-11-01T10:05:00.000Z');
  const get = new URL(store.presignGet('files/u/z', { expiresInSeconds: 60, now, contentType: 'application/pdf', disposition: 'attachment' }).url);
  assert.equal(get.searchParams.get('response-content-disposition'), 'attachment; filename="file"');
  assert.equal(get.searchParams.get('response-content-type'), 'application/pdf');
  assert.ok(!get.search.includes('+'), 'spaces are %20, never +');
});

test('S3 adapter: unreachable, throttled and failing services are retryable; refusals are not', async () => {
  const down = new S3BlobStore({ ...config, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(down.head('files/u/a'), BlobStoreUnavailableError);
  for (const status of [429, 500, 503]) {
    const store = new S3BlobStore({ ...config, fetch: fakeFetch(() => new Response('busy', { status })).fetch });
    await assert.rejects(store.read('files/u/a', 10), BlobStoreUnavailableError, String(status));
  }
  const denied = new S3BlobStore({ ...config, fetch: fakeFetch(() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })).fetch });
  await assert.rejects(denied.put('files/u/a', new Uint8Array(1), 'text/plain'), (e: unknown) => e instanceof BlobStoreError && !(e instanceof BlobStoreUnavailableError) && /AccessDenied/.test((e as Error).message));
  const copyError = new S3BlobStore({ ...config, fetch: fakeFetch(() => new Response('<Error><Code>InternalError</Code></Error>', { status: 200 })).fetch });
  await assert.rejects(copyError.copy('files/u/a', 'files/u/b'), BlobStoreUnavailableError, 'a 200 with an error body');
  const lying = new S3BlobStore({ ...config, fetch: fakeFetch(() => new Response(new Uint8Array(100), { status: 200, headers: { 'content-length': '5' } })).fetch });
  await assert.rejects(lying.read('files/u/a', 10), BlobTooLargeError, 'the read stops at the limit whatever the declared length');
  assert.throws(() => new S3BlobStore({ ...config, endpoint: 'ftp://storage' }), BlobStoreError);
  assert.throws(() => new S3BlobStore({ ...config, endpoint: 'http://user:pw@storage:8333' }), BlobStoreError);
  assert.throws(() => new S3BlobStore({ ...config, bucket: 'Bad_Bucket' }), BlobStoreError);
  assert.throws(() => new S3BlobStore({ ...config, secretAccessKey: '' }), BlobStoreError);
});

test('configuration: files are off by default, the fakes are refused in production, s3 needs every setting', () => {
  assert.equal(blobStoreFromEnv({}), null);
  assert.equal(filesOptionsFromEnv({}).store, null);
  assert.equal(blobStoreFromEnv({ FILES_STORAGE: 'filesystem', FILES_FS_ROOT: join(tmpdir(), 'trustwork-files-config') })?.store.kind, 'filesystem');
  assert.throws(() => blobStoreFromEnv({ FILES_STORAGE: 'filesystem', NODE_ENV: 'production' }), /refused with NODE_ENV=production/);
  assert.throws(() => blobStoreFromEnv({ FILES_STORAGE: 's3', FILES_S3_ENDPOINT: 'http://storage:8333' }), /FILES_S3_BUCKET, FILES_S3_ACCESS_KEY_ID, FILES_S3_SECRET_ACCESS_KEY/);
  assert.throws(() => blobStoreFromEnv({ FILES_STORAGE: 'gcs' }), /disabled, filesystem or s3/);
  const s3 = blobStoreFromEnv({ FILES_STORAGE: 's3', FILES_S3_ENDPOINT: 'http://storage:8333', FILES_S3_BUCKET: 'trustwork-files', FILES_S3_ACCESS_KEY_ID: 'k', FILES_S3_SECRET_ACCESS_KEY: 's', NODE_ENV: 'production' });
  assert.equal(s3?.store.kind, 's3');
  const options = filesOptionsFromEnv({ FILES_STORAGE: 'filesystem', FILES_FS_ROOT: join(tmpdir(), 'trustwork-files-config'), FILES_UPLOAD_URL_TTL_SECONDS: '86400', FILES_DOWNLOAD_URL_TTL_SECONDS: '1' });
  assert.deepEqual([options.uploadTtlSeconds, options.downloadTtlSeconds], [900, 10], 'configured lifetimes are clamped to the contract bounds');
  assert.equal(scannerFromEnv({}), null);
  assert.equal(scannerFromEnv({ FILES_SCANNER: 'fake' })?.name, 'fake');
  assert.throws(() => scannerFromEnv({ FILES_SCANNER: 'fake', NODE_ENV: 'production' }), /refused with NODE_ENV=production/);
  assert.throws(() => scannerFromEnv({ FILES_SCANNER: 'clamav' }), /unset or fake/);
});

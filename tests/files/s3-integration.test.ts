import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { S3BlobStore, TombstoneLedger } from '../../packages/data/src/files/index.js';
import { sha } from './helpers.js';

/**
 * FILE-001 S3 adapter against a real S3-compatible service: the compose stack's SeaweedFS (infra/compose.yaml, service
 * `storage`) or any local equivalent, with authentication enabled. Runs only when the endpoint and local credentials are
 * given; otherwise skipped with the reason. No provider account is involved:
 *
 *   TRUSTWORK_TEST_S3_ENDPOINT=http://127.0.0.1:18333 TRUSTWORK_TEST_S3_ACCESS_KEY_ID=... TRUSTWORK_TEST_S3_SECRET_ACCESS_KEY=... \
 *     node --import tsx --test tests/files/s3-integration.test.ts
 *
 * The service itself refuses an expired, altered or unsigned request: the proof that signed URLs are short-lived and the
 * bucket is not public.
 */
const endpoint = process.env.TRUSTWORK_TEST_S3_ENDPOINT;
const accessKeyId = process.env.TRUSTWORK_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.TRUSTWORK_TEST_S3_SECRET_ACCESS_KEY;
const skip = endpoint && accessKeyId && secretAccessKey ? false : 'SKIPPED: TRUSTWORK_TEST_S3_ENDPOINT and local credentials are not set (S3-compatible service not configured)';

test('S3 adapter against a real S3-compatible service', { skip }, async (t) => {
  const bucket = `trustwork-test-${randomBytes(4).toString('hex')}`;
  const store = new S3BlobStore({ endpoint: endpoint as string, bucket, region: process.env.TRUSTWORK_TEST_S3_REGION ?? 'us-east-1', accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string });
  await store.ensureBucket();
  await store.ensureBucket();
  t.after(async () => {
    for (const key of await store.list('').catch(() => [])) await store.delete(key).catch(() => undefined);
  });
  const body = new TextEncoder().encode(`fixture bytes ${randomBytes(8).toString('hex')}\n`);
  const key = `files/u/${sha(body)}`;

  await t.test('a signed PUT stores exactly the declared bytes; changed headers are refused by the service', async () => {
    const put = store.presignPut(key, { contentType: 'text/plain', contentLength: body.byteLength, expiresInSeconds: 60, now: new Date() });
    const wrongType = await fetch(put.url, { method: 'PUT', headers: { ...put.headers, 'content-type': 'text/html' }, body: Buffer.from(body) });
    assert.equal(wrongType.status, 403, 'a content type other than the signed one');
    await wrongType.body?.cancel();
    const ok = await fetch(put.url, { method: 'PUT', headers: put.headers, body: Buffer.from(body) });
    assert.equal(ok.status, 200, await ok.text());
    assert.deepEqual((await store.head(key))?.bytes, body.byteLength);
    assert.equal(sha((await store.read(key, body.byteLength))!), sha(body));
  });

  await t.test('a signed GET serves the bytes with the signed type and disposition; expired, altered and unsigned requests are refused', async () => {
    const get = store.presignGet(key, { expiresInSeconds: 60, now: new Date(), contentType: 'text/plain', disposition: 'attachment' });
    const ok = await fetch(get.url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="file"');
    assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(sha(new Uint8Array(await ok.arrayBuffer())), sha(body));

    const expired = store.presignGet(key, { expiresInSeconds: 60, now: new Date(Date.now() - 120_000), contentType: 'text/plain', disposition: 'attachment' });
    const late = await fetch(expired.url);
    assert.equal(late.status, 403, 'expired');
    await late.body?.cancel();
    const altered = new URL(get.url);
    altered.searchParams.set('X-Amz-Expires', '604800');
    const extended = await fetch(altered.toString());
    assert.equal(extended.status, 403, 'a lifetime extended by the client');
    await extended.body?.cancel();
    const otherKey = await fetch(get.url.replace(key, `files/u/${'0'.repeat(64)}`));
    assert.equal(otherKey.status, 403, 'the signature does not open another object');
    await otherKey.body?.cancel();
    const unsigned = await fetch(new URL(`/${bucket}/${key}`, endpoint).toString());
    assert.equal(unsigned.status, 403, 'the bucket is not public');
    await unsigned.body?.cancel();
  });

  await t.test('server-side copy, listing, idempotent delete and the tombstone ledger', async () => {
    await store.copy(key, `${key}-copy`);
    assert.equal(sha((await store.read(`${key}-copy`, body.byteLength))!), sha(body));
    assert.deepEqual(await store.list('files/u/'), [key, `${key}-copy`].sort());
    await store.delete(`${key}-copy`);
    await store.delete(`${key}-copy`);
    assert.equal(await store.head(`${key}-copy`), null);
    assert.equal(await store.read(`${key}-copy`, 10), null);
    const ledger = new TombstoneLedger(store);
    const id = '0b5f2c1e-3f4a-4d2b-9c8e-1a2b3c4d5e6f';
    await ledger.record({ v: 1, artifactId: id, storageKey: key, reason: 'deleted', privacyRequestId: null, recordedAt: new Date().toISOString() });
    assert.equal((await ledger.all()).length, 1);
    assert.equal((await ledger.get(id) as { storageKey: string }).storageKey, key);
  });
});

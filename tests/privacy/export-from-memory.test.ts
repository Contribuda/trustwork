import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { addLogins, signIn } from '../admin/helpers.js';
import { BlobStoreError, type BlobStore } from '../../packages/data/src/files/blob-store.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';

/**
 * PRV-001: the JSON export is delivered from memory. A write would serve no purpose, and a crash between the write and
 * the delete would leave a plaintext personal export in storage with nothing sweeping it. A store that refuses every
 * write under the export prefix and records the attempt proves the write is gone; the digest stays in the response.
 */
function refusingExportWrites(store: BlobStore, kind: BlobStore['kind'], attempts: string[]): BlobStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'kind') return kind;
      if (key === 'put') return async (path: string, body: Uint8Array, contentType: string, signal?: AbortSignal) => {
        if (path.startsWith('privacy-exports/')) { attempts.push(path); throw new BlobStoreError('synthetic: exports are never written'); }
        return target.put(path, body, contentType, signal);
      };
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('PRV export delivery: the archive goes out from memory on any store, with its digest, and is never written', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'privacy-memory-'));
  const attempts: string[] = [];
  // Not the filesystem fake: delivery no longer depends on which object store the deployment runs.
  const store = refusingExportWrites(new FilesystemBlobStore({ root }), 's3', attempts);
  const h = await startHarness('privacy_export_memory', { files: { store } });
  if (!h) { await rm(root, { recursive: true, force: true }); t.skip(SKIP_REASON); return; }
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }); });
  const person = (await h.db.admin.query<{ id: string }>("INSERT INTO trustwork.person(display_name) VALUES('Synthetic Memory Export Subject') RETURNING id")).rows[0]!.id;
  const email = `synthetic-${randomUUID()}@example.invalid`;
  await addLogins(h, [[person, email]]);
  const client = h.client(); await signIn(client, email);
  const created = await client.post('/v1/privacy/exports', { subject: { kind: 'person', id: person } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body as { export: { id: string } }).export.id;

  const first = await client.get(`/v1/privacy/exports/${id}`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers['cache-control'], 'no-store');
  const body = first.body as { sha256: string; archive: { format: string; complete: boolean; subject: unknown } };
  assert.deepEqual(Object.keys(body).sort(), ['archive', 'sha256']);
  assert.equal(body.archive.format, 'privacy-json-1');
  assert.equal(body.archive.complete, false);
  assert.deepEqual(body.archive.subject, { kind: 'person', id: person });
  assert.equal(body.sha256, createHash('sha256').update(JSON.stringify(body.archive)).digest('hex'), 'the digest covers the delivered archive');
  assert.deepEqual(attempts, [], 'nothing was written under the export prefix');
  assert.deepEqual(await store.list('privacy-exports/'), []);
});

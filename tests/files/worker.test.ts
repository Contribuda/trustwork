import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { BlobStoreUnavailableError } from '../../packages/data/src/files/index.js';
import { FILES_DELETE_KIND, FILES_SCAN_KIND } from '../../apps/worker/src/files/handlers.js';
import { png, startFilesStack } from './helpers.js';

const stack = await startFilesStack('files_worker');

/**
 * FILE-001 worker behaviour on real PostgreSQL with the worker role: an unreachable scanner or store is a retry (the
 * file stays pending and invisible), never an unknown outcome; a duplicated intent yields one job; a legal hold set
 * after the deletion request stops the deletion (the file stays hidden, the job dead-letters for the privacy officer).
 */
test('FILE-001 worker: retries, duplicates and legal holds', { skip: stack ? false : SKIP_REASON }, async (t) => {
  if (!stack) return;
  t.after(() => stack.close());
  const { seed, admin } = stack;
  const petr = await stack.client('petr');
  const boris = await stack.client('boris');
  const owner = { kind: 'person' as const, id: seed.people.petr };
  const project = { kind: 'project', id: seed.project };
  const jobOf = async (kind: string, artifactId: string) => (await admin.query<{ state: string; attempt: number; last_error: string | null }>(
    "SELECT state, attempt, last_error FROM trustwork.job WHERE kind = $1 AND payload->>'artifactId' = $2 ORDER BY created_at", [kind, artifactId])).rows;

  await t.test('an unavailable scanner retries with backoff and keeps the file invisible', async () => {
    stack.scanner.unavailable = true;
    const file = await stack.upload(petr, { owner, parent: project, bytes: png() });
    const [job] = await jobOf(FILES_SCAN_KIND, file.id);
    assert.equal(job?.state, 'queued', 'retryable, not parked as outcome_unknown');
    assert.equal(job?.attempt, 1);
    assert.match(job?.last_error ?? '', /scanner is unavailable/);
    assert.equal((await boris.get(`/v1/files/${file.id}`)).status, 404);
    stack.scanner.unavailable = false;
    await admin.query("UPDATE trustwork.job SET next_at = now() WHERE kind = $1 AND payload->>'artifactId' = $2", [FILES_SCAN_KIND, file.id]);
    await stack.drain();
    assert.equal((await jobOf(FILES_SCAN_KIND, file.id))[0]?.state, 'succeeded');
    assert.equal((await boris.get(`/v1/files/${file.id}`)).status, 200);
  });

  await t.test('an unreachable store is a retry for scans and deletions', async () => {
    const original = stack.store.read.bind(stack.store);
    stack.store.read = async () => {
      throw new BlobStoreUnavailableError('connection refused');
    };
    const file = await stack.upload(petr, { owner, parent: project, bytes: png() });
    stack.store.read = original;
    assert.equal((await jobOf(FILES_SCAN_KIND, file.id))[0]?.state, 'queued');
    await admin.query("UPDATE trustwork.job SET next_at = now() WHERE kind = $1", [FILES_SCAN_KIND]);
    await stack.drain();
    assert.equal(((await petr.get(`/v1/files/${file.id}`)).body as { scanState: string }).scanState, 'clean');

    const originalDelete = stack.store.delete.bind(stack.store);
    stack.store.delete = async () => {
      throw new BlobStoreUnavailableError('connection refused');
    };
    assert.equal((await petr.post(`/v1/files/${file.id}/delete`, {})).status, 200);
    await stack.drain();
    stack.store.delete = originalDelete;
    assert.equal((await jobOf(FILES_DELETE_KIND, file.id))[0]?.state, 'queued');
    assert.ok(await stack.tombstones.get(file.id), 'the tombstone is written before the bytes go');
    await admin.query("UPDATE trustwork.job SET next_at = now() WHERE kind = $1", [FILES_DELETE_KIND]);
    await stack.drain();
    assert.equal((await jobOf(FILES_DELETE_KIND, file.id))[0]?.state, 'succeeded');
    assert.equal((await admin.query('SELECT 1 FROM trustwork.evidence_artifact WHERE id = $1', [file.id])).rowCount, 0);
  });

  await t.test('the same intent appended twice yields one job', async () => {
    const file = await stack.upload(petr, { owner, parent: project, bytes: png() }, { scan: false });
    await admin.query("INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('evidence_artifact', $1, 1, 'file.uploaded', $2)", [file.id, JSON.stringify({ artifactId: file.id })]);
    await stack.drain();
    assert.equal((await jobOf(FILES_SCAN_KIND, file.id)).length, 1);
    assert.equal(stack.scanner.calls > 0, true);
  });

  await t.test('a malformed intent never reaches a job', async () => {
    await admin.query("INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('evidence_artifact', 'x', 1, 'file.uploaded', $1)", [JSON.stringify({ artifactId: 'not-a-uuid', storageKey: 'files/u/forged' })]);
    await stack.drain();
    const jobs = await admin.query("SELECT 1 FROM trustwork.job WHERE kind = $1 AND payload->>'artifactId' = 'not-a-uuid'", [FILES_SCAN_KIND]);
    assert.equal(jobs.rowCount, 0);
  });

  await t.test('a legal hold set after the deletion request stops the deletion; the file stays hidden', async () => {
    const file = await stack.upload(petr, { owner, parent: project, bytes: png() });
    assert.equal((await petr.post(`/v1/files/${file.id}/delete`, {})).status, 200);
    await withMaintenance(admin, (trx) => trx.updateTable('evidence_artifact').set({ legal_hold: true }).where('id', '=', file.id).execute());
    await stack.drain();
    const [job] = await jobOf(FILES_DELETE_KIND, file.id);
    assert.equal(job?.state, 'dead');
    assert.match(job?.last_error ?? '', /legal hold/);
    assert.ok(await stack.store.head(file.storageKey), 'the bytes are preserved');
    assert.equal(await stack.tombstones.get(file.id), null, 'no tombstone for a preserved file');
    assert.equal((await petr.get(`/v1/files/${file.id}`)).status, 404, 'still hidden from every runtime reader');
  });
});

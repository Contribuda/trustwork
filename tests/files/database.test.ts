import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import { files, fileWorker } from '../../packages/data/src/repositories/files.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/index.js';
import { filesExpireUploadsTask, requestFileErasure } from '../../apps/worker/src/files/handlers.js';
import { Metrics } from '../../apps/worker/src/index.js';
import { SKIP_REASON, sqlState } from '../data/helpers/postgres.js';
import { principalFor, seedFixtures, type Seed } from '../data/helpers/seed.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { sha } from './helpers.js';
import { allowedClassifications, FILE_CLASSIFICATIONS, FILE_PARENT_KINDS } from '../../packages/contracts/src/files.js';

const env = await provisionWorkerDatabase('files_database');

/**
 * FILE-001 database boundary on real PostgreSQL with the actual runtime and worker roles: an upload cannot forge its
 * uploader, owner, scan state or legal hold; the runtime role writes the lifecycle only through the owner-run commands
 * (which repeat the attach and ownership checks), the worker role only through its entry points and has no table grant;
 * verdicts are recorded once; erasure needs two people and yields to a legal hold; abandoned uploads are discarded.
 */
test('FILE-001 database: roles, policies and owner-run commands', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  const root = mkdtempSync(join(tmpdir(), 'trustwork-files-db-'));
  const worker: DataPool = env.db.teardown.watch(env.workerPool(4));
  t.after(async () => {
    env.db.teardown.begin();
    await worker.end().catch(() => undefined);
    await env.close();
    rmSync(root, { recursive: true, force: true });
  });
  const seed: Seed = await seedFixtures(env.db.admin);
  const app = env.db.app;
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(app, await principalFor(env.db.admin, personId), fn);
  const rejects = async (promise: Promise<unknown>, state: string, hint?: string) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    assert.ok(error, 'expected a rejection');
    assert.equal(sqlState(error), state, String(error));
    if (hint) assert.equal((error as { hint?: string }).hint, hint, String(error));
  };
  let counter = 0;
  const input = (personId: string, over: Partial<Parameters<typeof files.startUpload>[1]> = {}) => ({
    owner: { personId }, parent: { kind: 'project' as const, id: seed.project }, classification: 'shared' as const, storageKey: `files/u/test-${++counter}`,
    sha256: sha(`content-${counter}`), bytes: 10, mediaType: 'image/png', uploadedBy: personId, ...over,
  });
  const clean = async (id: string) => tx(worker, (trx) => fileWorker.recordScan(trx, id, { state: 'clean' }));

  await t.test('an upload cannot forge uploader, owner, scan state or legal hold', async () => {
    await rejects(as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr, { uploadedBy: seed.people.carl }), 300)), '42501');
    await rejects(as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr, { owner: { personId: seed.people.carl } }), 300)), '42501');
    await rejects(as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr, { owner: { companyId: seed.companies.supplier } }), 300)), '42501');
    await rejects(as(seed.people.carl, (trx) => files.startUpload(trx, input(seed.people.carl), 300)), '42501');
    await rejects(as(seed.people.petr, (trx) => sql`INSERT INTO trustwork.evidence_artifact (owner_person_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, uploaded_by, scan_state)
      VALUES (${seed.people.petr}, 'project', ${seed.project}, 'shared', 'files/u/forged', ${sha('x')}, 1, 'image/png', ${seed.people.petr}, 'clean')`.execute(trx)), '42501');
    await rejects(as(seed.people.petr, (trx) => sql`INSERT INTO trustwork.evidence_artifact (owner_person_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, uploaded_by, legal_hold)
      VALUES (${seed.people.petr}, 'project', ${seed.project}, 'shared', 'files/u/forged2', ${sha('x')}, 1, 'image/png', ${seed.people.petr}, true)`.execute(trx)), '42501');
    await rejects(as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr, { classification: 'restricted' as 'shared' }), 300)), '42501');
    const ok = await as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr), 300));
    assert.ok(ok.uploadExpiresAt.getTime() > Date.now());
    await rejects(as(seed.people.petr, (trx) => sql`UPDATE trustwork.evidence_artifact SET scan_state = 'clean' WHERE id = ${ok.id}`.execute(trx)), '42501');
    await rejects(as(seed.people.petr, (trx) => sql`UPDATE trustwork.file_artifact_state SET upload_completed_at = now() WHERE artifact_id = ${ok.id}`.execute(trx)), '42501');
    await rejects(as(seed.people.petr, (trx) => sql`DELETE FROM trustwork.evidence_artifact WHERE id = ${ok.id}`.execute(trx)), '42501');
    await rejects(as(seed.people.petr, (trx) => sql`SELECT trustwork.files_register_upload(${ok.id}::uuid, 300)`.execute(trx)), '42501', 'files.not_found');
  });

  await t.test('the upload window is bounded by the database and belongs to the uploader', async () => {
    for (const ttl of [0, 29, 901, 86_400]) {
      await rejects(as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr), ttl)), '23514', 'files.window_bounds');
    }
    const { id } = await as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr), 60));
    await rejects(as(seed.people.boris, (trx) => files.completeUpload(trx, id)), '42501', 'files.not_found');
    assert.equal(await as(seed.people.petr, (trx) => files.completeUpload(trx, id)), true);
    assert.equal(await as(seed.people.petr, (trx) => files.completeUpload(trx, id)), false, 'completion is reported once');
  });

  await t.test('pending files are visible to the owner only; clean shared files follow the parent', async () => {
    const { id } = await as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr), 60));
    assert.ok(await as(seed.people.petr, (trx) => files.get(trx, id)));
    assert.equal(await as(seed.people.boris, (trx) => files.get(trx, id)), undefined, 'not before the scan');
    assert.equal(await clean(id), true);
    assert.equal(await clean(id), false, 'a verdict is recorded once');
    assert.ok(await as(seed.people.boris, (trx) => files.get(trx, id)), 'a live participant reads the clean shared file');
    assert.equal(await as(seed.people.carl, (trx) => files.get(trx, id)), undefined);
    assert.deepEqual(await as(seed.people.carl, (trx) => files.forParent(trx, 'project', seed.project)), []);
    const state = await as(seed.people.boris, (trx) => trx.selectFrom('file_artifact_state').selectAll().where('artifact_id', '=', id).executeTakeFirst());
    assert.ok(state?.scanned_at, 'the state follows the artifact visibility');
    assert.equal(await as(seed.people.carl, (trx) => trx.selectFrom('file_artifact_state').selectAll().where('artifact_id', '=', id).executeTakeFirst()), undefined);
    await rejects(worker.query("SELECT trustwork.files_record_scan($1::uuid, 'clean', 'malware')", [id]), '23514', 'files.invalid_verdict');
    await rejects(worker.query("SELECT trustwork.files_record_scan($1::uuid, 'quarantined', NULL)", [id]), '23514', 'files.invalid_verdict');
    await rejects(worker.query("SELECT trustwork.files_record_scan($1::uuid, 'pending', NULL)", [id]), '23514', 'files.invalid_verdict');
  });

  await t.test('the database classification rule equals the contract policy for every parent kind', async () => {
    for (const kind of FILE_PARENT_KINDS) {
      for (const classification of FILE_CLASSIFICATIONS) {
        const result: { rows: { ok: boolean }[] } = await env.db.admin.query<{ ok: boolean }>('SELECT trustwork.files_classification_allowed($1, $2) AS ok', [kind, classification]);
        assert.equal(result.rows[0]?.ok, (allowedClassifications(kind) as string[]).includes(classification), `${kind}/${classification}`);
      }
    }
  });

  await t.test('roles: the worker has no table grant, each role executes only its own entry points', async () => {
    await rejects(worker.query('SELECT 1 FROM trustwork.evidence_artifact'), '42501');
    await rejects(worker.query('SELECT 1 FROM trustwork.file_artifact_state'), '42501');
    await rejects(worker.query('SELECT trustwork.files_copy($1::uuid, $2, $3::uuid, $4)', [seed.project, 'project', seed.project, 'files/c/x']), '42501');
    await rejects(worker.query('SELECT trustwork.files_request_deletion($1::uuid)', [seed.project]), '42501');
    await rejects(app.query('SELECT trustwork.files_record_scan($1::uuid, $2, NULL)', [seed.project, 'clean']), '42501');
    await rejects(app.query('SELECT trustwork.files_finish_deletion($1::uuid)', [seed.project]), '42501');
    await rejects(app.query('SELECT trustwork.files_apply_tombstone($1::uuid, $2)', [seed.project, 'files/u/x']), '42501');
    await rejects(app.query('SELECT * FROM trustwork.files_scan_target($1::uuid)', [seed.project]), '42501');
    const grants = await env.db.admin.query<{ privilege_type: string; table_name: string }>("SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'trustwork_worker' AND table_name IN ('evidence_artifact', 'file_artifact_state')");
    assert.deepEqual(grants.rows, []);
    const appGrants = await env.db.admin.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'trustwork_app' AND table_name = 'file_artifact_state'");
    assert.deepEqual(appGrants.rows.map((r) => r.privilege_type), ['SELECT']);
  });

  await t.test('copy, move and deletion requests repeat the ownership and attach checks', async () => {
    const { id } = await as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr), 60));
    await rejects(as(seed.people.petr, (trx) => files.copy(trx, id, { kind: 'project', id: seed.project }, 'files/c/early')), '23514', 'files.not_clean');
    await clean(id);
    await rejects(as(seed.people.boris, (trx) => files.copy(trx, id, { kind: 'project', id: seed.project }, 'files/c/boris')), '42501', 'files.not_found');
    await rejects(as(seed.people.boris, (trx) => files.move(trx, id, { kind: 'project', id: seed.project })), '42501', 'files.not_found');
    await rejects(as(seed.people.boris, (trx) => files.requestDeletion(trx, id)), '42501', 'files.not_found');
    await rejects(as(seed.people.petr, (trx) => files.copy(trx, id, { kind: 'person', id: seed.people.petr }, 'files/c/person')), '23514', 'files.classification_not_allowed');
    await rejects(as(seed.people.petr, (trx) => files.copy(trx, id, { kind: 'person', id: seed.people.carl }, 'files/c/carl')), '42501', 'files.parent_not_found');
    await rejects(as(seed.people.petr, (trx) => files.move(trx, id, { kind: 'project', id: seed.project })), '23514', 'files.same_parent');
    const copyId = await as(seed.people.petr, (trx) => files.copy(trx, id, { kind: 'project', id: seed.project }, 'files/c/ok'));
    const [source, copy] = await withMaintenance(env.db.admin, async (trx) => Promise.all([
      trx.selectFrom('evidence_artifact').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
      trx.selectFrom('evidence_artifact').selectAll().where('id', '=', copyId).executeTakeFirstOrThrow(),
    ]));
    assert.deepEqual([copy.owner_person_id, copy.classification, copy.sha256, copy.bytes, copy.media_type, copy.uploaded_by, copy.scan_state], [source.owner_person_id, source.classification, source.sha256, source.bytes, source.media_type, source.uploaded_by, 'pending']);
    const target = await tx(worker, (trx) => fileWorker.scanTarget(trx, copyId));
    assert.equal(target?.copy_from_key, source.storage_key);
    assert.equal(await as(seed.people.petr, (trx) => files.requestDeletion(trx, copyId)), true);
    assert.equal(await as(seed.people.petr, (trx) => files.requestDeletion(trx, copyId)), false);
    assert.equal(await as(seed.people.petr, (trx) => files.get(trx, copyId)), undefined, 'hidden at once, for the owner too');
    await rejects(env.db.admin.query("UPDATE trustwork.file_artifact_state SET deletion_requested_at = NULL, deletion_mode = NULL WHERE artifact_id = $1", [copyId]), '23000', 'files.state_immutable');
  });

  await t.test('erasure needs two different people and yields to a legal hold', async () => {
    const make = async () => {
      const { id } = await as(seed.people.petr, (trx) => files.startUpload(trx, input(seed.people.petr), 60));
      await clean(id);
      return id;
    };
    const [a, b, held] = [await make(), await make(), await make()];
    await assert.rejects(requestFileErasure(worker, { privacyRequestId: 'pr-1', artifactIds: [a], executedBy: seed.people.anna, secondApprover: seed.people.anna }), /two different people/);
    await rejects(tx(worker, (trx) => fileWorker.requestErasure(trx, a, { privacyRequestId: 'pr-1', executedBy: seed.people.anna, secondApprover: seed.people.anna })), '23514', 'files.erasure_approvers');
    await withMaintenance(env.db.admin, (trx) => trx.updateTable('evidence_artifact').set({ legal_hold: true }).where('id', '=', held).execute());
    const report = await requestFileErasure(worker, { privacyRequestId: 'pr-1', artifactIds: [a, b, held, '00000000-0000-4000-8000-000000000000'], executedBy: seed.people.anna, secondApprover: seed.people.boris });
    assert.deepEqual(report, { queued: [a, b], held: [held], missing: ['00000000-0000-4000-8000-000000000000'] });
    const queued = await env.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.job WHERE kind = 'files.delete' AND payload->>'artifactId' = ANY($1)", [[a, b]]);
    assert.equal(queued.rows[0]?.n, 2);
    const target = await tx(worker, (trx) => fileWorker.deletionTarget(trx, a));
    assert.deepEqual([target?.deletion_mode, target?.privacy_request_id], ['erase', 'pr-1']);
    assert.equal(await tx(worker, (trx) => fileWorker.finishDeletion(trx, a)), true);
    const audit = await env.db.admin.query<{ action: string }>('SELECT action FROM trustwork.audit_event WHERE object_id = $1 ORDER BY id', [a]);
    assert.deepEqual(audit.rows.map((r) => r.action), ['file.scan_clean', 'file.erasure_requested', 'file.erased']);
  });

  await t.test('abandoned uploads are discarded with their bytes; completed or recent ones stay', async () => {
    const store = new FilesystemBlobStore({ root });
    const insert = async (key: string, expiresAt: string, completed: boolean) => {
      const row = await env.db.admin.query<{ id: string }>(`INSERT INTO trustwork.evidence_artifact (owner_person_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, uploaded_by)
        VALUES ($1, 'project', $2, 'shared', $3, $4, 3, 'text/plain', $1) RETURNING id`, [seed.people.petr, seed.project, key, sha(key)]);
      const id = row.rows[0]!.id;
      await env.db.admin.query(`INSERT INTO trustwork.file_artifact_state (artifact_id, origin, upload_expires_at, upload_completed_at) VALUES ($1, 'upload', $2, $3)`, [id, expiresAt, completed ? expiresAt : null]);
      await store.put(key, new TextEncoder().encode('abc'));
      return id;
    };
    const old = await insert('files/u/abandoned', new Date(Date.now() - 2 * 3600_000).toISOString(), false);
    const recent = await insert('files/u/recent', new Date(Date.now() - 10 * 60_000).toISOString(), false);
    const done = await insert('files/u/done', new Date(Date.now() - 2 * 3600_000).toISOString(), true);
    const report = await filesExpireUploadsTask({ pool: worker, store, metrics: new Metrics() }).run();
    assert.deepEqual(report, { due: 1, discarded: 1 });
    const left = await env.db.admin.query<{ id: string }>('SELECT id FROM trustwork.evidence_artifact WHERE id = ANY($1)', [[old, recent, done]]);
    assert.deepEqual(left.rows.map((r) => r.id).sort(), [recent, done].sort());
    assert.equal(await store.head('files/u/abandoned'), null);
    assert.ok(await store.head('files/u/recent'));
  });
});

import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { inTransaction } from '@trustwork/worker';
import { digitalSourceTypeUri, ProvenanceWorkspaceSchema, PublicPublicationSchema } from '../../packages/contracts/src/client.js';
import { BlobStoreUnavailableError } from '../../packages/data/src/files/index.js';
import { PROVENANCE_IMAGE_KIND } from '../../apps/worker/src/provenance/handlers.js';
import { provenanceWorker } from '../../packages/data/src/repositories/provenance.js';
import { readDigitalSourceType } from '../../apps/worker/src/provenance/xmp.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { exifTiff, jpeg, startFilesStack, uploadKey } from '../files/helpers.js';
import { expectRefusal, ok } from '../content/http.js';
import type { Client } from '../backend/helpers/app.js';

const stack = await startFilesStack('provenance_images');
const png = (seed: number) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: seed, g: 90, b: 160 } } }).png().toBuffer();
type View = ReturnType<typeof ProvenanceWorkspaceSchema.parse>;
interface ImageRow { id: string; status: string; failure: string | null; ready: boolean }

/** The whole path on real PostgreSQL with the runtime and worker roles: API, outbox, worker job, file scan, public read. */
test('PROV-001 generated images: labelled in the file, gated at release, public only in labelled form', { skip: stack ? false : SKIP_REASON }, async t => {
  if (!stack) return;
  const hub = await withMaintenance(stack.admin, trx => trx.insertInto('hub').values({ slug: `prov-image-${Date.now()}`, lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow());
  const previousHub = process.env.TRUSTWORK_HUB_ID;
  process.env.TRUSTWORK_HUB_ID = hub.id;
  t.after(async () => {
    if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID; else process.env.TRUSTWORK_HUB_ID = previousHub;
    await stack.close();
  });
  const petr = await stack.client('petr'), boris = await stack.client('boris'), anonymous = await stack.client();
  const owner = { kind: 'person' as const, id: stack.seed.people.petr };
  const name = (await stack.admin.query<{ display_name: string }>('SELECT display_name FROM trustwork.person WHERE id=$1', [owner.id])).rows[0]!.display_name;
  async function create(format = 'article') {
    return ok<{ publication: { id: string; revision: number } }>(await petr.post('/v1/publications', {
      owner: { kind: 'person' }, format, articleFormat: format === 'article' ? 'practice' : null, originalLanguage: 'en', licence: 'cc_by',
      draft: { title: 'Synthetic illustrated piece', body: 'Synthetic text.', language: 'en', sourceRefs: [], treatment: 'original_reporting', eventTime: null, assistantAssisted: true },
      authorship: [{ kind: 'person', id: owner.id, credit: name, assistantAssisted: true }],
    }), 201).publication;
  }
  const workspace = async (id: string, client: Client = petr) => ProvenanceWorkspaceSchema.parse(ok(await client.get(`/v1/provenance/publications/${id}`)));
  async function declare(id: string, kind: 'generated' | 'ai_assisted' = 'generated'): Promise<View> {
    const v = await workspace(id);
    ok(await petr.post('/v1/provenance/declarations', { declaration: { binding: v.binding, expectedRevision: v.record?.revision ?? 0, kind, roles: ['editorial_illustrator'], evidence: 'human_declaration', original: null, reason: 'Synthetic illustration' } }), 201);
    const next = await workspace(id);
    ok(await petr.post('/v1/provenance/consents', { provenanceId: next.record!.id, role: 'responsible_editor', credit: next.credit, channels: ['web'], noticeVersion: 'provenance.credit.v1', informedConsent: true }), 201);
    return next;
  }
  const upload = (id: string, bytes: Uint8Array, options: { mediaType?: string; classification?: string } = {}) =>
    stack.upload(petr, { owner, parent: { kind: 'publication', id }, bytes, mediaType: options.mediaType ?? 'image/png', classification: options.classification ?? 'owner_private' });
  const body = (v: View, assetId: string, over: Record<string, unknown> = {}) => ({ image: { provenanceId: v.record!.id, binding: v.binding, assetId, digitalSourceType: 'trainedAlgorithmicMedia', altText: 'Synthetic abstract illustration of wall layers', depictsRealPerson: false, documentary: false, ...over } });
  const images = async (id: string) => ok<{ items: ImageRow[] }>(await petr.get(`/v1/provenance/publications/${id}/images`)).items;
  const publish = (id: string, revision: number) => petr.post(`/v1/publications/${id}/publish`, { expectedRevision: revision, scheduledFor: null });

  const pub = await create();
  const view = await declare(pub.id);
  const source = await upload(pub.id, await png(10));

  await t.test('only someone who may work on the piece can attach a file to it', async () => {
    const start = (client: Client) => client.post('/v1/files/uploads', { owner: { kind: 'person', id: stack.seed.people.boris }, parent: { kind: 'publication', id: pub.id }, mediaType: 'image/png', bytes: 10, sha256: 'a'.repeat(64), uploadKey: uploadKey(), classification: 'owner_private' });
    expectRefusal(await start(boris), 404, 'access.not_found');
    const outsider = (await stack.admin.query('SELECT 1 FROM trustwork.evidence_artifact WHERE parent_id=$1 AND uploaded_by=$2', [pub.id, stack.seed.people.boris])).rowCount;
    assert.equal(outsider, 0);
  });

  await t.test('a generated piece without a labelled image is refused at release', async () => {
    expectRefusal(await publish(pub.id, view.publicationRevision), 422, 'validation.schema', 'provenance_image_required');
  });

  await t.test('only a first-party person with publication rights, for an exact private clean image of this piece', async () => {
    assert.equal((await anonymous.post('/v1/provenance/images', body(view, source.id))).status, 401);
    expectRefusal(await boris.post('/v1/provenance/images', body(view, source.id)), 403, 'access.forbidden');
    expectRefusal(await petr.post('/v1/provenance/images', body(view, source.id, { binding: { ...view.binding, version: 2 } })), 422, 'validation.schema', 'binding_mismatch');
    expectRefusal(await petr.post('/v1/provenance/images', body(view, source.id, { digitalSourceType: 'digitalCapture' })), 422, 'validation.schema');
    for (const attestation of [{ depictsRealPerson: true }, { documentary: true }]) expectRefusal(await petr.post('/v1/provenance/images', body(view, source.id, attestation)), 422, 'validation.schema');
    expectRefusal(await petr.post('/v1/provenance/images', body(view, source.id, { altText: '   ' })), 422, 'validation.schema');
    const other = await create();
    const foreign = await upload(other.id, await png(11));
    expectRefusal(await petr.post('/v1/provenance/images', body(view, foreign.id)), 422, 'validation.schema', 'image_binding_mismatch');
    const open = await upload(pub.id, await png(12), { classification: 'public' });
    expectRefusal(await petr.post('/v1/provenance/images', body(view, open.id)), 422, 'validation.schema', 'image_source_public');
  });

  await t.test('never where a reader expects documentation', async () => {
    const news = await create('news');
    const v = await declare(news.id);
    const asset = await upload(news.id, await png(13));
    expectRefusal(await petr.post('/v1/provenance/images', body(v, asset.id)), 422, 'validation.schema', 'image_documentary');
  });

  let imageId = '';
  await t.test('the worker labels a copy; release waits for the label and the scan', async () => {
    imageId = ok<{ imageId: string; status: string }>(await petr.post('/v1/provenance/images', body(view, source.id)), 202).imageId;
    assert.deepEqual((await images(pub.id)).map(i => [i.status, i.ready]), [['pending', false]]);
    assert.deepEqual(ok<{ items: unknown[] }>(await boris.get(`/v1/provenance/publications/${pub.id}/images`)).items, [], 'a stranger sees nothing of a draft');
    expectRefusal(await publish(pub.id, view.publicationRevision), 422, 'validation.schema', 'provenance_image_required');
    await stack.drain();
    assert.deepEqual((await images(pub.id)).map(i => [i.status, i.ready]), [['carried', true]]);
    ok(await publish(pub.id, view.publicationRevision));
  });

  await t.test('readers get the label, the alt text and bytes carrying the type; never the source', async () => {
    const current = PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${pub.id}`))).current;
    const p = current.provenance;
    assert.ok(p?.availability === 'recorded');
    assert.equal(p.kind, 'generated');
    assert.deepEqual(p.images, [{ id: imageId, digitalSourceType: 'trainedAlgorithmicMedia', altText: 'Synthetic abstract illustration of wall layers' }]);
    assert.equal(JSON.stringify(p).includes(source.id), false, 'the private source stays private');
    const response = await anonymous.get(`/v1/publications/${pub.id}/images/${imageId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.match(String(response.headers['cache-control']), /no-store/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const bytes = (await stack.app.fastify.inject({ method: 'GET', url: `/v1/publications/${pub.id}/images/${imageId}` })).rawPayload;
    assert.equal(readDigitalSourceType(bytes, 'image/png'), digitalSourceTypeUri('trainedAlgorithmicMedia'));
    assert.equal((await sharp(bytes).metadata()).width, 8);
    assert.equal((await boris.get(`/v1/files/${source.id}`)).status, 404, 'the unlabelled upload is not readable by others');
    assert.equal((await anonymous.get(`/v1/publications/${pub.id}/images/${source.id}`)).status, 404);
    const stranger = await create();
    assert.equal((await anonymous.get(`/v1/publications/${stranger.id}/images/${imageId}`)).status, 404, 'an image is bound to its publication');
  });

  await t.test('an image of a draft is not served', async () => {
    const draftPiece = await create();
    const v = await declare(draftPiece.id);
    const asset = await upload(draftPiece.id, await png(14));
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    await stack.drain();
    assert.equal((await anonymous.get(`/v1/publications/${draftPiece.id}/images/${id}`)).status, 404);
  });

  await t.test('two requests for one file give one label and one derived file', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(15));
    const outcomes = await Promise.all([petr.post('/v1/provenance/images', body(v, asset.id)), petr.post('/v1/provenance/images', body(v, asset.id))]);
    assert.deepEqual(outcomes.map(o => o.status).sort(), [202, 409]);
    await stack.drain();
    assert.equal((await images(piece.id)).length, 1);
    const files = await stack.admin.query('SELECT 1 FROM trustwork.evidence_artifact WHERE parent_id=$1 AND classification=$2', [piece.id, 'public']);
    assert.equal(files.rowCount, 1);
  });

  await t.test('an unreachable store is a retry, then the label lands once', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(16));
    const put = stack.store.put.bind(stack.store);
    stack.store.put = async () => { throw new BlobStoreUnavailableError('connection refused'); };
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    await stack.drain();
    stack.store.put = put;
    assert.deepEqual((await images(piece.id)).map(i => i.status), ['pending']);
    const job = (await stack.admin.query<{ state: string }>("SELECT state FROM trustwork.job WHERE kind=$1 AND payload->>'imageId'=$2", [PROVENANCE_IMAGE_KIND, id])).rows[0];
    assert.equal(job?.state, 'queued', 'retryable, not parked');
    await stack.admin.query('UPDATE trustwork.job SET next_at=now() WHERE kind=$1', [PROVENANCE_IMAGE_KIND]);
    await stack.drain();
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.ready]), [['carried', true]]);
  });

  await t.test('location metadata never goes public: the labelled copy is quarantined and release stays blocked', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, jpeg(exifTiff(true)), { mediaType: 'image/jpeg' });
    ok(await petr.post('/v1/provenance/images', body(v, asset.id)), 202);
    await stack.drain();
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.ready]), [['carried', false]]);
    expectRefusal(await publish(piece.id, v.publicationRevision), 422, 'validation.schema', 'provenance_image_required');
  });

  await t.test('a file that cannot be labelled is a recorded failure that blocks release until a new declaration', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic broken image')]);
    const asset = await upload(piece.id, broken);
    ok(await petr.post('/v1/provenance/images', body(v, asset.id)), 202);
    await stack.drain();
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.failure]), [['failed', 'malformed_image']]);
    expectRefusal(await publish(piece.id, v.publicationRevision), 422, 'validation.schema', 'provenance_image_required');
  });

  await t.test('a source deleted before the job runs fails honestly', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(17));
    ok(await petr.post('/v1/provenance/images', body(v, asset.id)), 202);
    ok(await petr.post(`/v1/files/${asset.id}/delete`, {}));
    await stack.drain();
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.failure]), [['failed', 'source_unavailable']]);
  });

  await t.test('a source deleted while the job runs leaves no public copy and no labelled bytes', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(18));
    const put = stack.store.put.bind(stack.store);
    stack.store.put = async (...args) => { await put(...args); ok(await petr.post(`/v1/files/${asset.id}/delete`, {})); };
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    await stack.drain();
    stack.store.put = put;
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.failure]), [['failed', 'source_unavailable']]);
    const copies = await stack.admin.query("SELECT 1 FROM trustwork.evidence_artifact WHERE parent_id=$1 AND classification='public'", [piece.id]);
    assert.equal(copies.rowCount, 0, 'nothing public was created from the withdrawn image');
    assert.deepEqual(await stack.store.list(`provenance/${id}`), [], 'the labelled bytes are gone with the source');
    const audit = await stack.admin.query<{ action: string }>("SELECT action FROM trustwork.audit_event WHERE object_kind='provenance_image' AND object_id=$1", [id]);
    assert.deepEqual(audit.rows.map(r => r.action), ['provenance.image_failed']);
    expectRefusal(await publish(piece.id, (await workspace(piece.id)).publicationRevision), 422, 'validation.schema', 'provenance_image_required');
  });

  await t.test('a retry after the store refused the clean-up still removes the labelled bytes', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(19));
    const put = stack.store.put.bind(stack.store), remove = stack.store.delete.bind(stack.store);
    stack.store.put = async (...args) => { await put(...args); ok(await petr.post(`/v1/files/${asset.id}/delete`, {})); };
    stack.store.delete = async (key: string) => {
      if (key.startsWith('provenance/')) throw new BlobStoreUnavailableError('connection refused');
      return remove(key);
    };
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    await stack.drain();
    stack.store.put = put;
    stack.store.delete = remove;
    assert.equal((await stack.store.list(`provenance/${id}`)).length, 1);
    await stack.admin.query('UPDATE trustwork.job SET next_at=now() WHERE kind=$1', [PROVENANCE_IMAGE_KIND]);
    await stack.drain();
    assert.deepEqual(await stack.store.list(`provenance/${id}`), []);
  });

  await t.test('a worker that died after storing the bytes leaves none behind when the retry finds the source gone', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(21));
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    // What the dead attempt left: the labelled bytes in the store, and the image still pending.
    await stack.store.put(`provenance/${id}`, await png(21));
    ok(await petr.post(`/v1/files/${asset.id}/delete`, {}));
    await stack.drain();
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.failure]), [['failed', 'source_unavailable']]);
    assert.deepEqual(await stack.store.list(`provenance/${id}`), []);
  });

  await t.test('a stalled attempt that finds the source gone leaves the bytes of a copy a retry already carried', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(22));
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    const key = `provenance/${id}`, labelled = await png(22);
    const read = stack.store.read.bind(stack.store);
    // While this attempt stalls before its read, a retry stores and carries the image; then the source is unreadable.
    stack.store.read = async () => {
      stack.store.read = read;
      await stack.store.put(key, labelled);
      await inTransaction(stack.env.workerPool(2), trx => provenanceWorker.imageComplete(trx, id, { key, sha256: createHash('sha256').update(labelled).digest('hex'), bytes: labelled.byteLength, credentials: null }));
      return null;
    };
    await stack.drain();
    stack.store.read = read;
    assert.deepEqual((await images(piece.id)).map(i => i.status), ['carried']);
    assert.deepEqual(await stack.store.list(key), [key], 'the live file keeps its bytes');
  });

  await t.test('a deletion in flight when the job completes is waited for, and wins', async () => {
    const piece = await create();
    const v = await declare(piece.id);
    const asset = await upload(piece.id, await png(20));
    const id = ok<{ imageId: string }>(await petr.post('/v1/provenance/images', body(v, asset.id)), 202).imageId;
    let decide!: () => void, begun!: () => void;
    const decided = new Promise<void>(resolve => { decide = resolve; }), started = new Promise<void>(resolve => { begun = resolve; });
    // The two writes of files_request_deletion, in its order, held open.
    const deletion = withMaintenance(stack.admin, async trx => {
      await sql`SELECT 1 FROM trustwork.evidence_artifact WHERE id=${asset.id}::uuid FOR UPDATE`.execute(trx);
      await sql`UPDATE trustwork.file_artifact_state SET deletion_requested_at=now(),deletion_requested_by=${owner.id}::uuid,deletion_mode='delete' WHERE artifact_id=${asset.id}::uuid`.execute(trx);
      begun();
      await decided;
    });
    await started;
    const completion = inTransaction(stack.env.workerPool(2), trx => provenanceWorker.imageComplete(trx, id, { key: `provenance/${id}`, sha256: 'a'.repeat(64), bytes: 1, credentials: null }));
    let waiting = false;
    for (let attempt = 0; attempt < 400 && !waiting; attempt++) {
      waiting = (await stack.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]!.n > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
    }
    decide();
    await deletion;
    assert.ok(waiting, 'the completion waits for the deletion, not merely races it');
    assert.equal(await completion, false);
    assert.deepEqual((await images(piece.id)).map(i => [i.status, i.failure]), [['failed', 'source_unavailable']]);
  });

  await t.test('deleting the labelled file removes the image and keeps the disclosure; retraction removes the image', async () => {
    const before = PublicPublicationSchema.parse(ok(await anonymous.get(`/v1/publications/${pub.id}`)));
    assert.equal((await anonymous.get(`/v1/publications/${pub.id}/images/${imageId}`)).status, 200);
    const derived = (await stack.admin.query<{ derived_asset_id: string }>('SELECT derived_asset_id FROM trustwork.provenance_image WHERE id=$1', [imageId])).rows[0]!.derived_asset_id;
    ok(await petr.post(`/v1/publications/${pub.id}/retract`, { expectedRevision: (await workspace(pub.id)).publicationRevision, note: 'Synthetic retraction' }));
    assert.equal((await anonymous.get(`/v1/publications/${pub.id}/images/${imageId}`)).status, 404);
    ok(await petr.post(`/v1/files/${derived}/delete`, {}));
    await stack.drain();
    assert.equal(before.current.provenance?.availability, 'recorded');
    const row = (await stack.admin.query<{ derived_asset_id: string | null; derived_sha256: string; status: string }>('SELECT derived_asset_id,derived_sha256,status FROM trustwork.provenance_image WHERE id=$1', [imageId])).rows[0]!;
    assert.equal(row.derived_asset_id, null, 'the file goes; the record of what it was stays');
    assert.equal(row.status, 'carried');
    assert.match(row.derived_sha256, /^[a-f0-9]{64}$/);
  });
});

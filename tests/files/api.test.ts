import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { expectError } from '../backend/helpers/app.js';
import { EICAR_TEST_STRING } from '../../apps/worker/src/files/scanner.js';
import { replayFileTombstones } from '../../apps/worker/src/files/handlers.js';
import { SignedUrlRejectedError } from '../../packages/data/src/files/index.js';
import { silentLogger } from '../../apps/worker/src/index.js';
import { jpeg, exifTiff, png, sha, startFilesStack, uploadKey } from './helpers.js';

const stack = await startFilesStack('files_api');

/**
 * FILE-001 acceptance through the real API on real PostgreSQL, the storage fake and the production worker registry:
 * the upload lifecycle with signed URLs, quarantine before visibility, negative authorization (another party can neither
 * read, list, download nor guess a file), expired and altered URLs, server-side size and type limits, duplicate upload
 * keys under concurrency, audited copy and move that keep owner and classification, and deletion with a tombstone that
 * survives a restore.
 */
test('FILE-001 files API', { skip: stack ? false : SKIP_REASON }, async (t) => {
  if (!stack) return;
  t.after(() => stack.close());
  const { seed, admin } = stack;
  const petr = await stack.client('petr');
  const boris = await stack.client('boris');
  const carl = await stack.client('carl');
  const anonymous = await stack.client();
  const project = { kind: 'project', id: seed.project };
  const petrParty = { kind: 'person' as const, id: seed.people.petr };
  const ownProject2 = await withMaintenance(admin, (trx) => trx.insertInto('project').values({
    owner_person_id: seed.people.petr, creator_person_id: seed.people.petr, leader_person_id: seed.people.petr, name: 'Second fixture project', status: 'active',
  }).returning('id').executeTakeFirstOrThrow());
  const carlProject = await withMaintenance(admin, (trx) => trx.insertInto('project').values({
    owner_person_id: seed.people.carl, creator_person_id: seed.people.carl, leader_person_id: seed.people.carl, name: 'Carl fixture project', status: 'active',
  }).returning('id').executeTakeFirstOrThrow());
  const rows = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
  t.afterEach(() => stack.clock.reset());

  let shared = '';
  let sharedKey = '';
  const sharedBytes = png();

  await t.test('upload lifecycle: signed PUT, completion, scan, then a signed GET', async () => {
    const body = { owner: petrParty, parent: project, mediaType: 'image/png', bytes: sharedBytes.byteLength, sha256: sha(sharedBytes), uploadKey: uploadKey() };
    const start = await petr.post('/v1/files/uploads', body);
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const result = start.body as { file: { id: string; scanState: string; classification: string; uploadedBy: string; origin: string }; upload: { method: string; url: string; headers: Record<string, string>; expiresAt: string } };
    shared = result.file.id;
    assert.equal(result.file.scanState, 'pending');
    assert.equal(result.file.classification, 'shared', 'a project file inherits the shared class');
    assert.equal(result.file.uploadedBy, seed.people.petr, 'the uploader is the session, never a request field');
    assert.equal(result.upload.method, 'PUT');
    assert.deepEqual(result.upload.headers, { 'content-length': String(sharedBytes.byteLength), 'content-type': 'image/png' });
    const ttl = (Date.parse(result.upload.expiresAt) - stack.clock.now().getTime()) / 1000;
    assert.ok(ttl > 0 && ttl <= 900, `upload URL lives at most 15 minutes (${ttl}s)`);
    assert.ok(!JSON.stringify(result.file).includes('files/u/'), 'the view never carries the storage key');

    const download = await petr.get(`/v1/files/${shared}/download`);
    expectError(download, 422, 'validation.schema');
    assert.equal((download.body as { details: { reason: string } }).details.reason, 'scan_pending');
    await stack.store.acceptPut(result.upload.url, sharedBytes, result.upload.headers, stack.clock.now());
    sharedKey = decodeURIComponent(new URL(result.upload.url).pathname.slice(1));
    await stack.drain();
    assert.equal(((await petr.get(`/v1/files/${shared}`)).body as { scanState: string }).scanState, 'pending', 'nothing is scanned before the uploader reports completion');

    const done = await petr.post(`/v1/files/${shared}/complete`, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const again = await petr.post(`/v1/files/${shared}/complete`, {});
    assert.equal(again.status, 200);
    const events = await rows("SELECT payload FROM trustwork.outbox_event WHERE type = 'file.uploaded' AND aggregate_id = $1", [shared]);
    assert.deepEqual(events.map((r) => r.payload), [{ artifactId: shared }], 'one identifiers-only event, even when completion is reported twice');
    await stack.drain();
    const file = (await petr.get(`/v1/files/${shared}`)).body as { scanState: string };
    assert.equal(file.scanState, 'clean');

    const ticket = await petr.get(`/v1/files/${shared}/download`);
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    const signed = (ticket.body as { download: { method: string; url: string; expiresAt: string } }).download;
    assert.equal(signed.method, 'GET');
    const lifetime = (Date.parse(signed.expiresAt) - stack.clock.now().getTime()) / 1000;
    assert.ok(lifetime > 0 && lifetime <= 300, `download URL lives at most 5 minutes (${lifetime}s)`);
    const fetched = await stack.store.acceptGet(signed.url, stack.clock.now());
    assert.equal(sha(fetched.body), sha(sharedBytes));
    assert.equal(fetched.contentType, 'image/png');
    assert.equal(fetched.disposition, 'inline');
    const audit = await rows("SELECT action, actor_person_id FROM trustwork.audit_event WHERE object_id = $1 ORDER BY id", [shared]);
    assert.deepEqual(audit.map((r) => r.action), ['file.upload_started', 'file.upload_completed', 'file.scan_clean']);
  });

  await t.test('expired, forged and altered signed URLs are refused', async () => {
    const ticket = (await petr.get(`/v1/files/${shared}/download`)).body as { download: { url: string } };
    stack.clock.advance(61_000);
    await assert.rejects(stack.store.acceptGet(ticket.download.url, stack.clock.now()), (e: unknown) => e instanceof SignedUrlRejectedError && e.reason === 'expired');
    stack.clock.reset();
    const forged = ticket.download.url.replace(sharedKey, `${sharedKey.slice(0, -1)}0`);
    await assert.rejects(stack.store.acceptGet(forged, stack.clock.now()), SignedUrlRejectedError, 'another key with the same signature');
    const longer = new URL(ticket.download.url);
    longer.searchParams.set('expires', String(Number(longer.searchParams.get('expires')) + 3600));
    await assert.rejects(stack.store.acceptGet(longer.toString(), stack.clock.now()), SignedUrlRejectedError, 'a lifetime extended by the client');

    const bytes = png();
    const start = (await petr.post('/v1/files/uploads', { owner: petrParty, parent: project, mediaType: 'image/png', bytes: bytes.byteLength, sha256: sha(bytes), uploadKey: uploadKey() })).body as { upload: { url: string; headers: Record<string, string> } };
    await assert.rejects(stack.store.acceptPut(start.upload.url, new Uint8Array(bytes.byteLength + 10), { ...start.upload.headers, 'content-length': String(bytes.byteLength + 10) }, stack.clock.now()), SignedUrlRejectedError, 'a bigger body than declared');
    await assert.rejects(stack.store.acceptPut(start.upload.url, bytes, { ...start.upload.headers, 'content-type': 'text/html' }, stack.clock.now()), SignedUrlRejectedError, 'another content type');
    stack.clock.advance(301_000);
    await assert.rejects(stack.store.acceptPut(start.upload.url, bytes, start.upload.headers, stack.clock.now()), (e: unknown) => e instanceof SignedUrlRejectedError && e.reason === 'expired');
  });

  await t.test('negative authorization: another party cannot read, list, download or guess a file', async () => {
    for (const path of [`/v1/files/${shared}`, `/v1/files/${shared}/download`, '/v1/files/00000000-0000-4000-8000-000000000000', '/v1/files/not-a-uuid', '/v1/files/00000000-0000-4000-8000-000000000000/download']) {
      expectError(await carl.get(path), 404, 'access.not_found');
    }
    const listed = await carl.get(`/v1/files?parentKind=project&parentId=${seed.project}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { items: [] }, 'an inaccessible parent lists like an empty one');
    expectError(await anonymous.get(`/v1/files/${shared}`), 401, 'auth.session_invalid');
    expectError(await anonymous.get(`/v1/files?parentKind=project&parentId=${seed.project}`), 401, 'auth.session_invalid');
    // The supplier participates in the project with read.shared and its member holds company.deals.manage.
    assert.equal((await boris.get(`/v1/files/${shared}`)).status, 200);
    assert.equal((await boris.get(`/v1/files/${shared}/download`)).status, 200);
    // Carl cannot attach to Petr's project, nor upload in Petr's name or for a company without company.deals.manage.
    const bytes = png();
    const declare = (owner: unknown, parent: unknown) => ({ owner, parent, mediaType: 'image/png', bytes: bytes.byteLength, sha256: sha(bytes), uploadKey: uploadKey() });
    const intoForeign = await carl.post('/v1/files/uploads', declare({ kind: 'person', id: seed.people.carl }, project));
    expectError(intoForeign, 404, 'access.not_found');
    expectError(await carl.post('/v1/files/uploads', declare(petrParty, project)), 403, 'access.forbidden');
    expectError(await carl.post('/v1/files/uploads', declare({ kind: 'company', id: seed.companies.unrelated }, { kind: 'company', id: seed.companies.unrelated })), 403, 'access.forbidden');
    expectError(await petr.post('/v1/files/uploads', declare({ kind: 'company', id: seed.companies.supplier }, project)), 403, 'access.forbidden');
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM trustwork.evidence_artifact WHERE uploaded_by = $1', [seed.people.carl]))[0]?.n), 0);
  });

  await t.test('classification: private and pending files stay with the owner; quarantine is final and explained to the owner only', async () => {
    const own = await stack.upload(petr, { owner: petrParty, parent: project, bytes: png(), classification: 'owner_private' });
    assert.equal((await petr.get(`/v1/files/${own.id}`)).status, 200);
    expectError(await boris.get(`/v1/files/${own.id}`), 404, 'access.not_found');
    const pending = await stack.upload(petr, { owner: petrParty, parent: project, bytes: png() }, { complete: false });
    expectError(await boris.get(`/v1/files/${pending.id}`), 404, 'access.not_found');
    const infected = new TextEncoder().encode(`${EICAR_TEST_STRING}\n`);
    const bad = await stack.upload(petr, { owner: petrParty, parent: project, bytes: infected, mediaType: 'text/plain' });
    const view = (await petr.get(`/v1/files/${bad.id}`)).body as { scanState: string; quarantineReason: string };
    assert.deepEqual([view.scanState, view.quarantineReason], ['quarantined', 'malware']);
    expectError(await boris.get(`/v1/files/${bad.id}`), 404, 'access.not_found');
    expectError(await petr.get(`/v1/files/${bad.id}/download`), 422, 'validation.schema');
    const listed = ((await boris.get(`/v1/files?parentKind=project&parentId=${seed.project}`)).body as { items: { id: string }[] }).items.map((f) => f.id);
    assert.ok(listed.includes(shared));
    for (const hidden of [own.id, pending.id, bad.id]) assert.ok(!listed.includes(hidden), 'the supplier lists only clean shared files');
    const ownerList = ((await petr.get(`/v1/files?parentKind=project&parentId=${seed.project}`)).body as { items: { id: string }[] }).items.map((f) => f.id);
    for (const visible of [shared, own.id, pending.id, bad.id]) assert.ok(ownerList.includes(visible), 'the owner lists all of its files');
  });

  await t.test('the stored bytes are verified: size, hash, type and location metadata of public images', async () => {
    const declared = png();
    const swapped = Buffer.from(declared);
    swapped.writeUInt8(swapped.readUInt8(swapped.length - 20) ^ 0xff, swapped.length - 20); // same length, different content
    const tampered = await stack.upload(petr, { owner: petrParty, parent: project, bytes: declared }, { body: swapped });
    assert.equal(((await petr.get(`/v1/files/${tampered.id}`)).body as { quarantineReason: string }).quarantineReason, 'hash_mismatch');
    const pdfAsPng = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
    const typed = await stack.upload(petr, { owner: petrParty, parent: project, bytes: pdfAsPng, mediaType: 'image/png' });
    assert.equal(((await petr.get(`/v1/files/${typed.id}`)).body as { quarantineReason: string }).quarantineReason, 'type_mismatch');
    const located = jpeg(exifTiff(true));
    const publicPhoto = await stack.upload(petr, { owner: petrParty, parent: project, bytes: located, mediaType: 'image/jpeg', classification: 'public' });
    assert.equal(((await petr.get(`/v1/files/${publicPhoto.id}`)).body as { quarantineReason: string }).quarantineReason, 'location_metadata');
    const privatePhoto = await stack.upload(petr, { owner: petrParty, parent: project, bytes: located, mediaType: 'image/jpeg' });
    assert.equal(((await petr.get(`/v1/files/${privatePhoto.id}`)).body as { scanState: string }).scanState, 'clean', 'parties keep originals with location');
    const missing = await stack.upload(petr, { owner: petrParty, parent: project, bytes: png() }, { complete: false });
    await stack.store.delete(missing.storageKey);
    assert.equal((await petr.post(`/v1/files/${missing.id}/complete`, {})).status, 200);
    await stack.drain();
    assert.equal(((await petr.get(`/v1/files/${missing.id}`)).body as { quarantineReason: string }).quarantineReason, 'missing_content');
  });

  await t.test('declared size and type limits are enforced by the server', async () => {
    const declare = (over: Record<string, unknown>) => ({ owner: petrParty, parent: project, mediaType: 'image/png', bytes: 100, sha256: sha('x'), uploadKey: uploadKey(), ...over });
    const big = await petr.post('/v1/files/uploads', declare({ bytes: 15 * 1024 * 1024 + 1 }));
    expectError(big, 413, 'validation.payload_too_large');
    expectError(await petr.post('/v1/files/uploads', declare({ mediaType: 'application/pdf', bytes: 50 * 1024 * 1024 + 1 })), 413, 'validation.payload_too_large');
    assert.equal((await petr.post('/v1/files/uploads', declare({ mediaType: 'application/pdf', bytes: 50 * 1024 * 1024 }))).status, 201, 'a magazine PDF at the limit is accepted');
    for (const mediaType of ['image/svg+xml', 'text/html', 'application/zip', 'application/x-msdownload', 'IMAGE/PNG']) expectError(await petr.post('/v1/files/uploads', declare({ mediaType })), 422, 'validation.schema');
    expectError(await petr.post('/v1/files/uploads', declare({ bytes: 0 })), 422, 'validation.schema');
    expectError(await petr.post('/v1/files/uploads', declare({ sha256: sha('x').toUpperCase() })), 422, 'validation.schema');
    expectError(await petr.post('/v1/files/uploads', declare({ classification: 'restricted' })), 422, 'validation.schema');
    expectError(await petr.post('/v1/files/uploads', declare({ uploadedBy: seed.people.carl })), 422, 'validation.unknown_field');
    expectError(await petr.post('/v1/files/uploads', declare({ scanState: 'clean' })), 422, 'validation.unknown_field');
    expectError(await petr.post('/v1/files/uploads', declare({ uploadKey: 'short' })), 422, 'validation.schema');
  });

  await t.test('concurrency: duplicate upload keys never create a second file', async () => {
    const bytes = png();
    const body = { owner: petrParty, parent: project, mediaType: 'image/png', bytes: bytes.byteLength, sha256: sha(bytes), uploadKey: uploadKey() };
    const sameKey = await Promise.all(Array.from({ length: 6 }, () => petr.post('/v1/files/uploads', body, { idempotencyKey: `dup-${body.uploadKey}` })));
    const ok = sameKey.filter((r) => r.status === 201);
    assert.ok(ok.length >= 1, JSON.stringify(sameKey.map((r) => [r.status, r.body])));
    for (const r of sameKey) assert.ok(r.status === 201 || (r.status === 409 && ['validation.idempotency_in_progress', 'validation.revision_conflict'].includes((r.body as { code: string }).code)), JSON.stringify(r.body));
    assert.equal(new Set(ok.map((r) => (r.body as { file: { id: string } }).file.id)).size, 1, 'every success replays the same file');
    const other = { ...body, uploadKey: uploadKey() };
    const distinctKeys = await Promise.all(Array.from({ length: 6 }, (_, i) => petr.post('/v1/files/uploads', other, { idempotencyKey: `race-${i}-${other.uploadKey}` })));
    const created = distinctKeys.filter((r) => r.status === 201);
    assert.equal(created.length, 1, JSON.stringify(distinctKeys.map((r) => [r.status, r.body])));
    for (const r of distinctKeys.filter((x) => x.status !== 201)) {
      expectError(r, 409, 'validation.revision_conflict');
      assert.equal((r.body as { details: { reason: string } }).details.reason, 'upload_key_taken');
    }
    const n = await rows("SELECT count(*)::int AS n FROM trustwork.evidence_artifact WHERE uploaded_by = $1 AND created_at > now() - interval '1 minute' AND sha256 = $2", [seed.people.petr, sha(bytes)]);
    assert.equal(Number(n[0]?.n), 2, 'one file per upload key');
    const id = (created[0]?.body as { file: { id: string } }).file.id;
    await stack.store.acceptPut((created[0]?.body as { upload: { url: string } }).upload.url, bytes, { 'content-length': String(bytes.byteLength), 'content-type': 'image/png' }, stack.clock.now());
    const completions = await Promise.all(Array.from({ length: 5 }, (_, i) => petr.post(`/v1/files/${id}/complete`, {}, { idempotencyKey: `complete-${i}-${id}` })));
    assert.ok(completions.every((r) => r.status === 200), JSON.stringify(completions.map((r) => r.body)));
    assert.equal((await rows("SELECT 1 FROM trustwork.outbox_event WHERE type = 'file.uploaded' AND aggregate_id = $1", [id])).length, 1, 'one scan intent');
  });

  await t.test('copy and move keep owner and classification, are audited and only the owner party may do them', async () => {
    const copy = await petr.post(`/v1/files/${shared}/copy`, { parent: { kind: 'project', id: ownProject2.id } });
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    const copied = copy.body as { id: string; owner: unknown; classification: string; sha256: string; scanState: string; origin: string; uploadedBy: string };
    assert.deepEqual([copied.owner, copied.classification, copied.sha256, copied.scanState, copied.origin, copied.uploadedBy], [petrParty, 'shared', sha(sharedBytes), 'pending', 'copy', seed.people.petr]);
    await stack.drain();
    const ticket = (await petr.get(`/v1/files/${copied.id}/download`)).body as { download: { url: string } };
    assert.equal(sha((await stack.store.acceptGet(ticket.download.url, stack.clock.now())).body), sha(sharedBytes), 'the worker copied the bytes and verified them');
    const copyAudit = await rows("SELECT actor_person_id, basis FROM trustwork.audit_event WHERE action = 'file.copied' AND object_id = $1", [copied.id]);
    assert.equal(copyAudit[0]?.actor_person_id, seed.people.petr);
    assert.equal(copyAudit[0]?.basis.sourceId, shared);
    assert.deepEqual(copyAudit[0]?.basis.to, { kind: 'project', id: ownProject2.id });

    expectError(await boris.post(`/v1/files/${shared}/copy`, { parent: { kind: 'project', id: ownProject2.id } }), 403, 'access.forbidden');
    expectError(await boris.post(`/v1/files/${shared}/move`, { parent: { kind: 'project', id: ownProject2.id } }), 403, 'access.forbidden');
    expectError(await carl.post(`/v1/files/${shared}/copy`, { parent: { kind: 'project', id: carlProject.id } }), 404, 'access.not_found');
    expectError(await petr.post(`/v1/files/${shared}/copy`, { parent: { kind: 'project', id: carlProject.id } }), 404, 'access.not_found');
    expectError(await petr.post(`/v1/files/${shared}/copy`, { parent: { kind: 'person', id: seed.people.petr } }), 422, 'validation.schema');
    expectError(await petr.post(`/v1/files/${shared}/copy`, { parent: { kind: 'project', id: ownProject2.id }, classification: 'public' }), 422, 'validation.unknown_field');
    expectError(await petr.post(`/v1/files/${shared}/copy`, { parent: { kind: 'project', id: ownProject2.id }, owner: { kind: 'person', id: seed.people.carl } }), 422, 'validation.unknown_field');

    const keyBefore = (await rows('SELECT storage_key FROM trustwork.evidence_artifact WHERE id = $1', [copied.id]))[0]?.storage_key;
    const move = await petr.post(`/v1/files/${copied.id}/move`, { parent: project });
    assert.equal(move.status, 201, JSON.stringify(move.body));
    const moved = move.body as { id: string; owner: unknown; classification: string; scanState: string; origin: string; parent: unknown };
    assert.deepEqual([moved.owner, moved.classification, moved.scanState, moved.origin, moved.parent], [petrParty, 'shared', 'clean', 'move', project]);
    expectError(await petr.get(`/v1/files/${copied.id}`), 404, 'access.not_found');
    assert.equal((await rows('SELECT storage_key FROM trustwork.evidence_artifact WHERE id = $1', [moved.id]))[0]?.storage_key, keyBefore, 'a move keeps the bytes in place');
    const moveAudit = await rows("SELECT basis FROM trustwork.audit_event WHERE action = 'file.moved' AND object_id = $1", [moved.id]);
    assert.equal(moveAudit[0]?.basis.sourceId, copied.id);
    assert.equal((await boris.get(`/v1/files/${moved.id}`)).status, 200, 'moved into the shared project, it follows that parent');

    await withMaintenance(admin, (trx) => trx.updateTable('evidence_artifact').set({ legal_hold: true }).where('id', '=', moved.id).execute());
    const held = await petr.post(`/v1/files/${moved.id}/move`, { parent: { kind: 'project', id: ownProject2.id } });
    expectError(held, 403, 'access.forbidden');
    expectError(await petr.post(`/v1/files/${moved.id}/delete`, {}), 403, 'access.forbidden');
  });

  await t.test('agents act only under a mandate', async () => {
    const bytes = png();
    const body = { owner: petrParty, parent: project, mediaType: 'image/png', bytes: bytes.byteLength, sha256: sha(bytes), uploadKey: uploadKey(), actor: { via: 'agent', mandateId: 'mandate-files-1' } };
    expectError(await petr.post('/v1/files/uploads', body), 403, 'access.mandate_scope');
    stack.mandateGrants.push({ personId: seed.people.petr, mandateId: 'mandate-files-1', action: 'prepare' });
    assert.equal((await petr.post('/v1/files/uploads', { ...body, uploadKey: uploadKey() })).status, 201);
    assert.ok(stack.mandates.checks.some((c) => c.action === 'prepare' && c.context?.kind === 'project' && c.context.id === seed.project));
    expectError(await petr.post(`/v1/files/${shared}/delete`, { actor: { via: 'agent', mandateId: 'mandate-files-1' } }), 403, 'access.mandate_scope');
  });

  await t.test('deletion: hidden at once, removed by the worker with a tombstone that a restore replays', async () => {
    const victim = await stack.upload(petr, { owner: petrParty, parent: project, bytes: png() });
    assert.equal((await boris.get(`/v1/files/${victim.id}`)).status, 200);
    expectError(await boris.post(`/v1/files/${victim.id}/delete`, {}), 403, 'access.forbidden');
    const removed = await petr.post(`/v1/files/${victim.id}/delete`, {});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body, { id: victim.id, deletionRequested: true });
    expectError(await petr.get(`/v1/files/${victim.id}`), 404, 'access.not_found');
    expectError(await boris.get(`/v1/files/${victim.id}/download`), 404, 'access.not_found');
    assert.ok(await stack.store.head(victim.storageKey), 'bytes stay until the worker runs');
    const snapshot = (await rows('SELECT * FROM trustwork.evidence_artifact WHERE id = $1', [victim.id]))[0];

    await stack.drain();
    assert.equal((await rows('SELECT 1 FROM trustwork.evidence_artifact WHERE id = $1', [victim.id])).length, 0);
    assert.equal(await stack.store.head(victim.storageKey), null);
    const tombstone = await stack.tombstones.get(victim.id) as { reason: string; storageKey: string };
    assert.deepEqual([tombstone.reason, tombstone.storageKey], ['deleted', victim.storageKey]);
    assert.deepEqual((await rows("SELECT action FROM trustwork.audit_event WHERE object_id = $1 AND action LIKE 'file.delet%' ORDER BY id", [victim.id])).map((r) => r.action), ['file.deletion_requested', 'file.deleted']);

    // A restore from before the deletion brings the row and the bytes back; the replay removes both again.
    await admin.query(`INSERT INTO trustwork.evidence_artifact (id, owner_person_id, owner_company_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, scan_state, uploaded_by)
      VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, 'clean', $10)`, [snapshot.id, snapshot.owner_person_id, snapshot.parent_kind, snapshot.parent_id, snapshot.classification, snapshot.storage_key, snapshot.sha256, snapshot.bytes, snapshot.media_type, snapshot.uploaded_by]);
    await stack.store.put(victim.storageKey, png());
    assert.equal((await boris.get(`/v1/files/${victim.id}`)).status, 200, 'restored without replay, the file would be served again');
    const worker = stack.env.workerPool(2);
    try {
      const report = await replayFileTombstones({ pool: worker, store: stack.store, tombstones: stack.tombstones, log: silentLogger });
      assert.ok(report.tombstones >= 1);
      assert.equal(report.rowsRemoved, 1);
      assert.deepEqual(report.invalid, []);
      const second = await replayFileTombstones({ pool: worker, store: stack.store, tombstones: stack.tombstones, log: silentLogger });
      assert.equal(second.rowsRemoved, 0, 'replay is idempotent');
    } finally {
      await worker.end();
    }
    expectError(await boris.get(`/v1/files/${victim.id}`), 404, 'access.not_found');
    assert.equal(await stack.store.head(victim.storageKey), null);
  });

  await t.test('files of a person and of a company follow their parent rules', async () => {
    const avatar = await stack.upload(petr, { owner: petrParty, parent: { kind: 'person', id: seed.people.petr }, bytes: png(), classification: 'public' });
    assert.equal((await carl.get(`/v1/files/${avatar.id}`)).status, 404, 'a private profile keeps its public picture out of reach (the person row is not visible)');
    const note = await stack.upload(petr, { owner: petrParty, parent: { kind: 'person', id: seed.people.petr }, bytes: new TextEncoder().encode('private note\n'), mediaType: 'text/plain' });
    assert.equal(((await petr.get(`/v1/files/${note.id}`)).body as { classification: string }).classification, 'owner_private');
    expectError(await petr.post('/v1/files/uploads', { owner: petrParty, parent: { kind: 'person', id: seed.people.carl }, mediaType: 'image/png', bytes: 10, sha256: sha('x'), uploadKey: uploadKey() }), 404, 'access.not_found');
    const logo = await stack.upload(boris, { owner: { kind: 'company', id: seed.companies.supplier }, parent: { kind: 'company', id: seed.companies.supplier }, bytes: png(), classification: 'public' });
    assert.equal((await petr.get(`/v1/files/${logo.id}`)).status, 200, 'a public company logo is readable by any signed-in person');
    const terms = await stack.upload(boris, { owner: { kind: 'company', id: seed.companies.supplier }, parent: { kind: 'company', id: seed.companies.supplier }, bytes: new TextEncoder().encode('terms\n'), mediaType: 'text/plain' });
    expectError(await petr.get(`/v1/files/${terms.id}`), 404, 'access.not_found');
    assert.equal((await boris.get(`/v1/files/${terms.id}`)).status, 200);
  });

  await t.test('without configured storage the routes do not exist', async () => {
    const { createApp } = await import('../../apps/api/src/app.js');
    const off = await createApp({ env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_PROVIDER_MODE: 'fake' }, pool: stack.env.apiPool, logSink: () => undefined });
    try {
      const response = await off.fastify.inject({ method: 'GET', url: `/v1/files/${shared}` });
      assert.equal(response.statusCode, 404);
    } finally {
      await off.close();
    }
  });
});

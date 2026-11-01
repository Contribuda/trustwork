import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { addLogins, signIn } from '../admin/helpers.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { PrivacyService } from '../../apps/api/src/modules/platform-admin/privacy/privacy.service.js';
import { gate, waitFor } from '../worker/helpers/worker-db.js';

test('PRV export admission: exact resolved session and current authority through HTTP consumption', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'privacy-admission-'));
  const store = new FilesystemBlobStore({ root });
  const h = await startHarness('privacy_admission', { files: { store } });
  if (!h) { await rm(root, { recursive: true, force: true }); t.skip(SKIP_REASON); return; }
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }); });
  const service = h.created.app.get(PrivacyService);
  const fixture = async () => {
    const person = (await h.db.admin.query<{ id: string }>("INSERT INTO trustwork.person(display_name) VALUES('Synthetic Export Subject') RETURNING id")).rows[0]!.id;
    const company = (await h.db.admin.query<{ id: string }>("INSERT INTO trustwork.company(display_name) VALUES('Synthetic Export Company') RETURNING id")).rows[0]!.id;
    const membership = (await h.db.admin.query<{ id: string }>(`INSERT INTO trustwork.membership(person_id,company_id,role,permissions,status,valid_from)
      VALUES($1,$2,'administrator',ARRAY['company.members.manage','company.deals.manage','company.catalogue.edit'],'active',now()) RETURNING id`, [person, company])).rows[0]!.id;
    const backup = (await h.db.admin.query<{ id: string }>("INSERT INTO trustwork.person(display_name) VALUES('Synthetic Backup Administrator') RETURNING id")).rows[0]!.id;
    await h.db.admin.query(`INSERT INTO trustwork.membership(person_id,company_id,role,permissions,status,valid_from)
      VALUES($1,$2,'administrator',ARRAY['company.members.manage'],'active',now())`, [backup, company]);
    return { people: { anna: person, petr: person }, companies: { mixed: company }, memberships: { anna: membership }, backup };
  };
  for (const mode of ['json', 'file'] as const) for (const change of ['session', 'membership', 'epoch', 'file', 'erasure'] as const) {
    for (const order of ['revocation-first', 'snapshot-first', 'delivery-first'] as const) await t.test(`${mode}: ${change}, ${order}`, async () => {
      const seed = await fixture();
      const person = seed.people.anna;
      const email = `synthetic-${randomUUID()}@example.invalid`;
      await addLogins(h, [[person, email]]);
      const client = h.client(); await signIn(client, email);
      // A second live session must never rescue a revoked originating one.
      const otherSession = h.client(); await signIn(otherSession, email);
      const sessionId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.session WHERE token_hash=$1', [createHash('sha256').update(client.sessionCookie!).digest()])).rows[0]!.id;
      const subject = { kind: 'company', id: seed.companies.mixed };
      const key = `synthetic/${randomUUID()}`; const bytes = Buffer.from('Synthetic exact-session private payload'); await store.put(key, bytes);
      const fileId = (await h.db.admin.query<{ id: string }>(`INSERT INTO trustwork.evidence_artifact
        (owner_company_id,parent_kind,parent_id,classification,storage_key,sha256,bytes,media_type,scan_state,uploaded_by)
        VALUES($1,'company',$1,'owner_private',$2,$3,$4,'text/plain','clean',$5) RETURNING id`, [subject.id, key, createHash('sha256').update(bytes).digest('hex'), bytes.length, person])).rows[0]!.id;
      const created = await client.post('/v1/privacy/exports', { subject }); assert.equal(created.status, 201);
      const exportId = (created.body as { export: { id: string } }).export.id;
      const url = `/v1/privacy/exports/${exportId}${mode === 'file' ? `/files/${fileId}` : ''}`;
      const mutate = async () => {
        if (change === 'session') { const r = await otherSession.post('/v1/me/sessions/revoke', { sessionId }, { idempotencyKey: null }); assert.equal(r.status, 204, JSON.stringify(r)); return; }
        if (change === 'membership') { const r = await otherSession.post(`/v1/companies/${subject.id}/memberships/end`, { membershipId: seed.memberships.anna, expectedRevision: 1, reason: 'Synthetic authority revocation' }); assert.equal(r.status, 200, JSON.stringify(r)); return; }
        if (change === 'file') { const r = await otherSession.post(`/v1/files/${fileId}/delete`, { actor: { via: 'person' } }); assert.equal(r.status, 200, JSON.stringify(r)); return; }
        if (change === 'erasure') return h.db.admin.query('SELECT trustwork.files_request_erasure($1,$2,$3,$4)', [fileId, `synthetic-${randomUUID()}`, person, seed.backup]);
        return h.db.admin.query('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [person]);
      };
      const entered = gate(); const release = gate();
      const readExport = privacy.export.bind(privacy);
      const attach = h.services().principals.attach.bind(h.services().principals);
      const download = service.download.bind(service); const downloadFile = service.downloadFile.bind(service);
      if (order === 'revocation-first') {
        h.services().principals.attach = async (request, reply) => {
          await attach(request, reply);
          if (request.url === url) { entered.open(); await release.promise; }
        };
      } else if (order === 'snapshot-first') {
        privacy.export = async (trx, id) => {
          const row = await readExport(trx, id);
          if (id === exportId) { entered.open(); await release.promise; }
          return row;
        };
      } else if (mode === 'file') {
        service.downloadFile = (state, id, fid, consume) => downloadFile(state, id, fid, async (file) => { entered.open(); await release.promise; await consume(file); });
      } else {
        service.download = (state, id, consume) => download(state, id, async (result) => { entered.open(); await release.promise; await consume(result); });
      }
      const response = client.get(url);
      let mutation: Promise<unknown> | undefined;
      try {
        await Promise.race([entered.promise, response.then((r) => { throw new Error(`delivery did not reach barrier: ${JSON.stringify(r)}`); })]);
        mutation = mutate();
        if (order !== 'delivery-first') await mutation;
        else await waitFor(async () => (await h.db.admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS blocked`)).rows[0].blocked, 5000, 'revocation waits for delivery locks');
      } finally {
        release.open();
        privacy.export = readExport; h.services().principals.attach = attach; service.download = download; service.downloadFile = downloadFile;
      }
      const result = await response; await mutation;
      if (order === 'delivery-first') assert.equal(result.status, 200, JSON.stringify(result.body));
      else {
        assert.ok([401, 404, 409, ...(mode === 'json' && (change === 'file' || change === 'erasure') ? [200] : [])].includes(result.status), JSON.stringify(result));
        assert.ok(!JSON.stringify(result.body).includes(bytes.toString('base64')));
        assert.ok(!JSON.stringify(result.body).includes('Synthetic exact-session private payload'));
      }
      if (change === 'session') assert.equal((await client.get(url)).status, 401);
    });
  }
  for (const expiry of ['idle', 'absolute'] as const) await t.test(`${expiry} expiry during file verification denies bytes`, async () => {
    const seed = await fixture(); const person = seed.people.petr;
    const email = `synthetic-${randomUUID()}@example.invalid`; await addLogins(h, [[person, email]]);
    const client = h.client(); await signIn(client, email);
    const key = `synthetic/${randomUUID()}`; const bytes = Buffer.from('Synthetic expiry secret'); await store.put(key, bytes);
    const fileId = (await h.db.admin.query<{ id: string }>(`INSERT INTO trustwork.evidence_artifact
      (owner_person_id,parent_kind,parent_id,classification,storage_key,sha256,bytes,media_type,scan_state,uploaded_by)
      VALUES($1,'person',$1,'owner_private',$2,$3,$4,'text/plain','clean',$1) RETURNING id`, [person, key, createHash('sha256').update(bytes).digest('hex'), bytes.length])).rows[0]!.id;
    const created = await client.post('/v1/privacy/exports', { subject: { kind: 'person', id: person } });
    const exportId = (created.body as { export: { id: string } }).export.id;
    const read = store.stream.bind(store);
    store.stream = async function* (path) { for await (const chunk of read(path)) { h.clock.advance(expiry === 'idle' ? h.created.config.session.idleMs + 1 : h.created.config.session.absoluteMs + 1); yield chunk; } };
    try { assert.equal((await client.get(`/v1/privacy/exports/${exportId}/files/${fileId}`)).status, 401); }
    finally { store.stream = read; h.clock.reset(); }
  });
});

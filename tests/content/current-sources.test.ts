import { withProvenanceFixtures } from './provenance-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { sources } from '../../packages/data/src/repositories/sources.js';
import { publications, publicContent } from '../../packages/data/src/repositories/content.js';
import { startHarness } from '../backend/helpers/app.js';
import { buildContentHttpWorld } from './http.js';
import { buildSourcesWorld, DISPLAY_ONLY } from '../sources/helpers.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { currentSourceFixture } from './current-sources.js';
import { draft, credit, source, refused } from './helpers.js';

const h = await startHarness('content_current_sources');
test('current source authority in real public API projections', { skip: h ? false : SKIP_REASON, timeout: 120_000 }, async t => {
  if (!h) return;
  const world = await buildContentHttpWorld(h);
  t.after(async () => { await world.close(); await h.close(); });
  const sw = await buildSourcesWorld(h.db.admin, h.pool, world.w), w = world.w, p = sw.people;
  const get = async (path: string) => { const r = await world.anonymous.get(path); assert.match(String(r.headers['cache-control']), /no-store/); return r; };
  const detail = (id: string) => get(`/v1/publications/${id}`);
  const pin = (id: string) => get(`/v1/publications/${id}/versions/1`);
  const issue = (number: number) => get(`/v1/magazine/issues/${number}?edition=1`);
  const deny = async (f: Awaited<ReturnType<typeof currentSourceFixture>>) => {
    assert.equal((await detail(f.pub.id)).status, 404); assert.equal((await pin(f.pub.id)).status, 404);
    const feed = await get('/v1/publications'); assert.ok(!JSON.stringify(feed.body).includes(f.marker));
    const r = await issue(f.issue.number); assert.equal(r.status, 200);
    const body = r.body as { items: { withheld: boolean; publicationVersion: number }[]; digest: { value: string } };
    assert.equal(body.items[0]!.withheld, true); assert.equal(body.items[0]!.publicationVersion, 1);
    assert.ok(!JSON.stringify(body).includes(f.marker));
    assert.equal(body.digest.value, (await withMaintenance(h.db.admin, trx => trx.selectFrom('issue_revision').select('digest').where('issue_id', '=', f.issue.id).executeTakeFirstOrThrow())).digest);
  };
  await t.test('allowed read first, uncommitted revocation, then committed revocation: no stale response', async () => {
    const f = await currentSourceFixture(sw, h.db.admin, 11);
    const first = await detail(f.pub.id); assert.equal(first.status, 200); assert.match(JSON.stringify(first.body), /licensed 11 body/);
    assert.equal((await pin(f.pub.id)).status, 200); assert.equal((await issue(11)).status, 200);
    for (const field of ['full_text', 'licence_snapshot', 'takedownContact', 'agreementRef', 'import_batch_id', 'decided_by']) assert.ok(!JSON.stringify(first.body).includes(field));
    let changed!: () => void, commit!: () => void;
    const ready = new Promise<void>(resolve => { changed = resolve; });
    const release = new Promise<void>(resolve => { commit = resolve; });
    const revoke = sw.cmd(p.stewardA, async (trx, ctx) => {
      await sources.setTerms(trx, ctx, f.registered.id, f.registered.revision, { ...f.input, allowedUses: DISPLAY_ONLY });
      changed(); await release;
    });
    try { await ready; assert.equal((await detail(f.pub.id)).status, 200, 'read serializes before revocation commit'); }
    finally { commit(); await revoke; }
    await deny(f);
  });
  await t.test('revocation first: an already open READ COMMITTED transaction and later API reads see current rights', async () => {
    const f = await currentSourceFixture(sw, h.db.admin, 12);
    await withMaintenance(h.db.admin, async trx => {
      assert.ok(await publicContent.publication(trx, w.hubId, f.pub.id));
      await sw.cmd(p.stewardA, (other, ctx) => sources.setTerms(other, ctx, f.registered.id, f.registered.revision, { ...f.input, allowedUses: DISPLAY_ONLY }));
      assert.equal(await publicContent.publication(trx, w.hubId, f.pub.id), null);
    });
    await deny(f);
  });
  await t.test('headline/link treatment never returns the stored full body, even when the old snapshot permits it', async () => {
    const f = await currentSourceFixture(sw, h.db.admin, 13, { treatment: 'headline_link' });
    await sw.cmd(p.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, f.registered.id, f.registered.revision, { ...f.input, allowedUses: DISPLAY_ONLY }));
    for (const response of [await detail(f.pub.id), await pin(f.pub.id)]) {
      assert.equal(response.status, 200); assert.ok(!JSON.stringify(response.body).includes(`${f.marker} body`));
    }
    assert.equal((await detail(f.pub.id)).body && ((await detail(f.pub.id)).body as { current: { body: null } }).current.body, null);
  });
  await t.test('ambiguous linkage fails closed, regardless of both sources granting rights', async () => {
    await refused(currentSourceFixture(sw, h.db.admin, 14, { ambiguous: true }), '23514', 'content.provenance_source_unavailable');
  });
  await t.test('URL equality and another publication never authorize an unlinked reference; own reporting needs no source row', async () => {
    const f = await currentSourceFixture(sw, h.db.admin, 15);
    const copy = await w.act.as(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: false,
      draft: draft({ sourceRefs: [source({ uri: f.external.url })], treatment: 'summary' }), authorship: credit(p.writer) }));
    await refused(w.act.as(p.writer, trx => withProvenanceFixtures(w).publish(trx, null, copy.id, copy.revision, null)), '23514', 'content.provenance_source_unavailable');
    assert.equal((await detail(copy.id)).status, 404);
    const own = await w.act.as(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: false,
      draft: draft(), authorship: credit(p.writer) }));
    await w.act.as(p.writer, trx => withProvenanceFixtures(w).publish(trx, null, own.id, own.revision, null));
    assert.equal((await detail(own.id)).status, 200);
    assert.equal(await withMaintenance(h.db.admin, trx => publicContent.publication(trx, w.otherHubId, f.pub.id)), null);
  });
  await t.test('a mismatched source/batch or hub on an imported link cannot authorize a publication', async () => {
    const other = await currentSourceFixture(sw, h.db.admin, 18);
    for (const mismatch of ['source', 'hub'] as const) {
      const f = await currentSourceFixture(sw, h.db.admin, mismatch === 'source' ? 16 : 17);
      const uri = `${f.external.url}-mismatch`;
      const copy = await w.act.as(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: false,
        draft: draft({ sourceRefs: [source({ uri })], treatment: 'summary' }), authorship: credit(p.writer) }));
      await refused(w.act.as(p.writer, trx => withProvenanceFixtures(w).publish(trx, null, copy.id, copy.revision, null)), '23514', 'content.provenance_source_unavailable');
      // Deliberately inconsistent imported fixture, not a production mutation path. Immutable real rows stay intact.
      await withMaintenance(h.db.admin, trx => sql`INSERT INTO trustwork.source_item
        (hub_id, source_id, import_batch_id, external_id, url, title, content_digest, licence_snapshot, status, decided_by, decided_at, publication_id)
        SELECT ${mismatch === 'hub' ? w.otherHubId : w.hubId}::uuid,
          ${mismatch === 'source' ? other.registered.id : f.registered.id}::uuid, import_batch_id, external_id || '-mismatch', ${uri}, title,
          content_digest, licence_snapshot, 'drafted', decided_by, decided_at, ${copy.id}::uuid
        FROM trustwork.source_item WHERE id = ${f.imported.id}::uuid`.execute(trx));
      await refused(w.act.as(p.writer, trx => withProvenanceFixtures(w).publish(trx, null, copy.id, copy.revision, null)), '23514', 'content.provenance_source_unavailable');
      assert.equal((await detail(copy.id)).status, 404); assert.equal((await pin(copy.id)).status, 404);
    }
  });
  await t.test('a correction to original reporting does not revive the revoked pinned source version', async () => {
    const f = await currentSourceFixture(sw, h.db.admin, 19);
    const ctx = await w.act.elevate(p.chief);
    await w.act.as(p.chief, trx => withProvenanceFixtures(w).correct(trx, ctx, f.pub.id, f.pub.revision, draft(), 'Synthetic replacement with own reporting', 'correction'));
    await sw.cmd(p.stewardA, (trx, c) => sources.setTerms(trx, c, f.registered.id, f.registered.revision, { ...f.input, allowedUses: DISPLAY_ONLY }));
    assert.equal((await detail(f.pub.id)).status, 200); assert.equal((await pin(f.pub.id)).status, 404);
    const pinned = await issue(19); assert.equal((pinned.body as { items: { withheld: boolean }[] }).items[0]!.withheld, true);
    assert.ok(!JSON.stringify(pinned.body).includes(f.marker));
  });
});

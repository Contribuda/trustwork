import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { outbox, withMaintenance, type Transaction } from '@trustwork/data';
import { HandlerRegistry, Worker } from '@trustwork/worker';
import { createApp } from '../../apps/api/src/app.js';
import { registerContent, CONTENT_RENDER_KIND } from '../../apps/worker/src/content/index.js';
import { renderLocalPdf } from '../../apps/worker/src/content/render.js';
import { publications, issues, contentModeration, type PublicationRow } from '../../packages/data/src/repositories/content.js';
import { moderation } from '../../packages/data/src/repositories/admin.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { buildSourcesWorld, sourceInput, item as sourceItem, DISPLAY_ONLY } from '../sources/helpers.js';
import { sources, importBatches, sourceItems } from '../../packages/data/src/repositories/sources.js';
import { consentPublicProfiles } from '../data/helpers/seed.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { consentToMention, credit, draft, refused, source } from './helpers.js';

const env = await provisionWorkerDatabase('content_render');
test('CNT-003 durable local PDF, restricted delivery and publication races', { skip: env ? false : SKIP_REASON, timeout: 120_000 }, async t => {
  if (!env) return;
  t.after(() => env.close());
  const sw = await buildSourcesWorld(env.db.admin, env.apiPool), w = sw.content, p = sw.people;
  await withMaintenance(env.db.admin, async trx => { await consentPublicProfiles(trx, [p.coauthor]); await trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', '=', p.coauthor).execute(); });
  const pool = env.workerPool(3);
  const ctxA = await w.act.elevate(p.editorA), ctxC = await w.act.elevate(p.chief);
  const act = w.act.as;
  let issueNumber = 0;
  async function publish(over: Parameters<typeof draft>[0] = {}) {
    let row = await act(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'ru', licence: 'cc_by', requiresReview: false,
      draft: draft({ language: 'ru', title: 'Synthetic: reader and PDF evidence', body: 'Synthetic content. <script>alert(1)</script>\n\nA local, version-bound artifact.', ...over }), authorship: [...credit(p.writer), ...credit(p.coauthor, 'Synthetic Coauthor')] }));
    await consentToMention(env!.db.admin, p.coauthor, row.id);
    row = await act(p.writer, trx => publications.publish(trx, null, row.id, row.revision, null));
    return row;
  }
  async function issueFor(pub: PublicationRow) {
    const version = (await act(p.chief, trx => publications.versions(trx, pub.id))).find(v => v.version === pub.current_version)!;
    let issue = await act(p.editorA, trx => issues.create(trx, ctxA, { hubId: w.hubId, number: ++issueNumber, date: '2026-11-01', theme: 'Synthetic: construction practice', coverAssetId: null, editorLetterId: null }));
    issue = await act(p.editorA, trx => issues.curate(trx, ctxA, issue.id, issue.revision, { items: [{ position: 1, section: 'practice', publicationId: pub.id, publicationVersionId: version.id }], theme: null, coverAssetId: null, editorLetterId: null }));
    issue = await act(p.editorA, trx => issues.transition(trx, ctxA, issue.id, issue.revision, 'curated'));
    issue = await act(p.editorA, trx => issues.transition(trx, ctxA, issue.id, issue.revision, 'review'));
    return act(p.chief, trx => issues.release(trx, ctxC, issue.id, issue.revision));
  }
  const request = (id: string, edition = 1) => act(p.editorA, async trx => {
    const render = await issues.requestRender(trx, ctxA, id, edition, 'pdf');
    await outbox.append(trx, { aggregate_kind: 'issue', aggregate_id: id, revision: render.revision, type: 'issue.render_requested', payload: { issueId: id, renderId: render.id, edition, format: 'pdf' } });
    return render;
  });
  const prepare = async (trx: Transaction, id: string) => (await sql<{ snapshot: unknown }>`SELECT trustwork.content_render_prepare(${id}::uuid) AS snapshot`.execute(trx)).rows[0]!.snapshot;
  const finish = async (trx: Transaction, id: string, snapshot: unknown) => (await sql<{ ok: boolean }>`SELECT trustwork.content_render_finish(${id}::uuid, ${JSON.stringify(snapshot)}::jsonb, ${Buffer.from('%PDF-synthetic-test')}::bytea) AS ok`.execute(trx)).rows[0]!.ok;
  const pdf = (number: number, hub = w.hubId) => tx(env.apiPool, trx => sql<{ bytes: Buffer; sha256: string; edition: number }>`SELECT * FROM trustwork.content_public_pdf(${hub}::uuid, ${number}, NULL::integer)`.execute(trx)).then(r => r.rows[0]);
  let primary = await publish();
  primary = await act(p.writer, trx => publications.correct(trx, null, primary.id, primary.revision, draft({ language: 'ru', body: 'Synthetic corrected content. <script>alert(1)</script>\n\nThe worker keeps user content inert.', assistantAssisted: true }), 'Synthetic: corrected insulation thickness.', 'correction'));
  const issue = await issueFor(primary);
  let generated: Buffer | undefined;

  await t.test('real outbox, worker fencing and duplicate requests produce one durable edition artifact', async () => {
    const a = await request(issue.id), b = await request(issue.id);
    let calls = 0;
    t.diagnostic(process.env.CNT003_EVIDENCE_DIR ? 'Installed Chromium PDF integration enabled' : 'Local PDF adapter fake; set CNT003_EVIDENCE_DIR for installed Chromium integration');
    const registry = new HandlerRegistry();
    registerContent(registry, async (snapshot, signal) => { calls++; generated = process.env.CNT003_EVIDENCE_DIR ? await renderLocalPdf(snapshot, signal) : Buffer.from('%PDF-synthetic-transaction-test'); return generated; });
    const worker = new Worker({ pool, registry, config: { workerId: 'cnt003-render', concurrency: 1, relayBatchSize: 500, retryJitter: 0 }, tasks: () => [], log: () => {} });
    t.after(() => worker.stop());
    await worker.runOnce({ rethrow: true }); await worker.idle();
    await worker.runOnce({ rethrow: true }); await worker.idle();
    const failures = await env.db.admin.query('SELECT state, last_error FROM trustwork.job WHERE kind = $1', [CONTENT_RENDER_KIND]);
    assert.equal(calls, 1, JSON.stringify(failures.rows));
    const jobs = await env.db.admin.query('SELECT state FROM trustwork.job WHERE kind = $1', [CONTENT_RENDER_KIND]);
    assert.equal(jobs.rows.length, 2); assert.ok(jobs.rows.every(r => r.state === 'succeeded'));
    assert.equal(await tx(pool, trx => prepare(trx, a.id)), null);
    assert.equal(await tx(pool, trx => prepare(trx, b.id)), null);
    const blob = await pdf(issue.number);
    assert.ok(blob && generated); assert.deepEqual(blob.bytes, generated);
    assert.equal(blob.sha256, createHash('sha256').update(generated).digest('hex'));
    const n = await env.db.admin.query('SELECT count(*)::int AS n FROM trustwork.content_render_blob'); assert.equal(n.rows[0].n, 1);
    if (process.env.CNT003_EVIDENCE_DIR) {
      await mkdir(process.env.CNT003_EVIDENCE_DIR, { recursive: true });
      await writeFile(`${process.env.CNT003_EVIDENCE_DIR}/issue-ru.pdf`, generated);
    }
  });
  await t.test('public download and HEAD use the guarded bytes; cross-hub and unknown editions are absent', async () => {
    const previous = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = w.hubId;
    const app = await createApp({ pool: env.apiPool, env: { PUBLIC_ORIGIN: 'http://127.0.0.1:3458', MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_HUB_ID: w.hubId }, logSink: () => {} });
    try {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await app.fastify.inject({ method, url: `/v1/magazine/issues/${issue.number}/pdf` });
        assert.equal(r.statusCode, 200, r.body); assert.match(String(r.headers['content-type']), /application\/pdf/);
        assert.match(String(r.headers['cache-control']), /no-store/);
        if (method === 'GET') assert.deepEqual(r.rawPayload, generated);
      }
      assert.equal((await app.fastify.inject({ method: 'GET', url: `/v1/magazine/issues/${issue.number}/pdf?edition=99` })).statusCode, 404);
      assert.equal(await pdf(issue.number, w.otherHubId), undefined);
    } finally { await app.close(); if (previous === undefined) delete process.env.TRUSTWORK_HUB_ID; else process.env.TRUSTWORK_HUB_ID = previous; }
  });
  await t.test('runtime roles cannot read raw blobs, manufacture bytes or invoke private snapshots', async () => {
    await refused(tx(env.apiPool, trx => prepare(trx, issue.id)), '42501');
    await refused(tx(env.apiPool, trx => finish(trx, issue.id, {})), '42501');
    for (const rolePool of [pool, env.apiPool]) {
      await refused(tx(rolePool, trx => sql`SELECT * FROM trustwork.content_render_blob`.execute(trx)), '42501');
      await refused(tx(rolePool, trx => sql`SELECT trustwork.content_render_snapshot(${issue.id}::uuid)`.execute(trx)), '42501');
    }
    await refused(act(p.writer, trx => issues.requestRender(trx, ctxA, issue.id, 1, 'pdf')), '42501');
  });
  await t.test('rollback after bytes were inserted leaves no artifact and a retry completes once', async () => {
    const i = await issueFor(await publish()), r = await request(i.id);
    await assert.rejects(tx(pool, async trx => { const snap = await prepare(trx, r.id); assert.ok(snap); assert.equal(await finish(trx, r.id, snap), true); throw new Error('synthetic crash before commit'); }), /synthetic crash/);
    assert.equal(await pdf(i.number), undefined);
    assert.equal(await tx(pool, async trx => finish(trx, r.id, await prepare(trx, r.id))), true);
    assert.ok(await pdf(i.number));
  });
  await t.test('correction during rendering prevents completion and invalidates an already delivered edition', async () => {
    const r = await request((await issueFor(primary)).id);
    await tx(pool, async trx => {
      const snap = await prepare(trx, r.id); assert.ok(snap);
      await act(p.writer, t2 => publications.correct(t2, null, primary.id, primary.revision, draft({ language: 'ru', body: 'Synthetic corrected body.' }), 'Synthetic correction notice', 'correction'));
      assert.equal(await finish(trx, r.id, snap), false);
    });
    assert.equal(await pdf(issue.number), undefined);
  });
  await t.test('a moderation removal between preparation and completion releases no bytes', async () => {
    const pub = await publish(), i = await issueFor(pub), r = await request(i.id);
    const ctxM = await w.act.elevate(p.moderator);
    await tx(pool, async trx => {
      const snap = await prepare(trx, r.id); assert.ok(snap);
      await act(p.moderator, async t2 => {
        const c = await moderation.openCase(t2, ctxM, { hubId: w.hubId, targetKind: 'publication', targetId: pub.id, subject: { kind: 'person', id: p.writer }, clauseCodes: ['community.misinformation'], emergencyHold: true });
        await contentModeration.apply(t2, c.id, 'hold');
      });
      assert.equal(await finish(trx, r.id, snap), false);
    });
    assert.equal(await pdf(i.number), undefined);
  });
  await t.test('retraction after completion and missing source authority both deny delivery', async () => {
    let pub = await publish(); const i = await issueFor(pub), r = await request(i.id);
    await tx(pool, async trx => finish(trx, r.id, await prepare(trx, r.id)));
    assert.ok(await pdf(i.number));
    pub = await act(p.writer, trx => publications.retract(trx, null, pub.id, pub.revision, 'Synthetic retraction'));
    assert.equal(pub.status, 'retracted'); assert.equal(await pdf(i.number), undefined);
    const sourced = await publish({ sourceRefs: [source()], treatment: 'summary' }), si = await issueFor(sourced), sr = await request(si.id);
    assert.equal(await tx(pool, trx => prepare(trx, sr.id)), null, 'a snapshot URL without linked source authority is insufficient');
  });
  await t.test('local renderer failure records a terminal outcome without leaking diagnostic content', async () => {
    const i = await issueFor(await publish()), r = await request(i.id);
    const registry = new HandlerRegistry(); registerContent(registry, async () => { throw new Error('synthetic sensitive diagnostic'); });
    const handler = registry.jobHandler(CONTENT_RENDER_KIND)!; assert.equal(handler.mode, 'transactional');
    if (handler.mode !== 'transactional') throw new Error('transactional handler required');
    await tx(pool, trx => handler.run({ trx, payload: { renderId: r.id }, signal: new AbortController().signal,
      job: {} as never, attemptId: 'synthetic:1', effectKey: 'synthetic', enqueue: async () => { throw new Error('unexpected enqueue'); } }));
    const result = await env!.db.admin.query('SELECT status, failure_reason FROM trustwork.render_artifact WHERE id = $1', [r.id]);
    assert.deepEqual(result.rows[0], { status: 'failed', failure_reason: 'local_renderer_failed' }); assert.equal(await pdf(i.number), undefined);
  });
  await t.test('concurrent render requests serialize on the immutable issue revision', async () => {
    const i = await issueFor(await publish());
    const a = await request(i.id), b = await request(i.id);
    const completed = await Promise.all([a, b].map(r => tx(pool, async trx => {
      const snap = await prepare(trx, r.id); return snap ? finish(trx, r.id, snap) : false;
    })));
    assert.deepEqual(completed.sort(), [false, true]);
    const count = await env.db.admin.query('SELECT count(*)::int AS n FROM trustwork.content_render_blob b JOIN trustwork.issue_revision r ON r.id = b.issue_revision_id WHERE r.issue_id = $1', [i.id]);
    assert.equal(count.rows[0].n, 1);
  });
  await t.test('current source licence revocation denies existing bytes and an in-flight completion', async () => {
    const input = sourceInput(p.stewardA);
    let registered = await sw.cmd(p.stewardA, (trx, ctx) => sources.register(trx, ctx, w.hubId, input));
    registered = await sw.cmd(p.stewardB, (trx, ctx) => sources.setStatus(trx, ctx, registered.id, registered.revision, 'active'));
    const external = sourceItem('cnt003');
    const batch = await sw.cmd(p.stewardA, (trx, ctx) => importBatches.stage(trx, ctx, registered.id, { items: [external], fields: [], links: [] }));
    await sw.cmd(p.stewardB, (trx, ctx) => importBatches.decide(trx, ctx, batch.id, batch.revision, 'activate'));
    const imported = await withMaintenance(env!.db.admin, trx => trx.selectFrom('source_item').selectAll().where('source_id', '=', registered.id).executeTakeFirstOrThrow());
    let pub = await act(p.editorA, trx => publications.create(trx, ctxA, { hubId: w.hubId, owner: { kind: 'editorial' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: true,
      draft: draft({ sourceRefs: [source({ uri: external.url })], treatment: 'summary' }), authorship: [{ kind: 'editorial', credit: 'Synthetic Editorial Office', assistantAssisted: false }] }));
    await act(p.editorA, trx => sourceItems.decide(trx, ctxA, imported.id, imported.revision, 'draft', pub.id));
    pub = await act(p.editorA, trx => publications.transition(trx, ctxA, pub.id, pub.revision, 'in_review'));
    pub = await act(p.chief, trx => publications.publish(trx, ctxC, pub.id, pub.revision, null));
    const i = await issueFor(pub), r = await request(i.id);
    await tx(pool, async trx => { const snap = await prepare(trx, r.id); assert.ok(snap); assert.equal(await finish(trx, r.id, snap), true); });
    assert.ok(await pdf(i.number));
    const next = await issueFor(pub), nextRender = await request(next.id);
    await tx(pool, async trx => {
      const snap = await prepare(trx, nextRender.id); assert.ok(snap);
      await sw.cmd(p.stewardA, (t2, ctx) => sources.setTerms(t2, ctx, registered.id, registered.revision, { ...input, allowedUses: DISPLAY_ONLY }));
      assert.equal(await finish(trx, nextRender.id, snap), false);
    });
    assert.equal(await pdf(i.number), undefined); assert.equal(await pdf(next.number), undefined);
  });
  await t.test('consent revocation invalidates the public projection of a stored artifact', async () => {
    const pub = await publish(), i = await issueFor(pub), r = await request(i.id);
    await tx(pool, async trx => finish(trx, r.id, await prepare(trx, r.id)));
    assert.ok(await pdf(i.number));
    await withMaintenance(env.db.admin, trx => sql`UPDATE trustwork.person SET profile_visibility = 'private' WHERE id = ${p.coauthor}::uuid`.execute(trx));
    assert.equal(await pdf(i.number), undefined);
  });
});

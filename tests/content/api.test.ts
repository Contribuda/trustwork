import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicationSchema, PublicationVersionSchema, IssueSchema } from '@trustwork/contracts';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { consoleCommand, buildContentHttpWorld, expectRefusal, ok, type ContentHttpWorld } from './http.js';
import { source } from './helpers.js';
import type { ManagePublicationView, PublicPublication } from '../../apps/api/src/modules/content/schemas.js';

/**
 * CNT-001 through the HTTP API (real database, runtime role, CSRF, idempotency, elevated staff sessions): people and
 * companies publish under their own names, credited co-authors are not editors, the editorial office publishes only
 * after a second editor's review, corrections are visible new versions, a moderation hold takes an item out of every
 * public projection, and the weekly issue is released frozen and corrected as a new edition. Negative authorization
 * for anonymous callers, outsiders, unelevated staff and staff without the permission; racing writers.
 */
const h = await startHarness('content_api');
const FORBIDDEN_KEYS = ['views', 'viewCount', 'readers', 'readership', 'reads', 'subscribers', 'subscriberCount', 'price', 'paywall', 'freeIssues', 'trial', 'sponsored', 'rank', 'score', 'popularity', 'traffic'];
function noTractionOrPaywall(r: Response): void {
  const json = JSON.stringify(r.body);
  for (const key of FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached a public response`);
}
const draft = (over: Record<string, unknown> = {}) => ({
  title: 'Synthetic: drainage behind retaining walls', body: 'Synthetic body for the API suite.', language: 'en', sourceRefs: [], treatment: 'original_reporting', eventTime: null, assistantAssisted: false, ...over,
});
const staffAct = { reason: 'Synthetic editorial action' };

test('content API: publications, corrections, moderation and curated issues', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const world: ContentHttpWorld = await buildContentHttpWorld(h).catch(async (error: unknown) => { await h.close(); throw error; });
  t.after(async () => { await world.close(); await h.close(); });
  const { c, anonymous, w } = world;
  const p = w.people;
  const create = (client: Client, body: Record<string, unknown>, key?: string) => client.post('/v1/publications', body, key ? { idempotencyKey: key } : {});
  const personalBody = (author: string, over: Record<string, unknown> = {}) => ({
    owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', originalLanguage: 'en', licence: 'cc_by', draft: draft(),
    authorship: [{ kind: 'person', id: author, credit: 'Synthetic Writer', assistantAssisted: false }], ...over,
  });

  await t.test('anonymous callers read public projections only', async () => {
    expectRefusal(await anonymous.post('/v1/publications', personalBody(p.writer), { idempotencyKey: null }), 401, 'auth.session_invalid');
    const feed = ok<{ items: unknown[]; next: null }>(await anonymous.get('/v1/publications'));
    assert.deepEqual(feed, { items: [], next: null });
    expectRefusal(await anonymous.get('/v1/me/publications'), 401, 'auth.session_invalid');
    expectRefusal(await anonymous.get('/v1/admin/content/issues'), 401, 'auth.session_invalid');
  });

  let view: ManagePublicationView;
  await t.test('a person writes a draft: private, idempotent, with credits separate from editing rights', async () => {
    expectRefusal(await create(c.writer, personalBody(p.writer, { viewCount: 0 })), 422, 'validation.unknown_field');
    expectRefusal(await create(c.writer, personalBody(p.writer, { owner: { kind: 'editorial' } })), 403, 'access.forbidden', 'elevation');
    const body = personalBody(p.writer, { authorship: [{ kind: 'person', id: p.writer, credit: 'Synthetic Writer', assistantAssisted: false }, { kind: 'person', id: p.coauthor, credit: 'Synthetic Co-author', assistantAssisted: false }] });
    view = ok<ManagePublicationView>(await create(c.writer, body, 'cnt-create-1'), 201);
    assert.equal(view.myRight, 'owner');
    assert.equal(PublicationSchema.safeParse(view.publication).success, true, 'the frozen Publication contract');
    assert.deepEqual(ok(await create(c.writer, body, 'cnt-create-1'), 201), view, 'a retry replays the result');
    expectRefusal(await create(c.writer, { ...body, licence: 'all_rights' }, 'cnt-create-1'), 409, 'validation.idempotency_conflict');
    expectRefusal(await c.outsider.get(`/v1/publications/${view.publication.id}/manage`), 404, 'access.not_found');
    expectRefusal(await anonymous.get(`/v1/publications/${view.publication.id}`), 404, 'access.not_found');
    // The credited co-author cannot edit until the owner grants a right.
    const save = (client: Client, title: string) => client.post(`/v1/publications/${view.publication.id}/draft`, { expectedRevision: view.publication.revision, draft: draft({ title }), authorship: null });
    expectRefusal(await save(c.coauthor, 'Hijack'), 403, 'access.forbidden', 'not_authorised');
    expectRefusal(await c.coauthor.post(`/v1/publications/${view.publication.id}/editors`, { personId: p.coauthor, rights: 'publish' }), 403, 'access.forbidden', 'not_authorised');
    view = ok(await c.writer.post(`/v1/publications/${view.publication.id}/editors`, { personId: p.coauthor, rights: 'edit' }));
    assert.deepEqual(view.publication.editors, [p.coauthor]);
    view = ok(await save(c.coauthor, 'Synthetic: drainage behind retaining walls, revised'));
    assert.equal(view.draft?.title, 'Synthetic: drainage behind retaining walls, revised');
    expectRefusal(await c.coauthor.post(`/v1/publications/${view.publication.id}/publish`, { expectedRevision: view.publication.revision, scheduledFor: null }), 403, 'access.forbidden', 'not_authorised');
    assert.equal(view.publication.authorship.length, 2, 'editing never adds a credit');
  });

  let pub: PublicPublication;
  await t.test('publishing: one of two racing publishers wins; the public projection is identical for everyone', async () => {
    const id = view.publication.id;
    await c.writer.post(`/v1/publications/${id}/editors`, { personId: p.member, rights: 'publish' });
    view = ok(await c.writer.get(`/v1/publications/${id}/manage`));
    const racers = await Promise.all([c.writer, c.member].map((client) => client.post(`/v1/publications/${id}/publish`, { expectedRevision: view.publication.revision, scheduledFor: null })));
    assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409]);
    view = ok(await c.writer.get(`/v1/publications/${id}/manage`));
    assert.equal(view.publication.status, 'published');
    assert.equal(PublicationVersionSchema.safeParse(view.versions[0]?.contract).success, true, 'the frozen PublicationVersion contract');
    const asAnon = await anonymous.get(`/v1/publications/${id}`);
    pub = ok<PublicPublication>(asAnon);
    noTractionOrPaywall(asAnon);
    assert.deepEqual(ok(await c.outsider.get(`/v1/publications/${id}`)), pub, 'signed-in readers see the same projection');
    assert.equal(pub.current.contentDigest, view.versions[0]?.contract.contentDigest.value);
    const feed = await anonymous.get('/v1/publications?format=article');
    noTractionOrPaywall(feed);
    assert.deepEqual((feed.body as { items: { id: string }[] }).items.map((i) => i.id), [id]);
    expectRefusal(await c.writer.post(`/v1/publications/${id}/draft`, { expectedRevision: view.publication.revision, draft: draft(), authorship: null }), 409, 'validation.revision_conflict', 'use_correction');
  });

  await t.test('corrections are visible new versions; the first text stays readable', async () => {
    const id = view.publication.id;
    expectRefusal(await c.writer.post(`/v1/publications/${id}/corrections`, { expectedRevision: view.publication.revision, draft: draft(), note: '', reason: 'x' }), 422, 'validation.schema');
    view = ok(await c.writer.post(`/v1/publications/${id}/corrections`, { expectedRevision: view.publication.revision, draft: draft({ body: 'Corrected synthetic body.' }), note: 'The pipe diameter was wrong in version 1.', reason: 'reader report' }), 201);
    assert.equal(view.publication.status, 'corrected');
    assert.equal(view.corrections[0]?.subject.kind, 'publication');
    pub = ok(await anonymous.get(`/v1/publications/${id}`));
    assert.equal(pub.current.correctionNote, 'The pipe diameter was wrong in version 1.');
    assert.deepEqual(pub.versions.map((v) => v.version), [1, 2]);
    assert.equal((ok(await anonymous.get(`/v1/publications/${id}/versions/1`)) as { body: string }).body, 'Synthetic body for the API suite.');
  });

  await t.test('news needs sources and the event time; licences block what they forbid', async () => {
    const news = (over: Record<string, unknown>) => create(c.writer, personalBody(p.writer, { format: 'news', articleFormat: null, licence: 'all_rights', draft: draft({ treatment: 'summary', eventTime: '2026-10-28T08:00:00.000Z', ...over }) }));
    expectRefusal(await news({ sourceRefs: [{ ...source(), allowedUses: undefined }] }), 422, 'validation.schema');
    for (const [over, reason] of [
      [{ sourceRefs: [] }, 'news_needs_source'],
      [{ sourceRefs: [source({}, { displaySummary: false })] }, 'licence_forbids_summary'],
      [{ sourceRefs: [source({}, { sendToModelProviders: false })], assistantAssisted: true }, 'licence_forbids_model_use'],
    ] as const) {
      const made = ok<ManagePublicationView>(await news(over), 201);
      expectRefusal(await c.writer.post(`/v1/publications/${made.publication.id}/publish`, { expectedRevision: made.publication.revision, scheduledFor: null }), 422, 'validation.schema', reason);
    }
    const good = ok<ManagePublicationView>(await news({ sourceRefs: [source()] }), 201);
    const published = ok<ManagePublicationView>(await c.writer.post(`/v1/publications/${good.publication.id}/publish`, { expectedRevision: good.publication.revision, scheduledFor: null }));
    expectRefusal(await anonymous.get(`/v1/publications/${published.publication.id}`), 404, 'access.not_found');
    const own = ok<ManagePublicationView>(await news({ treatment: 'original_reporting', sourceRefs: [source({ kind: 'own_reporting' })] }), 201);
    await c.writer.post(`/v1/publications/${own.publication.id}/publish`, { expectedRevision: own.publication.revision, scheduledFor: null });
    const shown = ok<PublicPublication>(await anonymous.get(`/v1/publications/${own.publication.id}`));
    assert.deepEqual(shown.current.sourceRefs.map((s) => [s.name, s.kind]), [['Synthetic Standards Bulletin', 'own_reporting']]);
    assert.equal(shown.current.eventTime, '2026-10-28T08:00:00.000Z');
    assert.ok(shown.current.publishedAt > shown.current.eventTime!);
  });

  let piece: ManagePublicationView;
  await t.test('editorial office: elevated staff, a second editor approves, the editor-in-chief retracts', async () => {
    const editorial = { owner: { kind: 'editorial' }, format: 'magazine_piece', articleFormat: 'analysis', originalLanguage: 'en', licence: 'all_rights', draft: draft({ title: 'Synthetic: the autumn lumber market' }),
      authorship: [{ kind: 'editorial', credit: 'Synthetic editorial office', assistantAssisted: false }], staff: staffAct };
    expectRefusal(await create(c.editorA, editorial), 403, 'access.forbidden', 'elevation');
    expectRefusal(await create(c.writer, editorial), 403, 'access.forbidden', 'staff');
    await world.elevate('editorA', 'editorB', 'chief', 'moderator', 'owner');
    piece = ok(await create(c.editorA, editorial), 201);
    assert.equal(piece.requiresReview, true);
    const id = piece.publication.id;
    expectRefusal(await c.editorA.post(`/v1/publications/${id}/publish`, { expectedRevision: piece.publication.revision, scheduledFor: null, staff: staffAct }), 409, 'validation.revision_conflict', 'review_required');
    piece = ok(await c.editorA.post(`/v1/publications/${id}/submit`, { expectedRevision: piece.publication.revision, staff: staffAct }));
    expectRefusal(await c.editorA.post(`/v1/publications/${id}/publish`, { expectedRevision: piece.publication.revision, scheduledFor: null, staff: staffAct }), 403, 'access.forbidden', 'self_review');
    expectRefusal(await c.editorB.post(`/v1/publications/${id}/publish`, { expectedRevision: piece.publication.revision, scheduledFor: null }), 403, 'access.forbidden', 'elevation');
    piece = ok(await c.editorB.post(`/v1/publications/${id}/publish`, { expectedRevision: piece.publication.revision, scheduledFor: null, staff: staffAct }));
    assert.equal(piece.publication.status, 'published');
    assert.equal(piece.myRight, 'staff');
    const board = ok<{ items: { id: string }[] }>(await c.editorA.get('/v1/admin/content/publications?status=published'));
    assert.ok(board.items.some((i) => i.id === id));
    expectRefusal(await c.writer.get('/v1/admin/content/publications'), 403, 'access.forbidden', 'staff');
  });

  await t.test('a moderation hold removes the public projection until the case is decided', async () => {
    const id = view.publication.id;
    const opened = await consoleCommand(c.moderator, '/v1/admin/moderation/cases', { hubId: w.hubId, targetKind: 'publication', targetId: id, subject: { kind: 'person', id: p.writer }, clauseCodes: ['community.misinformation'], emergencyHold: true });
    const caseId = (ok<{ case: { id: string } }>(opened, 201)).case.id;
    expectRefusal(await anonymous.get(`/v1/publications/${id}`), 404, 'access.not_found');
    assert.equal((ok<{ items: { id: string }[] }>(await anonymous.get('/v1/publications'))).items.some((i) => i.id === id), false);
    assert.equal((ok<ManagePublicationView>(await c.writer.get(`/v1/publications/${id}/manage`))).moderation, 'held', 'the owner sees why');
    ok(await consoleCommand(c.moderator, `/v1/admin/moderation/cases/${caseId}/decide`, { decision: 'no_action' }));
    ok(await anonymous.get(`/v1/publications/${id}`));
  });

  await t.test('the weekly issue: curated, released frozen, corrected as a new edition, rendered', async () => {
    expectRefusal(await consoleCommand(c.writer, '/v1/admin/content/issues', { number: 1, date: '2026-11-02', theme: null, coverAssetId: null, editorLetterPublicationId: null }), 403, 'access.forbidden', 'staff');
    expectRefusal(await consoleCommand(c.moderator, '/v1/admin/content/issues', { number: 1, date: '2026-11-02', theme: null, coverAssetId: null, editorLetterPublicationId: null }), 403, 'access.forbidden', 'staff_permission_missing');
    type Issue = { issue: { id: string; revision: number; status: string; currentEdition: number | null }; revisions: { edition: number; status: string; items: unknown[] }[] };
    let issue = ok<Issue>(await consoleCommand(c.editorA, '/v1/admin/content/issues', { number: 1, date: '2026-11-02', theme: 'Synthetic: walls and water', coverAssetId: null, editorLetterPublicationId: null }), 201);
    const I = `/v1/admin/content/issues/${issue.issue.id}`;
    issue = ok(await consoleCommand(c.editorA, `${I}/curate`, { expectedRevision: issue.issue.revision, theme: null, coverAssetId: null, editorLetterPublicationId: null,
      items: [{ position: 1, section: 'analysis', publicationId: piece.publication.id, publicationVersion: 1 }, { position: 2, section: 'practice', publicationId: view.publication.id, publicationVersion: 1 }] }));
    issue = ok(await consoleCommand(c.editorA, `${I}/status`, { expectedRevision: issue.issue.revision, status: 'curated' }));
    issue = ok(await consoleCommand(c.editorA, `${I}/status`, { expectedRevision: issue.issue.revision, status: 'review' }));
    expectRefusal(await anonymous.get('/v1/magazine/issues/1'), 404, 'access.not_found');
    expectRefusal(await consoleCommand(c.editorA, `${I}/release`, { expectedRevision: issue.issue.revision }), 403, 'access.forbidden', 'staff_permission_missing');
    issue = ok(await consoleCommand(c.chief, `${I}/release`, { expectedRevision: issue.issue.revision }));
    assert.equal(issue.issue.status, 'released');
    let shown = await anonymous.get('/v1/magazine/issues/1');
    noTractionOrPaywall(shown);
    let body = ok<{ issue: unknown; items: { corrected: boolean; publicationVersion: number }[] }>(shown);
    assert.equal(IssueSchema.safeParse(body.issue).success, true, 'the frozen Issue contract');
    assert.equal(body.items[1]?.corrected, true, 'readers see that the practice article was corrected since');
    expectRefusal(await consoleCommand(c.editorA, `${I}/curate`, { expectedRevision: issue.issue.revision, items: [], theme: null, coverAssetId: null, editorLetterPublicationId: null }), 409, 'validation.revision_conflict', 'issue_frozen');
    issue = ok(await consoleCommand(c.editorA, `${I}/corrections`, { expectedRevision: issue.issue.revision, note: 'Edition 2 carries the corrected practice article.' }), 201);
    issue = ok(await consoleCommand(c.chief, `${I}/release`, { expectedRevision: issue.issue.revision }));
    assert.equal(issue.issue.status, 'corrected');
    body = ok(await anonymous.get('/v1/magazine/issues/1'));
    assert.equal(body.items[1]?.publicationVersion, 2);
    body = ok(await anonymous.get('/v1/magazine/issues/1?edition=1'));
    assert.equal(body.items[1]?.publicationVersion, 1, 'the archive keeps edition 1');
    const archive = ok<{ issues: { number: number; currentEdition: number }[] }>(await anonymous.get('/v1/magazine/issues?year=2026'));
    assert.deepEqual(archive.issues.map((i) => [i.number, i.currentEdition]), [[1, 2]]);
    issue = ok(await consoleCommand(c.editorA, `${I}/renders`, { edition: 2, format: 'pdf' }), 201);
    const renderId = (issue.revisions.at(-1) as unknown as { renders: { id: string }[] }).renders[0]!.id;
    ok(await consoleCommand(c.editorA, `/v1/admin/content/renders/${renderId}/result`, { outcome: { status: 'rendered', artifactId: null, sha256: 'd'.repeat(64), rendererVersion: 'synthetic-renderer 0.1' } }));
    shown = await anonymous.get('/v1/magazine/issues/1');
    assert.deepEqual((shown.body as { issue: { renderArtifacts: unknown[] } }).issue.renderArtifacts, [{ format: 'pdf', hash: 'd'.repeat(64), sourceEdition: 2 }]);
  });

  await t.test('walls, digests and comments', async () => {
    const id = view.publication.id;
    const wall = ok<{ items: { publicationId: string; corrected: boolean }[] }>(await c.writer.post('/v1/walls', { wall: { kind: 'person' }, publicationId: id, publicationVersion: 1, pinned: true }), 201);
    assert.equal(wall.items[0]?.corrected, true);
    assert.deepEqual(ok(await anonymous.get(`/v1/walls/person/${p.writer}`)), wall);
    expectRefusal(await c.employee.post('/v1/walls', { wall: { kind: 'company', id: w.company }, publicationId: id, publicationVersion: null, pinned: false }), 403, 'access.forbidden', 'not_authorised');
    const digest = ok<{ digest: { id: string; revision: number }; items: { display: string }[] }>(await consoleCommand(c.editorA, '/v1/admin/content/digests', { title: 'Synthetic: November', period: '2026-11', publicationIds: [id] }), 201);
    assert.deepEqual(digest.items.map((i) => i.display), ['full']);
    ok(await consoleCommand(c.chief, `/v1/admin/content/digests/${digest.digest.id}/release`, { expectedRevision: digest.digest.revision }));
    noTractionOrPaywall(await anonymous.get(`/v1/magazine/digests/${digest.digest.id}`));
    expectRefusal(await c.reader.post(`/v1/publications/${id}/comments`, { parentId: null, body: 'Synthetic question' }), 403, 'access.forbidden', 'comments_disabled');
    process.env.TRUSTWORK_CONTENT_COMMENTS = 'on';
    try {
      ok(await c.reader.post(`/v1/publications/${id}/comments`, { parentId: null, body: 'Synthetic question' }), 201);
      expectRefusal(await anonymous.post(`/v1/publications/${id}/comments`, { parentId: null, body: 'x' }, { idempotencyKey: null }), 401, 'auth.session_invalid');
    } finally {
      delete process.env.TRUSTWORK_CONTENT_COMMENTS;
    }
    assert.equal((ok<{ items: unknown[] }>(await anonymous.get(`/v1/publications/${id}/comments`))).items.length, 1);
  });

  await t.test('retraction by the editor-in-chief keeps the record and withholds the body', async () => {
    const id = piece.publication.id;
    expectRefusal(await c.editorA.post(`/v1/publications/${id}/retract`, { expectedRevision: piece.publication.revision, note: 'x', staff: staffAct }), 403, 'access.forbidden', 'staff_permission_missing');
    piece = ok(await c.chief.post(`/v1/publications/${id}/retract`, { expectedRevision: piece.publication.revision, note: 'Synthetic: unverified figures.', staff: staffAct }));
    const shown = ok<PublicPublication>(await anonymous.get(`/v1/publications/${id}`));
    assert.equal(shown.status, 'retracted');
    assert.equal(shown.current.body, null);
    assert.equal(shown.retraction?.note, 'Synthetic: unverified figures.');
  });

  await t.test('company publications need company.publish', async () => {
    const companyBody = { owner: { kind: 'company', id: w.company }, format: 'company_post', articleFormat: null, originalLanguage: 'en', licence: 'all_rights', draft: draft({ title: 'Synthetic: our new yard' }),
      authorship: [{ kind: 'company', id: w.company, credit: 'Synthetic Builders LLC', assistantAssisted: false }] };
    expectRefusal(await create(c.employee, companyBody), 403, 'access.forbidden', 'not_authorised');
    const made = ok<ManagePublicationView>(await create(c.member, companyBody), 201);
    assert.deepEqual(made.owner, { kind: 'company', id: w.company });
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { computeDigest } from '@trustwork/contracts';
import { bindTransaction, withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { moderation, appeals } from '../../packages/data/src/repositories/admin.js';
import {
  comments, contentModeration, contentWorker, digests, issues, publicContent, publications, walls, type ContentStaffContext, type PublicationRow,
} from '../../packages/data/src/repositories/content.js';
import { provisionTestDatabase, SKIP_REASON, sqlState } from '../data/helpers/postgres.js';
import { buildContentWorld, consentToMention, credit, draft, newsDraft, refused, source, type ContentWorld } from './helpers.js';

/**
 * CNT-001 on real PostgreSQL under the runtime role: publication lifecycle, author versus editor rights, immutable
 * versions and corrections, sourcing and licence blockers, editorial four eyes with audited staff commands, moderation
 * holds removing the public projection, numbered issues with frozen editions and correction editions, walls, digests,
 * scheduling and concurrency. Every person and company is synthetic.
 */
const db = await provisionTestDatabase('content_db');
type Pub = Record<string, unknown> & { current: Record<string, unknown> | null; versions: unknown[]; corrections: unknown[]; entityLinks: unknown[]; retraction: unknown };
const FORBIDDEN_PUBLIC_KEYS = ['views', 'viewCount', 'readers', 'readership', 'reads', 'subscribers', 'price', 'paywall', 'trial', 'sponsored', 'rank', 'score', 'budget'];

test('content persistence under the restricted runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const w: ContentWorld = await buildContentWorld(db.admin, db.app);
  const p = w.people;
  const as = <T>(person: string, fn: (trx: Transaction) => Promise<T>) => w.act.as(person, fn);
  const staff = (person: string): Promise<ContentStaffContext> => w.act.elevate(person);
  const anon = <T>(fn: (trx: Transaction) => Promise<T>) => withAnon(fn);
  async function withAnon<T>(fn: (trx: Transaction) => Promise<T>): Promise<T> {
    const client = await db!.app.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(bindTransaction(client));
      await client.query('COMMIT');
      return out;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  const publicOf = (id: string) => anon((trx) => publicContent.publication(trx, w.hubId, id)) as Promise<Pub | null>;
  const personal = (person: string, over: Parameters<typeof draft>[0] = {}, format = 'personal_post') =>
    as(person, (trx) => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format, articleFormat: null, language: 'en', licence: 'all_rights', requiresReview: false, draft: draft(over), authorship: credit(person) }));
  const noForbiddenKeys = (value: unknown) => {
    const json = JSON.stringify(value);
    for (const key of FORBIDDEN_PUBLIC_KEYS) assert.ok(!json.includes(`"${key}"`), `${key} reached a public projection`);
  };

  await t.test('the runtime role writes nothing directly and sees only its working set', async () => {
    const created = await personal(p.writer);
    await refused(as(p.writer, (trx) => sql`UPDATE trustwork.publication SET status = 'published' WHERE id = ${created.id}::uuid`.execute(trx)), '42501');
    await refused(as(p.writer, (trx) => sql`INSERT INTO trustwork.correction (hub_id, subject_kind, publication_id, from_version, to_version, reason, corrected_by)
      VALUES (${w.hubId}::uuid, 'publication', ${created.id}::uuid, 1, 2, 'x', ${p.writer}::uuid)`.execute(trx)), '42501');
    await refused(as(p.writer, (trx) => sql`DELETE FROM trustwork.publication_version WHERE publication_id = ${created.id}::uuid`.execute(trx)), '42501');
    assert.equal((await as(p.writer, (trx) => publications.get(trx, created.id)))?.id, created.id, 'the owner sees the draft');
    assert.equal(await as(p.outsider, (trx) => publications.get(trx, created.id)), undefined, 'an outsider does not');
    assert.equal(await as(p.coauthor, (trx) => publications.versions(trx, created.id)).then((v) => v.length), 0, 'nor does someone without a right');
    assert.equal(await publicOf(created.id), null, 'drafts have no public projection');
    const anonymous = await db.app.query('SELECT count(*)::int AS n FROM trustwork.publication');
    assert.equal(anonymous.rows[0].n, 0, 'without a principal nothing is visible');
  });

  let post: PublicationRow;
  await t.test('authorship credit and editing rights are separate', async () => {
    post = await as(p.writer, (trx) => publications.create(trx, null, {
      hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: false, draft: draft({ title: 'Synthetic: insulating a crawl space' }),
      authorship: [...credit(p.writer), { kind: 'person', id: p.coauthor, credit: 'Synthetic Co-author', assistantAssisted: false }],
    }));
    // Credited, but no right to edit.
    await refused(as(p.coauthor, (trx) => publications.saveDraft(trx, null, post.id, post.revision, draft({ title: 'Hijacked' }), null)), '42501', 'content.not_authorised');
    await refused(as(p.writer, (trx) => publications.grantEditor(trx, post.id, p.writer, 'edit')), '42501', 'content.self_grant');
    await refused(as(p.coauthor, (trx) => publications.grantEditor(trx, post.id, p.coauthor, 'publish')), '42501', 'content.not_authorised');
    await as(p.writer, (trx) => publications.grantEditor(trx, post.id, p.coauthor, 'edit'));
    post = await as(p.coauthor, (trx) => publications.saveDraft(trx, null, post.id, (post as PublicationRow).revision, draft({ title: 'Synthetic: insulating a crawl space, revised' }), null));
    await refused(as(p.coauthor, (trx) => publications.publish(trx, null, post.id, post.revision, null)), '42501', 'content.not_authorised');
    // Editing never adds a credit.
    assert.deepEqual((await as(p.writer, (trx) => publications.authorship(trx, post.id))).map((a) => a.author_person_id), [p.writer, p.coauthor]);
    await as(p.writer, (trx) => publications.grantEditor(trx, post.id, p.reader, 'publish'));
    assert.deepEqual((await as(p.writer, (trx) => publications.authorship(trx, post.id))).map((a) => a.author_person_id), [p.writer, p.coauthor], 'an editor is not credited');
    // The editor gives the right back; afterwards they see nothing.
    await as(p.reader, (trx) => publications.revokeEditor(trx, post.id, p.reader));
    assert.equal(await as(p.reader, (trx) => publications.get(trx, post.id)), undefined);
  });

  await t.test('publishing freezes the version and binds its digest; later changes are corrections', async () => {
    post = await as(p.writer, (trx) => publications.publish(trx, null, post.id, post.revision, null));
    assert.equal(post.status, 'published');
    const [v1] = await as(p.writer, (trx) => publications.versions(trx, post.id));
    assert.ok(v1 && v1.status === 'published' && v1.content_digest);
    const expected = computeDigest({ title: v1.title, body: v1.body, language: v1.language, sourceRefs: [], eventTime: null, correctionOf: null, correctionNote: null });
    assert.equal(v1.content_digest, expected.value, 'the database binds the same trustwork-digest-1 the application computes');
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('publication_version').set({ title: 'Silently edited' }).where('id', '=', v1.id).execute()), '23000', 'commercial.version_frozen');
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('publication_version').set({ status: 'draft' }).where('id', '=', v1.id).execute()), '23000', 'commercial.version_frozen');
    await refused(withMaintenance(db.admin, (trx) => trx.deleteFrom('publication_version').where('id', '=', v1.id).execute()), '23000', 'audit.append_only');
    await refused(as(p.writer, (trx) => publications.saveDraft(trx, null, post.id, post.revision, draft(), null)), '23514', 'content.use_correction');
    await refused(withMaintenance(db.admin, (trx) => trx.insertInto('publication_authorship').values({ publication_id: post.id, position: 9, author_kind: 'person', author_person_id: p.reader, credit: 'Late credit' }).execute()),
      '23000', 'content.authorship_frozen');
    const pub = await publicOf(post.id);
    assert.equal(pub?.status, 'published');
    assert.equal((pub?.current as { body: string }).body, 'Synthetic body text for tests.');
    assert.deepEqual((pub?.authorship as { id: string | null; credit: string }[]).map((a) => [a.id, a.credit]), [[p.writer, 'Synthetic Writer']],
      'a co-author credit is withheld without current consent');
    noForbiddenKeys(pub);
  });

  await t.test('a correction is a new version with a visible note; the previous text stays readable', async () => {
    await refused(as(p.writer, (trx) => publications.correct(trx, null, post.id, post.revision, draft({ body: 'Fixed' }), '', 'reason')), '22023', 'content.correction_note_required');
    await refused(as(p.coauthor, (trx) => publications.correct(trx, null, post.id, post.revision, draft({ body: 'Fixed' }), 'note', 'reason')), '42501', 'content.not_authorised');
    post = await as(p.writer, (trx) => publications.correct(trx, null, post.id, post.revision, draft({ title: 'Synthetic: insulating a crawl space, revised', body: 'Corrected body.' }),
      'The first version gave the wrong vapour barrier thickness.', 'reader report'));
    assert.equal(post.status, 'corrected');
    assert.equal(post.current_version, 2);
    const pub = await publicOf(post.id) as Pub;
    assert.equal((pub.current as { correctionOf: number }).correctionOf, 1);
    assert.equal((pub.current as { correctionNote: string }).correctionNote, 'The first version gave the wrong vapour barrier thickness.');
    assert.equal(pub.versions.length, 2);
    assert.equal(pub.corrections.length, 1);
    const old = await anon((trx) => publicContent.version(trx, w.hubId, post.id, 1)) as { body: string };
    assert.equal(old.body, 'Synthetic body text for tests.', 'version 1 is still readable');
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('correction').set({ reason: 'rewritten' }).where('publication_id', '=', post.id).execute()), '23000', 'audit.append_only');
  });

  await t.test('news names its sources and times; licences decide what may be published', async () => {
    const news = (over: Parameters<typeof newsDraft>[0]) => as(p.writer, (trx) => publications.create(trx, null, {
      hubId: w.hubId, owner: { kind: 'person' }, format: 'news', articleFormat: null, language: 'en', licence: 'all_rights', requiresReview: false, draft: newsDraft(over), authorship: credit(p.writer),
    }));
    const tryPublish = async (row: PublicationRow) => as(p.writer, (trx) => publications.publish(trx, null, row.id, row.revision, null));
    await refused(tryPublish(await news({ sourceRefs: [] })), '23514', 'content.news_needs_source');
    await refused(tryPublish(await news({ eventTime: null })), '23514', 'content.news_needs_event_time');
    await refused(tryPublish(await news({ sourceRefs: [source({ license: null })] })), '23514', 'content.source_licence_missing');
    await refused(tryPublish(await news({ sourceRefs: [source({}, { displayHeadlineAndLink: false })] })), '23514', 'content.licence_forbids_display');
    await refused(tryPublish(await news({ sourceRefs: [source({}, { displaySummary: false })] })), '23514', 'content.licence_forbids_summary');
    await refused(tryPublish(await news({ treatment: 'rewrite', sourceRefs: [source({}, { rewriteWithAttribution: false })] })), '23514', 'content.licence_forbids_rewrite');
    await refused(tryPublish(await news({ assistantAssisted: true, sourceRefs: [source({}, { sendToModelProviders: false })] })), '23514', 'content.licence_forbids_model_use');
    // Own reporting needs no third-party licence; a headline-and-link treatment of a display-only source is fine.
    const own = await tryPublish(await news({ treatment: 'original_reporting', sourceRefs: [{ uri: 'https://example.invalid/site-visit', name: 'Own reporting', kind: 'own_reporting', sourceTime: null, observedAt: '2026-10-29T10:00:00.000Z', license: null }] }));
    assert.equal(own.status, 'published');
    const display = await tryPublish(await news({ treatment: 'headline_link', sourceRefs: [source({}, { displaySummary: false, storeFullText: false, sendToModelProviders: false })] }));
    assert.equal(await publicOf(display.id), null, 'unlinked external snapshots do not grant public display');
    const pub = await publicOf(own.id) as Pub;
    const current = pub.current as { eventTime: string; publishedAt: string; sourceRefs: { name: string; kind: string }[]; contentDigest: string };
    assert.equal(current.eventTime, '2026-10-28T08:00:00.000Z', 'event time and publication time are separate');
    assert.ok(current.publishedAt && current.publishedAt !== current.eventTime);
    assert.equal(current.sourceRefs[0]?.name, 'Own reporting');
    const v = (await as(p.writer, (trx) => publications.versions(trx, own.id)))[0]!;
    const refs = (v.source_refs as Array<Record<string, unknown>>).map((s) => ({ uri: s.uri, sourceTime: s.sourceTime, observedAt: s.observedAt, license: s.license }));
    assert.equal(current.contentDigest, computeDigest({ title: v.title, body: v.body, language: 'en', sourceRefs: refs, eventTime: '2026-10-28T08:00:00.000Z', correctionOf: null, correctionNote: null }).value);
  });

  let piece: PublicationRow;
  await t.test('editorial publications: elevated staff, review by a second editor, audited', async () => {
    const create = (person: string, c: ContentStaffContext | null) => as(person, (trx) => publications.create(trx, c, {
      hubId: w.hubId, owner: { kind: 'editorial' }, format: 'magazine_piece', articleFormat: 'analysis', language: 'en', licence: 'all_rights', requiresReview: false,
      draft: draft({ title: 'Synthetic: lumber prices this autumn' }), authorship: [{ kind: 'editorial', credit: 'Synthetic editorial office', assistantAssisted: false }],
    }));
    await refused(create(p.editorA, null), '42501', 'admin.elevation_required');
    await refused(create(p.writer, await staff(p.writer)), '42501', 'admin.forbidden');
    await refused(as(p.writer, (trx) => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'magazine_piece', articleFormat: null, language: 'en', licence: 'all_rights', requiresReview: false, draft: draft(), authorship: credit(p.writer) })), '23514');
    const ctxA = await staff(p.editorA);
    piece = await create(p.editorA, ctxA);
    assert.equal(piece.requires_review, true, 'editorial publications always need review');
    await refused(as(p.editorA, (trx) => publications.publish(trx, ctxA, piece.id, piece.revision, null)), '23514', 'content.review_required');
    piece = await as(p.editorA, (trx) => publications.transition(trx, ctxA, piece.id, piece.revision, 'in_review'));
    await refused(as(p.editorA, (trx) => publications.publish(trx, ctxA, piece.id, piece.revision, null)), '42501', 'content.self_review');
    const ctxB = await staff(p.editorB);
    piece = await as(p.editorB, (trx) => publications.publish(trx, ctxB, piece.id, piece.revision, null));
    assert.equal(piece.status, 'published');
    const audit = await db.admin.query<{ action: string; actor_person_id: string }>(`SELECT action, actor_person_id FROM trustwork.admin_audit_event WHERE object_id = $1 ORDER BY sequence`, [piece.id]);
    assert.deepEqual(audit.rows.map((r) => r.action), ['publication.create', 'publication.submitted', 'publication.published']);
    assert.equal(audit.rows[2]?.actor_person_id, p.editorB);
    // Retraction belongs to the editor-in-chief.
    await refused(as(p.editorB, (trx) => publications.retract(trx, ctxB, piece.id, piece.revision, 'Withdrawn')), '42501', 'admin.forbidden');
    await refused(as(p.writer, (trx) => publications.retract(trx, null, piece.id, piece.revision, 'Withdrawn')), '42501', 'admin.elevation_required');
  });

  await t.test('company publications are written by members holding company.publish', async () => {
    const create = (person: string) => as(person, (trx) => publications.create(trx, null, {
      hubId: w.hubId, owner: { kind: 'company', id: w.company }, format: 'company_post', articleFormat: null, language: 'en', licence: 'all_rights', requiresReview: false, draft: draft({ title: 'Synthetic: our new yard' }),
      authorship: [{ kind: 'company', id: w.company, credit: 'Synthetic Builders LLC', assistantAssisted: false }],
    }));
    await refused(create(p.employee), '42501', 'content.not_authorised');
    await refused(create(p.writer), '42501', 'content.not_authorised');
    const row = await create(p.member);
    const published = await as(p.member, (trx) => publications.publish(trx, null, row.id, row.revision, null));
    assert.equal(published.owner_company_id, w.company);
    assert.equal(await as(p.employee, (trx) => publications.get(trx, row.id)), undefined, 'membership without company.publish gives no working access');
  });

  await t.test('a moderation hold removes the public projection; decisions keep or restore it', async () => {
    const victim = await personal(p.writer, { title: 'Synthetic: disputed claim' });
    const live = await as(p.writer, (trx) => publications.publish(trx, null, victim.id, victim.revision, null));
    assert.ok(await publicOf(live.id));
    const ctxM = await staff(p.moderator);
    const held = await as(p.moderator, async (trx) => {
      const c = await moderation.openCase(trx, ctxM, { hubId: w.hubId, targetKind: 'publication', targetId: live.id, subject: { kind: 'person', id: p.writer }, clauseCodes: ['community.misinformation'], emergencyHold: true });
      assert.equal(await contentModeration.apply(trx, c.id, 'hold'), 'applied');
      return c;
    });
    assert.equal(await publicOf(live.id), null, 'held: no public projection');
    assert.equal(((await anon((trx) => publicContent.feed(trx, w.hubId, { format: null, topic: null, before: null, beforeId: null, limit: 100 }))) as { id: string }[]).some((x) => x.id === live.id), false, 'not in the feed');
    // Nobody but staff applies effects, and the case must support the effect.
    await refused(as(p.writer, (trx) => contentModeration.apply(trx, held.id, 'restore')), '42501', 'content.not_authorised');
    await refused(as(p.moderator, (trx) => contentModeration.apply(trx, held.id, 'remove')), '23514', 'content.moderation_mismatch');
    // Decided without removal: the hold no longer hides the publication.
    await as(p.moderator, (trx) => moderation.decide(trx, ctxM, held.id, 'no_action'));
    assert.ok(await publicOf(live.id), 'a no-action decision lifts the hold');
    // A removal hides it again; an overturning appeal restores it.
    const removal = await as(p.moderator, async (trx) => {
      const c = await moderation.openCase(trx, ctxM, { hubId: w.hubId, targetKind: 'publication', targetId: live.id, subject: { kind: 'person', id: p.writer }, clauseCodes: ['community.misinformation'] });
      const decided = await moderation.decide(trx, ctxM, c.id, 'content_removed');
      await contentModeration.apply(trx, decided.id, 'remove');
      return decided;
    });
    assert.equal(await publicOf(live.id), null);
    await refused(as(p.moderator, (trx) => contentModeration.apply(trx, removal.id, 'restore')), '23514', 'content.moderation_mismatch');
    const appeal = await as(p.writer, (trx) => appeals.file(trx, 'moderation_case', removal.id, 'Synthetic appeal'));
    const ctxO = await staff(p.owner);
    await as(p.owner, async (trx) => {
      await appeals.decide(trx, ctxO, appeal.id, 'overturned');
      assert.equal(await contentModeration.apply(trx, removal.id, 'restore'), 'applied');
    });
    assert.ok(await publicOf(live.id), 'restored');
    // Unknown targets are a no-op for this module.
    const other = await as(p.moderator, (trx) => moderation.openCase(trx, ctxM, { hubId: w.hubId, targetKind: 'publication', targetId: p.reader, clauseCodes: ['community.spam'], emergencyHold: true }));
    assert.equal(await as(p.moderator, (trx) => contentModeration.apply(trx, other.id, 'hold')), 'unknown_target');
  });

  await t.test('person links need the person\'s consent; company links are public', async () => {
    post = await as(p.writer, (trx) => publications.setLinks(trx, null, post.id, post.revision, ['materials'], [
      { kind: 'person', id: p.mentioned, relation: 'interviewee' }, { kind: 'company', id: w.company, relation: 'contractor' },
    ]));
    await refused(as(p.writer, (trx) => publications.setLinks(trx, null, post.id, post.revision, ['no.such.topic'], null)), '23514', 'content.unknown_topic');
    await refused(as(p.reader, (trx) => publications.setLinks(trx, null, post.id, post.revision, [], null)), '42501', 'content.not_authorised');
    let pub = await publicOf(post.id) as Pub & { topics: string[] };
    assert.deepEqual(pub.topics, ['materials']);
    assert.deepEqual(pub.entityLinks, [{ party: { kind: 'company', id: w.company }, relation: 'contractor' }], 'no consent, no person link');
    await consentToMention(db.admin, p.mentioned, post.id);
    pub = await publicOf(post.id) as Pub & { topics: string[] };
    assert.equal(pub.entityLinks.length, 2);
    // Staff fix links without touching the body (and without an editing right).
    const ctxA = await staff(p.editorA);
    post = await as(p.editorA, (trx) => publications.setLinks(trx, ctxA, post.id, post.revision, ['materials', 'markets'], null));
    pub = await publicOf(post.id) as Pub & { topics: string[] };
    assert.deepEqual(pub.topics, ['markets', 'materials']);
    assert.equal(pub.versions.length, 2, 'links never create versions');
  });

  let issueId = '';
  await t.test('issues: numbered, dated, frozen at release; a correction is a new edition', async () => {
    const ctxC = await staff(p.chief);
    const ctxA = await staff(p.editorA);
    await refused(as(p.writer, async (trx) => issues.create(trx, await staff(p.writer), { hubId: w.hubId, number: 1, date: '2026-11-02', theme: null, coverAssetId: null, editorLetterId: null })), '42501', 'admin.forbidden');
    let issue = await as(p.editorA, (trx) => issues.create(trx, ctxA, { hubId: w.hubId, number: 1, date: '2026-11-02', theme: 'Synthetic: autumn materials', coverAssetId: null, editorLetterId: piece.id }));
    issueId = issue.id;
    await refused(as(p.editorA, (trx) => issues.create(trx, ctxA, { hubId: w.hubId, number: 1, date: '2026-11-09', theme: null, coverAssetId: null, editorLetterId: null })), '23505');
    const versions = await as(p.chief, (trx) => publications.versions(trx, post.id));
    const v1 = versions.find((v) => v.version === 1)!;
    const pieceVersion = (await as(p.chief, (trx) => publications.versions(trx, piece.id)))[0]!;
    const draftOnly = await personal(p.writer, { title: 'Synthetic: unpublished' });
    const draftVersion = (await as(p.writer, (trx) => publications.versions(trx, draftOnly.id)))[0]!;
    await refused(as(p.editorA, (trx) => issues.curate(trx, ctxA, issue.id, issue.revision, { items: [{ position: 1, section: 'practice', publicationId: draftOnly.id, publicationVersionId: draftVersion.id }], theme: null, coverAssetId: null, editorLetterId: null })),
      '23514', 'content.version_not_published');
    issue = await as(p.editorA, (trx) => issues.curate(trx, ctxA, issue.id, issue.revision, {
      items: [{ position: 1, section: 'analysis', publicationId: piece.id, publicationVersionId: pieceVersion.id }, { position: 2, section: 'practice', publicationId: post.id, publicationVersionId: v1.id }],
      theme: null, coverAssetId: null, editorLetterId: null,
    }));
    issue = await as(p.editorA, (trx) => issues.transition(trx, ctxA, issue.id, issue.revision, 'curated'));
    issue = await as(p.editorA, (trx) => issues.transition(trx, ctxA, issue.id, issue.revision, 'review'));
    await refused(as(p.editorA, (trx) => issues.release(trx, ctxA, issue.id, issue.revision)), '42501', 'admin.forbidden');
    issue = await as(p.chief, (trx) => issues.release(trx, ctxC, issue.id, issue.revision));
    assert.equal(issue.status, 'released');
    assert.equal(issue.current_edition, 1);
    const [rev1] = await as(p.chief, (trx) => issues.revisions(trx, issueId));
    const expected = computeDigest({ issueNumber: 1, date: '2026-11-02', items: [
      { position: 1, publicationId: piece.id, publicationVersion: 1, section: 'analysis' }, { position: 2, publicationId: post.id, publicationVersion: 1, section: 'practice' },
    ] });
    assert.equal(rev1?.digest, expected.value);
    // Frozen for every role.
    await refused(withMaintenance(db.admin, (trx) => trx.deleteFrom('issue_item').where('issue_revision_id', '=', rev1!.id).execute()), '23000', 'content.issue_frozen');
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('issue_item').set({ section: 'news' }).where('issue_revision_id', '=', rev1!.id).execute()), '23000', 'content.issue_frozen');
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('issue_revision').set({ digest: 'b'.repeat(64) }).where('id', '=', rev1!.id).execute()), '23000', 'commercial.version_frozen');
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('issue').set({ issue_date: '2026-11-03' }).where('id', '=', issueId).execute()), '23000', 'content.issue_frozen');
    await refused(as(p.editorA, (trx) => issues.curate(trx, ctxA, issueId, issue.revision, { items: [], theme: null, coverAssetId: null, editorLetterId: null })), '23514', 'content.issue_frozen');
    let pub = await anon((trx) => publicContent.issue(trx, w.hubId, 1, null)) as { edition: number; items: { publicationVersion: number; corrected: boolean }[] };
    assert.equal(pub.edition, 1);
    assert.equal(pub.items[1]?.publicationVersion, 1);
    assert.equal(pub.items[1]?.corrected, true, 'the pinned version was corrected since: the reader sees the notice');
    noForbiddenKeys(pub);
    // Correction edition: repinned to the corrected version, with a note.
    await refused(as(p.editorA, (trx) => issues.correct(trx, ctxA, issueId, issue.revision, '')), '22023', 'content.correction_note_required');
    issue = await as(p.editorA, (trx) => issues.correct(trx, ctxA, issueId, issue.revision, 'The practice article was corrected; this edition carries version 2.'));
    issue = await as(p.chief, (trx) => issues.release(trx, ctxC, issueId, issue.revision));
    assert.equal(issue.status, 'corrected');
    assert.equal(issue.current_edition, 2);
    pub = await anon((trx) => publicContent.issue(trx, w.hubId, 1, null)) as typeof pub & { corrections: unknown[]; correctionNote: string };
    assert.equal(pub.edition, 2);
    assert.equal(pub.items[1]?.publicationVersion, 2);
    assert.equal((pub as unknown as { corrections: unknown[] }).corrections.length, 1);
    const first = await anon((trx) => publicContent.issue(trx, w.hubId, 1, 1)) as typeof pub;
    assert.equal(first.items[1]?.publicationVersion, 1, 'the archive keeps edition 1');
    const archive = await anon((trx) => publicContent.archive(trx, w.hubId, 2026)) as { number: number; currentEdition: number }[];
    assert.deepEqual(archive.map((a) => [a.number, a.currentEdition]), [[1, 2]]);
  });

  await t.test('render artifacts record the edition they render and complete once', async () => {
    const ctxA = await staff(p.editorA);
    const queued = await as(p.editorA, (trx) => issues.requestRender(trx, ctxA, issueId, 2, 'pdf'));
    assert.equal(queued.status, 'queued');
    await refused(as(p.editorA, (trx) => issues.recordRender(trx, ctxA, queued.id, { status: 'rendered', artifactId: null, sha256: null, rendererVersion: 'synthetic-1', failureReason: null })), '23514');
    const done = await as(p.editorA, (trx) => issues.recordRender(trx, ctxA, queued.id, { status: 'rendered', artifactId: null, sha256: 'c'.repeat(64), rendererVersion: 'synthetic-renderer 0.1', failureReason: null }));
    assert.equal(done.status, 'rendered');
    await refused(as(p.editorA, (trx) => issues.recordRender(trx, ctxA, queued.id, { status: 'failed', artifactId: null, sha256: null, rendererVersion: null, failureReason: 'late' })), '23000', 'content.immutable');
    const pub = await anon((trx) => publicContent.issue(trx, w.hubId, 1, 2)) as { renderArtifacts: { format: string; hash: string; sourceEdition: number }[] };
    assert.deepEqual(pub.renderArtifacts.map((r) => [r.format, r.hash, r.sourceEdition]), [['pdf', 'c'.repeat(64), 2]]);
    assert.deepEqual((await anon((trx) => publicContent.issue(trx, w.hubId, 1, 1)) as typeof pub).renderArtifacts, [], 'edition 1 has its own artifacts');
  });

  await t.test('retraction keeps an explanatory record and withholds the body everywhere', async () => {
    const ctxC = await staff(p.chief);
    piece = await as(p.chief, (trx) => publications.retract(trx, ctxC, piece.id, piece.revision, 'Synthetic: the price series was not verified.'));
    const pub = await publicOf(piece.id) as Pub;
    assert.equal(pub.status, 'retracted');
    assert.equal((pub.current as { body: string | null }).body, null);
    assert.deepEqual((pub.retraction as { note: string }).note, 'Synthetic: the price series was not verified.');
    const issue = await anon((trx) => publicContent.issue(trx, w.hubId, 1, null)) as { items: { retracted: boolean }[] };
    assert.equal(issue.items[0]?.retracted, true);
    await refused(as(p.chief, (trx) => publications.correct(trx, ctxC, piece.id, piece.revision, draft(), 'note', 'reason')), '23514', 'content.retracted');
  });

  await t.test('walls reference versions and show later corrections; held items drop out', async () => {
    const ref = await as(p.writer, (trx) => walls.add(trx, { kind: 'person', companyId: null, publicationId: post.id, versionId: null, pinned: true }));
    await refused(as(p.writer, (trx) => walls.add(trx, { kind: 'company', companyId: w.company, publicationId: post.id, versionId: null, pinned: false })), '42501', 'content.not_authorised');
    const draftOnly = await personal(p.writer);
    await refused(as(p.writer, (trx) => walls.add(trx, { kind: 'person', companyId: null, publicationId: draftOnly.id, versionId: null, pinned: false })), 'P0002', 'content.not_found');
    const wall = await anon((trx) => publicContent.wall(trx, 'person', p.writer)) as { publicationId: string; corrected: boolean; correctionNote: string }[];
    assert.equal(wall[0]?.publicationId, post.id);
    assert.equal(wall[0]?.corrected, true);
    assert.match(wall[0]?.correctionNote ?? '', /vapour barrier/);
    await refused(as(p.reader, (trx) => walls.remove(trx, ref.id)), 'P0002', 'content.not_found');
    await as(p.writer, (trx) => walls.remove(trx, ref.id));
    assert.deepEqual(await anon((trx) => publicContent.wall(trx, 'person', p.writer)), []);
  });

  await t.test('digests: full text only for cc_by items whose sources allow syndication', async () => {
    const ctxA = await staff(p.editorA);
    const ctxC = await staff(p.chief);
    const allRights = await personal(p.writer, { title: 'Synthetic: all rights' });
    const published = await as(p.writer, (trx) => publications.publish(trx, null, allRights.id, allRights.revision, null));
    const digest = await as(p.editorA, (trx) => digests.create(trx, ctxA, { hubId: w.hubId, title: 'Synthetic: November practice', period: '2026-11', publicationIds: [post.id, published.id] }));
    const items = await as(p.editorA, (trx) => digests.items(trx, digest.id));
    assert.deepEqual(items.map((i) => [i.licence, i.display]), [['cc_by', 'full'], ['all_rights', 'headline_link']]);
    await refused(as(p.editorA, (trx) => digests.create(trx, ctxA, { hubId: w.hubId, title: 'Synthetic', period: '2026-11', publicationIds: [piece.id] })), '23514', 'content.not_public');
    assert.equal(await anon((trx) => publicContent.digest(trx, w.hubId, digest.id)), null, 'unreleased digests are not public');
    await as(p.chief, (trx) => digests.release(trx, ctxC, digest.id, digest.revision));
    const pub = await anon((trx) => publicContent.digest(trx, w.hubId, digest.id)) as { items: { display: string; body: string | null }[] };
    assert.equal(pub.items[0]?.body, 'Corrected body.');
    assert.equal(pub.items[1]?.body, null, 'headline and link only');
    await refused(withMaintenance(db.admin, (trx) => trx.deleteFrom('magazine_digest_item').where('digest_id', '=', digest.id).execute()), '23000', 'content.digest_frozen');
  });

  await t.test('scheduling: an embargoed item is published by the worker when its time comes', async () => {
    const row = await personal(p.writer, { title: 'Synthetic: embargoed' });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await as(p.writer, (trx) => publications.publish(trx, null, row.id, row.revision, at));
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(await publicOf(row.id), null, 'embargoed');
    assert.equal(await withMaintenance(db.admin, (trx) => contentWorker.publishDue(trx)), 0, 'not yet');
    await withMaintenance(db.admin, (trx) => trx.updateTable('publication').set({ scheduled_for: new Date(Date.now() - 1000) }).where('id', '=', row.id).execute());
    assert.equal(await withMaintenance(db.admin, (trx) => contentWorker.publishDue(trx)), 1);
    assert.equal((await publicOf(row.id))?.status, 'published');
    const grants = await db.admin.query(`SELECT has_function_privilege('trustwork_worker', 'trustwork.content_publish_due(integer)', 'EXECUTE') AS w,
      has_function_privilege('trustwork_app', 'trustwork.content_publish_due(integer)', 'EXECUTE') AS a`);
    assert.deepEqual(grants.rows[0], { w: true, a: false });
  });

  await t.test('linked editions: machine assistance stays labelled until someone else reviews it', async () => {
    const es = await as(p.writer, (trx) => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'es-US', licence: 'cc_by', requiresReview: false,
      draft: draft({ title: 'Sintetico: aislamiento', language: 'es-US', treatment: 'translation' }), authorship: credit(p.writer) }));
    const link = await as(p.writer, (trx) => publications.linkEdition(trx, null, post.id, es.id, true));
    await as(p.writer, (trx) => publications.publish(trx, null, es.id, es.revision, null));
    await refused(as(p.writer, (trx) => publications.reviewEdition(trx, null, link.id)), '42501', 'content.self_review');
    let pub = await publicOf(post.id) as Pub & { editions: { machineAssisted: boolean; reviewed: boolean; language: string }[] };
    assert.deepEqual(pub.editions.map((e) => [e.language, e.machineAssisted, e.reviewed]), [['es-US', true, false]]);
    await as(p.writer, (trx) => publications.grantEditor(trx, es.id, p.coauthor, 'edit'));
    await as(p.coauthor, (trx) => publications.reviewEdition(trx, null, link.id));
    pub = await publicOf(post.id) as typeof pub;
    assert.equal(pub.editions[0]?.reviewed, true);
  });

  await t.test('comments: on public items only; moderation holds them', async () => {
    const c = await as(p.reader, (trx) => comments.add(trx, post.id, null, 'Synthetic question about the barrier.'));
    const draftOnly = await personal(p.writer);
    await refused(as(p.reader, (trx) => comments.add(trx, draftOnly.id, null, 'x')), 'P0002', 'content.not_found');
    await refused(as(p.reader, (trx) => comments.add(trx, piece.id, null, 'x')), 'P0002', 'content.not_found');
    assert.equal(((await anon((trx) => publicContent.comments(trx, w.hubId, post.id))) as unknown[]).length, 1);
    const ctxM = await staff(p.moderator);
    await as(p.moderator, async (trx) => {
      const mc = await moderation.openCase(trx, ctxM, { hubId: w.hubId, targetKind: 'publication_comment', targetId: c.id, subject: { kind: 'person', id: p.reader }, clauseCodes: ['community.spam'], emergencyHold: true });
      assert.equal(await contentModeration.apply(trx, mc.id, 'hold'), 'applied');
    });
    assert.equal(((await anon((trx) => publicContent.comments(trx, w.hubId, post.id))) as unknown[]).length, 0);
    await refused(withMaintenance(db.admin, (trx) => trx.updateTable('publication_comment').set({ body: 'rewritten' }).where('id', '=', c.id).execute()), '23000', 'content.immutable');
  });

  await t.test('concurrency: one of two racing publishers or correctors wins, the other is told to reload', async () => {
    const row = await personal(p.writer, { title: 'Synthetic: race' });
    await as(p.writer, (trx) => publications.grantEditor(trx, row.id, p.coauthor, 'publish'));
    const fresh = (await as(p.writer, (trx) => publications.get(trx, row.id)))!;
    const results = await Promise.allSettled([
      as(p.writer, (trx) => publications.publish(trx, null, row.id, fresh.revision, null)),
      as(p.coauthor, (trx) => publications.publish(trx, null, row.id, fresh.revision, null)),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(['40001'].includes(sqlState(failure.reason) ?? ''), String(failure.reason));
    const live = (await as(p.writer, (trx) => publications.get(trx, row.id)))!;
    const corrections = await Promise.allSettled([1, 2].map((n) => as(n === 1 ? p.writer : p.coauthor, (trx) => publications.correct(trx, null, row.id, live.revision, draft({ body: `Race ${n}` }), `note ${n}`, 'race'))));
    assert.deepEqual(corrections.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await as(p.writer, (trx) => publications.versions(trx, row.id))).length, 2, 'exactly one correction version');
    const concurrentIssues = await Promise.allSettled([1, 2].map(async () => as(p.editorA, async (trx) => issues.create(trx, await staff(p.editorA), { hubId: w.hubId, number: 7, date: '2026-12-14', theme: null, coverAssetId: null, editorLetterId: null }))));
    assert.deepEqual(concurrentIssues.map((r) => r.status).sort(), ['fulfilled', 'rejected'], 'one issue number per hub');
  });

  await t.test('principals never see another hub\'s public content', async () => {
    assert.equal(await anon((trx) => publicContent.publication(trx, w.otherHubId, post.id)), null);
    assert.equal(await anon((trx) => publicContent.issue(trx, w.otherHubId, 1, null)), null);
    await withPrincipal(db.app, await w.act.principal(p.reader), async (trx) => {
      assert.equal((await trx.selectFrom('issue').selectAll().execute()).length, 0, 'issues in curation are staff-only');
    });
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { contentPublishDueTask } from '../../apps/worker/src/content/index.js';
import { staffAssignments } from '../../packages/data/src/repositories/admin.js';
import { publications, type ContentStaffContext } from '../../packages/data/src/repositories/content.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { buildContentWorld, credit, draft } from './helpers.js';
import { withProvenanceFixtures } from './provenance-fixture.js';

const env = await provisionWorkerDatabase('content_schedule_authority');
const LATER = '2099-01-01T00:00:00.000Z';
const LAPSED = 'content.schedule_authority_lapsed';

/** A release set up in advance is still that person's act: the worker task, under its own role, rechecks and names them. */
test('a scheduled release needs the scheduler\'s right when it runs, and records who released it', { skip: env ? false : SKIP_REASON }, async t => {
  if (!env) return;
  t.after(() => env.close());
  const w = await buildContentWorld(env.db.admin, env.apiPool), p = w.people;
  const fixtures = withProvenanceFixtures(w);
  const as = w.act.as;
  const task = contentPublishDueTask({ pool: env.workerPool(2) });
  const due = (...ids: string[]) => withMaintenance(env.db.admin, trx => trx.updateTable('publication').set({ scheduled_for: new Date(Date.now() - 1000) }).where('id', 'in', ids).execute());
  const row = (id: string) => withMaintenance(env.db.admin, trx => trx.selectFrom('publication').select(['status', 'scheduled_by', 'revision']).where('id', '=', id).executeTakeFirstOrThrow());
  const version = (id: string) => withMaintenance(env.db.admin, trx => trx.selectFrom('publication_version').select(['published_by', 'drafted_by', 'status']).where('publication_id', '=', id).orderBy('version', 'desc').executeTakeFirstOrThrow());
  const blocked = async (id: string) => (await env.db.admin.query<{ reason: string }>(`SELECT reason FROM trustwork.audit_event WHERE object_id=$1 AND action='publication.schedule_blocked'`, [id])).rows.map(r => r.reason);
  const setMemberRights = (permissions: string[]) => withMaintenance(env.db.admin, trx => trx.updateTable('membership').set({ permissions }).where('person_id', '=', p.member).where('company_id', '=', w.company).execute());
  const personal = (title: string) => as(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: false, draft: draft({ title }), authorship: credit(p.writer) }));
  /** The writer's piece, scheduled by the co-author under a publish right the writer gave them. */
  const scheduledByEditor = async (title: string) => {
    const piece = await personal(title);
    await as(p.writer, trx => publications.grantEditor(trx, piece.id, p.coauthor, 'publish'));
    await as(p.coauthor, trx => fixtures.publish(trx, null, piece.id, piece.revision, LATER));
    return piece.id;
  };
  const companyPiece = async (title: string) => {
    const piece = await as(p.member, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'company', id: w.company }, format: 'company_post', articleFormat: null, language: 'en', licence: 'cc_by', requiresReview: false, draft: draft({ title }), authorship: credit(p.member, 'Synthetic Company Writer') }));
    await as(p.member, trx => fixtures.publish(trx, null, piece.id, piece.revision, LATER));
    return piece.id;
  };
  const editorialPiece = async (title: string) => {
    const a: ContentStaffContext = await w.act.elevate(p.editorA), b: ContentStaffContext = await w.act.elevate(p.editorB);
    let piece = await as(p.editorA, trx => publications.create(trx, a, { hubId: w.hubId, owner: { kind: 'editorial' }, format: 'magazine_piece', articleFormat: 'analysis', language: 'en', licence: 'all_rights', requiresReview: false, draft: draft({ title }), authorship: [{ kind: 'editorial', credit: 'Synthetic editorial office', assistantAssisted: false }] }));
    piece = await as(p.editorA, trx => publications.transition(trx, a, piece.id, piece.revision, 'in_review'));
    await as(p.editorB, trx => fixtures.publish(trx, b, piece.id, piece.revision, LATER));
    return piece.id;
  };

  await t.test('the person who scheduled is recorded and audited, never the drafter', async () => {
    const id = await scheduledByEditor('Synthetic scheduled by an editor');
    assert.equal((await row(id)).scheduled_by, p.coauthor);
    await due(id);
    assert.deepEqual(await task.run(), { published: 1 });
    const released = await version(id);
    assert.equal(released.drafted_by, p.writer);
    assert.equal(released.published_by, p.coauthor);
    assert.equal((await row(id)).scheduled_by, null, 'the record of a schedule ends with the schedule');
    const audit = await env.db.admin.query<{ actor_person_id: string }>(`SELECT actor_person_id FROM trustwork.audit_event WHERE object_id=$1 AND action='publication.scheduled_release'`, [id]);
    assert.deepEqual(audit.rows.map(r => r.actor_person_id), [p.coauthor]);
  });

  await t.test('a revoked publish right stops the release until someone who holds the right takes it over', async () => {
    const id = await scheduledByEditor('Synthetic right revoked');
    await as(p.writer, trx => publications.revokeEditor(trx, id, p.coauthor));
    await due(id);
    assert.deepEqual(await task.run(), { published: 0 });
    assert.deepEqual(await task.run(), { published: 0 }, 'retried without an error');
    assert.equal((await row(id)).status, 'scheduled');
    assert.equal((await version(id)).published_by, null);
    assert.deepEqual(await blocked(id), [LAPSED], 'recorded once');
    const { revision } = await row(id);
    await as(p.writer, trx => publications.publish(trx, null, id, revision, LATER));
    assert.equal((await row(id)).scheduled_by, p.writer);
    await due(id);
    assert.deepEqual(await task.run(), { published: 1 });
    assert.equal((await version(id)).published_by, p.writer);
  });

  await t.test('a right narrowed to editing is not a right to publish', async () => {
    const id = await scheduledByEditor('Synthetic right narrowed');
    await as(p.writer, trx => publications.revokeEditor(trx, id, p.coauthor));
    await as(p.writer, trx => publications.grantEditor(trx, id, p.coauthor, 'edit'));
    await due(id);
    assert.deepEqual(await task.run(), { published: 0 });
    assert.deepEqual(await blocked(id), [LAPSED]);
  });

  await t.test('a member who lost company.publish no longer releases for the company', async () => {
    const kept = await companyPiece('Synthetic company piece, right kept');
    await due(kept);
    assert.deepEqual(await task.run(), { published: 1 });
    assert.equal((await version(kept)).published_by, p.member);
    const id = await companyPiece('Synthetic company piece, right lost');
    await due(id);
    await setMemberRights([]);
    assert.deepEqual(await task.run(), { published: 0 });
    assert.deepEqual(await blocked(id), [LAPSED]);
    await setMemberRights(['company.publish']);
    assert.deepEqual(await task.run(), { published: 1 }, 'a right restored is the same right');
  });

  await t.test('editorial: the staff member who scheduled must still hold the publish permission', async () => {
    const kept = await editorialPiece('Synthetic editorial piece');
    await due(kept);
    assert.deepEqual(await task.run(), { published: 1 });
    const released = await version(kept);
    assert.deepEqual([released.drafted_by, released.published_by], [p.editorA, p.editorB]);
    const id = await editorialPiece('Synthetic editorial piece, role revoked');
    await due(id);
    const assignment = await withMaintenance(env.db.admin, trx => trx.selectFrom('staff_role_assignment').select('id').where('person_id', '=', p.editorB).where('revoked_at', 'is', null).executeTakeFirstOrThrow());
    const owner = await w.act.elevate(p.owner);
    await as(p.owner, trx => staffAssignments.revoke(trx, owner, assignment.id));
    assert.deepEqual(await task.run(), { published: 0 });
    assert.deepEqual(await blocked(id), [LAPSED]);
  });

  await t.test('a schedule with no author on record is not released on a guess', async () => {
    const piece = await personal('Synthetic older schedule');
    await as(p.writer, trx => fixtures.publish(trx, null, piece.id, piece.revision, LATER));
    await withMaintenance(env.db.admin, trx => trx.updateTable('publication').set({ scheduled_by: null, scheduled_for: new Date(Date.now() - 1000) }).where('id', '=', piece.id).execute());
    assert.deepEqual(await task.run(), { published: 0 });
    assert.deepEqual(await blocked(piece.id), [LAPSED]);
  });

  await t.test('returning a scheduled piece to draft ends the schedule and its author', async () => {
    const piece = await personal('Synthetic returned piece');
    const scheduled = await as(p.writer, trx => fixtures.publish(trx, null, piece.id, piece.revision, LATER));
    await as(p.writer, trx => publications.transition(trx, null, piece.id, scheduled.revision, 'draft'));
    const after = await row(piece.id);
    assert.deepEqual([after.status, after.scheduled_by], ['draft', null]);
  });

  for (const outcome of ['commits', 'rolls back'] as const) {
    await t.test(`a revocation in flight decides the release when it ${outcome}, and is never overtaken`, async () => {
      await setMemberRights(['company.publish']);
      const id = await companyPiece(`Synthetic race, revocation ${outcome}`);
      await due(id);
      let decide!: () => void, begun!: () => void;
      const decided = new Promise<void>(resolve => { decide = resolve; }), started = new Promise<void>(resolve => { begun = resolve; });
      const revocation = withMaintenance(env.db.admin, async trx => {
        await trx.updateTable('membership').set({ permissions: [] }).where('person_id', '=', p.member).where('company_id', '=', w.company).execute();
        begun();
        await decided;
        if (outcome === 'rolls back') throw new Error('synthetic rollback');
      }).catch((error: Error) => assert.equal(error.message, 'synthetic rollback'));
      try {
        await started;
        // The worker neither waits for the revocation nor releases past it; the piece stays for the next run.
        assert.deepEqual(await task.run(), { published: 0 });
        assert.equal((await row(id)).status, 'scheduled');
        assert.deepEqual(await blocked(id), [], 'an undecided revocation records nothing');
      } finally {
        decide();
        await revocation;
      }
      await task.run();
      assert.equal((await row(id)).status, outcome === 'commits' ? 'scheduled' : 'published');
      assert.deepEqual(await blocked(id), outcome === 'commits' ? [LAPSED] : []);
    });
  }

  // Last: the hold cannot be cleared here, and it keeps the co-author out of every later release.
  await t.test('a held scheduler releases nothing, and one blocked piece holds nothing else back', async () => {
    const held = await scheduledByEditor('Synthetic piece of a held person');
    const clear = await personal('Synthetic piece beside it');
    await as(p.writer, trx => fixtures.publish(trx, null, clear.id, clear.revision, LATER));
    await due(held, clear.id);
    await withMaintenance(env.db.admin, trx => trx.insertInto('jurisdiction_hold').values({ person_id: p.coauthor, place: 'ZZ', source: 'staff_report', dataset: 'synthetic' }).execute());
    await task.run();
    assert.equal((await row(held)).status, 'scheduled');
    assert.equal((await row(clear.id)).status, 'published');
    assert.deepEqual(await blocked(held), [LAPSED]);
  });
});

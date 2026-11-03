import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { contentPublishDueTask } from '../../apps/worker/src/content/index.js';
import { publications } from '../../packages/data/src/repositories/content.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { buildContentWorld, credit, draft } from '../content/helpers.js';
import { withProvenanceFixtures } from '../content/provenance-fixture.js';

const env = await provisionWorkerDatabase('provenance_schedule');

test('the worker task releases what a person scheduled, under the worker role and every publication rule', { skip: env ? false : SKIP_REASON }, async t => {
  if (!env) return;
  t.after(() => env.close());
  const w = await buildContentWorld(env.db.admin, env.apiPool), p = w.people;
  const fixtures = withProvenanceFixtures(w);
  const scheduled = async (title: string, assistantAssisted = false) => {
    const row = await w.act.as(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language: 'en', licence: 'cc_by', requiresReview: false, draft: draft({ title, assistantAssisted }), authorship: credit(p.writer) }));
    await w.act.as(p.writer, trx => fixtures.publish(trx, null, row.id, row.revision, '2099-01-01T00:00:00.000Z'));
    return row.id;
  };
  const clean = await scheduled('Synthetic scheduled piece');
  const assisted = await scheduled('Synthetic assisted piece', true);
  const status = (id: string) => w.act.as(p.writer, trx => publications.get(trx, id)).then(row => row?.status);
  const task = contentPublishDueTask({ pool: env.workerPool(2) });

  assert.deepEqual(await task.run(), { published: 0 }, 'nothing is due yet');
  assert.equal(await status(clean), 'scheduled');
  await withMaintenance(env.db.admin, trx => trx.updateTable('publication').set({ scheduled_for: new Date(Date.now() - 1000) }).where('id', 'in', [clean, assisted]).execute());
  // Withdrawing the credit between scheduling and release blocks only that piece.
  const consent = (await env.db.admin.query<{ id: string }>(
    `SELECT c.id FROM trustwork.provenance_credit_consent c JOIN trustwork.provenance_record r ON r.id=c.provenance_id WHERE r.publication_id=$1`, [assisted])).rows[0]!;
  await withMaintenance(env.db.admin, trx => trx.insertInto('provenance_credit_revocation').values({ consent_id: consent.id, person_id: p.writer, reason: 'Synthetic withdrawal' }).execute());

  assert.deepEqual(await task.run(), { published: 1 });
  assert.equal(await status(clean), 'published');
  assert.equal(await status(assisted), 'scheduled');
  assert.deepEqual(await task.run(), { published: 0 }, 'the blocked piece is retried without an error');
  const blocked = await env.db.admin.query<{ reason: string }>(`SELECT reason FROM trustwork.audit_event WHERE object_id=$1 AND action='publication.schedule_blocked'`, [assisted]);
  assert.deepEqual(blocked.rows.map(r => r.reason), ['content.provenance_credit_required'], 'recorded once');
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { privacyWorld } from './helpers.js';
import { privacySourceFixture } from './source-fixture.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { caseGrants } from '../../packages/data/src/repositories/admin.js';
import { importBatches } from '../../packages/data/src/repositories/sources.js';
import { item } from '../sources/helpers.js';
import { gate } from '../worker/helpers/worker-db.js';

test('PRV source requests bind real case grants, human evidence, action and source revision', async (t) => {
  const h = await startHarness('privacy_source');
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(() => h.close());
  const world = await privacyWorld(h);
  const submit = (proof: string, action = 'objection', proposedValue: string | null = null) => h.client().post('/v1/privacy/public/sourced-requests', { proof, action, proposedValue }, { idempotencyKey: null });
  await t.test('unknown proof gives the same response; address possession is never deletion authority', async () => {
    const result = await submit('0'.repeat(64), 'erasure');
    assert.equal(result.status, 202); assert.deepEqual(result.body, { accepted: true });
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_source_request')).rows[0].n, 0);
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.privacy_source_proof'), /permission denied/);
  });
  await t.test('unprivileged caller, mismatched grant, missing evidence and changed action are refused', async () => {
    const f = await privacySourceFixture(h, world);
    await assert.rejects(world.as(world.people.subject, (trx) => privacy.sourceProof(trx, f.ctx, f.body)));
    await assert.rejects(world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, { ...f.body, grantId: randomUUID() })));
    await assert.rejects(world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, { ...f.body, evidenceRef: randomUUID() })));
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
    assert.equal((await submit(f.proof, 'erasure')).status, 202);
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_source_request')).rows[0].n, 0);
  });
  await t.test('a verified objection reaches the actual SRC staging boundary and survives duplicate requests', async () => {
    const f = await privacySourceFixture(h, world);
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
    for (let i = 0; i < 2; i++) assert.equal((await submit(f.proof)).status, 202);
    const rows = (await h.db.admin.query('SELECT * FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].state, 'objection_applied');
    await assert.rejects(world.as(world.people.officer, (trx) => importBatches.stage(trx, f.ctx, f.source.id,
      { items: [item(randomUUID())], fields: [f.field], links: [] })), (e: { hint?: string }) => e.hint === 'privacy.do_not_collect');
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_replay_receipt')).rows[0].n, 0, 'objection is not represented as completed erasure');
  });
  await t.test('staging first: objection waits, then blocks activation and the real public provenance projection', async () => {
    const f = await privacySourceFixture(h, world);
    await h.db.admin.query("UPDATE trustwork.hub SET lifecycle='public' WHERE id=$1", [f.source.hub_id]);
    const before = await h.pool.query<{ v: { fields: unknown[] } }>('SELECT trustwork.sources_public_provenance($1,$2,$3) AS v', [f.source.hub_id, f.field.recordKind, f.field.recordId]);
    assert.equal(before.rows[0]!.v.fields.length, 1);
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
    const locked = gate(); const release = gate();
    const staging = world.as(world.people.officer, async (trx) => {
      const batch = await importBatches.stage(trx, f.ctx, f.source.id, { items: [item(randomUUID())], fields: [f.field], links: [] });
      locked.open(); await release.promise; return batch;
    });
    await locked.promise; const objection = submit(f.proof); release.open(); const batch = await staging;
    assert.equal((await objection).status, 202);
    await assert.rejects(world.as(world.people.reviewer, (trx) => importBatches.decide(trx, f.reviewCtx, batch.id, batch.revision, 'activate')),
      (e: { hint?: string }) => e.hint === 'privacy.do_not_collect');
    const after = await h.pool.query<{ v: { fields: unknown[] } }>('SELECT trustwork.sources_public_provenance($1,$2,$3) AS v', [f.source.hub_id, f.field.recordKind, f.field.recordId]);
    assert.deepEqual(after.rows[0]!.v.fields, []);
    assert.equal((await h.db.admin.query('SELECT value FROM trustwork.sourced_record_field WHERE id=$1', [f.fieldId])).rows[0].value, f.field.value, 'lawful source evidence was not rewritten');
  });
  await t.test('revocation winning the race invalidates an issued capability before intake', async () => {
    const f = await privacySourceFixture(h, world);
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
    const locked = gate(); const release = gate();
    const revoke = world.as(world.people.reviewer, async (trx) => { await caseGrants.revoke(trx, f.reviewCtx, f.grant.id); locked.open(); await release.promise; });
    await locked.promise; const pending = submit(f.proof); release.open(); await revoke;
    assert.equal((await pending).status, 202);
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows[0].n, 0);
  });
  await t.test('changed source revision invalidates correction authority; no source history is rewritten', async () => {
    const f = await privacySourceFixture(h, world);
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, { ...f.body, action: 'correction' }));
    await h.db.admin.query('UPDATE trustwork.source SET revision=revision+1 WHERE id=$1', [f.source.id]);
    assert.equal((await submit(f.proof, 'correction', 'Synthetic corrected value')).status, 202);
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows[0].n, 0);
    assert.equal((await h.db.admin.query('SELECT value FROM trustwork.sourced_record_field WHERE id=$1', [f.fieldId])).rows[0].value, f.field.value);
  });
});

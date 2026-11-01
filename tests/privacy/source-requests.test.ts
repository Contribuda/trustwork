import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'kysely';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { privacyWorld } from './helpers.js';
import { privacySourceFixture } from './source-fixture.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { caseGrants } from '../../packages/data/src/repositories/admin.js';
import { importBatches, sources } from '../../packages/data/src/repositories/sources.js';
import { item } from '../sources/helpers.js';
import { gate, tx, waitFor } from '../worker/helpers/worker-db.js';

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
  const waitingOn = (pid: number) => waitFor(async () => (await h.db.admin.query(
    'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid],
  )).rows[0].waiting, 5000, 'competing command is blocked on the owning transaction');
  await t.test('takedown first: source lock precedes field, stale proof is not consumed', async () => {
    const f = await privacySourceFixture(h, world);
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
    const locked = gate(); const release = gate(); let pid = 0;
    const takedown = world.as(world.people.officer, async (trx) => {
      await sql`SET LOCAL statement_timeout='10s'`.execute(trx);
      await sources.preparePolicyCheck(trx, f.ctx, f.source.hub_id, f.source.id);
      pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
      locked.open(); await release.promise;
      return sources.takedown(trx, f.ctx, { sourceId: f.source.id, itemId: null }, 'privacy_request', 'Synthetic takedown race');
    });
    await locked.promise;
    const submission = submit(f.proof);
    try { await waitingOn(pid); } finally { release.open(); }
    const [removed, received] = await Promise.all([takedown, submission]);
    assert.equal(removed.fields_deactivated, 1); assert.equal(received.status, 202);
    assert.equal((await h.db.admin.query('SELECT used_at FROM trustwork.privacy_source_proof WHERE token_hash=$1', [f.body.tokenHash])).rows[0].used_at, null);
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows[0].n, 0);
  });
  await t.test('submission first: authorized takedown waits through commit then completes with evidence intact', async () => {
    const f = await privacySourceFixture(h, world);
    await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
    const locked = gate(); const release = gate(); let pid = 0;
    const submission = tx(h.pool, async (_trx, client) => {
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query('SELECT trustwork.privacy_source_submit($1,$2,$3)', [f.body.tokenHash, 'objection', null]);
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      locked.open(); await release.promise;
    });
    await locked.promise;
    const takedown = world.as(world.people.officer, (trx) => sources.takedown(trx, f.ctx,
      { sourceId: f.source.id, itemId: null }, 'privacy_request', 'Synthetic takedown after submission'));
    try { await waitingOn(pid); } finally { release.open(); }
    await Promise.all([submission, takedown]);
    const field = (await h.db.admin.query('SELECT active,value FROM trustwork.sourced_record_field WHERE id=$1', [f.fieldId])).rows[0];
    assert.equal(field.active, false); assert.equal(field.value, f.field.value);
    assert.equal((await h.db.admin.query('SELECT state FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows[0].state, 'objection_applied');
  });
  await t.test('expiry while waiting for the parent source denies proof and grant independently', async () => {
    for (const expiry of ['proof', 'grant']) {
      const f = await privacySourceFixture(h, world, expiry === 'grant' ? 2 : 3600);
      await world.as(world.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
      const table = expiry === 'proof' ? 'privacy_source_proof' : 'case_access_grant';
      const where = expiry === 'proof' ? 'token_hash' : 'id';
      await h.db.admin.query("UPDATE trustwork.privacy_source_proof SET expires_at=clock_timestamp()+$2::interval WHERE token_hash=$1",
        [f.body.tokenHash, expiry === 'proof' ? '1 second' : '1 hour']);
      const locked = gate(); const release = gate(); let pid = 0;
      const owner = world.as(world.people.officer, async (trx) => {
        await sources.preparePolicyCheck(trx, f.ctx, f.source.hub_id, f.source.id);
        pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
        locked.open(); await release.promise;
      });
      await locked.promise; const submission = submit(f.proof);
      try {
        await waitingOn(pid);
        await waitFor(async () => (await h.db.admin.query(`SELECT expires_at<=clock_timestamp() expired FROM trustwork.${table} WHERE ${where}=$1`,
          [expiry === 'proof' ? f.body.tokenHash : f.grant.id])).rows[0].expired, 5000, 'authority expiry');
      } finally { release.open(); }
      await owner; assert.equal((await submission).status, 202);
      assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows[0].n, 0);
    }
  });

});

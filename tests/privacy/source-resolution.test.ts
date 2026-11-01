import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { privacyWorld } from './helpers.js';
import { sourceResolutionFixture } from './source-resolution-fixture.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { caseGrants } from '../../packages/data/src/repositories/admin.js';
import { importBatches } from '../../packages/data/src/repositories/sources.js';
import { item } from '../sources/helpers.js';
import { provisionLocalPrivacyJournal, replayPrivacyLedger } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { executeLocalSourceErasure } from '../../apps/api/src/modules/platform-admin/privacy/source-executor.js';
import { principalFor } from '../data/helpers/seed.js';
import { gate, tx } from '../worker/helpers/worker-db.js';

test('owning source resolution: current two-person authority, immutable evidence and retained replay', async (t) => {
  const h = await startHarness('privacy_source_resolution');
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(() => h.close()); const w = await privacyWorld(h);
  await h.db.admin.query("INSERT INTO trustwork.privacy_country_policy(country,version,review,sources,deadline_days,retention_days) VALUES('ZZ','synthetic-resolution','verified','[\"https://example.invalid/synthetic-policy\"]',3,0)");
  const prepare = async (action: 'correction' | 'erasure' = 'correction') => {
    const f = await sourceResolutionFixture(h, w, action);
    const plan = await w.as(w.people.officer, (trx) => privacy.proposeSourcePlan(trx, f.ctx, f.request.id, f.grant.id));
    return { ...f, plan };
  };
  const approve = (f: Awaited<ReturnType<typeof prepare>>) => w.as(w.people.reviewer, (trx) => privacy.approveSourcePlan(trx, f.reviewCtx, f.plan.id, f.second.id, f.plan.digest));
  const execute = (f: Awaited<ReturnType<typeof prepare>>) => w.as(w.people.officer, (trx) => privacy.executeSourcePlan(trx, f.ctx, f.plan.id, f.plan.digest));
  await t.test('correction appends a replacement field, preserves the original and consumes exact human approval', async () => {
    const f = await prepare();
    await assert.rejects(w.as(w.people.officer, (trx) => privacy.approveSourcePlan(trx, f.ctx, f.plan.id, f.grant.id, f.plan.digest)), (e: { hint?: string }) => e.hint === 'admin.self_approval');
    await approve(f);
    await assert.rejects(w.as(w.people.subject, (trx) => privacy.executeSourcePlan(trx, f.ctx, f.plan.id, f.plan.digest)));
    assert.equal((await execute(f)).status, 'applied');
    const original = (await h.db.admin.query('SELECT value,active FROM trustwork.sourced_record_field WHERE id=$1', [f.fieldId])).rows[0];
    assert.equal(original.value, f.field.value); assert.equal(original.active, false);
    const resolution = (await h.db.admin.query('SELECT * FROM trustwork.source_field_resolution WHERE source_field_id=$1', [f.fieldId])).rows[0];
    const replacement = (await h.db.admin.query('SELECT value,active FROM trustwork.sourced_record_field WHERE id=$1', [resolution.replacement_field_id])).rows[0];
    assert.equal(replacement.value, f.intake.proposedValue); assert.equal(replacement.active, true);
    assert.equal((await h.db.admin.query('SELECT status FROM trustwork.second_person_approval WHERE id=$1', [f.plan.approvalId])).rows[0].status, 'consumed');
    await assert.rejects(h.db.admin.query('DELETE FROM trustwork.source_field_resolution WHERE id=$1', [f.plan.id]));
    await assert.rejects(h.pool.query('SELECT trustwork.sources_apply_privacy_resolution($1,NULL)', [f.plan.id]), /permission denied/);
    await h.db.admin.query("UPDATE trustwork.hub SET lifecycle='public' WHERE id=$1", [f.source.hub_id]);
    const view = (await h.pool.query('SELECT trustwork.sources_public_provenance($1,$2,$3) AS v', [f.source.hub_id, f.field.recordKind, f.field.recordId])).rows[0].v;
    assert.equal(view.fields[0].correction.kind, 'verified_subject_correction');
    await assert.rejects(w.as(w.people.officer, (trx) => importBatches.stage(trx, f.ctx, f.source.id, { items: [item(randomUUID())], fields: [f.field], links: [] })),
      (e: { hint?: string }) => e.hint === 'privacy.source_review_required');
    assert.equal(view.fields.length, 1); assert.equal(view.fields[0].value, f.intake.proposedValue);
  });
  await t.test('changed policy, grants and a hold prevent execution without mutating evidence', async () => {
    const f = await prepare(); await approve(f);
    const locked = gate(); const release = gate();
    const holding = w.as(w.people.officer, async (trx) => { await privacy.sourceHold(trx, f.ctx, f.fieldId, f.grant.id, 'litigation', randomUUID()); locked.open(); await release.promise; });
    await locked.promise;
    const pending = assert.rejects(execute(f), (e: { hint?: string }) => e.hint === 'privacy.plan_changed');
    release.open(); await holding; await pending;
    const g = await prepare(); await approve(g);
    await w.as(w.people.officer, (trx) => caseGrants.revoke(trx, g.ctx, g.second.id));
    await assert.rejects(execute(g), (e: { hint?: string }) => e.hint === 'privacy.case_grant_required');
    const p = await prepare(); await approve(p);
    await h.db.admin.query("UPDATE trustwork.privacy_country_policy SET version='synthetic-resolution-2' WHERE country='ZZ'");
    await assert.rejects(execute(p), (e: { hint?: string }) => e.hint === 'privacy.plan_changed');
    assert.equal((await h.db.admin.query('SELECT active FROM trustwork.sourced_record_field WHERE id=$1', [f.fieldId])).rows[0].active, true);
  });
  await t.test('UNKNOWN and unexpired retention remain unavailable even with two human approvals', async () => {
    for (const mode of ['UNKNOWN', 'retention']) {
      await h.db.admin.query('UPDATE trustwork.privacy_country_policy SET review=$1,retention_days=$2 WHERE country=$3', [mode === 'UNKNOWN' ? 'UNKNOWN' : 'verified', mode === 'retention' ? 30 : 0, 'ZZ']);
      const f = await prepare(); await approve(f);
      await assert.rejects(execute(f), (e: { hint?: string }) => e.hint === (mode === 'UNKNOWN' ? 'privacy.country_policy_UNKNOWN' : 'privacy.retention_required'));
    }
    await h.db.admin.query("UPDATE trustwork.privacy_country_policy SET review='verified',retention_days=0 WHERE country='ZZ'");
  });
  await t.test('erasure runtime gate stays closed; explicit local retained executor deactivates only the field', async () => {
    const f = await prepare('erasure'); await approve(f);
    assert.equal((await execute(f)).reason, 'retained_authority_unavailable');
    const work = await mkdtemp(join(tmpdir(), 'prv-source-journal-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    const binding = { journalId: randomUUID(), authorityDirectory: join(work, 'authority'), journalDirectory: join(work, 'journal') };
    const ledger = await provisionLocalPrivacyJournal(binding);
    const result = await executeLocalSourceErasure({ admin: h.db.admin, personId: w.people.officer,
      authzEpoch: (await principalFor(h.db.admin, w.people.officer)).authzEpoch, context: f.ctx, planId: f.plan.id, digest: f.plan.digest,
      ledger, retainedAuthority: { directory: binding.authorityDirectory, journalId: binding.journalId } });
    assert.equal(result.complete, false); assert.equal(result.evidenceRetained, true);
    assert.equal((await ledger.all()).length, 1);
    assert.equal((await h.db.admin.query('SELECT value FROM trustwork.sourced_record_field WHERE id=$1', [f.fieldId])).rows[0].value, f.field.value);
    await ledger.withRestore(async (entries) => tx(h.db.admin, async (_trx, client) => {
      await client.query('SET LOCAL ROLE trustwork_owner'); await client.query("SET LOCAL trustwork.maintenance='on'");
      assert.equal(await replayPrivacyLedger(client, entries), 1); assert.equal(await replayPrivacyLedger(client, entries), 1);
    }));
    await assert.rejects(w.as(w.people.officer, (trx) => importBatches.stage(trx, f.ctx, f.source.id, { items: [item(randomUUID())], fields: [f.field], links: [] })),
      (e: { hint?: string }) => e.hint === 'privacy.do_not_collect');
    assert.equal((await h.db.admin.query('SELECT count(*)::int n FROM trustwork.privacy_replay_receipt')).rows[0].n, 0, 'no whole-subject erasure receipt');
  });
});

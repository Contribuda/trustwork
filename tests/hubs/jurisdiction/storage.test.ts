import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type DataPool } from '@trustwork/data';
import { configActivationDigestInput } from '../../../packages/contracts/src/hub-core.js';
import { hubConfig } from '../../../packages/data/src/repositories/hubs.js';
import { JurisdictionConfiguration } from '../../../apps/api/src/modules/hubs/jurisdiction/configuration.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildHubWorld, rejects, syncKernel, US_HUB } from '../helpers.js';
import { LOCALES, payloadOf, syntheticSettings } from './fixtures.js';

/** Tests existing storage safeguards, not an assertion that HUB-005 runtime integration is complete. */
const db = await provisionTestDatabase('hub005_jurisdiction', { weight: 2 });
test('jurisdiction draft storage, preflight and inherited second-person guards on real PostgreSQL', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate(); await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 6 });
  t.after(async () => { await runtime.end(); await db.close(); });
  await syncKernel(db.admin);
  const world = await buildHubWorld(db.admin); const p = world.people;
  const a = actors(db.admin, runtime, world);
  await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: world.nodeId } });
  const hubId = (await a.createHub('synthetic-jurisdiction', { ...US_HUB, locales: LOCALES, name: Object.fromEntries(LOCALES.map((locale) => [locale, 'Synthetic jurisdiction test hub'])) })).hub_id;
  const otherHub = (await a.createHub('synthetic-other-jurisdiction')).hub_id;
  await a.assignSensitive({ personId: p.owner, role: 'hub-owner', scope: { kind: 'hub', hubId } });
  await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId } });
  await a.assignSensitive({ personId: p.otherOwner, role: 'hub-owner', scope: { kind: 'hub', hubId: otherHub } });
  await a.assign({ personId: p.moderator, role: 'moderator', scope: { kind: 'hub', hubId } });
  const service = new JurisdictionConfiguration();
  const draft = (personId: string, payload = payloadOf(syntheticSettings())) => a.cmd(personId, (trx, cmd) => service.draft(trx, cmd, hubId, payload));

  await t.test('negative: outsider, wrong role and foreign hub cannot draft or read settings', async () => {
    for (const personId of [p.outsider, p.moderator, p.otherOwner]) {
      await rejects(draft(personId), '42501');
      assert.deepEqual(await a.as(personId, (trx) => hubConfig.list(trx, hubId, 'jurisdiction')), []);
    }
  });
  const version = await draft(p.owner);
  await t.test('draft is immutable, audited and has a persisted digest', async () => {
    assert.equal(version.status, 'draft'); assert.match(version.payload_digest, /^[a-f0-9]{64}$/);
    const audit = await db.admin.query("SELECT actor_person_id, outcome FROM trustwork.admin_audit_event WHERE object_id = $1 AND action = 'hub.config_drafted'", [version.id]);
    assert.deepEqual(audit.rows, [{ actor_person_id: p.owner, outcome: 'applied' }]);
    await rejects(a.as(p.owner, (trx) => trx.updateTable('hub_config_version').set({ payload: {} }).where('id', '=', version.id).execute()), '42501');
  });
  await t.test('preflight reports missing languages and mandatory baseline instead of inventing counsel approval', async () => {
    const complete = await a.as(p.owner, (trx) => service.preflight(trx, hubId, version.id));
    assert.equal(complete.status, 'blocked'); assert.ok(complete.problems.includes('mandatory_baseline_not_representable'));
    assert.ok(!complete.problems.some((x) => x.startsWith('disclosure_locale_missing:')));
    const setting = syntheticSettings(); delete setting.policy.disclosureTextKeys.es;
    const partial = await draft(p.owner, payloadOf(setting));
    const incomplete = await a.as(p.owner, (trx) => service.preflight(trx, hubId, partial.id));
    assert.ok(incomplete.problems.includes('disclosure_locale_missing:es'));
    await assert.rejects(a.as(p.otherOwner, (trx) => service.preflight(trx, hubId, version.id)), { code: 'access.not_found' });
  });
  const digestInput = configActivationDigestInput({ id: version.id, hubId, domain: 'jurisdiction', version: version.version, payloadDigest: version.payload_digest });
  await t.test('existing repository requires a second person and refuses self-activation', async () => {
    await rejects(a.cmd(p.owner, (trx, cmd) => hubConfig.activate(trx, cmd, version.id, version.revision, null)), '42501');
    await rejects(a.cmd(p.officer, (trx, cmd) => hubConfig.activate(trx, cmd, version.id, version.revision, null)), '42501');
    const selfApproval = await a.approve(p.owner, p.officer, 'jurisdiction.activate_settings', hubId, digestInput);
    await rejects(a.cmd(p.owner, (trx, cmd) => hubConfig.activate(trx, cmd, version.id, version.revision, selfApproval)), '42501');
  });
  await t.test('unreviewed legacy policy stays unavailable even with an exact approval under concurrency', async () => {
    // A second person cannot turn prose-only v1 groundwork into executable law.
    const approvalId = await a.approve(p.officer, p.owner, 'jurisdiction.activate_settings', hubId, digestInput);
    const outcomes = await Promise.allSettled([1, 2].map(() => a.cmd(p.officer, (trx, cmd) => hubConfig.activate(trx, cmd, version.id, version.revision, approvalId))));
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 0);
    assert.equal(outcomes.filter((r) => r.status === 'rejected').length, 2);
    const current = await a.as(p.owner, (trx) => hubConfig.current(trx, hubId));
    assert.equal(current.find((v) => v.domain === 'jurisdiction')?.id, undefined);
    const audit = await db.admin.query("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE object_id = $1 AND action = 'hub.config_activated'", [version.id]);
    assert.equal(audit.rows[0].n, 0);
  });
  await t.test('participant runtime has no sensitive-config projection: RLS and public accessor refuse', async () => {
    assert.deepEqual(await a.as(p.outsider, (trx) => hubConfig.current(trx, hubId)), []);
    await assert.rejects(runtime.query("SELECT trustwork.hubs_public_config($1, 'jurisdiction')", [hubId]), { code: '42501' });
    await assert.rejects(runtime.query("SELECT trustwork.hubs_active_payload($1, 'jurisdiction')", [hubId]), { code: '42501' });
  });
});

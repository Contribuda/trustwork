import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { launchGates, hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { verification, type DraftRecipeInput } from '../../packages/data/src/repositories/verification.js';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { actors, buildHubWorld, rejects, syncKernel } from '../hubs/helpers.js';

const h = await startHarness('verification_launch_gate');
const GATE = 'verification_recipe_enabled';

/**
 * The launch gate `verification_recipe_enabled` on real PostgreSQL under the runtime role: it reads the hub's recipes, so a
 * draft, a recipe of another hub and a configuration version with any payload do not satisfy it, an active recipe does, and
 * activating a version re-opens a passed gate. Every name is synthetic.
 */
test('the verification launch gate reads the recipes', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const admin = h.db.admin;
  await syncKernel(admin);
  const w = await buildHubWorld(admin);
  const a = actors(admin, h.pool, w);
  await withMaintenance(admin, async (trx) => {
    const release = (role: 'data-steward' | 'support-agent', permissions: string[]) => staffRoleDefinitions.release(trx, { version: 1, role, scopes: ['hub'], permissions: permissions as never,
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await release('data-steward', ['admin.hub.read', 'admin.hub.launch.check', 'admin.claims.read', 'admin.claims.policy.edit', 'admin.config.edit']);
    await release('support-agent', ['admin.hub.read']);
  });
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-gate-hub')).hub_id;
  const otherHubId = (await a.createHub('synthetic-gate-other')).hub_id;
  const steward = w.people.owner;
  await a.assign({ personId: steward, role: 'data-steward', scope: { kind: 'hub', hubId } });
  await a.assign({ personId: steward, role: 'data-steward', scope: { kind: 'hub', hubId: otherHubId } });
  // Staff without a claims permission: the checklist still has to answer for them.
  await a.assign({ personId: w.people.moderator, role: 'support-agent', scope: { kind: 'hub', hubId } });

  const recipe = (over: Partial<DraftRecipeInput> = {}): DraftRecipeInput => ({
    key: 'company-claim', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12, steps: [{ check: 'sanctions_screening', required: true }], badgeCategories: ['sanctions_screening_clear'], ...over,
  });
  const draft = (hub: string, over?: Partial<DraftRecipeInput>) => a.cmd(steward, (trx, ctx) => verification.draftRecipe(trx, ctx, hub, recipe(over)));
  const activate = (id: string, revision: number) => a.cmd(steward, (trx, ctx) => verification.activateRecipe(trx, ctx, id, revision));
  const confirmed = async (person = steward) => (await a.as(person, (trx) => launchGates.preconditions(trx, hubId))).get(GATE);
  const state = async () => (await a.as(steward, (trx) => launchGates.list(trx, hubId))).find((g) => g.gate === GATE);
  const check = () => a.cmd(steward, (trx, ctx) => launchGates.check(trx, ctx, hubId, GATE, randomUUID()));

  await t.test('no recipe, a draft, another hub\'s recipe and a configuration version do not satisfy it', async () => {
    assert.equal(await confirmed(), false);
    await draft(hubId);
    assert.equal(await confirmed(), false, 'a draft runs nothing');
    const foreign = await draft(otherHubId);
    await activate(foreign.id, foreign.revision);
    assert.equal(await confirmed(), false, 'a recipe of another hub');
    const version = await a.cmd(steward, (trx, ctx) => hubConfig.draft(trx, ctx, hubId, 'verification', { anything: true }));
    await a.cmd(steward, (trx, ctx) => hubConfig.activate(trx, ctx, version.id, version.revision, null));
    assert.equal(await confirmed(), false, 'a configuration version says nothing about the recipes');
    await rejects(check(), '23514');
  });

  await t.test('nobody calls the two new functions directly', async () => {
    for (const [name, args] of [['verification_has_active_recipe', `'${hubId}'::uuid`], ['hubs_reopen_gate', `'${hubId}'::uuid, '${GATE}', 'x'`]] as const) {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE trustwork_app');
        await assert.rejects(client.query(`SELECT trustwork.${name}(${args})`), (error: unknown) => (error as { code?: string }).code === '42501', name);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });

  await t.test('an active recipe satisfies it, for a reader who may not see recipes too', async () => {
    const drafted = (await a.as(steward, (trx) => verification.recipes(trx, hubId))).find((r) => r.status === 'draft')!;
    await activate(drafted.id, drafted.revision);
    assert.equal(await confirmed(), true);
    assert.equal(await confirmed(w.people.moderator), true, 'the checklist answers the same for staff without a claims permission');
    await check();
    assert.equal((await state())?.state, 'passed');
  });

  await t.test('a new active version re-opens the passed gate; the gate is confirmed again and a person checks it', async () => {
    const next = await draft(hubId, { recheckMonths: 6 });
    assert.equal((await state())?.state, 'passed', 'a draft changes nothing');
    await activate(next.id, next.revision);
    const gate = await state();
    assert.equal(gate?.state, 'invalidated');
    assert.equal(gate?.invalidation_reason, `recipe company-claim version ${next.version} activated`);
    assert.equal(await confirmed(), true, 'the engine still confirms it');
    await check();
    assert.equal((await state())?.state, 'passed');
  });
});

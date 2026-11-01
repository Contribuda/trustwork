import test from 'node:test';
import assert from 'node:assert/strict';
import { withPrincipal } from '@trustwork/data';
import { sql } from 'kysely';
import { PlansService } from '../../apps/api/src/modules/plans/plans.service.js';
import { CapabilityAuthority, mcpGate } from '../../apps/api/src/modules/agent-modules/authority.js';
import { ENGINE_MANIFESTS } from '../../apps/api/src/modules/agent-modules/ports.js';
import { PLAN_SERVICE_BINDINGS } from '../../apps/api/src/modules/agent-modules/plan-bindings.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, stateOf } from '../assistant/helpers.js';
import { principalFor } from '../data/helpers/seed.js';
import { activatePolicy, buildAgentWorld, engage, release, ok } from './helpers.js';
import { usHubPolicy } from './fixtures.js';

const h = await startHarness('agent_service_gate');
test('actual plan service transactions share the capability gate and retain owning resource authorization', { skip: h ? false : SKIP_REASON }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  await activatePolicy(h, world, usHubPolicy(world.hubId));
  const owner = h.client();
  await login(owner, 'petr');
  const outsider = h.client();
  await login(outsider, 'carl');
  const project = ok<{ id: string }>(await owner.post('/v1/projects', { owner: { kind: 'person', id: seed.people.petr }, name: 'Synthetic service gate', summary: null, leaderPersonId: null }), 201);
  const content = { summary: null, assumptions: [], budget: null, timeline: null, dependencies: [], items: [] };
  const plan = ok<{ draft: { id: string; revision: number } }>(await owner.post(`/v1/projects/${project.id}/plan`, { timeZone: 'UTC', actor: { via: 'person' }, content }), 201);
  const service = h.created.app.get(PlansService);

  await t.test('every exported plan operation is explicitly bound and SQL manifests equal the engine registry', async () => {
    const exported = Object.keys(PLAN_SERVICE_BINDINGS);
    assert.equal(exported.length, 26);
    const rows = (await h.db.admin.query<{ document: unknown }>('SELECT document FROM trustwork.agent_engine_manifest ORDER BY module_key')).rows;
    assert.deepEqual(rows.map(r => r.document), [...ENGINE_MANIFESTS].sort((a,b) => a.key.localeCompare(b.key)));
    await assert.rejects(as(h, seed.people.petr, trx => sql`UPDATE trustwork.agent_engine_manifest SET module_version = '9.9.9'`.execute(trx)));
  });
  await t.test('real HTTP read and direct agent-facing service read refuse the same disabled capability', async () => {
    assert.equal((await owner.get(`/v1/projects/${project.id}/plan`)).status, 200);
    assert.equal((await outsider.get(`/v1/projects/${project.id}/plan`)).status, 404, 'the shared gate does not grant resource access');
    const stop = await engage(world, 'agent_capability', { capabilityId: 'project_planner.get_plan' });
    const http = await owner.get(`/v1/projects/${project.id}/plan`);
    assert.equal(http.status, 403);
    await assert.rejects(service.get(project.id, await stateOf(h, owner, 'service-read')),
      (e: unknown) => (e as { details?: { reason?: string } }).details?.reason === 'kill_switch');
    await release(world, stop);
    assert.equal((await owner.get(`/v1/projects/${project.id}/plan`)).status, 200);
  });
  await t.test('a current capability stop denies an actual mutation without changing the draft', async () => {
    const stop = await engage(world, 'agent_capability', { capabilityId: 'project_planner.draft_plan' });
    const response = await owner.post(`/v1/projects/${project.id}/plan/versions/${plan.draft.id}/content`, { expectedRevision: plan.draft.revision, actor: { via: 'person' }, content: { ...content, summary: 'Must not be written' } });
    assert.equal(response.status, 403);
    assert.equal((await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.plan_version WHERE id=$1',[plan.draft.id])).rows[0]?.revision, plan.draft.revision);
    await release(world, stop);
  });
  await t.test('an actual service read holds authority until its transaction commits before a concurrent stop', async () => {
    const blocker = await h.db.admin.connect();
    let read: ReturnType<typeof owner.get> | undefined;
    let stop: ReturnType<typeof engage> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE trustwork.plan_version IN ACCESS EXCLUSIVE MODE');
      read = owner.get(`/v1/projects/${project.id}/plan`);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked = (await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%plan_version%'")).rows[0]!.n > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, 'the actual owning read reached its resource query after the shared gate');
      let stopped = false;
      stop = engage(world, 'agent_capability', { capabilityId: 'project_planner.get_plan' }).then(id => { stopped = true; return id; });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(stopped, false, 'the revoker cannot commit ahead of the admitted service transaction');
      await blocker.query('COMMIT');
      assert.equal((await read).status, 200);
      const id = await stop;
      assert.equal((await owner.get(`/v1/projects/${project.id}/plan`)).status, 403, 'the opposite order sees the committed stop');
      await release(world, id);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await read;
      await stop;
    }
  });

  await t.test('unknown capability and an MCP call without validated audience are unavailable', async () => {
    const authority = new CapabilityAuthority({ hubId: world.hubId });
    const principal = await principalFor(h.db.admin, seed.people.petr);
    await withPrincipal(h.pool, principal, async trx => {
      const d = await authority.check(trx, { personId: seed.people.petr, onBehalfCompanyId: null, representativeOf: null, connectionId: null }, 'unregistered.send_everything', 'communicate');
      assert.equal(d.allowed, false);
      const capability = ENGINE_MANIFESTS.find(m => m.key === 'project_planner')!.capabilities[0]!;
      assert.equal((await mcpGate(authority, trx, {} as never, capability)).decision, 'deny');
    });
  });
});

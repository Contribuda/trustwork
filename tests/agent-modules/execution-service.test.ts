import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionService } from '../../apps/api/src/modules/execution/execution.service.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { stateOf } from '../assistant/helpers.js';
import { buildAgreement, businessDate, type Fixture } from '../trust/helpers.js';
import { REGISTRY } from './fixtures.js';
import { activatePolicy, buildAgentWorld, engage, release } from './helpers.js';

const h = await startHarness('agent_execution_service');
test('execution service preserves party projections and applies shared policy to real reads and mutations', { skip: h ? false : SKIP_REASON }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  await activatePolicy(h, world, engineDefaultPolicy(world.hubId, REGISTRY));
  const f: Fixture = { admin: h.db.admin, app: h.db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
  const a = await buildAgreement(f, businessDate(-1));
  const client = h.client();
  const seller = h.client();
  const outsider = h.client();
  await login(client, 'petr');
  await login(seller, 'boris');
  await login(outsider, 'carl');
  const base = `/v1/execution/agreements/${a.agreement.id}`;
  const service = h.created.app.get(ExecutionService);
  assert.equal((await client.get(base)).status, 200);
  assert.equal((await seller.get(base)).status, 200);
  assert.equal((await outsider.get(base)).status, 404);
  const stop = await engage(world, 'agent_capability', { capabilityId: 'execution_evidence.get_execution' });
  assert.equal((await client.get(base)).status, 403);
  await assert.rejects(service.view(a.agreement.id, await stateOf(h, client, 'execution-service-read')),
    (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'kill_switch');
  await release(world, stop);
  const blocked = await engage(world, 'agent_capability', { capabilityId: 'execution_evidence.record_claim' });
  const response = await seller.post(`${base}/claims`, {
    obligationId: a.byKind.deliver.id, defectId: null, kind: 'goods_delivery', claimant: { kind: 'company', id: f.supplier },
    lines: [{ ref: 'q1', quantity: { value: '40', unit: 'm2' } }], period: null, performedAt: new Date().toISOString(),
    statement: 'Synthetic denied claim', supersedesClaimId: null, actor: { via: 'person' },
  });
  assert.equal(response.status, 403);
  assert.equal((await h.db.admin.query('SELECT id FROM trustwork.execution_claim WHERE agreement_id=$1', [a.agreement.id])).rowCount, 0);
  await release(world, blocked);
});

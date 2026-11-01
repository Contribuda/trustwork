import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TasksService } from '../../apps/api/src/modules/tasks/tasks.service.js';
import { NoTaskMandates } from '../../apps/api/src/modules/tasks/mandates.js';
import { ConfiguredElectronicRecords } from '../../apps/api/src/modules/transactions/electronic-records.js';
import { bindServiceCapabilities } from '../../apps/api/src/modules/agent-modules/service-bindings.js';
import { TASK_SERVICE_BINDINGS } from '../../apps/api/src/modules/agent-modules/task-bindings.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import { CreateTaskRequestCommandSchema } from '../../packages/contracts/src/tasks.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { stateOf } from '../assistant/helpers.js';
import { REGISTRY } from './fixtures.js';
import { activatePolicy, buildAgentWorld, engage, release } from './helpers.js';

const h = await startHarness('agent_task_service_port');
test('task binding calls the owning service and preserves missing mandate authority', { skip: h ? false : SKIP_REASON }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  await activatePolicy(h, world, engineDefaultPolicy(world.hubId, REGISTRY));
  const client = h.client();
  await login(client, 'petr');
  // Integration seam only: BILL-003 owns the production factory and every fee-confirming source transition.
  const service = bindServiceCapabilities(h.created.ctx!, h.services().principals, TASK_SERVICE_BINDINGS,
    principals => new TasksService(h.created.ctx!, principals, new NoTaskMandates(), new ConfiguredElectronicRecords()));
  const state = await stateOf(h, client, 'task-owning-port');
  assert.deepEqual(await service.listOpen(state), { requests: [] });
  const stop = await engage(world, 'agent_capability', { capabilityId: 'task_marketplace.list_open_requests' });
  await assert.rejects(service.listOpen(state), (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'kill_switch');
  await release(world, stop);
  const input = CreateTaskRequestCommandSchema.parse({
    source: { projectId: seed.project, itemKey: 'synthetic-step' }, audience: 'invited',
    terms: { title: 'Synthetic request', fields: ['scope'], scopeNote: null, milestoneItemKeys: ['synthetic-step'], acceptanceCriteria: ['Synthetic evidence'], responseDeadline: '2027-06-01T00:00:00Z', currency: 'USD' },
    privateConstraint: null, actor: { via: 'agent', mandateId: randomUUID() },
  });
  await assert.rejects(service.createRequest(input, state), (error: unknown) => (error as { code?: string }).code === 'access.mandate_scope');
  assert.equal((await h.db.admin.query('SELECT id FROM trustwork.task_request')).rowCount, 0);
});

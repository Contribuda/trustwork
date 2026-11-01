import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { AgentModuleManifestSchema } from '../../packages/contracts/src/agent-catalog.js';
import { TASK_MARKETPLACE_MANIFEST } from '../../packages/contracts/src/tasks.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import type { Harness } from '../backend/helpers/app.js';

/** Exact synthetic fake-order capability for AST recovery/accounting tests; never shipped or runtime-registerable. */
export const SYNTHETIC_ORDER_MANIFEST = AgentModuleManifestSchema.parse({
  ...TASK_MARKETPLACE_MANIFEST, key: 'deal_desk', version: '1.0.0', actions: ['place_order', 'communicate', 'negotiate'], safetySuite: 'tests/assistant/runtime.test.ts',
  capabilities: [{
    ...TASK_MARKETPLACE_MANIFEST.capabilities.find(c => c.id === 'task_marketplace.accept_offer')!,
    id: 'deal_desk.place_order', source: { kind: 'module', moduleKey: 'deal_desk', moduleVersion: '1.0.0' },
    mandateAction: 'place_order', confirmation: 'mandate',
  }, ...(['communicate', 'negotiate'] as const).map(action => ({
    ...TASK_MARKETPLACE_MANIFEST.capabilities.find(c => c.id === 'task_marketplace.send_offer')!,
    id: `deal_desk.${action}`, source: { kind: 'module' as const, moduleKey: 'deal_desk', moduleVersion: '1.0.0' },
    mandateAction: action, confirmation: 'mandate' as const,
  }))],
});
export async function installSyntheticOrderManifest(h: Harness): Promise<void> {
  const control = engineDefaultPolicy('synthetic', { manifests: [SYNTHETIC_ORDER_MANIFEST], extensions: [] }).modules[0];
  await withMaintenance(h.db.admin, trx => sql`INSERT INTO trustwork.agent_engine_manifest(module_key,module_version,document,default_control)
    VALUES('deal_desk','1.0.0',${JSON.stringify(SYNTHETIC_ORDER_MANIFEST)}::jsonb,${JSON.stringify(control)}::jsonb)`.execute(trx));
  await installSyntheticHandler(h, 'deal_desk.place_order', 'fake_orders', 'order.place');
  await installSyntheticHandler(h, 'deal_desk.place_order', 'fake_orders', 'place_order.submit');
  await installSyntheticHandler(h, 'deal_desk.communicate', 'fake_channel', 'communicate.submit');
  await installSyntheticHandler(h, 'deal_desk.negotiate', 'fake_channel', 'negotiate.counter');
}

/** Explicit local fake effect binding; no production capability can pick an arbitrary provider/operation. */
export async function installSyntheticHandler(h: Harness, capabilityId: string, provider: string, operation: string): Promise<void> {
  await withMaintenance(h.db.admin, trx => sql`INSERT INTO trustwork.agent_effect_handler(module_key,module_version,capability_id,provider,operation)
    VALUES(${capabilityId.split('.')[0]},'1.0.0',${capabilityId},${provider},${operation}) ON CONFLICT DO NOTHING`.execute(trx));
}

export const SYNTHETIC_HUMAN_MANIFEST = AgentModuleManifestSchema.parse({
  ...SYNTHETIC_ORDER_MANIFEST, key: 'execution_clerk', actions: ['confirm_execution'],
  capabilities: [{ ...SYNTHETIC_ORDER_MANIFEST.capabilities[0], id: 'execution_clerk.confirm_execution',
    source: { kind: 'module', moduleKey: 'execution_clerk', moduleVersion: '1.0.0' },
    mandateAction: 'confirm_execution', confirmation: 'person_each' }],
});
export async function installSyntheticHumanManifest(h: Harness): Promise<void> {
  const control = engineDefaultPolicy('synthetic', { manifests: [SYNTHETIC_HUMAN_MANIFEST], extensions: [] }).modules[0];
  await withMaintenance(h.db.admin, trx => sql`INSERT INTO trustwork.agent_engine_manifest(module_key,module_version,document,default_control)
    VALUES('execution_clerk','1.0.0',${JSON.stringify(SYNTHETIC_HUMAN_MANIFEST)}::jsonb,${JSON.stringify(control)}::jsonb)`.execute(trx));
}

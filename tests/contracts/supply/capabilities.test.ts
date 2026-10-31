import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../../packages/contracts/src/index.js';
import * as s from '../../../packages/contracts/src/supply/index.js';

const entries = s.SUPPLY_CAPABILITIES;
const caps = entries.map((e) => e.capability);

test('every capability declares kind, mandate action and confirmation, and passes the registry invariants', () => {
  assert.ok(entries.length >= 40);
  for (const e of entries) {
    const r = s.SupplyCapabilityEntrySchema.safeParse(e);
    assert.ok(r.success, `${e.capability.id}: ${!r.success ? JSON.stringify(r.error.issues) : ''}`);
    assert.deepEqual(c.capabilityViolations(e.capability), [], e.capability.id);
    assert.ok(c.CapabilityKindSchema.options.includes(e.capability.kind));
    assert.ok(c.CapabilityConfirmationSchema.options.includes(e.capability.confirmation));
    if (e.capability.kind === 'commit') {
      assert.notEqual(e.capability.mandateAction, null, `${e.capability.id} names its mandate action`);
      assert.notEqual(e.defaultApproval, null, `${e.capability.id} names its default approval`);
    }
    assert.ok(e.capability.id.startsWith(`${(e.capability.source as { moduleKey: string }).moduleKey}.`));
    assert.ok(s.SUPPLY_MODULE_KEYS.includes((e.capability.source as { moduleKey: string }).moduleKey as never));
    assert.match(e.capability.id, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'frozen id format (ADR 012 decision 36)');
  }
  assert.equal(new Set(caps.map((x) => x.id)).size, caps.length, 'ids are unique');
  for (const reused of s.REUSED_CAPABILITY_IDS) assert.equal(caps.some((x) => x.id === reused), false, `${reused} stays declared by its own module`);
});

test('approve is humanOnly: every approve capability is confirmed by a person each time and unreachable from connections', () => {
  const approving = entries.filter((e) => e.capability.mandateAction === 'approve');
  assert.deepEqual(approving.map((e) => e.capability.id).sort(), ['payables_desk.clear_risk_signal', 'procurement.activate_route', 'procurement.decide_approval']);
  for (const e of approving) {
    assert.equal(e.humanOnly, true);
    assert.equal(e.capability.confirmation, 'person_each');
    assert.deepEqual(e.defaultApproval, { mode: 'ask_each' });
    assert.equal(e.capability.surfaces.includes('mcp') || e.capability.surfaces.includes('a2a'), false);
  }
  const accept = entries.find((e) => e.capability.id === 'receiving_clerk.accept_delivered_goods')!;
  assert.equal(accept.humanOnly, true, 'accepting delivered goods stays human');
  const payee = entries.find((e) => e.capability.id === 'core.change_payee')!;
  assert.equal(payee.capability.kind, 'govern');
  assert.equal(payee.capability.confirmation, 'first_party_step_up');
  // The schema refuses an approve entry that is not human-only or that a connection could reach.
  const decide = entries.find((e) => e.capability.id === 'procurement.decide_approval')!;
  assert.equal(s.SupplyCapabilityEntrySchema.safeParse({ ...decide, humanOnly: false }).success, false);
  assert.equal(s.SupplyCapabilityEntrySchema.safeParse({ ...decide, capability: { ...decide.capability, confirmation: 'mandate' } }).success, false);
  assert.equal(s.SupplyCapabilityEntrySchema.safeParse({ ...decide, capability: { ...decide.capability, surfaces: ['ui', 'agent', 'mcp'] } }).success, false);
  const release = entries.find((e) => e.capability.id === 'payables_desk.release_payments')!;
  assert.equal(release.capability.budgetKind, 'transaction');
  assert.equal(s.SupplyCapabilityEntrySchema.safeParse({ ...release, defaultApproval: { mode: 'pre_authorized' } }).success, false);
});

test('every reference resolves to an exported schema and every design operation maps to an entry', async () => {
  const modules: Record<string, Record<string, unknown>> = { supply: s.SUPPLY_SCHEMAS };
  for (const cap of caps) {
    for (const ref of [cap.input, cap.output]) {
      if (!modules[ref.contract]) modules[ref.contract] = await import(`../../../packages/contracts/src/${ref.contract}.js`) as Record<string, unknown>;
      assert.ok(modules[ref.contract]![ref.schema] !== undefined, `${cap.id}: ${ref.contract}.${ref.schema}`);
    }
  }
  const served = new Set(entries.flatMap((e) => e.designOperations));
  for (const op of s.DESIGN_PARITY_OPERATIONS) assert.ok(served.has(op) || op in s.DESIGN_OPERATIONS_SERVED_ELSEWHERE, `design row ${op} has a capability`);
  for (const op of served) assert.ok((s.DESIGN_PARITY_OPERATIONS as readonly string[]).includes(op), `${op} is a design row`);
});

test('parity: every entry is reachable from the interface and the agent; the entries build a registry through module manifests', () => {
  assert.deepEqual(c.parityGaps(caps), []);
  const byModule = new Map<string, c.AgentCapability[]>();
  for (const cap of caps) {
    const key = (cap.source as { moduleKey: string }).moduleKey;
    byModule.set(key, [...(byModule.get(key) ?? []), cap]);
  }
  const manifests: c.AgentModuleManifest[] = [...byModule].map(([key, list]) => ({
    key, version: '1.0.0', family: key === 'core' ? 'core' : 'operations', status: 'proposed',
    actions: [...new Set(list.flatMap((x) => (x.mandateAction ? [x.mandateAction] : [])))],
    capabilities: list, meters: [...new Set(list.flatMap((x) => x.meters))], suits: ['general_contractor'], freeFloor: [], safetySuite: `tests/agent-modules/supply/${key}`,
  }));
  const registry = c.buildCapabilityRegistry({ registryVersion: 1, hubId: null, manifests, extensionCapabilities: [] });
  assert.equal(registry.capabilities.length, caps.length);
  assert.deepEqual(s.supplyAgentCapabilities().map((x) => x.id), caps.map((x) => x.id));
});

test('connections can only propose human-only commits and can never reach approvals or governance', () => {
  const connection = c.AGENT_CATALOG_EXAMPLES.ExternalConnection[0] as c.ExternalConnection;
  const wide: c.ExternalConnection = { ...connection, scopes: ['read.public', 'read.me', 'read.contexts', 'read.private', 'propose', 'act'], privateDataClasses: ['budgets', 'negotiation_constraints', 'private_projects', 'drafts'] };
  for (const e of entries) {
    const verdict = c.connectionMayInvoke(e.capability, wide);
    if (e.capability.kind === 'govern' || e.capability.mandateAction === 'approve') assert.equal(verdict, 'deny', e.capability.id);
    else if (e.humanOnly) assert.equal(verdict, 'propose_only', e.capability.id);
    else if (e.capability.kind === 'commit') assert.equal(verdict, 'execute_under_mandate', e.capability.id);
  }
});

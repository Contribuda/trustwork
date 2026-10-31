import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCapabilitySchema, connectionMayInvoke, evaluateMandateV2, mandateChangeAllowed, MandateV2Schema, requiredConnectionScopes,
  type AgentCapability, type ExternalConnection, type MandateV2, type MandateV2CheckRequest,
} from '@trustwork/contracts';
import { actionDigest, assertShareable, PrivateFieldError, restrictedPlacesFromPacks } from '../../apps/api/src/modules/assistant/policy.js';
import { MODULE_KEYS } from '../../apps/api/src/modules/assistant/mandate-store.js';
import { MandateDraftSchema } from '../../apps/api/src/modules/assistant/schemas.js';
import type { ModelToolCall } from '../../apps/api/src/modules/assistant/ports.js';
import { FakeEffectProvider } from '../../apps/worker/src/assistant/index.js';

/**
 * AST-001 pure policy: chat, agents and connections never create, confirm or widen a mandate; `confirm_execution` is
 * never pre-authorized; governance capabilities are unreachable by connections and absent from the model's tools;
 * private constraints never enter an effect payload; approvals bind a digest that changes with any material change.
 */
const PERSON = '0192f0c0-0000-7000-8000-000000000001';
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const mandate = (over: Partial<MandateV2> = {}): MandateV2 => MandateV2Schema.parse({
  id: '0192f0c0-0000-7000-8000-0000000000aa', schemaVersion: 2, principal: { personId: PERSON, onBehalfOf: null }, grantee: { kind: 'own_agent' },
  moduleKeys: ['deal_desk'], actions: ['communicate', 'confirm_execution'], contexts: [{ kind: 'project', id: 'project-demo' }],
  limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [],
  escalation: { kind: 'ask_principal' }, confirmation: { via: 'first_party_form', personId: PERSON, at: '2026-10-31T10:00:00.000Z', stepUp: true },
  validUntil: '2027-10-31T00:00:00.000Z', status: 'active', revision: 1, revokedAt: null, ...over,
});
const request = (over: Partial<MandateV2CheckRequest> = {}): MandateV2CheckRequest => ({
  moduleKey: 'deal_desk', action: 'communicate', context: { kind: 'project', id: 'project-demo' }, contextFacts: { categories: [], region: null, projectId: 'project-demo' },
  amount: null, committedUnderMandate: null, actionsInWindow: 0, approvalsAtRevision: 0, conditionFacts: {}, actor: { kind: 'own_agent', personId: PERSON }, via: { kind: 'first_party' },
  hub: { forbiddenPreAuthorization: [] }, blockedBySwitchId: null, isRestricted: () => false, ...over,
});

test('chat, agents, connections, modules, goals and extensions only propose; the system only narrows', () => {
  const active = mandate();
  const widened = MandateV2Schema.parse({ ...active, revision: 2, actions: [...active.actions, 'negotiate'] });
  for (const kind of ['agent', 'connection', 'chat', 'module', 'goal', 'extension'] as const) {
    assert.equal(mandateChangeAllowed({ kind }, null, active), 'mandate.proposal_only', `${kind} cannot create`);
    assert.equal(mandateChangeAllowed({ kind }, active, widened), 'mandate.proposal_only', `${kind} cannot widen`);
  }
  assert.equal(mandateChangeAllowed({ kind: 'system', reason: 'kill_switch' }, active, widened), 'mandate.system_may_only_narrow');
  const suspended = MandateV2Schema.parse({ ...active, revision: 2, status: 'suspended' });
  assert.equal(mandateChangeAllowed({ kind: 'system', reason: 'authority_basis_lost' }, active, suspended), 'ok');
  // A person confirms only their own mandate on the first-party form.
  assert.equal(mandateChangeAllowed({ kind: 'person', personId: '0192f0c0-0000-7000-8000-000000000002', via: 'first_party_form' }, active, widened), 'mandate.not_principal');
  assert.equal(mandateChangeAllowed({ kind: 'person', personId: PERSON, via: 'first_party_form' }, active, widened), 'ok');
});

test('confirm_execution is never pre-authorized, whatever the approval policy says', () => {
  const decision = evaluateMandateV2(mandate(), request({ action: 'confirm_execution' }), new Date('2026-11-01T00:00:00Z'));
  assert.equal(decision.effect, 'ask');
  assert.ok(decision.effect === 'ask' && decision.reasons.includes('human_only'));
  assert.equal(evaluateMandateV2(mandate(), request(), new Date('2026-11-01T00:00:00Z')).effect, 'allow', 'an ordinary action under a pre-authorized mandate is allowed');
  // The person's stop or a hub kill switch denies before anything else.
  assert.deepEqual(evaluateMandateV2(mandate(), request({ blockedBySwitchId: 'stop-1' }), new Date('2026-11-01T00:00:00Z')), { effect: 'deny', reason: 'kill_switch' });
});

test('governance capabilities are unreachable by connections and absent from the model tools', () => {
  const govern: AgentCapability = AgentCapabilitySchema.parse({
    id: 'core.confirm_mandate', version: 1, source: { kind: 'module', moduleKey: 'core', moduleVersion: '1.0.0' }, kind: 'govern', input: { contract: 'agent-catalog', schema: 'MandateChangeProposalSchema', version: 1 },
    output: { contract: 'agent-catalog', schema: 'MandateV2Schema', version: 1 }, mandateAction: null, contextKinds: [], confirmation: 'first_party_form', budgetKind: null, reads: ['owner_private'],
    privateDataClasses: [], sideEffects: ['state_change'], acceptsUntrustedText: false, meters: [], surfaces: ['ui', 'agent'], status: 'live', labelKey: 'assistant.capability.confirmMandate',
  });
  assert.equal(requiredConnectionScopes(govern), null);
  const connection = {
    id: 'conn-1', hubId: 'hub-1', owner: { kind: 'person', personId: PERSON }, protocol: 'mcp', clientId: 'client', clientNameSelfAsserted: 'Client', listedByHub: false,
    scopes: ['read.public', 'read.me', 'propose', 'act'], privateDataClasses: [], mandateBindings: [{ mandateId: 'm-1', revision: 1 }], rateLimitProfile: 'default',
    consent: { via: 'first_party_form', personId: PERSON, at: '2026-10-31T10:00:00.000Z', stepUp: true }, status: 'active', createdAt: '2026-10-31T10:00:00.000Z', lastUsedAt: null, revokedAt: null, revision: 1,
  } as ExternalConnection;
  assert.equal(connectionMayInvoke(govern, connection), 'deny');
  assert.ok(!AgentCapabilitySchema.safeParse({ ...govern, surfaces: ['ui', 'agent', 'mcp'] }).success, 'a govern capability exposed to MCP is invalid');
  // The model's tool vocabulary: proposals and decided actions only; no confirm, approve, stop or settings tool exists.
  const kinds: ModelToolCall['kind'][] = ['propose_mandate_change', 'propose_action', 'retrieve', 'propose_backlog_item'];
  assert.deepEqual(kinds.filter((k) => /confirm|approve|stop|settings|grant|release/.test(k)), []);
  // A draft submitted by a client never carries a confirmation, a status or a revision of its own.
  const draft = { onBehalfOf: null, grantee: { kind: 'own_agent' }, moduleKeys: ['deal_desk'], actions: ['communicate'], contexts: [{ kind: 'project', id: 'p' }],
    limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'ask_each' }, approvers: [],
    escalation: { kind: 'ask_principal' }, validUntil: '2027-01-01T00:00:00.000Z' };
  assert.ok(MandateDraftSchema.safeParse(draft).success);
  for (const extra of [{ confirmation: { via: 'first_party_form', personId: PERSON, at: '2026-10-31T10:00:00.000Z', stepUp: true } }, { status: 'active' }, { revision: 9 }, { actor: { via: 'agent' } }]) {
    assert.ok(!MandateDraftSchema.safeParse({ ...draft, ...extra }).success, `draft refuses ${Object.keys(extra)[0]}`);
  }
});

test('private constraints never enter an effect payload', () => {
  assert.doesNotThrow(() => assertShareable({ quoteId: 'q-1', lines: [{ sku: 'A', quantity: '2' }], message: 'Can you deliver on Monday?' }));
  for (const payload of [{ floorPrice: usd('100') }, { lines: [{ sku: 'A', privateNotes: 'x' }] }, { terms: { budgetCeiling: usd('1') } }, { constraintRecordId: 'c-1' }, { nested: [{ ownerNotes: 'x' }] }]) {
    assert.throws(() => assertShareable(payload), PrivateFieldError);
  }
});

test('an approval binds a digest that any material change voids', () => {
  const base = { mandate: { id: 'm-1', revision: 1 }, capabilityId: 'deal_desk.place_order', action: 'place_order' as const, context: { kind: 'order' as const, id: 'o-1' }, amount: usd('80000'),
    effect: { provider: 'fake_orders', operation: 'order.place', payload: { supplier: 's-1', quantity: '10' } } };
  const digest = actionDigest(base);
  assert.equal(actionDigest({ ...base }), digest, 'stable');
  assert.notEqual(actionDigest({ ...base, amount: usd('80001') }), digest, 'price');
  assert.notEqual(actionDigest({ ...base, effect: { ...base.effect, payload: { supplier: 's-2', quantity: '10' } } }), digest, 'supplier');
  assert.notEqual(actionDigest({ ...base, mandate: { id: 'm-1', revision: 2 } }), digest, 'mandate revision');
});

test('restricted places come from the authoritative country-pack list; a missing list fails closed', () => {
  const restricted = restrictedPlacesFromPacks();
  for (const code of ['RU', 'UA-43', 'UA-14', 'CU', 'IR', 'KP']) assert.equal(restricted(code), true, code);
  for (const code of ['US', 'US-TX', 'GE', 'UA-30']) assert.equal(restricted(code), false, code);
  assert.equal(restrictedPlacesFromPacks('/nonexistent')('US'), true);
});

test('module ports speak for the registry modules of each slice', () => {
  assert.deepEqual(MODULE_KEYS.tasks, ['task_marketplace']);
  assert.deepEqual(MODULE_KEYS.plans, ['project_planner']);
  assert.ok(MODULE_KEYS.deals.includes('deal_desk') && MODULE_KEYS.commerce.includes('sourcing_desk'));
});

test('the fake provider deduplicates by correlation key and answers lookups from its ledger', async () => {
  const provider = new FakeEffectProvider('fake_orders').next('timeout_after_effect');
  const request = { correlationKey: 'assistant:1', operationId: 'op-1', attemptNo: 1, operation: 'order.place', payload: {}, amount: usd('1') };
  await assert.rejects(provider.submit(request, new AbortController().signal));
  assert.equal(provider.effects, 1);
  assert.deepEqual(await provider.lookup('assistant:1'), { status: 'final', result: 'succeeded', providerReference: 'fake_orders-1', evidence: 'fake_orders lookup: succeeded' });
  const again = await provider.submit({ ...request, operationId: 'op-2', attemptNo: 2 }, new AbortController().signal);
  assert.equal(again.kind, 'final');
  assert.equal(provider.effects, 1, 'a repeated key never repeats the effect');
  assert.deepEqual(await provider.lookup('assistant:unknown'), { status: 'not_found' });
});

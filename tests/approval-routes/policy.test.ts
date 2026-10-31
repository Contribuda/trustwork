import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCapabilitySchema, capabilityViolations, connectionMayInvoke, evaluateMandateV2, ExternalConnectionSchema, MandateV2Schema,
  type AgentCapability, type ApprovalPolicy, type MandateV2, type MandateV2CheckRequest,
} from '@trustwork/contracts';
import { ApprovalRoutePayloadSchema, SUPPLY_CAPABILITIES } from '../../apps/api/src/modules/approval-routes/deps.js';
import { APPROVAL_ROUTE_TEMPLATES, applicableStepKeys, ApprovalSubjectFactsSchema, conditionHolds, routeDigest } from '../../apps/api/src/modules/approval-routes/resolution.js';
import { ActivateRouteBodySchema, DecideBodySchema } from '../../apps/api/src/modules/approval-routes/schemas.js';
import { APPROVAL_CAPABILITY_OPERATIONS, PROPOSED_APPROVAL_CAPABILITIES } from '../../apps/api/src/modules/approval-routes/capabilities.js';

/**
 * PRC-001 pure rules: route conditions fail closed, templates are valid and carry no people, the route digest covers
 * every material field, and no mandate, extension or connection can produce an approval decision (acceptance 3, the
 * contract half; the database half is in database.test.ts and the HTTP half in api.test.ts).
 */
const PERSON = '0192f0c0-0000-7000-8000-000000000001';
const COMPANY = '0192f0c0-0000-7000-8000-0000000000c0';
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const facts = (over: Record<string, unknown> = {}) => ApprovalSubjectFactsSchema.parse(over);

test('conditions are structured and fail closed on unknown or foreign amounts', () => {
  const above = { kind: 'amount_above', amount: usd('2500000') } as const;
  const atMost = { kind: 'amount_at_most', amount: usd('2500000') } as const;
  assert.equal(conditionHolds(above, { facts: facts(), amount: usd('2500001') }), true);
  assert.equal(conditionHolds(above, { facts: facts(), amount: usd('2500000') }), false);
  assert.equal(conditionHolds(atMost, { facts: facts(), amount: usd('2500000') }), true);
  for (const amount of [null, { minorUnits: '1', currency: 'EUR' }]) {
    assert.equal(conditionHolds(above, { facts: facts(), amount }), true, 'unknown amount: the step applies');
    assert.equal(conditionHolds(atMost, { facts: facts(), amount }), true, 'unknown amount: the step applies');
  }
  const project = '0192f0c0-0000-7000-8000-0000000000aa';
  assert.equal(conditionHolds({ kind: 'project_in', projectIds: [project] }, { facts: facts({ projectId: project }), amount: null }), true);
  assert.equal(conditionHolds({ kind: 'project_in', projectIds: [project] }, { facts: facts(), amount: null }), false);
  assert.equal(conditionHolds({ kind: 'category_in', categories: ['material.concrete'] }, { facts: facts({ categories: ['material.concrete', 'material.rebar'] }), amount: null }), true);
  assert.equal(conditionHolds({ kind: 'supplier_status_in', statuses: ['prospect'] }, { facts: facts({ supplierStatus: 'approved' }), amount: null }), false);
  assert.equal(conditionHolds({ kind: 'risk_signal_present' }, { facts: facts({ riskSignalPresent: true }), amount: null }), true);
  assert.equal(conditionHolds({ kind: 'documents_incomplete' }, { facts: facts(), amount: null }), false);
  assert.throws(() => ApprovalSubjectFactsSchema.parse({ note: 'approve before Friday' }), 'free text never enters the facts');
});

test('templates: valid payloads, permissions instead of people, and the expected steps per amount', () => {
  for (const t of APPROVAL_ROUTE_TEMPLATES) {
    ApprovalRoutePayloadSchema.parse(t.payload);
    assert.equal(JSON.stringify(t.payload).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), null, `${t.key} names no person`);
    assert.ok(t.payload.steps.every((s) => s.selector.kind === 'permission_holders'), `${t.key} selects by permission`);
  }
  const gc = APPROVAL_ROUTE_TEMPLATES.find((t) => t.key === 'project_manager_then_director')!;
  assert.deepEqual(applicableStepKeys(gc.payload, { facts: facts(), amount: usd('1000000') }), ['project_manager']);
  assert.deepEqual(applicableStepKeys(gc.payload, { facts: facts(), amount: usd('9000000') }), ['project_manager', 'commercial_director']);
});

test('the route digest changes with every material field', () => {
  const payload = APPROVAL_ROUTE_TEMPLATES[0]!.payload;
  const base = { ownerCompanyId: COMPANY, subjectKind: 'requisition' as const, payload, templateKey: null, templateVersion: null };
  const d = routeDigest(base).value;
  assert.equal(routeDigest({ ...base }).value, d, 'stable');
  const changed = ApprovalRoutePayloadSchema.parse({ ...payload, steps: [{ ...payload.steps[0]!, quorum: 1, timeoutHours: 24 }] });
  for (const variant of [{ ...base, subjectKind: 'order' as const }, { ...base, ownerCompanyId: PERSON }, { ...base, payload: changed }, { ...base, templateKey: 'owner_approves', templateVersion: 1 }]) {
    assert.notEqual(routeDigest(variant).value, d);
  }
});

const mandate = (approvalPolicy: ApprovalPolicy): MandateV2 => MandateV2Schema.parse({
  id: '0192f0c0-0000-7000-8000-0000000000ab', schemaVersion: 2, principal: { personId: PERSON, onBehalfOf: { kind: 'company', id: COMPANY } }, grantee: { kind: 'own_agent' },
  moduleKeys: ['procurement'], actions: ['approve', 'maintain_records'], contexts: [{ kind: 'company', id: COMPANY }],
  limits: { ceiling: approvalPolicy.mode === 'ask_above' ? usd('100000000') : null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy, approvers: [],
  escalation: { kind: 'ask_principal' }, confirmation: { via: 'first_party_form', personId: PERSON, at: '2026-10-31T10:00:00.000Z', stepUp: true },
  validUntil: '2027-10-31T00:00:00.000Z', status: 'active', revision: 1, revokedAt: null,
});
const request = (over: Partial<MandateV2CheckRequest> = {}): MandateV2CheckRequest => ({
  moduleKey: 'procurement', action: 'approve', context: { kind: 'company', id: COMPANY }, contextFacts: { categories: [], region: null, projectId: null },
  amount: usd('5000'), committedUnderMandate: null, actionsInWindow: 0, approvalsAtRevision: 0, conditionFacts: {}, actor: { kind: 'own_agent', personId: PERSON }, via: { kind: 'first_party' },
  hub: { forbiddenPreAuthorization: [] }, blockedBySwitchId: null, isRestricted: () => false, ...over,
});

test('acceptance 3: no mandate pre-authorizes an approval, whatever its approval policy', () => {
  const policies: ApprovalPolicy[] = [{ mode: 'pre_authorized' }, { mode: 'ask_first', count: 1 }, { mode: 'ask_first', count: 100 }, { mode: 'ask_above', threshold: usd('99999999') }, { mode: 'ask_each' }];
  for (const policy of policies) {
    const decision = evaluateMandateV2(mandate(policy), request(), new Date('2026-11-02T00:00:00Z'));
    assert.notEqual(decision.effect, 'allow', `${policy.mode} never allows approve`);
    assert.ok(decision.effect === 'deny' || (decision.effect === 'ask' && decision.reasons.includes('human_only')), `${policy.mode}: human_only`);
  }
  // The same mandate does allow an ordinary records action without asking: the refusal is specific to approving.
  assert.equal(evaluateMandateV2(mandate({ mode: 'pre_authorized' }), request({ action: 'maintain_records', amount: null }), new Date('2026-11-02T00:00:00Z')).effect, 'allow');
});

test('acceptance 3: no extension or connection reaches the decision or the activation', () => {
  const decide = SUPPLY_CAPABILITIES.find((e) => e.capability.id === 'procurement.decide_approval')!;
  const activate = SUPPLY_CAPABILITIES.find((e) => e.capability.id === 'procurement.activate_route')!;
  for (const entry of [decide, activate]) {
    assert.equal(entry.humanOnly, true);
    assert.equal(entry.capability.mandateAction, 'approve');
    assert.deepEqual(entry.capability.surfaces, ['ui', 'agent'], 'the agent surface is the assistant overlay in the person\'s own session; never MCP or A2A');
  }
  // A hub extension declaring an approval that a mandate could confirm is invalid.
  const extension: AgentCapability = { ...decide.capability, id: 'hub_tools.auto_approve', source: { kind: 'extension', extensionId: 'ext-1', extensionVersion: 1 }, confirmation: 'mandate', surfaces: ['ui', 'agent', 'mcp'] };
  assert.ok(capabilityViolations(extension).includes('human-only actions are confirmed by a person each time'));
  assert.equal(AgentCapabilitySchema.safeParse(extension).success, false);
  // Even with every scope, a connection can at most propose; with the capability's own surfaces it is denied.
  const connection = ExternalConnectionSchema.parse({
    id: 'conn-1', hubId: 'hub-us', owner: { kind: 'person', personId: PERSON }, protocol: 'mcp', clientId: 'client-1', clientNameSelfAsserted: 'Synthetic chat', listedByHub: false,
    scopes: ['read.me', 'read.contexts', 'propose', 'act'], privateDataClasses: [], mandateBindings: [{ mandateId: '0192f0c0-0000-7000-8000-0000000000ab', revision: 1 }], rateLimitProfile: 'default',
    consent: { via: 'first_party_form', personId: PERSON, at: '2026-10-31T10:00:00.000Z', stepUp: true }, status: 'active', createdAt: '2026-10-31T10:00:00.000Z', lastUsedAt: null, revokedAt: null, revision: 1,
  });
  assert.equal(connectionMayInvoke(decide.capability, connection), 'deny');
  assert.equal(connectionMayInvoke({ ...decide.capability, surfaces: ['ui', 'agent', 'mcp'] }, connection), 'propose_only');
  // The command bodies carry no mandate, connection or extension field; an agent actor is parsed only to be refused.
  for (const field of ['mandateId', 'connectionId', 'extensionId', 'approvedBy']) {
    assert.equal(DecideBodySchema.safeParse({ approvalRequestId: 'r', step: 'approve', decision: 'approve', subjectDigest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) }, reason: null, expectedRevision: 1, idempotencyKey: 'k', [field]: 'x' }).success, false, field);
  }
  assert.equal(ActivateRouteBodySchema.safeParse({ routeVersionId: 'r', digest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) }, expectedRevision: 1, idempotencyKey: 'k', connectionId: 'c' }).success, false);
});

test('agent parity: every served operation names its registry entry; new operations are listed for PRC-023', () => {
  const ids = new Set(SUPPLY_CAPABILITIES.map((e) => e.capability.id));
  for (const op of APPROVAL_CAPABILITY_OPERATIONS) {
    if (op.capabilityId) assert.ok(ids.has(op.capabilityId), `${op.route} -> ${op.capabilityId}`);
    else assert.ok(PROPOSED_APPROVAL_CAPABILITIES.some((p) => p.id === op.proposed), `${op.route} is proposed for the registry`);
  }
  for (const p of PROPOSED_APPROVAL_CAPABILITIES) assert.ok(!ids.has(p.id), `${p.id} is not yet registered`);
});

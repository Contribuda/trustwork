import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isRestricted } from '@trustwork/country-packs';
import * as c from '../../packages/contracts/src/index.js';
import * as catalog from '../../packages/contracts/src/agent-catalog.js';

/* Synthetic records only (US demo hub, USD). */
const at = '2026-10-31T15:00:00Z';
const now = new Date('2026-11-01T12:00:00Z');
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const person = 'person-demo-ana';
const colleague = 'person-demo-ben';
const company = 'company-demo-lone-star-facades';
const confirmation = { via: 'first_party_form' as const, personId: person, at, stepUp: false };
const ex = c.AGENT_CATALOG_EXAMPLES;
const baseMandate = ex.MandateV2[0] as c.MandateV2;
const baseConnection = ex.ExternalConnection[0] as c.ExternalConnection;
const coreCaps = ex.AgentCapability as readonly c.AgentCapability[];
const cap = (id: string) => coreCaps.find((x) => x.id === id)!;

/** A pre-authorized personal mandate covering every v2 action with budgets, so only approval logic can stop an action. */
const wide: c.MandateV2 = {
  ...baseMandate,
  id: 'mandate-demo-wide',
  principal: { personId: person, onBehalfOf: null },
  moduleKeys: ['execution_clerk', 'quoting'],
  actions: [...c.MANDATE_ACTIONS_V2],
  contexts: [{ kind: 'agreement', id: 'agreement-demo-1' }, { kind: 'rfq', categories: ['facade_works'], regions: ['US-TX'], projectId: null }],
  limits: { ceiling: usd('100000000'), perActionCeiling: null, transactionBudgetId: 'budget-demo-tx', platformBudgetId: 'budget-demo-platform', perWindow: null },
  conditions: [],
  approvalPolicy: { mode: 'pre_authorized' },
  approvers: [],
};
const request = (over: Partial<c.MandateV2CheckRequest> = {}): c.MandateV2CheckRequest => ({
  moduleKey: 'execution_clerk',
  action: 'place_order',
  context: { kind: 'agreement', id: 'agreement-demo-1' },
  contextFacts: { categories: [], region: 'US-TX', projectId: null },
  amount: usd('100000'),
  committedUnderMandate: null,
  actionsInWindow: 0,
  approvalsAtRevision: 0,
  conditionFacts: {},
  actor: { kind: 'own_agent', personId: person },
  via: { kind: 'first_party' },
  hub: { forbiddenPreAuthorization: [] },
  blockedBySwitchId: null,
  isRestricted,
  ...over,
});
const evaluate = (m: c.MandateV2, over: Partial<c.MandateV2CheckRequest> = {}) => c.evaluateMandateV2(m, request(over), now);
const valid = (m: c.MandateV2) => c.MandateV2Schema.safeParse(m).success;

/* ---------- Examples, JSON Schema, contract references ---------- */

test('every example validates against its schema and every schema has a versioned JSON Schema', () => {
  const json = c.agentCatalogJsonSchemas();
  for (const [name, schema] of Object.entries(c.AGENT_CATALOG_SCHEMAS)) {
    const examples = ex[name as c.AgentCatalogSchemaName];
    assert.ok(examples.length > 0, `${name} has an example`);
    for (const example of examples) {
      const result = schema.safeParse(example);
      assert.ok(result.success, `${name}: ${JSON.stringify(result.error?.issues)}`);
    }
    const doc = json[name as c.AgentCatalogSchemaName];
    assert.equal(doc.$id, `urn:trustwork:contracts:agent-catalog:v${c.AGENT_CATALOG_CONTRACT_VERSION}:${name}`);
    assert.equal(doc.$schema, 'https://json-schema.org/draft/2020-12/schema');
  }
  assert.equal(json.MandateV2.additionalProperties, false, 'strict objects stay closed in JSON Schema');
});

test('every capability contract reference resolves to an exported schema of that contract file', async () => {
  for (const capability of coreCaps) {
    for (const ref of [capability.input, capability.output]) {
      const mod = (await import(`../../packages/contracts/src/${ref.contract}.js`)) as Record<string, unknown>;
      assert.ok(mod[ref.schema] && typeof (mod[ref.schema] as { safeParse?: unknown }).safeParse === 'function', `${capability.id}: ${ref.contract}.${ref.schema}`);
    }
  }
});

test('the reference registry builds from module manifests, has no parity gaps and lets connections reach no governance', () => {
  const registry = c.buildCapabilityRegistry({ registryVersion: 1, hubId: null, manifests: ex.AgentModuleManifest as c.AgentModuleManifest[], extensionCapabilities: [] });
  assert.equal(registry.capabilities.length, coreCaps.length);
  assert.deepEqual(c.parityGaps(registry.capabilities), []);
  for (const capability of registry.capabilities) {
    if (capability.kind === 'govern') {
      assert.equal(c.requiredConnectionScopes(capability), null);
      assert.equal(c.connectionMayInvoke(capability, { ...baseConnection, scopes: ['read.public', 'read.me', 'read.contexts', 'read.private', 'propose', 'act'], privateDataClasses: ['budgets'] }), 'deny');
    }
  }
});

test('MCP compatibility: scope, data-class and mandate-kind vocabularies are importable enums', () => {
  assert.deepEqual(c.ConnectionScopeSchema.options, ['read.public', 'read.me', 'read.contexts', 'read.private', 'propose', 'act']);
  assert.deepEqual(c.PrivateDataClassSchema.options, ['negotiation_constraints', 'budgets', 'private_projects', 'drafts']);
  assert.ok(c.MandateActionV2Schema.options.includes('confirm_execution'));
  assert.ok(c.CONNECTION_FORBIDDEN_OPERATIONS.includes('create_confirm_or_widen_mandate'));
});

/* ---------- Frozen v1 stays valid; v2 is a superset ---------- */

test('frozen v1 shapes are unchanged and v1 fixtures still validate', () => {
  assert.deepEqual(Object.keys(c.MandateSchema.shape), ['id', 'principal', 'actions', 'contexts', 'limits', 'conditions', 'validUntil', 'status', 'revision', 'revokedAt']);
  assert.deepEqual(c.MandateActionSchema.options, ['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'place_order', 'accept_order', 'generate_deliverable']);
  assert.deepEqual(Object.keys(c.ActionIntentSchema.shape), ['id', 'runId', 'mandate', 'action', 'context', 'amount', 'actionDigest', 'state', 'reservationId', 'attemptCount', 'effectCorrelationKey', 'outcome', 'revision']);
  for (const action of c.MandateActionSchema.options) assert.ok(c.MandateActionV2Schema.options.includes(action), `v2 keeps ${action}`);
  for (const kind of ['project', 'rfq', 'quote', 'agreement'] as const) assert.ok(c.ContextKindV2Schema.options.includes(kind));
  const dir = new URL('../../packages/contracts/fixtures/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const fixture = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { records: Record<string, unknown[]> };
    for (const [name, rows] of Object.entries(fixture.records)) {
      const schema = (c as Record<string, unknown>)[`${name}Schema`] as { safeParse(v: unknown): { success: boolean } };
      for (const row of rows) assert.ok(schema.safeParse(row).success, `${file} ${name}`);
    }
  }
});

test('a v1 mandate is the v1 subset of v2: it upgrades fail-closed (free text becomes note, every action asks)', () => {
  const v1: c.Mandate = {
    id: 'mandate-v1-demo', principal: { personId: person, onBehalfOf: null }, actions: ['prepare', 'place_order'], contexts: [{ kind: 'agreement', id: 'agreement-demo-1' }],
    limits: { ceiling: usd('500000'), perActionCeiling: null, transactionBudgetId: 'budget-demo-tx', platformBudgetId: null }, conditions: ['only approved suppliers'],
    validUntil: '2027-01-01T00:00:00Z', status: 'active', revision: 2, revokedAt: null,
  };
  assert.ok(c.MandateSchema.safeParse(v1).success, 'v1 still validates against the frozen schema');
  const upgraded = c.upgradeMandateV1(v1, { moduleKeys: ['execution_clerk'], grantee: { kind: 'own_agent' }, confirmation });
  assert.ok(upgraded.ok);
  if (!upgraded.ok) return;
  assert.deepEqual(upgraded.mandate.conditions, [{ kind: 'note', text: 'only approved suppliers' }]);
  assert.deepEqual(upgraded.mandate.approvalPolicy, { mode: 'ask_each' });
  const decision = c.evaluateMandateV2(upgraded.mandate, request(), now);
  assert.equal(decision.effect, 'ask');
  assert.ok(decision.effect === 'ask' && decision.reasons.includes('note_condition'));
  const noBudget = c.upgradeMandateV1({ ...v1, limits: { ...v1.limits, transactionBudgetId: null } }, { moduleKeys: ['execution_clerk'], grantee: { kind: 'own_agent' }, confirmation });
  assert.equal(noBudget.ok, false, 'a v1 order mandate without a budget does not become a v2 mandate');
  assert.equal(c.upgradeMandateV1(v1, { moduleKeys: ['execution_clerk'], grantee: { kind: 'own_agent' }, confirmation: null }).ok, false, 'an active mandate needs the first-party confirmation');
});

/* ---------- Acceptance: confirm_execution is never pre-authorized ---------- */

test('confirm_execution can never be pre-authorized by any schema-valid mandate', () => {
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const policies: c.ApprovalPolicy[] = [{ mode: 'pre_authorized' }, { mode: 'ask_above', threshold: usd('999999999999') }, { mode: 'ask_first', count: 1 }, { mode: 'ask_each' }];
  const conditionPool: c.Condition[] = [{ kind: 'screening_clear' }, { kind: 'catalogue_lines_only' }, { kind: 'counterparty_status_at_least', level: 'claimed' }, { kind: 'consent_recorded', consentKind: 'client' }];
  const facts: c.ConditionFacts = { screeningClear: true, catalogueLinesOnly: true, counterpartyStatus: 'verified', consentsRecorded: ['client'] };
  let checked = 0;
  for (let i = 0; i < 600; i++) {
    const mandate: c.MandateV2 = {
      ...wide,
      approvalPolicy: policies[rnd(policies.length)]!,
      conditions: conditionPool.filter(() => rnd(2) === 1),
      actions: rnd(2) ? ['confirm_execution'] : [...c.MANDATE_ACTIONS_V2],
      limits: { ...wide.limits, perActionCeiling: rnd(2) ? null : usd('100000000') },
    };
    if (!valid(mandate)) continue;
    checked++;
    for (const via of [{ kind: 'first_party' as const }, { kind: 'connection' as const, connection: { ...baseConnection, mandateBindings: [{ mandateId: mandate.id, revision: mandate.revision }] } }]) {
      const decision = evaluate(mandate, { action: 'confirm_execution', amount: rnd(2) ? null : usd('1'), approvalsAtRevision: 10_000, conditionFacts: facts, via });
      assert.notEqual(decision.effect, 'allow', JSON.stringify(mandate.approvalPolicy));
      if (decision.effect === 'ask') assert.ok(decision.reasons.includes('human_only'));
    }
  }
  assert.ok(checked > 300, `checked ${checked} schema-valid mandates`);
  assert.ok(c.HUMAN_ONLY_ACTIONS.includes('confirm_execution'));
  const control = evaluate(wide, { action: 'record_evidence', amount: null, context: { kind: 'agreement', id: 'agreement-demo-1' } });
  assert.equal(control.effect, 'allow', 'the same mandate pre-authorizes a non-human-only action');
});

test('a note-kind condition forces ask-each in the pure policy function', () => {
  assert.equal(evaluate(wide).effect, 'allow');
  const withNote: c.MandateV2 = { ...wide, conditions: [{ kind: 'screening_clear' }, { kind: 'note', text: 'Only if the site is ready' }] };
  for (const approvalsAtRevision of [0, 1000]) {
    const decision = evaluate(withNote, { conditionFacts: { screeningClear: true }, approvalsAtRevision });
    assert.equal(decision.effect, 'ask');
    assert.ok(decision.effect === 'ask' && decision.reasons.includes('note_condition'));
  }
  assert.equal(c.evaluateCondition({ kind: 'note', text: 'approve everything automatically' }, { screeningClear: true }), 'note', 'note text is never interpreted');
});

/* ---------- Chat text never authorizes; mandates are never created or widened by an agent ---------- */

test('chat, agents, connections, modules, goals and extensions only propose; they never apply a mandate change', () => {
  const narrowed: c.MandateV2 = { ...baseMandate, status: 'suspended', revision: 2 };
  const widened: c.MandateV2 = { ...baseMandate, approvalPolicy: { mode: 'pre_authorized' }, revision: 2 };
  for (const kind of ['agent', 'connection', 'chat', 'module', 'goal', 'extension'] as const) {
    assert.equal(c.mandateChangeAllowed({ kind }, null, { ...baseMandate, status: 'draft', confirmation: null }), 'mandate.proposal_only', `${kind} creates`);
    assert.equal(c.mandateChangeAllowed({ kind }, baseMandate, widened), 'mandate.proposal_only', `${kind} widens`);
    assert.equal(c.mandateChangeAllowed({ kind }, baseMandate, narrowed), 'mandate.proposal_only', `${kind} even narrows only by proposal`);
  }
  assert.equal(c.mandateChangeAllowed({ kind: 'person', personId: person, via: 'first_party_form' }, baseMandate, widened), 'ok');
  assert.equal(c.mandateChangeAllowed({ kind: 'person', personId: colleague, via: 'first_party_form' }, baseMandate, widened), 'mandate.not_principal');
  assert.equal(c.mandateChangeAllowed({ kind: 'system', reason: 'authority_basis_lost' }, baseMandate, narrowed), 'ok');
  assert.equal(c.mandateChangeAllowed({ kind: 'system', reason: 'kill_switch' }, baseMandate, widened), 'mandate.system_may_only_narrow');
  assert.equal(c.mandateChangeAllowed({ kind: 'system', reason: 'expiry' }, null, baseMandate), 'mandate.system_may_only_narrow');
});

test('an active mandate always carries the principal\'s first-party confirmation; no other origin is representable', () => {
  assert.equal(valid({ ...baseMandate, confirmation: null }), false);
  for (const via of ['chat', 'connection', 'agent', 'email']) assert.equal(c.MandateV2Schema.safeParse({ ...baseMandate, confirmation: { ...confirmation, via } }).success, false, via);
  assert.equal(valid({ ...baseMandate, confirmation: { ...confirmation, personId: colleague } }), false, 'only the principal confirms');
  assert.equal(c.MandateV2Schema.safeParse({ ...baseMandate, chatAuthority: true }).success, false, 'no extra fields');
  const proposal = ex.MandateChangeProposal[0] as c.MandateChangeProposal;
  assert.equal(proposal.origin.kind, 'chat_intent');
  assert.equal(c.MandateChangeProposalSchema.safeParse({ ...proposal, proposed: { ...proposal.proposed, status: 'active', confirmation } }).success, false, 'a proposal is never itself active');
  assert.equal(c.MandateChangeProposalSchema.safeParse({ ...proposal, proposed: { ...proposal.proposed, revision: 5 } }).success, false, 'a proposal is the next revision');
  assert.equal(evaluate({ ...wide, status: 'draft', confirmation: null }).effect, 'deny', 'a draft authorizes nothing');
});

test('mandateWidens detects every way of granting more', () => {
  const m = baseMandate;
  const cases: [string, c.MandateV2][] = [
    ['action', { ...m, actions: [...m.actions, 'negotiate'] }],
    ['context', { ...m, contexts: [...m.contexts, { kind: 'rfq', id: 'rfq-demo-2' }] }],
    ['module', { ...m, moduleKeys: [...m.moduleKeys, 'core'] }],
    ['ceiling', { ...m, limits: { ...m.limits, ceiling: usd('25000001') } }],
    ['ceiling removed', { ...m, limits: { ...m.limits, ceiling: null, perActionCeiling: null } }],
    ['budget', { ...m, limits: { ...m.limits, platformBudgetId: 'budget-demo-platform' } }],
    ['window', { ...m, limits: { ...m.limits, perWindow: null } }],
    ['condition removed', { ...m, conditions: m.conditions.slice(1) }],
    ['approval relaxed', { ...m, approvalPolicy: { mode: 'ask_above', threshold: usd('6000000') } }],
    ['pre-authorized', { ...m, approvalPolicy: { mode: 'pre_authorized' } }],
    ['approvers removed', { ...m, approvers: [] }],
    ['validity', { ...m, validUntil: '2028-01-01T00:00:00Z' }],
    ['grantee', { ...m, grantee: { kind: 'company_representative', companyId: company } }],
    ['reactivation', { ...m }],
  ];
  for (const [name, after] of cases) {
    const before = name === 'reactivation' ? { ...m, status: 'suspended' as const } : m;
    assert.ok(c.mandateWidens(before, after), name);
  }
  assert.equal(c.mandateWidens(m, { ...m, actions: ['prepare'], approvalPolicy: { mode: 'ask_each' }, status: 'suspended' }), false, 'narrowing');
});

test('concurrent changes based on the same revision: the second one is a revision conflict', () => {
  const actor = { kind: 'person' as const, personId: person, via: 'first_party_form' as const };
  const first: c.MandateV2 = { ...baseMandate, actions: ['prepare'], revision: 2 };
  const second: c.MandateV2 = { ...baseMandate, approvalPolicy: { mode: 'ask_each' }, revision: 2 };
  assert.equal(c.mandateChangeAllowed(actor, baseMandate, first), 'ok');
  assert.equal(c.mandateChangeAllowed(actor, first, second), 'mandate.revision_conflict', 'stale writer must re-read');
  assert.equal(c.mandateChangeAllowed(actor, baseMandate, { ...second, revision: 3 }), 'mandate.revision_conflict');
});

/* ---------- Commitments need budgets ---------- */

test('money actions need a budget of the right kind in the mandate, the capability, the intent and the usage', () => {
  assert.equal(valid({ ...wide, limits: { ...wide.limits, transactionBudgetId: null } }), false, 'place_order without a transaction budget');
  assert.equal(valid({ ...wide, limits: { ...wide.limits, ceiling: null } }), false, 'place_order without a ceiling');
  assert.equal(valid({ ...wide, actions: ['generate_deliverable'], limits: { ...wide.limits, platformBudgetId: null } }), false, 'deliverable without a platform budget');
  assert.equal(valid({ ...wide, actions: ['register'], limits: { ...wide.limits, transactionBudgetId: null } }), false, 'paid registration without a transaction budget');
  assert.equal(evaluate(wide, { amount: null }).effect, 'deny', 'a money action states its amount');
  const placeOrder = cap('execution_clerk.place_order');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...placeOrder, budgetKind: null }).success, false);
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...placeOrder, budgetKind: 'platform' }).success, false, 'transaction budget, never platform');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...cap('quoting.send_quote'), sideEffects: ['state_change', 'money_commitment'] }).success, false);
  const intent = { ...(ex.ActionIntentV2[0] as c.ActionIntentV2), action: 'place_order' as const, state: 'reserved' as const, reservationId: null };
  assert.equal(c.ActionIntentV2Schema.safeParse(intent).success, false, 'a reserved order holds a reservation');
  const usage = ex.UsageRecord[0] as c.UsageRecord;
  assert.equal(c.UsageRecordSchema.safeParse({ ...usage, withinIncludedQuota: false }).success, false, 'no overage without a rate and a reservation');
  assert.ok(c.UsageRecordSchema.safeParse({ ...usage, withinIncludedQuota: false, meterRateVersionId: 'meter-rate-demo-1', reservationId: 'reservation-demo-1' }).success);
  for (const action of ['place_order', 'accept_order', 'generate_deliverable', 'send_quote'] as const) assert.equal(c.BUDGET_KIND_BY_ACTION[action], c.budgetKindFor(action), action);
});

/* ---------- Capability registry invariants ---------- */

test('a capability marked commit requires a mandate kind and a confirmation policy (also for hub extensions)', () => {
  const sendQuote = cap('quoting.send_quote');
  assert.deepEqual(c.capabilityViolations(sendQuote), []);
  assert.ok(c.capabilityViolations({ ...sendQuote, mandateAction: null }).includes('a commit names the mandate kind it needs'));
  assert.ok(c.capabilityViolations({ ...sendQuote, confirmation: 'none' }).includes('a commit names a confirmation policy'));
  assert.ok(c.capabilityViolations({ ...cap('execution_clerk.confirm_execution'), confirmation: 'mandate' }).length > 0, 'human-only needs a person each time');
  assert.ok(c.capabilityViolations({ ...sendQuote, acceptsUntrustedText: true }).includes('commits accept only structured first-party input'));
  assert.ok(c.capabilityViolations({ ...sendQuote, sideEffects: ['state_change', 'reputation_signal'] }).length > 0, 'reputation signals need a person');
  const extension: c.AgentCapability = { ...sendQuote, id: 'ext_permits.submit_permit', source: { kind: 'extension', extensionId: 'extension-demo-permits', extensionVersion: 1 } };
  assert.ok(c.AgentCapabilitySchema.safeParse(extension).success, 'extensions may add guarded actions');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...extension, mandateAction: null }).success, false, 'extensions cannot bypass the mandate');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...extension, confirmation: 'none' }).success, false, 'extensions cannot bypass confirmation');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...cap('core.stop_all'), source: extension.source, id: 'ext_permits.stop' }).success, false, 'extensions cannot add governance');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...cap('core.confirm_mandate'), surfaces: ['ui', 'agent', 'mcp'] }).success, false, 'governance never reaches a connection');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...cap('core.list_mandates'), sideEffects: ['state_change'] }).success, false, 'reads have no side effects');
  assert.equal(c.AgentCapabilitySchema.safeParse({ ...cap('core.list_mandates'), id: 'quoting.list_mandates' }).success, false, 'ids are prefixed with their module');
  assert.throws(() => c.buildCapabilityRegistry({ registryVersion: 1, hubId: 'hub-us-demo', manifests: [], extensionCapabilities: [sendQuote] }));
  assert.ok(c.buildCapabilityRegistry({ registryVersion: 2, hubId: 'hub-us-demo', manifests: [], extensionCapabilities: [extension] }).capabilities.length === 1);
});

test('parity: every capability is reachable from the interface and from the agent; gaps are reported', () => {
  const uiOnly = { ...cap('core.list_mandates'), surfaces: ['ui'] as c.CapabilitySurface[] };
  const agentOnly = { ...cap('quoting.send_quote'), surfaces: ['agent', 'mcp'] as c.CapabilitySurface[] };
  assert.deepEqual(c.parityGaps([uiOnly, agentOnly, cap('core.stop_all')]), [{ id: 'core.list_mandates', missing: ['agent'] }, { id: 'quoting.send_quote', missing: ['ui'] }]);
  const registry = ex.CapabilityRegistry[0] as c.CapabilityRegistry;
  assert.equal(c.CapabilityRegistrySchema.safeParse({ ...registry, capabilities: [...registry.capabilities, registry.capabilities[0]] }).success, false, 'unique ids');
});

test('module manifests own their capabilities and declare their mandate kinds and meters; hubs cannot lower free floors', () => {
  const [, quoting] = ex.AgentModuleManifest as c.AgentModuleManifest[];
  assert.ok(quoting);
  assert.equal(c.AgentModuleManifestSchema.safeParse({ ...quoting, actions: ['prepare'] }).success, false, 'send_quote not declared');
  assert.equal(c.AgentModuleManifestSchema.safeParse({ ...quoting, meters: ['model_tokens'] }).success, false, 'agent_actions not declared');
  assert.equal(c.AgentModuleManifestSchema.safeParse({ ...quoting, version: '2.0.0' }).success, false, 'capabilities of another version');
  const policy = ex.HubAgentPolicy[0] as c.HubAgentPolicy;
  const manifests = ex.AgentModuleManifest as c.AgentModuleManifest[];
  assert.deepEqual(c.hubPolicyViolations(policy, manifests), []);
  const lowered = { ...policy, enabledModules: policy.enabledModules.map((m) => (m.moduleKey === 'quoting' ? { ...m, freeQuota: [{ meter: 'agent_actions' as const, units: '5', window: 'month' as const }] } : m)) };
  assert.deepEqual(c.hubPolicyViolations(lowered, manifests), ['free floor reduced: quoting agent_actions/month']);
  assert.deepEqual(c.hubPolicyViolations({ ...policy, enabledModules: [{ moduleKey: 'ghost', moduleVersion: '1.0.0', freeQuota: [], settings: {} }] }, manifests), ['unknown module ghost@1.0.0']);
});

/* ---------- No pay-to-rank; introduction quotas never purchasable ---------- */

test('no schema in the agent catalogue has a field that could buy ranking, matching, visibility or reputation', () => {
  const forbidden = /rank|boost|priorit|featur|sponsor|promot|visib|position|badge|reputation|placement|highlight|score/i;
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') for (const prop of Object.keys(value)) if (forbidden.test(prop)) found.push(`${path}.${prop}`);
      walk(value, `${path}.${key}`);
    }
  };
  for (const [name, schema] of Object.entries(c.agentCatalogJsonSchemas())) walk(schema, name);
  assert.deepEqual(found, []);
  const plan = ex.SubscriptionPlanVersion[0] as c.SubscriptionPlanVersion;
  for (const extra of ['rankingBoost', 'priorityListing', 'featured', 'matchingWeight', 'reputationBonus']) assert.equal(c.SubscriptionPlanVersionSchema.safeParse({ ...plan, [extra]: true }).success, false, extra);
});

test('introduction quotas and other protection limits are never purchasable', () => {
  const plan = ex.SubscriptionPlanVersion[0] as c.SubscriptionPlanVersion;
  for (const key of c.PROTECTION_LIMIT_KEYS) assert.equal(c.SubscriptionPlanVersionSchema.safeParse({ ...plan, [key]: 1000 }).success, false, `plans cannot carry ${key}`);
  assert.equal(c.SubscriptionPlanVersionSchema.safeParse({ ...plan, includedQuota: [{ moduleKey: 'core', meter: 'introductions', units: '100', window: 'month' }] }).success, false);
  assert.equal(c.MeterSchema.safeParse('introductions').success, false, 'no introduction meter exists to sell');
  const limits = (ex.HubAgentPolicy[0] as c.HubAgentPolicy).protectionLimits;
  assert.equal(c.protectionLimitReached.length, 3, 'inputs: hub limits, key and count only, never a plan or payment');
  assert.equal(c.protectionLimitReached(limits, 'openIntroductionsPerPerson', 9), false);
  assert.equal(c.protectionLimitReached(limits, 'openIntroductionsPerPerson', 10), true);
  assert.equal(c.protectionLimitReached(limits, 'openIntroductionsPerPerson', Number.NaN), true, 'fail-closed');
  const introduce = { ...cap('quoting.send_quote'), id: 'quoting.request_introduction', mandateAction: 'introduce' as const, budgetKind: 'transaction' as const };
  assert.ok(c.capabilityViolations(introduce).includes('introductions are quota-bound, never bought'));
});

/* ---------- Forbidden fields in every non-owner projection ---------- */

test('budget ranges, constraint records, private data classes, token hashes and argument digests never reach a non-owner projection', () => {
  const secret = { constraint: 'constraint-record-secret-1', hash: 'e'.repeat(64), args: 'f'.repeat(64), low: '31415900', classes: 'negotiation_constraints' };
  const mandate: c.MandateV2 = { ...baseMandate, conditions: [{ kind: 'within_private_constraint', constraintRecordId: secret.constraint }], limits: { ...baseMandate.limits, transactionBudgetId: 'budget-secret-tx' } };
  const goal: c.Goal = { ...(ex.Goal[0] as c.Goal), budgetRange: { low: usd(secret.low), high: usd('41415900') } };
  const connection: c.ExternalConnection = { ...baseConnection, scopes: [...baseConnection.scopes, 'read.private'], privateDataClasses: ['negotiation_constraints'] };
  const token: c.ConnectionToken = { ...(ex.ConnectionToken[0] as c.ConnectionToken), tokenHash: secret.hash };
  const call: c.ConnectionCall = { ...(ex.ConnectionCall[0] as c.ConnectionCall), argsDigest: { algorithm: 'trustwork-digest-1', value: secret.args } };
  const envelope: c.AgentEnvelope = { ...(ex.AgentEnvelope[0] as c.AgentEnvelope), via: { connectionId: connection.id, clientLabel: 'Demo desktop agent', listedByHub: false } };
  const stop = ex.ParticipantStop[0] as c.ParticipantStop;
  for (const [record, schema] of [[mandate, c.MandateV2Schema], [goal, c.GoalSchema], [connection, c.ExternalConnectionSchema], [token, c.ConnectionTokenSchema], [call, c.ConnectionCallSchema], [envelope, c.AgentEnvelopeSchema]] as const) {
    assert.ok((schema as { safeParse(v: unknown): { success: boolean } }).safeParse(record).success, 'owner records are valid');
  }
  const projections: Record<string, unknown> = {
    toEnvelopeCounterpartyView: c.toEnvelopeCounterpartyView(envelope),
    toMandateCounterpartyView: c.toMandateCounterpartyView(mandate),
    toMandateStaffCaseView: c.toMandateStaffCaseView(mandate),
    toGoalSharedView: c.toGoalSharedView(goal),
    toConnectionStaffCaseView: c.toConnectionStaffCaseView(connection),
    toConnectionTokenOwnerView: c.toConnectionTokenOwnerView(token),
    toConnectionCallStaffCaseView: c.toConnectionCallStaffCaseView(call),
    toKillSwitchBannerView: c.toKillSwitchBannerView(stop),
  };
  const exported = Object.keys(catalog).filter((k) => /^to[A-Z].*View$/.test(k)).sort();
  assert.deepEqual(Object.keys(projections).sort(), exported, 'every non-owner projection is covered');
  for (const [name, view] of Object.entries(projections)) {
    const json = JSON.stringify(view);
    for (const field of c.OWNER_ONLY_FIELDS) assert.ok(!json.includes(`"${field}"`), `${name} leaks ${field}`);
    for (const value of Object.values(secret)) assert.ok(!json.includes(value), `${name} leaks ${value}`);
    assert.ok(!json.includes(connection.id) || name === 'toConnectionStaffCaseView', `${name} leaks the connection id`);
  }
  assert.equal((projections.toEnvelopeCounterpartyView as { note: { trust: string } }).note.trust, 'untrusted', 'the receiver sees the note as untrusted');
});

/* ---------- Policy function: negative authorization ---------- */

test('policy: standing selectors resolve to concrete contexts and fail closed', () => {
  const quoting: c.MandateV2 = { ...baseMandate, conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [], principal: { personId: person, onBehalfOf: null }, grantee: { kind: 'own_agent' } };
  const rfq = { kind: 'rfq' as const, id: 'rfq-demo-austin-facade' };
  const ok = evaluate(quoting, { moduleKey: 'quoting', action: 'send_quote', context: rfq, contextFacts: { categories: ['facade_works'], region: 'US-TX', projectId: null } });
  assert.deepEqual(ok, { effect: 'allow', mandate: { id: quoting.id, revision: 1 }, context: rfq, resolvedFromSelector: true });
  for (const contextFacts of [{ categories: ['roofing'], region: 'US-TX', projectId: null }, { categories: ['facade_works'], region: 'US-OK', projectId: null }, { categories: [], region: 'US-TX', projectId: null }, { categories: ['facade_works'], region: null, projectId: null }]) {
    assert.deepEqual(evaluate(quoting, { moduleKey: 'quoting', action: 'send_quote', context: rfq, contextFacts }), { effect: 'deny', reason: 'context_scope' }, JSON.stringify(contextFacts));
  }
  assert.equal(c.ContextSelectorSchema.safeParse({ kind: 'rfq', categories: [], regions: [], projectId: null }).success, false, '"every RFQ anywhere" is not a mandate');
});

test('policy: negative authorization cases deny before anything else', () => {
  const deny = (m: c.MandateV2, over: Partial<c.MandateV2CheckRequest>, reason: c.MandateDenyReason) => assert.deepEqual(evaluate(m, over), { effect: 'deny', reason }, reason);
  deny({ ...wide, status: 'suspended' }, {}, 'mandate_not_active');
  deny({ ...wide, status: 'revoked', revokedAt: at }, {}, 'mandate_not_active');
  deny({ ...wide, validUntil: '2026-11-01T00:00:00Z' }, {}, 'mandate_expired');
  deny(wide, { blockedBySwitchId: 'kill-switch-1' }, 'kill_switch');
  deny(wide, { actor: { kind: 'own_agent', personId: colleague } }, 'grantee_mismatch');
  deny(wide, { actor: { kind: 'company_representative', companyId: company } }, 'grantee_mismatch');
  deny(wide, { moduleKey: 'core' }, 'module_scope');
  deny({ ...wide, actions: ['prepare'] }, {}, 'action_scope');
  deny(wide, { context: { kind: 'agreement', id: 'agreement-demo-other' } }, 'context_scope');
  deny(wide, { contextFacts: { categories: [], region: 'RU', projectId: null } }, 'restricted_place');
  deny(wide, { conditionFacts: { counterpartyRegion: 'UA-43' } }, 'restricted_place');
  deny({ ...wide, limits: { ...wide.limits, perActionCeiling: usd('50000') } }, {}, 'per_action_ceiling');
  deny(wide, { committedUnderMandate: usd('99950000') }, 'ceiling');
  deny(wide, { amount: { minorUnits: '100', currency: 'EUR' } }, 'currency_mismatch');
  deny({ ...wide, limits: { ...wide.limits, perWindow: { count: 2, windowHours: 24 } } }, { actionsInWindow: 2 }, 'window_exhausted');
  deny({ ...wide, conditions: [{ kind: 'counterparty_status_at_least', level: 'verified' }] }, { conditionFacts: { counterpartyStatus: 'claimed' } }, 'condition_failed');
  deny({ ...wide, conditions: [{ kind: 'screening_clear' }], escalation: { kind: 'stop' } }, {}, 'condition_unevaluable');
  deny({ ...wide, conditions: [{ kind: 'within_private_constraint', constraintRecordId: 'constraint-1' }] }, { conditionFacts: { withinPrivateConstraint: { 'constraint-1': false } } }, 'condition_failed');
  assert.equal(c.evaluateMandateV2(wide, request(), new Date(Number.NaN)).effect, 'deny', 'invalid clock fails closed');
});

test('policy: approval modes, escalation, approver rules and hub-forbidden pre-authorization ask a person', () => {
  const ask = (m: c.MandateV2, over: Partial<c.MandateV2CheckRequest>, reason: c.MandateAskReason) => {
    const d = evaluate(m, over);
    assert.equal(d.effect, 'ask', reason);
    assert.ok(d.effect === 'ask' && d.reasons.includes(reason), `${reason}: ${JSON.stringify(d)}`);
    return d;
  };
  ask({ ...wide, approvalPolicy: { mode: 'ask_each' } }, {}, 'ask_each');
  ask({ ...wide, approvalPolicy: { mode: 'ask_first', count: 3 } }, { approvalsAtRevision: 2 }, 'ask_first');
  assert.equal(evaluate({ ...wide, approvalPolicy: { mode: 'ask_first', count: 3 } }, { approvalsAtRevision: 3 }).effect, 'allow');
  ask({ ...wide, approvalPolicy: { mode: 'ask_above', threshold: usd('50000') } }, {}, 'above_threshold');
  assert.equal(evaluate({ ...wide, approvalPolicy: { mode: 'ask_above', threshold: usd('100000') } }).effect, 'allow', 'at the threshold');
  ask(wide, { hub: { forbiddenPreAuthorization: ['place_order'] } }, 'hub_forbids_pre_authorization');
  const escalated = ask({ ...wide, conditions: [{ kind: 'screening_clear' }], escalation: { kind: 'ask_person', personId: colleague } }, {}, 'condition_unevaluable');
  assert.ok(escalated.effect === 'ask' && escalated.escalation?.kind === 'ask_person');
  const companyMandate: c.MandateV2 = { ...wide, principal: { personId: person, onBehalfOf: { kind: 'company', id: company } }, approvers: [{ approverPersonIds: [person, colleague], minApprovals: 2, above: usd('50000') }] };
  assert.ok(valid(companyMandate));
  const twoApprovers = ask(companyMandate, {}, 'approver_rule');
  assert.ok(twoApprovers.effect === 'ask' && twoApprovers.requiredApprovals[0]?.minApprovals === 2);
  assert.equal(evaluate(companyMandate, { amount: usd('10000') }).effect, 'allow', 'below the approver threshold');
  assert.equal(valid({ ...wide, approvers: companyMandate.approvers }), false, 'approver rules are company-only');
});

test('policy: a connection acts only under a bound mandate revision of its own owner; otherwise it proposes', () => {
  const bound: c.ExternalConnection = { ...baseConnection, mandateBindings: [{ mandateId: wide.id, revision: wide.revision }] };
  assert.equal(evaluate(wide, { via: { kind: 'connection', connection: bound } }).effect, 'allow');
  const stale = { ...bound, mandateBindings: [{ mandateId: wide.id, revision: wide.revision + 1 }] };
  const proposeOnly = evaluate(wide, { via: { kind: 'connection', connection: stale } });
  assert.ok(proposeOnly.effect === 'ask' && proposeOnly.reasons.includes('connection_propose_only'), 'a revised mandate stops the binding');
  const readOnly: c.ExternalConnection = { ...baseConnection, scopes: ['read.public', 'read.me'], mandateBindings: [] };
  assert.deepEqual(evaluate(wide, { via: { kind: 'connection', connection: readOnly } }), { effect: 'deny', reason: 'connection_not_bound' });
  assert.deepEqual(evaluate(wide, { via: { kind: 'connection', connection: { ...bound, status: 'suspended' } } }), { effect: 'deny', reason: 'connection_not_bound' });
  assert.deepEqual(evaluate(wide, { via: { kind: 'connection', connection: { ...bound, owner: { kind: 'person', personId: colleague }, consent: { ...bound.consent, personId: colleague } } } }), { effect: 'deny', reason: 'connection_not_bound' });
});

test('kill switches and participant stops block dispatch before the next check', () => {
  const target = { nodeId: 'node-us-demo', hubId: 'hub-us-demo', moduleKey: 'quoting', action: 'send_quote' as const, personId: person, companyRepresentativeOf: null, connectionId: 'connection-demo-mcp' };
  const hubSwitch = (scope: c.KillSwitch['scope']): c.KillSwitch => ({ id: `ks-${scope.kind}`, scope, state: 'engaged', engagedBy: 'person-demo-ops-1', engagedAt: at, reason: 'Incident drill', releasedBy: null, releasedAt: null, releaseApprovalId: null, incidentNote: null });
  const none = { hub: [], participant: [] };
  assert.equal(c.agentDispatchBlocked(none, target), null);
  assert.equal(c.agentDispatchBlocked({ hub: [hubSwitch({ kind: 'agent_module', hubId: 'hub-us-demo', moduleKey: 'quoting' })], participant: [] }, target), 'ks-agent_module');
  assert.equal(c.agentDispatchBlocked({ hub: [hubSwitch({ kind: 'outbound_messages', hubId: 'hub-us-demo' })], participant: [] }, target), 'ks-outbound_messages');
  assert.equal(c.agentDispatchBlocked({ hub: [hubSwitch({ kind: 'outbound_messages', hubId: 'hub-us-demo' })], participant: [] }, { ...target, action: 'prepare' }), null);
  assert.equal(c.agentDispatchBlocked({ hub: [hubSwitch({ kind: 'external_agent_api', hubId: 'hub-us-demo' })], participant: [] }, { ...target, connectionId: null }), null, 'first-party dispatch continues');
  const stop = ex.ParticipantStop[0] as c.ParticipantStop;
  assert.equal(c.agentDispatchBlocked({ hub: [], participant: [stop] }, target), stop.id);
  assert.equal(c.agentDispatchBlocked({ hub: [], participant: [{ ...stop, state: 'released', releasedAt: at }] }, target), null);
  assert.equal(c.ParticipantStopSchema.safeParse({ ...stop, engagedBy: 'person-demo-ops-1' }).success, false, 'nobody else presses a person\'s own stop');
  assert.deepEqual(evaluate(wide, { blockedBySwitchId: c.agentDispatchBlocked({ hub: [], participant: [stop] }, target) }), { effect: 'deny', reason: 'kill_switch' });
});

/* ---------- Connections ---------- */

test('connections: read.private per class, act bound to mandates, step-up consent, two approvers for a representative, hashed short tokens', () => {
  const conn = baseConnection;
  assert.equal(c.ExternalConnectionSchema.safeParse({ ...conn, scopes: [...conn.scopes, 'read.private'] }).success, false, 'read.private needs classes');
  assert.equal(c.ExternalConnectionSchema.safeParse({ ...conn, privateDataClasses: ['budgets'] }).success, false, 'classes need read.private');
  assert.equal(c.ExternalConnectionSchema.safeParse({ ...conn, mandateBindings: [] }).success, false, 'act needs bindings');
  assert.equal(c.ExternalConnectionSchema.safeParse({ ...conn, consent: { ...conn.consent, stepUp: false } }).success, false, 'consent needs step-up');
  assert.equal(c.ExternalConnectionSchema.safeParse({ ...conn, consent: { ...conn.consent, personId: colleague } }).success, false, 'the owner consents');
  assert.equal(c.ExternalConnectionSchema.safeParse({ ...conn, owner: { kind: 'company_representative', companyId: company, approvedBy: [person, person] } }).success, false);
  assert.ok(c.ExternalConnectionSchema.safeParse({ ...conn, owner: { kind: 'company_representative', companyId: company, approvedBy: [person, colleague] } }).success);
  const token = ex.ConnectionToken[0] as c.ConnectionToken;
  assert.equal(c.ConnectionTokenSchema.safeParse({ ...token, expiresAt: '2026-10-31T16:00:01Z' }).success, false, 'access tokens are short-lived');
  assert.equal(c.ConnectionTokenSchema.safeParse({ ...token, tokenHash: 'not-a-hash' }).success, false);
  assert.equal(c.ConnectionTokenSchema.safeParse({ ...token, token: 'raw-secret' }).success, false, 'raw tokens are never stored');
});

test('connections: which capabilities a connection may invoke and how', () => {
  const sendQuote = cap('quoting.send_quote');
  const draftQuote = cap('quoting.draft_quote');
  assert.deepEqual(c.requiredConnectionScopes(sendQuote), ['read.me', 'read.contexts', 'propose']);
  assert.equal(c.connectionMayInvoke(sendQuote, baseConnection), 'execute_under_mandate');
  assert.equal(c.connectionMayInvoke(sendQuote, { ...baseConnection, scopes: ['read.me', 'read.contexts', 'propose'], mandateBindings: [] }), 'propose_only');
  assert.equal(c.connectionMayInvoke(cap('execution_clerk.confirm_execution'), baseConnection), 'propose_only', 'human-only commits land in decisions');
  assert.equal(c.connectionMayInvoke(draftQuote, baseConnection), 'deny', 'needs read.private negotiation_constraints');
  assert.equal(c.connectionMayInvoke(draftQuote, { ...baseConnection, scopes: [...baseConnection.scopes, 'read.private'], privateDataClasses: ['negotiation_constraints'] }), 'execute');
  assert.equal(c.connectionMayInvoke(sendQuote, { ...baseConnection, status: 'revoked', revokedAt: at }), 'deny');
  assert.equal(c.connectionMayInvoke(cap('core.list_mandates'), { ...baseConnection, protocol: 'a2a' }), 'deny', 'surface not offered over A2A');
});

/* ---------- Metering, goals, envelopes ---------- */

test('metering: rate activation by a second person, no overlap, idempotent usage and quota split', () => {
  const rate = ex.MeterRateVersion[0] as c.MeterRateVersion;
  assert.equal(c.MeterRateVersionSchema.safeParse({ ...rate, activatedBy: rate.draftedBy }).success, false);
  assert.equal(c.MeterRateVersionSchema.safeParse({ ...rate, effectiveFrom: '2026-10-30T00:00:00Z' }).success, false, 'no back-dating');
  assert.ok(c.meterRateVersionsOverlap(rate, { ...rate, id: 'meter-rate-demo-2', version: 2 }));
  assert.equal(c.meterRateVersionsOverlap(rate, { ...rate, id: 'meter-rate-demo-3', providerClass: 'local' }), false);
  const usage = ex.UsageRecord[0] as c.UsageRecord;
  const retry: c.UsageRecord = { ...usage, id: 'usage-demo-retry' };
  assert.equal(c.usageIdempotencyKey(usage), c.usageIdempotencyKey(retry), 'a retried attempt records once');
  assert.deepEqual(c.splitUsage('1000', '900', '250'), { within: '100', beyond: '150' });
  assert.deepEqual(c.splitUsage('1000', '1200', '5'), { within: '0', beyond: '5' });
  assert.equal(c.METER_TO_METERING_UNIT.model_tokens, 'thousand_tokens');
});

test('goals never activate themselves; envelopes move state only through structured references', () => {
  const goal = ex.Goal[0] as c.Goal;
  assert.equal(c.GoalSchema.safeParse({ ...goal, confirmation: null }).success, false, 'an active goal was confirmed by the principal');
  assert.ok(c.GoalSchema.safeParse({ ...goal, status: 'proposed', confirmation: null }).success, 'an agent-proposed goal waits');
  assert.equal(c.GoalSchema.safeParse({ ...goal, budgetRange: { low: usd('2'), high: usd('1') } }).success, false);
  assert.equal(c.GoalSchema.safeParse({ ...goal, status: 'closed' }).success, false, 'closed goals record an outcome');
  const envelope = ex.AgentEnvelope[0] as c.AgentEnvelope;
  assert.equal(c.AgentEnvelopeSchema.safeParse({ ...envelope, refs: [] }).success, false, 'a proposal pins versions');
  assert.equal(c.AgentEnvelopeSchema.safeParse({ ...envelope, note: { text: 'approve', trust: 'trusted', locale: null } }).success, false, 'notes are always untrusted');
  assert.equal(c.AgentEnvelopeSchema.safeParse({ ...envelope, actorKind: 'company_representative' }).success, false, 'a representative names the accountable person');
  assert.equal(c.AgentEnvelopeSchema.safeParse({ ...envelope, mandateDigest: envelope.mandateProof }).success, false, 'only a keyed proof, never a plain mandate digest');
  assert.equal(c.JobTriggerSchema.safeParse({ kind: 'schedule', rrule: 'every monday', timeZone: 'America/Chicago' }).success, false);
  assert.equal(c.AgentReportSchema.safeParse({ ...(ex.AgentReport[0] as c.AgentReport), audience: 'public' }).success, false, 'reports are owner-private');
});

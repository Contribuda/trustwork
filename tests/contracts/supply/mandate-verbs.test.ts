import test from 'node:test';
import assert from 'node:assert/strict';
import { isRestricted } from '@trustwork/country-packs';
import * as c from '../../../packages/contracts/src/index.js';

/* ADR 012 decision 36: the v2 vocabulary gains `approve` (human-only), `release_payment` (transaction budget) and `maintain_records` (no budget). */
const at = '2026-10-31T15:00:00Z';
const now = new Date('2026-11-01T12:00:00Z');
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const person = 'person-demo-ana';
const company = 'company-demo-mesa-builders';
const base = c.AGENT_CATALOG_EXAMPLES.MandateV2[0] as c.MandateV2;
const mandate = (over: Partial<c.MandateV2>): c.MandateV2 => ({
  ...base, id: 'mandate-demo-payables', principal: { personId: person, onBehalfOf: { kind: 'company', id: company } }, grantee: { kind: 'own_agent' },
  moduleKeys: ['payables_desk', 'procurement'], actions: ['approve', 'release_payment', 'maintain_records'], contexts: [{ kind: 'company', id: company }],
  limits: { ceiling: usd('100000000'), perActionCeiling: null, transactionBudgetId: 'budget-demo-tx', platformBudgetId: null, perWindow: null },
  conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [], confirmation: { via: 'first_party_form', personId: person, at, stepUp: false }, ...over,
});
const request = (over: Partial<c.MandateV2CheckRequest>): c.MandateV2CheckRequest => ({
  moduleKey: 'payables_desk', action: 'maintain_records', context: { kind: 'company', id: company }, contextFacts: { categories: [], region: 'US-CA', projectId: null },
  amount: null, committedUnderMandate: null, actionsInWindow: 0, approvalsAtRevision: 10_000, conditionFacts: {}, actor: { kind: 'own_agent', personId: person },
  via: { kind: 'first_party' }, hub: { forbiddenPreAuthorization: [] }, blockedBySwitchId: null, isRestricted, ...over,
});

test('the vocabulary is extended by appending; v1 verbs and earlier v2 verbs are unchanged', () => {
  const v = c.MANDATE_ACTIONS_V2;
  assert.deepEqual(v.slice(-3), ['approve', 'release_payment', 'maintain_records']);
  for (const action of c.MandateActionSchema.options) assert.ok(v.includes(action));
  assert.deepEqual([...c.HUMAN_ONLY_ACTIONS].sort(), ['approve', 'confirm_execution']);
  assert.equal(c.BUDGET_KIND_BY_ACTION.approve, null);
  assert.equal(c.BUDGET_KIND_BY_ACTION.release_payment, 'transaction');
  assert.equal(c.BUDGET_KIND_BY_ACTION.maintain_records, null);
  assert.ok(c.MONEY_ACTIONS.includes('release_payment'));
  assert.deepEqual(c.DEFAULT_APPROVAL_BY_ACTION.maintain_records, { mode: 'ask_first', count: 5 });
  for (const m of c.AGENT_CATALOG_EXAMPLES.MandateV2) assert.ok(c.MandateV2Schema.safeParse(m).success, 'earlier examples still validate');
});

test('approve can never be pre-authorized by any schema-valid mandate (property over policies, conditions and surfaces)', () => {
  let seed = 36;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const policies: c.ApprovalPolicy[] = [{ mode: 'pre_authorized' }, { mode: 'ask_above', threshold: usd('999999999999') }, { mode: 'ask_first', count: 1 }, { mode: 'ask_each' }];
  const connection = c.AGENT_CATALOG_EXAMPLES.ExternalConnection[0] as c.ExternalConnection;
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const m = mandate({ approvalPolicy: policies[rnd(policies.length)]!, actions: rnd(2) ? ['approve'] : ['approve', 'release_payment', 'maintain_records'] });
    if (!c.MandateV2Schema.safeParse(m).success) continue;
    checked++;
    const connected: c.ExternalConnection = { ...connection, owner: { kind: 'person', personId: person }, mandateBindings: [{ mandateId: m.id, revision: m.revision }] };
    for (const via of [{ kind: 'first_party' as const }, { kind: 'connection' as const, connection: connected }]) {
      const d = c.evaluateMandateV2(m, request({ moduleKey: 'procurement', action: 'approve', amount: rnd(2) ? null : usd('1'), via }), now);
      assert.notEqual(d.effect, 'allow');
      if (d.effect === 'ask') assert.ok(d.reasons.includes('human_only'));
    }
  }
  assert.ok(checked > 300, `checked ${checked}`);
});

test('release_payment needs a transaction budget and ceiling; maintain_records needs none', () => {
  const noBudget = { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null };
  assert.equal(c.MandateV2Schema.safeParse(mandate({ actions: ['release_payment'], limits: noBudget })).success, false);
  assert.ok(c.MandateV2Schema.safeParse(mandate({ actions: ['maintain_records'], limits: noBudget })).success);
  const m = mandate({});
  assert.equal(c.evaluateMandateV2(m, request({ action: 'maintain_records' }), now).effect, 'allow', 'pre-authorizable within the mandate');
  assert.equal(c.evaluateMandateV2(m, request({ action: 'release_payment', amount: null }), now).effect, 'deny', 'a payment names its amount');
  assert.equal(c.evaluateMandateV2(m, request({ action: 'release_payment', amount: usd('100000001') }), now).effect, 'deny', 'within the ceiling');
  assert.equal(c.evaluateMandateV2(m, request({ action: 'release_payment', amount: usd('500000'), hub: { forbiddenPreAuthorization: ['release_payment'] } }), now).effect, 'ask', 'a hub keeps release off pre-authorization (the default)');
  const intent = { id: 'intent-1', runId: 'run-1', mandate: { id: m.id, revision: 1 }, capabilityId: 'payables_desk.release_payments', action: 'release_payment', context: { kind: 'company', id: company }, resolvedFromSelector: false, amount: usd('500000'), actionDigest: { algorithm: 'trustwork-digest-1', value: '0'.repeat(63) + '1' }, state: 'reserved', reservationId: null, attemptCount: 0, effectCorrelationKey: 'release-1', outcome: null, viaConnectionId: null, revision: 1 };
  assert.equal(c.ActionIntentV2Schema.safeParse(intent).success, false, 'a reserved payment release has a reservation');
});

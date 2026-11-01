import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMandateV2, MandateV2Schema, type MandateV2CheckRequest } from '@trustwork/contracts';
import { resolveJurisdictionPolicies } from '../../../packages/contracts/src/jurisdiction.js';
import { restrictMandateByJurisdiction } from '../../../apps/api/src/modules/hubs/jurisdiction/runtime.js';
import { RepositoryJurisdictionPacks } from '../../../apps/api/src/modules/hubs/jurisdiction/pack-source.js';
import { LOCALES, syntheticBaseline, syntheticSettings } from './fixtures.js';

const personId = '0192f0c0-0000-7000-8000-000000000001';
const mandate = MandateV2Schema.parse({
  id: '0192f0c0-0000-7000-8000-0000000000aa', schemaVersion: 2, principal: { personId, onBehalfOf: null }, grantee: { kind: 'own_agent' },
  moduleKeys: ['deal_desk'], actions: ['send_quote'], contexts: [{ kind: 'project', id: 'synthetic-project' }],
  limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [],
  escalation: { kind: 'ask_principal' }, confirmation: { via: 'first_party_form', personId, at: '2026-10-31T10:00:00.000Z', stepUp: true },
  validUntil: '2027-10-31T00:00:00.000Z', status: 'active', revision: 1, revokedAt: null,
});
function request(minorUnits: string): MandateV2CheckRequest {
  return { moduleKey: 'deal_desk', action: 'send_quote', context: { kind: 'project', id: 'synthetic-project' }, contextFacts: { categories: [], region: null, projectId: 'synthetic-project' }, amount: { minorUnits, currency: 'USD' }, committedUnderMandate: null, actionsInWindow: 0, approvalsAtRevision: 0, conditionFacts: {}, actor: { kind: 'own_agent', personId }, via: { kind: 'first_party' }, hub: { forbiddenPreAuthorization: [] }, blockedBySwitchId: null, isRestricted: () => false };
}
const settings = syntheticSettings();
const resolution = resolveJurisdictionPolicies({ applicableJurisdictions: ['US'], settings: [settings], baselines: new Map([['US', { status: 'known', baseline: syntheticBaseline(settings) }]]), action: 'send_quote', hubLocales: LOCALES, isRestricted: () => false });

test('pure composition asks above a jurisdiction threshold despite a pre-authorized confirmed mandate', () => {
  const req = request('10001');
  const decision = evaluateMandateV2(mandate, req, new Date('2026-11-01T00:00:00Z'));
  assert.equal(decision.effect, 'allow');
  assert.deepEqual(restrictMandateByJurisdiction(decision, resolution, req.amount), { effect: 'ask', reasons: ['jurisdiction_limit_exceeded'] });
  const at = request('10000');
  assert.equal(restrictMandateByJurisdiction(evaluateMandateV2(mandate, at, new Date('2026-11-01T00:00:00Z')), resolution, at.amount).effect, 'allow');
});
test('jurisdiction composition never widens a mandate or clears a kill switch', () => {
  const req = request('1'); const at = new Date('2026-11-01T00:00:00Z');
  for (const decision of [evaluateMandateV2({ ...mandate, status: 'revoked' }, req, at), evaluateMandateV2(mandate, { ...req, blockedBySwitchId: 'synthetic-stop' }, at)]) {
    assert.equal(decision.effect, 'deny'); assert.equal(restrictMandateByJurisdiction(decision, resolution, req.amount).effect, 'deny');
  }
  const ask = evaluateMandateV2({ ...mandate, approvalPolicy: { mode: 'ask_each' } }, req, at);
  assert.equal(restrictMandateByJurisdiction(ask, resolution, req.amount).effect, 'ask');
  assert.equal(restrictMandateByJurisdiction(ask, { ...resolution, status: 'unknown' }, req.amount).effect, 'deny');
});
test('existing US pack facts are evidence only; missing mandatory semantics and counsel stay UNKNOWN', () => {
  const inspection = new RepositoryJurisdictionPacks().inspect('US-CA');
  assert.equal(inspection.baseline.status, 'unknown');
  assert.ok(inspection.facts.some((f) => f.fact.id === 'ca-bot-disclosure' && f.scope === 'US-CA'));
  assert.ok(inspection.facts.some((f) => f.fact.id === 'esign-electronic-agents' && f.scope === 'US'));
  assert.ok(inspection.facts.every((f) => f.fact.sources.length > 0));
  if (inspection.baseline.status === 'unknown') {
    assert.ok(inspection.baseline.reasons.includes('counsel_review_pending'));
    assert.ok(inspection.baseline.reasons.includes('mandatory_baseline_not_representable'));
  }
});
test('pack reader fails closed for missing files, unknown subdivisions, restricted places and path injection', () => {
  const source = new RepositoryJurisdictionPacks();
  for (const jurisdiction of ['RU', 'UA-43:synthetic', '../us', 'US-QQ', 'US-CA:synthetic']) assert.equal(source.inspect(jurisdiction).baseline.status, 'unknown');
  assert.deepEqual(source.inspect('../us').facts, []);
  assert.deepEqual(new RepositoryJurisdictionPacks('/nonexistent').inspect('US').facts, []);
});

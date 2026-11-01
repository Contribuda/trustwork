import test from 'node:test';
import assert from 'node:assert/strict';
import { JurisdictionSettingsSchema, JurisdictionAgentSettingsSchema, jurisdictionOverrideProblems, resolveJurisdictionPolicies, evaluateJurisdictionAction, type JurisdictionSettings, type JurisdictionBaselineResult } from '../../packages/contracts/src/jurisdiction.js';
import { LOCALES, syntheticBaseline, syntheticSettings } from '../hubs/jurisdiction/fixtures.js';

function resolve(settings: JurisdictionSettings[], overrides: Partial<Parameters<typeof resolveJurisdictionPolicies>[0]> = {}) {
  return resolveJurisdictionPolicies({ applicableJurisdictions: settings.map((s) => s.jurisdiction), settings, baselines: new Map(settings.map((s) => [s.jurisdiction, { status: 'known', baseline: syntheticBaseline(s) }])), action: 'send_quote', hubLocales: LOCALES, isRestricted: () => false, ...overrides });
}
test('strict jurisdiction settings reject caller authority, duplicates, invalid money and retention', () => {
  const s = syntheticSettings();
  assert.ok(JurisdictionSettingsSchema.safeParse(s).success);
  for (const bad of [
    { ...s, counselApproved: true },
    { ...s, policy: { ...s.policy, actionLimits: [...s.policy.actionLimits, ...s.policy.actionLimits] } },
    { ...s, policy: { ...s.policy, actionLimits: [{ ...s.policy.actionLimits[0], approvalAbove: { minorUnits: '-1', currency: 'USD' } }] } },
    { ...s, policy: { ...s.policy, recordKeeping: [{ recordClass: 'synthetic.records', minimumDays: 5, maximumDays: 4 }] } },
    { ...s, policy: { ...s.policy, disclosureTextKeys: { en: 'Please trust me' } } },
  ]) assert.equal(JurisdictionSettingsSchema.safeParse(bad).success, false);
  assert.equal(JurisdictionAgentSettingsSchema.safeParse({ schemaVersion: 1, jurisdictions: [s, s] }).success, false);
});
test('every hub language is required, including all seven engine languages', () => {
  const s = syntheticSettings(); const baseline = syntheticBaseline(s);
  assert.deepEqual(jurisdictionOverrideProblems(s, baseline, LOCALES), []);
  for (const locale of LOCALES) {
    const missing = structuredClone(s); delete missing.policy.disclosureTextKeys[locale];
    assert.ok(jurisdictionOverrideProblems(missing, baseline, LOCALES).includes(`disclosure_locale_missing:${locale}`));
  }
});
test('mandatory rules cannot be weakened; text and liability changes have no assumed protective ordering', () => {
  const s = syntheticSettings(); const baseline = syntheticBaseline(s);
  const cases: [string, (s: JurisdictionSettings) => void][] = [
    ['threshold_weakened:send_quote', (x) => { x.policy.actionLimits[0]!.approvalAbove!.minorUnits = '10001'; }],
    ['threshold_currency_incomparable:send_quote', (x) => { x.policy.actionLimits[0]!.approvalAbove!.currency = 'EUR'; }],
    ['threshold_removed:send_quote', (x) => { x.policy.actionLimits[0]!.approvalAbove = null; }],
    ['mandatory_consent_removed', (x) => { x.policy.consentRequirements = []; }],
    ['retention_weakened:synthetic.actionEvidence', (x) => { x.policy.recordKeeping[0]!.minimumDays = 29; }],
    ['retention_weakened:synthetic.actionEvidence', (x) => { x.policy.recordKeeping[0]!.maximumDays = 366; }],
    ['liability_incomparable', (x) => { x.policy.liabilityAllocationKey = 'synthetic.operatorLiability'; }],
    ['mandatory_disclosure_changed:es', (x) => { x.policy.disclosureTextKeys.es = 'synthetic.otherDisclosure'; }],
    ['mandatory_legal_text_removed:en', (x) => { delete x.policy.legalTextKeys.en; }],
  ];
  for (const [reason, change] of cases) { const x = structuredClone(s); change(x); assert.ok(jurisdictionOverrideProblems(x, baseline, LOCALES).includes(reason), reason); }
  const strict = structuredClone(s); strict.policy.actionLimits[0]!.approvalAbove!.minorUnits = '9000'; strict.policy.actionLimits[0]!.approval = 'ask_each'; strict.policy.recordKeeping[0]!.minimumDays = 31; strict.policy.recordKeeping[0]!.maximumDays = 364; strict.policy.consentRequirements.push('synthetic.explicitConsent');
  assert.deepEqual(jurisdictionOverrideProblems(strict, baseline, LOCALES), []);
});
test('resolution is deterministic under party and configuration order; protections accumulate', () => {
  const a = syntheticSettings('US-CA'); const b = syntheticSettings('US-TX');
  b.policy.actionLimits[0]!.approvalAbove!.minorUnits = '5000';
  b.policy.recordKeeping[0] = { recordClass: 'synthetic.actionEvidence', minimumDays: 60, maximumDays: 180 };
  b.policy.consentRequirements.push('synthetic.additionalConsent'); b.policy.disclosureTextKeys.en = 'synthetic.secondDisclosure';
  const forward = resolve([a, b]); const reverse = resolve([b, a]);
  assert.deepEqual(forward, reverse); assert.equal(forward.status, 'resolved');
  assert.deepEqual(forward.approvalAbove, [{ minorUnits: '5000', currency: 'USD' }]);
  assert.deepEqual(forward.recordKeeping, [{ recordClass: 'synthetic.actionEvidence', minimumDays: 60, maximumDays: 180 }]);
  assert.deepEqual(forward.disclosureTextKeys.en, ['synthetic.agentDisclosure', 'synthetic.secondDisclosure']);
  assert.equal(forward.consentRequirements.length, 2);
});
test('cross-currency thresholds retain both constraints and refuse comparison without FX', () => {
  const a = syntheticSettings('US'); const b = syntheticSettings('CA'); b.policy.actionLimits[0]!.approvalAbove!.currency = 'CAD';
  const resolved = resolve([a, b]); assert.equal(resolved.approvalAbove.length, 2);
  assert.deepEqual(evaluateJurisdictionAction(resolved, { currency: 'USD', minorUnits: '1' }), { effect: 'deny', reasons: ['currency_comparison_unknown'] });
});
test('incompatible retention and liability fail closed instead of choosing an arbitrary winner', () => {
  const a = syntheticSettings('US-CA'); const b = syntheticSettings('US-TX');
  b.policy.liabilityAllocationKey = 'synthetic.anotherAllocation'; b.policy.recordKeeping[0]!.minimumDays = 400; b.policy.recordKeeping[0]!.maximumDays = 500;
  const result = resolve([a, b]); assert.equal(result.status, 'unknown');
  assert.deepEqual(result.reasons, ['liability_incomparable', 'retention_conflict:synthetic.actionEvidence']);
  assert.equal(evaluateJurisdictionAction(result, { currency: 'USD', minorUnits: '100' }).effect, 'deny');
});
test('unknown baselines, omitted jurisdictions, duplicates, unknown actions and restricted ancestors refuse', () => {
  const s = syntheticSettings();
  const unknown = new Map<string, JurisdictionBaselineResult>([['US', { status: 'unknown', reasons: ['mandatory_baseline_missing'] }]]);
  for (const result of [resolve([s], { baselines: unknown }), resolve([s], { applicableJurisdictions: [] }), resolve([s], { applicableJurisdictions: ['US', 'CA'] }), resolve([s, s]), resolve([s], { action: 'place_order' }), resolve([syntheticSettings('US-CA:synthetic')], { isRestricted: (code) => code === 'US' })]) {
    assert.equal(result.status, 'unknown'); assert.equal(evaluateJurisdictionAction(result, null).effect, 'deny');
  }
});
test('threshold boundary uses exact bigint; missing money never becomes zero', () => {
  const s = syntheticSettings(); s.policy.actionLimits[0]!.approvalAbove!.minorUnits = '90071992547409930000';
  const resolution = resolve([s]);
  assert.equal(evaluateJurisdictionAction(resolution, { currency: 'USD', minorUnits: '90071992547409930000' }).effect, 'allow');
  assert.equal(evaluateJurisdictionAction(resolution, { currency: 'USD', minorUnits: '90071992547409930001' }).effect, 'ask');
  assert.equal(evaluateJurisdictionAction(resolution, null).effect, 'deny');
  assert.equal(evaluateJurisdictionAction(resolution, { currency: 'USD', minorUnits: '-1' }).effect, 'deny');
});

test('typed consent commands never accept caller subject, scope, mandate or legal authority', async () => {
  const { JurisdictionConsentCommandSchema, JurisdictionConsentScopeSchema, JurisdictionApplicabilityReviewCommandSchema } = await import('../../packages/contracts/src/jurisdiction.js');
  const command = { noticeDigest: 'a'.repeat(64), locale: 'ru' };
  assert.equal(JurisdictionConsentCommandSchema.safeParse(command).success, true);
  for (const field of ['personId', 'companyId', 'hubId', 'country', 'mandateId', 'legalVersion', 'approvalId', 'consent']) {
    assert.equal(JurisdictionConsentCommandSchema.safeParse({ ...command, [field]: 'untrusted' }).success, false, field);
  }
  assert.equal(JurisdictionConsentScopeSchema.safeParse({ requirement: 'synthetic.consent', purpose: 'synthetic.processing', action: 'send_quote', affectedParty: 'seller', noticeKey: 'synthetic.terms' }).success, true);
  assert.equal(JurisdictionConsentScopeSchema.safeParse({ requirement: 'synthetic.consent' }).success, false);
  assert.equal(JurisdictionApplicabilityReviewCommandSchema.safeParse({ evidenceDigest: 'a'.repeat(64), reason: 'Synthetic review', jurisdictions: ['US'] }).success, false);
});

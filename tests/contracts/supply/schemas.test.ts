import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as s from '../../../packages/contracts/src/supply/index.js';
import * as f from './fixtures.js';

const keysOf = (schema: z.ZodType): string[] => {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as { properties?: Record<string, unknown> };
  return Object.keys(json.properties ?? {});
};
const deepKeys = (schema: z.ZodType): string[] => {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const props = (node as { properties?: Record<string, unknown> }).properties;
    if (props) for (const [k, v] of Object.entries(props)) { out.push(k); walk(v); }
    for (const v of Object.values(node)) if (typeof v === 'object') walk(v);
  };
  walk(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
  return out;
};

test('fixtures validate and every schema has a versioned JSON Schema', () => {
  for (const [schema, value] of [
    [s.ApprovalRouteVersionSchema, f.routeVersion], [s.ApprovalRequestSchema, f.approvalRequest], [s.ApprovalDecisionSchema, f.approvalDecision],
    [s.RequisitionVersionSchema, f.requisitionVersion], [s.PayeeAccountSchema, f.payeeAccount], [s.BidOutcomeNoticeSchema, f.outcomeNotice],
    [s.MatchTolerancePolicyPayloadSchema, f.tolerance], [s.ProcurementHubSettingsSchema, s.PROCUREMENT_HUB_DEFAULTS],
  ] as const) {
    const r = (schema as z.ZodType).safeParse(value);
    assert.ok(r.success, JSON.stringify(!r.success && r.error.issues));
  }
  const json = s.supplyJsonSchemas();
  assert.ok(Object.keys(json).length >= 150);
  for (const [name, doc] of Object.entries(json)) assert.equal(doc.$id, `urn:trustwork:contracts:supply:v${s.SUPPLY_CONTRACT_VERSION}:${name.replace(/Schema$/, '')}`);
});

test('PayeeAccountSchema has no account-number field and rejects one', () => {
  const forbidden = /account.?(number|no)|routing|iban|swift|bic|sort.?code|bank.?account|clabe/i;
  for (const schema of [s.PayeeAccountSchema, s.PayeeChangeRequestSchema, s.PaymentInstructionSchema, s.PaymentProposalVersionSchema, s.TradeInvoiceVersionSchema, s.ChangePayeeCommandSchema]) {
    const bad = deepKeys(schema).filter((k) => forbidden.test(k));
    assert.deepEqual(bad, [], `no bank data fields: ${bad.join(', ')}`);
  }
  for (const extra of [{ accountNumber: '123456789' }, { routingNumber: '021000021' }, { iban: 'DE00000000000000000000' }]) {
    assert.equal(s.PayeeAccountSchema.safeParse({ ...f.payeeAccount, ...extra }).success, false);
  }
  for (const masked of ['123456789', '••1234567', '****', 'acct 1234']) {
    assert.equal(s.PayeeAccountSchema.safeParse({ ...f.payeeAccount, maskedDisplay: masked }).success, false, masked);
  }
});

test('BidOutcomeNoticeSchema has no price or competitor field', () => {
  const forbidden = /price|amount|total|money|minor|competitor|winner|awarded(?!_)|bidder|other|rank|line|quote|value/i;
  const keys = keysOf(s.BidOutcomeNoticeSchema).filter((k) => k !== 'outcome');
  assert.deepEqual(keys.filter((k) => forbidden.test(k)), []);
  for (const extra of [{ winningPrice: f.usd('100') }, { competitorId: 'company-demo-x' }, { awardedTotal: f.usd('1') }, { rank: 2 }]) {
    assert.equal(s.BidOutcomeNoticeSchema.safeParse({ ...f.outcomeNotice, ...extra }).success, false);
  }
  assert.equal(s.BidOutcomeNoticeSchema.safeParse({ ...f.outcomeNotice, outcome: 'awarded' }).success, false, 'no band for the winner');
  assert.equal(s.BidOutcomeNoticeSchema.safeParse({ ...f.outcomeNotice, buyerOptedInToFeedback: false }).success, false, 'no band without the buyer opt-in');
  assert.ok(s.BidOutcomeNoticeSchema.safeParse({ ...f.outcomeNotice, feedbackBand: null, reasonCategory: null, buyerOptedInToFeedback: false }).success);
});

test('an approval decision is a first-party person decision bound to the digest; no mandate, connection or agent can produce one', () => {
  for (const extra of [{ mandateId: 'mandate-demo-1' }, { connectionId: 'connection-demo-1' }, { actionIntentId: 'intent-demo-1' }, { extensionId: 'ext-1' }, { agent: true }]) {
    assert.equal(s.ApprovalDecisionSchema.safeParse({ ...f.approvalDecision, ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(s.ApprovalDecisionSchema.safeParse({ ...f.approvalDecision, confirmation: f.confirm(f.cy) }).success, false, 'someone else cannot confirm');
  assert.equal(s.ApprovalDecisionSchema.safeParse({ ...f.approvalDecision, decision: 'reject' }).success, false, 'reject needs a reason');
  assert.equal(s.DecideApprovalCommandSchema.safeParse({ approvalRequestId: 'a', step: 'pm', decision: 'approve', subjectDigest: f.digest, reason: null, expectedRevision: 1, idempotencyKey: 'k1', mandateId: 'm' }).success, false);
  assert.ok(s.decisionBindsRequest(f.approvalDecision, f.approvalRequest));
  assert.equal(s.decisionBindsRequest({ ...f.approvalDecision, subjectDigest: f.digest2 }, f.approvalRequest), false, 'a new subject version voids the decision');
  assert.equal(s.decisionBindsRequest(f.approvalDecision, { ...f.approvalRequest, status: 'superseded' }), false);
});

test('approval routes cannot switch segregation of duties off and need a second person when the hub says so', () => {
  assert.equal(s.ApprovalRouteVersionSchema.safeParse({ ...f.routeVersion, payload: { ...f.routeVersion.payload, sodRules: [] } }).success, false);
  assert.equal(s.ApprovalRouteVersionSchema.safeParse({ ...f.routeVersion, activatedBy: f.ana }).success, false, 'drafter alone cannot activate');
  const escalateApprove = { ...f.routeVersion.payload.steps[0]!, escalation: { kind: 'approve' } };
  assert.equal(s.ApprovalRouteVersionSchema.safeParse({ ...f.routeVersion, payload: { ...f.routeVersion.payload, steps: [escalateApprove] } }).success, false, 'nothing approved by silence');
  assert.equal(s.SOD_RULES.length, 5);
});

test('requisitions are versioned, line keys unique, estimates labelled and in one currency', () => {
  assert.equal(s.RequisitionVersionSchema.safeParse({ ...f.requisitionVersion, payload: { ...f.requisitionVersion.payload, lines: [f.requisitionLine, f.requisitionLine] } }).success, false);
  const eur = { ...f.requisitionLine, lineKey: 'l2', estimate: { minorUnits: '100', currency: 'EUR' } };
  assert.equal(s.RequisitionVersionSchema.safeParse({ ...f.requisitionVersion, payload: { ...f.requisitionVersion.payload, lines: [f.requisitionLine, eur] } }).success, false);
  assert.equal(s.RequisitionLineSchema.safeParse({ ...f.requisitionLine, quantity: f.qty('0', 'yd3') }).success, false, 'positive quantity');
  assert.equal(s.RequisitionLineSchema.safeParse({ ...f.requisitionLine, quantity: { value: 12.5, unit: 'yd3' } }).success, false, 'never a JS number');
});

test('payee changes only come from the supplier company with a second factor; documents, e-mail and agents are refused with a risk signal', () => {
  const base = { id: 'pcr-1', payeeAccountId: 'payee-demo-2', previousPayeeAccountId: 'payee-demo-1', requestedByPersonId: f.ana, stepUp: true, callback: null, riskSignalId: null, status: 'requested' as const, requestedAt: f.at };
  assert.ok(s.PayeeChangeRequestSchema.safeParse({ ...base, requestedVia: 'company_account' }).success);
  assert.equal(s.PayeeChangeRequestSchema.safeParse({ ...base, requestedVia: 'company_account', stepUp: false }).success, false);
  for (const via of ['document', 'email', 'agent'] as const) {
    assert.equal(s.PayeeChangeRequestSchema.safeParse({ ...base, requestedVia: via }).success, false, `${via} cannot request`);
    assert.ok(s.PayeeChangeRequestSchema.safeParse({ ...base, requestedVia: via, requestedByPersonId: null, stepUp: false, status: 'rejected', riskSignalId: 'signal-1' }).success);
  }
  assert.equal(s.PayeeChangeRequestSchema.safeParse({ ...base, requestedVia: 'company_account', status: 'cooling_off' }).success, false, 'cooling-off only after a confirmed callback');
});

test('payment instructions never route money through an operator account', () => {
  const base = { id: 'pi-1', proposalVersionId: 'ppv-1', target: { kind: 'trade_invoice' as const, id: 'ti-1' }, payeeAccountId: 'payee-demo-1', amount: f.usd('100000'), scheduledFor: f.sdDate('2026-11-15'), paymentId: null, evidenceRefs: [] };
  assert.ok(s.PaymentInstructionSchema.safeParse({ ...base, mode: 'provider', providerConnectionId: 'pc-1', actionIntentId: 'intent-1', state: 'scheduled' }).success);
  assert.equal(s.PaymentInstructionSchema.safeParse({ ...base, mode: 'operator_account', providerConnectionId: null, actionIntentId: null, state: 'scheduled' }).success, false);
  assert.equal(s.PaymentInstructionSchema.safeParse({ ...base, mode: 'external_recorded', providerConnectionId: null, actionIntentId: null, state: 'external_recorded' }).success, false, 'external needs evidence');
  assert.equal(s.PaymentInstructionSchema.safeParse({ ...base, mode: 'external_recorded', providerConnectionId: null, actionIntentId: null, state: 'submitted', evidenceRefs: ['ev-1'] }).success, false, 'an external payment is never submitted to a provider');
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...s.PROCUREMENT_HUB_DEFAULTS, bankPaymentFileExport: true }).success, false, 'no bank payment file exports');
});

test('private records never become reputation or platform transactions', () => {
  assert.deepEqual(s.ExternalOrderSchema.shape.platformTransaction.def.values, [false]);
  assert.deepEqual(s.ExternalOrderSchema.shape.reputationEffect.def.values, ['none']);
  assert.deepEqual(s.SupplierAssessmentSchema.shape.reputationInput.def.values, [false]);
  const card = s.toSupplierCard(
    { id: 'sr-1', ownerCompanyId: f.company.id, linkedCompanyId: f.supplier.id, linkedSourcedCompanyId: null, externalCounterpartyId: null, status: 'blocked', categories: ['lumber'], regions: ['US-CA'], internalNotes: 'late twice', defaultPaymentTerms: null, onboarding: [], revision: 1 },
    { agreements: 2, orders: 3, receipts: 3, receiptsOnTime: 2, discrepancies: 1, matchExceptions: 0, openInvoices: 0, openInvoiceAmount: null, documentsExpiringWithin30Days: 0 },
    { counterpartyStatus: 'claimed', reputationSnapshotId: null, dueDiligencePackId: null },
  );
  assert.equal(card.audience, 'party_private');
  assert.equal(card.onTimeRate, '0.666666');
  assert.equal('internalNotes' in card, false, 'notes stay on the record, not on the card');
  assert.equal(s.SupplierRecordSchema.safeParse({ id: 'sr-2', ownerCompanyId: f.company.id, linkedCompanyId: f.supplier.id, linkedSourcedCompanyId: null, externalCounterpartyId: 'ec-1', status: 'prospect', categories: [], regions: [], internalNotes: null, defaultPaymentTerms: null, onboarding: [], revision: 1 }).success, false, 'exactly one link');
});

test('intake never creates anything but a draft, and every extracted value cites its locator', () => {
  assert.equal(s.ExtractedFieldSchema.safeParse({ value: 'USD 1,200.00', confidence: '0.93', locator: null }).success, false);
  assert.equal(s.ExtractedFieldSchema.safeParse({ value: '1200', confidence: '1.2', locator: { kind: 'text_line', line: 3 } }).success, false);
  assert.equal(s.ExtractionReviewSchema.safeParse({ id: 'r1', intakeDocumentId: 'd1', extractionRunId: null, corrections: {}, reviewedByPersonId: f.ana, reviewedVia: 'first_party', acceptedAt: f.at, created: { kind: 'trade_invoice', id: 'ti-1', state: 'approved' } }).success, false);
  assert.deepEqual(s.fieldsNeedingTouch({ total: { value: '10', confidence: '0.5', locator: { kind: 'text_line', line: 1 } }, number: { value: 'A1', confidence: '0.95', locator: { kind: 'text_line', line: 2 } } }, '0.8'), ['total']);
  assert.equal(s.DiscrepancySchema.safeParse({ kind: 'payee_differs', lineNo: null, expected: null, found: null, raisesRiskSignal: false }).success, false);
  assert.deepEqual(s.SenderClaimSchema.shape.trust.def.values, ['untrusted']);
});

test('hub defaults keep every risky option off; benchmarks and pooling need counsel records', () => {
  const d = s.PROCUREMENT_HUB_DEFAULTS;
  assert.equal(d.autoRelease.enabled, false);
  assert.equal(d.benchmarks.enabled, false);
  assert.equal(d.demandPooling.enabled, false);
  assert.equal(d.payeeCoolingOffBusinessDays, 3);
  assert.equal(d.freeTierActiveProjects, 1);
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...d, payeeCoolingOffBusinessDays: 2 }).success, false, 'never shorter than three business days');
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...d, benchmarks: { ...d.benchmarks, enabled: true } }).success, false, 'counsel sign-off required');
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...d, benchmarks: { ...d.benchmarks, minBuyers: 4 } }).success, false, 'minimum group size');
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...d, benchmarks: { ...d.benchmarks, dominanceSharePercent: '31' } }).success, false);
  const withBench = { ...d, benchmarks: { ...d.benchmarks, enabled: true, counselSignoffRef: 'signoff-1' } };
  assert.ok(s.ProcurementHubSettingsSchema.safeParse(withBench).success);
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...d, demandPooling: { enabled: true, competitionLawOpinionRef: 'opinion-1', maxPoolSharePercent: null } }).success, false, 'pooling only after benchmarks');
  assert.equal(s.ProcurementHubSettingsSchema.safeParse({ ...withBench, demandPooling: { enabled: true, competitionLawOpinionRef: null, maxPoolSharePercent: null } }).success, false, 'pooling needs an opinion');
  const company = { modules: [], payeeCoolingOffBusinessDays: 3, intakeConfidenceThreshold: '0.8', feedbackBandsDefault: false, benchmarkContribution: true } as const;
  assert.deepEqual(s.companySettingsViolations({ ...company, modules: [] }, d), ['benchmarks are off in this hub']);
  assert.deepEqual(s.companySettingsViolations({ ...company, modules: [], payeeCoolingOffBusinessDays: 5, benchmarkContribution: false }, { ...d, payeeCoolingOffBusinessDays: 5 }), []);
});

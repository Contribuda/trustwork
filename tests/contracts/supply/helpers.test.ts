import test from 'node:test';
import assert from 'node:assert/strict';
import { isRestricted } from '@trustwork/country-packs';
import * as s from '../../../packages/contracts/src/supply/index.js';
import * as f from './fixtures.js';

const sod = (over: Partial<s.SodInput>): s.SodResult => s.sodViolation({ subjectKind: 'requisition', approverPersonId: f.ben, requesterPersonId: f.ana, coApproverPersonIds: [], eligibleApproverCount: 3, ...over });

test('sodViolation: the requester never approves their own subject', () => {
  assert.deepEqual(sod({}), { kind: 'ok' });
  for (const subjectKind of s.APPROVAL_SUBJECT_KINDS) {
    assert.deepEqual(sod({ subjectKind, approverPersonId: f.ana, coApproverPersonIds: [f.cy] }), { kind: 'violation', rule: 'requester_never_approves_own_subject' }, subjectKind);
  }
});

test('sodViolation: payee changer, payee verifier, receiver and preparer rules', () => {
  assert.deepEqual(sod({ subjectKind: 'payment_proposal', payeeChangedByPersonIds: [f.ben], coApproverPersonIds: [f.cy] }), { kind: 'violation', rule: 'payee_changer_never_approves_payment_to_payee' }, 'never, even with a co-approver');
  assert.deepEqual(sod({ subjectKind: 'trade_invoice', payeeChangedByPersonIds: [f.ben] }).kind, 'violation');
  assert.deepEqual(sod({ subjectKind: 'payment_proposal', firstPaymentToPayee: true, payeeVerifiedByPersonIds: [f.ben] }), { kind: 'violation', rule: 'payee_verifier_never_alone_approves_first_payment' });
  assert.deepEqual(sod({ subjectKind: 'payment_proposal', firstPaymentToPayee: true, payeeVerifiedByPersonIds: [f.ben], coApproverPersonIds: [f.cy] }), { kind: 'ok' }, 'not alone');
  assert.deepEqual(sod({ subjectKind: 'payment_proposal', firstPaymentToPayee: false, payeeVerifiedByPersonIds: [f.ben] }), { kind: 'ok' }, 'later payments');
  const receiver = { subjectKind: 'trade_invoice' as const, receiptRecordedByPersonIds: [f.ben], receiverSoleApprovalThreshold: f.usd('500000') };
  assert.deepEqual(sod({ ...receiver, amount: f.usd('500001') }), { kind: 'violation', rule: 'receiver_never_alone_approves_matching_invoice_above_threshold' });
  assert.deepEqual(sod({ ...receiver, amount: f.usd('500000') }), { kind: 'ok' }, 'at the threshold');
  assert.deepEqual(sod({ ...receiver, amount: f.usd('900000'), coApproverPersonIds: [f.cy] }), { kind: 'ok' });
  assert.equal(sod({ ...receiver, amount: null }).kind, 'violation', 'unknown amount fails closed');
  assert.equal(sod({ ...receiver, amount: { minorUnits: '1', currency: 'EUR' } }).kind, 'violation', 'other currency fails closed');
  assert.deepEqual(sod({ subjectKind: 'payment_proposal', proposalPreparedByPersonId: f.ben }), { kind: 'violation', rule: 'preparer_never_alone_approves_payment_proposal' });
  assert.deepEqual(sod({ subjectKind: 'payment_proposal', proposalPreparedByPersonId: f.ben, coApproverPersonIds: [f.ben] }).kind, 'violation', 'co-approving with oneself is still alone');
});

test('sodViolation: a one-person company gets an explicit flag instead of a silent bypass', () => {
  assert.deepEqual(sod({ approverPersonId: f.ana, eligibleApproverCount: 1 }), { kind: 'sole_person_flag', rule: 'requester_never_approves_own_subject' });
  assert.equal(sod({ approverPersonId: f.ana, eligibleApproverCount: 2 }).kind, 'violation');
});

test('delegation never exceeds the delegator, the period, the subject kinds or the limit', () => {
  const d = s.ApprovalDelegationSchema.parse({ id: 'del-1', companyId: f.company.id, delegatorPersonId: f.cy, delegatePersonId: f.ben, subjectKinds: ['requisition'], limit: f.usd('1000000'), validFrom: f.at, validUntil: f.later, status: 'active' });
  const input = { subjectKind: 'requisition' as const, amount: f.usd('999999'), at: new Date('2026-11-05T00:00:00Z'), delegatorMayDecide: true, bothMembersActive: true };
  assert.ok(s.delegationCovers(d, input));
  assert.equal(s.delegationCovers(d, { ...input, delegatorMayDecide: false }), false, 'never above the delegator');
  assert.equal(s.delegationCovers(d, { ...input, bothMembersActive: false }), false, 'ends with membership');
  assert.equal(s.delegationCovers(d, { ...input, amount: f.usd('1000001') }), false);
  assert.equal(s.delegationCovers(d, { ...input, amount: null }), false);
  assert.equal(s.delegationCovers(d, { ...input, subjectKind: 'payment_proposal' }), false);
  assert.equal(s.delegationCovers(d, { ...input, at: new Date(f.later) }), false, 'end is exclusive');
  assert.equal(s.delegationCovers({ ...d, status: 'revoked' }, input), false);
  assert.equal(s.ApprovalDelegationSchema.safeParse({ ...d, delegatePersonId: f.cy }).success, false);
});

test('allocations never exceed the requested quantity; call-offs never exceed the framework', () => {
  const alloc = (value: string, status: s.RequisitionAllocation['status'] = 'planned', unit = 'yd3') => ({ allocated: f.qty(value, unit), status });
  assert.ok(s.allocationsWithinRequested(f.qty('12', 'yd3'), [alloc('5'), alloc('7.000')]));
  assert.equal(s.allocationsWithinRequested(f.qty('12', 'yd3'), [alloc('5'), alloc('7.000001')]), false);
  assert.ok(s.allocationsWithinRequested(f.qty('12', 'yd3'), [alloc('12'), alloc('3', 'cancelled')]), 'cancelled allocations do not count');
  assert.equal(s.allocationsWithinRequested(f.qty('12', 'yd3'), [alloc('1', 'planned', 'm3')]), false, 'another unit fails closed');

  const terms = s.FrameworkTermsSchema.parse({ agreementId: 'agr-1', period: { from: '2026-11-01', to: '2027-10-31' }, lines: [{ lineKey: 'rebar', unitRate: f.usd('95000'), maxQuantity: f.qty('100', 't') }], maxValue: f.usd('9000000') });
  const callOff = (id: string, value: string, amount: string, status: s.CallOff['status'] = 'placed') => s.CallOffSchema.parse({ id, frameworkAgreementId: 'agr-1', orderId: null, lines: [{ lineKey: 'rebar', quantity: f.qty(value, 't'), amount: f.usd(amount) }], status, reservationId: status === 'cancelled' ? null : `res-${id}` });
  assert.ok(s.callOffWithinFramework(terms, [callOff('c1', '60', '5700000')], callOff('c2', '40', '3300000')));
  assert.equal(s.callOffWithinFramework(terms, [callOff('c1', '60', '5700000')], callOff('c2', '40.5', '3000000')), false, 'quantity');
  assert.equal(s.callOffWithinFramework(terms, [callOff('c1', '60', '5700000')], callOff('c2', '30', '3300001')), false, 'value');
  assert.ok(s.callOffWithinFramework(terms, [callOff('c1', '90', '8000000', 'cancelled')], callOff('c2', '100', '9000000')));
  const other = { ...callOff('c3', '1', '1'), lines: [{ lineKey: 'mesh', quantity: f.qty('1', 't'), amount: f.usd('1') }] };
  assert.equal(s.callOffWithinFramework(terms, [], other), false, 'lines outside the framework');
});

test('stockBalance is exact, append-only and ignores who recorded movements', () => {
  const m = (id: string, kind: s.StockMovementKind, value: string, from: string | null, to: string | null, by = f.ana): s.StockMovement => s.StockMovementSchema.parse({
    id, stockItemId: 'item-1', fromLocationId: from, toLocationId: to, quantity: f.qty(value, 'pc'), kind, source: { kind: 'manual', id: 'src-1' },
    costCodeId: kind === 'issue_to_work' ? 'cc-1' : null, planItemKey: null, unitCost: null, lot: null, reason: ['adjustment', 'write_off'].includes(kind) ? 'count' : null, recordedByPersonId: by, occurredAt: f.at,
  });
  const moves = [
    m('1', 'receipt', '100.5', null, 'site-a'), m('2', 'issue_to_work', '20.25', 'site-a', null, f.ben), m('3', 'transfer_out', '30', 'site-a', null),
    m('4', 'transfer_in', '30', null, 'site-b'), m('5', 'adjustment', '-0.25', null, 'site-a', f.cy), m('6', 'write_off', '1', 'site-a', null), m('7', 'surplus_listed', '10', 'site-a', null),
  ];
  assert.deepEqual(s.stockBalance(moves, 'item-1', 'site-a', 'pc'), { value: '49.00', unit: 'pc' });
  assert.deepEqual(s.stockBalance(moves, 'item-1', 'site-b', 'pc'), { value: '30', unit: 'pc' });
  assert.deepEqual(s.stockBalance(moves, 'item-1', 'site-c', 'pc'), { value: '0', unit: 'pc' });
  const shuffled = [...moves].reverse();
  assert.deepEqual(s.stockBalance(shuffled, 'item-1', 'site-a', 'pc'), s.stockBalance(moves, 'item-1', 'site-a', 'pc'), 'order independent');
  assert.throws(() => s.stockBalance([{ ...moves[0]!, quantity: f.qty('1', 'kg') }], 'item-1', 'site-a', 'pc'));
  assert.equal(s.StockMovementSchema.safeParse({ ...moves[1]!, costCodeId: null }).success, false, 'issue names a cost code or plan item');
  assert.equal(s.StockMovementSchema.safeParse({ ...moves[0]!, fromLocationId: 'site-x' }).success, false, 'a receipt only adds');
  assert.equal(s.StockMovementSchema.safeParse({ ...moves[5]!, reason: null }).success, false, 'write-offs give a reason');
  assert.ok(s.stockLocationAllowed({ region: 'US-CA' }, isRestricted));
  for (const region of ['RU', 'UA-43', 'IR', 'KP', 'CU']) assert.equal(s.stockLocationAllowed({ region }, isRestricted), false, region);
});

test('costSummary: planned, committed, actual, forecast and paid, exact and idempotent', () => {
  const line = s.BudgetLineSchema.parse({ id: 'bl-1', budgetId: 'budget-tx-1', costCodeId: 'cc-1', planItemKey: null, planned: f.usd('1000000'), warningThresholds: ['80', '95'] });
  const e = (id: string, kind: s.CostEntryKind, amount: string, key = id) => s.CostEntrySchema.parse({ id, budgetLineId: 'bl-1', kind, amount: f.usd(amount), source: { kind: 'manual', id: 'm' }, idempotencyKey: `idem-key-${key}`, occurredAt: f.at });
  const entries = [e('1', 'commitment', '700000'), e('2', 'commitment', '700000', '1'), e('3', 'commitment_change', '150000'), e('4', 'commitment_release', '-50000'), e('5', 'actual', '400000'), e('6', 'actual_reversal', '-10000'), e('7', 'forecast_adjustment', '60000')];
  const sum = s.costSummary(line, entries, [f.usd('200000')]);
  assert.deepEqual([sum.committed, sum.actual, sum.forecast, sum.paid], [f.usd('800000'), f.usd('390000'), f.usd('860000'), f.usd('200000')]);
  assert.equal(sum.forecastIsEstimate, true);
  assert.deepEqual(sum.warningsCrossed, ['80']);
  assert.equal(sum.overPlanned, false);
  assert.ok(s.costSummary(line, [...entries, e('8', 'commitment', '200001')]).overPlanned);
  assert.equal(s.CostEntrySchema.safeParse({ ...entries[0]!, amount: f.usd('-1') }).success, false);
  assert.equal(s.CostEntrySchema.safeParse({ ...entries[3]!, amount: f.usd('1') }).success, false);
  const totals = s.costTotals([sum, sum], 'USD');
  assert.deepEqual(totals.planned, f.usd('2000000'));
});

test('documentCompleteness: required, unexpired and approved; expired documents block payment where configured', () => {
  const set = s.DocumentRequirementSetSchema.parse({ id: 'drs-1', owner: f.company, hubId: null, subjectKind: 'supplier_onboarding', version: 1, status: 'active', payload: { requirements: [
    { type: { pack: 'US', key: 'certificate_of_insurance' }, required: true, mustBeUnexpired: true, blocksPayment: true },
    { type: { pack: 'US', key: 'vendor_tax_form' }, required: true, mustBeUnexpired: false, blocksPayment: false },
    { type: { pack: 'US', key: 'lien_waiver' }, required: false, mustBeUnexpired: false, blocksPayment: false },
  ] } });
  const link = (key: string, status: s.DocumentLink['status'], validUntil: string | null = null): s.DocumentLink => ({ id: `dl-${key}`, subject: { kind: 'supplier_record', id: 'sr-1' }, type: { pack: 'US', key }, fileId: status === 'missing' ? null : `file-${key}`, intakeDocumentId: null, eDocumentExchangeId: null, status, validUntil, approvalRequestId: null });
  const ok = s.documentCompleteness(set, [link('certificate_of_insurance', 'approved', '2027-01-01'), link('vendor_tax_form', 'approved')], '2026-11-01');
  assert.deepEqual([ok.complete, ok.paymentBlocked, ok.present.length, ok.missing], [true, false, 2, ['US:lien_waiver']]);
  const expired = s.documentCompleteness(set, [link('certificate_of_insurance', 'approved', '2026-10-01'), link('vendor_tax_form', 'in_review')], '2026-11-01');
  assert.deepEqual([expired.complete, expired.paymentBlocked, expired.expired, expired.inReview], [false, true, ['US:certificate_of_insurance'], ['US:vendor_tax_form']]);
  assert.equal(s.DocumentLinkSchema.safeParse({ ...link('vendor_tax_form', 'received'), intakeDocumentId: 'in-1' }).success, false, 'one source');
});

test('payee cooling-off counts business days (three by default) and release rules follow ADR 012 decision 34', () => {
  assert.equal(s.coolingOffEndsOn('2026-11-06'), '2026-11-11', 'Friday plus three business days');
  assert.equal(s.coolingOffEndsOn('2026-11-06', 3, ['2026-11-11']), '2026-11-12', 'Veterans Day skipped when the hub lists it');
  assert.throws(() => s.coolingOffEndsOn('2026-11-06', 2), 'never shorter than the minimum');
  assert.equal(s.addBusinessDays('2026-11-02', 0), '2026-11-02');
  const facts: s.ReleaseFacts = { invoiceStatus: 'approved', invoiceMatched: true, proposalApproved: true, payeeStatus: 'active', payeeUsableOn: '2026-11-11', today: '2026-11-12', payeeLastChangedOn: '2026-11-06', openRiskSignals: 0, withinOpenAmount: true };
  assert.deepEqual(s.releaseBlockers(facts), []);
  assert.deepEqual(s.releaseBlockers({ ...facts, today: '2026-11-10' }), ['payee_cooling_off']);
  assert.deepEqual(s.releaseBlockers({ ...facts, payeeStatus: 'cooling_off' }), ['payee_cooling_off']);
  assert.deepEqual(s.releaseBlockers({ ...facts, openRiskSignals: 1, withinOpenAmount: false }), ['open_risk_signal', 'above_open_amount']);
  const hubOn = { autoReleaseEnabled: true, payeeUnchangedDays: 90 };
  assert.equal(s.agentMayReleaseWithoutAsking(facts, { ...hubOn, autoReleaseEnabled: false }), false, 'off by default');
  assert.equal(s.agentMayReleaseWithoutAsking(facts, hubOn), false, 'payee changed six days ago');
  assert.ok(s.agentMayReleaseWithoutAsking({ ...facts, payeeLastChangedOn: '2026-08-01' }, hubOn));
  assert.ok(s.agentMayReleaseWithoutAsking({ ...facts, payeeLastChangedOn: null }, hubOn));
  assert.equal(s.agentMayReleaseWithoutAsking({ ...facts, payeeLastChangedOn: null, invoiceMatched: false }, hubOn), false);
  assert.equal(s.agentMayReleaseWithoutAsking({ ...facts, payeeLastChangedOn: null, openRiskSignals: 1 }, hubOn), false);
  assert.ok(s.instructionsWithinOpenAmount(f.usd('1000'), [{ amount: f.usd('600'), state: 'succeeded' }, { amount: f.usd('400'), state: 'scheduled' }, { amount: f.usd('900'), state: 'failed' }]));
  assert.equal(s.instructionsWithinOpenAmount(f.usd('1000'), [{ amount: f.usd('600'), state: 'outcome_unknown' }, { amount: f.usd('401'), state: 'scheduled' }]), false, 'an unknown outcome still counts');
  assert.equal(s.riskSignalClearAllowed({ status: 'open' }, f.ben, [f.ben]), false, 'the changer never clears');
  assert.ok(s.riskSignalClearAllowed({ status: 'open' }, f.cy, [f.ben]));
});

test('benchmark cells are suppressed below minimum groups, above the dominance share and inside the lag', () => {
  const on = { ...s.PROCUREMENT_HUB_DEFAULTS.benchmarks, enabled: true, counselSignoffRef: 'signoff-1' };
  const cell = { nBuyers: 5, nSellers: 5, largestContributorSharePercent: '30', period: '2026-Q2' };
  assert.equal(s.benchmarkCellSuppressed(cell, on, '2026-Q4'), false);
  assert.ok(s.benchmarkCellSuppressed(cell, s.PROCUREMENT_HUB_DEFAULTS.benchmarks, '2026-Q4'), 'off by default');
  assert.ok(s.benchmarkCellSuppressed({ ...cell, nBuyers: 4 }, on, '2026-Q4'));
  assert.ok(s.benchmarkCellSuppressed({ ...cell, nSellers: 4 }, on, '2026-Q4'));
  assert.ok(s.benchmarkCellSuppressed({ ...cell, largestContributorSharePercent: '30.000001' }, on, '2026-Q4'));
  assert.ok(s.benchmarkCellSuppressed({ ...cell, period: '2026-Q4' }, on, '2026-Q4'), 'current quarter');
  assert.ok(s.benchmarkCellSuppressed({ ...cell, period: '2026-Q4' }, on, '2027-Q1') === false);
  assert.equal(s.PriceBenchmarkSchema.safeParse({ id: 'b1', hubId: 'hub-us-demo', methodVersion: 1, materialClass: 'material.concrete', unit: 'yd3', region: 'US-CA', period: '2026-Q2', nBuyers: 3, nSellers: 3, suppressed: true, p25: null, p50: f.usd('1'), p75: null }).success, false, 'suppressed cells carry no figures');
});

test('plan item to buying (ADR 012 decision 37)', () => {
  assert.equal(s.buyingPathFor('consumer', 'works'), 'task');
  assert.equal(s.buyingPathFor('small_owner', 'goods'), 'rfq');
  assert.equal(s.buyingPathFor('consumer', 'services'), 'task');
  for (const kind of s.PlanItemPurchaseKindSchema.options) assert.equal(s.buyingPathFor('company_with_routes', kind), 'requisition');
  const p = (path: s.BuyingPath, status: 'active' | 'closed', target = `t-${path}`) => ({ projectId: 'project-1', planItemKey: 'framing', planVersionId: 'pv-1', path, targetId: target, status, recordedAt: f.at });
  assert.ok(s.PlanItemBuyingPathsSchema.safeParse([p('task', 'closed'), p('rfq', 'active')]).success);
  assert.equal(s.PlanItemBuyingPathsSchema.safeParse([p('task', 'active'), p('rfq', 'active')]).success, false, 'one path at a time');
});

test('sourcing: exact levelled totals, stale quotes non-comparable, banded feedback', () => {
  const payload = s.BidLevelSheetPayloadSchema.parse({
    currency: 'USD', exchangeRateSnapshot: null,
    columns: [
      { kind: 'quote_version', key: 'a', quoteVersionId: 'qv-a', version: 2, digest: f.digest, comparable: true, staleReason: null },
      { kind: 'quote_version', key: 'b', quoteVersionId: 'qv-b', version: 1, digest: f.digest2, comparable: false, staleReason: 'rfq_amended' },
    ],
    cells: [
      { columnKey: 'a', rfqLineKey: 'l1', normalizedQuantity: f.qty('10'), conversionRuleRef: null, unitPrice: f.usd('1001'), lineTotal: f.usd('10010'), excluded: false, alternate: false, leadTimeDays: 10, carbonKgCo2e: null },
      { columnKey: 'a', rfqLineKey: 'l2', normalizedQuantity: null, conversionRuleRef: null, unitPrice: null, lineTotal: null, excluded: true, alternate: false, leadTimeDays: null, carbonKgCo2e: null },
      { columnKey: 'b', rfqLineKey: 'l1', normalizedQuantity: f.qty('10'), conversionRuleRef: null, unitPrice: f.usd('900'), lineTotal: f.usd('9000'), excluded: false, alternate: false, leadTimeDays: 30, carbonKgCo2e: null },
    ],
    adjustments: [{ columnKey: 'a', rfqLineKey: 'l2', kind: 'plug_for_exclusion', label: 'buyer_estimate', amount: f.usd('2500'), source: 'Own price history, Q3' }],
  });
  assert.deepEqual(s.levelSheetTotals(payload), [
    { columnKey: 'a', quoted: f.usd('10010'), adjustments: f.usd('2500'), levelled: f.usd('12510') },
    { columnKey: 'b', quoted: f.usd('9000'), adjustments: f.usd('0'), levelled: null },
  ]);
  assert.equal(s.BidLevelSheetPayloadSchema.safeParse({ ...payload, columns: [{ ...payload.columns[1]!, comparable: true }, payload.columns[0]!] }).success, false, 'a stale version is never comparable');
  assert.equal(s.feedbackBand(f.usd('105000'), f.usd('100000')), 'within_5pct');
  assert.equal(s.feedbackBand(f.usd('105001'), f.usd('100000')), 'within_15pct');
  assert.equal(s.feedbackBand(f.usd('115001'), f.usd('100000')), 'above_15pct');
});

test('receiving: accepted plus rejected equals received, server time is the evidence unless a person confirms the device time, no double booking', () => {
  const line = { orderLineRef: 'l1', received: f.qty('10'), accepted: f.qty('8'), rejected: f.qty('2'), discrepancy: 'damaged' as const, note: null, evidenceRefs: [] };
  assert.ok(s.GoodsReceiptLineSchema.safeParse(line).success);
  assert.equal(s.GoodsReceiptLineSchema.safeParse({ ...line, rejected: f.qty('1') }).success, false);
  assert.equal(s.GoodsReceiptLineSchema.safeParse({ ...line, discrepancy: 'none' }).success, false);
  assert.equal(s.receiptEvidenceTime({ deviceTime: f.at, serverTime: f.later, deviceTimeConfirmedBy: null }), f.later);
  assert.equal(s.receiptEvidenceTime({ deviceTime: f.at, serverTime: f.later, deviceTimeConfirmedBy: f.ana }), f.at);
  const b = (id: string, from: string, to: string, status: 'held' | 'confirmed' | 'released' = 'confirmed') => s.SiteResourceBookingSchema.parse({ id, siteResourceId: 'crane-1', deliverySlotId: `slot-${id}`, startsAt: from, endsAt: to, status });
  assert.ok(s.bookingsOverlap(b('1', '2026-11-03T16:00:00Z', '2026-11-03T18:00:00Z'), b('2', '2026-11-03T17:00:00Z', '2026-11-03T19:00:00Z')));
  assert.equal(s.bookingsOverlap(b('1', '2026-11-03T16:00:00Z', '2026-11-03T18:00:00Z'), b('2', '2026-11-03T18:00:00Z', '2026-11-03T19:00:00Z')), false, 'back to back');
  assert.equal(s.bookingsOverlap(b('1', '2026-11-03T16:00:00Z', '2026-11-03T18:00:00Z'), b('2', '2026-11-03T17:00:00Z', '2026-11-03T19:00:00Z', 'released')), false);
});

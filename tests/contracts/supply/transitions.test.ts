import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../../../packages/contracts/src/supply/index.js';

type Table = Readonly<Record<string, readonly string[]>>;
const tables: [string, Table, readonly string[], (a: string, b: string) => boolean][] = [
  ['requisition', s.REQUISITION_TRANSITIONS, s.RequisitionStatusSchema.options, s.requisitionTransitionAllowed as (a: string, b: string) => boolean],
  ['approval request', s.APPROVAL_REQUEST_TRANSITIONS, s.ApprovalRequestStatusSchema.options, s.approvalTransitionAllowed as (a: string, b: string) => boolean],
  ['approval route', s.APPROVAL_ROUTE_TRANSITIONS, s.ApprovalRouteStatusSchema.options, s.approvalRouteTransitionAllowed as (a: string, b: string) => boolean],
  ['trade invoice', s.TRADE_INVOICE_TRANSITIONS, s.TradeInvoiceStatusSchema.options, (a, b) => s.tradeInvoiceTransitionAllowed(a as s.TradeInvoiceStatus, b as s.TradeInvoiceStatus)],
  ['payment proposal', s.PAYMENT_PROPOSAL_TRANSITIONS, s.PaymentProposalStatusSchema.options, s.paymentProposalTransitionAllowed as (a: string, b: string) => boolean],
  ['payment instruction', s.PAYMENT_INSTRUCTION_TRANSITIONS, s.PaymentInstructionStateSchema.options, s.paymentInstructionTransitionAllowed as (a: string, b: string) => boolean],
  ['payee change', s.PAYEE_CHANGE_TRANSITIONS, s.PayeeChangeStatusSchema.options, s.payeeChangeTransitionAllowed as (a: string, b: string) => boolean],
  ['payee account', s.PAYEE_ACCOUNT_TRANSITIONS, s.PayeeAccountStatusSchema.options, s.payeeAccountTransitionAllowed as (a: string, b: string) => boolean],
  ['payment risk signal', s.PAYMENT_RISK_SIGNAL_TRANSITIONS, s.PaymentRiskSignalStatusSchema.options, s.paymentRiskSignalTransitionAllowed as (a: string, b: string) => boolean],
  ['bid level sheet', s.BID_LEVEL_SHEET_TRANSITIONS, s.BidLevelSheetStatusSchema.options, s.bidLevelSheetTransitionAllowed as (a: string, b: string) => boolean],
  ['award decision', s.AWARD_DECISION_TRANSITIONS, s.AwardDecisionStatusSchema.options, s.awardDecisionTransitionAllowed as (a: string, b: string) => boolean],
  ['intake document', s.INTAKE_TRANSITIONS, s.IntakeStatusSchema.options, s.intakeTransitionAllowed as (a: string, b: string) => boolean],
  ['substitution', s.SUBSTITUTION_TRANSITIONS, s.SubstitutionStatusSchema.options, s.substitutionTransitionAllowed as (a: string, b: string) => boolean],
  ['external order', s.EXTERNAL_ORDER_TRANSITIONS, s.ExternalOrderStatusSchema.options, s.externalOrderTransitionAllowed as (a: string, b: string) => boolean],
  ['goods receipt', s.GOODS_RECEIPT_TRANSITIONS, s.GoodsReceiptStatusSchema.options, s.goodsReceiptTransitionAllowed as (a: string, b: string) => boolean],
  ['stock transfer', s.STOCK_TRANSFER_TRANSITIONS, s.StockTransferStatusSchema.options, s.stockTransferTransitionAllowed as (a: string, b: string) => boolean],
  ['supplier return', s.SUPPLIER_RETURN_TRANSITIONS, s.SupplierReturnStatusSchema.options, s.supplierReturnTransitionAllowed as (a: string, b: string) => boolean],
  ['e-document exchange', s.E_DOCUMENT_EXCHANGE_TRANSITIONS, s.EDocumentExchangeStatusSchema.options, s.eDocumentExchangeTransitionAllowed as (a: string, b: string) => boolean],
];

/** All paths from `from` to `to` pass through `via` (search the graph with `via` removed). */
function mustPass(table: Table, from: string, to: string, via: string): boolean {
  const seen = new Set<string>([via]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) return false;
    for (const next of table[cur] ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return true;
}

test('every table covers exactly its states, has no self-transition and agrees with its guard', () => {
  for (const [name, table, states, guard] of tables) {
    assert.deepEqual(Object.keys(table).sort(), [...states].sort(), name);
    for (const from of states) for (const to of states) {
      assert.equal(guard(from, to), (table[from] ?? []).includes(to), `${name} ${from}->${to}`);
      if (from === to) assert.equal(guard(from, to), false, `${name} self ${from}`);
    }
    for (const targets of Object.values(table)) for (const t of targets) assert.ok(states.includes(t), `${name} target ${t}`);
  }
});

test('requisition: forbidden transitions of the lifecycle are rejected', () => {
  const t = s.requisitionTransitionAllowed;
  for (const [a, b] of [['draft', 'approved'], ['draft', 'in_approval'], ['submitted', 'approved'], ['rejected', 'approved'], ['rejected', 'draft'], ['returned', 'approved'], ['fulfilled', 'cancelled'], ['partially_fulfilled', 'cancelled'], ['cancelled', 'sourcing'], ['draft', 'cancelled'], ['in_approval', 'sourcing']] as const) {
    assert.equal(t(a, b), false, `${a}->${b}`);
  }
  for (const [a, b] of [['draft', 'submitted'], ['in_approval', 'returned'], ['returned', 'draft'], ['approved', 'sourcing'], ['sourcing', 'fulfilled'], ['approved', 'cancelled'], ['in_approval', 'submitted']] as const) assert.ok(t(a, b), `${a}->${b}`);
  assert.ok(mustPass(s.REQUISITION_TRANSITIONS, 'draft', 'approved', 'in_approval'), 'approval only through the route');
  assert.ok(mustPass(s.REQUISITION_TRANSITIONS, 'draft', 'fulfilled', 'approved'));
});

test('approval request: every outcome is terminal; expired and superseded never approve', () => {
  for (const terminal of ['approved', 'rejected', 'returned', 'withdrawn', 'expired', 'superseded'] as const) {
    for (const to of s.ApprovalRequestStatusSchema.options) assert.equal(s.approvalTransitionAllowed(terminal, to), false, `${terminal}->${to}`);
  }
  assert.ok(s.approvalTransitionAllowed('pending', 'superseded'));
});

test('trade invoice: no approval without match and approval, no payment without scheduling, open risk signals block', () => {
  const t = (a: s.TradeInvoiceStatus, b: s.TradeInvoiceStatus, openRiskSignals = 0) => s.tradeInvoiceTransitionAllowed(a, b, { openRiskSignals });
  for (const [a, b] of [['received', 'approved'], ['in_review', 'approved'], ['in_review', 'in_approval'], ['duplicate_suspected', 'matched'], ['duplicate_suspected', 'approved'], ['exception', 'matched'], ['matched', 'approved'], ['approved', 'paid'], ['payment_unknown', 'partially_paid'], ['rejected', 'in_review'], ['paid', 'scheduled'], ['credited', 'paid']] as const) {
    assert.equal(t(a, b), false, `${a}->${b}`);
  }
  assert.ok(t('in_approval', 'approved'));
  assert.equal(t('in_approval', 'approved', 1), false, 'open signal blocks approval');
  assert.ok(t('approved', 'scheduled'));
  assert.equal(t('approved', 'scheduled', 2), false, 'open signal blocks scheduling');
  assert.ok(t('in_approval', 'rejected', 1), 'rejection stays possible');
  assert.ok(mustPass(s.TRADE_INVOICE_TRANSITIONS, 'received', 'approved', 'matched'));
  assert.ok(mustPass(s.TRADE_INVOICE_TRANSITIONS, 'received', 'approved', 'in_approval'));
  assert.ok(mustPass(s.TRADE_INVOICE_TRANSITIONS, 'received', 'paid', 'scheduled'));
  assert.ok(mustPass(s.TRADE_INVOICE_TRANSITIONS, 'received', 'matched', 'in_review'), 'a person reviews first');
});

test('payment instruction: an unknown outcome is reconciled, never retried; external payments are only recorded', () => {
  const t = s.paymentInstructionTransitionAllowed;
  for (const [a, b] of [['outcome_unknown', 'submitted'], ['outcome_unknown', 'succeeded'], ['outcome_unknown', 'scheduled'], ['reconciling', 'submitted'], ['failed', 'submitted'], ['failed', 'scheduled'], ['succeeded', 'submitted'], ['external_recorded', 'submitted'], ['scheduled', 'succeeded'], ['pending', 'submitted']] as const) {
    assert.equal(t(a, b), false, `${a}->${b}`);
  }
  assert.ok(mustPass(s.PAYMENT_INSTRUCTION_TRANSITIONS, 'outcome_unknown', 'succeeded', 'reconciling'));
});

test('payment proposal and payee protection: no shortcut past approval, verification or cooling-off', () => {
  for (const [a, b] of [['draft', 'approved'], ['proposed', 'approved'], ['draft', 'executing'], ['proposed', 'executing'], ['completed', 'executing'], ['cancelled', 'draft']] as const) assert.equal(s.paymentProposalTransitionAllowed(a, b), false, `${a}->${b}`);
  assert.ok(mustPass(s.PAYMENT_PROPOSAL_TRANSITIONS, 'draft', 'executing', 'approved'));
  for (const [a, b] of [['requested', 'active'], ['requested', 'cooling_off'], ['verifying', 'active'], ['rejected', 'verifying'], ['active', 'cooling_off']] as const) assert.equal(s.payeeChangeTransitionAllowed(a, b), false, `${a}->${b}`);
  assert.ok(mustPass(s.PAYEE_CHANGE_TRANSITIONS, 'requested', 'active', 'cooling_off'));
  assert.ok(mustPass(s.PAYEE_CHANGE_TRANSITIONS, 'requested', 'active', 'verifying'));
  for (const [a, b] of [['pending_verification', 'active'], ['superseded', 'active'], ['suspended', 'active'], ['rejected', 'active']] as const) assert.equal(s.payeeAccountTransitionAllowed(a, b), false, `${a}->${b}`);
  assert.equal(s.paymentRiskSignalTransitionAllowed('cleared', 'open'), false);
  assert.equal(s.paymentRiskSignalTransitionAllowed('confirmed', 'cleared'), false);
});

test('intake and the other records: no path skips the person', () => {
  assert.ok(mustPass(s.INTAKE_TRANSITIONS, 'received', 'accepted', 'awaiting_review'));
  assert.equal(s.intakeTransitionAllowed('extracting', 'accepted'), false);
  assert.equal(s.intakeTransitionAllowed('duplicate_suspected', 'accepted'), false);
  assert.equal(s.bidLevelSheetTransitionAllowed('frozen', 'draft'), false, 'a frozen sheet never thaws');
  assert.ok(mustPass(s.AWARD_DECISION_TRANSITIONS, 'proposed', 'executed', 'approved'));
  assert.equal(s.awardDecisionTransitionAllowed('rejected', 'executed'), false);
  assert.ok(mustPass(s.SUBSTITUTION_TRANSITIONS, 'proposed', 'approved', 'in_approval'));
  assert.equal(s.goodsReceiptTransitionAllowed('recorded', 'draft'), false, 'corrections append');
  assert.equal(s.externalOrderTransitionAllowed('received', 'cancelled'), false);
  assert.equal(s.externalOrderTransitionAllowed('closed', 'received'), false);
  assert.equal(s.stockTransferTransitionAllowed('received', 'cancelled'), false);
  assert.equal(s.supplierReturnTransitionAllowed('requested', 'credited'), false);
  for (const [a, b] of [['outcome_unknown', 'queued'], ['outcome_unknown', 'sent'], ['received', 'accepted'], ['rejected', 'sent']] as const) assert.equal(s.eDocumentExchangeTransitionAllowed(a, b), false, `${a}->${b}`);
  assert.equal(s.approvalRouteTransitionAllowed('superseded', 'active'), false);
});

test('random walks only ever follow the tables (property)', () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (const [name, table, states, guard] of tables) {
    for (let i = 0; i < 200; i++) {
      const from = states[rnd(states.length)]!;
      const to = states[rnd(states.length)]!;
      if (guard(from, to)) assert.ok(table[from]!.includes(to), `${name} ${from}->${to}`);
    }
  }
});

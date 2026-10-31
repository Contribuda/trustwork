import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../../../packages/contracts/src/supply/index.js';
import * as f from './fixtures.js';

let seed = 20261031;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
const dec = () => {
  const whole = String(1 + rnd(5000));
  const frac = rnd(3) === 0 ? '' : `.${String(rnd(1000)).padStart(3, '0')}`;
  return whole + frac;
};
/** Same value, different spelling: trailing zeros on the fraction. */
const respell = (d: string) => (d.includes('.') ? `${d}00` : `${d}.000`);
const zero = f.tolerance;

const line = (over: Partial<s.MatchLineInput> = {}, q = '10', price = '1250', tax = '100'): s.MatchLineInput => ({
  lineNo: 1, mode: 'three_way',
  order: { orderLineRef: 'l1', quantity: f.qty(q), unitPrice: f.usd(price) },
  receipts: [{ receiptLineRef: 'gr-1', received: q, accepted: q }],
  acceptanceRecorded: false, previouslyInvoiced: '0',
  invoiced: { quantity: f.qty(q), unitPrice: f.usd(price), taxAmount: f.usd(tax), expectedTax: f.usd(tax) },
  ...over,
});

test('an invoice equal to the order and the receipts matches, whatever the decimals and their spelling (property)', () => {
  for (let i = 0; i < 300; i++) {
    const q = dec();
    const price = String(1 + rnd(1_000_000));
    const tax = String(rnd(50_000));
    const l = line({}, q, price, tax);
    assert.equal(s.threeWayMatch([l], zero).overall, 'matched', `q=${q}`);
    const respelled = { ...l, invoiced: { ...l.invoiced, quantity: f.qty(respell(q)) }, receipts: [{ receiptLineRef: 'gr-1', received: respell(q), accepted: q }] };
    assert.equal(s.threeWayMatch([respelled], zero).overall, 'matched', `respelled q=${q}`);
  }
});

test('one minor unit or one millionth over is a variance with zero tolerance and within tolerance at the limit (exact)', () => {
  const l = line();
  const priceUp = { ...l, invoiced: { ...l.invoiced, unitPrice: f.usd('1251') } };
  assert.equal(s.threeWayMatch([priceUp], zero).lines[0]!.result, 'price_variance');
  assert.equal(s.threeWayMatch([priceUp], { ...zero, price: { percent: null, absolute: f.usd('1') }, invoiceTotal: { percent: null, absolute: f.usd('10') } }).lines[0]!.result, 'within_tolerance');
  const qtyUp = { ...l, invoiced: { ...l.invoiced, quantity: f.qty('10.000001') } };
  assert.equal(s.threeWayMatch([qtyUp], zero).lines[0]!.result, 'quantity_variance');
  assert.equal(s.threeWayMatch([qtyUp], { ...zero, quantity: { percent: null, absolute: '0.000001' }, invoiceTotal: { percent: null, absolute: f.usd('1') } }).lines[0]!.result, 'within_tolerance');
  // 2 % of 1250 minor units is exactly 25: 1275 is inside, 1276 is not.
  const pct = { ...zero, price: { percent: '2', absolute: null }, invoiceTotal: { percent: '100', absolute: null } };
  assert.equal(s.threeWayMatch([{ ...l, invoiced: { ...l.invoiced, unitPrice: f.usd('1275') } }], pct).lines[0]!.result, 'within_tolerance');
  assert.equal(s.threeWayMatch([{ ...l, invoiced: { ...l.invoiced, unitPrice: f.usd('1276') } }], pct).lines[0]!.result, 'price_variance');
  // Both limits hold: 2 % allows 25, the absolute limit 10 is stricter.
  assert.equal(s.threeWayMatch([{ ...l, invoiced: { ...l.invoiced, unitPrice: f.usd('1270') } }], { ...pct, price: { percent: '2', absolute: f.usd('10') } }).lines[0]!.result, 'price_variance');
  const taxUp = { ...l, invoiced: { ...l.invoiced, taxAmount: f.usd('101') } };
  assert.equal(s.threeWayMatch([taxUp], zero).lines[0]!.result, 'tax_variance');
});

test('raising a tolerance never turns a line from accepted into a variance (monotonic property)', () => {
  const order = ['matched', 'within_tolerance'];
  for (let i = 0; i < 300; i++) {
    const q = dec();
    const price = String(100 + rnd(100_000));
    const l = line({}, q, price, '0');
    const over = { ...l, invoiced: { ...l.invoiced, quantity: f.qty(String(Number(q.split('.')[0]) + rnd(3))), unitPrice: f.usd(String(Number(price) + rnd(200))) } };
    const small = { ...zero, price: { percent: String(rnd(5)), absolute: null }, quantity: { percent: String(rnd(5)), absolute: null }, invoiceTotal: { percent: '1000', absolute: null } };
    const big = { ...small, price: { percent: String(Number(small.price.percent) + 50), absolute: null }, quantity: { percent: String(Number(small.quantity.percent) + 50), absolute: null } };
    const a = s.threeWayMatch([over], small).lines[0]!.result;
    const b = s.threeWayMatch([over], big).lines[0]!.result;
    if (order.includes(a)) assert.ok(order.includes(b), `${a} -> ${b}`);
  }
});

test('missing order, receipt or acceptance, partial invoicing and unit or currency mismatches', () => {
  const l = line();
  assert.equal(s.threeWayMatch([{ ...l, order: null }], zero).lines[0]!.result, 'no_order');
  assert.equal(s.threeWayMatch([{ ...l, receipts: [] }], zero).lines[0]!.result, 'no_receipt');
  assert.equal(s.threeWayMatch([{ ...l, receipts: [] , mode: 'two_way' }], zero).lines[0]!.result, 'matched', 'two-way compares with the order');
  assert.equal(s.threeWayMatch([{ ...l, mode: 'four_way' }], zero).lines[0]!.result, 'no_acceptance');
  assert.equal(s.threeWayMatch([{ ...l, mode: 'four_way', acceptanceRecorded: true }], zero).lines[0]!.result, 'matched');
  // Received 10, accepted 8: three-way bills against the accepted quantity.
  const partialAccept = { ...l, receipts: [{ receiptLineRef: 'gr-1', received: '10', accepted: '8' }] };
  assert.equal(s.threeWayMatch([partialAccept], zero).lines[0]!.result, 'quantity_variance');
  // Six already invoiced of ten accepted: four more match, five do not.
  const second = { ...l, previouslyInvoiced: '6', invoiced: { ...l.invoiced, quantity: f.qty('4') } };
  assert.equal(s.threeWayMatch([second], zero).lines[0]!.result, 'matched');
  assert.equal(s.threeWayMatch([{ ...second, invoiced: { ...second.invoiced, quantity: f.qty('5') } }], zero).lines[0]!.result, 'quantity_variance');
  assert.equal(s.threeWayMatch([{ ...l, invoiced: { ...l.invoiced, quantity: f.qty('10', 'kg') } }], zero).lines[0]!.result, 'quantity_variance', 'units are never converted implicitly');
  assert.equal(s.threeWayMatch([{ ...l, invoiced: { ...l.invoiced, unitPrice: { minorUnits: '1250', currency: 'EUR' } } }], zero).lines[0]!.result, 'price_variance', 'currencies fail closed');
  assert.equal(s.threeWayMatch([{ ...l, invoiced: { ...l.invoiced, unitPrice: f.usd('1000') } }], zero).lines[0]!.result, 'matched', 'billing under the agreed price is no variance');
});

test('invoice-level tolerance and duplicate suspicion make the whole invoice an exception', () => {
  const lines = [1, 2, 3].map((n) => ({ ...line(), lineNo: n, invoiced: { ...line().invoiced, unitPrice: f.usd('1251') } }));
  const perLine = { ...zero, price: { percent: null, absolute: f.usd('1') } };
  assert.equal(s.threeWayMatch(lines, perLine).overall, 'exception', 'three lines over by 10 each exceed a zero invoice tolerance');
  const out = s.threeWayMatch(lines, { ...perLine, invoiceTotal: { percent: null, absolute: f.usd('30') } });
  assert.equal(out.overall, 'within_tolerance');
  assert.equal(out.invoiceOverMinorUnits, '30');
  assert.equal(s.threeWayMatch([line()], zero, { duplicateSuspected: true }).overall, 'exception');
  assert.equal(s.InvoiceMatchSchema.safeParse({ id: 'm1', tradeInvoiceVersionId: 'tiv-1', tolerancePolicyVersionId: 'tp-1', lines: [], overall: 'matched', duplicateSuspected: true, computedAt: f.at }).success, false);
});

test('invoice arithmetic, normalized numbers and the supplier status view', () => {
  const payload = { lines: [{ lineNo: 1, orderLineRef: 'l1', description: 'Rebar #4', quantity: f.qty('2.5', 't'), unitPrice: f.usd('95001'), taxDeterminationId: null, taxAmount: f.usd('0'), lineTotal: f.usd('237502') }], total: f.usd('237502'), taxTotal: f.usd('0'), dueDate: null, paymentTerms: null, payeeAccountId: null };
  assert.deepEqual(s.invoiceArithmeticMismatches(payload), [], '2.5 x 95001 = 237502.5, half-even to 237502');
  assert.deepEqual(s.invoiceArithmeticMismatches({ ...payload, total: f.usd('237503') }), ['grand total']);
  assert.equal(s.normalizedInvoiceNumber('inv-000123 '), s.normalizedInvoiceNumber('INV 123'));
  const inv: s.TradeInvoice = { id: 'ti-1', issuer: f.supplier, externalCounterpartyId: null, recipient: f.company, number: 'INV-1', basis: { kind: 'order', id: 'order-1' }, origin: 'platform', status: 'duplicate_suspected', currentVersionId: 'tiv-1', duplicateOf: 'ti-0', eDocumentExchangeId: null };
  const view = s.toSupplierInvoiceStatusView(inv, { scheduledFor: null, paidOn: null, disputeReasonCategory: null });
  assert.equal(view.status, 'in_review', 'internal suspicion is not shown to the supplier');
  assert.equal(Object.keys(view).some((k) => /approver|budget|match|note|duplicate/i.test(k)), false);
});

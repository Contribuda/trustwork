import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../../packages/contracts/src/index.js';
import * as d from '../../../packages/contracts/src/deals.js';
import { COMMERCE_CAPABILITIES } from '../../../packages/contracts/src/commerce.js';
import { SUPPLY_CAPABILITIES } from '../../../packages/contracts/src/supply/index.js';

/**
 * COM-002 contracts: the agreement digest covers the terms kind (ADR 012 decision 19), comparison normalization with
 * explicit exclusions (a quote for 10 in v1 is never totalled as 100 in v2), the private constraints that bind agents,
 * electronic-records consent, derived obligations and the capability registry entries (ADR 010 decision 23).
 */
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const ref = (id: string, version: number, value: string) => ({ id, version, digest: { algorithm: 'trustwork-digest-1' as const, value } });
const rfqPayload = (quantity: string) => ({
  title: 'Patio', lines: [{ lineId: 'pavers', kind: 'goods' as const, description: 'Pavers', specification: {}, quantity: { value: quantity, unit: 'm2' }, alternativesAllowed: false }, { lineId: 'laying', kind: 'works' as const, description: 'Laying', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false }],
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } }, acceptanceCriteria: 'Level', paymentTermsRequested: null, currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [],
});
function quotePayload(quantity: string, opts: { unit?: string; extra?: boolean; currency?: string; until?: string } = {}): c.QuoteVersionPayload {
  const currency = opts.currency ?? 'USD';
  const m = (minorUnits: string) => ({ minorUnits, currency });
  const goods = (BigInt(quantity) * 3000n).toString();
  const lines: c.QuoteVersionPayload['lines'] = [
    { lineId: 'q1', rfqLineId: 'pavers', kind: 'goods', specSnapshot: {}, offeringVersionRef: null, quantity: { value: quantity, unit: opts.unit ?? 'm2' }, unitPrice: m('3000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: m('0'), lineTotal: m(goods), substitution: null, options: [] },
    { lineId: 'q2', rfqLineId: 'laying', kind: 'works', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'ls' }, unitPrice: m('50000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: m('0'), lineTotal: m('50000'), substitution: null, options: [] },
  ];
  if (opts.extra) lines.push({ lineId: 'q3', rfqLineId: null, kind: 'services', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '2', unit: 'h' }, unitPrice: m('7000'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: m('0'), lineTotal: m('14000'), substitution: null, options: [] });
  const net = lines.reduce((sum, l) => sum + BigInt(l.lineTotal.minorUnits), 0n).toString();
  return { currency, paymentTerms: 'Net 30', validity: { until: opts.until ?? '2027-06-01T00:00:00.000Z' }, exclusions: ['Permits'], attachments: [], deliveryTerms: { milestones: [{ description: 'All', due: bdate('2027-03-20') }], location: 'Site' }, totals: { net: m(net), tax: m('0'), gross: m(net) }, lines };
}
const seller = { kind: 'company' as const, id: 'company-supplier-1' };
const buyer = { kind: 'person' as const, id: 'person-petr' };

test('the agreement digest covers the terms kind (ADR 012 decision 19); records without a kind are rfq_quote', () => {
  const q = ref('quote-v2', 2, 'a'.repeat(64));
  const r = ref('rfq-v2', 2, 'b'.repeat(64));
  const kinds = c.AgreementTermsKindSchema.options.map((k) => c.computeAgreementDigest(q, r, k).value);
  assert.equal(new Set(kinds).size, 3, 'the same refs under another kind are another agreement');
  assert.deepEqual(c.computeAgreementDigest(q, r), c.computeAgreementDigest(q, r, 'rfq_quote'));
  assert.deepEqual(Object.keys(c.agreementDigestInput(q, r, 'task')), ['termsKind', 'quoteVersion', 'rfqVersion']);
  assert.equal(c.AgreementTermsKindSchema.safeParse('rental').success, false);
});

test('comparison: only versions pinned to the current RFQ version are compared; quantity or unit differences are exclusions, never totals', () => {
  const v1 = { id: 'rfq-v1', version: 1, digest: { algorithm: 'trustwork-digest-1' as const, value: '1'.repeat(64) } };
  const v2 = { ...ref('rfq-v2', 2, '2'.repeat(64)), payload: rfqPayload('100') };
  const entry = (quoteId: string, payload: c.QuoteVersionPayload, rfqVersion: c.VersionRef, status: c.QuoteStatus = 'sent') => ({ quoteId, seller, version: ref(`${quoteId}-v`, 1, 'c'.repeat(64)), rfqVersion, status, payload });
  const versions = [
    entry('old-10-on-v1', quotePayload('10'), v1),
    entry('ten-on-v2', quotePayload('10'), v2),
    entry('hundred-on-v2', quotePayload('100', { extra: true }), v2),
    entry('feet-on-v2', quotePayload('100', { unit: 'ft2' }), v2),
    entry('eur-on-v2', quotePayload('100', { currency: 'EUR' }), v2),
    entry('expired-on-v2', quotePayload('100', { until: '2027-01-01T00:00:00.000Z' }), v2),
    entry('withdrawn-on-v2', quotePayload('100'), v2, 'withdrawn'),
  ];
  const result = d.compareQuotes({ rfqId: 'rfq', mode: 'current', currentRfqVersion: v2, versions, now: new Date('2027-02-01T00:00:00Z') });
  const byId = new Map(result.entries.map((e) => [e.quoteId, e]));
  assert.deepEqual(result.historical.map((h) => [h.quoteId, h.staleReason]), [['old-10-on-v1', 'rfq_amended'], ['withdrawn-on-v2', null]], 'stale and withdrawn versions are historical, never ranked');
  assert.equal(byId.get('ten-on-v2')?.lines[0]?.match, 'quantity_differs');
  assert.equal(byId.get('ten-on-v2')?.comparableTotal, null, 'quantity 10 is never totalled as quantity 100');
  assert.deepEqual(byId.get('ten-on-v2')?.notTotalledBecause, ['scope_mismatch']);
  assert.deepEqual(byId.get('hundred-on-v2')?.comparableTotal?.gross, usd('350000'), 'the unsolicited extra is shown but not totalled');
  assert.deepEqual(byId.get('hundred-on-v2')?.extras.map((x) => x.quoteLineId), ['q3']);
  assert.deepEqual(byId.get('hundred-on-v2')?.exclusions, ['Permits']);
  assert.equal(byId.get('feet-on-v2')?.lines[0]?.match, 'unit_differs', 'no implicit unit conversion');
  assert.deepEqual(byId.get('eur-on-v2')?.notTotalledBecause, ['currency_differs']);
  assert.deepEqual(byId.get('expired-on-v2')?.notTotalledBecause, ['expired']);
  const historical = d.compareQuotes({ rfqId: 'rfq', mode: 'historical', currentRfqVersion: v2, versions, now: new Date('2027-02-01T00:00:00Z') });
  assert.equal(historical.entries.length, 0);
  assert.equal(historical.historical.length, versions.length);
  assert.ok(!JSON.stringify(historical).includes('comparableTotal'));
});

test('the quote payload contract: catalogue units, one answer per RFQ line, exact totals, no tax on an untaxed line', () => {
  assert.ok(d.QuotePayloadWithKnownUnitsSchema.safeParse(quotePayload('10')).success);
  assert.equal(d.QuotePayloadWithKnownUnitsSchema.safeParse(quotePayload('10', { unit: 'cubit' })).success, false);
  const twice = quotePayload('10');
  twice.lines[1] = { ...twice.lines[1]!, rfqLineId: 'pavers' };
  assert.equal(d.QuotePayloadWithKnownUnitsSchema.safeParse(twice).success, false, 'an RFQ line is answered once');
  const wrong = { ...quotePayload('10'), totals: { ...quotePayload('10').totals, gross: usd('1') } };
  assert.equal(d.QuotePayloadWithKnownUnitsSchema.safeParse(wrong).success, false);
  const taxed = quotePayload('10');
  taxed.lines[0] = { ...taxed.lines[0]!, taxAmount: usd('5') };
  assert.equal(d.QuotePayloadWithKnownUnitsSchema.safeParse(taxed).success, false);
});

test('private constraints bind agents: never below the seller floor, never above the buyer ceiling; the checks name lines, not values', () => {
  const payload = quotePayload('100');
  assert.deepEqual(d.linesBelowFloor(payload, { q1: usd('2800') }), []);
  assert.deepEqual(d.linesBelowFloor(payload, { q1: usd('3100') }), ['q1']);
  assert.deepEqual(d.linesBelowFloor(payload, { pavers: usd('3100') }), ['q1'], 'a floor may be keyed by the RFQ line');
  assert.deepEqual(d.linesBelowFloor(payload, { q2: { minorUnits: '1', currency: 'EUR' } }), ['q2'], 'another currency is refused');
  assert.equal(d.aboveCeiling(usd('9500000'), usd('9000000')), true);
  assert.equal(d.aboveCeiling(usd('9000000'), usd('9000000')), false);
  assert.equal(d.aboveCeiling(null, usd('1')), false);
  assert.equal(d.aboveCeiling(usd('1'), null), false);
});

test('electronic records: required consent names the current disclosure', () => {
  const policy = { required: true, disclosureKey: 'us.electronic-records.v1', basis: ['US:eSignature/esign-act', 'US:eSignature/ueta'] };
  assert.ok(d.ElectronicRecordsPolicySchema.safeParse(policy).success);
  assert.equal(d.electronicRecordsSatisfied(policy, null), false);
  assert.equal(d.electronicRecordsSatisfied(policy, { consented: true, disclosureKey: 'us.electronic-records.v0' }), false);
  assert.equal(d.electronicRecordsSatisfied(policy, { consented: true, disclosureKey: 'us.electronic-records.v1' }), true);
  assert.equal(d.electronicRecordsSatisfied({ ...policy, required: false }, null), true);
  assert.equal(d.ElectronicRecordsConsentSchema.safeParse({ consented: false, disclosureKey: 'x' }).success, false, 'consent is affirmative');
});

test('obligations derive from accepted terms; due times are the local start of the milestone business day', () => {
  const obligations = d.deriveObligations({ buyer, seller }, quotePayload('100', { extra: true }));
  assert.deepEqual(obligations.map((o) => [o.party.id, o.kind]), [[seller.id, 'deliver'], [seller.id, 'perform'], [buyer.id, 'pay'], [buyer.id, 'accept']]);
  assert.deepEqual(obligations.find((o) => o.kind === 'pay')?.amount, usd('364000'));
  assert.equal(d.zonedStartOfDay('2027-03-20', 'America/Los_Angeles'), '2027-03-20T07:00:00.000Z');
  assert.equal(d.zonedStartOfDay('2027-01-20', 'America/Los_Angeles'), '2027-01-20T08:00:00.000Z', 'standard time');
  assert.equal(d.zonedStartOfDay('2027-07-01', 'Asia/Tbilisi'), '2027-06-30T20:00:00.000Z');
});

test('every deal capability is a valid AGT-002 entry for the interface and the agent; money actions name the transaction budget', async () => {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const entry of d.DEAL_CAPABILITIES) {
    const cap = entry.capability;
    assert.deepEqual(c.capabilityViolations(cap), [], cap.id);
    for (const r of [cap.input, cap.output]) {
      modules[r.contract] ??= await import(`../../../packages/contracts/src/${r.contract}.js`) as Record<string, unknown>;
      assert.ok(modules[r.contract]?.[r.schema], `${cap.id}: ${r.contract}.${r.schema} is exported`);
    }
    assert.match(entry.apiRoute, /^(GET|POST) \/v1\//);
    if (cap.kind === 'commit') assert.ok(cap.mandateAction !== null && !cap.acceptsUntrustedText, `${cap.id} needs a mandate and structured input`);
    assert.notEqual(cap.budgetKind, 'platform', `${cap.id} charges no platform budget`);
  }
  const caps = d.DEAL_CAPABILITIES.map((e) => e.capability);
  assert.deepEqual(c.parityGaps(caps), []);
  const all = [...caps, ...COMMERCE_CAPABILITIES.map((e) => e.capability), ...SUPPLY_CAPABILITIES.map((e) => e.capability)].map((x) => x.id);
  assert.equal(new Set(all).size, all.length, 'no id is declared twice next to COM-001 and the procurement suite');
  const byId = new Map(caps.map((x) => [x.id, x]));
  assert.equal(byId.get('deal_desk.place_order')?.budgetKind, 'transaction');
  assert.ok(byId.get('deal_desk.place_order')?.sideEffects.includes('money_commitment'));
  assert.deepEqual(byId.get('sourcing_desk.get_quote')?.reads, ['shared_party'], 'the buyer reads the seller quote as a shared projection');
});

test('forbidden keys: what each side must never receive is disjoint from what it owns', () => {
  for (const key of d.SELLER_FORBIDDEN_KEYS) assert.ok(!(d.BUYER_FORBIDDEN_KEYS as readonly string[]).includes(key), key);
  const seller = d.toSellerOrder({ id: 'o', agreementId: 'a', acceptedTermsDigest: { algorithm: 'trustwork-digest-1', value: 'a'.repeat(64) }, status: 'placed', externalReference: null, reservationId: 'reservation-1', revision: 1, createdAt: '2027-01-01T00:00:00Z' });
  assert.ok(!JSON.stringify(seller).includes('reservation'));
});

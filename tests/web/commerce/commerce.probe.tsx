/**
 * WEB-002 probe of the commerce data boundary and the editor arithmetic, run by commerce.test.ts in a child process
 * with this directory's tsconfig (the web app's `@/` paths) under `node --test`. No network: the live adapter talks to
 * a fake transport; the demo adapter reads the synthetic fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuoteTotals, type RfqVersionPayload } from '@trustwork/contracts/client';
import {
  BUYER_FORBIDDEN_KEYS,
  BuyerQuoteViewSchema,
  NeedSchema,
  OwnerRfqViewSchema,
  QuoteComparisonSchema,
  QuotePayloadWithKnownUnitsSchema,
  SELLER_FORBIDDEN_KEYS,
  SellerAgreementViewSchema,
  SellerQuoteViewSchema,
  SUPPLIER_FORBIDDEN_KEYS,
  SupplierRfqViewSchema,
} from '@/components/commerce/contracts';
import { demoCommercePort } from '@/components/commerce/demo';
import { createHttpCommercePort } from '@/components/commerce/http';
import { fromMinor, toMinor } from '@/components/commerce/format';
import { belowFloor, lineAmounts, lineTotalMinor, taxMinor, totals } from '@/components/commerce/quote-math';
import { prefillQuotePayload } from '@/components/commerce/quote-prefill';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import { localeLayers } from '@/app/_lib/locale';
import { data } from '@/app/_lib/data';
import type { AuthenticatedPrincipal } from '@/app/_lib/data';
import type { Transport } from '@/app/_lib/data/http/transport';

// Demo projections read their synthetic line texts from the dictionaries (English reference, US formats).
setLocaleStore({ locale: 'en', country: 'US', layers: localeLayers('en') });

/** Every key anywhere in a JSON value (objects and arrays, recursively). */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keys(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    out.add(k);
    keys(v, out);
  }
  return out;
}
const forbidden = (value: unknown, list: readonly string[]) => [...keys(value)].filter((k) => list.includes(k));

test('quote arithmetic is exact: half-even rounding, tax on the line total, totals the API recomputes', () => {
  assert.equal(lineTotalMinor('1999', '3'), 5997n);
  assert.equal(lineTotalMinor('1000', '2.5'), 2500n);
  assert.equal(lineTotalMinor('333', '0.5'), 166n, '166.5 rounds half to even');
  assert.equal(lineTotalMinor('335', '0.5'), 168n, '167.5 rounds half to even');
  assert.equal(taxMinor(10000n, 'vat', '8.875'), 888n);
  assert.equal(taxMinor(10000n, 'none', '20'), 0n, 'an untaxed line carries no tax');
  const lines = [lineAmounts({ unitPriceMinor: '95000', quantity: '12', tax: 'vat', ratePercent: '12', currency: 'USD' }), lineAmounts({ unitPriceMinor: '120000', quantity: '1', tax: 'none', ratePercent: null, currency: 'USD' })];
  const sum = totals(lines, 'USD');
  assert.deepEqual(sum, { net: { minorUnits: '1260000', currency: 'USD' }, tax: { minorUnits: '136800', currency: 'USD' }, gross: { minorUnits: '1396800', currency: 'USD' } });
  assert.equal(verifyQuoteTotals({ currency: 'USD', lines: lines.map((l) => ({ ...l, unitPrice: { minorUnits: '1', currency: 'USD' } })), totals: sum }), 'ok');
  assert.equal(belowFloor('900', 'USD', { minorUnits: '1000', currency: 'USD' }), true);
  assert.equal(belowFloor('1000', 'USD', { minorUnits: '1000', currency: 'USD' }), false);
  assert.equal(belowFloor('5000', 'USD', { minorUnits: '1000', currency: 'EUR' }), true, 'another currency never passes as above the floor');
});

test('typed amounts convert to minor units exactly and refuse what the currency cannot hold', () => {
  assert.equal(toMinor('1250.5', 'USD'), '125050');
  assert.equal(toMinor('1250,50', 'USD'), '125050');
  assert.equal(toMinor('0.001', 'USD'), null);
  assert.equal(toMinor('-1', 'USD'), null);
  assert.equal(toMinor('abc', 'USD'), null);
  assert.equal(toMinor('1500', 'JPY'), '1500');
  assert.equal(toMinor('1500.5', 'JPY'), null);
  assert.equal(fromMinor('125050', 'USD'), '1250.50');
  assert.equal(fromMinor('5', 'USD'), '0.05');
});

const RFQ: RfqVersionPayload = {
  title: 'Steel beams', currency: 'USD', responseDeadline: '2026-11-20T18:00:00.000Z', attachments: [], acceptanceCriteria: 'Signed delivery note', paymentTermsRequested: 'Net 30',
  deliveryTerms: { location: { region: 'US-TX' }, window: { from: { date: '2026-12-01', timeZone: 'America/Chicago' }, to: { date: '2026-12-10', timeZone: 'America/Chicago' } } },
  lines: [
    { lineId: 'l1', kind: 'goods', description: 'Beams', specification: { grade: 'A992' }, quantity: { value: '10', unit: 't' }, alternativesAllowed: true },
    { lineId: 'l2', kind: 'services', description: 'Delivery', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  ],
};

test('a prefilled quote answers every RFQ line once with the buyer data; an amendment never keeps the old quantity', () => {
  const first = prefillQuotePayload(RFQ, null, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(first.lines.length, 2);
  assert.deepEqual(first.lines.map((l) => l.rfqLineId), ['l1', 'l2']);
  assert.deepEqual(first.lines[0]!.quantity, { value: '10', unit: 't' });
  assert.deepEqual(first.lines[0]!.specSnapshot, { grade: 'A992' });
  QuotePayloadWithKnownUnitsSchema.parse(first);
  const priced = { ...first, lines: first.lines.map((l, i) => ({ ...l, unitPrice: { minorUnits: i === 0 ? '95000' : '50000', currency: 'USD' }, ...lineAmounts({ unitPriceMinor: i === 0 ? '95000' : '50000', quantity: l.quantity.value, tax: 'none', ratePercent: null, currency: 'USD' }) })) };
  const amended: RfqVersionPayload = { ...RFQ, lines: [{ ...RFQ.lines[0]!, quantity: { value: '12', unit: 't' } }, RFQ.lines[1]!] };
  const next = prefillQuotePayload(amended, { ...priced, totals: totals(priced.lines, 'USD') }, Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(next.lines[0]!.quantity, { value: '12', unit: 't' }, 'the quantity follows version 2');
  assert.equal(next.lines[0]!.unitPrice.minorUnits, '95000', 'the price carries over by RFQ line id');
  assert.equal(next.lines[0]!.lineTotal.minorUnits, '1140000', 'and the total is recomputed for 12, never kept for 10');
  QuotePayloadWithKnownUnitsSchema.parse(next);
  assert.ok(Date.parse(next.validity.until) > Date.parse('2026-11-01T00:00:00Z'));
});

/* ---------- Demo adapter: exact contract shapes and no counterparty private half ---------- */

async function principal(persona: 'mixed' | 'owner' | 'reader'): Promise<AuthenticatedPrincipal> {
  const p = await data.principalFor({ persona, scenario: 'default', fromQuery: false, defaultPersona: persona });
  assert.ok(p, `persona ${persona}`);
  return p;
}

test('demo projections parse with the contract schemas and never carry the other side’s private half', async () => {
  const anna = await principal('mixed');
  const rfqs = await demoCommercePort.listRfqs(anna);
  assert.ok(rfqs.length > 0, 'the mixed persona buys');
  let amended = 0;
  for (const item of rfqs) {
    const view = await demoCommercePort.getRfq(anna, item.id);
    assert.ok(view && view.projection === 'owner_private');
    OwnerRfqViewSchema.parse(view);
    if (view.versions.some((v) => v.status === 'superseded')) amended += 1;
    const comparison = await demoCommercePort.getComparison(anna, item.id, 'current');
    if (comparison) QuoteComparisonSchema.parse(comparison);
    for (const entry of comparison?.entries ?? []) {
      const quote = await demoCommercePort.getQuote(anna, entry.quoteId);
      assert.ok(quote && quote.projection === 'shared_party', 'the buyer reads the shared projection of a quote');
      BuyerQuoteViewSchema.parse(quote);
      assert.deepEqual(forbidden(quote, BUYER_FORBIDDEN_KEYS), [], 'no floors, margins, notes or catalogue provenance on the buyer side');
      assert.ok(entry.version.id && comparison?.currentRfqVersion.id, 'entries answer the current version');
    }
    for (const h of comparison?.historical ?? []) assert.equal(h.staleReason, 'rfq_amended', 'versions for an earlier RFQ version are historical, never compared');
  }
  assert.ok(amended > 0, 'the demo shows an amended request with stale quotes');

  const invitations = await demoCommercePort.listInvitations(anna);
  assert.ok(invitations.length > 0, 'the mixed persona also sells');
  for (const item of invitations) {
    const view = await demoCommercePort.getRfq(anna, item.rfq.id);
    assert.ok(view && view.projection === 'shared_party');
    SupplierRfqViewSchema.parse(view);
    assert.deepEqual(forbidden(view, SUPPLIER_FORBIDDEN_KEYS), [], 'an invited supplier never sees budgets, notes, shortlist or the sender');
  }
  for (const item of await demoCommercePort.listQuotes(anna)) {
    const quote = await demoCommercePort.getQuote(anna, item.id);
    assert.ok(quote && quote.projection === 'owner_private');
    SellerQuoteViewSchema.parse(quote);
    assert.deepEqual(forbidden(quote, SELLER_FORBIDDEN_KEYS), []);
  }
  const agreements = await demoCommercePort.listAgreements(anna);
  for (const a of agreements) {
    const view = await demoCommercePort.getAgreement(anna, a.id);
    assert.ok(view);
    if (view.side === 'seller') {
      SellerAgreementViewSchema.parse(view);
      assert.deepEqual(forbidden(view, SELLER_FORBIDDEN_KEYS), [], 'the seller never sees the buyer reservation or budget');
    }
  }
  const needs = await demoCommercePort.listNeeds(anna);
  for (const n of needs) NeedSchema.parse(await demoCommercePort.getNeed(anna, n.id));
});

test('demo visibility follows the persona: no company, no sales; other people’s requests are not found', async () => {
  const olga = await principal('reader');
  assert.deepEqual(await demoCommercePort.listInvitations(olga), []);
  assert.deepEqual(await demoCommercePort.listRfqs(olga), []);
  const anna = await principal('mixed');
  const annaRfq = (await demoCommercePort.listRfqs(anna))[0]!;
  const petr = await principal('owner');
  assert.equal(await demoCommercePort.getRfq(petr, annaRfq.id), null, 'another person’s request answers null (404)');
  assert.equal(await demoCommercePort.getRfq(olga, annaRfq.id), null);
});

/* ---------- Live adapter: strict projections ---------- */

function transport(routes: Record<string, unknown>): Transport {
  return {
    async get(path) {
      if (!(path in routes)) return null;
      return routes[path];
    },
    async hasSession() {
      return true;
    },
  };
}

test('the live adapter refuses a supplier view that carries the buyer’s private half, and answers null for 404', async () => {
  const anna = await principal('mixed');
  const shared = { projection: 'shared_party', rfq: { id: 'r1', buyer: { kind: 'company', id: 'c1' }, status: 'published', category: null }, versions: [], invitations: [] };
  const ok = createHttpCommercePort(transport({ '/v1/rfqs/r1': shared }));
  assert.deepEqual((await ok.getRfq(anna, 'r1'))?.projection, 'shared_party');
  const leaking = createHttpCommercePort(transport({ '/v1/rfqs/r1': { ...shared, privateConstraint: { budgetCeiling: { minorUnits: '1', currency: 'USD' } } } }));
  await assert.rejects(() => leaking.getRfq(anna, 'r1'), 'an unexpected private field fails the parse instead of rendering');
  assert.equal(await ok.getRfq(anna, 'missing'), null);
  assert.equal(await ok.getRfq(anna, '../../v1/me'), null, 'ids outside the token alphabet never reach the API');
  const buyerQuote = { projection: 'shared_party', quote: { id: 'q1', rfqId: 'r1', seller: { kind: 'company', id: 'c2' }, buyer: { kind: 'person', id: 'p1' }, status: 'sent', staleReason: null, currentVersion: 1, revision: 2 }, versions: [], rounds: [], amendmentRequests: [] };
  const withFloors = createHttpCommercePort(transport({ '/v1/quotes/q1': { ...buyerQuote, privateConstraint: { floorPrices: {} } } }));
  await assert.rejects(() => withFloors.getQuote(anna, 'q1'), 'a buyer view with the seller floors is refused');
  assert.equal((await createHttpCommercePort(transport({ '/v1/quotes/q1': buyerQuote })).getQuote(anna, 'q1'))?.projection, 'shared_party');
});

/* ---------- Command builders: the exact contract commands, or a refusal naming the field ---------- */

function fields(values: Record<string, string>, checked: string[] = []) {
  return { get: (name: string) => values[name] ?? '', checked: (name: string) => checked.includes(name) };
}
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REF = (n: number) => ({ id: ID(n), version: 1, digest: { algorithm: 'trustwork-digest-1' as const, value: 'a'.repeat(64) } });

test('command builders produce payloads the contract schemas accept, and refuse with a field to fix', async () => {
  const c = await import('@/components/commerce/contracts');
  const { build } = await import('@/components/commerce/shapes');
  const need = build({ kind: 'need', mode: 'create' }, '/v1/needs', {}, fields({ owner: `person:${ID(1)}`, title: 'Windows', lines: '3', 'line.0.description': 'Triple glazed units', 'line.0.kind': 'goods', 'line.0.quantity': '12', 'line.0.unit': 'pc', 'line.1.description': '', from: '2026-12-01', to: '2026-12-20', timeZone: 'America/New_York', region: 'US-NY', acceptance: 'Installed and sealed' }, ['line.0.alternatives']), null);
  assert.ok(need.ok);
  const needCommand = c.CreateNeedCommandSchema.parse(need.steps[0]!.payload);
  assert.equal(needCommand.fields.lines.length, 1, 'blank new rows are ignored');
  assert.deepEqual(needCommand.fields.lines[0]!.quantity, { value: '12', unit: 'pc' });
  const noTitle = build({ kind: 'need', mode: 'create' }, '/v1/needs', {}, fields({ owner: `person:${ID(1)}`, lines: '0' }), null);
  assert.deepEqual(noTitle, { ok: false, error: 'commerce.need.titleRequired', field: 'title' });
  const badQty = build({ kind: 'need', mode: 'save' }, '/v1/needs/x', { expectedRevision: 2 }, fields({ title: 'W', lines: '1', 'line.0.description': 'x', 'line.0.quantity': '-3' }), null);
  assert.deepEqual(badQty, { ok: false, error: 'commerce.lines.quantityInvalid', field: 'line.0.quantity' });

  const draft = build({ kind: 'rfqDraft', payload: RFQ as unknown as Record<string, unknown>, deadline: { local: '2026-11-20T18:00', value: RFQ.responseDeadline } }, '/v1/rfqs/r/versions/v', { expectedRevision: 3 }, fields({ title: 'Steel beams', lines: '3', 'line.0.lineId': 'l1', 'line.0.description': 'Beams', 'line.0.kind': 'goods', 'line.0.quantity': '12', 'line.0.unit': 't', 'line.0.spec': '{"grade":"A992"}', 'line.1.lineId': 'l2', 'line.1.description': 'Delivery', 'line.1.kind': 'services', 'line.1.quantity': '1', 'line.1.unit': 'ls', region: 'US-TX', from: '2026-12-01', to: '2026-12-10', timeZone: 'America/Chicago', acceptance: 'Signed delivery note', deadline: '2026-11-20T18:00' }, ['line.0.alternatives']), null);
  assert.ok(draft.ok);
  const saved = c.SaveRfqDraftCommandSchema.parse(draft.steps[0]!.payload);
  assert.equal(saved.payload.responseDeadline, RFQ.responseDeadline, 'an untouched deadline keeps its exact instant');
  assert.deepEqual(saved.payload.lines.map((l) => l.lineId), ['l1', 'l2'], 'line ids survive an amendment, so the comparison aligns lines across versions');
  assert.deepEqual(saved.payload.lines[0]!.quantity, { value: '12', unit: 't' });

  const convert = build({ kind: 'convert' }, '/v1/needs/n/convert', { expectedRevision: 4 }, fields({ currency: 'usd', deadline: '2030-01-10T12:00', ceiling: '25000.50', notes: 'Private' }), null);
  assert.ok(convert.ok);
  const conv = c.ConvertNeedCommandSchema.parse(convert.steps[0]!.payload);
  assert.deepEqual(conv.privateConstraint?.budgetCeiling, { minorUnits: '2500050', currency: 'USD' });

  const priv = build({ kind: 'private', currency: 'USD' }, '/v1/rfqs/r/private', { expectedRevision: 1 }, fields({ ceiling: '100', notes: 'n' }), null);
  assert.ok(priv.ok);
  c.SaveRfqPrivateConstraintCommandSchema.parse(priv.steps[0]!.payload);

  const invite = build({ kind: 'invite' }, '/v1/rfqs/r/invitations', { rfqId: ID(2), rfqVersionId: ID(3) }, fields({ supplier: `company:${ID(4)}` }), null);
  assert.ok(invite.ok);
  c.InviteSupplierRequestSchema.parse(invite.steps[0]!.payload);
  assert.equal(build({ kind: 'invite' }, '/v1/rfqs/r/invitations', {}, fields({ supplier: '' }), null).ok, false);

  const ask = build({ kind: 'amendment', currency: 'USD' }, '/v1/quotes/q/amendment-requests', { quoteVersionId: ID(5) }, fields({ lines: '2', 'line.0.lineId': 'q1', 'line.0.price': '900', 'line.1.lineId': 'q2', total: '' }), null);
  assert.ok(ask.ok);
  const request = c.CreateAmendmentRequestCommandSchema.parse(ask.steps[0]!.payload);
  assert.equal(request.changes.length, 1, 'only the lines with a target are asked');

  const base = { rfqId: ID(6), quoteVersion: REF(7), rfqVersion: REF(8), expectedRevision: 2 };
  assert.deepEqual(build({ kind: 'accept' }, '/v1/agreements', base, fields({ disclosureKey: 'trustwork.electronic-records.v1' }), null), { ok: false, error: 'commerce.consent.required', field: 'consent' }, 'no acceptance without consent');
  const accept = build({ kind: 'accept' }, '/v1/agreements', base, fields({ disclosureKey: 'trustwork.electronic-records.v1' }, ['consent']), null);
  assert.ok(accept.ok);
  c.AcceptTermsRequestSchema.parse(accept.steps[0]!.payload);

  const order = build({ kind: 'placeOrder' }, '/v1/agreements/a/orders', { action: 'place_order', context: { kind: 'rfq', id: ID(6) }, agreementId: ID(9), quoteVersion: REF(7), rfqVersion: REF(8), expectedRevision: 2 }, fields({ budget: ID(10), reference: 'PO-1' }), null);
  assert.ok(order.ok);
  const placed = c.PlaceOrderRequestSchema.parse(order.steps[0]!.payload);
  assert.equal(placed.platformBudgetId, null, 'no platform charge in this slice');
  assert.equal('amount' in (order.steps[0]!.payload as Record<string, unknown>), false, 'the total never comes from the browser');

  const quotePayload = prefillQuotePayload(RFQ, null, Date.parse('2026-11-01T00:00:00Z'));
  const quote = build(
    { kind: 'quote', currency: 'USD', payload: quotePayload as unknown as Record<string, unknown>, privatePath: '/v1/quotes/q/private', privateRevision: 1, sendPath: '/v1/quotes/q/send', validity: { local: 'x', value: '2030-01-01T00:00:00.000Z' } },
    '/v1/quotes/q/versions/v',
    { expectedRevision: 3, quoteId: ID(11), version: 1 },
    fields({ 'q.0.quantity': '10', 'q.0.unit': 't', 'q.0.price': '950.00', 'q.0.tax': 'other', 'q.0.rate': '8.25', 'q.0.floor': '900', 'q.1.quantity': '1', 'q.1.unit': 'ls', 'q.1.price': '500', 'q.1.tax': 'none', milestones: '2', 'm.0.description': 'Delivery', 'm.0.due': '2026-12-05', validity: 'x', paymentTerms: 'Net 30', exclusions: 'Crane\n\nPermits', notes: 'Floor is firm' }),
    'send',
  );
  assert.ok(quote.ok);
  assert.equal(quote.steps.length, 3, 'save, private record, then send');
  const savedQuote = c.SaveQuoteDraftCommandSchema.parse(quote.steps[0]!.payload);
  assert.equal(savedQuote.payload.totals.gross.minorUnits, String(950000 + 78375 + 50000), 'exact totals the API recomputes');
  assert.deepEqual(savedQuote.payload.exclusions, ['Crane', 'Permits']);
  const privateStep = c.SaveQuotePrivateCommandSchema.parse(quote.steps[1]!.payload);
  assert.deepEqual(Object.values(privateStep.floorPrices), [{ minorUnits: '90000', currency: 'USD' }]);
  assert.equal(JSON.stringify(quote.steps[0]!.payload).includes('floor'), false, 'floors never travel with the quote version');
  assert.equal(quote.steps[2]!.revisionFromQuote, true);
  c.SendQuoteCommandSchema.parse({ ...quote.steps[2]!.payload, expectedRevision: 4 });
});

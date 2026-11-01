import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PublicFee, PublicPrice, PublicPricing } from '../../../packages/contracts/src/billing-fees.js';
import { computeDigest } from '../../../packages/contracts/src/common/digest.js';
import { publicPricingProjection } from '../../../apps/web/app/_lib/data/http/pricing.js';
import { exactPrice } from '../../../apps/web/app/(public)/[lang]/pricing/money.js';
import { pricingView } from '../../../apps/web/app/(public)/[lang]/pricing/view.js';

const at = '2026-11-01T00:00:00.000Z';
const hubId = randomUUID();
function fee(overrides: Partial<PublicFee['terms']> = {}): PublicFee {
  const value = { id: randomUUID(), hubId, version: 1, terms: { kind: 'task' as const, categoryKey: null, currency: 'USD', basisPoints: null,
    fixedMinor: '0', payer: 'buyer' as const, effectiveFrom: at, effectiveTo: null, acceptanceTextVersion: 'synthetic-1', ...overrides } };
  return { ...value, digest: computeDigest({ action: 'billing.activate_fee_version', ...value }).value };
}
function catalogue(fees: PublicFee[] = []): PublicPricing {
  return { hubId, fees, prices: [], unavailable: ['models', 'capabilities', 'credit_packs'] };
}
function price(): PublicPrice {
  return { id: randomUUID(), version: 1, kind: 'deliverable', code: 'synthetic', currency: 'USD', amountMinor: '9223372036854775807',
    effectiveFrom: at, effectiveTo: null, validity: null, planVersion: null };
}
test('exact monetary display retains the final minor units at bigint maximum in all seven languages', () => {
  for (const locale of ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) {
    const display = exactPrice('9223372036854775807', 'USD', locale);
    assert.equal(display.replace(/[^0-9]/g, ''), '9223372036854775807');
    assert.ok(display.includes('USD'));
    assert.equal(exactPrice('1', 'USD', locale).replace(/[^0-9]/g, ''), '001');
    assert.equal(exactPrice('0', 'USD', locale).replace(/[^0-9]/g, ''), '000');
    assert.equal(exactPrice('9223372036854775807', 'JPY', locale).replace(/[^0-9]/g, ''), '9223372036854775807');
    assert.equal(exactPrice('1001', 'KWD', locale).replace(/[^0-9]/g, ''), '1001');
  }
});
test('public projection rejects mixed hubs, changed fee terms/digests, private fields and invalid versions', () => {
  const current = fee();
  assert.deepEqual(publicPricingProjection(catalogue([current])), catalogue([current]));
  for (const invalid of [
    { ...catalogue([current]), hubId: randomUUID() },
    { ...catalogue([current]), hubId: null },
    catalogue([{ ...current, terms: { ...current.terms, fixedMinor: '1' } }]),
    catalogue([{ ...current, digest: 'a'.repeat(64) }]),
    catalogue([current, current]),
    { ...catalogue(), providerCost: '99' },
    { ...catalogue(), prices: [{ ...price(), draftedBy: randomUUID() }] },
    { ...catalogue(), prices: [{ ...price(), effectiveTo: at }] },
    { ...catalogue(), prices: [{ ...price(), kind: 'plan' }] },
    { ...catalogue(), prices: [{ ...price(), kind: 'credit_pack' }] },
  ]) assert.throws(() => publicPricingProjection(invalid));
  assert.throws(() => publicPricingProjection(null));
});
test('current, future and expired versions respect exact half-open boundaries, independent of locale', () => {
  const current = fee();
  const future = fee({ effectiveFrom: '2026-11-02T00:00:00.000Z' });
  const expired = fee({ effectiveFrom: '2026-10-31T00:00:00.000Z', effectiveTo: at });
  const view = pricingView(catalogue([future, expired, current]), at);
  const section = view.sections.find(s => s.key === 'fees')!;
  assert.deepEqual(section.current.map(r => r.value.id), [current.id]);
  assert.deepEqual(section.future.map(r => r.value.id), [future.id]);
  assert.equal(view.hubId, hubId);
  assert.deepEqual(pricingView(catalogue([current, future, expired]), at), view);
  assert.equal(pricingView(catalogue([future]), future.terms.effectiveFrom).sections.find(s => s.key === 'fees')!.current[0]?.value.id, future.id);
});
test('legacy missing coverage, explicit zero, unconfigured and failed reads stay distinct', () => {
  assert.equal(pricingView(null, at).state, 'error');
  assert.equal(pricingView({ ...catalogue(), hubId: null }, at).state, 'unconfigured');
  const empty = pricingView(catalogue(), at);
  assert.equal(empty.state, 'partial');
  assert.ok(empty.sections.every(s => s.state === 'unavailable'));
  const zero = pricingView(catalogue([fee()]), at).sections.find(s => s.key === 'fees')!;
  assert.equal(zero.state, 'available');
  assert.equal(zero.current.length, 1);
});

test('owning snapshot separates complete, confirmed-empty, missing and failed readers', () => {
  const coverage: NonNullable<PublicPricing['coverage']> = { generatedAt: at, sections: { fees:'available',plans:'available',services:'available',models:'available',capabilities:'available',credit_packs:'available' } };
  const complete = pricingView({...catalogue(),coverage}, '2099-01-01T00:00:00Z');
  assert.equal(complete.state,'complete');
  assert.equal(complete.at,at);
  assert.ok(complete.sections.every(s=>s.state==='empty'));
  coverage.sections.models='unavailable';coverage.sections.plans='error';
  const partial=pricingView({...catalogue([fee()]),coverage}, '2099-01-01T00:00:00Z');
  assert.equal(partial.state,'partial');
  assert.equal(partial.sections.find(s=>s.key==='plans')?.state,'error');
  assert.equal(partial.sections.find(s=>s.key==='models')?.state,'unavailable');
  assert.equal(partial.sections.find(s=>s.key==='services')?.state,'empty');
  assert.equal(partial.sections.find(s=>s.key==='fees')?.current.length,1);
  assert.throws(()=>publicPricingProjection({...catalogue(),hubId:null,coverage}));
  coverage.sections.fees='error';
  assert.throws(()=>publicPricingProjection({...catalogue([fee()]),coverage}));
});

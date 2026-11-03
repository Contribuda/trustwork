import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PublicFee, PublicPrice, PublicPricing, PublicReferral } from '../../../packages/contracts/src/billing-fees.js';
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
  const coverage: NonNullable<PublicPricing['coverage']> = { generatedAt: at, sections: { fees:'available',plans:'available',services:'available',models:'available',capabilities:'available',credit_packs:'available',referrals:'available' } };
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

function referral(overrides: Partial<PublicReferral['terms']> = {}): PublicReferral {
  return { id: randomUUID(), hubId, version: 1, digest: 'a'.repeat(64), terms: { programmeKey: 'synthetic_invite', eligibleParties: 'person', rewardKind: 'platform_credit', currency: 'USD',
    referrerRewardMinor: '100', refereeRewardMinor: '0', maxRewardsPerReferrer: null, effectiveFrom: at, effectiveTo: null, acceptanceTextVersion: 'synthetic-1', publicTerms: { en: 'Synthetic' }, ...overrides } };
}
test('referral terms have their own section and states: none, published, unavailable, failed', () => {
  const coverage = (referrals: 'available' | 'unavailable' | 'error') => ({ generatedAt: at, sections: { fees: 'available', plans: 'available', services: 'available', models: 'available', capabilities: 'available', credit_packs: 'available', referrals } }) as NonNullable<PublicPricing['coverage']>;
  const section = (pricing: PublicPricing) => pricingView(pricing, at).sections.find(s => s.key === 'referrals')!;
  assert.equal(section({ ...catalogue(), referrals: [], coverage: coverage('available') }).state, 'empty');
  assert.equal(section({ ...catalogue(), referrals: [], coverage: coverage('error') }).state, 'error');
  assert.equal(section({ ...catalogue(), referrals: [], coverage: coverage('unavailable') }).state, 'unavailable');
  assert.equal(section(catalogue()).state, 'unavailable', 'an older response without the section claims nothing');
  const current = referral(); const future = referral({ effectiveFrom: '2026-11-02T00:00:00.000Z' }); const expired = referral({ effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: at });
  const published = section({ ...catalogue(), referrals: [future, expired, current], coverage: coverage('available') });
  assert.equal(published.state, 'available');
  assert.deepEqual(published.current.map(r => r.value.id), [current.id]);
  assert.deepEqual(published.future.map(r => r.value.id), [future.id]);
  const { referrals: _none, ...older } = coverage('available').sections; void _none;
  assert.equal(pricingView({ ...catalogue(), coverage: { generatedAt: at, sections: older } }, at).state, 'partial', 'without the referral reader the catalogue is not complete');
});
test('public projection refuses referrals of another hub, from an unavailable reader, without a hub, or duplicated', () => {
  const current = referral();
  const sections = { fees: 'available', plans: 'available', services: 'available', models: 'unavailable', capabilities: 'unavailable', credit_packs: 'unavailable', referrals: 'available' } as const;
  assert.deepEqual(publicPricingProjection({ ...catalogue(), referrals: [current] }).referrals, [current]);
  for (const invalid of [
    { ...catalogue(), referrals: [{ ...current, hubId: randomUUID() }] },
    { ...catalogue(), hubId: null, referrals: [current] },
    { ...catalogue(), referrals: [current, current] },
    { ...catalogue(), referrals: [current], coverage: { generatedAt: at, sections: { ...sections, referrals: 'error' } } },
    { ...catalogue(), referrals: [{ ...current, terms: { ...current.terms, rewardKind: 'cash' } }] },
    { ...catalogue(), referrals: [{ ...current, legalReviewRef: 'private' }] },
  ]) assert.throws(() => publicPricingProjection(invalid));
});

test('public projection refuses a sale price without its unit and a credit pack without its validity', () => {
  const disclosure = { offerId: randomUUID(), name: 'Synthetic', acceptanceTextVersion: 'synthetic-1', plan: null };
  const sale = { modelId: 'synthetic-model', capabilityId: null, meter: 'model_tokens' as const, perUnits: '1000' };
  const creditPack = { creditMinor: '1000', validityDays: 90, expiryNoticeDays: 14, refundPolicyVersion: 'synthetic-refund-1' };
  const model = { ...price(), kind: 'model' as const, disclosure: { ...disclosure, sale, creditPack: null } };
  const pack = { ...price(), kind: 'credit_pack' as const, validity: 'P90D', disclosure: { ...disclosure, sale: null, creditPack } };
  assert.equal(publicPricingProjection({ ...catalogue(), prices: [model, pack] }).prices.length, 2);
  for (const invalid of [
    { ...model, disclosure: { ...disclosure, sale: null } },
    { ...model, disclosure: undefined },
    { ...pack, disclosure: { ...disclosure, creditPack: null } },
    { ...pack, validity: null },
    { ...model, disclosure: { ...model.disclosure, sale: { ...sale, providerCost: '1' } } },
  ]) assert.throws(() => publicPricingProjection({ ...catalogue(), prices: [invalid] }));
  const view = pricingView({ ...catalogue(), prices: [model, pack] }, at);
  assert.equal(view.sections.find(s => s.key === 'models')?.current[0]?.value.id, model.id);
  assert.equal(view.sections.find(s => s.key === 'credit_packs')?.current[0]?.value.id, pack.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import * as contracts from '../../../packages/contracts/src/billing-fees.js';
import { MARKETPLACE_FEE_KINDS } from '../../../packages/contracts/src/hub.js';

/**
 * Payment neutrality as a schema and a source property (ADR 010 decision 21). Every setting a hub can write into a fee,
 * price or referral version is enumerated from the strict contracts; none may name a discovery or reputation control.
 * The other direction is a scan: code that orders or scores people and offers never reads a fee, price or referral record.
 */
const CONTROL = /rank|match|recommend|reputation|boost|score|weight|priorit|position|badge|visib|sponsor|promot|participant|personId|companyId|partyId/i;

function keysOf(schema: z.ZodType, path = ''): string[] {
  const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; options?: z.ZodType[]; innerType?: z.ZodType; in?: z.ZodType; element?: z.ZodType; valueType?: z.ZodType } }).def;
  if (def.type === 'object') return Object.entries(def.shape ?? {}).flatMap(([key, value]) => [`${path}${key}`, ...keysOf(value, `${path}${key}.`)]);
  if (def.type === 'union') return (def.options ?? []).flatMap((option) => keysOf(option, path));
  const inner = def.innerType ?? def.in ?? def.element ?? def.valueType;
  return inner ? keysOf(inner, path) : [];
}
function strictAtEveryLevel(schema: z.ZodType): boolean {
  const def = (schema as unknown as { def: { type: string; catchall?: { def?: { type?: string } }; shape?: Record<string, z.ZodType>; options?: z.ZodType[]; innerType?: z.ZodType; in?: z.ZodType; element?: z.ZodType; valueType?: z.ZodType } }).def;
  if (def.type === 'object') return def.catchall?.def?.type === 'never' && Object.values(def.shape ?? {}).every(strictAtEveryLevel);
  if (def.type === 'union') return (def.options ?? []).every(strictAtEveryLevel);
  const inner = def.innerType ?? def.in ?? def.element ?? def.valueType;
  return inner ? strictAtEveryLevel(inner) : true;
}
const SETTINGS: Readonly<Record<string, z.ZodType>> = { FeeTermsSchema: contracts.FeeTermsSchema, ReferralTermsSchema: contracts.ReferralTermsSchema, SalePriceTermsSchema: contracts.SalePriceTermsSchema };

test('no fee, commission or referral configuration key can name a discovery, reputation or participant control', () => {
  for (const [name, schema] of Object.entries(SETTINGS)) {
    const keys = keysOf(schema);
    assert.ok(keys.length >= 8, `${name} is enumerated`);
    assert.deepEqual(keys.filter((key) => CONTROL.test(key)), [], name);
    assert.ok(strictAtEveryLevel(schema), `${name} refuses unknown keys at every level`);
  }
});

const ROOT = process.cwd();
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);
    return /\.(ts|tsx|sql)$/.test(name) ? [path] : [];
  });
}
/** The code that decides order, comparison, reputation and listing. Module owners extend this list, never shrink it. */
const DISCOVERY = [
  'apps/api/src/modules/directory', 'apps/api/src/modules/trust', 'apps/api/src/modules/profiles', 'apps/api/src/modules/reputation', 'apps/api/src/modules/supplier-base',
  'packages/contracts/src/deals.ts', 'packages/data/src/repositories/directory.ts', 'packages/data/src/repositories/reputation.ts',
  'packages/data/migrations/directory', 'packages/data/migrations/reputation',
];
const FEE_RECORDS = /marketplace_fee_version|billing_fee_|billingFees|bookingFees|billingReferrals|billingSalePrices|referral_terms_version|price_sale_|price_version|priceVersion|credit_pack|offer_id|subscription_plan_version|entitlement/;

test('no ranking, comparison, directory or reputation source reads a fee, price, plan, entitlement or referral record', () => {
  const files = DISCOVERY.flatMap((path) => {
    try { return statSync(join(ROOT, path)).isDirectory() ? sources(path) : [path]; } catch { return []; }
  });
  assert.ok(files.length >= 12, `the scan covers real sources (${files.length})`);
  // Comments may state the rule ("no entitlement input"); only code counts.
  const code = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)(\/\/|--).*$/gm, '');
  assert.deepEqual(files.filter((file) => FEE_RECORDS.test(code(file))), []);
});

test('fee sources import no ranking, directory or reputation code, so a fee cannot write to them', () => {
  const files = [...sources('apps/api/src/modules/billing/fees'), 'packages/data/src/repositories/billing-fees.ts', 'packages/contracts/src/billing-fees.ts'];
  assert.deepEqual(files.filter((file) => /from '[^']*(directory|reputation|modules\/trust|supplier-base)[^']*'/.test(readFileSync(join(ROOT, file), 'utf8'))), []);
});

/** Conductor ruling, 2026-11-03: no commission on RFQ and quote orders for now; the frozen contract stands. */
test('RFQ and quote orders carry no commission: no fee kind names them and the order path reads no fee record', () => {
  assert.deepEqual([...MARKETPLACE_FEE_KINDS], ['consultation', 'task', 'ticket', 'course']);
  const terms = { categoryKey: null, currency: 'USD', basisPoints: 100, fixedMinor: null, payer: 'buyer', effectiveFrom: '2029-01-01T00:00:00.000Z', effectiveTo: null, acceptanceTextVersion: 'synthetic-1' };
  assert.equal(contracts.FeeTermsSchema.safeParse({ ...terms, kind: 'task' }).success, true);
  for (const kind of ['rfq', 'rfq_quote', 'quote', 'order', 'marketplace']) assert.equal(contracts.FeeTermsSchema.safeParse({ ...terms, kind }).success, false, kind);
  const orderPath = [...sources('apps/api/src/modules/transactions'), ...sources('apps/api/src/modules/procurement'), ...sources('apps/api/src/modules/sales')];
  assert.ok(orderPath.length >= 10, `the scan covers real sources (${orderPath.length})`);
  assert.deepEqual(orderPath.filter((file) => /marketplace_fee_version|billing_fee_|billingFees|bookingFees|feeConfirmation|billing\/fees/.test(readFileSync(join(ROOT, file), 'utf8'))), []);
  assert.match(readFileSync(join(ROOT, 'apps/api/src/modules/transactions/transactions.service.ts'), 'utf8'), /no_platform_charge/);
});

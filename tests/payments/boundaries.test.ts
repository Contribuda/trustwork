import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function sources(path: string, extension = '.ts'): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sources(join(path, e.name), extension) : e.name.endsWith(extension) ? [join(path, e.name)] : []);
}

/** Every file PAY-001 owns that can touch money: API module, worker, contracts, data access and migrations. */
const PAYMENT_CODE = [
  ...sources('apps/api/src/modules/payments'),
  ...sources('apps/worker/src/payments'),
  'packages/contracts/src/payments.ts', 'packages/contracts/src/payment-sources.ts',
  'packages/data/src/repositories/payments.ts', 'packages/data/src/repositories/payment-sources.ts',
  'packages/data/src/schema/payments.ts', 'packages/data/src/schema/payment-sources.ts',
];
const PAYMENT_MIGRATIONS = sources('packages/data/migrations/payments', '.sql');
/** Comments explain what is absent; the identifiers below must not appear as code anywhere. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|--).*$/gm, '');

test('ranking, matching and reputation modules do not depend on payment state or payment providers', () => {
  const files = [...sources('apps/api/src/modules'), ...sources('packages/contracts/src')]
    .filter((p) => /(?:ranking|matching|recommendation|reputation)/.test(p));
  assert.ok(files.length > 0);
  for (const path of files) assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s+['"][^'"]*\/payments|payment_intent|payment_operation|PaymentProviders|PaymentStateSchema)/, path);
});

test('the shipped payment bootstrap contains no real provider or account bootstrap', () => {
  const main = readFileSync('apps/worker/src/main.ts', 'utf8');
  assert.match(main, /const payments: PaymentRuntime = \{ pool, providers: new PaymentProviders\(\) \}/);
  const migration = readFileSync('packages/data/migrations/payments/20261123100000_payment_operations.sql', 'utf8');
  assert.doesNotMatch(migration, /INSERT INTO trustwork\.(?:payment_source|payment_rail|billing_account)/);
  assert.match(migration, /custody='provider_connected_accounts'/);
});

test('no code path converts currency or computes a settlement from a reference rate', () => {
  assert.ok(PAYMENT_CODE.length >= 12 && PAYMENT_MIGRATIONS.length >= 16);
  const forbidden = /\b(?:exchange_?rates?|fx_?rates?|reference_?rates?|conversion_?rates?|exchangeRates?|fxRates?|referenceRates?|conversionRates?|convert(?:Currency|Amount|Money)|currency_?conversion|currencyConversion)\b/i;
  for (const path of [...PAYMENT_CODE, ...PAYMENT_MIGRATIONS]) {
    const code = withoutComments(readFileSync(path, 'utf8'));
    assert.doesNotMatch(code, forbidden, path);
  }
  for (const path of PAYMENT_MIGRATIONS) {
    const code = withoutComments(readFileSync(path, 'utf8'));
    // Amounts are copied and compared as exact minor units: never multiplied, divided, rounded or cast to a decimal.
    assert.doesNotMatch(code, /amount_?minor['")]*(?:::(?:bigint|integer))?\s*[*/]/i, path);
    assert.doesNotMatch(code, /\b(?:round|trunc|ceil|floor)\s*\(/i, path);
    assert.doesNotMatch(code, /::(?:numeric|decimal|double precision|real|float)/i, path);
  }
  // Every receipt binds the exact original amount and currency; a differing one is a binding mismatch, never a conversion.
  const receipt = readFileSync('packages/data/migrations/payments/20261123100000_payment_operations.sql', 'utf8');
  assert.match(receipt, /e->>'amountMinor' IS DISTINCT FROM p\.binding->>'amountMinor' OR e->>'currency' IS DISTINCT FROM p\.binding->>'currency'/);
  // The provider port carries one currency per instruction and parses amounts as integer strings only.
  const contracts = readFileSync('packages/contracts/src/payments.ts', 'utf8');
  assert.match(contracts, /PaymentMinorSchema = z\.string\(\)\.regex\(\/\^\[1-9\]\\d\{0,17\}\$\/\)/);
  assert.equal((contracts.match(/currency: CurrencySchema/g) ?? []).length, 3);
});

test('no payments table or function holds, pools or credits a balance of Trustwork or the hub operator', () => {
  for (const path of PAYMENT_MIGRATIONS) {
    const code = withoutComments(readFileSync(path, 'utf8'));
    assert.doesNotMatch(code, /INSERT INTO trustwork\.(?:payment_source|payment_rail|billing_account|ledger_entry|budget)\b/, path);
    assert.doesNotMatch(code, /CREATE TABLE trustwork\.payment_\w*(?:balance|wallet|float|pool|treasury)\w*/i, path);
    assert.doesNotMatch(code, /\b(?:operator|platform|trustwork|hub)_?(?:balance|wallet|account_ref|float)\b/i, path);
    // The ledger is touched only through BILL-001's outcome functions, with the original reservation and evidence.
    for (const call of code.matchAll(/trustwork\.billing_(\w+)\(/g)) assert.ok(['hold_for_effect', 'close_from_outcome', 'refund', 'may_spend'].includes(call[1]!), `${path}: billing_${call[1]}`);
  }
  for (const path of PAYMENT_CODE) assert.doesNotMatch(withoutComments(readFileSync(path, 'utf8')), /\b(?:operatorAccount(?!InFundsFlow)|platformBalance|operatorBalance|hubBalance|walletBalance|creditBalance)\b/, path);
  // Every rail declares provider custody and is guarded against restricted places and operator routing.
  const guard = readFileSync('packages/data/migrations/payments/20261201100000_payment_rail_guard.sql', 'utf8');
  assert.match(guard, /CREATE TRIGGER payment_rail_guard BEFORE INSERT OR UPDATE ON trustwork\.payment_rail/);
  assert.match(guard, /trustwork\.kernel_place_restricted\(v\)/);
  assert.match(guard, /NEW\.custody <> 'provider_connected_accounts'/);
  assert.match(guard, /\(NEW\.evidence_mode = 'synthetic'\) <> \(c\.mode = 'fake'\)/);
  // The route check refuses an operator account in the funds flow and funds held by anyone but a licensed provider.
  const routeDefinitions = PAYMENT_MIGRATIONS.filter((p) => /FUNCTION trustwork\.payments_route_available\(|FUNCTION trustwork\.payments_candidate_routes\(|'fundsHeldBy'/.test(readFileSync(p, 'utf8')));
  assert.ok(routeDefinitions.length >= 4);
  for (const path of routeDefinitions) {
    const route = readFileSync(path, 'utf8');
    assert.match(route, /cfg(?:\.payload)?->>'fundsHeldBy' IS DISTINCT FROM 'licensed_payment_provider'/, path);
    assert.match(route, /cfg(?:\.payload)?->'operatorAccountInFundsFlow' IS DISTINCT FROM 'false'::jsonb/, path);
  }
  // The review checklist travels with the module so a reviewer reads it next to the code.
  const readme = readFileSync('apps/api/src/modules/payments/README.md', 'utf8');
  assert.match(readme, /^## No held funds: review checklist$/m);
  for (const item of ['operatorAccountInFundsFlow', 'provider_connected_accounts', 'billing_close_from_outcome', 'kernel_place_restricted', 'amountMinor']) assert.ok(readme.includes(item), `checklist names ${item}`);
});

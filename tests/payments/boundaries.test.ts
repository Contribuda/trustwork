import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function sources(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sources(join(path, e.name)) : e.name.endsWith('.ts') ? [join(path, e.name)] : []);
}

test('ranking, matching and reputation modules do not depend on payment state or payment providers', () => {
  const files = [...sources('apps/api/src/modules'), ...sources('packages/contracts/src')]
    .filter((p) => /(?:ranking|matching|recommendation|reputation)/.test(p));
  assert.ok(files.length > 0);
  for (const path of files) assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s+['"][^'"]*\/payments|payment_intent|payment_operation|PaymentProviders|PaymentStateSchema)/, path);
});

test('the shipped payment bootstrap contains no real provider or account bootstrap', () => {
  const main = readFileSync('apps/worker/src/main.ts', 'utf8');
  assert.match(main, /const payments: PaymentRuntime = \{ pool, providers: new PaymentProviders\(\) \}/);
  const migration = readFileSync('packages/data/migrations/payments/20261119100000_payment_operations.sql', 'utf8');
  assert.doesNotMatch(migration, /INSERT INTO trustwork\.(?:payment_source|payment_rail|billing_account)/);
  assert.match(migration, /custody='provider_connected_accounts'/);
});

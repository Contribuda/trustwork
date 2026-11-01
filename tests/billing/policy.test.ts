import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { budgetKindFor } from '../../packages/contracts/src/billing.js';
import { decideEntitlement, FREE_BASIC_FEATURES, SPENDING_ACTIONS } from '../../apps/api/src/modules/billing/policy.js';
import { SYNTHETIC_OFFERS } from '../../apps/api/src/modules/billing/synthetic-catalogue.js';
import { mapBillingError } from '../../apps/api/src/modules/billing/billing.service.js';
import { ApiError } from '../../apps/api/src/common/errors.js';
import type { EntitlementRow } from '../../packages/data/src/schema/billing.js';

const BILLING_TABLES = ['billing_account', 'offer', 'subscription_plan_version', 'price_version', 'price_acceptance', 'subscription', 'entitlement', 'meter_rate_version',
  'marketplace_fee_version', 'usage_record', 'budget', 'reservation', 'ledger_entry', 'credit_grant'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|sql)$/.test(name) ? [path] : [];
  });
}

test('free basic participation is the same for every party and needs no entitlement; roles are not an input', () => {
  for (const key of FREE_BASIC_FEATURES) assert.deepEqual(decideEntitlement({ kind: 'participation', key }, []), { allowed: true, basis: 'free_basic' });
  assert.equal(decideEntitlement.length, 2, 'decision inputs are the feature and the entitlements only: no role, permission, ranking or reputation input');
  const row = { id: 'e1', module_code: 'quoting', offer_code: 'synthetic_agent_capacity', source: 'trial' } as unknown as EntitlementRow & { offer_code: string };
  assert.deepEqual(decideEntitlement({ kind: 'module', moduleCode: 'quoting' }, [row]), { allowed: true, basis: 'entitlement', entitlementId: 'e1', source: 'trial' });
  assert.deepEqual(decideEntitlement({ kind: 'module', moduleCode: 'research' }, [row]), { allowed: false, basis: 'none' });
});

test('every spending action needs exactly one budget kind; transaction actions never map to platform and vice versa', () => {
  assert.deepEqual(SPENDING_ACTIONS.map((a) => [a, budgetKindFor(a)]), [['place_order', 'transaction'], ['accept_order', 'transaction'], ['generate_deliverable', 'platform'], ['subscribe', 'platform']]);
  assert.equal(budgetKindFor('send_quote'), null, 'sending a quote spends nothing');
});

test('the synthetic catalogue is labelled and never claims a real price', () => {
  for (const offer of SYNTHETIC_OFFERS) {
    assert.match(offer.code, /^synthetic_/);
    assert.match(offer.name, /^Synthetic /);
    assert.match(offer.amountMinor, /^(0|100)$/, 'placeholder amounts only (zero or one currency unit)');
  }
});

test('payment neutrality by construction: only billing and the exact settlement boundary read billing tables', () => {
  const roots = ['packages/data/src', 'packages/data/migrations', 'apps/api/src', 'apps/worker/src', 'packages/contracts/src'];
  const offenders: string[] = [];
  const pattern = new RegExp(`(trustwork\\.(${BILLING_TABLES.join('|')})\\b|(selectFrom|insertInto|updateTable|innerJoin|leftJoin)\\('(${BILLING_TABLES.join('|')})( as [a-z]+)?'\\))`);
  // PAY-001 reuses the original commercial reservation. This is not entitlement/ranking access.
  const settlementReaders = new Set([
    'packages/data/migrations/payments/20261123100000_payment_operations.sql',
    'packages/data/migrations/payments/20261123100005_payment_current_authority.sql',
  ]);
  for (const root of roots) {
    for (const path of files(root)) {
      const rel = relative('.', path);
      if (rel.includes('/billing') || rel.endsWith('billing.ts')) continue;
      const source = readFileSync(path, 'utf8');
      if (settlementReaders.has(rel)) {
        const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))];
        for (const match of matches) assert.ok(['budget', 'reservation'].includes(match[2] ?? match[4] ?? ''), `${rel}: only original settlement funds`);
      } else if (pattern.test(source)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'ranking, matching, directory, reputation and other modules stay blind to billing; only exact settlement readers are allowed');
});

test('no float money in the billing slice', () => {
  const migration = files('packages/data/migrations/billing').map((f) => readFileSync(f, 'utf8')).join('\n').replace(/--.*$/gm, '');
  assert.doesNotMatch(migration, /\b(real|double precision|numeric|float\d?|money)\b(?!\s*\))/i);
  for (const source of [...files('apps/api/src/modules/billing'), 'packages/data/src/repositories/billing.ts']) {
    const text = readFileSync(source, 'utf8');
    assert.doesNotMatch(text, /parseFloat|Number\(\s*[a-z_.]*minor|toFixed\(/i, `${source} never turns money into a JavaScript number`);
  }
});

test('database refusals map to frozen contract codes with the billing reason', () => {
  const mapped = mapBillingError({ code: '42501', hint: 'billing.budget_kind_mismatch', message: 'kind' });
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.code, 'commercial.authority_missing');
  assert.deepEqual(mapped.details, { reason: 'billing.budget_kind_mismatch' });
  assert.equal((mapBillingError({ code: '23514', hint: 'billing.activator_is_drafter' }) as ApiError).code, 'access.second_approver_required');
  const plain = new Error('x');
  assert.equal(mapBillingError(plain), plain);
});

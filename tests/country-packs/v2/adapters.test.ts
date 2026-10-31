import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidatedScreeningList } from '@trustwork/compliance';
import { PROVIDER_CAPABILITIES } from '@trustwork/contracts/client';
import { ENGINE_ADAPTERS } from '@trustwork/country-packs';

test('the adapter registry lists only adapters that exist in engine code', async () => {
  const implementations: Record<string, () => { id: string }> = {
    'us-consolidated-screening-list': () => consolidatedScreeningList(),
  };
  for (const adapter of ENGINE_ADAPTERS) {
    assert.ok(PROVIDER_CAPABILITIES.includes(adapter.capability), adapter.id);
    const make = implementations[adapter.id];
    assert.ok(make, `${adapter.id} has an implementation checked here`);
    assert.equal(make().id, adapter.id);
  }
  const screening = await consolidatedScreeningList().screen({ name: 'Synthetic Test Company' });
  assert.deepEqual(screening, { status: 'not_run', reason: 'missing_key' }, 'without a key the adapter makes no call');
});

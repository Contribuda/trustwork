import test from 'node:test';
import assert from 'node:assert/strict';
import { LIST_ADAPTERS, findListAdapter } from '../../packages/compliance/src/lists/index.js';
import { ENGINE_ADAPTERS, findAdapter } from '../../packages/country-packs/src/adapters.js';

test('every list ingestion adapter is an engine adapter a country-pack sanctions fact can name', () => {
  for (const adapter of LIST_ADAPTERS) {
    const engine = findAdapter({ capability: 'sanctions_list', id: adapter.id });
    assert.ok(engine, `${adapter.id} is registered in ENGINE_ADAPTERS`);
    assert.equal(engine.module, '@trustwork/compliance');
    assert.equal(engine.withoutCredentials, 'not_run', 'no download without an activated provider');
    assert.match(adapter.extension, /^[a-z]{2,5}$/);
  }
  const listAdapterIds = ENGINE_ADAPTERS.filter((a) => a.capability === 'sanctions_list' && a.id !== 'us-consolidated-screening-list').map((a) => a.id).sort();
  assert.deepEqual(listAdapterIds, LIST_ADAPTERS.map((a) => a.id).sort(), 'the query adapter (CSL) aside, the registries agree');
  assert.equal(findListAdapter('us-consolidated-screening-list'), null, 'the CSL is a keyed query adapter, not a list export');
  assert.equal(findListAdapter('unknown'), null);
});

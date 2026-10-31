import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTRICTED_PLACES } from '../../packages/compliance/src/index.js';
import { RESTRICTED } from '../../packages/country-packs/src/restricted.js';

/**
 * The authoritative list of restricted places is packages/country-packs/packs/restricted.json. The compliance package
 * keeps its own constant (it has no dependency on country packs); this test keeps the two from drifting apart.
 */
test('the compliance restricted places equal the authoritative country-pack list', () => {
  const authoritative = RESTRICTED.places.map((place) => place.code).sort();
  assert.deepEqual([...RESTRICTED_PLACES].sort(), authoritative);
});

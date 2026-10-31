import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyLocaleCookiePaths, localeCookiePath } from '../../apps/web/app/_lib/locale-names.js';

/** The preview serves the app under `/trustwork`; a cookie on `/trustwork/` never reached the bare home page. */
test('locale cookies live on the base path without a trailing slash', () => {
  assert.equal(localeCookiePath(''), '/');
  assert.equal(localeCookiePath('/trustwork'), '/trustwork');
  assert.equal(localeCookiePath('/trustwork/'), '/trustwork');
});

test('a choice clears the paths earlier builds wrote, so a stale copy cannot shadow it', () => {
  assert.deepEqual(legacyLocaleCookiePaths(''), []);
  assert.deepEqual(legacyLocaleCookiePaths('/trustwork'), ['/', '/trustwork/']);
  assert.ok(!legacyLocaleCookiePaths('/trustwork').includes(localeCookiePath('/trustwork')));
});

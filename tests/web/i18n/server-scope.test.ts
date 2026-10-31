import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getLocaleStore, runWithLocaleScope, setLocaleStore } from '../../../packages/i18n-runtime/src/server.js';

/**
 * The server-component build (`react-server` condition) outside React rendering: route handlers run in
 * their own AsyncLocalStorage scope, and nothing a request writes is visible to another request or to
 * code outside any scope (the old build kept a process-wide copy that the next request could read).
 */
test('route handler scopes keep concurrent requests apart', async () => {
  const handler = (locale: string, ms: number) =>
    runWithLocaleScope(async () => {
      setLocaleStore({ locale, country: 'US', layers: [] });
      await sleep(ms);
      const seen = getLocaleStore().locale;
      await sleep(1);
      return [seen, getLocaleStore().locale];
    });
  const results = await Promise.all([handler('en', 20), handler('ru', 1), handler('ka', 10), handler('hy', 5)]);
  assert.deepEqual(results, [['en', 'en'], ['ru', 'ru'], ['ka', 'ka'], ['hy', 'hy']]);
});

test('outside any request scope reads the engine default and writes are dropped', () => {
  setLocaleStore({ locale: 'ru', country: 'UZ', layers: [] });
  assert.equal(getLocaleStore().locale, 'en');
  assert.deepEqual(getLocaleStore().layers, []);
});

test('a scope starts unprimed: the engine default until the handler primes it', async () => {
  await runWithLocaleScope(async () => {
    assert.equal(getLocaleStore().locale, 'en');
    setLocaleStore({ locale: 'uz-Latn', country: 'UZ', layers: [] });
    await sleep(1);
    assert.equal(getLocaleStore().locale, 'uz-Latn');
  });
  assert.equal(getLocaleStore().locale, 'en');
});

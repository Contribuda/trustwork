import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Maintained languages; Russian is not maintained (owner, 2026-11-01) and falls back to English. */
const tags = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
const dictionary = (tag: string): Record<string, string> => JSON.parse(readFileSync(`apps/web/locales/${tag}/console-navigation.json`, 'utf8')).consoleNav;

test('navigation copy is complete in every maintained locale, with no English words in non-Latin interface copy', () => {
  const reference = dictionary('en');
  for (const tag of tags) {
    const values = dictionary(tag);
    assert.deepEqual(Object.keys(values).sort(), Object.keys(reference).sort(), tag);
    for (const [key, value] of Object.entries(values)) {
      assert.ok(value.trim(), `${tag}.${key}`);
      assert.deepEqual(value.match(/\{[^}]+\}/g) ?? [], reference[key]!.match(/\{[^}]+\}/g) ?? [], `${tag}.${key}`);
      if (['ru', 'ka', 'hy'].includes(tag)) assert.doesNotMatch(value, /[A-Za-z]{3,}/, `${tag}.${key}`);
    }
  }
});

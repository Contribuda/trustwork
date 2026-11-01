import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tags = ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
const dictionary = (tag: string): Record<string, string> => JSON.parse(readFileSync(`apps/web/locales/${tag}/console-navigation.json`, 'utf8')).consoleNav;

test('navigation copy is complete in seven locales, with no English words in non-Latin interface copy', () => {
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

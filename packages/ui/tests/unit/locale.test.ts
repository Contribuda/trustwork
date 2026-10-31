import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import { formatDate, formatMessage, locale, t, uiDictionary, uiLocales } from '../../src/i18n/index';

function strings(node: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof node === 'string') return [[path.join('.'), node]];
  if (Array.isArray(node)) return node.flatMap((value, index) => strings(value, [...path, String(index)]));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => strings(value, [...path, key]));
  return [];
}

const en = strings(locale);
const enKeys = new Set(en.map(([key]) => key));

test('navigation invariants from the specification are intact in the reference dictionary', () => {
  assert.deepEqual(locale.publicNav, ['Home', 'News', 'Articles', 'Events', 'Companies', 'People', 'Projects', 'Magazine']);
  assert.deepEqual(locale.workspaceNav, ['Overview', 'My page', 'Company', 'Projects', 'Procurement', 'Sales', 'Publications', 'Assistant']);
  assert.equal(locale.publicExit, 'To the industry');
  assert.deepEqual(locale.onboarding, ['I buy', 'I supply', 'I take part in the industry']);
});

test('every dictionary carries exactly the reference keys, no empty strings and no placeholders', () => {
  for (const tag of uiLocales()) {
    const all = strings(uiDictionary(tag));
    const keys = new Set(all.map(([key]) => key));
    assert.deepEqual([...keys].sort(), [...enKeys].sort(), `${tag}: key set differs from en`);
    for (const [key, value] of all) {
      assert.ok(value.trim().length > 0, `${tag}: ${key} is empty`);
      assert.ok(!/TODO|TBD|lorem/i.test(value), `${tag}: ${key} contains a placeholder`);
    }
  }
});

test('Russian copy is Cyrillic (Latin only for product names and keys)', () => {
  const allowed = /Google|Apple|Trustwork|Enter|Shift\+Enter|%|№/g;
  for (const [key, value] of strings(uiDictionary('ru'))) {
    if (key.startsWith('brand.')) continue; // the engine's own name is Latin; deployments overlay their brand
    const stripped = value
      .replace(allowed, '')
      .replace(/\{[a-zA-Z0-9_]+(, plural,)?/g, '')
      .replace(/\b(one|few|many|other)\s*\{/g, '');
    assert.ok(!/[A-Za-z]{2,}/.test(stripped), `${key} contains Latin text: ${value}`);
  }
});

test('plural groups carry the forms their language needs', () => {
  for (const [key, value] of strings(uiDictionary('ru'))) {
    if (!value.includes('plural')) continue;
    for (const form of ['one', 'few', 'many']) assert.ok(value.includes(`${form} {`), `ru ${key} is missing the ${form} form`);
  }
  for (const [key, value] of en) {
    if (!value.includes('plural')) continue;
    for (const form of ['one', 'other']) assert.ok(value.includes(`${form} {`), `en ${key} is missing the ${form} form`);
  }
});

test('no Russian-provider names remain in any dictionary', () => {
  for (const tag of uiLocales()) for (const [key, value] of strings(uiDictionary(tag))) assert.ok(!/Яндекс|Yandex|VK\b|Сбер|Sber/i.test(value), `${tag}: ${key}`);
});

test('the active locale selects messages, plural rules and date formats; English is the fallback', () => {
  setLocaleStore({ locale: 'ru', country: 'UZ', layers: [] });
  assert.equal(t('common.save'), 'Сохранить');
  assert.equal(formatMessage('{count, plural, one {# минуту} few {# минуты} many {# минут}}', { count: 3 }), '3 минуты');
  assert.equal(formatDate('2026-10-27'), '27 октября 2026');
  setLocaleStore({ locale: 'en', country: 'UZ', layers: [] });
  assert.equal(t('common.save'), 'Save');
  assert.equal(formatMessage('{count, plural, one {# minute} other {# minutes}}', { count: 3 }), '3 minutes');
  assert.equal(formatDate('2026-10-27'), '27 October 2026');
  setLocaleStore({ locale: 'uz-Latn', country: 'UZ', layers: [] });
  assert.equal(t('common.save'), 'Saqlash', 'registered pack dictionaries are used');
  assert.match(formatDate('2026-10-27'), /2026/);
  setLocaleStore({ locale: 'xx', country: 'UZ', layers: [] });
  assert.equal(t('common.save'), 'Save', 'unknown dictionary falls back to English');
  setLocaleStore({ locale: 'en', country: 'UZ', layers: [] });
});

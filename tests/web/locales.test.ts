import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { enabledPacks, getPack } from '@trustwork/country-packs';

/** Every locale dictionary against the English reference (ADR-009): complete packs must be fully translated. */
const appRoot = resolve('apps/web/app/_lib/locales');
const uiRoot = resolve('packages/ui/locales');

function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((value, index) => leaves(value, `${path}.${index}`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
  return [];
}

function dictionary(root: string, tag: string): Record<string, string> | null {
  try {
    return Object.fromEntries(leaves(JSON.parse(readFileSync(resolve(root, `${tag}.json`), 'utf8'))).filter(([key]) => key !== '$comment'));
  } catch {
    return null;
  }
}

for (const root of [appRoot, uiRoot]) {
  const en = dictionary(root, 'en')!;
  const files = readdirSync(root).filter((f) => f.endsWith('.json'));
  test(`${root}: every dictionary defines only reference keys, no empty strings, no placeholders`, () => {
    for (const file of files) {
      const dict = dictionary(root, file.replace('.json', ''))!;
      for (const [key, value] of Object.entries(dict)) {
        assert.ok(key in en, `${file}: ${key} is not a reference key`);
        assert.ok(value.trim().length > 0, `${file}: ${key} is empty`);
        assert.ok(!/TODO|TBD|lorem|XXX/i.test(value), `${file}: ${key} has a placeholder`);
      }
    }
  });
  test(`${root}: the Russian dictionary is complete`, () => {
    const ru = dictionary(root, 'ru')!;
    assert.deepEqual(
      Object.keys(en).filter((k) => !(k in ru)),
      [],
    );
  });
  test(`${root}: complete country packs are fully translated; partial packs may fall back to English`, () => {
    for (const pack of enabledPacks()) {
      const dict = dictionary(root, pack.defaultLocale);
      if (!dict) continue; // the dictionary lands with the pack's own task (INTL-UZ, INTL-GE, …)
      const missing = Object.keys(en).filter((k) => !(k in dict));
      if (pack.status === 'complete') assert.deepEqual(missing, [], `${pack.code}: ${pack.defaultLocale} is missing ${missing.length} keys`);
    }
  });
  test(`${root}: no Russian-provider names anywhere`, () => {
    for (const file of files) for (const [key, value] of Object.entries(dictionary(root, file.replace('.json', ''))!)) assert.ok(!/Яндекс|Yandex|ВКонтакте|Сбер|Sber|GigaChat/i.test(value), `${file}: ${key}`);
  });
}

test('restricted places never have a dictionary of their own', () => {
  assert.equal(getPack('RU'), null);
});

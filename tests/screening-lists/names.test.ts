import test from 'node:test';
import assert from 'node:assert/strict';
import { NameKeySchema } from '../../packages/contracts/src/sanctions.js';
import { CYRILLIC_ICAO_9303, NAME_KEY_VERSION, nameKey, nameKeys, nameTokens, TRANSLITERATION_TABLES } from '../../packages/compliance/src/names/index.js';

// Synthetic names only (ADR 014: never real listed people in fixtures).
test('the same name in Latin with marks, in another order, in upper case or in Cyrillic gives one key', () => {
  const key = nameKey('Anna Demonova Testova');
  assert.equal(key, 'anna demonova testova');
  for (const spelling of ['Ánna Demonóva Testová', 'TESTOVA, Anna Demonova', 'testova anna  demonova', 'Тестова Анна Демонова', 'ТЕСТОВА Анна Демонова', 'Demonova-Testova Anna', 'Anna Demonova Testova Anna']) {
    assert.equal(nameKey(spelling), key, spelling);
  }
  assert.ok(NameKeySchema.safeParse(key).success);
});

test('ICAO Doc 9303 Cyrillic: multi-letter values, dropped soft sign, short i and decomposed input', () => {
  assert.equal(nameKey('Юлия Щукина'), 'iuliia shchukina');
  assert.equal(nameKey('Жанна Хохлова'), 'khokhlova zhanna');
  assert.equal(nameKey('Игорь Цой'), 'igor tsoi');
  assert.equal(nameKey('Ёлкина Эмма'), 'elkina emma');
  assert.equal(nameKey('Объектов'), 'obieektov');
  assert.equal(nameKey('Й'.normalize('NFD') + 'одов'), 'iodov', 'a decomposed short i is composed first');
  assert.equal(nameKey("Мар'яна Ґалій"), 'galii mariana', 'apostrophes join, Ukrainian letters follow the table');
  assert.equal(CYRILLIC_ICAO_9303.map['щ'], 'shch');
  assert.equal(CYRILLIC_ICAO_9303.source.title.includes('9303'), true);
});

test('punctuation separates tokens except apostrophes; letters without a decomposition fold by the CLDR table', () => {
  assert.equal(nameKey('O’Brien-Smith Jr.'), 'jr obrien smith');
  assert.equal(nameKey("D'Arcy"), nameKey('D´Arcy'));
  assert.equal(nameKey('Straße Øster Łukasz'), 'lukasz oster strasse');
  assert.equal(nameKey('Example (Synthetic) Trading, L.L.C.'), 'c example l synthetic trading');
  assert.equal(nameKey('Synthetic Voyager 7'), '7 synthetic voyager', 'digits are tokens');
  assert.equal(nameKey('\u03D2'), 'υ', 'a capital produced by decomposition is lower-cased');
  assert.equal(nameKey('— . , ;'), '', 'no letters, no key');
  assert.deepEqual(nameTokens('b a b'), ['a', 'b']);
});

test('Georgian by the national system; scripts without a table stay as they are', () => {
  assert.equal(nameKey('ანა დემონოვა'), 'ana demonova');
  assert.equal(nameKey('ᲐᲜᲐ დემონოვა'), 'ana demonova', 'Mtavruli capitals fold to Mkhedruli');
  assert.equal(nameKey('مثال اختبار'), nameKey('اختبار مثال'), 'Arabic letters still meet in the same script');
});

test('nameKeys: distinct, sorted, empty names dropped; tables never overlap', () => {
  assert.deepEqual(nameKeys(['Anna Testova', 'Тестова Анна', '...', 'Zed Example']), ['anna testova', 'example zed']);
  const seen = new Set<string>();
  for (const table of TRANSLITERATION_TABLES) {
    for (const key of Object.keys(table.map)) {
      assert.ok(!seen.has(key), `${key} mapped twice`);
      seen.add(key);
    }
    assert.match(table.source.url, /^https:\/\//);
    assert.match(table.source.accessed, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(NAME_KEY_VERSION, 'name-key-1');
});

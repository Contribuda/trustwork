import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const languages = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const reference = read("../../../locales/en.json").adminShell;
for (const language of languages) {
  test(`DS-005 ${language}: complete messages, interpolation and inherited navigation`, () => {
    const copy = read(`../../../locales/${language}.json`).adminShell;
    const source = read(
      `../../../../../docs/design/prototypes/source/locales/${language}/console.json`,
    );
    assert.deepEqual(Object.keys(copy), Object.keys(reference));
    for (const [key, value] of Object.entries(copy)) {
      if (typeof value !== "string") continue;
      assert.ok(value.trim());
      assert.deepEqual(
        value.match(/\{\w+\}/g),
        reference[key].match(/\{\w+\}/g),
      );
    }
    assert.equal(copy.overview, source.s_overview);
    assert.equal(copy.editorial, source.area_editorial);
    assert.equal(copy.outreach, source.s_outreach);
    assert.equal(copy.network, source.n_network);
    assert.deepEqual(Object.keys(copy.languages), languages);
  });
}

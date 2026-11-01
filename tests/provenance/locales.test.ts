import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVENANCE_ROLES } from "../../packages/contracts/src/provenance.js";
test("all seven locales carry disclosure, exact consent notice and functional role labels", () => {
  const languages = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
  const read = (language: string) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../apps/web/locales/${language}/provenance.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ).publicationProvenance as Record<string, unknown> & { roles: Record<string, string> };
  const reference = read("en");
  for (const language of languages) {
    const dictionary = read(language);
    assert.deepEqual(
      Object.keys(dictionary).sort(),
      Object.keys(reference).sort(),
    );
    assert.deepEqual(
      Object.keys(dictionary.roles).sort(),
      [...PROVENANCE_ROLES].sort(),
    );
    for (const value of [
      ...Object.values(dictionary).filter((v) => typeof v === "string"),
      ...Object.values(dictionary.roles),
    ])
      assert.ok(typeof value === "string" && value.trim().length > 0);
  }
});

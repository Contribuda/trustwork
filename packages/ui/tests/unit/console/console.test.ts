import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gridDestination } from "../../../src/components/DataTable/grid";
import {
  rowSelected,
  toggleRows,
  type TableSelection,
} from "../../../src/components/DataTable/selection";
import { selectableTerritories } from "../../../src/components/NetworkMap/places";

test("APG arrows, Home/End, control bounds and page navigation never wrap", () => {
  const p = { row: 3, column: 2 };
  assert.deepEqual(gridDestination(p, "ArrowDown", false, 12, 4), {
    row: 4,
    column: 2,
  });
  assert.deepEqual(gridDestination(p, "ArrowUp", false, 12, 4), {
    row: 2,
    column: 2,
  });
  assert.deepEqual(gridDestination(p, "ArrowRight", false, 12, 4), {
    row: 3,
    column: 3,
  });
  assert.deepEqual(gridDestination(p, "ArrowLeft", false, 12, 4), {
    row: 3,
    column: 1,
  });
  assert.deepEqual(gridDestination(p, "Home", false, 12, 4), {
    row: 3,
    column: 0,
  });
  assert.deepEqual(gridDestination(p, "End", false, 12, 4), {
    row: 3,
    column: 3,
  });
  assert.deepEqual(gridDestination(p, "Home", true, 12, 4), {
    row: 0,
    column: 0,
  });
  assert.deepEqual(gridDestination(p, "End", true, 12, 4), {
    row: 11,
    column: 3,
  });
  assert.deepEqual(gridDestination(p, "PageDown", false, 12, 4), {
    row: 8,
    column: 2,
  });
  assert.deepEqual(gridDestination(p, "PageUp", false, 12, 4), {
    row: 0,
    column: 2,
  });
  assert.deepEqual(
    gridDestination({ row: 0, column: 0 }, "ArrowLeft", false, 12, 4),
    { row: 0, column: 0 },
  );
});
test("page selection preserves explicit selections on other pages without mutating input", () => {
  const initial: TableSelection = { kind: "keys", keys: new Set(["earlier"]) };
  const next = toggleRows(initial, ["one", "two"], true);
  assert.equal(rowSelected(next, "earlier"), true);
  assert.equal(rowSelected(next, "two"), true);
  assert.equal(rowSelected(initial, "two"), false);
  assert.equal(
    rowSelected(toggleRows(next, ["one", "two"], false), "earlier"),
    true,
  );
});
test("all-matching selection is explicit, excludes rows and cannot leak into a changed query", () => {
  const initial: TableSelection = {
    kind: "matching",
    snapshot: "query-v1",
    excluded: new Set(),
  };
  const next = toggleRows(initial, ["one"], false, "query-v1");
  assert.equal(rowSelected(next, "one", "query-v1"), false);
  assert.equal(rowSelected(initial, "one", "query-v1"), true);
  assert.equal(rowSelected(next, "two", "query-v2"), false);
  assert.deepEqual(toggleRows(next, ["two"], true, "query-v2"), {
    kind: "keys",
    keys: new Set(["two"]),
  });
});
test("network display denies every canonical restricted code, descendants, mixed and empty territories", () => {
  const list = JSON.parse(
    readFileSync(
      new URL(
        "../../../../country-packs/packs/restricted.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { places: { code: string }[] };
  for (const p of list.places) {
    assert.equal(selectableTerritories([p.code]), false, p.code);
    assert.equal(selectableTerritories([p.code.toLowerCase()]), false, p.code);
    assert.equal(selectableTerritories(["US-CA", p.code]), false, p.code);
  }
  assert.equal(selectableTerritories(["RU-MOW"]), false);
  assert.equal(selectableTerritories([]), false);
  assert.equal(selectableTerritories(["unknown"]), false);
  assert.equal(selectableTerritories(["US-CA", "GE"]), true);
});
test("console translations have the same nonempty keys in all seven dictionaries", () => {
  const languages = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
  const dicts = languages.map(
    (lang) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../locales/${lang}.json`, import.meta.url),
          "utf8",
        ),
      ).consoleKit as Record<string, unknown>,
  );
  for (const dict of dicts) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(dicts[0]!).sort());
    for (const value of Object.values(dict))
      assert.ok(
        typeof value === "object" ||
          (typeof value === "string" && value.trim().length > 0),
      );
  }
});

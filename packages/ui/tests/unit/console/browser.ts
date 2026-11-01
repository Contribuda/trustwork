import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const languages = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
const widths = [375, 768, 1280];
const stories = [
  "records",
  "editable-grid",
  "grid-interactions",
  "access",
  "decisions",
  "activity",
  "navigation",
  "loading",
  "empty",
  "error",
];
function messages(lang: string) {
  return JSON.parse(readFileSync(resolve(`locales/${lang}.json`), "utf8"));
}
async function open(page: Page, story: string) {
  await page.goto(`/iframe.html?id=console-kit--${story}&viewMode=story`);
  await expect(page.getByRole("main")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function axe(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
for (const language of languages)
  for (const width of widths) {
    test(`DS-003 rendered stories, locale and axe ${language} ${width}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        locale: language,
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      const external: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
          external.push(url.origin);
          return route.abort();
        }
        return route.continue();
      });
      const k = messages(language).consoleKit;
      try {
        for (const story of stories) {
          await open(page, story);
          await expect(page.getByRole("note")).toHaveText(k.synthetic);
          await expect(page.locator("html")).toHaveAttribute("lang", language);
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
            `${story}: no page overflow in ${language} at ${width}`,
          ).toBe(true);
          await axe(page);
          // Exercise the actual localized controls in every language and viewport, not just static axe output.
          if (story === "records") {
            const facet = page
              .getByRole("group", { name: k.status })
              .getByRole("checkbox")
              .first();
            await facet.focus();
            await page.keyboard.press("Space");
            await expect(facet).not.toBeChecked();
            const selectPage = page.getByRole("checkbox", {
              name: k.selectPage,
            });
            await selectPage.focus();
            await page.keyboard.press("Space");
            await expect(selectPage).toBeChecked();
            await page.keyboard.press("Escape");
            await expect(selectPage).not.toBeChecked();
          }
          if (story === "editable-grid") {
            await page
              .locator('[data-grid-row="1"][data-grid-column="0"]')
              .focus();
            await page.keyboard.press("F2");
            await expect(page.getByRole("textbox")).toBeFocused();
            await page.keyboard.press("Escape");
          }
          if (story === "grid-interactions") {
            const cell = page.locator(
              '[data-grid-row="1"][data-grid-column="3"]',
            );
            await cell.focus();
            await page.keyboard.press("F2");
            await expect(
              cell.getByRole("button", { name: k.openPage, exact: true }),
            ).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(
              cell.getByRole("button", { name: k.share, exact: true }),
            ).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(page.locator("[data-request]")).toHaveText("share:1");
            await page.keyboard.press("Shift+Tab");
            await expect(
              cell.getByRole("button", { name: k.openPage, exact: true }),
            ).toBeFocused();
            await page.keyboard.press("Escape");
            await expect(cell).toBeFocused();
            await expect(
              page.getByRole("grid").locator('[tabindex="0"]'),
            ).toHaveCount(1);
            const edit = page.locator(
              '[data-grid-row="1"][data-grid-column="1"]',
            );
            await edit.focus();
            await page.keyboard.press("Enter");
            await page
              .getByRole("textbox", { name: k.name, exact: true })
              .fill("123");
            await page.keyboard.press("Tab");
            await expect(
              page
                .getByRole("status")
                .filter({
                  hasText: k.changeRequested.replace("{value}", "123"),
                }),
            ).toBeVisible();
            await expect(
              page.locator('[data-grid-row="1"][data-grid-column="2"]'),
            ).toBeFocused();
          }
          if (story === "access") {
            if (width >= 768) {
              await page
                .getByRole("grid")
                .locator('[data-grid-row="0"][data-grid-column="0"]')
                .focus();
              await page.keyboard.press("ArrowDown");
              await page.keyboard.press("ArrowRight");
              await page.keyboard.press("Enter");
            } else {
              await page.getByRole("list").getByRole("button").first().focus();
              await page.keyboard.press("Enter");
            }
          }
          if (story === "decisions") {
            const diff = page
              .getByRole("region")
              .filter({ has: page.getByRole("table") });
            const table = diff.getByRole("table");
            await expect(table.getByRole("columnheader")).toHaveText([
              k.field,
              k.before,
              k.after,
            ]);
            await expect(table.getByRole("row")).toHaveCount(4);
            if (width === 375) {
              await diff.focus();
              for (let key = 0; key < 20; key++)
                await page.keyboard.press("ArrowRight");
              await expect
                .poll(() =>
                  diff.evaluate((node) =>
                    Math.abs(
                      node.scrollWidth - node.clientWidth - node.scrollLeft,
                    ),
                  ),
                )
                .toBeLessThan(2);
              const after = await table
                .getByRole("columnheader", { name: k.after, exact: true })
                .boundingBox();
              const region = await diff.boundingBox();
              expect(after!.x).toBeGreaterThanOrEqual(region!.x);
              expect(after!.x + after!.width).toBeLessThanOrEqual(
                region!.x + region!.width + 1,
              );
              await expect(diff).toBeFocused();
              if (language === "ru") {
                mkdirSync("dist/console-evidence", { recursive: true });
                await diff.screenshot({
                  path: "dist/console-evidence/decisions-after-ru-375.png",
                });
              }
              for (let key = 0; key < 20; key++)
                await page.keyboard.press("ArrowLeft");
              await expect
                .poll(() => diff.evaluate((node) => node.scrollLeft))
                .toBe(0);
            }
            const show = page.getByRole("checkbox", { name: k.showUnchanged });
            await show.focus();
            await page.keyboard.press("Space");
            await expect(page.getByRole("table").getByRole("row")).toHaveCount(
              5,
            );
            await page
              .getByRole("textbox", { name: k.reason })
              .first()
              .fill(k.synthetic);
            await expect(
              page.getByRole("button", { name: k.decline, exact: true }),
            ).toBeEnabled();
            await expect(
              page.getByRole("button", { name: k.approve, exact: true }),
            ).toBeDisabled();
            await page.getByRole("textbox", { name: k.code }).fill("123456");
            await page
              .getByRole("button", {
                name: k.typeToConfirm.replace(
                  "{value}",
                  k.item.replace("{count}", "1"),
                ),
              })
              .click();
            await axe(page);
            await page.keyboard.press("Escape");
          }
          if (story === "activity") {
            await expect(page.getByRole("table").getByRole("row")).toHaveCount(
              3,
            );
            const map = page.getByRole("region", { name: k.hub, exact: true });
            const markers = map
              .locator("button")
              .filter({ hasText: k.item.split("{count}")[0] });
            await markers.first().focus();
            await page.keyboard.press("ArrowRight");
            await expect(markers.nth(1)).toBeFocused();
            await expect(map.getByRole("listitem")).toHaveCount(2);
            await page.getByRole("link").first().focus();
            await expect(page.getByRole("link").first()).toBeFocused();
          }
          if (story === "navigation") {
            const trigger = page.getByRole("button", {
              name: k.commands,
              exact: true,
            });
            await trigger.focus();
            await page.keyboard.press("Enter");
            await page.keyboard.press("ArrowDown");
            await expect(
              page.getByRole("combobox", { name: k.commands, exact: true }),
            ).toHaveAttribute("aria-activedescendant", /-1$/);
            await axe(page);
            await page.keyboard.press("Escape");
            await expect(trigger).toBeFocused();
            const disclosure = page.getByRole("button", {
              name: k.rule,
              exact: true,
            });
            await disclosure.focus();
            await page.keyboard.press("Enter");
            await expect(disclosure).toHaveAttribute("aria-expanded", "true");
            await page
              .getByRole("button", { name: k.shortcuts, exact: true })
              .click();
            const preference = page.getByRole("checkbox", {
              name: k.singleKeys,
            });
            await preference.focus();
            await page.keyboard.press("Space");
            await expect(preference).toBeChecked();
            await axe(page);
            await page.keyboard.press("Escape");
          }
          await expect(
            page.getByText("RESTRICTED_FIXTURE_MUST_NOT_RENDER"),
          ).toHaveCount(0);
          if (
            language === "ru" &&
            [375, 1280].includes(width) &&
            ["records", "access", "decisions", "activity"].includes(story)
          ) {
            mkdirSync("dist/console-evidence", { recursive: true });
            await page.screenshot({
              path: `dist/console-evidence/${story}-${language}-${width}.png`,
              fullPage: true,
            });
          }
        }
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
for (const width of widths) {
  test(`DS-003 grid editing and matrix keyboard ${width}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    try {
      await open(page, "editable-grid");
      const grid = page.getByRole("grid");
      const first = grid.locator('[data-grid-row="0"][data-grid-column="0"]');
      await first.focus();
      await page.keyboard.press("ArrowDown");
      const cell = grid.locator('[data-grid-row="1"][data-grid-column="0"]');
      await expect(cell).toBeFocused();
      await page.keyboard.press("F2");
      const input = page.getByRole("textbox", { name: "Name" });
      await expect(input).toBeFocused();
      await input.fill("Cancelled edit");
      await page.keyboard.press("Escape");
      await expect(cell).toBeFocused();
      await expect(cell).not.toContainText("Cancelled edit");
      await page.keyboard.press("Enter");
      await input.fill("Committed edit");
      await page.keyboard.press("Enter");
      await expect(cell).toHaveText("Committed edit");
      await expect(cell).toBeFocused();
      await page.keyboard.press("Control+End");
      await expect(
        grid.locator('[data-grid-row="2"][data-grid-column="1"]'),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await expect(
        grid.locator('[data-grid-row="2"][data-grid-column="0"]'),
      ).toBeFocused();
      await page.keyboard.press("PageUp");
      await expect(first).toBeFocused();
      await open(page, "access");
      if (width < 768) {
        await page
          .getByRole("button", { name: /Synthetic record 1: Allowed/ })
          .first()
          .focus();
        await page.keyboard.press("Enter");
      } else {
        const matrix = page.getByRole("grid");
        await matrix
          .locator('[data-grid-row="0"][data-grid-column="0"]')
          .focus();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowRight");
        await expect(
          matrix.locator('[data-grid-row="1"][data-grid-column="1"]'),
        ).toBeFocused();
        await page.keyboard.press("Enter");
      }
      await expect(
        page.getByRole("status").filter({ hasText: /Permission supplied/ }),
      ).toBeVisible();
      await axe(page);
    } finally {
      await context.close();
    }
  });
  test(`DS-003 server controls, selection and drawer return ${width}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    try {
      await open(page, "records");
      await page.getByRole("searchbox").fill("does not match synthetic rows");
      await expect(
        page.getByRole("button", { name: "Synthetic record 1", exact: true }),
      ).toBeVisible();
      if (width >= 768) {
        await expect(page.getByRole("table")).toHaveCount(1);
        await expect(page.getByRole("grid")).toHaveCount(0);
        await page.getByRole("columnheader", { name: /Name/ }).click();
        await expect(
          page.getByRole("columnheader", { name: /Name/ }),
        ).toHaveAttribute("aria-sort", "ascending");
      }
      await page
        .getByRole("checkbox", { name: "Select this page" })
        .press("Space");
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Selected: 3 of 120" })
          .first(),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("checkbox", { name: "Select this page" }),
      ).not.toBeChecked();
      await page
        .getByRole("button", { name: "Select all 120 matching records" })
        .click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Selected: 120 of 120" })
          .first(),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      const trigger = page.getByRole("button", {
        name: "Synthetic record 1",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("complementary");
      await expect(drawer).toBeFocused();
      await expect(page.locator("#storybook-root")).not.toHaveAttribute(
        "inert",
        "",
      );
      await axe(page);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await page
        .getByRole("textbox", { name: "View name" })
        .fill("Synthetic saved view");
      await page
        .getByRole("button", { name: "Save view", exact: true })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "Synthetic saved view" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await expect(
        page.getByRole("navigation").locator('[aria-current="page"]'),
      ).toContainText("2");
      await expect(trigger).toBeVisible(); // The fixed server fixture never fabricates a fetched page.
      await page.locator("summary").click();
      const columns = page.locator("details");
      await columns
        .getByRole("checkbox", { name: "Status", exact: true })
        .press("Space");
      if (width >= 768)
        await expect(
          page.getByRole("columnheader", { name: /Status/ }),
        ).toHaveCount(0);
      else
        await expect(
          page.getByRole("term").filter({ hasText: "Status" }),
        ).toHaveCount(0);
      await columns
        .getByRole("checkbox", { name: "Status", exact: true })
        .press("Space");
      await columns
        .getByRole("button", { name: "Move Name down", exact: true })
        .click();
      if (width >= 768)
        await expect(page.getByRole("columnheader").nth(1)).toContainText(
          "Status",
        );
      else await expect(page.getByRole("term").first()).toHaveText("Status");
      await page.locator("summary").click();
    } finally {
      await context.close();
    }
  });
  test(`DS-003 confirmation paste, step-up and disabled actions ${width}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    try {
      await open(page, "decisions");
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Decline", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("textbox", { name: "Reason" })
        .first()
        .fill("Synthetic reason");
      await expect(
        page.getByText("484 characters left", { exact: true }),
      ).toHaveCount(2);
      await expect(
        page.getByRole("button", { name: "Decline", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Request release", exact: true }),
      ).toBeDisabled();
      const trigger = page.getByRole("button", {
        name: "Type Synthetic record 1 to confirm",
      });
      await trigger.click();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      const input = page.getByRole("textbox", {
        name: "Type Synthetic record 1 to confirm",
      });
      await page.evaluate(() =>
        navigator.clipboard.writeText("Synthetic record 1"),
      );
      await input.focus();
      await page.keyboard.press("ControlOrMeta+V");
      await expect(input).toHaveValue("Synthetic record 1");
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Removed", exact: true }),
      ).toBeEnabled();
      await axe(page);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      const code = page.getByRole("textbox", { name: "Authenticator code" });
      await expect(code).toHaveAttribute("autocomplete", "one-time-code");
      await page.evaluate(() => navigator.clipboard.writeText("123456"));
      await code.focus();
      await page.keyboard.press("ControlOrMeta+V");
      await expect(code).toHaveValue("123456");
      await page.getByRole("button", { name: "Password", exact: true }).click();
      await expect(page.locator('input[name="password"]')).toHaveAttribute(
        "autocomplete",
        "current-password",
      );
      await expect(page.locator('input[name="password"]')).toHaveValue(
        "123456",
      );
    } finally {
      await context.close();
    }
  });
  test(`DS-003 palette, disclosure, shortcut preference and map keyboard ${width}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    try {
      await open(page, "navigation");
      const trigger = page.getByRole("button", {
        name: "Sections and commands",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Control+k");
      const combo = page.getByRole("combobox", {
        name: "Sections and commands",
        exact: true,
      });
      await expect(combo).toBeFocused();
      await page.keyboard.press("End");
      await expect(combo).toHaveAttribute("aria-activedescendant", /-2$/);
      await axe(page);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await page.getByRole("button", { name: "Read the rule" }).click();
      await expect(
        page.getByRole("button", { name: "Read the rule" }),
      ).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
      await page
        .getByRole("checkbox", { name: "Enable single-key shortcuts" })
        .press("Space");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
      await expect(
        page.getByRole("checkbox", { name: "Enable single-key shortcuts" }),
      ).toBeChecked();
      await page.keyboard.press("Escape");
      await open(page, "activity");
      const map = page.getByRole("region", { name: "Hub", exact: true });
      const marker = map
        .getByRole("button", { name: "Synthetic record 1", exact: true })
        .first();
      await marker.focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        map
          .getByRole("button", { name: "Synthetic record 2", exact: true })
          .first(),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("status").filter({ hasText: "ge" }),
      ).toBeVisible();
      await expect(map.getByRole("list").getByRole("listitem")).toHaveCount(2);
    } finally {
      await context.close();
    }
  });
}

for (const width of widths) {
  test(`DS-003 multiple cell controls, disabled skipping and outer Tab ${width}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    try {
      await open(page, "grid-interactions");
      const grid = page.getByRole("grid");
      const cell = grid.locator('[data-grid-row="1"][data-grid-column="3"]');
      const first = cell.getByRole("button", { name: "Open as page" });
      const second = cell.getByRole("button", { name: "Share with team" });
      const link = cell.getByRole("link");
      await cell.focus();
      await page.keyboard.press("Enter");
      await expect(first).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-request]")).toHaveText("open:1");
      await page.keyboard.press("Tab");
      await expect(second).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-request]")).toHaveText("share:1");
      await page.keyboard.press("Tab");
      await expect(link).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(second).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(cell).toBeFocused();
      await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
      await page.keyboard.press("F2");
      await page.keyboard.press("Shift+Tab");
      await expect(
        grid.locator('[data-grid-row="1"][data-grid-column="2"]'),
      ).toBeFocused();
      await cell.focus();
      await page.keyboard.press("F2");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const selection = grid.locator(
        '[data-grid-row="2"][data-grid-column="0"]',
      );
      await expect(selection).toBeFocused();
      await page.keyboard.press("F2");
      await expect(selection.getByRole("checkbox")).toBeFocused();
      await page.keyboard.press("Space");
      await expect(selection.getByRole("checkbox")).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(selection).toBeFocused();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("F2");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      // Selection's ordinary toolbar follows this table, so Tab must leave it.
      await expect(grid.locator(":focus")).toHaveCount(0);
      await page.keyboard.press("Shift+Tab");
      await expect(
        grid.locator('[data-grid-row="2"][data-grid-column="3"]'),
      ).toBeFocused();
      await axe(page);
    } finally {
      await context.close();
    }
  });

  test(`DS-003 edit Tab uses every rendered column and both boundaries ${width}`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    try {
      for (const selection of [false, true])
        for (const actions of [false, true])
          for (const data of [1, 2]) {
            await open(page, "grid-interactions");
            if (!selection)
              await page
                .getByRole("checkbox", {
                  name: "Select this page",
                  exact: true,
                })
                .first()
                .press("Space");
            if (!actions)
              await page
                .getByRole("checkbox", { name: "Row actions", exact: true })
                .press("Space");
            if (data === 1) {
              await page.locator("summary").click();
              await page
                .locator("details")
                .getByRole("checkbox", { name: "Name", exact: true })
                .press("Space");
              await page.locator("summary").click();
            }
            const grid = page.getByRole("grid");
            const offset = selection ? 1 : 0;
            const count = data + offset + (actions ? 1 : 0);
            const cell = (row: number, column: number) =>
              grid.locator(
                `[data-grid-row="${row}"][data-grid-column="${column}"]`,
              );
            // First visible data cell: backwards reaches selection or the preceding header.
            await cell(1, offset).focus();
            await page.keyboard.press("F2");
            await grid.getByRole("textbox").fill("First draft");
            await page.keyboard.press("Shift+Tab");
            await expect(cell(1, offset)).toHaveText("First draft");
            await expect(
              cell(selection ? 1 : 0, selection ? 0 : count - 1),
            ).toBeFocused();
            await expect(page.locator("[data-request]")).toHaveText(
              `1:${data === 1 ? "value" : "name"}:First draft`,
            );
            // Last visible data cell: forwards includes actions, wraps rows, or exits.
            await cell(2, offset + data - 1).focus();
            await page.keyboard.press("Enter");
            await grid.getByRole("textbox").fill("Last draft");
            await page.keyboard.press("Tab");
            await expect(cell(2, offset + data - 1)).toHaveText("Last draft");
            await expect(page.locator("[data-request]")).toHaveText(
              "2:value:Last draft",
            );
            if (actions) await expect(cell(2, count - 1)).toBeFocused();
            else await expect(grid.locator(":focus")).toHaveCount(0);
            // Forward from first data cell uses the actual displayed column order.
            await cell(1, offset).focus();
            await page.keyboard.press("Enter");
            await grid.getByRole("textbox").fill("Next draft");
            await page.keyboard.press("Tab");
            await expect(
              cell(
                offset + 1 < count ? 1 : 2,
                offset + 1 < count ? offset + 1 : 0,
              ),
            ).toBeFocused();
            await expect(cell(1, offset)).toHaveText("Next draft");
            // Navigation Tab, including reverse at the first header, leaves the grid.
            await cell(0, 0).focus();
            await page.keyboard.press("Shift+Tab");
            await expect(grid.locator(":focus")).toHaveCount(0);
            await page.keyboard.press("Tab");
            await expect(cell(0, 0)).toBeFocused();
          }
    } finally {
      await context.close();
    }
  });

  test(`DS-003 controlled requests never claim persistence ${width}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en",
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      for (const behavior of ["delay", "reject", "none", "throw"]) {
        await open(page, "grid-interactions");
        await page.getByLabel("Status", { exact: true }).selectOption(behavior);
        const grid = page.getByRole("grid");
        const cell = grid.locator('[data-grid-row="1"][data-grid-column="1"]');
        await cell.focus();
        await page.keyboard.press("F2");
        await grid.getByRole("textbox").fill(`Draft ${behavior}`);
        await page.keyboard.press("Tab");
        await expect(page.locator("[data-request]")).toHaveText(
          `1:name:Draft ${behavior}`,
        );
        const status = page
          .getByRole("status")
          .filter({
            hasText:
              behavior === "reject" || behavior === "throw"
                ? `Change request failed: Draft ${behavior}`
                : `Change requested: Draft ${behavior}`,
          });
        await expect(status).toBeVisible();
        await expect(
          page.getByRole("status").filter({ hasText: /\bSaved\b/ }),
        ).toHaveCount(0);
        if (behavior === "throw") {
          await expect(grid.getByRole("textbox")).toBeFocused();
          await expect(grid.getByRole("textbox")).toHaveValue("Draft throw");
          await page.keyboard.press("Escape");
        } else {
          await expect(cell).toHaveText("Synthetic record 1");
          await expect(
            grid.locator('[data-grid-row="1"][data-grid-column="2"]'),
          ).toBeFocused();
          if (behavior === "delay") {
            await page
              .getByRole("button", { name: "Verify", exact: true })
              .click();
            await expect(cell).toHaveText("Draft delay");
            await expect(status).toContainText("Persistence is not confirmed");
          } else {
            await cell.focus();
            await page.keyboard.press("F2");
            await expect(grid.getByRole("textbox")).toHaveValue(
              `Draft ${behavior}`,
            );
            await page.keyboard.press("Escape");
            await expect(cell).toHaveText("Synthetic record 1");
          }
        }
        await axe(page);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const languages = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
const widths = [375, 1280];
const evidence = process.env.DS005_EVIDENCE_DIR ?? "dist/admin-shell";
const copy = (language: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../locales/${language}.json`, import.meta.url),
      "utf8",
    ),
  );
async function open(page: Page, story = "overview") {
  await page.goto(
    `/iframe.html?id=console-admin-shell--${story}&viewMode=story`,
  );
  await expect(page.getByRole("main")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function inspect(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
async function capture(page: Page, name: string) {
  mkdirSync(evidence, { recursive: true });
  const path = resolve(evidence, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  writeFileSync(
    resolve(evidence, `${name}.json`),
    JSON.stringify(
      {
        screenshot: `${name}.png`,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        viewport: page.viewportSize(),
        locale: await page.locator("html").getAttribute("lang"),
        state: name,
        inspectedByAutomation: true,
        visuallyInspectedByAgent: false,
      },
      null,
      2,
    ),
  );
}

for (const language of languages)
  for (const width of widths) {
    test(`DS-005 rendered states, keyboard and axe ${language} ${width}`, async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({
        locale: language,
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      const external: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        if (
          !["127.0.0.1", "localhost"].includes(
            new URL(route.request().url()).hostname,
          )
        ) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      const m = copy(language),
        k = m.adminShell;
      try {
        await open(page);
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(page.getByRole("banner")).toHaveCount(1);
        await expect(page.getByRole("main")).toHaveCount(1);
        await expect(page.getByRole("note")).toContainText(k.previewNotice);
        await expect(
          page.getByRole("button", { name: m.shell.account, exact: true }),
        ).toHaveCount(1);
        await expect(
          page.getByRole("link", { name: m.assistant.title, exact: true }),
        ).toHaveCount(1);
        const picker = page.getByLabel(m.consoleKit.language, { exact: true });
        expect(
          await picker
            .locator("option")
            .evaluateAll((nodes) =>
              nodes.map((node) => (node as HTMLOptionElement).value),
            ),
        ).toEqual(languages);
        // Start from the document: Tab really reaches the skip link, then the header.
        await page.keyboard.press("Tab");
        await expect(page.getByRole("link", { name: k.skip })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
        await inspect(page);
        await capture(page, `${language}-${width}-closed`);
        const menuTrigger = page.getByRole("button", {
          name: k.navigation,
          exact: true,
        });
        await menuTrigger.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: k.navigation });
        await expect(dialog).toBeVisible();
        expect(
          await page
            .locator("main")
            .evaluate((element) => Boolean(element.closest("[inert]"))),
        ).toBe(true);
        await expect(dialog.locator('[aria-current="page"]')).toHaveText(
          k.overview,
        );
        await expect(
          dialog.getByText(k.unavailable, { exact: true }),
        ).toBeVisible();
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          await expect(dialog.locator(":focus")).toHaveCount(1);
        }
        await inspect(page);
        await capture(page, `${language}-${width}-navigation`);
        await page.keyboard.press("Escape");
        await expect(menuTrigger).toBeFocused();
        await expect(dialog).toHaveCount(0);
        // Route selection updates only the owning story; it closes the sheet and focuses the new h1.
        await page.keyboard.press("Enter");
        await dialog
          .getByRole("link", { name: k.editorial, exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          k.editorial,
        );
        await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
        await expect(page.locator("[data-request]")).toHaveAttribute(
          "data-request",
          "editorial",
        );
        await expect(
          page.getByRole("navigation", {
            name: m.common.breadcrumbs,
            exact: true,
          }),
        ).toBeVisible();
        // Account menu is separate from navigation and commands.
        const account = page.getByRole("button", {
          name: m.shell.account,
          exact: true,
        });
        await account.focus();
        await page.keyboard.press("ArrowDown");
        const userMenu = page.getByRole("menu");
        await expect(userMenu).toBeVisible();
        await expect(
          page.getByRole("menuitem", { name: m.shell.menu.signOut }),
        ).toHaveAttribute("aria-disabled", "true");
        await expect(
          page.getByText(k.accountUnavailable, { exact: true }),
        ).toBeVisible();
        await inspect(page);
        await capture(page, `${language}-${width}-account`);
        await page.keyboard.press("Escape");
        await expect(account).toBeFocused();
        await page.keyboard.press("Enter");
        await page
          .getByRole("menuitem", { name: m.shell.menu.accountSettings })
          .press("Enter");
        await expect(account).toBeFocused();
        await expect(
          page.getByRole("status").filter({ hasText: k.requestNotice }),
        ).toBeVisible();
        await expect(page.locator("[data-request]")).toHaveAttribute(
          "data-request",
          "settings",
        );
        const search = page.getByRole("button", {
          name: m.consoleKit.commands,
          exact: true,
        });
        await search.focus();
        await page.keyboard.press("Control+k");
        const combo = page.getByRole("combobox", {
          name: m.consoleKit.commands,
          exact: true,
        });
        await expect(combo).toBeFocused();
        expect(
          await page
            .locator("main")
            .evaluate((element) => Boolean(element.closest("[inert]"))),
        ).toBe(true);
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press("Tab");
          await expect(page.getByRole("dialog").locator(":focus")).toHaveCount(
            1,
          );
        }
        await combo.focus();
        await inspect(page);
        await capture(page, `${language}-${width}-palette`);
        await combo.fill("zzzz-no-match");
        await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(
          0,
        );
        await expect(
          page.getByRole("status").filter({ hasText: m.common.noResults }),
        ).toBeVisible();
        await inspect(page);
        await capture(page, `${language}-${width}-palette-empty`);
        await page.keyboard.press("Escape");
        await expect(search).toBeFocused();
        await page.keyboard.press("Enter");
        await combo.fill(k.network);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          k.network,
        );
        await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
        await expect(page.locator("[data-request]")).toHaveAttribute(
          "data-request",
          "network",
        );
        await inspect(page);
        await open(page, "long-labels");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          k.longTitle,
        );
        await inspect(page);
        await capture(page, `${language}-${width}-long`);
        await page
          .getByRole("button", { name: k.navigation, exact: true })
          .click();
        await expect(
          page.getByRole("dialog").getByRole("link", { name: k.longTitle }),
        ).toBeVisible();
        await inspect(page);
        await capture(page, `${language}-${width}-long-open`);
        await page.keyboard.press("Escape");
        await open(page, "empty");
        await inspect(page);
        await capture(page, `${language}-${width}-empty`);
        await page
          .getByRole("button", { name: k.navigation, exact: true })
          .click();
        await expect(
          page.getByRole("dialog").getByText(k.emptyNavigation),
        ).toBeVisible();
        await inspect(page);
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: m.shell.account, exact: true })
          .click();
        await expect(
          page.getByText(k.emptyAccount, { exact: true }),
        ).toBeVisible();
        await inspect(page);
        await capture(page, `${language}-${width}-empty-account`);
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("button", { name: m.shell.account, exact: true }),
        ).toBeFocused();
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

test("DS-005 responsive focus, open-modal resize and language selection", async ({
  browser,
}) => {
  const context = await browser.newContext({
    locale: "en",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await open(page);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Editorial", exact: true })
      .focus();
    await page.setViewportSize({ width: 375, height: 812 });
    const trigger = page.getByRole("button", {
      name: "Main navigation",
      exact: true,
    });
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("link", { name: "Network", exact: true }).focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(
      dialog.getByRole("link", { name: "Network", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    for (const language of languages) {
      const select = page.locator("header select");
      await select.focus();
      await select.selectOption(language);
      await expect(select).toBeFocused();
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(
        page.getByRole("button", {
          name: copy(language).shell.account,
          exact: true,
        }),
      ).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

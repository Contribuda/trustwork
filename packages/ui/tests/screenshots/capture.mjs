// Captures review screenshots of selected stories from the static Storybook build (dist/storybook).
// Usage: node tests/screenshots/capture.mjs <outDir> [storyId ...]   (run inside packages/ui after build:storybook)
// Without story ids the default Showcase set is captured at 1280 and 375 px. Output: <outDir>/<story>-<width>.png
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [, , outArg = 'dist/screenshots', ...ids] = process.argv;
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const port = Number(process.env.STORYBOOK_PORT ?? 6111);

const defaults = [
  { id: 'showcase-compositions--home', widths: [1280, 375], fullPage: true },
  { id: 'showcase-compositions--workspace', widths: [1280], fullPage: true },
  { id: 'showcase-compositions--article', widths: [1280], fullPage: true },
  { id: 'editorial-hero-cards-bands--story-cards', widths: [1280], fullPage: true },
  { id: 'editorial-hero-cards-bands--magazine-covers', widths: [1280], fullPage: true },
  { id: 'workspace-decision-entity-events--entity-cards', widths: [1280], fullPage: true },
  { id: 'workspace-decision-entity-events--decision-cards', widths: [1280], fullPage: true },
  { id: 'media-covers-and-photographs--artworks', widths: [1280], fullPage: true },
  { id: 'shell-authshell--login', widths: [1280], fullPage: false },
  { id: 'primitives-typography--scale', widths: [1280], fullPage: true },
];
const targets = ids.length ? ids.map((id) => ({ id, widths: [1280, 375], fullPage: true })) : defaults;

const server = spawn(process.execPath, ['tests/serve-static.mjs', 'dist/storybook', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
try {
  for (const target of targets) {
    for (const width of target.widths) {
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 812 : 800 }, deviceScaleFactor: 1, locale: 'ru-RU' });
      await page.goto(`http://127.0.0.1:${port}/iframe.html?id=${encodeURIComponent(target.id)}&viewMode=story`);
      await page.locator('#storybook-root > *').first().waitFor({ state: 'attached', timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      // Let enter animations and image fades finish, then scroll so lazy images load.
      await page.evaluate(async () => {
        const step = 600;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(700);
      const file = join(out, `${target.id.replace(/^.*?--/, '')}-${width}.png`);
      await page.screenshot({ path: file, fullPage: target.fullPage });
      console.log(file);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}

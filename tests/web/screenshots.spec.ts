import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { hydrated } from './helpers.js';

/**
 * Evidence screenshots (committed under tests/web/__screenshots__). Written only when
 * TRUSTWORK_E2E_SCREENSHOTS=1 so routine runs do not churn binaries. Viewport-only PNGs keep files small.
 */
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '__screenshots__');
const enabled = process.env.TRUSTWORK_E2E_SCREENSHOTS === '1';

const SHOTS: ReadonlyArray<{ name: string; path: string; widths: number[]; prepare?: 'overlay' | 'nav-sheet' | 'menu' }> = [
  { name: 'home', path: '/', widths: [1280, 768, 375] },
  { name: 'news', path: '/news', widths: [1280, 375] },
  { name: 'news-detail', path: '/news/standart-ventfasady-vesna', widths: [1280] },
  { name: 'articles', path: '/articles', widths: [1280] },
  { name: 'companies', path: '/companies', widths: [1280] },
  { name: 'company', path: '/companies/fasad-primer', widths: [1280, 375] },
  { name: 'people', path: '/people', widths: [1280] },
  { name: 'projects', path: '/projects', widths: [1280] },
  { name: 'project', path: '/projects/shkola-na-reke', widths: [1280] },
  { name: 'magazine', path: '/magazine', widths: [1280] },
  { name: 'issue', path: '/magazine/12', widths: [1280, 768] },
  { name: 'reader', path: '/magazine/12/read', widths: [1280, 375] },
  { name: 'login', path: '/login', widths: [1280, 375] },
  { name: 'signup', path: '/signup', widths: [1280] },
  { name: 'recover', path: '/recover', widths: [1280] },
  { name: 'onboarding', path: '/onboarding?persona=reader', widths: [1280, 375] },
  { name: 'onboarding-goals', path: '/onboarding/goals?persona=reader', widths: [1280] },
  { name: 'onboarding-profile', path: '/onboarding/profile?persona=reader', widths: [1280, 375] },
  { name: 'overview-mixed', path: '/app?persona=mixed', widths: [1280, 768, 375] },
  { name: 'overview-reader', path: '/app?persona=reader', widths: [1280] },
  { name: 'overview-owner', path: '/app?persona=owner', widths: [1280] },
  { name: 'me', path: '/app/me?persona=mixed', widths: [1280] },
  { name: 'company-ws', path: '/app/company?persona=mixed', widths: [1280] },
  { name: 'company-ws-empty', path: '/app/company?persona=reader', widths: [1280] },
  { name: 'projects-ws', path: '/app/projects?persona=mixed', widths: [1280, 375] },
  { name: 'project-ws', path: '/app/projects/project-school?persona=mixed', widths: [1280] },
  { name: 'procurement', path: '/app/procurement?persona=mixed', widths: [1280] },
  { name: 'sales', path: '/app/sales?persona=mixed', widths: [1280] },
  { name: 'publications', path: '/app/publications?persona=reader', widths: [1280] },
  { name: 'assistant-overlay', path: '/app?persona=mixed', widths: [1280, 375], prepare: 'overlay' },
  { name: 'assistant', path: '/app/assistant?persona=mixed', widths: [1280] },
  { name: 'settings', path: '/app/settings?persona=mixed', widths: [1280] },
  { name: 'avatar-menu', path: '/app?persona=mixed', widths: [1280], prepare: 'menu' },
  { name: 'nav-sheet', path: '/app?persona=mixed', widths: [375], prepare: 'nav-sheet' },
  { name: 'error', path: '/app?persona=mixed&scenario=error', widths: [1280] },
  { name: 'not-found', path: '/projects/dacha-petra', widths: [1280] },
];

test.describe('screenshots @screenshots', () => {
  test.skip(!enabled, 'set TRUSTWORK_E2E_SCREENSHOTS=1 to write evidence screenshots');
  test.beforeAll(() => mkdirSync(dir, { recursive: true }));

  for (const shot of SHOTS) {
    for (const width of shot.widths) {
      test(`${shot.name} @ ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 800 });
        await page.goto(shot.path);
        await page.waitForLoadState('networkidle');
        if (shot.prepare === 'overlay') await (await hydrated(page.getByRole('button', { name: /Помощник/ }).last())).click();
        if (shot.prepare === 'menu') await (await hydrated(page.getByRole('button', { name: 'Аккаунт' }))).click();
        if (shot.prepare === 'nav-sheet') await (await hydrated(page.getByRole('button', { name: 'Открыть меню' }))).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: resolve(dir, `${shot.name}-${width}.png`), fullPage: false, scale: 'css' });
      });
    }
  }
});

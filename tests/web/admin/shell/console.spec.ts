import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AXE_TAGS, hydrated } from '../../helpers.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';
import { DEMO_FRESH_SETUP_TOKEN, DEMO_SETUP_TOKEN } from '../../../../apps/web/app/admin/_fixtures/setup.js';

/**
 * ADM-002 browser suite for the hub console (demo mode, the main server of apps/web/playwright.config.ts):
 * unreachable for anonymous visitors, the denied state on every route for `staff-none`, permission-filtered
 * navigation, scoped roles, one named hub per page and no switcher, approvals, commands that change nothing in demo
 * mode, the setup wizard, honest "designed" pages, scenarios, Russian without English copy, axe and layout at 1280,
 * 768 and 375 px. English runs with the `en` locale cookie; Russian is the suite default.
 */

const US = '/admin/hubs/us-demo';
const SAM = '/admin/hubs/samarkand';
const cookie = (name: string, value: string) => ({ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
const english = { cookies: [cookie('trustwork.locale', 'en'), cookie('trustwork.country', 'US')], origins: [] };
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

const at = (path: string, persona?: string, extra = '') => `${path}${persona ? `?persona=${persona}${extra ? `&${extra}` : ''}` : extra ? `?${extra}` : ''}`;
const sectionPath = (base: string, path: string) => (path ? `${base}/${path}` : base);

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n');
  expect(results.violations, summary).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scrolling').toBeLessThanOrEqual(1);
}

/** Visible and screen-reader text in the page's language: data in another language (`lang`), code and the workspace demo strip are excluded. */
async function uiText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pageLang = document.documentElement.lang;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) {
      const element = walker.currentNode.parentElement;
      if (!element || element.closest('script, style, code, template, [data-testid="demo-banner"]')) continue;
      const tagged = element.closest('[lang]');
      if (tagged && tagged !== document.documentElement && tagged.getAttribute('lang') !== pageLang) continue;
      parts.push(walker.currentNode.textContent ?? '');
    }
    return parts.join(' ');
  });
}

const LATIN_OK = /\b(Trustwork|OpenRouter|HTTPS|localhost|Tab|Escape|ISO|US|UZ|en|es)\b/g;
async function expectNoEnglish(page: Page) {
  const text = (await uiText(page)).replace(/\S+@\S+/g, ' ').replace(/\b[a-z0-9]+(?:[.-][a-z0-9]+)+\b/g, ' ').replace(/\b[A-Z]{2}(?:-[A-Z0-9]{1,3})?(?::[a-z0-9-]+)?\b/g, ' ').replace(LATIN_OK, ' ');
  const latin = text.match(/\b[A-Za-z]{3,}\b/g) ?? [];
  expect(latin, `English copy found: ${[...new Set(latin)].join(', ')}`).toEqual([]);
  expect(text).toMatch(/[А-Яа-яЁё]{3,}/);
}

test.describe('hub console: who can reach it', () => {
  test('demo /admin without a persona lists the staff roles; each opens the console as that role', async ({ page }) => {
    const response = await page.goto('/admin');
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('admin-demo-chooser')).toBeVisible();
    await expect(page.getByTestId('admin-demo-chooser').getByRole('link')).toHaveCount(13);
    await page.getByTestId('admin-demo-persona-hub-owner').click();
    await expect(page).toHaveURL(/persona=hub-owner/);
    await expect(page.getByTestId('admin-demo-chooser')).toHaveCount(0);
  });

  test('anonymous visitors get 404 on every other console route, the wizard included', async ({ page }) => {
    for (const path of [US, `${US}/approvals`, `${US}/hub/identity`, `${US}/integrations/providers`, SAM, '/admin/setup', '/admin/setup/check', '/admin/hubs/no-such-hub']) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }
    expect((await page.goto(`${US}?persona=mixed`))?.status(), 'a workspace persona is not a staff persona').toBe(404);
  });

  test('staff-none sees the denied state, and nothing else, on every console route of both hubs', async ({ page }) => {
    const paths = ['/admin', ...SECTIONS.map(({ section }) => sectionPath(US, section.path)), ...SECTIONS.filter(({ group }) => group.id === 'home' || group.id === 'hub').map(({ section }) => sectionPath(SAM, section.path))];
    for (const path of paths) {
      const response = await page.request.get(at(path, 'staff-none'));
      expect(response.status(), path).toBe(200);
      const html = await response.text();
      expect(html, `${path}: denied state`).toContain('data-testid="admin-denied"');
      expect(html, `${path}: no console navigation`).not.toContain('admin-nav__link');
      expect(html, `${path}: no hub data`).not.toContain('admin-panel');
    }
  });

  test('a revoked role grants nothing, and unknown sections stay not found', async ({ page }) => {
    await page.goto(at(`${US}/hub/identity`, 'staff-none'));
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    expect((await page.goto(at(`${US}/no/such/section`, 'hub-owner')))?.status()).toBe(404);
  });
});

test.describe('hub console in English', () => {
  test.use({ storageState: english });

  test('the shell names one hub, shows the demo band, filters navigation and has no hub switcher', async ({ page }) => {
    await page.goto(at(US, 'hub-owner'));
    const band = page.locator('header.admin-band');
    await expect(band.getByText('Administration', { exact: true })).toBeVisible();
    await expect(page.getByTestId('admin-hub-name')).toHaveText('Trustwork United States (demo)');
    await expect(page.getByTestId('acts-on')).toContainText('Trustwork United States (demo)');
    await expect(page.getByTestId('admin-demo-band')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(band.getByRole('combobox')).toHaveCount(0);
    await expect(band.getByRole('link', { name: /Samarqand|Samarkand/ })).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Console navigation' });
    await expect(nav.getByRole('link', { name: 'Identity and territory' })).toBeVisible();
    await expect(nav.getByText('Privacy', { exact: true })).toHaveCount(0);
    await expect(nav.getByText('Staff and audit', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Help' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the workspace' })).toBeVisible();
    for (const path of ['approvals', 'help', 'hub/identity', 'hub/modes', 'hub/modules', 'hub/legal', 'hub/residency', 'hub/country', 'hub/taxonomy', 'hub/launch']) {
      await page.goto(at(`${US}/${path}`, 'hub-owner'));
      await expect(page.getByTestId('acts-on'), path).toContainText('Trustwork United States (demo)');
      await expect(page.getByTestId('admin-demo-band'), path).toBeVisible();
    }
  });

  test('overview: queues only for what the viewer may act on, gates, health and caps', async ({ page }) => {
    await page.goto(at(US, 'trust-reviewer'));
    const queues = page.locator('#queues');
    await expect(queues.getByRole('link', { name: 'Claims' })).toBeVisible();
    await expect(queues.getByRole('link', { name: 'Support cases' })).toHaveCount(0);
    await page.goto(at(US, 'hub-owner'));
    await expect(page.locator('#launch-progress')).toContainText('4 of 14');
    await expect(page.locator('#health')).toContainText('Not measured yet');
    await expect(page.locator('#spend')).toHaveCount(1);
    await page.goto(at(US, 'auditor'));
    await expect(page.getByTestId('nothing-waiting')).toHaveText('Nothing needs your decision today.');
    await page.goto(at(SAM, 'node-operator'));
    await expect(page.getByTestId('reduced-sod')).toBeVisible();
  });

  test('a section without permission is absent from navigation and denied by address, with the roles that grant it', async ({ page }) => {
    await page.goto(at(`${US}/privacy/requests`, 'hub-owner'));
    await expect(page.getByTestId('admin-denied')).toContainText('You do not have access to this section');
    await expect(page.getByTestId('admin-denied')).toContainText('Privacy officer');
    await expect(page.getByRole('navigation', { name: 'Console navigation' })).toBeVisible();
  });

  test('scoped roles: a US hub owner is denied on Samarkand; a node operator covers both and gets the hub list', async ({ page }) => {
    await page.goto(at(SAM, 'hub-owner'));
    await expect(page.getByTestId('admin-denied')).toContainText('Your staff roles cover another hub, not this one.');
    await page.goto(at('/admin', 'hub-owner'));
    await expect(page).toHaveURL(new RegExp(`${US}\\?persona=hub-owner$`));
    await page.goto(at('/admin', 'node-operator'));
    await expect(page.getByTestId('admin-hub-list').getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('Node console')).toBeVisible();
    await page.goto(at('/admin', 'staff-none'));
    await expect(page.getByTestId('admin-denied')).toContainText('You have no staff role for this hub');
  });

  test('approvals: decide with the digest, never one\'s own, void and expired states; demo saves nothing', async ({ page }) => {
    await page.goto(at(`${US}/approvals`, 'hub-owner'));
    const legal = page.getByTestId('approval-rq-legal-privacy-2');
    await expect(legal).toContainText('Activate a legal document version');
    await expect(legal).toContainText('Privacy notice 2');
    await expect(page.getByTestId('approval-rq-automation-editorial')).toContainText('The action changed; a new request is required.');
    const mine = page.getByTestId('approval-rq-role-compliance');
    await expect(mine).toContainText('You cannot approve your own request.');
    await (await hydrated(legal.getByLabel('Reason'))).fill('Counsel letter checked against both editions');
    await legal.getByRole('button', { name: 'Record the decision' }).click();
    await expect(legal.locator('.admin-form__result')).toHaveText('Demo: changes are not saved.');
    await page.goto(at(`${US}/approvals`, 'compliance'));
    await expect(page.locator('#mine').getByTestId('approval-rq-legal-privacy-2')).toBeVisible();
    await page.goto(at(`${SAM}/approvals`, 'node-operator'));
    await expect(page.getByTestId('approvals-empty')).toBeVisible();
  });

  test('commands are validated and authorized on the server: restricted places, contradictions, read-only viewers', async ({ page }) => {
    await page.goto(at(`${US}/hub/identity`, 'hub-owner'));
    const form = page.locator('#change');
    await (await hydrated(form.getByLabel('Add a territory'))).fill('UA-43:sevastopol');
    await form.getByLabel('Reason').fill('Synthetic test');
    await form.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(form.locator('.admin-form__result')).toHaveText('This territory is not available.');
    await form.getByLabel('Add a territory').fill('US-TX:austin');
    await form.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(form.locator('.admin-form__result')).toHaveText('Demo: changes are not saved.');
    await expect(form.getByLabel('Reason')).toHaveValue('Synthetic test');

    await page.goto(at(`${US}/hub/modes`, 'hub-owner'));
    const modes = page.locator('#change-modes');
    await (await hydrated(modes.getByLabel('Registration', { exact: true }))).selectOption('open');
    await modes.getByLabel('Reason').fill('Synthetic test');
    await modes.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(modes.locator('.admin-form__result')).toContainText('open registration only when public');

    await page.goto(at(`${US}/hub/launch`, 'hub-owner'));
    const launch = page.locator('#request-launch');
    await (await hydrated(launch.getByLabel('Reason'))).fill('Synthetic test');
    await launch.getByRole('button', { name: 'Request soft launch or public' }).click();
    await expect(launch.locator('.admin-form__result')).toContainText('Open launch gates block this');

    await page.goto(at(`${US}/hub/identity`, 'editor'));
    await expect(page.locator('#change')).toContainText('Read only: your roles do not include changing this.');
    await expect(page.locator('#change').getByRole('button', { name: 'Save as a new version' })).toBeDisabled();
  });

  test('scenarios: elevation gate, offline, maintenance, engaged kill switch and the error boundary', async ({ page }) => {
    await page.goto(at(US, 'hub-owner', 'scenario=elevation-required'));
    await expect(page.getByTestId('admin-elevation')).toContainText('Confirm it is you');
    await expect(page.getByRole('navigation', { name: 'Console navigation' })).toHaveCount(0);
    await page.goto(at(`${US}/hub/identity`, 'hub-owner', 'scenario=offline'));
    await expect(page.getByTestId('admin-offline-band')).toBeVisible();
    await expect(page.locator('#change').getByRole('button', { name: 'Save as a new version' })).toBeDisabled();
    await page.goto(at(US, 'ops', 'scenario=maintenance'));
    await expect(page.getByTestId('admin-maintenance-band')).toBeVisible();
    await page.goto(at(US, 'ops', 'scenario=kill-switch-engaged'));
    await expect(page.getByTestId('admin-kill-switch-band')).toContainText('all outbound messages');
    await page.goto(at(US, 'hub-owner', 'scenario=error'));
    await expect(page.getByRole('heading', { level: 1, name: 'Could not load the page' })).toBeVisible();
  });

  test('designed sections render an honest status page, not an imitation', async ({ page }) => {
    await page.goto(at(`${US}/integrations/providers`, 'ops'));
    await expect(page.getByTestId('admin-designed')).toContainText('Designed, not built yet');
    await expect(page.getByTestId('admin-designed')).toContainText('HC-100');
    await expect(page.getByRole('navigation', { name: 'Console navigation' }).getByRole('link', { name: /Providers/ })).toContainText('Designed');
  });

  test('setup wizard: token required, no skipping ahead, blocking checks, restricted places refused, second factor required', async ({ page }) => {
    expect((await page.goto('/admin/setup/check?token=wrong'))?.status()).toBe(404);
    await page.goto(`/admin/setup?token=${DEMO_SETUP_TOKEN}`);
    await expect(page).toHaveURL(/\/admin\/setup\/review\?token=/);
    await expect(page.getByTestId('setup-summary').getByRole('listitem')).toHaveCount(8);
    await page.goto(`/admin/setup/review?token=${DEMO_FRESH_SETUP_TOKEN}`);
    await expect(page).toHaveURL(/\/admin\/setup\/check\?token=/);
    await expect(page.getByTestId('check-worker')).toContainText('Failed');
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeDisabled();

    await page.goto(`/admin/setup/hub?token=${DEMO_SETUP_TOKEN}&example=us`);
    await expect(page.getByLabel('Territory')).toHaveValue('US-CA:san-diego');
    await (await hydrated(page.getByLabel('Territory'))).fill('RU');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.locator('#setup-step .admin-form__result')).toHaveText('This territory is not available.');

    await page.goto(`/admin/setup/admin?token=${DEMO_SETUP_TOKEN}`);
    await (await hydrated(page.getByLabel('Name'))).fill('Synthetic Hub Owner');
    await page.getByLabel('E-mail').fill('owner@setup.example.invalid');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.locator('#setup-step .admin-form__result')).toContainText('second factor');
    await page.getByLabel('Second factor').selectOption('webauthn');
    await page.getByLabel('I have stored the recovery codes.').check();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/admin\/setup\/residency\?token=/);
  });
});

test.describe('hub console in Russian', () => {
  test('no English copy on the Samarkand hub screens, the hub list, a designed page and the wizard', async ({ page }) => {
    const paths = [
      at('/admin', 'node-operator'),
      ...['', 'approvals', 'help', 'hub/identity', 'hub/modes', 'hub/modules', 'hub/legal', 'hub/residency', 'hub/country', 'hub/taxonomy', 'hub/launch', 'ops/health'].map((p) => at(sectionPath(SAM, p), 'node-operator')),
      at(`${US}/approvals`, 'hub-owner'),
      at(US, 'hub-owner', 'scenario=elevation-required'),
      at(`${US}/privacy/requests`, 'hub-owner'),
      `/admin/setup/check?token=${DEMO_FRESH_SETUP_TOKEN}`,
      `/admin/setup/review?token=${DEMO_SETUP_TOKEN}`,
    ];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator('.admin'), path).toBeVisible();
      await expectNoEnglish(page);
    }
    await page.goto(at(SAM, 'node-operator'));
    await expect(page.getByTestId('admin-hub-name')).toHaveText('Trustwork Самарканд (пример)');
    await expect(page.getByTestId('admin-demo-band')).toContainText('Демонстрационные данные');
  });
});

test.describe('hub console layout and accessibility', () => {
  for (const viewport of VIEWPORTS) {
    test(`axe and layout at ${viewport.width} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const path of [at(US, 'hub-owner'), at(`${US}/approvals`, 'hub-owner'), at(`${US}/hub/identity`, 'hub-owner'), at(`${US}/hub/launch`, 'hub-owner'), at(`${SAM}/hub/residency`, 'node-operator'), at(`${US}/hub/modes`, 'staff-none'), at('/admin', 'node-operator'), `/admin/setup/hub?token=${DEMO_SETUP_TOKEN}`]) {
        await page.goto(path);
        await expect(page.locator('.admin'), path).toBeVisible();
        await axe(page);
        await noHorizontalScroll(page);
      }
    });
  }

  test('keyboard: the skip link comes first; on a phone the sections open as a sheet that Escape closes', async ({ page }) => {
    await page.goto(at(US, 'hub-owner'));
    await page.keyboard.press('Tab');
    await expect(page.locator('.admin-skip')).toBeFocused();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(at(US, 'hub-owner'));
    await expect(page.locator('.admin-sidebar')).toBeHidden();
    const menu = await hydrated(page.locator('.admin-band__menu button'));
    await menu.click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('link', { name: 'Одобрения' }).or(sheet.getByRole('link', { name: 'Согласования' }))).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });
});

test.describe('hub console screenshots', () => {
  test.skip(!process.env.TRUSTWORK_E2E_SCREENSHOTS, 'set TRUSTWORK_E2E_SCREENSHOTS=1 to write the PR screenshots');
  test('writes screenshots in Russian and English at 1280 and 375 px', async ({ page, context }) => {
    const out = resolve('dist/admin-screenshots');
    mkdirSync(out, { recursive: true });
    const shots = [
      ['overview', at(US, 'hub-owner')],
      ['approvals', at(`${US}/approvals`, 'hub-owner')],
      ['launch', at(`${US}/hub/launch`, 'hub-owner')],
      ['samarkand-overview', at(SAM, 'node-operator')],
      ['denied-staff-none', at(`${US}/hub/identity`, 'staff-none')],
      ['setup-hub', `/admin/setup/hub?token=${DEMO_SETUP_TOKEN}&example=samarkand`],
    ] as const;
    for (const locale of ['ru', 'en'] as const) {
      await context.addCookies([{ name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/' }]);
      for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const [name, path] of shots) {
          await page.goto(path);
          await page.screenshot({ path: `${out}/${locale}-${viewport.width}-${name}.png`, fullPage: viewport.width === 1280 });
        }
      }
    }
  });
});

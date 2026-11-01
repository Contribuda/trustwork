import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AXE_TAGS, hydrated } from '../../helpers.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';

/**
 * HUBC-005 browser suite: the agent product, product modules, billing and communications screens of the hub console on
 * fixtures (demo mode, the main server of apps/web/playwright.config.ts). Every built section renders; suppressed cohorts
 * read "fewer than 10"; activation shows the stored preview and only creates a second-person request; there is no list
 * of anyone's agent; guard rails are shown locked without a control; Russian has no English copy; axe and layout at
 * 1280, 768 and 375 px.
 */

const US = '/admin/hubs/us-demo';
const SAM = '/admin/hubs/samarkand';
const cookie = (name: string, value: string) => ({ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
const english = { cookies: [cookie('trustwork.locale', 'en'), cookie('trustwork.country', 'US')], origins: [] };
const at = (path: string, persona: string) => `${path}?persona=${persona}`;
const GROUPS = ['modules', 'agents', 'billing', 'communications'];
const BUILT = SECTIONS.filter(({ group, section }) => GROUPS.includes(group.id) && section.status === 'demo');
/** The persona that may read each group on the US hub. */
const READER: Record<string, string> = { modules: 'hub-owner', agents: 'hub-owner', billing: 'commercial', communications: 'hub-owner' };
const readerFor = (group: string) => READER[group]!;

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n');
  expect(results.violations, summary).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scrolling').toBeLessThanOrEqual(1);
}

/** Visible and screen-reader text in the page's language; data in another language (`lang`), code and the workspace demo strip are excluded. */
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

const LATIN_OK = /\b(Trustwork|HTTPS|MCP|A2A|SPF|DKIM|DMARC|DNS|10DLC|USD|UZS|US|UZ|en|es)\b/g;
async function expectNoEnglish(page: Page) {
  const text = (await uiText(page))
    .replace(/\S+@\S+/g, ' ')
    // Identifiers and codes shown as option values (capability ids, template keys, record ids).
    .replace(/[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)+/g, ' ')
    .replace(/\b[A-Z]{2}(?:-[A-Z0-9]{1,3})?\b/g, ' ')
    .replace(LATIN_OK, ' ');
  const latin = text.match(/\b[A-Za-z]{3,}\b/g) ?? [];
  expect(latin, `English copy found: ${[...new Set(latin)].join(', ')}`).toEqual([]);
  expect(text).toMatch(/[А-Яа-яЁё]{3,}/);
}

test.describe('hub console product screens (English)', () => {
  test.use({ storageState: english });

  test('every built section of modules, agents, billing and communications renders for a staff member who may read it', async ({ page }) => {
    expect(BUILT.length).toBe(24);
    for (const { group, section } of BUILT) {
      const response = await page.goto(at(`${US}/${section.path}`, readerFor(group.id)));
      expect(response?.status(), section.path).toBe(200);
      await expect(page.getByRole('heading', { level: 1 }), section.path).toBeVisible();
      await expect(page.getByTestId('admin-denied'), section.path).toHaveCount(0);
      await expect(page.getByTestId('admin-designed'), section.path).toHaveCount(0);
    }
    // Procurement stays designed (HUBC-011); the Samarkand hub shows teaching empty states.
    await page.goto(at(`${US}/modules/procurement`, 'hub-owner'));
    await expect(page.getByTestId('admin-designed')).toContainText('HC-68');
    await page.goto(at(`${SAM}/agents/modules`, 'ops'));
    await expect(page.getByText('No agent modules are switched on in this hub yet.')).toBeVisible();
  });

  test('cohort counts under ten read "fewer than 10", never a number', async ({ page }) => {
    await page.goto(at(`${US}/agents/usage`, 'hub-owner'));
    const row = page.getByTestId('usage-table').getByRole('row', { name: /RFQ responder/ });
    await expect(row).toContainText('fewer than 10');
    await expect(row.locator('[data-suppressed="true"]').first()).toBeVisible();
    await page.goto(at(`${US}/agents/external`, 'hub-owner'));
    await expect(page.locator('#external-protocols')).toContainText('fewer than 10');
  });

  test('activation shows the stored preview with cohort counts and only creates a second-person request', async ({ page }) => {
    await page.goto(at(`${US}/billing/prices`, 'commercial'));
    const request = page.locator('#activate-pr-planner-2');
    await expect(request.getByTestId('activation-preview')).toContainText('Stored preview of the effect');
    await expect(request.getByTestId('activation-preview')).toContainText('Job subscriptions affected');
    await expect(request.getByTestId('activation-request')).toHaveAttribute('data-second-person', 'commerce.activate_price_version');
    const form = request.getByTestId('activation-request');
    await (await hydrated(form.getByLabel('Reason'))).fill('Synthetic test: planner price version 2');
    await form.getByRole('button', { name: 'Request activation' }).click();
    await expect(form.locator('.admin-form__result')).toContainText('second-person request');

    await page.goto(at(`${US}/agents/extensions`, 'hub-owner'));
    const weather = page.getByTestId('extension-weather_window');
    await expect(weather.getByTestId('safety-failed')).toBeVisible();
    await expect(weather.getByRole('button', { name: 'Request activation' })).toBeDisabled();
    const catalog = page.getByTestId('extension-supplier_catalog');
    await expect(catalog.getByTestId('activation-request')).toHaveAttribute('data-second-person', 'agents.activate_extension');
    await expect(catalog.getByTestId('activation-preview')).toContainText('fewer than 10');

    await page.goto(at(`${US}/modules/marketplace`, 'commercial'));
    await expect(page.getByTestId('pending-requests')).toBeVisible();
    await expect(page.locator('#activate-fee-consultation-2').getByTestId('activation-request')).toHaveAttribute('data-second-person', 'billing.activate_fee_version');
  });

  test('agent policy and non-commitment module activation are blocked; jurisdiction shows its stored preview', async ({ page }) => {
    await page.goto(at(`${US}/agents/modules`, 'hub-owner'));
    const planner = page.locator('#module-project_planner');
    await expect(planner.getByTestId('activation-preview')).toBeVisible();
    await expect(planner.getByRole('button', { name: 'Request activation' })).toBeDisabled();
    await expect(planner).toContainText('One person cannot activate this change.');
    await page.goto(at(`${US}/agents/policy`, 'hub-owner'));
    const policy = page.locator('#policy-draft');
    await expect(policy.getByRole('button', { name: 'Request activation' })).toBeDisabled();
    await expect(policy).toContainText('One person cannot activate this change.');
    const jurisdiction = page.getByTestId('jurisdiction-US-TX');
    await expect(jurisdiction.getByTestId('activation-preview')).toContainText('Record keeping (years)');
    await expect(jurisdiction.locator('input[name="f.previewDigest"]')).toHaveValue(/^[a-f0-9]{64}$/);
    await expect(jurisdiction.getByRole('button', { name: 'Request activation' })).toBeDisabled();
  });

  test('there is no list of anyone\'s agent, and guard rails are locked without a control', async ({ page }) => {
    await page.goto(at(`${US}/agents/modules`, 'hub-owner'));
    await expect(page.getByTestId('no-agent-list')).toBeVisible();
    await expect(page.locator('a[href*="/participants/people/"], a[href*="/support/accounts/"]')).toHaveCount(0);
    const rails = page.getByTestId('guard-rails');
    for (const rail of ['mandates', 'confirmations', 'sanctions', 'restrictedPlaces', 'paymentNeutrality']) await expect(rails.locator(`[data-guard-rail="${rail}"]`)).toContainText('Locked');
    await expect(page.locator('#guard-rails').locator('input, select, textarea, button')).toHaveCount(0);
    await expect(page.getByTestId('negative-margin')).toBeVisible();
    await page.goto(at(`${US}/agents/external`, 'hub-owner'));
    await expect(page.getByTestId('no-client-list')).toBeVisible();
  });

  test('commands are checked on the server: guard rails, restricted places, own-template publishing, read-only viewers', async ({ page }) => {
    await page.goto(at(`${US}/agents/extensions`, 'hub-owner'));
    const draft = page.locator('#draft-extension');
    await (await hydrated(draft.getByLabel('Extension key'))).fill('demo_tool');
    await draft.getByLabel('Endpoint host').fill('api.partner.example');
    await draft.getByLabel('Country of the endpoint').fill('IR');
    await draft.getByLabel('Reason').fill('Synthetic test');
    await draft.getByRole('button', { name: 'Draft an extension' }).click();
    await expect(draft.locator('.admin-form__result')).not.toHaveText('');
    await expect(draft.locator('.admin-form__result')).not.toContainText('Demo: changes are not saved');

    await page.goto(at(`${US}/modules/knowledge-sharing`, 'editor'));
    const share = page.getByTestId('share-ks-diary-1');
    await expect(share.getByTestId('consent-missing')).toContainText('Example Framing Co. (demo)');
    await expect(share.getByRole('option', { name: 'Publish' })).toHaveCount(0);

    await page.goto(at(`${US}/billing/prices`, 'hub-owner'));
    await expect(page.getByTestId('admin-denied')).toHaveCount(0);
    await expect(page.locator('#price-draft')).toContainText('Read only: your roles do not include changing this.');
    await page.goto(at(`${US}/billing/prices`, 'editor'));
    await expect(page.getByTestId('admin-denied')).toBeVisible();
  });
});

test.describe('hub console product screens in Russian', () => {
  test('no English copy on the agent, billing, module and communications screens', async ({ page }) => {
    const paths = [
      at(`${US}/agents/modules`, 'hub-owner'),
      at(`${US}/agents/policy`, 'hub-owner'),
      at(`${US}/agents/extensions`, 'hub-owner'),
      at(`${US}/agents/usage`, 'hub-owner'),
      at(`${US}/billing/prices`, 'commercial'),
      at(`${US}/billing/credits`, 'commercial'),
      at(`${US}/modules/marketplace`, 'commercial'),
      at(`${US}/modules/planner`, 'hub-owner'),
      at(`${US}/communications/templates`, 'hub-owner'),
      at(`${SAM}/agents/modules`, 'ops'),
    ];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator('.admin'), path).toBeVisible();
      await expectNoEnglish(page);
    }
    await page.goto(at(`${US}/agents/usage`, 'hub-owner'));
    await expect(page.getByTestId('usage-table')).toContainText('меньше 10');
  });
});

test.describe('hub console product screens: layout and accessibility', () => {
  const pages = [
    at(`${US}/agents/modules`, 'hub-owner'),
    at(`${US}/agents/policy`, 'hub-owner'),
    at(`${US}/agents/extensions`, 'hub-owner'),
    at(`${US}/agents/usage`, 'hub-owner'),
    at(`${US}/billing/prices`, 'commercial'),
    at(`${US}/billing/offers`, 'commercial'),
    at(`${US}/modules/marketplace`, 'commercial'),
    at(`${US}/modules/knowledge-sharing`, 'editor'),
    at(`${US}/communications/senders`, 'hub-owner'),
  ];
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ]) {
    test(`axe and layout at ${viewport.width} px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      for (const path of pages) {
        await page.goto(path);
        await expect(page.locator('.admin'), path).toBeVisible();
        await axe(page);
        await noHorizontalScroll(page);
        const overflowingLabels = await page.locator('.agent-capabilities td').evaluateAll((cells) => cells.filter((cell) => {
          const label = getComputedStyle(cell, '::before');
          return parseFloat(label.height) > cell.getBoundingClientRect().height + 1;
        }).length);
        expect(overflowingLabels, 'translated table labels stay inside their cells').toBe(0);
      }
    });
  }
});

test.describe('hub console product screenshots', () => {
  test.skip(!process.env.TRUSTWORK_E2E_SCREENSHOTS, 'set TRUSTWORK_E2E_SCREENSHOTS=1 to write the PR screenshots');
  test('writes screenshots in English and Russian at 1280 and 375 px', async ({ page, context }) => {
    test.setTimeout(240_000);
    const out = resolve('dist/admin-screenshots');
    mkdirSync(out, { recursive: true });
    const shots = [
      ['agents-modules', at(`${US}/agents/modules`, 'hub-owner')],
      ['agents-extensions', at(`${US}/agents/extensions`, 'hub-owner')],
      ['agents-usage', at(`${US}/agents/usage`, 'hub-owner')],
      ['billing-prices', at(`${US}/billing/prices`, 'commercial')],
      ['modules-marketplace', at(`${US}/modules/marketplace`, 'commercial')],
    ] as const;
    for (const locale of ['en', 'ru'] as const) {
      await context.addCookies([{ name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/' }]);
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 375, height: 812 },
      ]) {
        await page.setViewportSize(viewport);
        for (const [name, path] of shots) {
          await page.goto(path);
          await page.screenshot({ path: `${out}/hubc5-${locale}-${viewport.width}-${name}.png`, fullPage: true });
        }
      }
    }
  });
});

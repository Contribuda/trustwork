import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AXE_TAGS, hydrated } from '../../helpers.js';

/**
 * OUTR-004 browser suite: the outreach section (HC-170 to HC-177) on fixtures, demo mode, the main server of
 * apps/web/playwright.config.ts. Acceptance: no control enables consumer outreach or an automated, consent-only or
 * forbidden channel; suppression only by exact lookup; every campaign shows its exact messages per language and
 * jurisdiction; small cohorts suppressed. Plus the strict banner, counsel and second person before a mode change,
 * permissions, Spanish without English copy, axe and layout at 1280, 768 and 375 px. Russian is not maintained
 * (ADR 009 decision 11), so the non-English run uses Spanish.
 */

const US = '/admin/hubs/us-demo';
const cookie = (name: string, value: string) => ({ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
const state = (locale: string) => ({ cookies: [cookie('trustwork.locale', locale), cookie('trustwork.country', 'US')], origins: [] });
const at = (path: string, persona: string, extra = '') => `${US}/${path}?persona=${persona}${extra ? `&${extra}` : ''}`;

/** Every OUTR-004 screen with a persona that may read it. */
const PAGES: ReadonlyArray<readonly [string, string]> = [
  ['outreach', 'editor'],
  ['outreach/policies', 'hub-owner'],
  ['outreach/campaigns', 'editor'],
  ['outreach/campaigns/claim-invite-roofing', 'editor'],
  ['outreach/templates', 'editor'],
  ['outreach/replies', 'editor'],
  ['outreach/suppression', 'privacy'],
  ['outreach/deliverability', 'ops'],
  ['outreach/lifecycle', 'editor'],
];

/** Values the engine floor forbids in any form that stores or sends something. */
const FORBIDDEN = ['consumer', 'phone_automated', 'sms_messenger', 'contact_form', 'social_message'];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n');
  expect(results.violations, summary).toEqual([]);
}

/** Fills the reason of the form that holds this button inside the area, submits it and returns its live result. */
async function submit(page: Page, area: ReturnType<Page['locator']>, button: string, reason = 'Synthetic test reason') {
  const form = area.locator('form').filter({ has: page.getByRole('button', { name: button }) });
  await (await hydrated(form.getByLabel('Reason'))).fill(reason);
  await form.getByRole('button', { name: button }).click();
  return form.locator('.admin-form__result');
}

test.describe('OUTR-004 in English', () => {
  test.use({ storageState: state('en') });

  test('acceptance 1: every screen renders with the strict banner, and no POST form offers a forbidden class or channel', async ({ page }) => {
    for (const [path, persona] of PAGES) {
      const response = await page.goto(at(path, persona));
      expect(response?.status(), path).toBe(200);
      await expect(page.getByTestId('acts-on'), path).toContainText('Trustwork United States (demo)');
      await expect(page.getByTestId('admin-demo-band'), path).toBeVisible();
      // Lifecycle journeys write to people who opted in, so the outreach strict rule does not apply to them.
      if (path !== 'outreach/lifecycle') await expect(page.getByTestId('outreach-strict'), path).toHaveText('Outreach is off: the strict rule applies in this hub.');
      const offered = await page.evaluate(() =>
        [...document.querySelectorAll('form')]
          .filter((f) => (f.getAttribute('method') ?? 'get').toLowerCase() === 'post' || f.querySelector('input[name="command"]'))
          .flatMap((f) => [...f.querySelectorAll('option, input[type="hidden"], input[type="radio"], input[type="checkbox"]')].map((o) => `${(o as HTMLInputElement).name || 'option'}=${(o as HTMLInputElement).value}`)),
      );
      expect(offered.filter((o) => FORBIDDEN.some((v) => o.endsWith(`=${v}`))), `${path}: forbidden value`).toEqual([]);
    }
  });

  test('overview and engine floor: mode, kill switch and the floor as rows without switches', async ({ page }) => {
    await page.goto(at('outreach', 'ops'));
    const floor = page.getByTestId('engine-floor');
    await expect(floor).toContainText('Consumer');
    await expect(floor).toContainText('Automated or AI voice call');
    await expect(floor.locator('input, select, button, [role="switch"]')).toHaveCount(0);
    await expect(await submit(page, page.locator('#kill-switch'), 'Engage the outreach kill switch')).toHaveText('Demo: this would engage the kill switch; nothing is saved.');
  });

  test('policies: counsel approval and a second person before a mode change; the simulator refuses forbidden outreach', async ({ page }) => {
    await page.goto(at('outreach/policies', 'compliance'));
    await expect(page.getByTestId('counsel-required')).toHaveText('A counsel approval record is required before this mode can be activated.');
    await expect(page.getByRole('button', { name: 'Request activation' })).toBeDisabled();
    await page.goto(at('outreach/policies', 'hub-owner', 'f.class=consumer&f.channel=email&f.jurisdiction=US-CA&f.source=on'));
    const simulation = page.getByTestId('simulation');
    await expect(simulation.locator('li')).not.toHaveCount(0);
    for (const item of await simulation.locator('li').all()) await expect(item).toHaveAttribute('data-contact', 'false');
    await page.goto(at('outreach/policies', 'hub-owner', 'f.class=business_role&f.channel=sms_messenger&f.jurisdiction=US-CA&f.source=on'));
    for (const item of await page.getByTestId('simulation').locator('li').all()) await expect(item).toHaveAttribute('data-contact', 'false');
  });

  test('acceptance 3: each campaign shows the exact message per language and jurisdiction; activation is refused under the strict rule', async ({ page }) => {
    await page.goto(at('outreach/campaigns', 'editor'));
    await expect(page.getByTestId('campaigns')).toContainText('fewer than 10');
    for (const id of ['claim-invite-roofing', 'correction-framing']) {
      await page.goto(at(`outreach/campaigns/${id}`, 'editor'));
      const previews = page.getByTestId('campaign-previews').getByTestId('message-preview');
      await expect(previews).not.toHaveCount(0);
      for (const preview of await previews.all()) {
        await expect(preview).toContainText('US-CA');
        await expect(preview).toContainText('Unsubscribe');
      }
      await expect(page.getByTestId('policy-gates')).toBeVisible();
      await expect(page.locator('#activation').getByRole('button', { name: 'Request activation' })).toBeDisabled();
    }
    await page.goto(at('outreach/campaigns/claim-invite-roofing', 'editor'));
    await expect(page.getByTestId('campaign-previews').getByTestId('message-preview')).toHaveCount(2);
    expect((await page.goto(at('outreach/campaigns/nope-nope', 'editor')))?.status()).toBe(404);
  });

  test('acceptance 2: suppression is found only by exact lookup; partial input finds nothing; no list is rendered', async ({ page }) => {
    await page.goto(at('outreach/suppression', 'privacy'));
    await expect(page.locator('#lookup')).toContainText('Look up one address at a time; the list cannot be browsed.');
    await expect(page.locator('body')).not.toContainText('example-plumbing.invalid');
    await expect(page.getByTestId('suppression-counts')).toContainText('fewer than 10');
    const lookup = page.locator('#lookup');
    await (await hydrated(lookup.getByLabel('Address or domain'))).fill('  Contact@Example-Plumbing.invalid ');
    await lookup.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByTestId('suppression-result')).toHaveAttribute('data-found', 'true');
    for (const partial of ['contact@', 'example-plumbing.invalid', '*']) {
      await page.goto(at('outreach/suppression', 'privacy', `f.identifier=${encodeURIComponent(partial)}`));
      await expect(page.getByTestId('suppression-result'), partial).toHaveAttribute('data-found', 'false');
    }
    await expect(page.locator('body')).not.toContainText('info@example-tile.invalid');
  });

  test('replies are untrusted and labelled as a rehearsal; small cohorts are suppressed elsewhere too', async ({ page }) => {
    await page.goto(at('outreach/replies', 'editor'));
    await expect(page.getByTestId('replies-untrusted')).toHaveText('Reply text is untrusted: it cannot start any action.');
    await expect(page.getByTestId('replies-rehearsal')).toBeVisible();
    await page.goto(at('outreach/lifecycle', 'editor'));
    await expect(page.getByTestId('journeys')).toContainText('fewer than 10');
    await page.goto(at('outreach/deliverability', 'ops'));
    await expect(page.locator('#rates')).toContainText('fewer than 10');
  });

  test('permissions: suppression is denied to communications staff and absent from their navigation; offline disables forms', async ({ page }) => {
    await page.goto(at('outreach/suppression', 'editor'));
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await page.goto(at('outreach', 'editor'));
    await expect(page.getByRole('navigation', { name: 'Console navigation' }).getByRole('link', { name: 'Suppression and objections' })).toHaveCount(0);
    await page.goto(at('outreach', 'support'));
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await page.goto(`/admin/hubs/samarkand/outreach/suppression?persona=privacy`);
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await page.goto(at('outreach/campaigns', 'editor', 'scenario=offline'));
    await expect(page.getByTestId('admin-offline-band')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });
});

test.describe('OUTR-004 in Spanish', () => {
  test.use({ storageState: state('es') });

  test('no English copy on the screens (data in another language, codes and select options excluded)', async ({ page }) => {
    for (const [path, persona] of PAGES) {
      await page.goto(at(path, persona));
      await expect(page.locator('.admin'), path).toBeVisible();
      const text = await page.evaluate(() => {
        const pageLang = document.documentElement.lang;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        while (walker.nextNode()) {
          const element = walker.currentNode.parentElement;
          if (!element || element.closest('script, style, code, template, select, [data-testid="demo-banner"]')) continue;
          const tagged = element.closest('[lang]');
          if (tagged && tagged !== document.documentElement && tagged.getAttribute('lang') !== pageLang) continue;
          parts.push(walker.currentNode.textContent ?? '');
        }
        return parts.join(' ');
      });
      const english = text.match(/\b(the|and|with|campaign|outreach|suppression|policy|version|request|draft|reply|replies|sender|template|journey|engage|look up|fewer than)\b/gi) ?? [];
      expect(english, `${path}: English copy ${[...new Set(english)].join(', ')}`).toEqual([]);
    }
  });
});

test.describe('OUTR-004 layout and accessibility', () => {
  test.use({ storageState: state('en') });
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ]) {
    test(`axe and no horizontal scroll at ${viewport.width} px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const [path, persona] of PAGES) {
        await page.goto(at(path, persona));
        await axe(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path}: horizontal scroll`).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('OUTR-004 screenshots', () => {
  test.skip(!process.env.TRUSTWORK_E2E_SCREENSHOTS, 'set TRUSTWORK_E2E_SCREENSHOTS=1 to write the PR screenshots');
  test('writes screenshots in English and Spanish at 1280 and 375 px', async ({ page, context }) => {
    const out = resolve('dist/admin-screenshots');
    mkdirSync(out, { recursive: true });
    const shots = [
      ['overview', at('outreach', 'ops')],
      ['policies', at('outreach/policies', 'hub-owner')],
      ['campaign', at('outreach/campaigns/claim-invite-roofing', 'editor')],
      ['suppression', at('outreach/suppression', 'privacy')],
    ] as const;
    for (const locale of ['en', 'es'] as const) {
      await context.addCookies([{ name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/' }]);
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width === 1280 ? 800 : 812 });
        for (const [name, path] of shots) {
          await page.goto(path);
          await page.screenshot({ path: `${out}/outr004-${locale}-${width}-${name}.png`, fullPage: true });
        }
      }
    }
  });
});

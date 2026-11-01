import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AXE_TAGS, hydrated } from '../../helpers.js';

/**
 * HUBC-004 browser suite: participants, support and trust and safety screens on fixtures (demo mode, the main server of
 * apps/web/playwright.config.ts). Acceptance: no impersonation route or control, no control that sets a score or a
 * badge, the case-grant journey with a second approver; plus permissions, suppressed cohorts, Russian without English
 * copy, axe and layout at 1280, 768 and 375 px. English runs with the `en` locale cookie; Russian is the suite default.
 */

const US = '/admin/hubs/us-demo';
const cookie = (name: string, value: string) => ({ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
const english = { cookies: [cookie('trustwork.locale', 'en'), cookie('trustwork.country', 'US')], origins: [] };
const at = (path: string, persona: string, extra = '') => `${US}/${path}?persona=${persona}${extra ? `&${extra}` : ''}`;

/** Every HUBC-004 screen with a persona that may read it. */
const PAGES: ReadonlyArray<readonly [string, string]> = [
  ['participants/people', 'trust-reviewer'],
  ['participants/companies', 'trust-reviewer'],
  ['participants/claims', 'trust-reviewer'],
  ['participants/verification', 'compliance'],
  ['participants/credentials', 'trust-reviewer'],
  ['participants/consents', 'trust-reviewer'],
  ['support', 'support'],
  ['support/accounts/acct-maya', 'support'],
  ['support/companies/co-harbor', 'support'],
  ['support/cases', 'support'],
  ['support/cases/sc-1001', 'support'],
  ['support/recovery', 'support'],
  ['support/explain', 'support'],
  ['trust/moderation', 'trust-reviewer'],
  ['trust/disputes', 'trust-reviewer'],
  ['trust/reputation', 'hub-owner'],
  ['trust/appeals', 'trust-reviewer'],
  ['trust/screening', 'compliance'],
  ['trust/confirmations', 'compliance'],
];

const IMPERSONATION = /imperson|log\s?in as|sign\s?in as|act as (the )?(user|person|participant)|become (the )?(user|person)|switch user|masquerade|войти как|войти под/i;
const SCORE = /score|rank|badge|featured|rating|position/i;

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

test.describe('HUBC-004 in English', () => {
  test.use({ storageState: english });

  test('acceptance 1 and 2: every screen renders on one hub, with no impersonation control and no score or badge field', async ({ page }) => {
    for (const [path, persona] of PAGES) {
      const response = await page.goto(at(path, persona));
      expect(response?.status(), path).toBe(200);
      await expect(page.getByTestId('acts-on'), path).toContainText('Trustwork United States (demo)');
      await expect(page.getByTestId('admin-demo-band'), path).toBeVisible();
      const controls = await page.evaluate(() => [
        ...[...document.querySelectorAll('a[href]')].map((a) => `link ${a.textContent?.trim()} ${a.getAttribute('href')}`),
        ...[...document.querySelectorAll('button')].map((b) => `button ${b.textContent?.trim()}`),
        ...[...document.querySelectorAll('input[name], select[name], textarea[name]')].map((f) => `field ${f.getAttribute('name')}`),
        ...[...document.querySelectorAll('input[name="command"]')].map((f) => `command ${(f as HTMLInputElement).value}`),
      ]);
      expect(controls.filter((c) => IMPERSONATION.test(c)), `${path}: impersonation`).toEqual([]);
      expect(controls.filter((c) => c.startsWith('field ') || c.startsWith('command ')).filter((c) => SCORE.test(c)), `${path}: score or badge`).toEqual([]);
    }
    for (const path of ['support/impersonate', 'support/accounts/acct-maya/login-as', 'support/accounts/acct-maya/session', 'participants/people/pr-maya/edit']) {
      expect((await page.goto(at(path, 'support')))?.status(), path).toBe(404);
    }
  });

  test('acceptance 3: the case-grant journey needs a second approver bound to the request', async ({ page }) => {
    // The support agent asks for a grant on named objects; it goes to a different person.
    await page.goto(at('support/cases/sc-1001', 'support-agent'));
    const request = page.locator('#request-grant');
    await (await hydrated(request.getByLabel('Object ids'))).fill('rfq-7781, inv-7781-2');
    await request.getByLabel('Purpose').fill('Check whether the invitation was delivered');
    await expect(await submit(page, request, 'Ask a different person to approve')).toHaveText(/different support lead for approval/);
    // A grant longer than 72 hours is refused.
    await request.getByLabel('Duration in hours').fill('96');
    await request.getByRole('button', { name: 'Ask a different person to approve' }).click();
    await expect(request.locator('.admin-form__result')).toHaveText('A case grant lasts at most 72 hours.');
    // The agent cannot approve: the decision form is read-only.
    const card = page.getByTestId('grant-request-gr-301');
    await expect(card.getByRole('button', { name: 'Record the decision' })).toBeDisabled();

    // The support lead, a different person, approves the exact request.
    await page.goto(at('support/cases/sc-1001', 'support'));
    const approve = page.getByTestId('grant-request-gr-301');
    await expect(approve).toContainText('Synthetic Support Agent');
    await expect(await submit(page, approve, 'Record the decision')).toHaveText('Demo: changes are not saved.');

    // The lead's own request cannot be approved by the lead.
    await page.goto(at('support/cases/sc-1002', 'support'));
    const own = page.getByTestId('grant-request-gr-302');
    await expect(own.getByTestId('own-grant-request')).toHaveText('You cannot approve your own request.');
    await expect(own.getByRole('button', { name: 'Record the decision' })).toBeDisabled();

    // An expired grant: the objects are not found again; reads stay in the access log.
    await page.goto(at('support/cases/sc-1003', 'support'));
    await expect(page.getByTestId('grant-expired-g-150')).toContainText('not found again');
    await expect(page.getByTestId('access-log')).toContainText('account_recovery: rr-61');
  });

  test('support without impersonation: lookups serve a case, the account card is an allowlist, one\'s own account is closed', async ({ page }) => {
    await page.goto(at('support', 'support', 'by=name&q=maya'));
    await expect(page.getByTestId('lookup-needs-case')).toBeVisible();
    await page.goto(at('support', 'support', 'by=email&q=MAYA%40harbor.example.invalid&case=sc-1001'));
    await expect(page.getByTestId('lookup-logged')).toContainText('sc-1001');
    await expect(page.getByTestId('lookup-results')).toContainText('ma***@harbor.example.invalid');
    await expect(page.locator('#get-q')).toHaveValue('');
    await page.goto(at('support', 'support', 'by=email&q=nobody%40example.invalid&case=sc-1001'));
    await expect(page.getByTestId('lookup-nothing')).toHaveText('Nothing found.');

    await page.goto(at('support/accounts/acct-maya', 'support', 'case=sc-1001'));
    await expect(page.getByTestId('no-impersonation')).toContainText('There is no way to sign in as a participant');
    await expect(page.locator('#summary')).not.toContainText('maya@harbor.example.invalid');
    const service = page.locator('#service');
    await (await hydrated(service.getByLabel('Action'))).selectOption('rebind_recovery_email');
    await expect(await submit(page, service, 'Request the action')).toHaveText('Record the evidence first.');
    await service.getByLabel(/Identity evidence was checked/).check();
    await service.getByRole('button', { name: 'Request the action' }).click();
    await expect(service.locator('.admin-form__result')).toContainText('Rebind a recovery e-mail');
    await page.getByRole('link', { name: 'View the public projection' }).click();
    await expect(page.getByTestId('public-projection')).toContainText('Electrician');

    await page.goto(at('support/accounts/p-support', 'support'));
    await expect(page.getByTestId('own-account')).toHaveText('You cannot service your own account.');
    await expect(page.locator('#service').getByRole('button', { name: 'Request the action' })).toBeDisabled();
    await page.goto(at('support/accounts/acct-erased', 'support'));
    await expect(page.getByTestId('erased-tombstone')).toBeVisible();
    await expect(page.locator('#service')).toHaveCount(0);
    expect((await page.goto(at('support/accounts/acct-unknown', 'support')))?.status()).toBe(404);
  });

  test('recovery: a different approver, a 72-hour cooling-off and objections that cancel', async ({ page }) => {
    await page.goto(at('support/recovery', 'support-agent'));
    await expect(page.getByTestId('recovery-rr-62').getByRole('button', { name: 'Approve' })).toBeDisabled();
    await page.goto(at('support/recovery', 'support'));
    await expect(await submit(page, page.getByTestId('recovery-rr-62'), 'Approve')).toContainText('would take effect on');
    await expect(page.getByTestId('recovery-rr-61').getByRole('button', { name: 'Complete the change' })).toBeDisabled();
    await expect(page.getByTestId('recovery-rr-55').getByTestId('objection')).toBeVisible();
  });

  test('participants and trust guard rails: sanctions block, conflicts, appeals elsewhere, bounded methods, suppressed cohorts', async ({ page }) => {
    await page.goto(at('participants/people', 'trust-reviewer'));
    await expect(page.getByTestId('account-states')).toContainText('fewer than 10');
    await expect(page.getByTestId('public-profiles')).not.toContainText('Private Client');
    await page.goto(at('participants/claims', 'trust-reviewer'));
    await expect(page.getByTestId('claim-cl-202').getByTestId('sanctions-block')).toBeVisible();
    await expect(page.getByTestId('claim-cl-203').getByRole('button', { name: 'Record the decision' })).toBeDisabled();
    await page.goto(at('trust/appeals', 'trust-reviewer'));
    await expect(page.getByTestId('appeal-ap-91').getByTestId('original-decider')).toBeVisible();
    await page.goto(at('trust/reputation', 'trust-reviewer'));
    await expect(page.getByTestId('no-score-control')).toContainText('No control here edits a score');
    const draft = page.locator('#draft');
    await (await hydrated(draft.getByLabel('Window in months'))).fill('120');
    await expect(await submit(page, draft, 'Draft a new version')).toHaveText('This value is outside the allowed range.');
    await expect(page.locator('#review').getByRole('button', { name: 'Release' })).toBeDisabled();
    await page.goto(at('trust/moderation', 'trust-reviewer'));
    const decide = page.locator('#decide');
    await (await hydrated(decide.getByLabel('Decision'))).selectOption('sanction');
    await decide.getByLabel('Sanction level').selectOption('4');
    await expect(await submit(page, decide, 'Decide a case')).toContainText('second-person request');
    await page.goto(at('trust/screening', 'compliance'));
    await expect(page.getByTestId('screening-metrics')).toContainText('fewer than 10');
    await page.goto(`/admin/hubs/samarkand/trust/screening?persona=node-operator`);
    await expect(page.getByTestId('admin-denied')).toBeVisible();
  });

  test('permissions: sections are absent from navigation and denied by address; offline disables every form', async ({ page }) => {
    await page.goto(at('support', 'trust-reviewer'));
    await expect(page.getByTestId('admin-denied')).toContainText('Support lead');
    await expect(page.getByRole('navigation', { name: 'Console navigation' }).getByText('Support', { exact: true })).toHaveCount(0);
    await page.goto(at('trust/moderation', 'support'));
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await page.goto(at('participants/claims', 'trust-reviewer', 'scenario=offline'));
    await expect(page.getByTestId('admin-offline-band')).toBeVisible();
    for (const button of await page.getByRole('button', { name: 'Record the decision' }).all()) await expect(button).toBeDisabled();
  });
});

test.describe('HUBC-004 in Georgian', () => {
  // Russian is not maintained (ADR 009 decision 11) and falls back to English; Georgian is a maintained non-Latin
  // language, so any Latin word on these screens is English copy that escaped the locale files.
  test.use({ storageState: { cookies: [cookie('trustwork.locale', 'ka'), cookie('trustwork.country', 'UZ')], origins: [] } });
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
      const cleaned = text.replace(/\S+@\S+/g, ' ').replace(/\b[a-z0-9]+(?:[.:_-][a-z0-9]+)+\b/g, ' ').replace(/\b[A-Z]{2}(?:-[A-Z0-9]{1,3})?\b/g, ' ').replace(/\b(Trustwork|EIN|SMS|US|UZ|en|es)\b/g, ' ');
      const latin = cleaned.match(/\b[A-Za-z]{3,}\b/g) ?? [];
      expect(latin, `${path}: English copy ${[...new Set(latin)].join(', ')}`).toEqual([]);
    }
  });
});

test.describe('HUBC-004 layout and accessibility', () => {
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

test.describe('HUBC-004 screenshots', () => {
  test.skip(!process.env.TRUSTWORK_E2E_SCREENSHOTS, 'set TRUSTWORK_E2E_SCREENSHOTS=1 to write the PR screenshots');
  test('writes screenshots in English and Russian at 1280 and 375 px', async ({ page, context }) => {
    const out = resolve('dist/admin-screenshots');
    mkdirSync(out, { recursive: true });
    const shots = [
      ['support-case', at('support/cases/sc-1001', 'support')],
      ['support-account', at('support/accounts/acct-maya', 'support', 'case=sc-1001')],
      ['claims', at('participants/claims', 'trust-reviewer')],
      ['reputation', at('trust/reputation', 'hub-owner')],
      ['screening', at('trust/screening', 'compliance')],
    ] as const;
    for (const locale of ['en', 'ru'] as const) {
      await context.addCookies([{ name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/' }]);
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width === 1280 ? 800 : 812 });
        for (const [name, path] of shots) {
          await page.goto(path);
          await page.screenshot({ path: `${out}/hubc004-${locale}-${width}-${name}.png`, fullPage: true });
        }
      }
    }
  });
});

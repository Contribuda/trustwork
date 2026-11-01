import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hydrated, expectNoAxeViolations } from '../../helpers.js';

const base = '/admin/hubs/us-demo';
const at = (path = 'inbox', extra = '') => `${base}/${path}?persona=hub-owner${extra ? `&${extra}` : ''}`;
const evidence = resolve('tests/web/admin/navigation/evidence');
const copy = (tag: string) => JSON.parse(readFileSync(resolve(`apps/web/locales/${tag}/console-navigation.json`), 'utf8')).consoleNav as Record<string, string>;
const en = copy('en');
const languageLabel = (tag: string): string => JSON.parse(readFileSync(resolve(`packages/ui/locales/${tag}.json`), 'utf8')).consoleKit.language;
async function english(page: Page) { await page.context().addCookies([{ name: 'trustwork.locale', value: 'en', domain: '127.0.0.1', path: '/' }]); }
async function ready(page: Page) { await hydrated(page.getByTestId('console-navigation-tools').getByRole('button').first()); }
async function geometry(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('palette private queries route to Support without network queries, history or participant payloads', async ({ page }) => {
  await english(page);
  await page.goto(`${base}/inbox?persona=support`); await ready(page);
  const trigger = page.getByRole('button', { name: en.commands!, exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  for (const value of ['private@example.invalid', 'Synthetic Private Person']) {
    await input.fill(value);
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(dialog.getByRole('option')).toHaveText(en.participantLookup!);
    await expect(dialog).toContainText(en.privacyNote!);
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(input).toHaveValue('');
  await input.fill('private@example.invalid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/support\?persona=support/);
  expect(page.url()).not.toContain('private');
  expect(requests.join('\n')).not.toMatch(/private@example|Synthetic Private Person/);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toMatch(/private@example|Synthetic Private Person/);
  await expect(page.locator('#admin-main')).toContainText(/case/i);
});

test('commands open owning forms, permission filtering and original approvals remain intact', async ({ page }) => {
  await english(page); await page.goto(at()); await ready(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('combobox').fill('> Edit hub identity');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/hub\/identity\?persona=hub-owner#change/);
  await expect(page.locator('#change')).toBeVisible();
  await page.goto(at()); await ready(page);
  await page.getByRole('link', { name: en.legacyApprovals! }).click();
  await expect(page).toHaveURL(/\/approvals\?persona=hub-owner/);
  await page.goto(`${base}/inbox?persona=auditor`); await ready(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('combobox').fill('>');
  await expect(page.getByRole('dialog').getByRole('option')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('combobox').fill('private@example.invalid');
  await expect(page.getByRole('dialog').getByRole('option')).toHaveCount(0);
});

test('shortcuts opt out, remap, ignore editing and IME, and never stack overlays', async ({ page }) => {
  await english(page); await page.goto(at()); await ready(page);
  const reason = page.getByTestId('decision-rq-legal-privacy-2').getByRole('textbox');
  await reason.fill(''); await reason.press('?');
  await expect(reason).toHaveValue('?'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await reason.press('Control+k'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await reason.blur();
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, isComposing: true })));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const intercepted = await page.evaluate(() => {
    const results: boolean[] = [];
    for (const attributes of [{ tag: 'input' }, { tag: 'textarea' }, { tag: 'div', contenteditable: 'true' }, { tag: 'div', role: 'combobox' }]) {
      const element = document.createElement(attributes.tag);
      if (attributes.contenteditable) element.setAttribute('contenteditable', attributes.contenteditable);
      if (attributes.role) element.setAttribute('role', attributes.role);
      document.body.append(element);
      const event = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
      element.dispatchEvent(event); results.push(event.defaultPrevented); element.remove();
    }
    return results;
  });
  expect(intercepted).toEqual([false, false, false, false]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: en.preferences!, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: en.singleKeys! }).focus();
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('checkbox', { name: en.singleKeys! })).not.toBeChecked();
  await page.keyboard.press('Control+k'); await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: en.preferences!, exact: true }).click();
  await dialog.getByText(en.singleKeys!, { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: en.singleKeys! })).toBeChecked();
  await dialog.getByLabel(en.shortcutSet!).selectOption('alternative');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.keyboard.press('h');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
  await page.getByRole('dialog').getByRole('combobox').fill('> Edit hub identity');
  await page.getByRole('dialog').getByRole('combobox').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(page).toHaveURL(/\/inbox\?/);
  await page.keyboard.press('Escape');
});

for (const decision of ['approve', 'decline'] as const) test(`375: simulated ${decision} is distinct from activation and survives refresh without replay`, async ({ page }) => {
  await english(page); await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(at('inbox', 'item=rq-legal-privacy-2')); await ready(page);
  const card = page.getByTestId('decision-rq-legal-privacy-2');
  await expect(card.getByTestId('inbox-field-diff').getByRole('listitem')).not.toHaveCount(0);
  await card.getByRole('textbox').fill('Synthetic reason');
  let sends = 0;
  page.on('request', (request) => { if (request.method() === 'POST') sends++; });
  await card.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Decline', exact: true }).click();
  await expect(card.getByTestId('simulated-decision')).toHaveText(decision === 'approve' ? en.simulatedApproved! : en.simulatedDeclined!);
  await expect(card).toContainText(en.notActivation!);
  expect(sends).toBe(1);
  await page.reload(); await ready(page);
  await expect(card.getByTestId('simulated-decision')).toBeVisible();
  expect(sends).toBe(1);
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await geometry(page); await expectNoAxeViolations(page);
});

test('lost response remains unknown across refresh, then reconciles the same operation without replay', async ({ page }) => {
  await english(page); await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(at('inbox', 'item=rq-legal-privacy-2&demoResult=unknown')); await ready(page);
  const card = page.getByTestId('decision-rq-legal-privacy-2');
  await card.getByRole('textbox').fill('Synthetic reason');
  const mutations: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') mutations.push(request.postData() ?? ''); });
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card.getByRole('button', { name: en.checkResult! })).toBeVisible();
  await expect(card.getByTestId('simulated-decision')).toHaveCount(0);
  const before = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes('synthetic-attempt')));
  await page.reload(); await ready(page);
  await expect(card.getByRole('button', { name: en.checkResult! })).toBeVisible();
  expect(mutations).toHaveLength(1);
  expect(await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes('synthetic-attempt')))).toEqual(before);
  await card.getByRole('button', { name: en.checkResult! }).click();
  await expect(card.getByTestId('simulated-decision')).toHaveText(en.simulatedApproved!);
  expect(mutations).toHaveLength(2);
  expect(mutations.filter((body) => body.includes('operationId'))).toHaveLength(1);
});

test('missing receipt stays unknown after read-only reconciliation and never unlocks a retry', async ({ page }) => {
  await english(page); await page.goto(at('inbox', 'item=rq-legal-privacy-2')); await ready(page);
  const card = page.getByTestId('decision-rq-legal-privacy-2');
  await card.getByRole('textbox').fill('Synthetic transport failure');
  await page.route('**/admin/hubs/us-demo/inbox?*', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed');
    else await route.continue();
  });
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card.getByRole('button', { name: en.checkResult! })).toBeVisible();
  await page.unroute('**/admin/hubs/us-demo/inbox?*');
  await card.getByRole('button', { name: en.checkResult! }).click();
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: en.checkResult! })).toBeVisible();
  await expect(card.getByTestId('simulated-decision')).toHaveCount(0);
});

test('self approval, stale digest, unauthorized deep links and wrong scope fail closed', async ({ page }) => {
  await english(page); await page.goto(at('inbox', 'view=mine&item=rq-role-compliance')); await ready(page);
  const own = page.getByTestId('decision-rq-role-compliance');
  await own.getByRole('textbox').fill('Cannot approve self');
  await expect(own.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await page.goto(at('inbox', 'item=rq-automation-editorial'));
  await expect(page.getByTestId('decision-rq-automation-editorial').getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  for (const item of ['rq-fee-consultation', 'missing-private-item']) {
    await page.goto(at('inbox', `item=${item}`));
    await expect(page.getByText(en.empty!, { exact: true })).toBeVisible();
  }
  await page.goto('/admin/hubs/samarkand/inbox?persona=hub-owner&item=rq-legal-privacy-2');
  await expect(page.getByTestId('admin-denied')).toBeVisible();
  await expect(page.getByTestId('decision-rq-legal-privacy-2')).toHaveCount(0);
});

test('saved views and notification preview remain device-only and reset after identity change', async ({ page }) => {
  await english(page); await page.goto(at('inbox', 'view=mine')); await ready(page);
  await page.getByRole('button', { name: en.saveView! }).click();
  await page.getByRole('button', { name: en.preferences!, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en.notifications!, { exact: true }).selectOption('none');
  await expect(dialog).toContainText(en.notificationsNote!);
  await page.keyboard.press('Escape');
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('trustwork.console.navigation.v1')!));
  expect(prefs.preferences.views).toEqual(['inbox:mine']); expect(prefs.preferences.notifications).toBe('none');
  await page.goto(`${base}/inbox?persona=ops`); await ready(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('trustwork.console.navigation.v1')!).scope)).not.toBe(prefs.scope);
  const next = await page.evaluate(() => JSON.parse(localStorage.getItem('trustwork.console.navigation.v1')!));
  expect(next.preferences.views).toEqual([]); expect(next.preferences.notifications).toBe('all');
});

test('Users uses only owning public projections and case workflow; missing staff/client owners are unavailable', async ({ page }) => {
  await english(page);
  for (const view of ['people', 'companies']) {
    await page.goto(at('users', `view=${view}`)); await ready(page);
    const rows = page.getByTestId('users-public-projection');
    await expect(rows).toBeVisible();
    const hrefs = await rows.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs.every((href) => href?.includes(`/participants/${view}?`) || href === `${base}/support?persona=hub-owner`)).toBe(true);
    await expect(page.locator('#admin-main')).toContainText(en.syntheticRows!);
  }
  await page.goto(at('users', 'view=staff'));
  await expect(page.getByRole('link', { name: en.openStaff! })).toHaveAttribute('href', `${base}/staff?persona=hub-owner`);
  await page.goto(at('users', 'view=clients'));
  await expect(page.locator('#users-clients')).toContainText(en.unavailable!);
  await expect(page.getByRole('link', { name: en.openClient! })).toHaveCount(0);
  await page.goto(`${base}/users?persona=auditor&view=people`);
  await expect(page.getByTestId('users-public-projection')).toHaveCount(0);
});

test('live mode refuses fixture identity and every new route', async ({ request }) => {
  const port = Number(process.env.HUBC020_PORT ?? 43471) + 1;
  for (const route of ['inbox', 'users']) {
    const response = await request.get(`http://127.0.0.1:${port}${at(route)}`);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('data-testid="decision-');
  }
});

test('the actual locale picker switches the whole navigation copy', async ({ page }) => {
  await english(page); await page.goto(at()); await ready(page);
  await page.getByRole('button', { name: en.preferences!, exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: languageLabel('en'), exact: true }).selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('h1')).toHaveText(copy('es').inbox!);
  await expect(page.getByRole('dialog')).toContainText(copy('es').notificationsNote!);
});

for (const width of [1280, 768, 375]) test(`seven locales, axe, geometry, touch targets and screenshots at ${width}`, async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  const observations: unknown[] = [];
  for (const tag of ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) {
    const strings = copy(tag);
    await page.context().addCookies([{ name: 'trustwork.locale', value: tag, domain: '127.0.0.1', path: '/' }]);
    await page.goto(at('inbox', 'item=rq-legal-privacy-2')); await ready(page);
    await expect(page.locator('h1')).toHaveText(strings.inbox!);
    await geometry(page); await expectNoAxeViolations(page);
    await page.locator('h1').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/${tag}-${width}-inbox.png`, fullPage: tag === 'ru' });
    await page.getByRole('button', { name: strings.preferences!, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const language = dialog.getByRole('combobox', { name: languageLabel(tag), exact: true });
    await expect(language.locator('option')).toHaveCount(7);
    await geometry(page); await expectNoAxeViolations(page);
    await page.screenshot({ path: `${evidence}/${tag}-${width}-preferences.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: strings.commands!, exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
    await expect(page.getByRole('dialog').getByRole('option')).not.toHaveCount(0);
    await geometry(page); await expectNoAxeViolations(page);
    await page.screenshot({ path: `${evidence}/${tag}-${width}-palette.png` });
    await page.keyboard.press('Escape');
    const targets = await page.getByTestId('console-navigation-tools').getByRole('button').evaluateAll((buttons) => buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
    expect(targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);
    await page.goto(at('users')); await ready(page); await geometry(page); await expectNoAxeViolations(page);
    observations.push({ tag, width, targets, axeViolations: 0, horizontalOverflow: false });
  }
  writeFileSync(`${evidence}/geometry-${width}.json`, `${JSON.stringify(observations, null, 2)}\n`);
});

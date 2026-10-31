import { expect, test } from '@playwright/test';
import { WEB_ORIGIN } from './ports.js';
import { msg, verifiedAccount } from './support.js';

/**
 * WEB-005 with live data: public pages are rendered per request (each carries its CSP nonce) without reading the
 * visitor; the signed-in visitor's own parts come from `/app/viewer`, which only the visitor's own browser receives
 * (`private, no-store`). A real session must never leak into a public page that the next visitor gets.
 */
test('a signed-in visitor gets the same public page as everybody else; the account comes only from their own /app/viewer', async ({ page, browser }) => {
  const name = `Cache Probe ${Date.now().toString(36)}`;
  await verifiedAccount(page.request, name);

  const response = await page.goto('/ru/companies');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control'], 'a public page is rendered for this request only').toMatch(/no-store/);
  expect(response?.headers()['x-nextjs-cache'], 'and never kept by the server').toBeUndefined();
  expect(response?.headers()['content-security-policy'] ?? '', 'with the per-request nonce policy').toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(await response!.text(), 'the page itself never carries the session').not.toContain(name);
  await expect(
    page
      .locator('header')
      .getByRole('button', { name: msg('shell.account') })
      .first(),
  ).toBeVisible();

  const viewer = await page.request.get('/app/viewer');
  expect(viewer.headers()['cache-control']).toBe('private, no-store');
  expect(viewer.headers().vary).toMatch(/Cookie/);
  expect(((await viewer.json()) as { viewer: { name: string } | null }).viewer?.name).toBe(name);
  expect((await page.request.get('/app/viewer?persona=owner')).status(), 'the demo persona is never read with live data').toBe(200);
  expect(((await (await page.request.get('/app/viewer?persona=owner')).json()) as { viewer: { name: string } | null }).viewer?.name).toBe(name);

  const anonymous = await browser.newContext();
  try {
    const visitor = await anonymous.newPage();
    const second = await visitor.goto(`${WEB_ORIGIN}/ru/companies`);
    expect(await second!.text()).not.toContain(name);
    await expect(
      visitor
        .locator('header')
        .getByRole('link', { name: msg('publicShell.signIn') })
        .first(),
    ).toBeVisible();
    expect(await (await anonymous.request.get(`${WEB_ORIGIN}/app/viewer`)).json()).toEqual({ viewer: null });
  } finally {
    await anonymous.close();
  }
});

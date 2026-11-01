import { test, expect, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ru from '../../../../apps/web/locales/ru/screening.json' with { type: 'json' };

const c = ru.screening.console;
const evidence = process.env.SANC006_EVIDENCE_DIR ?? resolve('dist/sanc006-evidence');
interface Setup { hub: string; subjectId: string; companyId: string; sessions: Record<'first' | 'second' | 'subject' | 'otherStaff', { name: string; value: string }[]> }

test('SANC-006 actual API: subject denied, required reason, second person and responsive accessible console', async ({ browser, request, baseURL }) => {
  const setup = await (await request.get(`http://127.0.0.1:${process.env.SANC006_CONTROL_PORT ?? 4582}/bootstrap`)).json() as Setup;
  const context = async (key: keyof Setup['sessions']): Promise<BrowserContext> => {
    const ctx = await browser.newContext({ baseURL: baseURL!, viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([...setup.sessions[key].map((cookie) => ({ ...cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' as const })),
      { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/' }, { name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/' }]);
    return ctx;
  };
  const first = await context('first'); const second = await context('second'); const subject = await context('subject'); const otherStaff = await context('otherStaff');
  try {
    const base = `/admin/hubs/${setup.hub}/trust/screening`;
    const otherStaffPage = await otherStaff.newPage();
    expect((await otherStaffPage.goto(base))?.status()).toBe(404);
    await expect(otherStaffPage.getByTestId('compliance-panel')).toHaveCount(0);
    const denied = await subject.newPage(); const response = await denied.goto(base);
    expect(response?.status()).toBe(404);
    await expect(denied.locator('.screening-console')).toHaveCount(0);
    expect((await subject.request.get('/v1/admin/screening/queue')).status()).toBe(403);
    const page = await first.newPage();
    await page.goto(base);
    await expect(page.getByRole('heading', { name: c.title, exact: true })).toBeVisible();
    await expect(page.getByText(c.incomplete)).toBeVisible();
    await expect(page.getByText('ofac-sdn', { exact: true })).toBeVisible();
    await expect(page.getByText(c.baseline, { exact: true })).toHaveCount(2);
    await expect(page.getByRole('heading', { name: c.geolocation, exact: true })).toBeVisible();
    await expect(page.getByText(c.modes.fake, { exact: true })).toBeVisible();
    await expect(page.getByText(c.freshnessStates.fresh, { exact: true })).toHaveCount(2);
    await expect(page.getByRole('heading', { name: c.metrics, exact: true })).toBeVisible();
    const baseline = page.getByRole('region', { name: c.lists, exact: true });
    await expect(baseline.locator('button, input, select, textarea')).toHaveCount(0);
    const clearHold = page.locator('form').filter({ has: page.getByRole('button', { name: c.clearHold, exact: true }) });
    await clearHold.getByRole('button').click();
    expect(await clearHold.locator('textarea').evaluate((el: HTMLTextAreaElement) => el.validity.valueMissing)).toBe(true);
    const holds = await (await first.request.get('/v1/admin/jurisdiction/holds')).json() as { items: { id: string; clearedAt: string | null }[] };
    const holdId = holds.items.find((hold) => hold.clearedAt === null)!.id;
    expect((await first.request.post(`/v1/admin/jurisdiction/holds/${holdId}/clear`, { headers: { 'X-Trustwork-Request': '1', origin: baseURL!, 'Idempotency-Key': 'sanc006-empty-hold-reason' }, data: { reason: ' ', evidence: 'document' } })).status()).toBe(422);
    await clearHold.getByLabel(c.reason, { exact: true }).fill('Synthetic travel evidence reviewed');
    await clearHold.getByRole('button').click();
    await expect(page.getByText('Synthetic travel evidence reviewed')).toBeVisible();
    await expect(page.getByRole('button', { name: c.clearHold, exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: new RegExp(setup.subjectId) }).click();
    await expect(page.getByText('Milo Fictivsky', { exact: true })).toBeVisible();
    const proposal = page.locator('form').filter({ has: page.getByRole('button', { name: c.propose, exact: true }) });
    await proposal.getByRole('button').click();
    expect(await proposal.locator('textarea').evaluate((el: HTMLTextAreaElement) => el.validity.valueMissing)).toBe(true);
    await proposal.getByLabel(c.reason, { exact: true }).fill('Synthetic: distinct identity document reviewed');
    await proposal.getByRole('button').click();
    await expect(page.getByText(c.secondRequired, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: c.approve, exact: true })).toBeDisabled();
    const match = await (await first.request.get('/v1/admin/screening/queue')).json() as { items: { subjectStateId: string }[] };
    const stateId = match.items[0]!.subjectStateId;
    const state = await (await first.request.get(`/v1/admin/screening/subjects/${stateId}`)).json() as { matches: { id: string; state: string; pendingApproval: { actionDigest: string } }[]; moneyHeld: boolean };
    expect(state.moneyHeld).toBe(true); expect(state.matches[0]!.state).toBe('pending_second');
    const m = state.matches[0]!;
    const self = await first.request.post(`/v1/admin/screening/matches/${m.id}/proposal-decision`, { headers: { 'X-Trustwork-Request': '1', origin: baseURL!, 'Idempotency-Key': 'sanc006-self-approve' }, data: { decision: 'approve', actionDigest: m.pendingApproval.actionDigest, reason: 'Synthetic self approval must fail' } });
    expect(self.status()).toBe(403); expect((await self.json()).code).toBe('access.second_approver_required');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, 'continuation-screening-ru-desktop.png'), fullPage: true });
    expect((await new AxeBuilder({ page }).include('.screening-console').analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: resolve(evidence, 'continuation-screening-ru-mobile.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    const reviewer = await second.newPage(); await reviewer.goto(`${base}?view=approvals`);
    await reviewer.getByRole('link', { name: new RegExp(setup.subjectId) }).click();
    await reviewer.getByRole('link', { name: c.openParticipant, exact: true }).click();
    await expect(reviewer).toHaveURL(new RegExp(`/participants/people/${setup.subjectId}`));
    await expect(reviewer.getByText(c.participantScope, { exact: true })).toBeVisible();
    await expect(reviewer.getByRole('region', { name: c.lists, exact: true })).toHaveCount(0);
    const approve = reviewer.locator('form').filter({ has: reviewer.getByRole('button', { name: c.approve, exact: true }) });
    await approve.getByLabel(c.reason, { exact: true }).fill('Synthetic independent review of the exact proposal');
    await approve.getByRole('button').click();
    await expect(reviewer.getByRole('heading', { name: c.states.not_same_person, exact: true })).toBeVisible();
    const final = await (await second.request.get(`/v1/admin/screening/subjects/${stateId}`)).json() as { matches: { state: string }[]; moneyHeld: boolean };
    expect(final.matches[0]!.state).toBe('not_same_person'); expect(final.moneyHeld).toBe(false);
    await reviewer.goto(`/admin/hubs/${setup.hub}/participants/compliance/${stateId}`);
    await expect(reviewer.getByTestId('compliance-panel')).toBeVisible();
    expect((await denied.goto(`/admin/hubs/${setup.hub}/participants/compliance/${stateId}`))?.status()).toBe(404);
    for (const [segment, id] of [['people', setup.subjectId], ['companies', setup.companyId]]) {
      const path = `/admin/hubs/${setup.hub}/participants/${segment}/${id}`;
      await reviewer.goto(path);
      await expect(reviewer.getByTestId('compliance-panel')).toBeVisible();
      await expect(reviewer.getByText(c.participantScope, { exact: true })).toBeVisible();
      await expect(reviewer.locator('.admin-demo-band')).toHaveCount(0);
      expect((await denied.goto(path))?.status()).toBe(404);
      expect((await otherStaffPage.goto(path))?.status()).toBe(404);
      await expect(otherStaffPage.getByTestId('compliance-panel')).toHaveCount(0);
      await reviewer.setViewportSize({ width: 375, height: 812 });
      expect(await reviewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page: reviewer }).include('.screening-console').analyze()).violations).toEqual([]);
      await reviewer.screenshot({ path: resolve(evidence, `continuation-${segment}-ru-mobile.png`), fullPage: true });
    }
    await reviewer.goto(base);
    const run = reviewer.locator('form').filter({ has: reviewer.getByRole('button', { name: c.requestRun, exact: true }) });
    await run.getByLabel(c.reason, { exact: true }).fill('Synthetic manual re-screen request'); await run.getByRole('button').click();
    await expect(reviewer.getByRole('heading', { name: c.runStates.queued, exact: true })).toBeVisible();
  } finally { await first.close(); await second.close(); await subject.close(); await otherStaff.close(); }
});

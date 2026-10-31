import { expect, test } from '@playwright/test';

/**
 * WEB-006: the company, person and project pages share one parameterized agent dialog (`PublicAssistant`).
 * Each page opens its own agent from its trigger, answers a starter question from the public brief, keeps the
 * conversation per entity and resets it. Locale-independent: it relies on roles and the dialog's structure.
 */
const PAGES = [
  { kind: 'company', path: '/companies/fasad-primer' },
  { kind: 'person', path: '/people/anna-primerova' },
  { kind: 'project', path: '/projects/shkola-na-reke' },
] as const;

for (const { kind, path } of PAGES) {
  test(`the ${kind} page opens its agent, answers a starter question and resets`, async ({ page }) => {
    await page.goto(path);
    await page.locator('button.cp-ask').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const log = dialog.getByRole('log');
    await expect(log.locator('.cp-msg--agent')).toHaveCount(1);
    const starters = dialog.locator('.cp-chat__starter .cp-chip');
    await expect(starters).toHaveCount(6);
    const question = (await starters.first().textContent())?.trim() ?? '';
    await starters.first().click();
    await expect(log.locator('.cp-msg--user')).toHaveText([question]);
    await expect(log.locator('.cp-msg--agent')).toHaveCount(2);
    await expect(log.locator('.cp-msg--agent').last().locator('.cp-msg__follow .cp-chip').first()).toBeVisible();

    // The conversation persists per entity in sessionStorage under the agent's own key.
    const stored = await page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.includes('agent:')));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(new RegExp(`:${path.split('/').pop()}$`));

    await dialog.locator('.cp-chat__reset').click();
    await expect(log.locator('.cp-msg--user')).toHaveCount(0);
    await expect(starters).toHaveCount(6);
  });
}

test('a trigger opens only the agent of its own kind', async ({ page }) => {
  await page.goto('/people/anna-primerova');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('company-agent:open', { detail: {} })));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('person-agent:open', { detail: {} })));
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('company agent: a resume for a company with several vacancies asks which one, then hands over after sign-in', async ({ page }) => {
  await page.goto('/companies/fasad-primer');
  await page.locator('button.cp-ask').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic') });
  const purposes = dialog.getByRole('radiogroup').getByRole('radio');
  await expect(purposes).toHaveCount(4);
  await purposes.first().click();
  await dialog.locator('.cp-chat__send').click();
  const log = dialog.getByRole('log');
  await expect(log.locator('.cp-files--sent .cp-file')).toHaveCount(1);
  const choices = log.locator('.cp-msg--agent').last().locator('.cp-chip--accent');
  await expect(choices).toHaveCount(3);
  const vacancy = (await choices.first().textContent())?.trim() ?? '';
  await choices.first().click();
  await expect(log.locator('.cp-msg--user').last()).toHaveText(vacancy);
  const login = log.locator('.cp-msg--agent').last().locator('.cp-msg__action--primary');
  await expect(login).toHaveAttribute('href', /^\/login\?next=.*company%3Dfasad-primer%26kind%3Dresume/);
});

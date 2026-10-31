import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { WEB_ORIGIN } from './ports.js';
import {
  COUNTRY_OF,
  LANGUAGES,
  PASSWORD,
  SAME_ORIGIN,
  expectAccessible,
  expectNoHorizontalOverflow,
  mailCount,
  mailToken,
  msg,
  ready,
  setApiClockOffset,
  shot,
  uniqueEmail,
  verifiedAccount,
} from './support.js';

/**
 * WEB-004 live API browser suite: the web app with demo mode off, the real API and a migrated PostgreSQL database
 * (stack.ts). Russian interface (non-English screenshots for the pull request); copy comes from the dictionaries.
 */
const FIXTURES = resolve(import.meta.dirname, '../../../apps/web/fixtures');
const fixtureNames = [
  (JSON.parse(readFileSync(resolve(FIXTURES, 'companies.json'), 'utf8')) as { companies: Array<{ company: { name: string } }> }).companies[0]!.company.name,
  (JSON.parse(readFileSync(resolve(FIXTURES, 'projects.json'), 'utf8')) as { projects: Array<{ project: { name: string } }> }).projects[0]!.project.name,
  (JSON.parse(readFileSync(resolve(FIXTURES, 'people.json'), 'utf8')) as { people: Array<{ person: { displayName: string } }> }).people[0]!.person.displayName,
];

async function sessionCookie(page: Page): Promise<string | undefined> {
  return (await page.context().cookies()).find((c) => c.name.endsWith('sr_session'))?.value;
}

/** Presses Tab until the target has focus (skip link, brand and the back link come first); fails after ten stops. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let stop = 0; stop < 10; stop++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error('the control is not reachable with the keyboard');
}

async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await ready(page);
  await page.getByLabel(msg('auth.email')).fill(email);
  await page.getByLabel(msg('auth.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: msg('auth.submitLogin'), exact: true }).click();
}

test.afterEach(async () => {
  await setApiClockOffset(0);
});

test('sign-up, verification from the mailbox, onboarding, sign-out and sign-in in the browser', async ({ page }) => {
  const email = uniqueEmail('signup');
  await page.goto('/signup');
  await ready(page);
  await expect(page.getByTestId('demo-banner'), 'no demo strip in live mode').toHaveCount(0);
  await page.getByLabel(msg('auth.name')).fill('Дина Строева');
  await page.getByLabel(msg('auth.email')).fill(email);
  await page.getByLabel(msg('auth.password'), { exact: true }).fill(PASSWORD);
  await page.getByText(msg('auth.acceptTermsPrefix')).click();
  await shot(page, '01-signup');
  const [signup] = await Promise.all([page.waitForResponse('**/v1/auth/signup'), page.getByRole('button', { name: msg('auth.submitSignup') }).click()]);
  expect(signup.status()).toBe(202);
  expect(signup.request().headers()['x-trustwork-request']).toBe('1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg('auth.verify.title'));
  await expect(page.getByText(msg('demo.noEmailSent'))).toHaveCount(0);
  expect(await sessionCookie(page), 'no session before e-mail verification').toBeUndefined();
  await shot(page, '02-verify-pending');

  // Resend repeats the sign-up: a second verification message arrives.
  await page.getByRole('button', { name: msg('auth.verify.resend') }).click();
  await expect(page.getByText(msg('auth.verify.resent'))).toBeVisible();
  expect(await mailCount(email)).toBe(2);

  const token = await mailToken(email, 'verify_email');
  await page.goto(`/verify-email/${token}`);
  expect(await sessionCookie(page), 'opening the link changes nothing').toBeUndefined();
  await shot(page, '03-verify-email');
  await page.getByRole('button', { name: msg('auth.verifyEmail.confirm') }).click();
  await expect(page).toHaveURL(/\/onboarding\?created=1$/);
  expect(await sessionCookie(page)).toBeTruthy();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Дина');

  // A spent token is refused with localized copy.
  await page.goto(`/verify-email/${token}`);
  await page.getByRole('button', { name: msg('auth.verifyEmail.confirm') }).click();
  await expect(page.getByText(msg('auth.verifyEmail.invalid'))).toBeVisible();

  await page.goto('/app/settings');
  await expect(page.getByText('Дина Строева').first()).toBeVisible();
  await expect(page.getByText(email).first()).toBeVisible();

  await page.goto('/logout');
  await shot(page, '04-logout');
  await page.getByRole('button', { name: msg('auth.logout.submit') }).click();
  await page.waitForURL(`${WEB_ORIGIN}/`, { timeout: 30_000 });
  expect(await sessionCookie(page)).toBeUndefined();
  await page.goto('/app/projects');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fprojects/);

  // Wrong password: localized message, password cleared, e-mail kept, no code shown.
  await login(page, email, 'a wrong password for sure');
  await expect(page.getByRole('alert').first()).toContainText(msg('error.auth.invalid_credentials'));
  await expect(page.getByText('auth.invalid_credentials')).toHaveCount(0);
  await expect(page.getByLabel(msg('auth.password'), { exact: true })).toHaveValue('');
  await expect(page.getByLabel(msg('auth.email'))).toHaveValue(email);

  await page.getByLabel(msg('auth.password'), { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: msg('auth.submitLogin'), exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test('password recovery through the mailbox ends every session and the old password', async ({ page, browser }) => {
  const { email } = await verifiedAccount(page.request, 'Recovery Person');
  await page.goto(`/recover?email=${encodeURIComponent(email)}`);
  await ready(page);
  await page.getByRole('button', { name: msg('auth.recover.submit') }).click();
  await expect(page.getByText(msg('auth.recover.sent'))).toBeVisible();
  const token = await mailToken(email, 'recovery');
  const fresh = await browser.newContext();
  const reset = await fresh.newPage();
  await reset.goto(`${WEB_ORIGIN}/recover/${token}`);
  await ready(reset);
  await reset.getByLabel(msg('settings.security.newPassword')).fill('a brand new password 2026');
  await reset.getByRole('button', { name: msg('auth.reset.submit') }).click();
  await expect(reset.getByText(msg('auth.reset.success'))).toBeVisible();
  await fresh.close();
  // The earlier session ended with the recovery: the browser still holds the cookie, the workspace says it expired.
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp&reason=expired$/);
  await expect(page.getByText(msg('auth.sessionExpired'))).toBeVisible();
  expect((await page.request.get('/v1/me')).status()).toBe(401);
});

test('company creation, a project and its publication, visible on the public pages', async ({ page, browser }) => {
  await verifiedAccount(page.request, 'Owner Olim');
  const handle = `e2e-${Date.now().toString(36)}`;
  await page.goto('/app/company');
  await ready(page);
  await expect(page.getByRole('heading', { name: msg('company.create.title') })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel(msg('company.create.name')).fill('Стройка Олима');
  await page.getByLabel(msg('company.create.handle')).fill(handle);
  await page.getByLabel(msg('company.create.description')).fill('Строим дома в Ташкенте.');
  await shot(page, '05-company-create');
  await page.getByRole('button', { name: msg('company.create.submit') }).click();
  await expect(page.getByText(msg('status.registered')).first()).toBeVisible();
  await expect(page.getByText('Стройка Олима').first()).toBeVisible();
  await shot(page, '06-company');

  // A second company is refused: one active employer per person.
  const again = await page.request.post('/v1/companies', { headers: { ...SAME_ORIGIN, 'Idempotency-Key': `e2e-${Date.now()}` }, data: { name: 'Second', handle: null, publicDescription: null } });
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe('membership.already_employed');

  await page.goto('/app/projects');
  await page.getByRole('button', { name: msg('projectsWs.create') }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(msg('projectsWs.createForm.name')).fill('Дом у реки');
  await dialog.getByLabel(msg('projectsWs.createForm.summary')).fill('Двухэтажный дом из кирпича.');
  await dialog.getByText(msg('projectsWs.createForm.ownerCompany', 'ru', { name: 'Стройка Олима' })).click();
  await expect(dialog.getByRole('radio', { name: msg('projectsWs.createForm.ownerCompany', 'ru', { name: 'Стройка Олима' }) })).toBeChecked();
  await expectAccessible(page);
  await shot(page, '07-project-create');
  await dialog.getByRole('button', { name: msg('projectsWs.createForm.submit') }).click();
  await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]{36}$/);
  const projectId = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Дом у реки');

  // Private until published: anonymous visitors (country and language chosen, no session) get 404.
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  expect((await visitor.goto(`${WEB_ORIGIN}/projects/${projectId}`))?.status()).toBe(404);

  await page.getByRole('tab', { name: msg('projectsWs.tabs.publication') }).click();
  await page.getByLabel(msg('projectsWs.publish.story')).fill('Начали стены первого этажа.');
  await shot(page, '08-project-publish');
  await page.getByRole('button', { name: msg('projectsWs.publish.submit') }).click();
  await expect(page.getByRole('link', { name: msg('projectsWs.hero.publicPage') })).toBeVisible();

  const publicPage = await visitor.goto(`${WEB_ORIGIN}/projects/${projectId}`);
  expect(publicPage?.status()).toBe(200);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('Дом у реки');
  await expect(visitor.getByText('Начали стены первого этажа.')).toBeVisible();
  await shot(visitor, '09-public-project');
  await visitor.goto(`${WEB_ORIGIN}/projects`);
  await expect(visitor.getByText('Дом у реки').first()).toBeVisible();
  await visitor.goto(`${WEB_ORIGIN}/companies/${handle}`);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('Стройка Олима');
  await expect(visitor.getByText(msg('status.registered')).first()).toBeVisible();
  await visitor.goto(`${WEB_ORIGIN}/companies`);
  await expect(visitor.getByText('Стройка Олима').first()).toBeVisible();
  for (const name of fixtureNames) await expect(visitor.getByText(name)).toHaveCount(0);
  await anonymous.close();
});

test('negative authorization: other people, anonymous visitors, forged requests and the persona switch', async ({ page, browser }) => {
  // Owner A with a private project.
  await verifiedAccount(page.request, 'Owner Aziz');
  const me = (await (await page.request.get('/v1/me')).json()) as { person: { id: string } };
  const project = await page.request.post('/v1/projects', { headers: { ...SAME_ORIGIN, 'Idempotency-Key': `e2e-p-${Date.now()}` }, data: { owner: { kind: 'person', id: me.person.id }, name: 'Private house', summary: null, leaderPersonId: null } });
  expect(project.status()).toBe(201);
  const projectId = ((await project.json()) as { id: string }).id;

  // Person B sees nothing of it.
  const other = await browser.newContext();
  const b = await other.newPage();
  await verifiedAccount(b.request, 'Other Bobur');
  expect((await b.request.get(`/v1/projects/${projectId}`)).status()).toBe(404);
  expect((await b.goto(`${WEB_ORIGIN}/app/projects/${projectId}`))?.status()).toBe(404);
  const publish = await b.request.post(`/v1/projects/${projectId}/publish`, { headers: { ...SAME_ORIGIN, 'Idempotency-Key': `e2e-b-${Date.now()}` }, data: { projectId, publishedStory: 'x', openNeedIds: [], expectedRevision: 1 } });
  expect([403, 404]).toContain(publish.status());
  await b.goto(`${WEB_ORIGIN}/app/projects`);
  await expect(b.getByText('Private house')).toHaveCount(0);
  // B's own project list ignores ?persona=: still B, no demo strip, no fixture rows.
  await b.goto(`${WEB_ORIGIN}/app/settings?persona=owner&scenario=error`);
  await expect(b.getByText('Other Bobur').first()).toBeVisible();
  await expect(b.getByTestId('demo-banner')).toHaveCount(0);
  for (const name of fixtureNames) await expect(b.getByText(name)).toHaveCount(0);
  await other.close();

  // Anonymous: no session, no persona.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  expect((await visitor.request.get('/v1/me')).status()).toBe(401);
  await visitor.goto(`${WEB_ORIGIN}/app?persona=owner`);
  await expect(visitor).toHaveURL(/\/login\?next=%2Fapp$/);
  await visitor.goto(`${WEB_ORIGIN}/app/company?persona=mixed`);
  await expect(visitor).toHaveURL(/\/login\?next=%2Fapp%2Fcompany$/);
  expect((await visitor.goto(`${WEB_ORIGIN}/projects/${projectId}`))?.status()).toBe(404);
  await anon.close();

  // Forged mutations with A's cookie: no CSRF header, a foreign origin, cross-site fetch metadata, extra fields.
  const key = () => ({ 'Idempotency-Key': `e2e-f-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const body = { name: 'Forged company', handle: null, publicDescription: null };
  const noHeader = await page.request.post('/v1/companies', { headers: { Origin: WEB_ORIGIN, ...key() }, data: body });
  expect(noHeader.status()).toBe(403);
  expect((await noHeader.json()).code).toBe('auth.csrf_rejected');
  const foreign = await page.request.post('/v1/companies', { headers: { 'X-Trustwork-Request': '1', Origin: 'https://evil.example', ...key() }, data: body });
  expect((await foreign.json()).code).toBe('auth.csrf_rejected');
  const crossSite = await page.request.post('/v1/companies', { headers: { 'X-Trustwork-Request': '1', 'Sec-Fetch-Site': 'cross-site', ...key() }, data: body });
  expect((await crossSite.json()).code).toBe('auth.csrf_rejected');
  const massAssignment = await page.request.post('/v1/companies', { headers: { ...SAME_ORIGIN, ...key() }, data: { ...body, status: 'verified' } });
  expect(massAssignment.status()).toBe(422);
  expect((await massAssignment.json()).code).toBe('validation.unknown_field');
  const noKey = await page.request.post('/v1/companies', { headers: SAME_ORIGIN, data: body });
  expect(noKey.status()).toBeGreaterThanOrEqual(400);
});

test('a taken company address and other API errors render localized copy, never the code', async ({ page, browser }) => {
  await verifiedAccount(page.request, 'First Founder');
  const handle = `taken-${Date.now().toString(36)}`;
  const first = await page.request.post('/v1/companies', { headers: { ...SAME_ORIGIN, 'Idempotency-Key': `e2e-t-${Date.now()}` }, data: { name: 'First', handle, publicDescription: null } });
  expect(first.status()).toBe(201);

  const ctx = await browser.newContext();
  const second = await ctx.newPage();
  await verifiedAccount(second.request, 'Second Founder');
  await second.goto(`${WEB_ORIGIN}/app/company`);
  await ready(second);
  await second.getByLabel(msg('company.create.name')).fill('Second');
  await second.getByLabel(msg('company.create.handle')).fill(handle);
  await second.getByRole('button', { name: msg('company.create.submit') }).click();
  await expect(second.getByText(msg('company.create.error.handleTaken')).first()).toBeVisible();
  // The corrected submission gets a new idempotency key and succeeds.
  await second.getByLabel(msg('company.create.handle')).fill(`${handle}-two`);
  await second.getByRole('button', { name: msg('company.create.submit') }).click();
  await expect(second.getByText(msg('status.registered')).first()).toBeVisible();
  await expect(second.locator('body')).not.toContainText('validation.');
  await ctx.close();
});

test('sessions: two devices, ending the other session behind step-up, password change', async ({ page, browser }) => {
  const { email } = await verifiedAccount(page.request, 'Session Saida');
  const laptop = await browser.newContext();
  const other = await laptop.newPage();
  await login(other, email);
  await expect(other).toHaveURL(/\/app$/);

  await page.goto('/app/settings');
  await expect(page.getByText(msg('settings.security.currentSession'))).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`^${msg('settings.security.endSession')}:`) })).toHaveCount(1);
  await shot(page, '10-settings-sessions');

  // Older than the step-up window: the API asks for the password again.
  await setApiClockOffset(11 * 60_000);
  await page.getByRole('button', { name: msg('settings.security.endOthers') }).click();
  const dialog = page.getByRole('dialog', { name: msg('settings.stepUp.title') });
  await expect(dialog).toBeVisible();
  const stepUpPassword = dialog.getByRole('textbox', { name: new RegExp(msg('auth.password')) });
  await expect(stepUpPassword).toBeFocused();
  await expectAccessible(page);
  await shot(page, '11-step-up');
  await stepUpPassword.fill('not the password');
  await dialog.getByRole('button', { name: msg('settings.stepUp.confirm') }).click();
  await expect(dialog.getByText(msg('error.auth.invalid_credentials'))).toBeVisible();
  await stepUpPassword.fill(PASSWORD);
  await dialog.getByRole('button', { name: msg('settings.stepUp.confirm') }).click();
  await expect(dialog).toBeHidden();
  const oneEnded = /one \{([^}]*)\}/.exec(msg('settings.security.othersEnded'))![1]!.replace('#', '1');
  await expect(page.getByText(oneEnded)).toBeVisible();
  expect((await other.request.get('/v1/me')).status(), 'the other device is signed out').toBe(401);
  await laptop.close();

  // Password change (fresh step-up from the dialog above): the new password works, the old one does not.
  await page.getByLabel(msg('settings.security.currentPassword')).fill(PASSWORD);
  await page.getByLabel(msg('settings.security.newPassword')).fill('another long password 2026');
  await page.getByRole('button', { name: msg('settings.security.changePassword') }).click();
  await expect(page.getByText(msg('settings.security.passwordChanged'))).toBeVisible();
  const oldLogin = await page.request.post('/v1/auth/login', { headers: SAME_ORIGIN, data: { email, password: PASSWORD } });
  expect(oldLogin.status()).toBe(401);
});

test('every engine language renders the API error in its own words', async ({ browser }) => {
  for (const language of LANGUAGES) {
    const ctx = await browser.newContext({
      storageState: {
        cookies: [
          { name: 'trustwork.country', value: COUNTRY_OF[language], domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
          { name: 'trustwork.locale', value: language, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
        ],
        origins: [],
      },
    });
    const page = await ctx.newPage();
    await page.goto(`${WEB_ORIGIN}/login`);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await ready(page);
    await page.getByLabel(msg('auth.email', language)).fill(uniqueEmail(`lang-${language}`));
    await page.getByLabel(msg('auth.password', language), { exact: true }).fill('some password value');
    await page.getByRole('button', { name: msg('auth.submitLogin', language), exact: true }).click();
    await expect(page.getByRole('alert').first(), language).toContainText(msg('error.auth.invalid_credentials', language));
    await expect(page.locator('body')).not.toContainText('auth.invalid_credentials');
    await ctx.close();
  }
});

test('keyboard, screen reader and narrow-screen checks on the changed screens', async ({ page, browser }) => {
  // Signed-out screens.
  for (const path of ['/login', '/signup', '/recover', '/recover/some-token-0001', '/verify-email/some-token-0001']) {
    await page.goto(path);
    await expectAccessible(page);
  }
  await page.goto('/verify-email/some-token-0001');
  await tabTo(page, page.getByRole('button', { name: msg('auth.verifyEmail.confirm') }));
  await page.keyboard.press('Enter');
  await expect(page.getByText(msg('auth.verifyEmail.invalid'))).toBeVisible();

  // Signed-in screens on a phone.
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  await verifiedAccount(mobile.request, 'Narrow Nodira');
  for (const path of ['/app/company', '/app/projects', '/app/settings', '/logout']) {
    await mobile.goto(`${WEB_ORIGIN}${path}`);
    await expectNoHorizontalOverflow(mobile);
    await expectAccessible(mobile);
  }
  await shot(mobile, '12-logout-phone');
  await mobile.goto(`${WEB_ORIGIN}/logout`);
  await tabTo(mobile, mobile.getByRole('button', { name: msg('auth.logout.submit') }));
  await phone.close();
});

test('with demo mode off, no fixture and no persona reaches any page', async ({ page, browser }) => {
  const publicRoutes = ['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine', '/magazine/archive', '/search?q=fasad'];
  const workspaceRoutes = ['/app', '/app/me', '/app/company', '/app/projects', '/app/procurement', '/app/sales', '/app/publications', '/app/assistant', '/app/notifications', '/app/settings', '/onboarding'];
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  for (const path of publicRoutes) {
    for (const query of ['', `${path.includes('?') ? '&' : '?'}persona=mixed&scenario=error`]) {
      const response = await visitor.goto(`${WEB_ORIGIN}${path}${query}`);
      expect(response?.status(), `${path}${query}`).toBeLessThan(400);
      await expect(visitor.getByTestId('demo-banner'), path).toHaveCount(0);
      await expect(visitor.getByText(msg('error.pageTitle')), `${path}${query} renders without the error boundary`).toHaveCount(0);
      for (const name of fixtureNames) await expect(visitor.getByText(name), `${path}: ${name}`).toHaveCount(0);
    }
  }
  await anonymous.close();

  await verifiedAccount(page.request, 'Crawler Kamola');
  for (const path of workspaceRoutes) {
    const response = await page.goto(`${path}?persona=owner`);
    expect(response?.status(), path).toBeLessThan(400);
    expect(new URL(page.url()).pathname, `${path} stays in the session's workspace`).toBe(path);
    await expect(page.getByText(msg('error.pageTitle')), `${path} renders without the error boundary`).toHaveCount(0);
    for (const name of fixtureNames) await expect(page.getByText(name), `${path}: ${name}`).toHaveCount(0);
  }
});

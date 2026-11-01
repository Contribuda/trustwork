import { expect, test, type Page } from '@playwright/test';
import {
  SAME_ORIGIN,
  STACK_ORIGIN,
  PASSWORD,
  expectAccessible,
  expectNoFixtureData,
  expectNoHorizontalOverflow,
  msg,
  ready,
  shot,
  uniqueEmail,
  verifiedAccount,
  visitorState,
  waitForMail,
  type Language,
} from './support.js';

/**
 * QA-002 platform release journey on the compose stack (release overlay: real SMTP to the sink, explicit jurisdiction
 * gate, demo mode off). One person signs up in the browser, verifies by the link in the mail the worker submitted over
 * SMTP, creates a company, invites a colleague (who accepts with the mailed token), creates a project, publishes it and
 * an anonymous visitor finds the project and the company on the public site of the US hub. Each project of the config
 * runs it in one language at one width; no fixture record may appear anywhere.
 */

const projectTag = (name: string) => name.replace(/[^a-z]/g, '');

test('sign-up, e-mail verification, company, colleague invitation, project publication, public pages', async ({ page, browser }, info) => {
  const language = (info.project.metadata as { language: Language }).language;
  const project = info.project.name;
  const phone = project.endsWith('phone');
  const t = (key: string, params: Record<string, string> = {}) => msg(key, language, params);
  await page.context().addCookies(visitorState(language).cookies);

  const stamp = `${Date.now().toString(36)}${projectTag(project)}`;
  const ownerName = language === 'es' ? 'Rosa Prueba' : 'Riley Release';
  const ownerEmail = uniqueEmail(`owner-${project}`);
  const companyName = language === 'es' ? `Construcciones Prueba ${stamp}` : `Release Builders ${stamp}`;
  const handle = `rc-${stamp}`.slice(0, 40);
  const projectName = language === 'es' ? `Casa de prueba ${stamp}` : `Release test house ${stamp}`;
  const story = language === 'es' ? 'Empezamos los muros de la planta baja.' : 'Ground floor walls are going up.';
  let companyId = '';
  let projectId = '';

  await test.step('sign-up in the browser: no session before verification, no demo strip', async () => {
    const response = await page.goto('/signup');
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await ready(page);
    await expectNoFixtureData(page, '/signup');
    await page.getByLabel(t('auth.name')).fill(ownerName);
    await page.getByLabel(t('auth.email')).fill(ownerEmail);
    await page.getByLabel(t('auth.password'), { exact: true }).fill(PASSWORD);
    // Click the start of the label (the box side): its middle can be the terms link, which leaves the form.
    await page.getByText(t('auth.acceptTermsPrefix')).click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole('checkbox').first()).toBeChecked();
    if (phone) await expectNoHorizontalOverflow(page);
    await shot(page, project, '01-signup');
    const [signup] = await Promise.all([page.waitForResponse('**/v1/auth/signup'), page.getByRole('button', { name: t('auth.submitSignup') }).click()]);
    expect(signup.status()).toBe(202);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('auth.verify.title'));
    expect((await page.context().cookies()).some((c) => c.name.endsWith('sr_session')), 'no session before verification').toBe(false);
  });

  await test.step('the verification mail arrives over SMTP in the visitor language and its link verifies the address', async () => {
    const { mail, link } = await waitForMail(ownerEmail, /^\/verify-email\//);
    expect(mail.language?.split('-')[0]).toBe(language);
    expect(mail.subject, 'a subject in the mail').toBeTruthy();
    expect(link.origin, 'mail links point at the public origin').toBe(STACK_ORIGIN);
    await page.goto(`${link.pathname}${link.search}`);
    expect((await page.context().cookies()).some((c) => c.name.endsWith('sr_session')), 'opening the link alone changes nothing').toBe(false);
    await shot(page, project, '02-verify-email');
    await page.getByRole('button', { name: t('auth.verifyEmail.confirm') }).click();
    await expect(page).toHaveURL(/\/onboarding\?created=1$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ownerName.split(' ')[0]!);
  });

  await test.step('the person creates a company page', async () => {
    await page.goto('/app/company');
    await ready(page);
    await expect(page.getByRole('heading', { name: t('company.create.title') })).toBeVisible();
    await page.getByLabel(t('company.create.name')).fill(companyName);
    await page.getByLabel(t('company.create.handle')).fill(handle);
    await page.getByLabel(t('company.create.description')).fill(story);
    await shot(page, project, '03-company-create');
    const [created] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/v1/companies') && r.request().method() === 'POST'),
      page.getByRole('button', { name: t('company.create.submit') }).click(),
    ]);
    expect(created.status(), await created.text()).toBe(201);
    companyId = ((await created.json()) as { company: { id: string } }).company.id;
    expect(companyId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByText(t('status.registered')).first()).toBeVisible();
    await expect(page.getByText(companyName).first()).toBeVisible();
    if (phone) await expectNoHorizontalOverflow(page);
    await expectNoFixtureData(page, '/app/company');
  });

  const viewport = page.viewportSize();
  const colleagueContext = await browser.newContext({ storageState: visitorState(language), locale: language === 'es' ? 'es-US' : 'en-US', ...(viewport ? { viewport } : {}) });
  const colleague = await colleagueContext.newPage();
  const colleagueName = language === 'es' ? 'Mateo Colega' : 'Casey Colleague';
  const colleagueEmail = uniqueEmail(`colleague-${project}`);

  await test.step('a colleague has a verified account (verified with the link of the mailed message)', async () => {
    await verifiedAccount(colleague.request, colleagueName, language, colleagueEmail);
  });

  await test.step('the owner invites the colleague from the People tab', async () => {
    await page.goto('/app/company');
    await page.getByRole('tab', { name: t('company.tabs.people') }).click();
    const form = page.getByRole('form', { name: t('company.inviteForm.title') });
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute('data-hydrated', '');
    await form.getByLabel(t('auth.email')).fill(colleagueEmail);
    await form.getByText(t('company.permissionLabel.publish')).click();
    await shot(page, project, '04-invite');
    const [invite] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/v1/companies/${companyId}/memberships`) && r.request().method() === 'POST'),
      form.getByRole('button', { name: t('company.inviteForm.submit') }).click(),
    ]);
    expect(invite.status(), await invite.text()).toBe(202);
    await expect(page.getByText(t('company.inviteForm.sent'))).toBeVisible();
  });

  await test.step('the invitation mail arrives over SMTP; the colleague opens the mailed link and accepts on its page', async () => {
    const { mail, link } = await waitForMail(colleagueEmail, /^\/invitations\//);
    expect(link.origin).toBe(STACK_ORIGIN);
    // QA-002 D5: the invitation is written in the invitee's own language (recorded when they verified the address).
    expect(mail.language?.split('-')[0], 'the invitation mail is in the invitee\'s language').toBe(language);
    const [, , membershipId, rawToken] = link.pathname.split('/');
    expect(membershipId).toMatch(/^[0-9a-f-]{36}$/);
    // QA-002 D1 fixed: the mailed link opens the invitation page, which shows the company (checked without spending the
    // token) and accepts with one button; the link needs no company id.
    const opened = await colleague.goto(link.pathname);
    expect(opened?.status()).toBe(200);
    await expect(colleague.getByRole('heading', { level: 1, name: t('auth.invitation.title') })).toBeVisible();
    await expect(colleague.getByText(companyName).first()).toBeVisible();
    await shot(colleague, project, '05a-invitation');
    const [accepted] = await Promise.all([
      colleague.waitForResponse((r) => r.url().endsWith('/v1/invitations/accept') && r.request().method() === 'POST'),
      colleague.getByRole('button', { name: t('auth.invitation.accept') }).click(),
    ]);
    expect(accepted.status(), await accepted.text()).toBe(200);
    await expect(colleague.getByText(t('auth.invitation.accepted', { company: companyName }))).toBeVisible();
    // A second use of the same link is refused, through the page's route and the company route alike.
    const again = await colleague.request.post('/v1/invitations/accept', {
      headers: { ...SAME_ORIGIN, 'Idempotency-Key': `release-accept-again-${stamp}` },
      data: { membershipId, invitationToken: decodeURIComponent(rawToken!) },
    });
    expect(again.status()).toBe(404);
    const viaCompany = await colleague.request.post(`/v1/companies/${companyId}/memberships/accept`, {
      headers: { ...SAME_ORIGIN, 'Idempotency-Key': `release-accept-company-${stamp}` },
      data: { membershipId, invitationToken: decodeURIComponent(rawToken!) },
    });
    expect(viaCompany.status()).toBe(404);
    await colleague.goto('/app/company');
    await expect(colleague.getByText(companyName).first()).toBeVisible();
    await expectNoFixtureData(colleague, 'colleague /app/company');
    await shot(colleague, project, '05-colleague-company');
    const members = await page.request.get(`/v1/companies/${companyId}/memberships`);
    expect(members.status()).toBe(200);
    const { items } = (await members.json()) as { items: Array<{ status: string }> };
    expect(items.filter((m) => m.status === 'active')).toHaveLength(2);
  });
  await colleagueContext.close();

  await test.step('the owner creates a company project; it stays private until published', async () => {
    await page.goto('/app/projects');
    await page.getByRole('button', { name: t('projectsWs.create') }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(t('projectsWs.createForm.name')).fill(projectName);
    await dialog.getByLabel(t('projectsWs.createForm.summary')).fill(story);
    await dialog.getByText(t('projectsWs.createForm.ownerCompany', { name: companyName })).click();
    await expect(dialog.getByRole('radio', { name: t('projectsWs.createForm.ownerCompany', { name: companyName }) })).toBeChecked();
    await shot(page, project, '06-project-create');
    await dialog.getByRole('button', { name: t('projectsWs.createForm.submit') }).click();
    await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]{36}$/);
    projectId = page.url().split('/').pop()!;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(projectName);
    const anonymous = await browser.newContext({ storageState: visitorState(language) });
    expect((await (await anonymous.newPage()).goto(`${STACK_ORIGIN}/projects/${projectId}`))?.status()).toBe(404);
    await anonymous.close();
  });

  await test.step('the owner publishes the project', async () => {
    await page.getByRole('tab', { name: t('projectsWs.tabs.publication') }).click();
    await page.getByLabel(t('projectsWs.publish.story')).fill(story);
    await shot(page, project, '07-project-publish');
    await page.getByRole('button', { name: t('projectsWs.publish.submit') }).click();
    await expect(page.getByRole('link', { name: t('projectsWs.hero.publicPage'), exact: true })).toBeVisible();
  });

  await test.step('an anonymous visitor of the US hub sees the project and the company; no fixture data anywhere', async () => {
    const anonymous = await browser.newContext({ storageState: visitorState(language), ...(viewport ? { viewport } : {}) });
    const visitor = await anonymous.newPage();
    const check = async (path: string) => {
      const response = await visitor.goto(`${STACK_ORIGIN}${path}`);
      expect(response?.status(), path).toBe(200);
      await expect(visitor.locator('html')).toHaveAttribute('lang', language);
      if (phone) await expectNoHorizontalOverflow(visitor);
      await expectNoFixtureData(visitor, path);
    };
    await check(`/projects/${projectId}`);
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(projectName);
    await expect(visitor.getByText(story).first()).toBeVisible();
    // QA-002 D2: the owner is the company, by name and link (no longer "Owner ?").
    await expect(visitor.locator('.pj-owner__name').first()).toHaveText(companyName);
    await expectAccessible(visitor);
    await shot(visitor, project, '08-public-project');
    // Directories page their results; the search field narrows them to the new record.
    await check(`/projects?q=${encodeURIComponent(projectName)}`);
    await expect(visitor.getByText(projectName).first()).toBeVisible();
    await check(`/companies/${handle}`);
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(companyName);
    await expect(visitor.getByText(t('status.registered')).first()).toBeVisible();
    // QA-002 D2: the company page lists its published project.
    await expect(visitor.locator('#projects').getByText(projectName).first()).toBeVisible();
    await expectAccessible(visitor);
    await shot(visitor, project, '09-public-company');
    await check(`/companies?q=${encodeURIComponent(companyName)}`);
    await expect(visitor.getByText(companyName).first()).toBeVisible();
    for (const path of ['/', '/projects', '/companies', '/people', '/news', '/events', `/search?q=${encodeURIComponent('Sample')}`]) await check(path);
    // QA-002 D4: real legal pages; this stack serves no hub, so both say plainly that no version is in force.
    for (const legal of ['terms', 'privacy']) {
      await check(`/legal/${legal}`);
      await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(t(`legal.${legal}.title`));
      await expect(visitor.getByText(t('legal.draftTitle'))).toBeVisible();
    }
    await shot(visitor, project, '10-home');
    await anonymous.close();
  });
});

/** Workspace pages with demo personas requested: still the session's own data, never a fixture. */
test('demo personas and scenarios are ignored with demo mode off', async ({ browser }, info) => {
  const language = (info.project.metadata as { language: Language }).language;
  const context = await browser.newContext({ storageState: visitorState(language) });
  const page: Page = await context.newPage();
  await verifiedAccount(page.request, language === 'es' ? 'Lucia Persona' : 'Pat Persona', language);
  for (const path of ['/app', '/app/me', '/app/company', '/app/projects', '/app/settings']) {
    const response = await page.goto(`${path}?persona=owner&scenario=error`);
    expect(response?.status(), path).toBeLessThan(400);
    expect(new URL(page.url()).pathname, `${path} stays in the session's workspace`).toBe(path);
    await expectNoFixtureData(page, path);
  }
  await context.close();
});

import { expect, test } from '@playwright/test';
import { hydrated } from './helpers.js';

const ready = (page: import('@playwright/test').Page) => page.locator('form[data-hydrated]').first().waitFor();

test.describe('auth and onboarding (fake contract adapter)', () => {
  test('login validation errors render contract codes mapped to Russian', async ({ page }) => {
    await page.goto('/login');
    await ready(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход');
    await page.getByLabel('Электронная почта').fill('не-почта');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('Исправьте ошибки в форме');
    await expect(page.getByText('Проверьте адрес почты').first()).toBeVisible();
    await expect(page.getByText('Введите пароль').first()).toBeVisible();
  });

  test('well-formed login is rejected with auth.invalid_credentials, password cleared, e-mail kept', async ({ page }) => {
    await page.goto('/login');
    await ready(page);
    await page.getByLabel('Электронная почта').fill('demo@example.invalid');
    await page.getByLabel('Пароль', { exact: true }).fill('любой-пароль');
    const [response] = await Promise.all([page.waitForResponse('**/api/auth/login'), page.getByRole('button', { name: 'Войти', exact: true }).click()]);
    expect(response.status()).toBe(401);
    expect((await response.json()).code).toBe('auth.invalid_credentials');
    await expect(page.getByRole('alert').first()).toContainText('Неверная почта или пароль');
    await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Электронная почта')).toHaveValue('demo@example.invalid');
    await expect(page.getByRole('link', { name: 'Забыли пароль?' })).toHaveAttribute('href', /email=demo%40example.invalid/);
  });

  test('signup has one name field, no surname, and ends in the verify-email state without creating anything', async ({ page }) => {
    await page.goto('/signup');
    await ready(page);
    await expect(page.getByLabel('Как вас зовут')).toBeVisible();
    await expect(page.getByText('Фамилия')).toHaveCount(0);
    await expect(page.getByText('ИНН')).toHaveCount(0);
    await page.getByRole('button', { name: 'Создать аккаунт' }).click();
    await expect(page.getByText('Напишите, как к вам обращаться').first()).toBeVisible();
    await expect(page.getByText('Нужно принять условия использования').first()).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveAttribute('aria-describedby', /signup-terms-error/);
    await expect(page.getByRole('link', { name: 'политику конфиденциальности' })).toBeVisible();
    await page.getByLabel('Как вас зовут').fill('Анна');
    await page.getByLabel('Электронная почта').fill('anna@example.invalid');
    await page.getByLabel('Пароль', { exact: true }).fill('короткий');
    await page.getByText('Принимаю').click();
    await page.getByRole('button', { name: 'Создать аккаунт' }).click();
    await expect(page.getByText('Пароль слишком короткий').first()).toBeVisible();
    await page.getByLabel('Пароль', { exact: true }).fill('длинный-пароль-для-демонстрации');
    const [response] = await Promise.all([page.waitForResponse('**/api/auth/signup'), page.getByRole('button', { name: 'Создать аккаунт' }).click()]);
    expect((await response.json()).code).toBe('auth.email_unverified');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Подтвердите почту');
    await expect(page.getByText('письма не отправляются')).toBeVisible();
  });

  test('recovery request shows the neutral confirmation; reset handles invalid tokens and the hold state', async ({ page }) => {
    await page.goto('/recover?email=demo@example.invalid');
    await ready(page);
    await expect(page.getByLabel('Электронная почта')).toHaveValue('demo@example.invalid');
    await page.getByRole('button', { name: 'Отправить ссылку' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Если такая почта' })).toContainText('Если такая почта зарегистрирована');
    await page.goto('/recover/not-a-real-token');
    await expect(page.getByText('Ссылка недействительна.')).toBeVisible();
    await expect(page.getByLabel('Новый пароль')).toHaveCount(0);
    await page.goto('/recover/demo-recovery-token-0001');
    await ready(page);
    await page.getByLabel('Новый пароль').fill('длинный-пароль-для-демонстрации');
    const [response] = await Promise.all([page.waitForResponse('**/api/auth/recover/reset'), page.getByRole('button', { name: 'Сохранить пароль' }).click()]);
    expect((await response.json()).code).toBe('auth.recovery.on_hold');
    await expect(page.getByRole('status').filter({ hasText: 'проверку' })).toContainText('поставлен на проверку');
  });

  test('login keyboard order: brand, back, e-mail, password, toggle, forgot, submit', async ({ page }) => {
    await page.goto('/login');
    await ready(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: / — (на главную|home)$/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'На главную', exact: true }).first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Электронная почта')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Пароль', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Показать пароль' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Забыли пароль?' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeFocused();
  });

  test('onboarding: five optional steps for any industry participant, no company questions', async ({ page }) => {
    await page.goto('/onboarding?persona=reader&created=1');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('кто вы в отрасли');
    await expect(page.getByText('Аккаунт создан')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Пока осмотрюсь' })).toBeVisible();
    await expect(page.getByText('ИНН')).toHaveCount(0);
    // The first step is server-rendered: a choice made before hydration is lost and "Continue" stays on the page.
    // Later steps are client navigations (router.push): wait for the navigation itself, which fetches the next
    // route from the server and can take longer than an assertion's poll window on a loaded machine.
    await (await hydrated(page.getByRole('radio', { name: 'Инженеры и технологи' }))).click();
    await page.getByRole('radio', { name: 'Независимый специалист' }).click();
    await page.getByLabel('Кто вы одной строкой').fill('Инженер стройконтроля');
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await page.waitForURL(/\/onboarding\/goals\?persona=reader$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Что вы хотите делать на платформе?');
    await page.getByRole('checkbox', { name: /Читать и учиться/ }).check();
    await page.getByRole('checkbox', { name: /Закупать/ }).check();
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await page.waitForURL(/\/onboarding\/interests\?persona=reader$/);
    await page.getByRole('checkbox', { name: 'Материалы', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Строительные материалы' }).check();
    await expect(page.getByRole('checkbox', { name: 'Строительные материалы' })).toBeChecked();
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await page.waitForURL(/\/onboarding\/profile\?persona=reader$/);
    await expect(page.getByText('Страница скрыта')).toBeVisible();
    await page.getByText('Показывать мою страницу в разделе «Люди»', { exact: true }).click();
    await expect(page.getByRole('switch', { name: /Показывать мою страницу/ })).toBeChecked();
    await expect(page.getByText('Так вас увидят')).toBeVisible();
    await expect(page.getByText('Инженер стройконтроля').first()).toBeVisible();
    await page.getByRole('button', { name: 'Завершить' }).click();
    await page.waitForURL(/\/onboarding\/done\?persona=reader$/);
    await expect(page.getByText(/Профиль заполнен|начать работать/)).toBeVisible();
    await page.getByRole('link', { name: 'Открыть кабинет' }).click();
    await page.waitForURL(/\/app\?persona=reader$/);
  });

  test('?next= accepts only same-origin relative paths (open redirect)', async ({ page }) => {
    for (const evil of ['//evil.example', '/\\evil.example', '/%5Cevil.example', 'https://evil.example/x', '/\\\\evil.example']) {
      await page.goto(`/login?persona=mixed&next=${encodeURIComponent(evil)}`);
      await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/app\?persona=mixed$/);
    }
    await page.goto('/login?persona=mixed&next=%2Fapp%2Fprojects');
    await expect(page).toHaveURL(/\/app\/projects\?persona=mixed$/);
    await page.goto('/login?next=%2F%2Fevil.example');
    await expect(page.getByRole('link', { name: 'Зарегистрироваться' })).toHaveAttribute('href', '/signup');
  });

  test('auth routes reject requests without the contract header', async ({ request }) => {
    const response = await request.post('/api/auth/login', { data: { email: 'a@b.ru', password: 'x' } });
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe('auth.csrf_rejected');
  });

  test('anonymous /app redirects to login with next', async ({ page }) => {
    await page.goto('/app/projects');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fprojects/);
  });
});

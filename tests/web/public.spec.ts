import { expect, test } from '@playwright/test';
import { PUBLIC_NAV, ROUTES, expectRussianOnly } from './helpers.js';

test.describe('public resource', () => {
  test('home renders the public shell with exactly the seven sections in order', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    const nav = page.getByRole('navigation', { name: 'Разделы' }).first();
    await expect(nav.getByRole('link')).toHaveText([...PUBLIC_NAV]);
    await expect(nav.getByRole('link', { name: 'Главная' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Войти в сервис' }).first()).toBeVisible();
    await expect(page.getByTestId('demo-banner')).toContainText('Демонстрация: синтетические данные');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('footer').getByRole('link', { name: 'Помощь' })).toBeVisible();
  });

  test('the brand font is Golos Text loaded through next/font', async ({ page }) => {
    await page.goto('/');
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family.toLowerCase()).toContain('golos');
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((f) => f.family.toLowerCase().includes('golos') && f.status === 'loaded');
    });
    expect(loaded).toBe(true);
  });

  for (const route of ROUTES.filter((r) => !r.path.startsWith('/app') && !r.path.startsWith('/onboarding'))) {
    test(`${route.name}: Russian copy only`, async ({ page }) => {
      await page.goto(route.path);
      await expectRussianOnly(page);
    });
  }

  test('news list groups items by day and links to the primary source', async ({ page }) => {
    await page.goto('/news');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новости отрасли');
    await expect(page.getByRole('link', { name: /К источнику/ }).first()).toHaveAttribute('rel', /noopener/);
    await page.goto('/news?topic=regulation');
    await expect(page.getByRole('link', { name: 'Новый стандарт на вентилируемые фасады вступит в силу весной' })).toBeVisible();
    await page.goto('/news?q=нетакойновости');
    await expect(page.getByText('По этим условиям ничего не найдено')).toBeVisible();
  });

  test('corrected news shows the correction banner and history', async ({ page }) => {
    await page.goto('/news/standart-ventfasady-vesna');
    await expect(page.locator('.art-correction')).toContainText('Материал исправлен');
    await expect(page.getByRole('heading', { name: 'История изменений' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Первоисточник' })).toBeVisible();
  });

  test('articles filter by format and show the empty state', async ({ page }) => {
    await page.goto('/articles?format=opinion');
    await expect(page.getByText('Пока нет статей в этом формате')).toBeVisible();
    await page.goto('/articles?format=interview');
    await expect(page.getByRole('link', { name: /Интервью: как читать протоколы/ })).toBeVisible();
  });

  test('companies hub labels sourced and claimed records and never shows verified', async ({ page }) => {
    await page.goto('/companies');
    await expect(page.getByText('По открытым источникам').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Заявлено компанией').locator('visible=true').first()).toBeVisible();
    // Evidence facet: the platform's own confirmation is a status filter, never a claim of a real verified company.
    await expect(page.locator('a.ev-facet__item[href*="status=verified"]')).toHaveCount(1);
    await page.goto('/companies/fasad-primer');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Фасад-Пример');
    const main = page.getByRole('main');
    await expect(main).toContainText('Монтаж вентилируемого фасада');
    await expect(main).not.toContainText('Минимальная цена');
    await page.goto('/companies/steklo-demo');
    await expect(page.getByText('Каталог не опубликован.')).toBeVisible();
  });

  test('people hub lists only published profiles; a private profile is 404', async ({ page }) => {
    await page.goto('/people');
    await expect(page.getByRole('link', { name: 'Анна Примерова' })).toBeVisible();
    await expect(page.getByText('Иван Мостов')).toHaveCount(0);
    const response = await page.goto('/people/ivan-mostov');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Страница не найдена')).toBeVisible();
  });

  test('projects hub shows only public projections; a private slug is 404 for anonymous', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByRole('link', { name: 'Школа на набережной: фасад и остекление' }).first()).toBeVisible();
    await expect(page.getByText('Загородный дом')).toHaveCount(0);
    const response = await page.goto('/projects/dacha-petra');
    expect(response?.status()).toBe(404);
    const mixed = await page.goto('/projects/dacha-petra?persona=mixed');
    expect(mixed?.status()).toBe(404);
  });

  test('public project page keeps evidence labels and baseline vs changed milestone dates', async ({ page }) => {
    await page.goto('/projects/shkola-na-reke');
    const main = page.getByRole('main');
    await expect(main).toContainText('План: 31.10.2026');
    await expect(main).toContainText('Перенос по инициативе заказчика');
    await expect(main).toContainText('Оспаривается');
    await expect(main).not.toContainText('Внутренняя сверка бюджета');
  });

  test('magazine: current issue, PDF pending placeholder, corrections, archive and reader', async ({ page }) => {
    await page.goto('/magazine');
    await expect(page.getByText('Свежий выпуск')).toBeVisible();
    await expect(page.getByRole('button', { name: 'PDF готовится' })).toBeDisabled();
    await page.goto('/magazine/12');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Фасады перед зимой');
    await expect(page.getByRole('heading', { name: 'Исправления в выпуске' })).toBeVisible();
    await expect(page.getByText('Уточнена температура применения клеевых составов').first()).toBeVisible();
    await page.goto('/magazine/11');
    await expect(page.getByRole('button', { name: /PDF будет доступен после запуска/ }).first()).toBeDisabled();
    await expect(page.getByRole('link', { name: /Скачать PDF/ })).toHaveCount(0);
    await page.goto('/magazine/archive');
    await expect(page.getByRole('link', { name: 'Фасады перед зимой', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Осень на стройке', exact: true })).toBeVisible();
    const missing = await page.goto('/magazine/99');
    expect(missing?.status()).toBe(404);
    await page.goto('/magazine/12/read');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Фасады зимой');
    await expect(page.getByText('Исправлена нижняя граница', { exact: false }).or(page.getByRole('status').first())).toBeVisible();
    await page.getByRole('button', { name: 'Следующий материал' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Люди недели');
    await expect(page.getByText('2 из 8')).toBeVisible();
    await expect(page).toHaveURL(/#item-2$/);
    const serif = await page.evaluate(() => getComputedStyle(document.querySelector('article')!).fontFamily);
    expect(serif.toLowerCase()).toContain('serif');
  });

  test('magazine preview leafs spreads, keeps #page-N and jumps from the contents menu', async ({ page }) => {
    await page.goto('/magazine');
    const counter = page.locator('.leaf__counter');
    await expect(counter).toHaveText('01–02 / 20');
    await page.getByRole('button', { name: 'Следующие страницы' }).first().click();
    await expect(counter).toHaveText('03–04 / 20', { timeout: 5000 });
    await expect(page).toHaveURL(/#page-3$/);
    await page.getByRole('button', { name: 'Содержание', exact: true }).click();
    await page.getByRole('menuitem', { name: /Цифры недели/ }).click();
    await expect(counter).toHaveText('17–18 / 20', { timeout: 5000 });
    // Deep link: a fresh document load with #page-N opens that spread.
    await page.goto('/');
    await page.goto('/magazine#page-19');
    await expect(counter).toHaveText('19–20 / 20');
    await expect(page.locator('.lp--colophon')).toBeVisible();
  });

  test('reader quiz and reading progress stay in the browser', async ({ page }) => {
    await page.goto('/magazine/12/read');
    await page.getByRole('radio', { name: 'Ниже +5 °C' }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Верно' })).toBeVisible();
    await page.getByRole('button', { name: 'Отметить прочитанным' }).click();
    await expect(page.getByText('Прочитано 1/8')).toBeVisible();
    const stored = await page.evaluate(() => window.localStorage.getItem('trustwork.magazine.12'));
    expect(stored).toContain('"read":[1]');
    await page.goto('/magazine');
    await expect(page.getByText('Прочитано 1/8').first()).toBeVisible();
  });

  test('reader opens the item from a #item-N deep link (issue page and TOC links)', async ({ page }) => {
    await page.goto('/magazine/12/read#item-3');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Как сравнивать предложения');
    await expect(page.getByText('3 из 8')).toBeVisible();
    await page.goto('/magazine/12');
    await page.getByRole('link', { name: 'Люди недели: руководитель проекта о приёмке без споров' }).first().click();
    await expect(page).toHaveURL(/\/magazine\/12\/read#item-2$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Люди недели');
  });

  test('public project status uses the contract wording', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Проекты, за которыми стоит общее дело');
    await expect(page.getByText('Реализуется').first()).toBeVisible();
    await expect(page.getByText('Завершён').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Закрыто')).toHaveCount(0);
  });

  test('unknown routes and /admin are 404', async ({ page }) => {
    expect((await page.goto('/this-route-does-not-exist'))?.status()).toBe(404);
    expect((await page.goto('/admin'))?.status()).toBe(404);
  });

  test('authenticated visitor sees one circular avatar instead of the sign-in link', async ({ page }) => {
    await page.goto('/?persona=mixed');
    const header = page.locator('header').first();
    await expect(header.getByRole('button', { name: 'Аккаунт' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Войти в сервис' })).toHaveCount(0);
    await expect(header.getByText('Анна Примерова')).toHaveCount(0);
    await header.getByRole('button', { name: 'Аккаунт' }).click();
    await expect(page.getByRole('menuitem', { name: 'В рабочее пространство' })).toBeVisible();
  });
});

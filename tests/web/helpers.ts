import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const PUBLIC_NAV = ['Главная', 'Новости', 'Статьи', 'События', 'Компании', 'Люди', 'Проекты', 'Журнал'] as const;
export const WORKSPACE_NAV = ['Обзор', 'Моя страница', 'Компания', 'Проекты', 'Закупки', 'Продажи', 'Публикации', 'Помощник'] as const;

/** Routes rendered in their default state for the axe scan and the Russian-copy check. */
export const ROUTES: ReadonlyArray<{ path: string; name: string }> = [
  { path: '/', name: 'home' },
  { path: '/news', name: 'news' },
  { path: '/news/standart-ventfasady-vesna', name: 'news-detail' },
  { path: '/articles', name: 'articles' },
  { path: '/articles/kak-sravnivat-predlozheniya-fasad', name: 'article-detail' },
  { path: '/companies', name: 'companies' },
  { path: '/companies/fasad-primer', name: 'company' },
  { path: '/companies/beton-obraztsovyi', name: 'company-sourced' },
  { path: '/people', name: 'people' },
  { path: '/people/anna-primerova', name: 'person' },
  { path: '/projects', name: 'projects' },
  { path: '/projects/shkola-na-reke', name: 'project' },
  { path: '/magazine', name: 'magazine' },
  { path: '/magazine/archive', name: 'magazine-archive' },
  { path: '/magazine/12', name: 'issue' },
  { path: '/magazine/12/read', name: 'reader' },
  { path: '/login', name: 'login' },
  { path: '/signup', name: 'signup' },
  { path: '/recover', name: 'recover' },
  { path: '/recover/abc', name: 'recover-invalid' },
  { path: '/recover/demo-recovery-token-0001', name: 'recover-reset' },
  { path: '/onboarding?persona=reader', name: 'onboarding' },
  { path: '/onboarding/goals?persona=reader', name: 'onboarding-goals' },
  { path: '/onboarding/interests?persona=reader', name: 'onboarding-interests' },
  { path: '/onboarding/profile?persona=reader', name: 'onboarding-profile' },
  { path: '/onboarding/done?persona=reader', name: 'onboarding-done' },
  { path: '/app?persona=mixed', name: 'overview-mixed' },
  { path: '/app?persona=reader', name: 'overview-reader' },
  { path: '/app?persona=owner', name: 'overview-owner' },
  { path: '/app/me?persona=mixed', name: 'me' },
  { path: '/app/company?persona=mixed', name: 'company-ws' },
  { path: '/app/company?persona=reader', name: 'company-ws-empty' },
  { path: '/app/projects?persona=mixed', name: 'projects-ws' },
  { path: '/app/projects/project-school?persona=mixed', name: 'project-ws' },
  { path: '/app/procurement?persona=owner', name: 'procurement' },
  { path: '/app/sales?persona=mixed', name: 'sales' },
  { path: '/app/sales?persona=reader', name: 'sales-no-company' },
  { path: '/app/publications?persona=reader', name: 'publications' },
  { path: '/app/assistant?persona=mixed', name: 'assistant' },
  { path: '/app/settings?persona=mixed', name: 'settings' },
  { path: '/app/notifications?persona=mixed', name: 'notifications' },
  { path: '/this-route-does-not-exist', name: 'not-found' },
];

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Tokens that are product-legitimate Latin (brands, formats, identifiers). */
const ALLOWED_LATIN = /\b(PDF|Google|Apple|ID|URL|CC|BY|Enter|Shift|UZ|GE|AM|AZ|UZS|GEL|AMD|AZN|BIM|Word|Excel|Trustwork|TRUSTWORK)\b/g;

export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/** Fails when visible copy contains Latin words (product copy must be Russian). */
export async function expectRussianOnly(page: Page): Promise<void> {
  const text = (await visibleText(page))
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/Фото: [^\n]+/g, ' ')
    .replace(/\b[\w.-]+\.(?:invalid|example|uz|ge|am|az|com|org|net)(?:\/\S*)?/g, ' ')
    .replace(/\S+\.(?:pdf|zip|xlsx|docx|png|jpg)\b/g, ' ')
    .replace(/\bsrcert-\d+\b/g, ' ')
    .replace(ALLOWED_LATIN, ' ');
  const latin = text.match(/\b[A-Za-z]{2,}\b/g) ?? [];
  expect(latin, `English product text found: ${[...new Set(latin)].join(', ')}`).toEqual([]);
  expect(text).toMatch(/[А-Яа-яЁё]{3,}/);
}

export async function expectNoAxeViolations(page: Page): Promise<number> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n');
  expect(results.violations, summary).toEqual([]);
  return results.violations.length;
}

export async function collectPageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

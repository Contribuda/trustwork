import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ROUTES, expectNoAxeViolations } from './helpers.js';

const results: Array<{ route: string; violations: number }> = [];

test.describe('axe-core over every route in its default state (WCAG 2.x A/AA tags)', () => {
  for (const route of ROUTES) {
    test(`${route.name} (${route.path})`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(route.path);
      await page.waitForLoadState('networkidle');
      expect(errors, 'no uncaught page errors').toEqual([]);
      const violations = await expectNoAxeViolations(page);
      results.push({ route: route.path, violations });
    });
  }
});

test.afterAll(({}, testInfo) => {
  mkdirSync('dist/axe', { recursive: true });
  writeFileSync(`dist/axe/worker-${testInfo.workerIndex}.json`, JSON.stringify(results, null, 2));
});

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.STORYBOOK_PORT ?? 6107);

/**
 * Runs accessibility (axe-core) and keyboard tests against the static Storybook build in dist/storybook.
 * `npm run test:a11y -w @trustwork/ui` builds Storybook first; `playwright test` alone reuses an existing build.
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './dist/test-results',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'dist/playwright-report.json' }]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'ru-RU',
    trace: 'off',
  },
  webServer: {
    command: `node tests/serve-static.mjs dist/storybook ${port}`,
    url: `http://127.0.0.1:${port}/index.json`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }, testMatch: /mobile\.spec\.ts/ },
  ],
});

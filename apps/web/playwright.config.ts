import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.TRUSTWORK_E2E_PORT ?? 3459);

/**
 * Browser tests for apps/web (Chromium only; no extra browsers). They run against `next start` of a
 * production build on a loopback port: `npm run build -w @trustwork/web` first, or go through
 * `TRUSTWORK_E2E=1 npm test` at the root (tests/web/web.test.ts builds, picks a free port and runs this).
 */
export default defineConfig({
  testDir: '../../tests/web',
  testMatch: /.*\.spec\.ts/,
  outputDir: './dist/test-results',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 4,
  reporter: [['list'], ['json', { outputFile: 'dist/playwright-report.json' }]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    /* Smooth scrolling makes scroll-into-view clicks flap between frames; browsers honour the reduce preference. */
    reducedMotion: 'reduce',
    // The suites were written against the Russian locale; the engine default is English (ADR-009).
    storageState: {
      cookies: [
        { name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
        { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
      ],
      origins: [],
    },
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: `node ../../node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // These suites exercise the synthetic demo (fixtures and `?persona=`); the live API suite is tests/web/live-api (WEB-004).
    env: { NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_DEMO_MODE: '1' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }, testIgnore: /responsive\.spec\.ts/ },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 }, hasTouch: true }, testMatch: /responsive\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }, testMatch: /responsive\.spec\.ts/ },
  ],
});

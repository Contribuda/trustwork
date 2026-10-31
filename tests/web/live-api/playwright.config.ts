import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { API_ORIGIN, API_PORT, CONTROL_PORT, WEB_ORIGIN, WEB_PORT } from './ports.js';

const repo = resolve(import.meta.dirname, '../../..');
const distDir = process.env.NEXT_DIST_DIR ?? '.next-live';

/**
 * Live API browser suite (WEB-004): the web app with demo mode off against the real API and a migrated PostgreSQL
 * database (stack.ts). Build the web app first with the rewrite pointing at this API, from apps/web:
 *
 *   NEXT_DIST_DIR=.next-live TRUSTWORK_API_ORIGIN=http://127.0.0.1:3471 npx next build --webpack
 *   NEXT_DIST_DIR=.next-live npx playwright test -c ../../tests/web/live-api/playwright.config.ts
 *
 * One worker: the suite moves the API clock (step-up) and the mailbox is shared.
 */
export default defineConfig({
  // WEB-002 adds the commerce journeys in tests/web/commerce next to this suite (same stack, same build).
  testDir: '..',
  testMatch: /(?:live-api|commerce)\/.*\.e2e\.ts$/,
  outputDir: resolve(repo, 'apps/web/dist/live-results'),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: resolve(repo, 'apps/web/dist/live-report.json') }]],
  timeout: 90_000,
  // The shared development machine renders slowly at times; CI is faster.
  expect: { timeout: 15_000 },
  use: {
    baseURL: WEB_ORIGIN,
    locale: 'ru-RU',
    timezoneId: 'Asia/Tashkent',
    reducedMotion: 'reduce',
    storageState: {
      cookies: [
        { name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
        { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
      ],
      origins: [],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx tests/web/live-api/stack.ts',
      cwd: repo,
      url: `${API_ORIGIN}/health/ready`,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'pipe',
      env: { TRUSTWORK_LIVE_API_PORT: String(API_PORT), TRUSTWORK_LIVE_CONTROL_PORT: String(CONTROL_PORT), TRUSTWORK_LIVE_WEB_PORT: String(WEB_PORT) },
    },
    {
      command: `node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port ${WEB_PORT}`,
      cwd: repo,
      url: `${WEB_ORIGIN}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
      // Demo mode off (the default): the app reads the live API through the same-origin rewrite.
      env: { NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: distDir, TRUSTWORK_API_ORIGIN: API_ORIGIN, TRUSTWORK_DEMO_MODE: '0' },
    },
  ],
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});

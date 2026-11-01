import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
const repo = resolve(import.meta.dirname, '../../../..');
export default defineConfig({
  testDir: '.', testMatch: 'pricing.e2e.ts', workers: 1, retries: 0, fullyParallel: false, timeout: 60000,
  outputDir: resolve(repo, 'apps/web/dist/bill003-results'),
  reporter: [['list'], ['json', { outputFile: resolve(repo, 'apps/web/dist/bill003-report.json') }]],
  use: { baseURL: 'http://127.0.0.1:3540', locale: 'ru-RU', timezoneId: 'UTC', reducedMotion: 'reduce',
    storageState: { cookies: [{ name: 'trustwork.country', value: 'US', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] },
    viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'node --import tsx tests/billing/fees/browser/stack.mjs', cwd: repo, url: 'http://127.0.0.1:3542', timeout: 180000, reuseExistingServer: false,
      env: { TRUSTWORK_TEST_PG_BACKEND: 'embedded', TRUSTWORK_REQUIRE_PG: '1', TSX_TSCONFIG_PATH: 'apps/web/tsconfig.json' } },
    { command: 'node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port 3540', cwd: repo,
      url: 'http://127.0.0.1:3540/ru/pricing', timeout: 120000, reuseExistingServer: false,
      env: { NEXT_DIST_DIR: '.next-bill003', TRUSTWORK_API_ORIGIN: 'http://127.0.0.1:3541', TRUSTWORK_DEMO_MODE: '0', NEXT_TELEMETRY_DISABLED: '1' } },
  ],
});

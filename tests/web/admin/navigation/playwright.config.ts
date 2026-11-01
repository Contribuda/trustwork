import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const port = Number(process.env.HUBC020_PORT ?? 43471);
// Tells the live-mode test that this config started the second (live) server; the main web suite does not.
process.env.HUBC020_LIVE_SERVER = String(port + 1);
const livePort = port + 1;
export default defineConfig({
  testDir: '..',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  outputDir: `${root}/apps/web/dist/hubc020-results`,
  reporter: [['list'], ['json', { outputFile: `${root}/apps/web/dist/hubc020-report.json` }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    actionTimeout: 15_000, browserName: 'chromium', viewport: { width: 1280, height: 800 },
    locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce',
    storageState: { cookies: [
      { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
      { name: 'trustwork.country', value: 'US', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
    ], origins: [] },
  },
  webServer: [
    { command: `node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port ${port}`, cwd: root, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, env: { NEXT_DIST_DIR: '.next-hubc020', NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_DEMO_MODE: '1', TRUSTWORK_DEFAULT_COUNTRY: 'US' } },
    { command: `node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port ${livePort}`, cwd: root, url: `http://127.0.0.1:${livePort}`, reuseExistingServer: false, env: { NEXT_DIST_DIR: '.next-hubc020', NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_DEMO_MODE: '0', TRUSTWORK_DEFAULT_COUNTRY: 'US' } },
  ],
});

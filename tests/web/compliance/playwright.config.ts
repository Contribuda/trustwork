import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const repo = resolve(import.meta.dirname, '../../..');
export default defineConfig({
  testDir: '.', testMatch: /.*\.e2e\.ts$/, workers: 1, retries: 0, fullyParallel: false, timeout: 90_000,
  outputDir: resolve(repo, 'apps/web/dist/sanc007-results'),
  reporter: [['list'], ['json', { outputFile: resolve(repo, 'apps/web/dist/sanc007-browser.json') }]],
  use: { baseURL: 'http://127.0.0.1:3586', viewport: { width: 1280, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node --import tsx tests/web/compliance/stack.ts', cwd: repo, url: 'http://127.0.0.1:4587/ready', timeout: 120_000, reuseExistingServer: false },
    { command: 'node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port 3586', cwd: repo,
      url: 'http://127.0.0.1:3586/login', timeout: 120_000, reuseExistingServer: false,
      env: { NEXT_DIST_DIR: '.next-sanc007', NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_API_ORIGIN: 'http://127.0.0.1:3587', TRUSTWORK_DEMO_MODE: '0',
        TRUSTWORK_JURISDICTION_GATE: 'edge_header', TRUSTWORK_JURISDICTION_COUNTRY_HEADER: 'X-Sanc007-Country' } },
  ],
});

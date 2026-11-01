import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
const repo = resolve(import.meta.dirname, '../../../..');
const web = Number(process.env.SANC006_WEB_PORT ?? 3580);
const api = Number(process.env.SANC006_API_PORT ?? 3581);
const control = Number(process.env.SANC006_CONTROL_PORT ?? 4582);
const origin = `http://127.0.0.1:${web}`;
export default defineConfig({
  testDir: '.', testMatch: /screening\.e2e\.ts$/, workers: 1, retries: 0, fullyParallel: false, timeout: 90_000,
  expect: { timeout: 20_000 }, reporter: [['list']], outputDir: resolve(repo, 'apps/web/dist/sanc006-results'),
  use: { baseURL: origin, viewport: { width: 1280, height: 900 }, locale: 'ru-RU', timezoneId: 'America/Los_Angeles', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node --import tsx tests/web/admin/screening/stack.ts', cwd: repo, url: `http://127.0.0.1:${control}/bootstrap`, timeout: 240_000, reuseExistingServer: false, env: { SANC006_WEB_PORT: String(web), SANC006_API_PORT: String(api), SANC006_CONTROL_PORT: String(control) } },
    { command: `node node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port ${web}`, cwd: repo, url: `${origin}/login`, timeout: 120_000, reuseExistingServer: false,
      env: { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next-sanc006', NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_DEMO_MODE: '0', TRUSTWORK_API_ORIGIN: `http://127.0.0.1:${api}` } },
  ],
});

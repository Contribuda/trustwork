import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Platform release journey (QA-002) against a running compose stack with the release overlay. It starts no server:
 * `node tests/release/platform/run.mjs` builds and starts the stack, runs this suite from apps/web and stops the stack.
 * By hand, with the stack already up:
 *
 *   TRUSTWORK_STACK_ORIGIN=http://localhost:8391 TRUSTWORK_RELEASE_MAIL_READER=http://127.0.0.1:8392 \
 *     npx playwright test -c ../../tests/release/platform/playwright.config.ts
 *
 * Four projects: English and Spanish, each at desktop and phone width. The gates spec (headers, CSP, jurisdiction,
 * readiness) runs once, in the desktop English project. One worker: the projects share one stack and one mail sink.
 */
const origin = (process.env.TRUSTWORK_STACK_ORIGIN ?? 'http://localhost:8080').replace(/\/$/, '');
const out = resolve(import.meta.dirname, 'dist');

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };
const phone = { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } };

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  outputDir: resolve(out, 'results'),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: resolve(out, 'report.json') }]],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: origin,
    timezoneId: 'America/Los_Angeles',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'en-desktop', use: { ...desktop, locale: 'en-US' }, metadata: { language: 'en' } },
    { name: 'en-phone', use: { ...phone, locale: 'en-US' }, metadata: { language: 'en' }, testIgnore: /gates\.e2e\.ts$/ },
    { name: 'es-desktop', use: { ...desktop, locale: 'es-US' }, metadata: { language: 'es' }, testIgnore: /gates\.e2e\.ts$/ },
    { name: 'es-phone', use: { ...phone, locale: 'es-US' }, metadata: { language: 'es' }, testIgnore: /gates\.e2e\.ts$/ },
  ],
});

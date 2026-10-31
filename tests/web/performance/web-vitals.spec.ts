import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * WEB-005 acceptance "mobile performance budgets pass in CI for the home, news and company templates". Each template is
 * loaded like a phone on a slow network (Lighthouse's mobile profile: 412 x 823 at 1.75x, 150 ms round trip, 1.6 Mbit/s
 * down, 0.75 Mbit/s up, CPU slowed four times) from the production build, after one warm-up request. The browser's
 * own Web Vitals entries give LCP, CLS and the long tasks for TBT; resource timing gives the
 * compressed bytes of the document, its stylesheets and its scripts. Budgets live in budgets.json next to this file:
 * the byte budgets catch weight regressions exactly, the timing budgets catch what the bytes do to a phone.
 */
type Metrics = { lcp: number; cls: number; tbt: number; fcp: number; documentBytes: number; cssBytes: number; jsBytes: number };
type Budget = { lcpMs: number; cls: number; tbtMs: number; fcpMs: number; documentKiB: number; cssKiB: number; jsKiB: number };
const budgets = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8')) as { templates: Record<string, { path: string; budget: Budget }> };

// A returning visitor who has chosen a country, in English: the template itself, without the first-visit window. The
// templates are the example hub's records (Uzbekistan, DEMO-US), so the numbers compare with the measurement before WEB-005.
const COOKIES = [
  { name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  { name: 'trustwork.locale', value: 'en', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
];
test.use({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true, locale: 'en-US', storageState: { cookies: COOKIES, origins: [] } });

/** Collects Web Vitals entries from the first paint on (installed before any page script runs). */
const OBSERVER = `
  window.__vitals = { lcp: 0, cls: 0, longTasks: [], fcp: 0 };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__vitals.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__vitals.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__vitals.longTasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') window.__vitals.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
`;

async function measure(page: Page, path: string): Promise<Metrics> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // Every load is a first visit: nothing from the browser cache. Each page is rendered for this request (CSP nonce).
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(OBSERVER);
  await page.goto(path, { waitUntil: 'load' });
  // LCP candidates stop at the first input; without input they settle once the page is idle.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const metrics = await page.evaluate(() => {
    const vitals = (window as unknown as { __vitals: { lcp: number; cls: number; longTasks: Array<[number, number]>; fcp: number } }).__vitals;
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    // Total blocking time between first contentful paint and the end of the load (Lighthouse uses time to interactive).
    const end = Math.max(navigation.loadEventEnd, vitals.lcp) + 1000;
    const tbt = vitals.longTasks.filter(([start]) => start >= vitals.fcp && start <= end).reduce((sum, [, duration]) => sum + Math.max(0, duration - 50), 0);
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const bytes = (test: (r: PerformanceResourceTiming) => boolean) => resources.filter(test).reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize), 0);
    return {
      lcp: vitals.lcp,
      cls: vitals.cls,
      tbt,
      fcp: vitals.fcp,
      documentBytes: navigation.transferSize || navigation.encodedBodySize,
      cssBytes: bytes((r) => r.initiatorType === 'link' && /\.css(?:$|\?)/.test(r.name)),
      jsBytes: bytes((r) => r.initiatorType === 'script' || /\/_next\/static\/chunks\/.+\.js(?:$|\?)/.test(r.name)),
    };
  });
  await cdp.detach();
  return metrics;
}

/** Timing metrics are the median of three loads (each in a fresh page): the browser job shares its CPU with other workers. */
const RUNS = 3;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

for (const [name, { path, budget }] of Object.entries(budgets.templates)) {
  test(`mobile budget: ${name} template (${path})`, async ({ context, request }) => {
    test.setTimeout(180_000);
    expect((await request.get(path)).status(), 'warm-up request').toBe(200);
    const runs: Metrics[] = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await context.newPage();
      runs.push(await measure(page, path));
      await page.close();
    }
    const m: Metrics = {
      lcp: median(runs.map((r) => r.lcp)),
      cls: median(runs.map((r) => r.cls)),
      tbt: median(runs.map((r) => r.tbt)),
      fcp: median(runs.map((r) => r.fcp)),
      documentBytes: median(runs.map((r) => r.documentBytes)),
      cssBytes: median(runs.map((r) => r.cssBytes)),
      jsBytes: median(runs.map((r) => r.jsBytes)),
    };
    const kib = (n: number) => Math.round((n / 1024) * 10) / 10;
    const report = `${name} (median of ${RUNS}): LCP ${Math.round(m.lcp)} ms, CLS ${m.cls.toFixed(3)}, TBT ${Math.round(m.tbt)} ms, FCP ${Math.round(m.fcp)} ms, document ${kib(m.documentBytes)} KiB, CSS ${kib(m.cssBytes)} KiB, JS ${kib(m.jsBytes)} KiB`;
    console.log(report);
    test.info().annotations.push({ type: 'web-vitals', description: report });
    expect.soft(m.lcp, `${report}\nLCP budget ${budget.lcpMs} ms`).toBeLessThanOrEqual(budget.lcpMs);
    expect.soft(m.lcp, 'a largest contentful paint was observed').toBeGreaterThan(0);
    expect.soft(m.cls, `CLS budget ${budget.cls}`).toBeLessThanOrEqual(budget.cls);
    expect.soft(m.tbt, `TBT budget ${budget.tbtMs} ms`).toBeLessThanOrEqual(budget.tbtMs);
    expect.soft(m.fcp, `FCP budget ${budget.fcpMs} ms`).toBeLessThanOrEqual(budget.fcpMs);
    expect.soft(kib(m.documentBytes), `document budget ${budget.documentKiB} KiB (compressed transfer)`).toBeLessThanOrEqual(budget.documentKiB);
    expect.soft(kib(m.cssBytes), `stylesheet budget ${budget.cssKiB} KiB`).toBeLessThanOrEqual(budget.cssKiB);
    expect.soft(kib(m.jsBytes), `script budget ${budget.jsKiB} KiB`).toBeLessThanOrEqual(budget.jsKiB);
  });
}

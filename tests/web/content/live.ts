/** CNT-003 bounded live acceptance: real PostgreSQL/API/DataPort, local Next and Chromium; synthetic content only. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPool, type DataPool } from '@trustwork/data';
import { HandlerRegistry, Worker } from '@trustwork/worker';
import { registerContent } from '../../../apps/worker/src/content/index.js';
import { renderLocalPdf } from '../../../apps/worker/src/content/render.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { startHarness } from '../../backend/helpers/app.js';
import { buildContentHttpWorld, consoleCommand } from '../../content/http.js';
import { credit, draft } from '../../content/helpers.js';
import { publications, issues } from '../../../packages/data/src/repositories/content.js';

const evidence = process.env.CNT003_EVIDENCE_DIR;
assert.ok(evidence, 'CNT003_EVIDENCE_DIR is required');
const h = await startHarness('cnt003_live'); assert.ok(h);
const world = await buildContentHttpWorld(h), { w } = world, p = w.people;
let server: ReturnType<typeof spawn> | undefined;
let worker: Worker | undefined, workerPool: DataPool | undefined;
const workerRole = `cnt003_browser_${randomBytes(6).toString('hex')}`;
let livePdf: Buffer | undefined;
const browser = await chromium.launch({ headless: true });
try {
  const ctxA = await w.act.elevate(p.editorA), ctxC = await w.act.elevate(p.chief);
  const make = async (format: 'article' | 'news', title: string, publish: boolean) => {
    let row = await w.act.as(p.writer, trx => publications.create(trx, null, { hubId: w.hubId, owner: { kind: 'person' }, format, articleFormat: format === 'article' ? 'practice' : null, language: 'ru', licence: 'cc_by', requiresReview: false,
      draft: draft({ title, body: 'Synthetic construction report. <img src="http://127.0.0.1:1/private" onerror="alert(1)">\n\nSynthetic findings, reviewed by the credited author.', language: 'ru', assistantAssisted: true,
        eventTime: format === 'news' ? '2026-11-01T00:00:00.000Z' : null,
        sourceRefs: format === 'news' ? [{ name: 'Synthetic field reporting', uri: 'https://example.invalid/field-notes', kind: 'own_reporting', observedAt: '2026-11-01T00:00:00.000Z' }] : [] }), authorship: credit(p.writer, 'Synthetic Writer') }));
    if (publish) row = await w.act.as(p.writer, trx => publications.publish(trx, null, row.id, row.revision, null));
    return row;
  };
  let article = await make('article', 'Synthetic: insulation practice', true);
  article = await w.act.as(p.writer, trx => publications.correct(trx, null, article.id, article.revision, draft({ title: 'Synthetic: corrected insulation practice', body: 'Synthetic corrected construction report.\n\n<script>window.unsafeContent = true</script>', language: 'ru', assistantAssisted: true }), 'Synthetic correction: insulation thickness updated.', 'correction'));
  const news = await make('news', 'Synthetic: construction field report', true);
  const hidden = await make('article', 'Synthetic PRIVATE draft marker', false);
  const version = (await w.act.as(p.writer, trx => publications.versions(trx, article.id))).find(v => v.version === 2)!;
  let issue = await w.act.as(p.editorA, trx => issues.create(trx, ctxA, { hubId: w.hubId, number: 1, date: '2026-11-01', theme: 'Synthetic: construction practice', coverAssetId: null, editorLetterId: null }));
  issue = await w.act.as(p.editorA, trx => issues.curate(trx, ctxA, issue.id, issue.revision, { items: [{ position: 1, section: 'practice', publicationId: article.id, publicationVersionId: version.id }], theme: null, coverAssetId: null, editorLetterId: null }));
  issue = await w.act.as(p.editorA, trx => issues.transition(trx, ctxA, issue.id, issue.revision, 'curated'));
  issue = await w.act.as(p.editorA, trx => issues.transition(trx, ctxA, issue.id, issue.revision, 'review'));
  await w.act.as(p.chief, trx => issues.release(trx, ctxC, issue.id, issue.revision));
  const password = randomBytes(18).toString('hex');
  await h.db.admin.query(`CREATE ROLE ${workerRole} LOGIN PASSWORD '${password}' IN ROLE trustwork_worker`);
  workerPool = createPool({ ...h.db.appConfig, user: workerRole, password, max: 3 });
  const registry = new HandlerRegistry();
  registerContent(registry, async (snapshot, signal) => { livePdf = await renderLocalPdf(snapshot, signal); return livePdf; });
  worker = new Worker({ pool: workerPool, registry, config: { workerId: 'cnt003-browser', concurrency: 1, relayBatchSize: 500 }, tasks: () => [], log: () => {} });
  await world.elevate('editorA');
  const requested = await consoleCommand(world.c.editorA, `/v1/admin/content/issues/${issue.id}/renders`, { edition: 1, format: 'pdf' });
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  await worker.runOnce({ rethrow: true }); await worker.idle();
  assert.ok(livePdf, 'real worker must produce the live browser artifact');
  await mkdir(evidence, { recursive: true }); await writeFile(`${evidence}/issue-live-ru.pdf`, livePdf);
  // Local, explicitly configured deployment; synthetic participants never leave this database.
  await world.app.app.listen(3467, '127.0.0.1');
  server = spawn(process.execPath, ['../../node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3468'], {
    cwd: 'apps/web', env: { ...process.env, TRUSTWORK_DEMO_MODE: '', TRUSTWORK_API_ORIGIN: 'http://127.0.0.1:3467', TRUSTWORK_DEFAULT_COUNTRY: 'UZ', TRUSTWORK_SITE_URL: 'http://127.0.0.1:3468', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = ''; server.stdout?.on('data', b => { serverLog += b; }); server.stderr?.on('data', b => { serverLog += b; });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await fetch('http://127.0.0.1:3468/ru/news').then(r => r.ok).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await mkdir(evidence, { recursive: true });
  const results: object[] = [];
  for (const locale of ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/' }, { name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    const errors: string[] = []; const external: string[] = [];
    page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`));
    await page.route('**/*', route => { const u = new URL(route.request().url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) { external.push(u.origin); return route.abort(); } return route.continue(); });
    for (const [route, surface] of [['/news', 'news'], [`/news/${news.id}`, 'news-detail'], ['/articles', 'articles'], [`/articles/${article.id}`, 'article'], ['/magazine', 'magazine'], ['/magazine/1', 'issue'], ['/magazine/archive', 'archive'], ['/magazine/rubric/practice', 'rubric'], ['/magazine/1/read', 'reader']] as const) {
      const response = await page.goto(`http://127.0.0.1:3468/${locale}${route}`, { waitUntil: 'networkidle' });
      assert.equal(response?.status(), 200, `${locale}${route}: ${serverLog.slice(-2000)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${locale}${route}: horizontal overflow`);
      assert.equal(await page.locator('body').innerText().then(s => s.includes('PRIVATE draft marker')), false);
      assert.equal(await page.evaluate(() => (window as unknown as { unsafeContent?: boolean }).unsafeContent), undefined);
      assert.equal(await page.getByRole('dialog').count(), 0, 'country gate must not mask reader acceptance');
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      await writeFile(`${evidence}/${locale}-${surface}-axe.json`, JSON.stringify(axe.violations, null, 2));
      await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement !== document.body), 'keyboard focus enters the page');
      const name = `${locale}-${surface}-375.png`;
      await page.screenshot({ path: `${evidence}/${name}`, fullPage: true });
      if (surface === 'reader') {
        await page.locator('.mgr__ctl--toc').focus(); await page.keyboard.press('Enter');
        await page.getByRole('dialog').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]'));
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
      if (locale === 'ru' && surface === 'reader') {
        await page.setViewportSize({ width: 1280, height: 900 });
        const link = page.locator('a[href*="/v1/magazine/issues/1/pdf"]').first(); assert.equal(await link.count(), 1);
        const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
        const downloadPath = await download.path(); assert.ok(downloadPath); assert.deepEqual(await readFile(downloadPath), livePdf);
        await page.screenshot({ path: `${evidence}/ru-reader-desktop.png`, fullPage: true }); await page.setViewportSize({ width: 375, height: 812 });
      }
      results.push({ locale, route, status: response?.status(), viewport: 375, axeViolations: axe.violations.length, screenshot: name });
    }
    await writeFile(`${evidence}/${locale}-browser-errors.json`, JSON.stringify({ errors, external }, null, 2));
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
  }
  await writeFile(`${evidence}/page-results.json`, JSON.stringify(results, null, 2));
  assert.ok(results.every(r => (r as { axeViolations: number }).axeViolations === 0), 'All pages must pass axe; see per-page reports');
  const raw = await fetch(`http://127.0.0.1:3468/ru/articles/${article.id}`).then(r => r.text());
  assert.match(raw, /application\/ld\+json/); assert.match(raw, /dateModified/); assert.match(raw, /Synthetic correction/);
  for (const section of ['news', 'articles', 'magazine']) for (const file of ['feed.xml', 'atom.xml', 'feed.json']) {
    const r = await fetch(`http://127.0.0.1:3468/ru/${section}/${file}`), body = await r.text();
    assert.equal(r.status, 200, `${section}/${file}`); assert.ok(body.includes('Synthetic')); assert.ok(!body.includes('PRIVATE draft marker'));
    if (section !== 'news') assert.match(body, /Synthetic correction/);
    if (file === 'feed.json') assert.equal(JSON.parse(body).version, 'https://jsonfeed.org/version/1.1');
    await writeFile(`${evidence}/${section}-${file}`, body);
  }
  const downloaded = await fetch('http://127.0.0.1:3468/v1/magazine/issues/1/pdf?edition=1');
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), livePdf);
  assert.equal((await fetch(`http://127.0.0.1:3468/ru/articles/${hidden.id}`)).status, 404);
  // Session-bound publications use the existing working projection, including the owner's draft.
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addCookies([...world.c.writer.jar].map(([name, value]) => ({ name, value, secure: name.startsWith('__Host-'), domain: '127.0.0.1', path: '/' })));
  await context.addCookies([{ name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/' }, { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage(); await page.goto('http://127.0.0.1:3468/app/publications', { waitUntil: 'networkidle' });
  assert.match(await page.locator('body').innerText(), /PRIVATE draft marker/);
  assert.ok(!(await page.locator('body').innerText()).includes('\u041d\u0438\u0433\u0434\u0435'), 'unknown placement must not be represented as nowhere');
  await page.screenshot({ path: `${evidence}/workspace-publications-375.png`, fullPage: true }); await context.close();
  await writeFile(`${evidence}/live-results.json`, JSON.stringify({ results, articleId: article.id, newsId: news.id, checks: ['inert content', 'private draft absent publicly', 'correction in feeds and JSON-LD', 'owner workspace draft', 'real worker PDF through the web origin'], manualScreenReader: 'not performed' }, null, 2));
  await writeFile(`${evidence}/next-server.log`, serverLog);
  console.log(`PASS: ${results.length} live pages, seven languages, 375px, keyboard focus and axe; nine feeds; private draft and owner workspace checks.`);
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(r => server!.once('exit', r)); }
  await worker?.stop(); await workerPool?.end();
  await h.db.admin.query(`DROP ROLE IF EXISTS ${workerRole}`);
  await browser.close(); await world.close(); await h.close();
}

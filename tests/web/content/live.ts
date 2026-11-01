import { withProvenanceFixtures } from '../../content/provenance-fixture.js';
/** CNT-003 bounded live acceptance: real PostgreSQL/API/DataPort, local Next and Chromium; synthetic content only. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
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
import { publications, issues, contentModeration } from '../../../packages/data/src/repositories/content.js';

import { buildSourcesWorld, DISPLAY_ONLY } from '../../sources/helpers.js';
import { currentSourceFixture } from '../../content/current-sources.js';
import { sources } from '../../../packages/data/src/repositories/sources.js';
import { moderation } from '../../../packages/data/src/repositories/admin.js';
import { consentRecords } from '../../../packages/data/src/repositories/profiles.js';
import { consentPublicProfiles } from '../../data/helpers/seed.js';

const evidence = process.env.CNT003_EVIDENCE_DIR;
assert.ok(evidence, 'CNT003_EVIDENCE_DIR is required');
// Next freezes rewrites at build time: build with TRUSTWORK_API_ORIGIN=http://127.0.0.1:3467 first.
const routes=JSON.parse(await readFile('apps/web/.next/routes-manifest.json','utf8'));
assert.ok(routes.rewrites.beforeFiles.some((route: {source:string;destination:string})=>route.source==='/v1/:path*'&&route.destination==='http://127.0.0.1:3467/v1/:path*'),'Build Next with the local API rewrite before live acceptance');
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
    if (publish) row = await w.act.as(p.writer, trx => withProvenanceFixtures(w).publish(trx, null, row.id, row.revision, null));
    return row;
  };
  let article = await make('article', 'Synthetic: insulation practice', true);
  article = await w.act.as(p.writer, trx => withProvenanceFixtures(w).correct(trx, null, article.id, article.revision, draft({ title: 'Synthetic: corrected insulation practice', body: 'Synthetic corrected construction report.\n\n<script>window.unsafeContent = true</script>', language: 'ru', assistantAssisted: true }), 'Synthetic correction: insulation thickness updated.', 'correction'));
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
  const browserLocales=(process.env.PROV_BROWSER_LOCALES ?? 'en,es,ru,uz-Latn,ka,hy,az-Latn').split(',').filter(Boolean);
  for (const locale of browserLocales) {
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
        const downloadFailure=await download.failure();
        const downloadResponse=await fetch(download.url());
        await writeFile(`${evidence}/pdf-download-diagnostic.json`,JSON.stringify({url:download.url(),failure:downloadFailure,status:downloadResponse.status,headers:Object.fromEntries(downloadResponse.headers)},null,2));
        assert.equal(downloadFailure,null);
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
  // A real published title/correction must remain JSON data, even without CSP as a second defense.
  const breakoutTitle = 'Synthetic </ScRiPt><script id="cnt003-breakout">window.jsonLdBreakout=true</script> <!-- & " \u2028\u2029';
  const breakoutNote = 'Synthetic correction </script><img id="cnt003-breakout-image" src="https://example.invalid/never-fetch" onerror="window.jsonLdBreakout=true">';
  let breakout = await make('article', breakoutTitle, true);
  breakout = await w.act.as(p.writer, trx => withProvenanceFixtures(w).correct(trx, null, breakout.id, breakout.revision, draft({ title: breakoutTitle, body: 'Synthetic JSON-LD boundary test.', language: 'ru' }), breakoutNote, 'correction'));
  const breakoutContext = await browser.newContext({ bypassCSP: true });
  await breakoutContext.addCookies([{ name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/' }]);
  const breakoutPage = await breakoutContext.newPage(), breakoutRequests: string[] = [], breakoutErrors: string[] = [];
  breakoutPage.on('pageerror', error => breakoutErrors.push(error.message));
  await breakoutPage.route('**/*', route => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)) { breakoutRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  assert.equal((await breakoutPage.goto(`http://127.0.0.1:3468/ru/articles/${breakout.id}`, { waitUntil: 'networkidle' }))?.status(), 200);
  const jsonScript = breakoutPage.locator('script[type="application/ld+json"]');
  assert.equal(await jsonScript.count(), 1);
  const jsonText = await jsonScript.textContent(); assert.ok(jsonText);
  assert.equal(JSON.parse(jsonText).headline, breakoutTitle);
  assert.equal(JSON.parse(jsonText).correction.text, breakoutNote);
  assert.ok(!jsonText.includes('<'), 'script data contains no HTML delimiter');
  assert.equal(await breakoutPage.locator('#cnt003-breakout, #cnt003-breakout-image').count(), 0);
  assert.equal(await breakoutPage.evaluate(() => (window as unknown as { jsonLdBreakout?: boolean }).jsonLdBreakout), undefined);
  assert.deepEqual(breakoutRequests, []); assert.deepEqual(breakoutErrors, []);
  await writeFile(`${evidence}/jsonld-results.json`, JSON.stringify({ cspBypassedForNegativeTest: true, titleRoundTrip: true, correctionRoundTrip: true, injectedElements: 0, externalRequests: breakoutRequests, pageErrors: breakoutErrors }, null, 2));
  await breakoutContext.close();
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
  await page.screenshot({ path: `${evidence}/workspace-publications-375.png`, fullPage: true });
  const labels=JSON.parse(await readFile('apps/web/locales/ru/provenance.json','utf8')).publicationProvenance;
  await page.goto(`http://127.0.0.1:3468/app/publications/${hidden.id}/edit`,{waitUntil:'networkidle'});
  await page.getByLabel(labels.heading,{exact:true}).fill('Synthetic UI publication');
  assert.equal(await page.getByRole('button',{name:labels.declare,exact:true}).isDisabled(),true,'unsaved text must not declare the older binding');
  await page.getByLabel(labels.body,{exact:true}).fill('Synthetic UI declaration workflow.');
  await page.getByLabel(labels.reason,{exact:true}).fill('Synthetic browser verification');
  assert.equal(await page.getByLabel(labels.language,{exact:true}).locator('option').count(),7);
  const command=async(label:string,path:string)=>{
    const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith(path)&&r.request().method()==='POST'),page.getByRole('button',{name:label,exact:true}).click()]);
    assert.ok(response.ok(),await response.text());
    await page.getByRole('status').filter({hasText:labels.saved}).waitFor();
  };
  await command(labels.saveDraft,`/v1/publications/${hidden.id}/draft`);
  await page.getByLabel(labels.roles.editorial_writer,{exact:true}).check();
  await command(labels.declare,'/v1/provenance/declarations');
  assert.equal(await page.getByLabel(labels.affirmConsent,{exact:true}).isChecked(),false);
  assert.equal(await page.getByRole('button',{name:labels.grantConsent,exact:true}).isDisabled(),true);
  await page.getByLabel(labels.web,{exact:true}).check();
  await page.getByLabel(labels.affirmConsent,{exact:true}).check();
  await command(labels.grantConsent,'/v1/provenance/consents');
  await command(labels.publish,`/v1/publications/${hidden.id}/publish`);
  const publicCredit=async(channel:string)=>fetch(`http://127.0.0.1:3468/v1/publications/${hidden.id}?channel=${channel}`).then(r=>r.json()).then(p=>p.current.provenance.credits);
  assert.equal((await publicCredit('web')).responsible_editor,'Synthetic Writer');
  assert.deepEqual(await publicCredit('feed'),{});assert.equal((await fetch(`http://127.0.0.1:3468/v1/publications/${hidden.id}?channel=pdf`)).status,422);
  for(const width of [375,1280]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();
    await writeFile(`${evidence}/ru-editor-${width}-axe.json`,JSON.stringify(axe.violations,null,2));
    assert.deepEqual(axe.violations,[]);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:`${evidence}/ru-editor-${width}.png`,fullPage:true});
  }
  await command(labels.revokeConsent,'/v1/provenance/revocations');
  assert.deepEqual(await publicCredit('web'),{});
  for(const locale of ['en','es','uz-Latn','ka','hy','az-Latn']) {
    await context.addCookies([{name:'trustwork.locale',value:locale,domain:'127.0.0.1',path:'/'}]);
    await page.setViewportSize({width:375,height:812});
    await page.goto(`http://127.0.0.1:3468/app/publications/${hidden.id}/edit`,{waitUntil:'networkidle'});
    const dictionary=JSON.parse(await readFile(`apps/web/locales/${locale}/provenance.json`,'utf8')).publicationProvenance;
    await page.getByRole('heading',{name:dictionary.title,exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`${evidence}/${locale}-editor-375.png`,fullPage:true});
  }
  await writeFile(`${evidence}/provenance-editor-results.json`,JSON.stringify({save:true,declare:true,publish:true,consent:'explicit-web-only',withdrawal:true,languages:7,viewports:[375,1280],manualScreenReader:'not performed',nativeLanguageReview:'not performed'},null,2));
  await context.close();
  // A distinct session reviews the exact machine translation through the first-party form.
  const translated=await w.act.as(p.writer,trx=>publications.create(trx,null,{hubId:w.hubId,owner:{kind:'person'},format:'article',articleFormat:'practice',language:'es',licence:'cc_by',requiresReview:false,draft:draft({language:'es',title:'Synthetic Spanish translation',body:'Synthetic translated construction report.',assistantAssisted:true}),authorship:credit(p.writer)}));
  await w.act.as(p.writer,trx=>publications.linkEdition(trx,null,article.id,translated.id,true));
  await world.c.writer.post(`/v1/publications/${translated.id}/editors`,{personId:p.coauthor,rights:'publish'});
  const translationContext=await browser.newContext({viewport:{width:375,height:812}});
  const usePerson=async(key:'writer'|'coauthor')=>{
    await translationContext.clearCookies();
    await translationContext.addCookies([...world.c[key].jar].map(([name,value])=>({name,value,secure:name.startsWith('__Host-'),domain:'127.0.0.1',path:'/'})));
    await translationContext.addCookies([{name:'trustwork.country',value:'UZ',domain:'127.0.0.1',path:'/'},{name:'trustwork.locale',value:'ru',domain:'127.0.0.1',path:'/'}]);
  };
  const trPage=await translationContext.newPage();
  const editor=async()=>{await trPage.goto(`http://127.0.0.1:3468/app/publications/${translated.id}/edit`,{waitUntil:'networkidle'});await trPage.getByLabel(labels.reason,{exact:true}).fill('Synthetic exact translation review');};
  const trCommand=async(label:string,path:string)=>{
    const [r]=await Promise.all([trPage.waitForResponse(r=>r.url().endsWith(path)&&r.request().method()==='POST'),trPage.getByRole('button',{name:label,exact:true}).click()]);assert.ok(r.ok(),await r.text());await trPage.getByRole('status').filter({hasText:labels.saved}).waitFor();
  };
  await usePerson('writer');await editor();
  await trPage.getByLabel(labels.kind,{exact:true}).selectOption('machine_translation');
  await trPage.getByLabel(labels.roles.editorial_translator,{exact:true}).check();
  await trPage.getByLabel(labels.originalId,{exact:true}).fill(article.id);
  await Promise.all([trPage.waitForResponse(r=>r.url().endsWith(`/v1/publications/${article.id}`)),trPage.getByRole('button',{name:labels.loadOriginal,exact:true}).click()]);
  await trCommand(labels.declare,'/v1/provenance/declarations');
  await usePerson('coauthor');await editor();
  await trCommand(labels.review,'/v1/provenance/reviews');
  assert.equal(await trPage.getByLabel(labels.kind,{exact:true}).locator('option:checked').textContent(),labels.machineReviewed);
  await trPage.getByLabel(labels.pdf,{exact:true}).check();await trPage.getByLabel(labels.feed,{exact:true}).check();await trPage.getByLabel(labels.affirmConsent,{exact:true}).check();
  await trCommand(labels.grantConsent,'/v1/provenance/consents');
  await trPage.evaluate(()=>window.scrollTo(0,0));
  await trPage.screenshot({path:`${evidence}/ru-translation-reviewer-375.png`,fullPage:true});
  await usePerson('writer');await editor();await trCommand(labels.publish,`/v1/publications/${translated.id}/publish`);
  const trVersion=(await w.act.as(p.writer,trx=>publications.versions(trx,translated.id)))[0]!;
  let trIssue=await w.act.as(p.editorA,trx=>issues.create(trx,ctxA,{hubId:w.hubId,number:15,date:'2026-11-01',theme:'Synthetic reviewed translation',coverAssetId:null,editorLetterId:null}));
  trIssue=await w.act.as(p.editorA,trx=>issues.curate(trx,ctxA,trIssue.id,trIssue.revision,{items:[{position:1,section:'practice',publicationId:translated.id,publicationVersionId:trVersion.id}],theme:null,coverAssetId:null,editorLetterId:null}));
  trIssue=await w.act.as(p.editorA,trx=>issues.transition(trx,ctxA,trIssue.id,trIssue.revision,'curated'));
  trIssue=await w.act.as(p.editorA,trx=>issues.transition(trx,ctxA,trIssue.id,trIssue.revision,'review'));
  await w.act.as(p.chief,trx=>issues.release(trx,ctxC,trIssue.id,trIssue.revision));
  await world.elevate('editorA');
  assert.equal((await consoleCommand(world.c.editorA,`/v1/admin/content/issues/${trIssue.id}/renders`,{edition:1,format:'pdf'})).status,201);
  await worker.runOnce({rethrow:true});await worker.idle();
  const translationPdf=await fetch('http://127.0.0.1:3468/v1/magazine/issues/15/pdf?edition=1');assert.equal(translationPdf.status,200);
  await writeFile(`${evidence}/issue-translation-es.pdf`,Buffer.from(await translationPdf.arrayBuffer()));
  await trPage.goto('http://127.0.0.1:3468/ru/magazine/15/read',{waitUntil:'networkidle'});
  assert.equal(await trPage.locator(`a[href="/ru/articles/${article.id}?version=2"]`).count(),1);
  await trPage.screenshot({path:`${evidence}/ru-translation-reader-375.png`,fullPage:true});
  for(const section of ['articles','magazine'])for(const file of ['feed.xml','atom.xml','feed.json']){
    const body=await fetch(`http://127.0.0.1:3468/ru/${section}/${file}`).then(r=>r.text());assert.ok(body.includes(`${article.id}?version=2`));
  }
  await usePerson('coauthor');await editor();await trCommand(labels.revokeConsent,'/v1/provenance/revocations');
  assert.equal((await fetch('http://127.0.0.1:3468/v1/magazine/issues/15/pdf?edition=1')).status,404);
  article=await w.act.as(p.writer,trx=>withProvenanceFixtures(w).correct(trx,null,article.id,article.revision,draft({language:'ru',title:'Synthetic current original',body:'Synthetic revised original.',assistantAssisted:true}),'Synthetic original update','Synthetic update'));
  await trPage.goto(`http://127.0.0.1:3468/ru/articles/${translated.id}`,{waitUntil:'networkidle'});
  assert.ok((await trPage.locator('body').innerText()).includes(labels.stale));
  const structured=JSON.parse((await trPage.locator('script[type="application/ld+json"]').textContent())!);
  assert.equal(structured.translationOfWork.identifier,version.content_digest);
  assert.ok(structured.translationOfWork.url.endsWith(`${article.id}?version=2`));
  assert.equal(structured.editor,undefined,'reviewer PDF/feed consent never becomes web editor consent');
  assert.equal(await trPage.locator(`a[href="/ru/articles/${article.id}?version=2"]`).count(),1);
  await trPage.screenshot({path:`${evidence}/ru-stale-translation-375.png`,fullPage:true});
  await writeFile(`${evidence}/translation-results.json`,JSON.stringify({distinctReviewerForm:true,reviewerConsent:['feed','pdf'],exactOriginalVersion:2,originalDigest:version.content_digest,staleAfterCorrection:true,pdfWithdrawalStatus:404},null,2));
  await translationContext.close();
  // The actual live DataPort and all nine feed routes must re-read rights after committed revocation.
  const sw = await buildSourcesWorld(h.db.admin, h.pool, w);
  await withMaintenance(h.db.admin, async trx => {
    await consentPublicProfiles(trx, [p.coauthor]);
    await trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', '=', p.coauthor).execute();
  });
  const licensed = await currentSourceFixture(sw, h.db.admin, 11, { coauthor: true });
  const licensedNews = await currentSourceFixture(sw, h.db.admin, 12, { format: 'news' });
  const linked = await currentSourceFixture(sw, h.db.admin, 13, { treatment: 'headline_link' });
  await sw.cmd(sw.people.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, linked.registered.id, linked.registered.revision, { ...linked.input, allowedUses: DISPLAY_ONLY }));
  const rightsContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await rightsContext.addCookies([{ name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/' }]);
  const rightsPage = await rightsContext.newPage();
  const externalRequests: string[] = [];
  await rightsPage.route('**/*', route => { if (!['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)) { externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const readWeb = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:3468${path}`);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/, path);
    return { status: r.status, body: await r.text() };
  };
  const feedEvidence: object[] = [];
  const checkFeeds = async (phase: 'allowed' | 'consent-withdrawn' | 'revoked') => {
    for (const section of ['news', 'articles', 'magazine']) for (const file of ['feed.xml', 'atom.xml', 'feed.json']) {
      const path = `/ru/${section}/${file}`, r = await readWeb(path);
      assert.equal(r.status, 200);
      const f = section === 'news' ? licensedNews : licensed;
      if (phase === 'revoked') for (const denied of [licensed, licensedNews]) {
        assert.ok(!r.body.includes(denied.marker), `${path} leaks ${denied.marker}`);
        assert.ok(!r.body.includes(denied.external.url), `${path} leaks revoked source URL`);
      } else assert.ok(r.body.includes(`${f.marker} body`), `${path} must initially serve licensed text`);
      assert.ok(!r.body.includes(`${linked.marker} body`), 'headline-link never carries full text');
      if (phase !== 'allowed') assert.ok(!r.body.includes(`${licensed.marker} coauthor`));
      await writeFile(`${evidence}/rights-${phase}-${section}-${file}`, r.body);
      feedEvidence.push({ phase, path, status: r.status, cache: 'no-store' });
    }
  };
  await rightsPage.goto(`http://127.0.0.1:3468/ru/magazine/11/read`, { waitUntil: 'networkidle' });
  assert.match(await rightsPage.locator('body').innerText(), /Synthetic licensed 11 body/);
  await rightsPage.screenshot({ path: `${evidence}/rights-allowed-reader-375.png`, fullPage: true });
  await checkFeeds('allowed');
  // Real worker PDF from the same linked source publication, before any rights change.
  await world.elevate('editorA');
  assert.equal((await consoleCommand(world.c.editorA, `/v1/admin/content/issues/${licensed.issue.id}/renders`, { edition: 1, format: 'pdf' })).status, 201);
  await worker.runOnce({ rethrow: true }); await worker.idle();
  const sourcePdf = await fetch('http://127.0.0.1:3468/v1/magazine/issues/11/pdf?edition=1');
  assert.equal(sourcePdf.status, 200); await writeFile(`${evidence}/issue-source.pdf`, Buffer.from(await sourcePdf.arrayBuffer()));
  await w.act.as(p.coauthor, async trx => {
    const consent = (await consentRecords.listForSubject(trx, p.coauthor)).find(c => c.target_id === licensed.pub.id)!;
    assert.ok(consent); await consentRecords.withdraw(trx, consent.id, 'Synthetic first-party withdrawal');
  });
  const consentProjection = await readWeb(`/v1/publications/${licensed.pub.id}`);
  assert.equal(consentProjection.status, 200); assert.ok(!consentProjection.body.includes(`${licensed.marker} coauthor`));
  await checkFeeds('consent-withdrawn');
  assert.equal((await readWeb('/v1/magazine/issues/11/pdf?edition=1')).status, 404, 'web and stored PDF honor consent change');
  for (const f of [licensed, licensedNews]) await sw.cmd(sw.people.stewardA, (trx, ctx) => sources.setTerms(trx, ctx, f.registered.id, f.registered.revision, { ...f.input, allowedUses: DISPLAY_ONLY }));
  for (const f of [licensed, licensedNews]) {
    for (const path of [`/v1/publications/${f.pub.id}`, `/v1/publications/${f.pub.id}/versions/1`, `/ru/${f.pub.format === 'news' ? 'news' : 'articles'}/${f.pub.id}`]) {
      const r = await readWeb(path); assert.equal(r.status, 404, path); assert.ok(!r.body.includes(f.marker));
    }
    const pinned = await readWeb(`/v1/magazine/issues/${f.issue.number}?edition=1`);
    assert.equal(pinned.status, 200); assert.ok(!pinned.body.includes(f.marker)); assert.equal(JSON.parse(pinned.body).items[0].withheld, true);
  }
  await checkFeeds('revoked');
  for (const path of ['/ru/magazine', '/ru/magazine/archive', '/ru/magazine/rubric/practice', '/ru/magazine/11/read']) {
    await rightsPage.goto(`http://127.0.0.1:3468${path}`, { waitUntil: 'networkidle' });
    const text = await rightsPage.locator('body').innerText();
    for (const f of [licensed, licensedNews]) assert.ok(!text.includes(f.marker), path);
  }
  await rightsPage.screenshot({ path: `${evidence}/rights-revoked-reader-375.png`, fullPage: true });
  assert.equal((await readWeb('/v1/magazine/issues/11/pdf?edition=1')).status, 404);
  // Existing removal and retraction controls still apply through the same live reader.
  const ctxM = await w.act.elevate(p.moderator);
  await w.act.as(p.moderator, async trx => {
    const c = await moderation.openCase(trx, ctxM, { hubId: w.hubId, targetKind: 'publication', targetId: article.id, subject: { kind: 'person', id: p.writer }, clauseCodes: ['community.misinformation'], emergencyHold: true });
    await moderation.decide(trx, ctxM, c.id, 'content_removed');
    await contentModeration.apply(trx, c.id, 'remove');
  });
  assert.equal((await readWeb(`/ru/articles/${article.id}`)).status, 404);
  assert.equal((await readWeb('/v1/magazine/issues/1/pdf?edition=1')).status, 404);
  const withheldIssue = await readWeb('/ru/magazine/1/read'); assert.ok(!withheldIssue.body.includes('Synthetic corrected construction report.'));
  await w.act.as(p.writer, trx => publications.retract(trx, null, news.id, news.revision, 'Synthetic withdrawn report'));
  const retracted = await readWeb(`/v1/publications/${news.id}`); assert.equal(JSON.parse(retracted.body).current.body, null);
  const newsFeed = await readWeb('/ru/news/feed.json'); assert.ok(!newsFeed.body.includes('Synthetic construction report.'));
  assert.deepEqual(externalRequests, []); await rightsContext.close();
  await writeFile(`${evidence}/rights-results.json`, JSON.stringify({ feedEvidence, externalRequests, sourceId: licensed.registered.id, publicationId: licensed.pub.id, pinnedVersion: 1,
    checks: ['initial rights', 'committed revocation', 'private source fields absent', 'consent credit withdrawn', 'headline link body withheld', 'pinned issue withheld', 'magazine/archive/rubric', 'PDF agrees', 'moderation', 'retraction'] }, null, 2));
  await writeFile(`${evidence}/live-results.json`, JSON.stringify({ results, articleId: article.id, newsId: news.id, checks: ['inert content', 'private draft absent publicly', 'correction in feeds and JSON-LD', 'owner workspace draft', 'real worker PDF through the web origin'], manualScreenReader: 'not performed' }, null, 2));
  await writeFile(`${evidence}/next-server.log`, serverLog);
  console.log(`PASS: ${results.length} public pages, ${browserLocales.length} public locales; seven editor locales; nine feeds; real consent, review, PDF and rights checks.`);
} catch(error) {
  let n=0;
  for(const context of browser.contexts())for(const page of context.pages()){
    await page.screenshot({path:`${evidence}/failure-${++n}.png`,fullPage:true}).catch(()=>{});
    await writeFile(`${evidence}/failure-${n}.txt`,`${page.url()}\n${await page.locator('body').innerText().catch(()=>'<unavailable>')}`);
  }
  throw error;
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(r => server!.once('exit', r)); }
  await worker?.stop(); await workerPool?.end();
  await h.db.admin.query(`DROP ROLE IF EXISTS ${workerRole}`);
  await browser.close(); await world.close(); await h.close();
}

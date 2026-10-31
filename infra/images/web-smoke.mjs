// Web image smoke (OPS-002): checks a running web container the way the hosted preview is used.
//   node infra/images/web-smoke.mjs <origin and base path, for example http://127.0.0.1:3999/trustwork> [container]
// With a container name it also reads the container log for the start-up line of the deployment configuration and
// requires the default country it reports to be TRUSTWORK_EXPECT_COUNTRY (default US). Checks: English by default
// with the engine title; the Russian interface by cookie with the Russian brand overlay's title; Georgian by the
// country cookie; the companies directory renders; static chunks and repository artworks are served; the proxy
// (apps/web/proxy.ts) runs on the home page and on other pages: a nonce-based Content-Security-Policy whose nonce the
// page's scripts carry, X-Frame-Options DENY, and `?country=&lang=` answered with a redirect that sets both cookies.
// Exit 0 when everything passed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [base = 'http://127.0.0.1:3000', container] = process.argv.slice(2).map((arg, i) => (i === 0 ? arg.replace(/\/$/, '') : arg));
const expectCountry = process.env.TRUSTWORK_EXPECT_COUNTRY ?? 'US';
// The Russian overlay's product name (docs/oss/BRAND.md), written as escapes because documentation and scripts stay ASCII.
const RUSSIAN_TITLE = 'Строй Репутация';
const origin = new URL(base).origin;
const basePath = new URL(base).pathname.replace(/\/$/, '');

const page = async (path, cookie) => {
  const response = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  return { status: response.status, html: await response.text() };
};
const lang = (html) => /<html[^>]*\blang="([^"]+)"/.exec(html)?.[1] ?? null;
const title = (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null;
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`ok   ${name}`); };

let home;
await step('English by default with the engine title', async () => {
  home = await page('');
  assert.equal(home.status, 200);
  assert.equal(lang(home.html), 'en');
  assert.equal(title(home.html), 'Trustwork');
});

if (container) {
  await step(`the deployment configuration loaded with default country ${expectCountry}`, async () => {
    const log = execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const line = log.split('\n').find((l) => l.includes('"deployment configuration loaded"'));
    assert.ok(line, 'start-up line "deployment configuration loaded" in the container log');
    assert.equal(JSON.parse(line).defaultCountry, expectCountry);
  });
}

await step('Russian by cookie shows the Russian brand overlay title', async () => {
  const ru = await page('', 'trustwork.locale=ru');
  assert.equal(ru.status, 200);
  assert.equal(lang(ru.html), 'ru');
  assert.equal(title(ru.html), RUSSIAN_TITLE);
});

await step('Georgia by the country cookie shows Georgian', async () => {
  const ka = await page('', 'trustwork.country=GE');
  assert.equal(ka.status, 200);
  assert.equal(lang(ka.html), 'ka');
  assert.equal(title(ka.html), 'Trustwork');
});

await step('the companies directory renders', async () => {
  const companies = await page('/companies');
  assert.equal(companies.status, 200);
  assert.equal(lang(companies.html), 'en');
  assert.match(companies.html, /<h1[\s>]/);
  assert.match(companies.html, /<main[\s>]/);
});

await step('static chunks and repository artworks are served', async () => {
  const chunk = /["'](\/(?:[^"']*\/)?_next\/static\/[^"']+\.js)["']/.exec(home.html)?.[1];
  assert.ok(chunk, 'the home page references a static chunk');
  assert.equal((await fetch(`${origin}${chunk}`, { signal: AbortSignal.timeout(10_000) })).status, 200);
  const artwork = /["'](\/(?:[^"']*\/)?media\/artworks\/[^"'?]+)["'?]/.exec(home.html)?.[1];
  if (artwork) assert.equal((await fetch(`${origin}${artwork}`, { signal: AbortSignal.timeout(10_000) })).status, 200);
});

const assertDocumentHeaders = async (path) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `${path || '/'} status`);
  const csp = response.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, `${path || '/'}: Content-Security-Policy with a script nonce (got "${csp}")`);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY', `${path || '/'}: X-Frame-Options`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const html = await response.text();
  assert.ok(html.includes(`nonce="${nonce}"`), `${path || '/'}: the page's scripts carry the header's nonce`);
};

await step('the home page and the companies page carry the nonce CSP and X-Frame-Options', async () => {
  await assertDocumentHeaders('');
  await assertDocumentHeaders('/companies');
});

for (const path of ['', '/companies']) {
  await step(`?country=GE&lang=ka on ${path || 'the home page'} redirects without the parameters and sets both cookies`, async () => {
    const response = await fetch(`${base}${path}?country=GE&lang=ka`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 307);
    assert.equal(new URL(response.headers.get('location') ?? '', base).pathname, `${basePath}${path}` || '/');
    assert.equal(new URL(response.headers.get('location') ?? '', base).search, '');
    const cookies = response.headers.getSetCookie();
    const cookiePath = basePath || '/';
    for (const expected of ['trustwork.country=GE', 'trustwork.locale=ka']) {
      const cookie = cookies.find((c) => c.startsWith(`${expected};`));
      assert.ok(cookie, `Set-Cookie ${expected} (got ${JSON.stringify(cookies)})`);
      assert.ok(cookie.split(';').map((part) => part.trim()).includes(`Path=${cookiePath}`), `${expected} has Path=${cookiePath}`);
    }
    const followed = await page(path, cookies.map((c) => c.split(';')[0]).join('; '));
    assert.equal(followed.status, 200);
    assert.equal(lang(followed.html), 'ka');
  });
}

console.log(`web smoke passed: ${passed} checks on ${base}`);

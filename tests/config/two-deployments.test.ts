import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { REPO, WEB, dataDirectory, syntheticPack } from './helpers.js';

/**
 * CFG-001 acceptance against a real production build: one build (one image) serves two deployments with different
 * default countries, brands and data directories, both in demo mode like the hosted preview (WEB-004). It needs a
 * build of apps/web and is skipped without one:
 *
 *   cd apps/web && NEXT_DIST_DIR=.next-e2e npx next build --webpack
 *   TRUSTWORK_CONFIG_BUILD=.next-e2e node --import tsx --test tests/config/two-deployments.test.ts
 *
 * `TRUSTWORK_CONFIG_BUILD` names the build directory inside apps/web. Both servers run on loopback ports and are
 * stopped by the test; nothing reaches the network.
 */
const build = process.env.TRUSTWORK_CONFIG_BUILD;
const enabled = Boolean(build && existsSync(join(WEB, build, 'BUILD_ID')));

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function start(env: Record<string, string>): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TRUSTWORK_') && !key.startsWith('NEXT_PUBLIC_')));
  const child = spawn(process.execPath, [join(REPO, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: WEB,
    env: { ...clean, NEXT_DIST_DIR: build!, NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_DEMO_MODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return { url, child };
    } catch {
      /* not listening yet */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  child.kill();
  throw new Error(`next start did not answer on ${url}`);
}

const page = async (url: string, cookie = '') => (await fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) })).text();

test('one build serves two deployments with different default countries, brands and data (set TRUSTWORK_CONFIG_BUILD to run)', { skip: !enabled, timeout: 180_000 }, async () => {
  const data = dataDirectory();
  data.write('country-packs/xf.json', syntheticPack('pt'));
  data.write('locales/pt/core.json', { locale: { gateTitle: 'Escolha o seu país' } });
  const servers: ChildProcess[] = [];
  try {
    const us = await start({ TRUSTWORK_DEFAULT_COUNTRY: 'US', TRUSTWORK_BRAND: 'none' });
    servers.push(us.child);
    const ge = await start({ TRUSTWORK_DEFAULT_COUNTRY: 'GE', TRUSTWORK_DATA_DIR: data.dir });
    servers.push(ge.child);

    // Default country for a visitor without cookies: the header switcher shows it, the page is English.
    const usHome = await page(`${us.url}/`);
    const geHome = await page(`${ge.url}/`);
    assert.match(usHome, /<html lang="en"/);
    assert.match(geHome, /<html lang="en"/);
    assert.match(usHome, /class="lsw__code">US</);
    assert.match(geHome, /class="lsw__code">GE</);

    // Brand: Trustwork in Russian too on the first, the default Russian-interface overlay on the second.
    assert.match(await page(`${us.url}/`, 'trustwork.locale=ru'), /<title>Trustwork<\/title>/);
    assert.doesNotMatch(await page(`${ge.url}/`, 'trustwork.locale=ru'), /<title>Trustwork<\/title>/);

    // Data directory: only the second deployment knows the XF pack and the pt language.
    const set = async (url: string) => (await fetch(`${url}/?country=XF&lang=pt`, { redirect: 'manual', signal: AbortSignal.timeout(20000) })).headers.getSetCookie().join('\n');
    assert.equal(await set(us.url), '', 'unknown country and language are ignored');
    const cookies = await set(ge.url);
    assert.match(cookies, /trustwork\.country=XF/);
    assert.match(cookies, /trustwork\.locale=pt/);
    const xf = await page(`${ge.url}/`, 'trustwork.country=XF; trustwork.locale=pt');
    assert.match(xf, /<html lang="pt"/);
    assert.match(xf, /class="lsw__code">XF</);
  } finally {
    for (const child of servers) child.kill();
    data.remove();
  }
});

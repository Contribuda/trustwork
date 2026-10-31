import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
async function availablePort() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); return port;
}
async function smoke(args, port, path, verify, extraEnv = {}) {
  let output = '';
  const child = spawn(process.execPath, args, { env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      let response;
      try { response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1000) }); } catch { /* Startup may still be in progress. */ }
      if (response) { assert.equal(response.status, 200); await verify(response); return; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Server startup timed out: ${output}`);
  } finally {
    if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
  }
}
const apiPort = await availablePort();
await smoke(['apps/api/dist/apps/api/src/main.js'], apiPort, '/health', async (r) => assert.deepEqual(await r.json(), { status: 'ok', mode: 'bootstrap', externalProviders: 'disabled' }), { API_PORT: String(apiPort), API_HOST: '127.0.0.1' });
const webPort = await availablePort();
await smoke(['node_modules/next/dist/bin/next', 'start', 'apps/web', '--hostname', '127.0.0.1', '--port', String(webPort)], webPort, '/', async (r) => {
  // Without cookies or a supported browser language the page is English (ADR 012, decision 27); a chosen country
  // keeps its default language and the Russian locale stays reachable by cookie. The title is the brand name: the
  // Russian overlay's (only in the Russian interface) or the engine's (Trustwork).
  const html = await r.text(); assert.match(html, /lang="en"/); assert.match(html, /<title>Trustwork<\/title>/);
  const uz = await fetch(`http://127.0.0.1:${webPort}/`, { headers: { cookie: 'trustwork.country=UZ' }, signal: AbortSignal.timeout(5000) });
  assert.equal(uz.status, 200); assert.match(await uz.text(), /lang="uz-Latn"/);
  const ru = await fetch(`http://127.0.0.1:${webPort}/`, { headers: { cookie: 'trustwork.country=UZ; trustwork.locale=ru' }, signal: AbortSignal.timeout(5000) });
  assert.equal(ru.status, 200);
  const ruHtml = await ru.text(); assert.match(ruHtml, /lang="ru"/); assert.match(ruHtml, /<title>(Строй Репутация|Trustwork)<\/title>/);
});
console.log('API health and the localized web home page (English default, a chosen country in its language, ru by cookie) passed loopback smoke checks; owned processes stopped.');

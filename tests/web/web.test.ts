import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';

/**
 * Root test-runner entry for the Playwright suite. The root runner only discovers `*.test.*` files,
 * so this wrapper builds apps/web, picks a free loopback port and runs `playwright test` there.
 * It is skipped unless TRUSTWORK_E2E=1 so `npm run check` stays green without a browser.
 */
const enabled = process.env.TRUSTWORK_E2E === '1';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test('apps/web Playwright suite (set TRUSTWORK_E2E=1 to run)', { skip: !enabled }, async () => {
  const cwd = resolve('apps/web');
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', TRUSTWORK_E2E_PORT: String(await freePort()) };
  const build = spawnSync('npm', ['run', 'build'], { cwd, env, stdio: 'inherit' });
  assert.equal(build.status, 0, 'next build must succeed before the browser tests');
  const run = spawnSync('npx', ['playwright', 'test'], { cwd, env, stdio: 'inherit' });
  assert.equal(run.status, 0, 'playwright test must exit 0');
});

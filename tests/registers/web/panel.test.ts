import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * REG-001 company-page panel. The probe compiles against the web app's `@/` paths, so it runs in a child process with
 * this directory's tsconfig (like tests/web/commerce and tests/web/live-api).
 */
const here = resolve('tests/registers/web');

test('company-page register panel (panel.probe.tsx)', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', join(here, 'panel.probe.tsx')], {
    encoding: 'utf8',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), TSX_TSCONFIG_PATH: join(here, 'tsconfig.json') },
  });
  assert.match(result.stdout, /ℹ pass [1-9]/, `the probe ran its tests\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ℹ fail 0/, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('type test: the probe compiles against the web app', () => {
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(here, 'tsconfig.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

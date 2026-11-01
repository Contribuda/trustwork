import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CNT-003 reader adapter and feed negative checks', () => {
  const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--test', '--test-reporter=spec', 'tests/web/content/reader.probe.tsx'], {
    encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), TSX_TSCONFIG_PATH: 'apps/web/tsconfig.json' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 6/); assert.match(result.stdout, /fail 0/);
});

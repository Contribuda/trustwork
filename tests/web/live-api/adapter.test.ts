import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ERROR_CODES } from '@trustwork/contracts';

/**
 * WEB-004 unit checks of the live API adapter and the demo-mode switch. The probe compiles against the web app's
 * `@/` paths, so it runs in a child process with this directory's tsconfig (like tests/web/data-port).
 */
const here = resolve('tests/web/live-api');

test('live adapter, transport and demo-mode switch (adapter.probe.tsx)', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', join(here, 'adapter.probe.tsx')], {
    encoding: 'utf8',
    // NODE_TEST_CONTEXT would make the child report into this runner and exit 0 whatever happens.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), TSX_TSCONFIG_PATH: join(here, 'tsconfig.json'), TRUSTWORK_DEMO_MODE: '', TRUSTWORK_DEMO_PERSONA: 'owner' },
  });
  assert.match(result.stdout, /# pass [1-9]/, 'the probe ran its tests');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

const LANGUAGES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'] as const;
/** Codes the API emits outside the frozen list (requested from FND-002) and the web's own network failure. */
const EXTRA_CODES = ['auth.email_taken', 'internal.error', 'network'];

function lookup(tree: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
}

test('every API error code renders localized copy in every engine language (error.<code>), never the code', () => {
  const missing: string[] = [];
  for (const language of LANGUAGES) {
    const core = JSON.parse(readFileSync(resolve(`apps/web/locales/${language}/core.json`), 'utf8')) as Record<string, unknown>;
    for (const code of [...ERROR_CODES, ...EXTRA_CODES]) {
      const value = lookup(core, `error.${code}`);
      if (typeof value !== 'string' || !value.trim() || (code.includes('.') && value.includes(code))) missing.push(`${language}: error.${code}`);
    }
  }
  assert.deepEqual(missing, [], 'add the message to apps/web/locales/<language>/core.json');
});

test('the fake auth adapter and its route handlers are gone', () => {
  for (const path of ['apps/web/app/_lib/auth-fake.ts', 'apps/web/app/api/auth/login/route.ts', 'apps/web/app/api/auth/signup/route.ts']) {
    assert.throws(() => readFileSync(resolve(path)), /ENOENT/, path);
  }
});

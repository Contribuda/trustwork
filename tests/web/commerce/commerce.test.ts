import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * WEB-002 unit checks. The probe compiles against the web app's `@/` paths, so it runs in a child process with this
 * directory's tsconfig (like tests/web/live-api and tests/web/data-port).
 */
const here = resolve('tests/web/commerce');

test('commerce boundary, demo projections and editor arithmetic (commerce.probe.tsx)', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', join(here, 'commerce.probe.tsx')], {
    encoding: 'utf8',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), TSX_TSCONFIG_PATH: join(here, 'tsconfig.json'), TRUSTWORK_DEMO_MODE: '1', TRUSTWORK_DEMO_PERSONA: '' },
  });
  assert.match(result.stdout, /ℹ pass [1-9]/, `the probe ran its tests\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ℹ fail 0/, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('type test: the probe compiles against the web app with its contracts', () => {
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(here, 'tsconfig.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}
const web = resolve('apps/web');
/** Source without comments, so documentation that names a forbidden field does not count as reading it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = [...files(join(web, 'app/app/procurement')), ...files(join(web, 'app/app/sales')), ...files(join(web, 'components/commerce'))].map((path) => ({ path, text: code(readFileSync(path, 'utf8')) }));

test('client components load commerce contracts as types only (no capability registry in a browser bundle)', () => {
  const offenders = sources.filter((s) => /^'use client'/.test(s.text) && /^import (?!type )[^;]*from '\.\/contracts'/m.test(s.text)).map((s) => s.path);
  assert.deepEqual(offenders, []);
});

test('the seller pages never read the buyer-private record and the buyer pages never read the seller floors', () => {
  const sales = sources.filter((s) => s.path.includes('/app/app/sales/'));
  for (const s of sales) assert.doesNotMatch(s.text, /budgetCeiling|internalNotes|evaluationWeights|shortlist|reservationId|transactionBudgetId/, s.path);
  const procurement = sources.filter((s) => s.path.includes('/app/app/procurement/'));
  for (const s of procurement) assert.doesNotMatch(s.text, /floorPrices|marginTargets|costBasis|negotiationNotes|fulfilmentPlan/, s.path);
});

test('no docked side panel and no Agents navigation in the commerce screens', () => {
  for (const s of sources) {
    assert.doesNotMatch(s.text, /href=["'`][^"'`]*\/agents/, s.path);
    assert.doesNotMatch(s.text, /position:\s*['"]?fixed/, s.path);
  }
  const css = readFileSync(join(web, 'components/commerce/commerce.css'), 'utf8');
  assert.doesNotMatch(css, /position:\s*fixed/);
});

test('every visible string comes from the locale files (no literal copy in the commerce JSX)', () => {
  const literal = />\s*[A-Za-z][a-z]+(?:\s+[a-z]+){1,}\s*</;
  for (const s of sources.filter((x) => x.path.endsWith('.tsx'))) assert.doesNotMatch(s.text, literal, s.path);
});

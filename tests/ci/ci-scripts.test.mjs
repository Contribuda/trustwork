import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { checkLockfile, expressionAllowed } from '../../scripts/ci/licenses.mjs';
import { compare, measure } from '../../scripts/ci/bundle-budget.mjs';
import { dirtyEntries } from '../../scripts/ci/assert-clean-tree.mjs';
import { formatSkipSummary } from '../../scripts/ci/skip-summary-reporter.mjs';

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('licence expressions: OR needs one allowed side, AND needs all, WITH needs the exact pair', () => {
  const allowed = new Set(['MIT', 'Apache-2.0', 'LGPL-3.0-or-later', 'GPL-2.0-only WITH Classpath-exception-2.0']);
  assert.equal(expressionAllowed('MIT', allowed), true);
  assert.equal(expressionAllowed('GPL-3.0-only', allowed), false);
  assert.equal(expressionAllowed('(MIT OR GPL-3.0-only)', allowed), true);
  assert.equal(expressionAllowed('Apache-2.0 AND LGPL-3.0-or-later AND MIT', allowed), true);
  assert.equal(expressionAllowed('Apache-2.0 AND SSPL-1.0', allowed), false, 'one disallowed AND term fails the package');
  assert.equal(expressionAllowed('(SSPL-1.0 AND MIT) OR Apache-2.0', allowed), true);
  assert.equal(expressionAllowed('GPL-2.0-only WITH Classpath-exception-2.0', allowed), true);
  assert.equal(expressionAllowed('MIT WITH Some-exception', allowed), false);
  assert.throws(() => expressionAllowed('(MIT OR', allowed), /licence expression/);
});

test('the lockfile check reports missing and disallowed licences, honours reviewed exceptions and passes the real lockfile', () => {
  const policy = { allowed: { MIT: 'permissive' }, exceptions: { 'legacy@1.0.0': 'reviewed' } };
  const lock = {
    packages: {
      '': { name: 'root' },
      'node_modules/ok': { version: '1.0.0', license: 'MIT' },
      'node_modules/copyleft': { version: '2.0.0', license: 'SSPL-1.0' },
      'node_modules/unknown': { version: '3.0.0' },
      'node_modules/legacy': { version: '1.0.0', license: 'Proprietary' },
      'node_modules/@trustwork/ui': { resolved: 'packages/ui', link: true },
    },
  };
  assert.deepEqual(checkLockfile(lock, policy).map((p) => [p.id, p.license]), [['copyleft@2.0.0', 'SSPL-1.0'], ['unknown@3.0.0', null]]);
  const real = checkLockfile(JSON.parse(readFileSync('package-lock.json', 'utf8')), JSON.parse(readFileSync('scripts/ci/license-policy.json', 'utf8')));
  assert.deepEqual(real, [], 'every package in package-lock.json is within the allowlist');
});

function fakeNextBuild(dir, sizes) {
  const random = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919 + n) % 251)); // poorly compressible
  mkdirSync(join(dir, 'static/chunks/app/(public)/projects/[slug]'), { recursive: true });
  mkdirSync(join(dir, 'server/app/(public)/projects/[slug]'), { recursive: true });
  writeFileSync(join(dir, 'static/chunks/main.js'), random(sizes.main));
  writeFileSync(join(dir, 'static/chunks/app/(public)/projects/[slug]/page.js'), random(sizes.page));
  writeFileSync(join(dir, 'static/chunks/unused.js'), random(sizes.unused));
  writeFileSync(join(dir, 'build-manifest.json'), JSON.stringify({ rootMainFiles: ['static/chunks/main.js'] }));
  writeFileSync(join(dir, 'server/app/(public)/projects/[slug]/page_client-reference-manifest.js'),
    `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/(public)/projects/[slug]/page"]=${JSON.stringify({
      clientModules: { a: { chunks: ['1', 'static/chunks/app/(public)/projects/%5Bslug%5D/page.js', '2', '/_next/static/chunks/main.js'] }, css: { chunks: ['static/css/x.css'] } },
    })};`);
  const gz = (file) => gzipSync(readFileSync(join(dir, file)), { level: 9 }).length;
  return { main: gz('static/chunks/main.js'), page: gz('static/chunks/app/(public)/projects/[slug]/page.js'), unused: gz('static/chunks/unused.js') };
}

test('bundle budget: measures shared, per-route and total gzip bytes and fails a route over budget', (t) => {
  const dir = scratch(t);
  const gz = fakeNextBuild(dir, { main: 4000, page: 6000, unused: 3000 });
  const measured = measure(dir);
  assert.equal(measured.sharedGzipBytes, gz.main);
  assert.deepEqual(measured.largestRoute, { route: '/(public)/projects/[slug]/page', gzipBytes: gz.main + gz.page }, 'URL-encoded chunk paths resolve; shared chunks count once');
  assert.equal(measured.totalGzipBytes, gz.main + gz.page + gz.unused);
  const roomy = { sharedGzipBytes: gz.main, largestRouteGzipBytes: gz.main + gz.page, totalGzipBytes: measured.totalGzipBytes };
  assert.deepEqual(compare(measured, roomy), []);
  const over = compare(measured, { ...roomy, largestRouteGzipBytes: gz.main + gz.page - 1 });
  assert.equal(over.length, 1);
  assert.match(over[0], /largest route \(\/\(public\)\/projects\/\[slug\]\/page\).*\(\+1\)/);
  assert.throws(() => compare(measured, { sharedGzipBytes: 1 }), /budget for largest route/);
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ ...roomy, totalGzipBytes: 10 }));
  const cli = spawnSync(process.execPath, [resolve('scripts/ci/bundle-budget.mjs'), dir, join(dir, 'budget.json')], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /bundle budget exceeded: all client chunks/);
  assert.throws(() => measure(join(dir, 'missing')), /build the web app first/);
});

test('clean-tree guard: a rewritten tracked file or a new untracked file is reported, ignored output is not', (t) => {
  const dir = scratch(t);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  writeFileSync(join(dir, 'next-env.d.ts'), 'tracked\n');
  git('add', '.');
  git('-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base');
  assert.deepEqual(dirtyEntries(dir), []);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist/out.js'), 'ignored');
  assert.deepEqual(dirtyEntries(dir), [], 'ignored build output does not count');
  writeFileSync(join(dir, 'next-env.d.ts'), 'rewritten by a build\n');
  writeFileSync(join(dir, 'stray.txt'), 'new');
  assert.deepEqual(dirtyEntries(dir), [' M next-env.d.ts', '?? stray.txt']);
  assert.deepEqual(dirtyEntries(dir, ['stray.txt']), ['?? stray.txt'], 'limited to the given paths');
  const cli = spawnSync(process.execPath, [resolve('scripts/ci/assert-clean-tree.mjs'), 'custom hint'], { cwd: dir, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /working tree is not clean: custom hint/);
});

test('skip summary names each skipped test and explains database skips; nothing is printed without skips', () => {
  assert.equal(formatSkipSummary([]), '');
  const summary = formatSkipSummary([
    { name: 'outbox', file: resolve('tests/data/reliability.test.ts'), reason: 'SKIPPED: no PostgreSQL (TRUSTWORK_TEST_DATABASE_URL unset)' },
    { name: 'browser', file: resolve('tests/web/web.test.ts'), reason: true },
  ]);
  assert.match(summary, /SKIPPED: 2 tests did not run/);
  assert.match(summary, /tests\/data\/reliability\.test\.ts: outbox \[SKIPPED: no PostgreSQL/);
  assert.match(summary, /tests\/web\/web\.test\.ts: browser\n/);
  assert.match(summary, /TRUSTWORK_REQUIRE_PG=1/);
  assert.doesNotMatch(formatSkipSummary([{ name: 'browser', file: 'x', reason: 'set TRUSTWORK_E2E=1' }]), /PostgreSQL/);
});

test('the reporter prints the summary at the end of a real node:test run', (t) => {
  const dir = scratch(t);
  const file = join(dir, 'skipping.test.mjs');
  writeFileSync(file, "import test from 'node:test';\ntest('runs', () => {});\ntest('needs a database', { skip: 'SKIPPED: no PostgreSQL (fixture)' }, () => {});\n");
  const reporter = new URL('../../scripts/ci/skip-summary-reporter.mjs', import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // otherwise the child reports to this runner instead of running its own reporters
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, '--test-reporter-destination=stderr', file], { encoding: 'utf8', cwd: dir, env });
  assert.equal(run.status, 0, 'a skip alone does not fail the run');
  assert.match(run.stderr, /SKIPPED: 1 test did not run/);
  assert.match(run.stderr, /skipping\.test\.mjs: needs a database \[SKIPPED: no PostgreSQL \(fixture\)\]/);
});

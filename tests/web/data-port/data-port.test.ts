import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * WEB-006 (audit finding A2): the web app's data boundary is an asynchronous `DataPort`, public entities are
 * addressed by handle and workspace objects by id, and no page reaches an adapter directly. The type test and
 * the runtime probe compile against the web app's `@/` paths, so they run in child processes with
 * `tests/web/data-port/tsconfig.json`.
 */
const root = resolve('.');
const here = resolve('tests/web/data-port');
const tsconfig = join(here, 'tsconfig.json');

test('type test: the fixture adapter satisfies the DataPort, every method is async, and the negative cases are rejected', () => {
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '-p', tsconfig], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('runtime probe: async results, handle and id addressing, private projects and anonymous workspace access', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'probe.tsx')], { encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig, TRUSTWORK_DEMO_MODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(report.source, 'fixtures');
  assert.equal(report.methods, 32, 'the port exposes the 32 data functions');
  assert.deepEqual(report.nonPromise, [], 'every port method returns a promise');
  assert.deepEqual(report.syncThrows, [], 'failures arrive as rejections, never as synchronous throws');
  assert.equal(report.personHandleRoundTrip, true);
  assert.equal(report.personHrefUsesHandle, true);
  assert.equal(report.companyHandleRoundTrip, true);
  assert.equal(report.projectHandleRoundTrip, true);
  assert.deepEqual(report.unknownHandle, [null, null, null], 'unknown handles resolve to null (404, existence not disclosed)');
  assert.equal(report.publicLookupById, null, 'public lookups take handles, not ids');
  assert.deepEqual(report.principal, { kind: 'person', hasHandle: true });
  assert.equal(report.anonymousPrincipal, null);
  assert.equal(report.workspaceIdRoundTrip, true);
  assert.equal(report.workspaceLookupByHandle, null, 'workspace objects are addressed by id, not by handle');
  assert.ok((report.privateProjects as number) > 0, 'the fixtures contain non-public projects to check');
  assert.equal(report.privateProjectsPublic, 0, 'non-public projects never resolve through the public port');
  assert.equal(report.anonymousWorkspace, 'rejected', 'workspace reads reject an anonymous principal');
  assert.equal(report.concurrentHomeEqual, true);
});

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.next') || entry.name === 'dist' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test('no page, layout, route or component imports an adapter or the fixture store directly', () => {
  const web = resolve('apps/web');
  const boundary = join(web, 'app/_lib/data');
  const offenders: string[] = [];
  for (const file of [...sources(join(web, 'app')), ...sources(join(web, 'components'))]) {
    if (file.startsWith(boundary)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const target = /from ['"]([^'"]*_lib\/data(?:\/[\w-]+)?)['"]/.exec(line)?.[1];
      if (!target || target.endsWith('_lib/data')) continue;
      // View models and the port type may be imported type-only (client components must not load the boundary).
      const typeOnly = /^\s*import type /.test(line) && /\/(types|port)$/.test(target);
      if (!typeOnly) offenders.push(`${relative(root, file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'import `data` from `@/app/_lib/data`; view-model types type-only');
});

test('the boundary module exports the port instance and no adapter function', () => {
  const index = readFileSync(resolve('apps/web/app/_lib/data/index.ts'), 'utf8');
  assert.match(index, /export const data: DataPort = /);
  assert.doesNotMatch(index, /export \* from '\.\/fixture-adapter'/);
  const adapter = readFileSync(resolve('apps/web/app/_lib/data/fixture-adapter.ts'), 'utf8');
  const exported = [...adapter.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exported, ['fixtureDataPort'], 'the adapter module exports only the port implementation');
});

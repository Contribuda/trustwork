import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clientEntry = resolve(root, 'packages/contracts/src/client.ts');
const serverEntry = resolve(root, 'packages/contracts/src/index.ts');

/** Static import graph: every module reachable from an entry through import/export specifiers. */
function reachable(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)].map((m) => (m[1] ?? m[2])!);
    graph.set(file, specifiers);
    for (const spec of specifiers) if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
  }
  return graph;
}

test('the client entry reaches no node: built-ins, no Buffer and no digest computation', () => {
  const graph = reachable(clientEntry);
  assert.ok(graph.size > 20, 'graph walked');
  for (const [file, specifiers] of graph) {
    for (const spec of specifiers) {
      assert.ok(!spec.startsWith('node:'), `${file} imports ${spec}`);
      assert.ok(spec.startsWith('.') || spec === 'zod', `${file} imports unexpected package ${spec}`);
    }
    const source = readFileSync(file, 'utf8');
    assert.ok(!/\bBuffer\b/.test(source), `${file} uses Buffer`);
    assert.ok(!/\bcomputeDigest\b|\bverifyDigest\b/.test(source), `${file} references digest computation`);
    assert.ok(!file.endsWith('/common/digest.ts') && !file.includes('/server/'), `${file} is server-only`);
  }
});
test('the server entry adds exactly the digest and commercial server modules', () => {
  const server = reachable(serverEntry);
  const client = reachable(clientEntry);
  const extra = [...server.keys()]
    .filter((f) => !client.has(f))
    .map((f) => f.slice(root.length + 1))
    .sort();
  assert.deepEqual(extra, ['packages/contracts/src/common/digest.ts', 'packages/contracts/src/federation.ts', 'packages/contracts/src/index.ts', 'packages/contracts/src/server/commercial.ts']);
  assert.ok(server.get(resolve(root, 'packages/contracts/src/common/digest.ts'))!.includes('node:crypto'));
});
test('package.json exposes "." (server) and "./client" subpath entries', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'packages/contracts/package.json'), 'utf8')) as { exports: Record<string, string> };
  assert.deepEqual(pkg.exports, { '.': './src/index.ts', './client': './src/client.ts' });
});
test('the client entry bundles for the browser with esbuild and the server entry does not', (t) => {
  const esbuild = resolve(root, 'node_modules/.bin/esbuild');
  if (!existsSync(esbuild)) {
    t.skip('esbuild binary not installed; the static import-graph test above still applies');
    return;
  }
  const bundle = (entry: string) => spawnSync(esbuild, [entry, '--bundle', '--platform=browser', '--format=esm', '--log-level=error'], { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const client = bundle(clientEntry);
  assert.equal(client.status, 0, client.stderr);
  assert.ok(!/node:crypto|require\("crypto"\)/.test(client.stdout), 'client bundle must not reference crypto');
  assert.ok(client.stdout.includes('trustwork-digest-1'), 'client bundle carries the digest vocabulary');
  const server = bundle(serverEntry);
  assert.notEqual(server.status, 0, 'the server entry is expected to fail a browser bundle because of node:crypto');
  assert.match(server.stderr, /node:crypto/);
});

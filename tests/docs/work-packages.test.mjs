import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { EXCLUDES } from '../../scripts/oss-excludes.mjs';
import { PRIVATE_TASKS, available, buildPackages } from '../../scripts/work-packages.mjs';

const file = JSON.parse(readFileSync('docs/engine/work-packages.json', 'utf8'));

test('public work packages match the task graph', { skip: !existsSync('tasks/graph.json') && 'exported tree has no task graph' }, () => {
  const graph = JSON.parse(readFileSync('tasks/graph.json', 'utf8'));
  assert.deepEqual(file, buildPackages(graph), 'run node scripts/work-packages.mjs generate');
});

test('public work packages never point into private paths or owner-only tasks', () => {
  for (const p of file.packages) {
    assert.ok(!PRIVATE_TASKS.has(p.id), `${p.id} is owner-only`);
    for (const dep of p.dependsOn) assert.ok(!PRIVATE_TASKS.has(dep), `${p.id} depends on owner-only ${dep}`);
    for (const path of [...p.read, ...p.paths]) {
      assert.ok(!/^https?:/.test(path), `${p.id} links outside the repository: ${path}`);
      assert.ok(!EXCLUDES.some((x) => path === x || path.startsWith(`${x}/`)), `${p.id} points into private ${path}`);
    }
    assert.ok(existsSync(p.handbook), `${p.id} handbook chapter ${p.handbook} exists`);
  }
});

test('available packages are open and have every dependency done', () => {
  const byId = new Map(file.packages.map((p) => [p.id, p]));
  for (const p of available(file)) {
    assert.equal(p.status, 'open');
    for (const dep of p.dependsOn) assert.equal(byId.get(dep)?.status, 'done', `${p.id} waits for ${dep}`);
  }
});

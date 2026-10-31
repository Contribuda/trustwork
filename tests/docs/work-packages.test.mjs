import test from 'node:test';
import assert from 'node:assert/strict';
import { available, load, validate } from '../../scripts/work-packages.mjs';

const data = load();

test('work packages are valid: fields, statuses, dependencies, no cycles, handbook chapters exist', () => {
  assert.deepEqual(validate(data), []);
});

test('work packages never point outside the repository', () => {
  for (const p of data.packages) for (const path of [...p.read, ...p.paths]) assert.ok(!/^https?:/.test(path) && !path.startsWith('/'), `${p.id}: ${path}`);
});

test('available packages are open and have every dependency done', () => {
  const byId = new Map(data.packages.map((p) => [p.id, p]));
  for (const p of available(data)) {
    assert.equal(p.status, 'open');
    for (const dep of p.dependsOn) assert.equal(byId.get(dep)?.status, 'done', `${p.id} waits for ${dep}`);
  }
});

test('the validator catches cycles, unknown dependencies and bad statuses', () => {
  const pkg = (id, dependsOn, status = 'open') => ({ id, title: id, area: 'x', status, dependsOn, handbook: 'docs/engine/README.md', goal: 'g', read: [], steps: ['s'], acceptance: ['a'], paths: ['apps/x'] });
  const exists = () => true;
  assert.match(validate({ schemaVersion: 1, packages: [pkg('AAA-001', ['BBB-001']), pkg('BBB-001', ['AAA-001'])] }, { exists }).join('\n'), /cycle/);
  assert.match(validate({ schemaVersion: 1, packages: [pkg('AAA-001', ['ZZZ-001'])] }, { exists }).join('\n'), /unknown dependency/);
  assert.match(validate({ schemaVersion: 1, packages: [pkg('AAA-001', [], 'maybe')] }, { exists }).join('\n'), /unknown status/);
  assert.match(validate({ schemaVersion: 1, packages: [pkg('AAA-001', ['BBB-001'], 'done'), pkg('BBB-001', [])] }, { exists }).join('\n'), /done while dependency/);
});

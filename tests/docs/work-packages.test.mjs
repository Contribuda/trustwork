import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { agentContext, available, dependents, load, next, validate } from '../../scripts/work-packages.mjs';
import { parseCommand } from '../../scripts/claims.mjs';

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

test('next picks an available package that unblocks the most work, optionally within an area', () => {
  const pkg = (id, dependsOn, area = 'x', status = 'open') => ({ id, title: id, area, status, dependsOn, handbook: 'docs/engine/README.md', goal: 'g', read: [], steps: ['s'], acceptance: ['a'], paths: ['apps/x'] });
  const fixture = { schemaVersion: 1, packages: [pkg('AAA-001', [], 'x', 'done'), pkg('BBB-001', ['AAA-001'], 'data'), pkg('CCC-001', ['AAA-001'], 'country-packs'), pkg('DDD-001', ['CCC-001']), pkg('EEE-001', ['DDD-001'])] };
  assert.equal(dependents(fixture).get('CCC-001'), 2);
  assert.deepEqual(next(fixture).map((p) => [p.id, p.unblocks]), [['CCC-001', 2], ['BBB-001', 0]]);
  assert.deepEqual(next(fixture, { area: 'data' }).map((p) => p.id), ['BBB-001']);
  assert.deepEqual(next(fixture, { area: 'events' }), []);
  for (const p of next(data)) assert.ok(available(data).includes(data.packages.find((x) => x.id === p.id)));
});

test('agent-context gives every package a reading list, rules, a claim comment that parses and hand-back steps', () => {
  for (const p of data.packages) {
    const c = agentContext(data, p.id);
    assert.equal(c.read[0], 'AGENTS.md');
    assert.ok(c.read.includes(p.handbook));
    assert.ok(c.rules.length >= 5);
    const claim = parseCommand(c.claimComment);
    assert.equal(claim.command, 'claim');
    assert.equal(claim.id, p.id);
    assert.deepEqual(claim.fields.scope, p.paths);
    assert.equal(c.claimable, available(data).includes(p));
  }
  assert.equal(agentContext(data, 'NOPE-001'), null);
  const out = JSON.parse(execFileSync(process.execPath, ['scripts/work-packages.mjs', 'agent-context', 'CTRY-002', '--json'], { encoding: 'utf8' }));
  assert.deepEqual(out.paths, data.packages.find((p) => p.id === 'CTRY-002').paths);
});

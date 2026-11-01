import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { agentContext, available, dependents, issueFor, load, next, pathConflicts, validate } from '../../scripts/work-packages.mjs';
import { CLAIM_TTL_DAYS, HEARTBEAT_DAYS, LABELS, MAX_ACTIVE_CLAIMS_PER_HUMAN, packageIdFromTitle, parseCommand } from '../../scripts/claims.mjs';

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

test('packages that can run at the same time never own overlapping paths', () => {
  assert.deepEqual(pathConflicts(data), []);
  const pkg = (id, dependsOn, paths, status = 'open') => ({ id, title: id, area: 'x', status, dependsOn, handbook: 'docs/engine/README.md', goal: 'g', read: [], steps: ['s'], acceptance: ['a'], paths });
  const exists = () => true;
  const clash = { schemaVersion: 1, packages: [pkg('AAA-001', [], ['apps/api/src/modules/plans']), pkg('BBB-001', [], ['apps/api/src/modules/plans/admin'])] };
  assert.deepEqual(pathConflicts(clash), [{ a: 'AAA-001', b: 'BBB-001', path: 'apps/api/src/modules/plans' }]);
  assert.match(validate(clash, { exists }).join('\n'), /AAA-001 and BBB-001 both own apps\/api\/src\/modules\/plans/);
  const ordered = { schemaVersion: 1, packages: [pkg('AAA-001', [], ['packages/data/migrations/plans']), pkg('BBB-001', ['AAA-001'], ['packages/x']), pkg('CCC-001', ['BBB-001'], ['packages/data/migrations/plans'])] };
  assert.deepEqual(pathConflicts(ordered), [], 'a transitive dependency orders the two packages');
  const finished = { schemaVersion: 1, packages: [pkg('AAA-001', [], ['apps/x'], 'done'), pkg('BBB-001', [], ['apps/x']), pkg('CCC-001', [], ['apps/x/y'], 'rejected')] };
  assert.deepEqual(pathConflicts(finished), [], 'done and rejected packages own nothing any more');
  assert.deepEqual(pathConflicts({ schemaVersion: 1, packages: [pkg('AAA-001', [], ['apps/xy']), pkg('BBB-001', [], ['apps/x'])] }), [], 'prefixes are compared per path segment');
});

test('issue renders the GitHub issue the claims bot and the issue template expect, for every package', () => {
  const byId = new Map(data.packages.map((p) => [p.id, p]));
  for (const p of data.packages) {
    const issue = issueFor(data, p.id);
    assert.equal(issue.title, `[WP ${p.id}] ${p.title}`);
    assert.equal(packageIdFromTitle(issue.title), p.id, 'the claims bot reads the package id from the title');
    for (const heading of ['### Goal', '### Read first', '### Steps', '### Acceptance', '### Paths this package owns', '### How to claim']) assert.ok(issue.body.includes(heading), `${p.id}: ${heading}`);
    assert.ok(issue.body.includes(`**Package:** \`${p.id}\``));
    assert.ok(issue.body.includes(p.goal));
    for (const a of p.acceptance) assert.ok(issue.body.includes(`- [ ] ${a}`), `${p.id}: acceptance`);
    for (const path of p.paths) assert.ok(issue.body.includes(`- \`${path}\``), `${p.id}: path ${path}`);
    for (const dep of p.dependsOn) assert.ok(issue.body.includes(`\`${dep}\` (${byId.get(dep).status})`), `${p.id}: dependency ${dep} with status`);
    const claim = parseCommand(/```text\n([\s\S]*?)```/.exec(issue.body)[1]);
    assert.equal(claim.command, 'claim');
    assert.equal(claim.id, p.id);
    assert.deepEqual(claim.fields.scope, p.paths);
    assert.deepEqual(issue.labels, ['work-package', available(data).includes(p) ? LABELS.ready.name : LABELS.waiting.name]);
    assert.ok(!issue.body.includes('](docs/'), `${p.id}: links are absolute so they work inside an issue`);
  }
  assert.equal(issueFor(data, 'NOPE-001'), null);
  const text = issueFor(data, 'CTRY-002').body;
  assert.ok(text.includes(`every ${HEARTBEAT_DAYS} days`) && text.includes(`for ${CLAIM_TTL_DAYS} days expires`) && text.includes(`at most ${MAX_ACTIVE_CLAIMS_PER_HUMAN} active claims`), 'the claim rules match the claims bot');
  assert.ok(issueFor(data, 'CTRY-002', { repo: 'someone/fork' }).body.includes('https://github.com/someone/fork/blob/main/'));
  const out = JSON.parse(execFileSync(process.execPath, ['scripts/work-packages.mjs', 'issue', 'CTRY-002', '--json'], { encoding: 'utf8' }));
  assert.deepEqual(out, issueFor(data, 'CTRY-002'));
  const plain = execFileSync(process.execPath, ['scripts/work-packages.mjs', 'issue', 'CTRY-002'], { encoding: 'utf8' });
  assert.ok(plain.startsWith(`[WP CTRY-002] ${byId.get('CTRY-002').title}\n\n**Package:**`));
  assert.throws(() => execFileSync(process.execPath, ['scripts/work-packages.mjs', 'issue', 'NOPE-001'], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 2);
});

test('literal ADM-UX identifiers validate without admitting arbitrary compound prefixes', () => {
  const base = { title: 'Synthetic package', area: 'test', status: 'open', dependsOn: [], handbook: 'docs/engine/README.md', goal: 'g', read: [], steps: ['s'], acceptance: ['a'], paths: ['apps/synthetic'] };
  for (const id of ['ADM-UX-001', 'ADM-UX-002', 'ADM-001', 'CTRY-MX']) {
    assert.deepEqual(validate({ schemaVersion: 1, packages: [{ ...base, id }] }, { exists: () => true }), [], id);
  }
  for (const id of ['ADM-UX-01', 'ADM-UX-0001', 'ADM-UX-001-extra', 'OTHER-UX-001']) {
    assert.ok(validate({ schemaVersion: 1, packages: [{ ...base, id }] }, { exists: () => true }).length, id);
  }
});

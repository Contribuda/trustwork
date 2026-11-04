import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { baseRevision, lateMigrations, migrationNames } from '../../scripts/ci/migration-order.mjs';

const SCRIPT = resolve('scripts/ci/migration-order.mjs');
const DIR = 'packages/data/migrations';
const AUTHOR = { GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
/** The inherited GITHUB_* variables describe this suite's own CI run, not the scratch repository. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_') && !key.startsWith('GIT_')));

/** A scratch repository whose `origin/main` is a plain ref, so nothing touches the network. */
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-migration-order-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), ...AUTHOR }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const add = (...paths) => {
    for (const path of paths) {
      const file = join(dir, DIR, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'SELECT 1;\n');
    }
    git('add', '-A');
    git('commit', '--quiet', '-m', `add ${paths.join(' ')}`);
    return git('rev-parse', 'HEAD');
  };
  const publish = () => git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const run = (env = {}, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), ...env } });
  git('init', '--quiet', '-b', 'main');
  return { dir, git, add, publish, run };
}

/** Main as it really happened: the screening file with the later timestamp merged first, the payments file after it. */
function mainWithHistoricalInversion(t) {
  const repo = repository(t);
  repo.add('20261027120000_core_functions.sql');
  repo.add('screening-notices/20261203100000_screening_staff_notice.sql');
  repo.add('payments/20261201100000_payment_rail_guard.sql');
  repo.publish();
  return repo;
}

test('only files directly in the root or one module directory, under the runner\'s name rule, are migrations', () => {
  assert.deepEqual([...migrationNames([
    `${DIR}/20261027120000_core_functions.sql`,
    `${DIR}/claims/20261206100000_claims_notices.sql`,
    `${DIR}/claims/.gitkeep`,
    `${DIR}/claims/deep/20261206100000_nested.sql`,
    `${DIR}/claims/20261206_short.sql`,
    'packages/data/src/20261206100000_elsewhere.sql',
    '',
  ])], ['20261027120000_core_functions.sql', '20261206100000_claims_notices.sql']);
});

test('an added file is judged against the newest base file by the whole name, as the runner sorts', () => {
  const base = new Set(['20261201100000_b.sql', '20261203100000_b.sql']);
  assert.deepEqual(lateMigrations(base, new Set([...base, '20261202100000_x.sql', '20261204100000_y.sql'])),
    { newest: '20261203100000_b.sql', added: ['20261202100000_x.sql', '20261204100000_y.sql'], late: ['20261202100000_x.sql'] });
  assert.deepEqual(lateMigrations(base, new Set([...base, '20261203100000_a.sql'])).late, ['20261203100000_a.sql'], 'an equal timestamp still sorts by the name');
  assert.deepEqual(lateMigrations(base, new Set([...base, '20261203100000_c.sql'])).late, []);
  assert.deepEqual(lateMigrations(new Set(), new Set(['20261201100000_a.sql'])).late, [], 'an empty base has nothing to sort before');
});

test('several added files are each judged against the base, never against each other', () => {
  const base = new Set(['20261203100000_b.sql']);
  assert.deepEqual(lateMigrations(base, new Set([...base, '20261204100000_y.sql', '20261205100000_z.sql'])).late, []);
});

test('the base is origin/main, except that a merge-queue group is judged against its parent', () => {
  assert.equal(baseRevision({}, () => assert.fail('no event is read outside a merge group')), 'origin/main');
  assert.equal(baseRevision({ GITHUB_EVENT_NAME: 'pull_request' }, () => assert.fail('a pull request has no group')), 'origin/main');
  assert.equal(baseRevision({ GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: 'e.json' }, (path) => ({ merge_group: { base_sha: `parent-from-${path}` } })), 'parent-from-e.json');
  assert.throws(() => baseRevision({ GITHUB_EVENT_NAME: 'merge_group' }, () => ({})), /base_sha/);
});

test('existing history passes: the 20261201 file that merged after 20261203 is never judged', (t) => {
  const repo = mainWithHistoricalInversion(t);
  const onMain = repo.run();
  assert.equal(onMain.status, 0, onMain.stderr);
  assert.match(onMain.stdout, /0 added migration/);
  repo.git('checkout', '--quiet', '-b', 'docs-only');
  writeFileSync(join(repo.dir, 'note.md'), 'text\n');
  repo.git('add', '-A');
  repo.git('commit', '--quiet', '-m', 'docs');
  assert.equal(repo.run().status, 0, 'a branch with no migration passes on top of the inversion');
  repo.git('checkout', '--quiet', 'main');
  repo.git('checkout', '--quiet', '-b', 'newer');
  repo.add('claims/20261204100000_claims.sql');
  assert.equal(repo.run().status, 0, 'a file after the newest passes although the newest is not the last one merged');
});

test('a pull request adding a migration before the newest fails and names the file and the newest', (t) => {
  const repo = mainWithHistoricalInversion(t);
  repo.git('checkout', '--quiet', '-b', 'late');
  repo.add('claims/20261202100000_late.sql');
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /20261202100000_late\.sql/);
  assert.match(result.stderr, /before 20261203100000_screening_staff_notice\.sql/);
});

test('the order spans the root and every module directory', (t) => {
  const repo = repository(t);
  repo.add('plans/20261203100000_plans.sql');
  repo.publish();
  repo.git('checkout', '--quiet', '-b', 'late-root');
  repo.add('20261202100000_root.sql');
  assert.equal(repo.run().status, 1);
});

test('one late file among good ones fails, naming only the late one', (t) => {
  const repo = mainWithHistoricalInversion(t);
  repo.git('checkout', '--quiet', '-b', 'mixed');
  repo.add('claims/20261202100000_late.sql', 'claims/20261204100000_fine.sql');
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 added migration/);
  assert.doesNotMatch(result.stderr, /20261204100000_fine/);
});

test('a branch that fell behind passes on its own head and fails on the merge CI checks out', (t) => {
  const repo = mainWithHistoricalInversion(t);
  repo.git('checkout', '--quiet', '-b', 'behind');
  repo.add('claims/20261204100000_claims.sql');
  repo.git('checkout', '--quiet', 'main');
  repo.add('billing/20261205100000_billing.sql');
  repo.publish();
  repo.git('checkout', '--quiet', 'behind');
  assert.equal(repo.run().status, 0, 'against its merge base the file is the newest, and main\'s newer file does not count as added or removed');
  repo.git('checkout', '--quiet', 'main');
  repo.git('checkout', '--quiet', '--detach');
  repo.git('merge', '--quiet', '--no-ff', '-m', 'synthetic pull request merge', 'behind');
  const merged = repo.run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal(merged.status, 1, merged.stdout);
  assert.match(merged.stderr, /20261204100000_claims\.sql/);
  assert.match(merged.stderr, /before 20261205100000_billing\.sql/);
});

test('moving a migration between modules adds nothing', (t) => {
  const repo = mainWithHistoricalInversion(t);
  repo.git('checkout', '--quiet', '-b', 'move');
  repo.git('mv', `${DIR}/payments/20261201100000_payment_rail_guard.sql`, `${DIR}/20261201100000_payment_rail_guard.sql`);
  repo.git('commit', '--quiet', '-m', 'move');
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 added migration/);
});

test('renaming a migration to an earlier name counts as adding that name', (t) => {
  const repo = mainWithHistoricalInversion(t);
  repo.git('checkout', '--quiet', '-b', 'rename');
  repo.git('mv', `${DIR}/payments/20261201100000_payment_rail_guard.sql`, `${DIR}/payments/20261201100001_payment_rail_guard.sql`);
  repo.git('commit', '--quiet', '-m', 'rename');
  assert.equal(repo.run().status, 1);
});

test('in a merge-queue group the second pull request is ordered against the first', (t) => {
  const repo = mainWithHistoricalInversion(t);
  repo.git('checkout', '--quiet', '--detach');
  const first = repo.add('sourcing/20261211100000_sourcing.sql');
  repo.add('billing/20261209100000_billing.sql');
  const event = join(repo.dir, 'event.json');
  writeFileSync(event, JSON.stringify({ merge_group: { base_sha: first } }));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: event };
  const group = repo.run(env);
  assert.equal(group.status, 1, group.stdout);
  assert.match(group.stderr, /20261209100000_billing\.sql/);
  assert.equal(repo.run().status, 0, 'against main alone both files are newer, which is why the group parent is the base');
});

test('without a merge base CI fails and a local clone is left to CI', (t) => {
  const repo = repository(t);
  repo.add('20261027120000_core_functions.sql');
  const local = repo.run();
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /skipped/);
  const ci = repo.run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal(ci.status, 1, 'CI never passes by not looking');
  assert.match(ci.stderr, /fetch-depth: 0/);
});

test('an explicit base revision replaces origin/main', (t) => {
  const repo = mainWithHistoricalInversion(t);
  const before = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '--quiet', '-b', 'late');
  repo.add('claims/20261202100000_late.sql');
  repo.publish();
  assert.equal(repo.run().status, 0, 'once on origin/main it is history');
  assert.equal(repo.run({}, before).status, 1);
});

test('npm run check runs the guard, and the job that runs it has the history it needs', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.check, /npm run check:migrations/);
  assert.equal(pkg.scripts['check:migrations'], 'node scripts/ci/migration-order.mjs');
  const job = /\n {2}check:\n[\s\S]*?\n {2}browser:/.exec(readFileSync('.github/workflows/check.yml', 'utf8'))?.[0] ?? '';
  assert.match(job, /actions\/checkout@[^\n]*\n\s+with:\n(?:\s+#[^\n]*\n)*\s+fetch-depth: 0\n/);
});

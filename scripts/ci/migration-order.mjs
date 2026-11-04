// Fails a change that adds a migration sorting before the newest migration on its merge base with main.
//
// The runner refuses a pending file that sorts before an applied one (packages/data/src/migrate/runner.ts), but CI
// migrates fresh databases, where nothing is applied yet, so a late timestamp only surfaces on a database that already
// holds the newer file. This check brings that refusal forward to the pull request.
//
// Only files the change adds are judged. Files already on the base are history, whatever their order: 20261201 merged
// after 20261203 once, and a released file is never renamed (the file name is the ledger identity).
//
// The base is `origin/main`. On a pull request CI checks out the merge of the branch into main, so the merge base is
// main itself and a branch that fell behind is judged against what it would land on. A merge-queue group is judged
// against the group's parent, so two pull requests in one group are ordered against each other as well.
//
// Usage: node scripts/ci/migration-order.mjs [base-revision]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIGRATIONS = 'packages/data/migrations';
/** The runner's file name rule, in the flat root or one module directory. Anything else the runner refuses by itself. */
const MIGRATION_PATH = new RegExp(`^${MIGRATIONS}/(?:[^/]+/)?(\\d{14}_[a-z0-9_]+\\.sql)$`);

/** Bare file names, because the bare name is the ledger identity: moving a file between modules adds nothing. */
export function migrationNames(paths) {
  return new Set(paths.flatMap((path) => {
    const match = MIGRATION_PATH.exec(path);
    return match ? [match[1]] : [];
  }));
}

/** Compares with `<` on the whole file name, as the runner does. Returns the added files that sort before the newest base file. */
export function lateMigrations(baseNames, headNames) {
  const newest = [...baseNames].reduce((latest, name) => (name > latest ? name : latest), '');
  const added = [...headNames].filter((name) => !baseNames.has(name)).sort();
  return { newest, added, late: added.filter((name) => name < newest) };
}

/** The merge-queue group's parent, or the default branch for everything else. */
export function baseRevision(env, readEvent) {
  if (env.GITHUB_EVENT_NAME !== 'merge_group') return 'origin/main';
  const sha = readEvent(env.GITHUB_EVENT_PATH).merge_group?.base_sha;
  if (!sha) throw new Error('the merge_group event has no base_sha');
  return sha;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function namesAt(revision) {
  return migrationNames(git(['ls-tree', '-r', '--name-only', revision, '--', MIGRATIONS]).split('\n'));
}

function exists(revision) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function main(argv, env) {
  const ci = env.GITHUB_ACTIONS === 'true';
  const base = argv[0] ?? baseRevision(env, (path) => JSON.parse(readFileSync(path, 'utf8')));
  let mergeBase;
  try {
    // A queue parent can be a commit the checkout has not fetched; a missing `origin/main` has nothing to fetch.
    if (!exists(base) && /^[0-9a-f]{40}$/.test(base)) git(['fetch', '--no-tags', '--quiet', 'origin', base]);
    mergeBase = git(['merge-base', base, 'HEAD']);
  } catch (error) {
    // CI must never pass by not looking. A local clone without the remote or with shallow history is left to CI.
    const reason = `no merge base between ${base} and HEAD (${String(error.stderr ?? error.message).trim() || 'not found'})`;
    if (ci) {
      console.error(`migration order: ${reason}; the checkout needs full history (fetch-depth: 0)`);
      return 1;
    }
    console.log(`migration order: skipped, ${reason}; CI checks this on every pull request`);
    return 0;
  }
  const { newest, added, late } = lateMigrations(namesAt(mergeBase), namesAt('HEAD'));
  if (late.length) {
    console.error(`migration order: ${late.length} added migration(s) sort before ${newest}, the newest on ${mergeBase.slice(0, 12)}:`);
    for (const name of late) console.error(`  ${name}`);
    console.error('A database that already applied it refuses these files. Rename each so that it sorts after that migration.');
    return 1;
  }
  console.log(`migration order: ${added.length} added migration(s), none before ${newest || 'an empty base'} (${mergeBase.slice(0, 12)})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2), process.env);

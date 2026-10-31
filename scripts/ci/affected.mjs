// Decides which heavy CI suites a pull request needs, from the files it changes. Prints `web=<bool>` and
// `ui=<bool>` lines for $GITHUB_OUTPUT. Only pull requests may skip: pushes to main and merge-queue groups always run
// everything, so a miss here is caught before anything reaches main.
//
// Usage: node scripts/ci/affected.mjs <event-name> <base-sha> <head-sha>
import { execFileSync } from 'node:child_process';

/** Paths that cannot change what the web app builds or renders. Anything else counts as web-affecting. */
const NOT_WEB = [
  /^apps\/api\//, /^apps\/worker\//, /^packages\/data\//, /^packages\/compliance\//, /^infra\//, /^docs\//,
  /^tests\/(?!web\/|ui\/)/, /^scripts\/(claims|work-packages|restore\/)/, /^[^/]+\.md$/,
];
/** Paths the design-system suite depends on. */
const UI = [/^packages\/ui\//, /^package-lock\.json$/, /^package\.json$/, /^\.nvmrc$/, /^\.github\/workflows\//];

export function affected(event, files) {
  if (event !== 'pull_request') return { web: true, ui: true };
  return {
    web: files.length === 0 || files.some((f) => !NOT_WEB.some((r) => r.test(f))),
    ui: files.length === 0 || files.some((f) => UI.some((r) => r.test(f))),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [event, base, head] = process.argv.slice(2);
  let files = [];
  let event2 = event;
  if (event === 'pull_request') {
    try {
      // Two-dot diff needs only the two trees, so a shallow fetch is enough; a behind branch can only add files (run more).
      // Only an already shallow checkout (CI) fetches with --depth: on a full local clone --depth would make the
      // shared repository shallow for every worktree.
      const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true';
      execFileSync('git', ['fetch', '--no-tags', '--quiet', ...(shallow ? ['--depth=1'] : []), 'origin', base, head]);
      files = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (error) {
      console.error(`affected: could not diff ${base}..${head}, running every suite (${error.message})`);
      event2 = 'unknown';
    }
  }
  const result = affected(event2, files);
  console.log(`web=${result.web}`);
  console.log(`ui=${result.ui}`);
}

// Image policy check (OPS-002): node infra/images/check-images.mjs <name>=<image reference>...
//   names: web, api, worker, migrate, proxy (budgets in infra/images/budgets.json)
// For every image: a non-root USER is configured and the container really runs as a non-zero uid; the size of its
// root filesystem stays within its budget; and, for the Node images, /app holds no devDependency (every devDependency of the
// root and of each workspace that is not also a production dependency somewhere), no tests, no docs, no TypeScript
// sources and no package manager. Exit 0 when every image passes, 1 otherwise.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const budgets = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'));
const pairs = process.argv.slice(2).map((arg) => arg.split('='));
if (pairs.length === 0 || pairs.some(([name, ref]) => !name || !ref || !budgets.images[name])) {
  console.error(`usage: check-images.mjs <name>=<image>... (names: ${Object.keys(budgets.images).join(', ')})`);
  process.exit(2);
}

const manifests = [join(root, 'package.json'), ...['apps', 'packages'].flatMap((dir) => readdirSync(join(root, dir)).map((name) => join(root, dir, name, 'package.json')))]
  .map((path) => JSON.parse(readFileSync(path, 'utf8')));
const production = new Set(manifests.flatMap((m) => Object.keys({ ...m.dependencies, ...m.peerDependencies })));
const forbiddenModules = [...new Set(manifests.flatMap((m) => Object.keys(m.devDependencies ?? {})))].filter((name) => !production.has(name)).sort();

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inImage = (ref, script) => docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', ref, '-c', script]);

let failed = 0;
for (const [name, ref] of pairs) {
  const policy = budgets.images[name];
  const problems = [];
  const user = docker(['image', 'inspect', '--format', '{{.Config.User}}', ref]);
  if (!user || /^(root|0)(:|$)/.test(user)) problems.push(`USER is "${user || '(unset)'}"`);
  const uid = inImage(ref, 'id -u');
  if (uid === '0') problems.push('the container runs as uid 0');
  // Size of the root filesystem as the container sees it (du), the same on every image store and platform.
  const mib = Number(inImage(ref, 'du -skx / 2>/dev/null | cut -f1')) / 1024;
  if (mib > policy.maxMiB) problems.push(`size ${mib.toFixed(1)} MiB exceeds the budget of ${policy.maxMiB} MiB`);
  if (policy.node) {
    const modules = forbiddenModules.map((m) => `/app/node_modules/${m}`).join(' ');
    const found = inImage(ref, [
      `for p in ${modules} /app/tests /app/docs /app/tasks /app/scripts; do [ -e "$p" ] && echo "present: $p"; done`,
      // TypeScript sources: only the one-line country-pack re-export of the migrate image is allowed (see backend.Dockerfile).
      "find /app -name node_modules -prune -o -type f \\( -name '*.ts' -o -name '*.tsx' \\) ! -path /app/packages/country-packs/src/index.ts -print | sed 's/^/typescript: /' | head -5",
      "find /app -type f \\( -name '*.test.*' -o -name '*.spec.*' \\) | sed 's/^/test file: /' | head -5",
      "find /app -name node_modules -prune -o -type f -name '*.md' -print | sed 's/^/doc: /' | head -5",
      'for b in npm npx yarn corepack; do command -v "$b" >/dev/null 2>&1 && echo "package manager: $b"; done',
      'true',
    ].join('; '));
    if (found) problems.push(...found.split('\n'));
  }
  const status = problems.length ? 'FAIL' : 'ok  ';
  console.log(`${status} ${name.padEnd(8)} ${ref}  user=${user} uid=${uid} size=${mib.toFixed(1)}MiB/${policy.maxMiB}MiB`);
  for (const problem of problems) console.log(`       - ${problem}`);
  if (problems.length) failed++;
}
console.log(failed ? `${failed} image(s) failed the policy` : `all ${pairs.length} image(s) passed (forbidden modules checked: ${forbiddenModules.length})`);
process.exit(failed ? 1 : 0);

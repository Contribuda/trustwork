/**
 * Work packages: the project's list of work (docs/engine/work-packages.json), edited directly in pull requests.
 *
 *   npm run work                                   what can be picked up now (open, every dependency done)
 *   node scripts/work-packages.mjs list --all      every package with its status
 *   node scripts/work-packages.mjs list --json     machine-readable list for agents
 *   node scripts/work-packages.mjs show <ID>       one package in full
 *   node scripts/work-packages.mjs validate        schema, dependencies, cycles, handbook links (part of npm run check)
 *
 * Status changes land in pull requests: `open` → `in_progress` when a claim is confirmed in the package's
 * issue, `in_review` when its pull request is ready, `done` when a maintainer merges the accepted work.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const FILE = resolve(root, 'docs/engine/work-packages.json');

export const STATUSES = ['open', 'in_progress', 'in_review', 'done', 'blocked', 'rejected'];
const FIELDS = ['id', 'title', 'area', 'status', 'dependsOn', 'handbook', 'goal', 'read', 'steps', 'acceptance', 'paths'];
const ID = /^[A-Z][A-Z0-9]*-\d{3}$|^[A-Z]{2,5}-[A-Z]{2,3}$/;
const validPath = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((part) => part && part !== '.' && part !== '..');

export function load(file = FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Returns a list of problems; empty means the file is valid. */
export function validate(data, { exists = (p) => existsSync(resolve(root, p)) } = {}) {
  const errors = [];
  if (data.schemaVersion !== 1 || !Array.isArray(data.packages)) return ['work-packages.json: schemaVersion 1 with a packages array is required'];
  const byId = new Map();
  for (const p of data.packages) {
    for (const key of FIELDS) {
      const value = p[key];
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && key !== 'dependsOn' && key !== 'read' && !(key === 'paths' && p.status === 'done') && !value.length)) errors.push(`${p.id ?? '?'}: missing ${key}`);
    }
    if (!ID.test(p.id ?? '')) errors.push(`${p.id}: invalid id`);
    if (byId.has(p.id)) errors.push(`${p.id}: duplicate id`);
    byId.set(p.id, p);
    if (!STATUSES.includes(p.status)) errors.push(`${p.id}: unknown status ${p.status}`);
    if (p.handbook && !exists(p.handbook)) errors.push(`${p.id}: handbook chapter ${p.handbook} does not exist`);
    for (const path of [...(p.read ?? []), ...(p.paths ?? [])]) if (!validPath(path) || /^https?:/.test(path)) errors.push(`${p.id}: invalid path ${path}`);
  }
  for (const p of data.packages) {
    for (const dep of p.dependsOn ?? []) {
      if (!byId.has(dep)) errors.push(`${p.id}: unknown dependency ${dep}`);
      if (p.status === 'done' && byId.get(dep)?.status !== 'done') errors.push(`${p.id}: done while dependency ${dep} is not`);
    }
  }
  const marks = new Map();
  const visit = (id, trail) => {
    if (marks.get(id) === 'active') { errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`); return; }
    if (marks.get(id) === 'done' || !byId.has(id)) return;
    marks.set(id, 'active');
    for (const dep of byId.get(id).dependsOn ?? []) visit(dep, [...trail, id]);
    marks.set(id, 'done');
  };
  for (const id of byId.keys()) visit(id, []);
  return errors;
}

export function available(data) {
  const done = new Set(data.packages.filter((p) => p.status === 'done').map((p) => p.id));
  return data.packages.filter((p) => p.status === 'open' && p.dependsOn.every((d) => done.has(d)));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/work-packages.mjs')) {
  const [command = 'list', ...rest] = process.argv.slice(2);
  const data = load();
  if (command === 'validate') {
    const errors = validate(data);
    if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
    console.log(`work packages valid: ${data.packages.length} packages, ${available(data).length} available`);
  } else if (command === 'show') {
    const pkg = data.packages.find((p) => p.id === rest[0]);
    if (!pkg) { console.error(`unknown work package ${rest[0] ?? ''}`); process.exit(2); }
    console.log(JSON.stringify(pkg, null, 2));
  } else if (command === 'list') {
    const rows = rest.includes('--all') ? data.packages : available(data);
    if (rest.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(rest.includes('--all') ? 'All work packages:' : 'Work packages you can pick up now (open, dependencies done):');
      for (const p of rows) console.log(`  ${p.id.padEnd(10)} ${p.status.padEnd(12)} ${p.title}  [${p.handbook}]`);
      if (!rows.length) console.log('  none right now; run with --all to see everything and what each package waits for');
      console.log('\nClaim one with a /claim comment on its GitHub issue, as described in docs/engine/agent-onboarding.md.');
    }
  } else {
    console.error('usage: node scripts/work-packages.mjs list [--all] [--json] | show <ID> | validate');
    process.exit(2);
  }
}

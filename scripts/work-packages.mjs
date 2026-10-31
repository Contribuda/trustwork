/**
 * Public work packages: the community's view of the task graph (docs/engine/work-packages.json).
 *
 *   node scripts/work-packages.mjs list [--all] [--json]   what can be picked up now (works in the exported tree)
 *   node scripts/work-packages.mjs show <ID>               one package in full
 *   node scripts/work-packages.mjs generate                rebuild the file from tasks/graph.json (private repository only)
 *   node scripts/work-packages.mjs check                   fail if the file is out of date (private repository only)
 *
 * The private graph stays the source of truth for the core team; the public file drops owner-only tasks
 * (deployment, client approval, management adoption, publication) and every reference into private paths.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCLUDES } from './oss-excludes.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const FILE = resolve(root, 'docs/engine/work-packages.json');
const GRAPH = resolve(root, 'tasks/graph.json');

/** Tasks that belong to the owner's own release and business process, not to the engine. */
export const PRIVATE_TASKS = new Set(['FND-001', 'FND-003', 'RES-001', 'OSS-001', 'DEP-001', 'ACC-001', 'INT-001']);

const STATUS = { accepted: 'done', ready: 'open', leased: 'in_progress', researching: 'in_progress', proposed: 'in_progress', implementing: 'in_progress', submitted: 'in_review', reviewed: 'in_review', blocked: 'blocked', rejected: 'rejected' };

/** Handbook chapter for each lane, so a contributor (or their agent) knows what to read first. */
const CHAPTER = {
  'backend': 'people-and-companies.md', 'backend-research': 'people-and-companies.md', 'data': 'architecture.md', 'integrator-contracts': 'architecture.md',
  'design-research': 'architecture.md', 'design-system': 'architecture.md', 'frontend': 'architecture.md', 'frontend-commerce': 'commerce.md',
  'commerce-backend': 'commerce.md', 'billing': 'billing.md', 'assistant': 'agents.md', 'content-magazine': 'publishing.md', 'execution-trust': 'execution-and-reputation.md',
  'qa-release': 'status.md', 'retrieval': 'search-and-knowledge.md', 'retrieval-preparation': 'search-and-knowledge.md', 'retrieval-data': 'search-and-knowledge.md',
  'product-research': 'search-and-knowledge.md', 'platform-admin-backend': 'hub-administration.md', 'platform-admin-web': 'hub-administration.md',
  'international': 'localization.md', 'compliance': 'trust-safety-privacy.md', 'events': 'events.md', 'learning': 'learning.md', 'matching': 'partners-and-matching.md',
  'hubs': 'hubs.md', 'hubs-web': 'hub-administration.md', 'verification': 'hub-administration.md', 'country-packs': 'country-specifics.md', 'federation': 'federation.md',
};

const isPrivatePath = (p) => /^https?:/.test(p) || EXCLUDES.some((x) => p === x || p.startsWith(`${x}/`));

export function buildPackages(graph) {
  const kept = graph.tasks.filter((t) => !PRIVATE_TASKS.has(t.id));
  const keptIds = new Set(kept.map((t) => t.id));
  const packages = kept.map((t) => ({
    id: t.id,
    title: t.title,
    area: t.lane,
    status: STATUS[t.status] ?? t.status,
    dependsOn: t.dependencies.filter((d) => keptIds.has(d)),
    handbook: CHAPTER[t.lane] ? `docs/engine/${CHAPTER[t.lane]}` : 'docs/engine/README.md',
    goal: t.goal,
    read: t.inputs.filter((p) => !isPrivatePath(p)),
    steps: t.steps,
    acceptance: t.acceptance,
    paths: t.paths.filter((p) => !isPrivatePath(p)),
  }));
  return { schemaVersion: 1, source: 'Generated from the core team task graph by scripts/work-packages.mjs; do not edit by hand.', packages };
}

const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;

export function available(data) {
  const done = new Set(data.packages.filter((p) => p.status === 'done').map((p) => p.id));
  return data.packages.filter((p) => p.status === 'open' && p.dependsOn.every((d) => done.has(d)));
}

function load() {
  if (!existsSync(FILE)) throw new Error(`missing ${FILE}`);
  return JSON.parse(readFileSync(FILE, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/work-packages.mjs')) {
  const [command = 'list', ...rest] = process.argv.slice(2);
  if (command === 'generate' || command === 'check') {
    if (!existsSync(GRAPH)) { console.error('tasks/graph.json is not in this tree (the exported engine ships only docs/engine/work-packages.json).'); process.exit(2); }
    const next = serialize(buildPackages(JSON.parse(readFileSync(GRAPH, 'utf8'))));
    if (command === 'generate') { writeFileSync(FILE, next); console.log(`wrote ${FILE}`); }
    else if (!existsSync(FILE) || readFileSync(FILE, 'utf8') !== next) { console.error('docs/engine/work-packages.json is out of date: run node scripts/work-packages.mjs generate'); process.exit(1); }
    else console.log('work packages are up to date');
  } else if (command === 'show') {
    const pkg = load().packages.find((p) => p.id === rest[0]);
    if (!pkg) { console.error(`unknown work package ${rest[0] ?? ''}`); process.exit(2); }
    console.log(JSON.stringify(pkg, null, 2));
  } else if (command === 'list') {
    const data = load();
    const rows = rest.includes('--all') ? data.packages : available(data);
    if (rest.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(rest.includes('--all') ? 'All work packages:' : 'Work packages you can pick up now (open, dependencies done):');
      for (const p of rows) console.log(`  ${p.id.padEnd(10)} ${p.status.padEnd(12)} ${p.title}  [${p.handbook}]`);
      if (!rows.length) console.log('  none right now; run with --all to see everything and what each package waits for');
      console.log('\nClaim one by commenting on its GitHub issue as described in docs/engine/agent-onboarding.md.');
    }
  } else {
    console.error('usage: node scripts/work-packages.mjs list [--all] [--json] | show <ID> | generate | check');
    process.exit(2);
  }
}

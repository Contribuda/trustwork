#!/usr/bin/env node
/**
 * Exports the engine into a fresh directory with no git history (OSS-001, ADR-009 decision 4).
 *
 *   node scripts/export-open-source.mjs <target-dir> [--ref HEAD] [--init]
 *
 * - Copies the tracked tree at `--ref` (default HEAD) with `git archive`, so untracked files, local
 *   caches and ignored artefacts never leave this repository.
 * - Removes deployment-specific and private material (operator evidence, Railway/Contribuddha
 *   infrastructure, agent coordination state, owner result files) listed in EXCLUDES.
 * - Rewrites Markdown links to excluded private records as plain text.
 * - Writes EXPORT-MANIFEST.json with the source commit, date and the exclusion list.
 * - With `--init`, runs `git init` in the target and makes a single commit; it never adds a remote
 *   and never pushes. Publishing is the owner's action only.
 * - Runs gitleaks on the export when the binary is on PATH; otherwise prints how to run it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { EXCLUDES } from './oss-excludes.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node scripts/export-open-source.mjs <target-dir> [--ref HEAD] [--init]');
  process.exit(2);
}
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : 'HEAD';
const init = args.includes('--init');
const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(target);


/** Lines to drop from exported files because they point at excluded private records. */
const SCRUB = {
  'docs/adr/README.md': ['005-delivery-coordination.md', '006-contribuddha-and-orbit.md'],
  'docs/adr/009-international-engine-and-open-source.md': ['docs/product/open-decisions.md'],
};
/** Scripts of the private repository that have no meaning without the excluded tooling. */
const DROP_SCRIPTS = ['claim'];

if (existsSync(out) && readdirSync(out).length) {
  console.error(`target ${out} is not empty`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const sha = execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
const tar = spawnSync('sh', ['-c', `git archive --format=tar ${sha} | tar -x -C "${out}"`], { cwd: root, stdio: 'inherit' });
if (tar.status !== 0) process.exit(tar.status ?? 1);

for (const rel of EXCLUDES) {
  const p = join(out, rel);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// The exported README is the community README; the brand overlay becomes the neutral stub.
// Files promoted from docs/oss to the root keep working links: targets are rewritten from docs/oss-relative to root-relative.
const promote = (from, to) => {
  const text = readFileSync(join(out, from), 'utf8').replace(/\]\(([^)\s#:]+)(#[^)]*)?\)/g, (whole, link, anchor = '') => `](${relative(dirname(join(out, to)), join(dirname(join(out, from)), link)) || '.'}${anchor})`);
  writeFileSync(join(out, to), text);
};
promote('docs/oss/README-operators.md', 'README.md');
// Coding agents get the public instructions: Codex and most tools read AGENTS.md, Claude Code reads CLAUDE.md, which imports it.
promote('docs/oss/AGENTS-public.md', 'AGENTS.md');
writeFileSync(join(out, 'CLAUDE.md'), '@AGENTS.md\n');
mkdirSync(join(out, 'apps/web/brand'), { recursive: true });
writeFileSync(join(out, 'apps/web/brand/index.ts'), `import type { BrandOverlay } from '@trustwork/ui/brand';\n\n/** Engine default: no deployment brand overlay (Trustwork lettering and strings). */\nexport const brandOverlay: BrandOverlay | null = null;\n`);
// Index rows and links that point at excluded private records are dropped from the exported copies.
for (const [rel, patterns] of Object.entries(SCRUB)) {
  const file = join(out, rel);
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => !patterns.some((p) => line.includes(p)));
  writeFileSync(file, lines.join('\n'));
}
// Any remaining Markdown link whose target is an excluded private record becomes plain text, so the public copy has no dead links.
const isPrivate = (rel) => EXCLUDES.some((x) => rel === x || rel.startsWith(`${x}/`));
const markdownFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name === '.git') return [];
  const p = join(dir, e.name);
  return e.isDirectory() ? markdownFiles(p) : e.name.endsWith('.md') ? [p] : [];
});
let unlinked = 0;
for (const file of markdownFiles(out)) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(/\[([^\]\n]+)\]\(([^)\s#:]+)(#[^)]*)?\)/g, (whole, text, link) => {
    const target = resolve(dirname(file), link);
    if (existsSync(target)) return whole;
    if (!isPrivate(relative(out, target))) return whole;
    unlinked += 1;
    return `${text} (private repository record, not exported)`;
  });
  if (after !== before) writeFileSync(file, after);
}
if (unlinked) console.log(`unlinked ${unlinked} Markdown references to private records`);

const pkgPath = join(out, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
for (const name of DROP_SCRIPTS) delete pkg.scripts[name];
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const manifest = {
  exportedAt: new Date().toISOString(),
  sourceCommit: sha,
  excludes: EXCLUDES,
  licence: 'AGPL-3.0-only (LICENSE); the Trustwork name and three-squares mark are the owner\'s (NOTICE)',
  publish: 'only the repository owner publishes; this script never adds a remote or pushes',
};
writeFileSync(join(out, 'EXPORT-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const gitleaks = spawnSync('gitleaks', ['--version'], { encoding: 'utf8' });
if (gitleaks.status === 0) {
  const config = existsSync(join(out, '.gitleaks.toml')) ? ['--config', join(out, '.gitleaks.toml')] : [];
  const scan = spawnSync('gitleaks', ['dir', out, '--no-banner', '--redact', ...config, '--report-format', 'json', '--report-path', `${out}.gitleaks.json`], { stdio: 'inherit' });
  console.log(scan.status === 0 ? 'gitleaks: no leaks found' : `gitleaks exit ${scan.status}: review the report next to the export directory`);
  if (scan.status !== 0) process.exitCode = 3;
} else {
  console.log(`gitleaks not on PATH; run: gitleaks dir "${out}" --config "${join(out, '.gitleaks.toml')}" --redact`);
}

if (init) {
  const run = (cmd, a) => {
    const r = spawnSync(cmd, a, { cwd: out, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['add', '-A']);
  run('git', ['-c', 'user.name=engine-export', '-c', 'user.email=export@localhost', 'commit', '-q', '-m', `Initial import of the engine (exported from ${sha.slice(0, 12)}, history not carried over)`]);
  console.log('initialised a fresh repository with one commit; no remote configured');
}
console.log(`exported ${sha.slice(0, 12)} to ${out}`);

// Documentation and project-data validation (part of npm run check):
// local Markdown links, work packages, requirement traceability, the public navigation invariant, JSON validity
// and file sizes.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { load as loadWorkPackages, validate as validateWorkPackages } from './work-packages.mjs';

const root = process.cwd();
const errors = [];
const skip = new Set(['.git', 'node_modules', '.next', 'dist', 'work', 'coverage']);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (skip.has(e.name) || e.name.startsWith('.next') ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(root);

for (const file of files.filter((p) => p.endsWith('.md'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    let link = m[1].split(/\s+"/)[0].replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    link = decodeURIComponent(link.split('#')[0]);
    if (link && !existsSync(resolve(dirname(file), link))) errors.push(`Broken local link: ${relative(root, file)} -> ${link}`);
  }
}

const workPackages = loadWorkPackages();
errors.push(...validateWorkPackages(workPackages));
const packageIds = new Set(workPackages.packages.map((p) => p.id));

const locale = JSON.parse(readFileSync('packages/ui/locales/ru.json', 'utf8'));
if (JSON.stringify(locale.publicNav) !== JSON.stringify(['Главная', 'Новости', 'Статьи', 'События', 'Компании', 'Люди', 'Проекты', 'Журнал'])) errors.push('Public navigation drift');

const trace = JSON.parse(readFileSync('docs/product/traceability.json', 'utf8'));
const specIds = [...readFileSync('docs/product/specification.md', 'utf8').matchAll(/^\| (R\d{2}) \|/gm)].map((m) => m[1]);
if (!specIds.length || new Set(specIds).size !== specIds.length) errors.push('Missing or duplicate specification requirements');
const traceIds = trace.requirements.map((x) => x.id);
if (new Set(traceIds).size !== traceIds.length) errors.push('Duplicate requirement trace');
for (const id of specIds) if (!traceIds.includes(id)) errors.push(`Missing requirement trace ${id}`);
for (const id of traceIds) if (!specIds.includes(id)) errors.push(`Unknown requirement trace ${id}`);
for (const row of trace.requirements) for (const id of row.tasks) if (!packageIds.has(id)) errors.push(`Trace ${row.id}: unknown work package ${id}`);

// Documentation is English only (owner rule, 2026-10-31): Russian is one interface language and lives in locale files and
// the brand overlay, never in Markdown or plain-text docs.
for (const file of files.filter((p) => p.endsWith('.md') || p.endsWith('.txt'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => { if (/[\u0400-\u04FF]/.test(line)) errors.push(`Cyrillic text in documentation: ${relative(root, file)}:${i + 1} (docs are English only; quote the English UI label and its locale key)`); });
}

// Leftover merge-conflict markers in any tracked text file.
const textFile = (p) => /\.(md|txt|json|ya?ml|ts|tsx|mjs|js|cjs|css|sql|example|toml)$|(^|\/)(Dockerfile|\.env\.example|NOTICE|LICENSE)$/.test(p);
for (const file of files.filter(textFile)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => { if (/^(<{7}|>{7})( |$)|^={7}$/.test(line)) errors.push(`Merge-conflict marker: ${relative(root, file)}:${i + 1}`); });
}

for (const p of files.filter((f) => f.endsWith('.json'))) {
  try { JSON.parse(readFileSync(p, 'utf8')); } catch { errors.push(`Invalid JSON ${relative(root, p)}`); }
}
for (const file of files.filter((p) => statSync(p).size > 50 * 1024 * 1024)) errors.push(`Oversize file ${relative(root, file)}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated local Markdown links, ${workPackages.packages.length} work packages, ${specIds.length} requirements and the navigation invariant.`);
}

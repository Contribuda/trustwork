// Merges per-worker axe results written by tests/e2e/a11y.spec.ts into dist/axe-summary.json.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist/axe';
const results = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .flatMap((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  .sort((a, b) => a.id.localeCompare(b.id));
const summary = { generatedAt: new Date().toISOString(), stories: results.length, violations: results.reduce((n, r) => n + r.violations, 0), results };
writeFileSync('dist/axe-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
console.log(`axe: ${summary.stories} stories scanned, ${summary.violations} violations`);

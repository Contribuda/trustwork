import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CTRY-EU acceptance: no engine code branches on EU membership. Engine code reads layer facts through
 * `layeredFactsFor`; a layer code or a list of member states never appears in code. Layer data also stays out of the
 * package index (and so out of browser bundles): only the `@trustwork/country-packs/layers` entry point reaches it.
 */

const ROOTS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', 'test-results', 'playwright-report']);
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith('.next')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return entry.isFile() && CODE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const FILES = ROOTS.flatMap((root) => codeFiles(root));
const MEMBERS = (JSON.parse(readFileSync('packages/country-packs/layers/eu.json', 'utf8')) as { members: { codes: string[] } }).members.codes;

test('no engine code names the EU layer code or a membership flag', () => {
  assert.ok(FILES.length > 100, 'the scan sees the engine sources');
  const offenders: string[] = [];
  const patterns = [/(['"`])EU\1/, /\bis_?eu\b/i, /\beu_?member/i, /\bEU_(?:MEMBERS|COUNTRIES|STATES)\b/];
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no engine code carries a list of member states', () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const quoted = new Set([...line.matchAll(/['"`]([A-Z]{2})['"`]/g)].map((m) => m[1]!));
      const members = MEMBERS.filter((code) => quoted.has(code));
      if (members.length >= 6) offenders.push(`${file}:${index + 1}: ${members.join(',')}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('layer data is reached only through the layers entry point, never from the package index or the web app', () => {
  const index = readFileSync('packages/country-packs/src/index.ts', 'utf8');
  assert.equal(/layers/.test(index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/LayerResolution/g, '')), false, 'the index does not re-export layers.ts');
  for (const file of FILES) {
    if (file.startsWith(join('packages', 'country-packs'))) continue;
    const text = readFileSync(file, 'utf8');
    assert.equal(/layers\/eu\.json/.test(text), false, `${file} does not import the layer file`);
    if (file.startsWith(join('apps', 'web'))) assert.equal(text.includes('@trustwork/country-packs/layers'), false, `${file} (web) does not import layer data`);
  }
});

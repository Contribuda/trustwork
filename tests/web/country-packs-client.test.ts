import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Country-pack facets stay on the server: nothing a client component reaches imports the full `@trustwork/country-packs`
 * entry (every pack with its facets, the validator and the country dataset) or `@trustwork/config` (which imports it).
 * Client components read packs through `@trustwork/country-packs/client` (the v1 subset of the built-in packs) and get
 * the visitor's own pack from the server (`rootClientLocale`, `LocaleProvider`). The built chunks are checked in CI by
 * the `serverOnlyMarkers` of scripts/ci/bundle-budget.json.
 */
const WEB = resolve(import.meta.dirname, '../../apps/web');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const SERVER_ONLY = ['@trustwork/country-packs', '@trustwork/config', '@trustwork/config/server'];

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(WEB, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** Every web module reachable at runtime from the client components (type-only imports are erased and do not count). */
function clientGraph(): Map<string, string[]> {
  const entries = [...walk(join(WEB, 'app')), ...walk(join(WEB, 'components'))].filter((f) => /\.tsx?$/.test(f) && /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')));
  const graph = new Map<string, string[]>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    // A server action module ('use server') reaches the browser only as a reference: its imports never ship.
    if (!entries.includes(file) && /^\s*['"]use server['"]/.test(source)) { graph.set(file, []); continue; }
    const specifiers = [...source.matchAll(/^(?:import|export)\s(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)].map((m) => (m[1] ?? m[2])!);
    graph.set(file, specifiers);
    for (const spec of specifiers) {
      if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
      const target = resolveLocal(file, spec);
      if (target && /\.tsx?$/.test(target)) queue.push(target);
    }
  }
  return graph;
}

test('no module a client component reaches imports the full country-pack entry or the deployment configuration', () => {
  const graph = clientGraph();
  assert.ok(graph.size > 50, `${graph.size} client modules walked`);
  const offenders = [...graph].flatMap(([file, specifiers]) => specifiers.filter((s) => SERVER_ONLY.includes(s)).map((s) => `${relative(WEB, file)} imports ${s}`));
  assert.deepEqual(offenders, []);
  const viaClientEntry = [...graph].filter(([, specifiers]) => specifiers.includes('@trustwork/country-packs/client')).map(([file]) => relative(WEB, file)).sort();
  for (const shared of ['app/_lib/country.ts', 'app/_lib/i18n.ts', 'components/commerce/amounts.ts', 'components/locale/LocaleProvider.tsx']) assert.ok(viaClientEntry.includes(shared), `${shared} reads packs through the client entry`);
});

test('the server hands the browser only the client subset of the visitor pack, never a full pack', () => {
  const locale = readFileSync(join(WEB, 'app/_lib/locale.ts'), 'utf8');
  assert.match(locale, /function packForBrowser\(\): ClientPack \| null \{[\s\S]*?toClientPack\(pack\)/);
  assert.match(locale, /setCountryPackResolver\(getCountryPack\);/);
  const provider = readFileSync(join(WEB, 'components/locale/LocaleProvider.tsx'), 'utf8');
  assert.match(provider, /pack\?: ClientPack \| null/);
  assert.doesNotMatch(provider, /CountryPack\b/);
});

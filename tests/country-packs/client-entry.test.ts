import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_CLIENT_PACKS, clientPacks, formatMoney as clientMoney, genericClientPack, getClientPack, toClientPack } from '@trustwork/country-packs/client';
import { BUILT_IN_PACKS, COUNTRIES, formatMoney, genericPack, getCountry, getPack, installPacks, resetPacks } from '@trustwork/country-packs';

/**
 * The browser entry of the country packs (`@trustwork/country-packs/client`) carries the v1 subset of the built-in
 * packs and nothing else: no facets, sources or verification notes, no validator, no facet schemas and no country
 * dataset. The built web app is checked too: `serverOnlyMarkers` in scripts/ci/bundle-budget.json fail the CI bundle
 * step when facet text reaches any client chunk.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clientEntry = resolve(root, 'packages/country-packs/src/client.ts');

/** Runtime import graph from an entry: `import type` lines are erased by the compiler and do not count. */
function runtimeGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/^(?:import|export)\s(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)].map((m) => (m[1] ?? m[2])!);
    graph.set(file, specifiers);
    for (const spec of specifiers) if (spec.startsWith('.') && !spec.endsWith('.json')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
  }
  return graph;
}

test('the client entry reaches only itself and the generated summaries: no zod, schemas, validator, pack files or country dataset', () => {
  const graph = runtimeGraph(clientEntry);
  assert.deepEqual([...graph.keys()].map((f) => f.slice(root.length + 1)).sort(), ['packages/country-packs/src/client-packs.generated.ts', 'packages/country-packs/src/client.ts']);
  for (const [file, specifiers] of graph) for (const spec of specifiers) assert.ok(spec.startsWith('./') && !spec.endsWith('.json'), `${file} imports ${spec} at runtime`);
});

test('package.json exposes "." (server), "./client" (browser) and "./layers" (server, CTRY-EU) entries', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'packages/country-packs/package.json'), 'utf8')) as { exports: Record<string, string> };
  assert.deepEqual(pkg.exports, { '.': './src/index.ts', './client': './src/client.ts', './layers': './src/layers.ts' });
});

test('the generated summaries are exactly the client subset of the pack files (regenerate with npm run generate:client -w @trustwork/country-packs)', () => {
  assert.deepEqual(BUILT_IN_CLIENT_PACKS, BUILT_IN_PACKS.map((pack) => toClientPack(pack)));
});

test('no facet, source, note or verification text is in the browser data, and it is a small fraction of the packs', () => {
  const data = JSON.stringify(BUILT_IN_CLIENT_PACKS);
  for (const key of ['facets', 'sources', 'notes', 'verification', 'verificationLevel', 'candidateAdapters', 'dataResidency', 'legalTemplates', 'issuer', 'timeZones']) {
    assert.ok(!data.includes(`"${key}"`), `client data carries "${key}"`);
  }
  const full = JSON.stringify(BUILT_IN_PACKS);
  assert.ok(data.length * 8 < full.length, `client data ${data.length} bytes against ${full.length} for the full packs`);
  const us = getClientPack('US');
  assert.ok(us);
  assert.equal(us.regions.length, getPack('US')!.regions.length, 'every subdivision stays selectable in client forms');
  assert.deepEqual(us.regions.find((r) => r.code === 'US-CA'), { code: 'US-CA', name: { en: 'California' }, kind: 'state' });
});

test('the generic profile has one source: its client subset equals the projection of the full profile', () => {
  const codes = ['FR', 'DE', 'JP', 'BR', 'KZ', ...COUNTRIES.filter((c) => c.currency === null).map((c) => c.code).slice(0, 2)];
  for (const code of codes) {
    const country = getCountry(code);
    assert.ok(country, code);
    assert.deepEqual(genericClientPack(country), toClientPack(genericPack(country)), code);
  }
});

test('on the server the client registry mirrors the deployment packs, reduced to the client subset', (t) => {
  t.after(() => resetPacks());
  const us = getPack('US')!;
  installPacks([{ ...us, name: { en: 'United States (deployment copy)' }, currency: { ...us.currency, displayFractionDigits: 0 } }]);
  const mirrored = getClientPack('us');
  assert.ok(mirrored);
  assert.equal(mirrored.name.en, 'United States (deployment copy)');
  assert.equal('facets' in mirrored, false);
  assert.equal(clientPacks().length, BUILT_IN_PACKS.length);
  assert.equal(clientMoney('123456', 'USD', 'en-US'), formatMoney('123456', 'USD', 'en-US'), 'both entries format with the deployment pack');
  assert.equal(clientMoney('123456', 'USD', 'en-US'), '$1,235');
  resetPacks();
  assert.equal(getClientPack('US')!.name.en, 'United States');
  assert.equal(clientMoney('123456', 'USD', 'en-US'), '$1,234.56');
});

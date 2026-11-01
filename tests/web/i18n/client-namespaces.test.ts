import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { uiDictionary } from '@trustwork/ui/i18n';
import { ROUTE_GROUPS, clientKeys, type RouteGroup } from './client-keys.js';
import { REPO, appLocaleTags, namespacesOf } from './helpers.js';

/**
 * INTL-004: the browser receives only the namespaces its route uses. `apps/web/locales/client-namespaces.json`
 * names them per route group; this test derives the same lists from the client components (see
 * client-keys.ts) and fails when the file is stale in either direction: a namespace a client component
 * needs but its route does not receive (a lookup would fail in the browser), or a namespace a route
 * receives without using it (dead weight on every page of the group).
 */
type LocaleData = {
  appLocales(): string[];
  appNamespaces(): string[];
  appNamespace(tag: string, namespace: string): Messages | undefined;
  appDictionary(tag: string, namespaces?: readonly string[]): Messages | undefined;
  appLayers(tag: string, namespaces?: readonly string[]): Messages[];
  coverage(tag: string): { total: number; translated: number };
};
// Loaded at run time: the module imports the web app's brand overlay, which the repository-wide
// NodeNext type check does not resolve (it is type-checked with the web app instead).
const localeDataUrl = new URL('../../../apps/web/app/_lib/locale-data.ts', import.meta.url).href;
const { appDictionary, appLayers, appLocales, appNamespace, appNamespaces, coverage } = (await import(localeDataUrl)) as LocaleData;

const table = JSON.parse(readFileSync(resolve(REPO, 'apps/web/locales/client-namespaces.json'), 'utf8')) as Record<string, string[]>;
const reference = appDictionary('en')! as Record<string, unknown>;
const owner = new Map<string, string>();
for (const namespace of appNamespaces()) for (const key of Object.keys(appNamespace('en', namespace)!)) owner.set(key, namespace);

function needed(group: RouteGroup): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, files] of clientKeys(group, reference)) {
    const namespace = owner.get(key)!;
    out.set(namespace, [...(out.get(namespace) ?? []), ...files.map((file) => `${file} (${key})`)]);
  }
  return out;
}

test('every route group of the table exists and the table covers every group', () => {
  assert.deepEqual(Object.keys(table).filter((key) => !key.startsWith('$')).sort(), Object.keys(ROUTE_GROUPS).sort());
});

const rootNeeds = needed('root');
for (const group of Object.keys(ROUTE_GROUPS) as RouteGroup[]) {
  test(`client namespaces of the ${group} routes match what their client components look up`, () => {
    const needs = group === 'root' ? rootNeeds : needed(group);
    const receives = new Set([...(group === 'root' ? [] : table.root!), ...table[group]!]);
    const missing = [...needs].filter(([namespace]) => !receives.has(namespace)).map(([namespace, users]) => `${namespace}: ${users.join(', ')}`);
    assert.deepEqual(missing, [], `add these namespaces to "${group}" in apps/web/locales/client-namespaces.json`);
    const expected = [...needs.keys()].filter((namespace) => group === 'root' || !table.root!.includes(namespace)).sort();
    assert.deepEqual([...table[group]!].sort(), expected, `"${group}" lists namespaces its client components never use (or the root list already carries them)`);
  });
}

test('the analysis finds the known client lookups (guards against a silently empty scan)', () => {
  const workspace = needed('workspace');
  assert.ok(workspace.get('assistant')?.some((user) => user.includes('AssistantPageClient.tsx')));
  assert.ok(needed('auth').get('auth')?.some((user) => user.includes('LoginForm.tsx')));
  assert.ok(rootNeeds.get('demo')?.some((user) => user.includes('DemoBanner.tsx')));
  // A permission literal and a file name that start like keys are not lookups.
  assert.ok(!needed('workspace').get('workspace')?.some((user) => user.includes('fixture-adapter')));
});

test('the server discovers languages and namespaces from the directories', () => {
  assert.deepEqual(appLocales(), appLocaleTags());
  assert.deepEqual(appNamespaces(), namespacesOf('en'));
});

test('every design-system dictionary file is registered without code (a new language is data only)', () => {
  // The design system's own registry module is not loaded here: what is registered came from the files.
  const tags = readdirSync(resolve(REPO, 'packages/ui/locales')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  for (const tag of tags) assert.ok(uiDictionary(tag), `packages/ui/locales/${tag}.json is not registered`);
});

test('layers for a set of namespaces carry those namespaces only, with the English fallback per namespace', () => {
  for (const tag of appLocales()) {
    for (const namespaces of [['core'], ['core', 'demo'], table.workspace!]) {
      const allowed = new Set(namespaces.flatMap((namespace) => Object.keys(appNamespace('en', namespace)!)));
      const layers = appLayers(tag, namespaces);
      for (const layer of layers) for (const key of Object.keys(layer)) assert.ok(allowed.has(key), `${tag} [${namespaces.join(',')}]: ${key} leaked from another namespace`);
      const covered = new Set(layers.flatMap((layer) => Object.keys(layer)));
      assert.deepEqual([...allowed].filter((key) => !covered.has(key)), [], `${tag}: every key of the namespaces resolves`);
    }
  }
});

test('a language without a file for a namespace falls back to English for that namespace only', () => {
  const english = appLayers('en', ['core']);
  assert.equal(english.length, 1);
  const unknown = appLayers('xx-unknown', ['core']);
  assert.deepEqual(unknown, english);
  assert.equal(appNamespace('ka', 'no-such-namespace'), undefined);
  assert.deepEqual(appLayers('ka', ['core', 'no-such-namespace']), appLayers('ka', ['core']));
});

test('coverage counts every namespace', () => {
  const reference = coverage('en');
  const perNamespace = appNamespaces().reduce((sum, namespace) => sum + JSON.stringify(appNamespace('en', namespace)).match(/":\s*(?:"|\[)/g)!.length, 0);
  assert.equal(reference.total, perNamespace);
  // Russian is not maintained (ADR 009 decision 11): it is counted, but only the maintained languages must be complete.
  for (const tag of appLocales()) {
    const counted = coverage(tag);
    assert.equal(counted.total, reference.total, `${tag} counts every key`);
    if (tag !== 'ru') assert.equal(counted.translated, reference.total, `${tag} is complete`);
  }
  assert.deepEqual(coverage('xx-unknown'), { total: reference.total, translated: 0 });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { enabledPacks, getPack } from '@trustwork/country-packs';

/**
 * Every dictionary against the English reference (ADR-009, INTL-004). Application dictionaries live in
 * `apps/web/locales/<tag>/<namespace>.json`; languages and namespaces are discovered by listing the
 * directories, so a new language or a new namespace file is checked here without editing this test.
 */
const appRoot = resolve('apps/web/locales');
const uiRoot = resolve('packages/ui/locales');

function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((value, index) => leaves(value, `${path}.${index}`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => (key.startsWith('$') ? [] : leaves(value, path ? `${path}.${key}` : key)));
  return [];
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const isDirectory = (path: string): boolean => statSync(path).isDirectory();

/** Language directories of an application locale tree, English first. */
function localeDirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => isDirectory(join(root, name)))
    .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
}

function namespaceFiles(root: string, tag: string): string[] {
  return readdirSync(join(root, tag))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .sort();
}

/**
 * Structural problems of an application locale tree: every language has exactly the reference's namespace
 * files; a namespace file holds only the top-level keys the reference file of the same name holds; the
 * reference never defines a top-level key in two namespaces; every language and namespace name is valid.
 */
function parityProblems(root: string): string[] {
  const problems: string[] = [];
  const tags = localeDirs(root);
  if (!tags.includes('en')) return ['no reference directory en/'];
  const reference = namespaceFiles(root, 'en');
  const owner = new Map<string, string>();
  for (const namespace of reference) {
    if (!/^[a-z][a-z0-9-]*$/.test(namespace)) problems.push(`en/${namespace}.json: namespace names are lower-case words`);
    for (const key of Object.keys(readJson(join(root, 'en', `${namespace}.json`)))) {
      if (key.startsWith('$')) continue;
      const other = owner.get(key);
      if (other) problems.push(`en: top-level key ${key} is defined in both ${other}.json and ${namespace}.json`);
      owner.set(key, namespace);
    }
  }
  for (const tag of tags) {
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(tag)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical?.toLowerCase() !== tag.toLowerCase()) problems.push(`${tag}/: not a BCP 47 language tag`);
    if (tag === 'en') continue;
    const own = namespaceFiles(root, tag);
    for (const namespace of reference) if (!own.includes(namespace)) problems.push(`${tag}/${namespace}.json is missing (every language has every namespace of en/)`);
    for (const namespace of own) {
      if (!reference.includes(namespace)) {
        problems.push(`${tag}/${namespace}.json has no reference en/${namespace}.json`);
        continue;
      }
      for (const key of Object.keys(readJson(join(root, tag, `${namespace}.json`)))) {
        if (key.startsWith('$')) continue;
        if (owner.get(key) !== namespace) problems.push(`${tag}/${namespace}.json: top-level key ${key} belongs to ${owner.has(key) ? `${owner.get(key)}.json` : 'no namespace of en/'}`);
      }
    }
  }
  return problems;
}

/** One language's leaves (every namespace merged for the app tree, the single file for the design system). */
function appLeaves(tag: string): Record<string, string> {
  return Object.fromEntries(namespaceFiles(appRoot, tag).flatMap((namespace) => leaves(readJson(join(appRoot, tag, `${namespace}.json`)))));
}

function uiLeaves(tag: string): Record<string, string> | null {
  try {
    return Object.fromEntries(leaves(readJson(join(uiRoot, `${tag}.json`))));
  } catch {
    return null;
  }
}

const APP_TAGS = localeDirs(appRoot);
const UI_TAGS = readdirSync(uiRoot)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -5));

test('the application tree has one directory per language and the six engine languages', () => {
  for (const tag of ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) assert.ok(APP_TAGS.includes(tag), `apps/web/locales/${tag}/ is missing`);
  assert.ok(namespaceFiles(appRoot, 'en').length >= 10, 'the reference is split into feature namespaces');
});

test('the old single-file dictionaries are gone', () => {
  assert.throws(() => statSync(resolve('apps/web/app/_lib/locales')), 'apps/web/app/_lib/locales must not come back: add a namespace file under apps/web/locales/<tag>/');
});

test('every language has exactly the reference namespaces, and every key sits in its namespace', () => {
  assert.deepEqual(parityProblems(appRoot), []);
});

test('only known metadata sits next to the language directories', () => {
  const allowed = new Set(['client-namespaces.json', 'types.ts', ...APP_TAGS.map((tag) => `${tag}.meta.json`)]);
  const stray = readdirSync(appRoot).filter((name) => !isDirectory(join(appRoot, name)) && !allowed.has(name));
  assert.deepEqual(stray, [], 'apps/web/locales holds language directories, <tag>.meta.json (INTL-007), client-namespaces.json and types.ts');
});

test('the key types list every reference namespace', () => {
  const types = readFileSync(join(appRoot, 'types.ts'), 'utf8');
  const listed = [...types.matchAll(/import\('\.\/en\/([a-z0-9-]+)\.json'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, namespaceFiles(appRoot, 'en'));
});

test('client namespace lists name existing namespaces only', () => {
  const table = readJson(join(appRoot, 'client-namespaces.json'));
  const namespaces = new Set(namespaceFiles(appRoot, 'en'));
  for (const [group, list] of Object.entries(table)) {
    if (group.startsWith('$')) continue;
    assert.ok(Array.isArray(list), group);
    for (const namespace of list as string[]) assert.ok(namespaces.has(namespace), `${group}: unknown namespace ${namespace}`);
    assert.equal(new Set(list as string[]).size, (list as string[]).length, `${group}: duplicate namespace`);
  }
});

test('a namespace missing in one language fails the parity check', () => {
  const root = mkdtempSync(join(tmpdir(), 'trustwork-locales-'));
  try {
    for (const tag of ['en', 'fr']) mkdirSync(join(root, tag));
    writeFileSync(join(root, 'en', 'core.json'), JSON.stringify({ shell: { title: 'Title' } }));
    writeFileSync(join(root, 'en', 'billing.json'), JSON.stringify({ billing: { title: 'Billing' } }));
    writeFileSync(join(root, 'fr', 'core.json'), JSON.stringify({ shell: { title: 'Titre' } }));
    assert.deepEqual(parityProblems(root), ['fr/billing.json is missing (every language has every namespace of en/)']);
    writeFileSync(join(root, 'fr', 'billing.json'), JSON.stringify({ billing: { title: 'Facturation' }, shell: { title: 'moved' } }));
    assert.deepEqual(parityProblems(root), ['fr/billing.json: top-level key shell belongs to core.json']);
    mkdirSync(join(root, 'not a tag'));
    assert.ok(parityProblems(root).includes('not a tag/: not a BCP 47 language tag'));
    writeFileSync(join(root, 'en', 'extra.json'), JSON.stringify({ shell: { other: 'Twice' } }));
    assert.ok(parityProblems(root).includes('en: top-level key shell is defined in both core.json and extra.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, tags, read] of [
  ['apps/web/locales', APP_TAGS, appLeaves],
  ['packages/ui/locales', UI_TAGS, uiLeaves],
] as const) {
  const en = read('en')!;
  test(`${name}: every dictionary defines only reference keys, no empty strings, no placeholders`, () => {
    for (const tag of tags) {
      const dict = read(tag)!;
      for (const [key, value] of Object.entries(dict)) {
        assert.ok(key in en, `${tag}: ${key} is not a reference key`);
        assert.ok(value.trim().length > 0, `${tag}: ${key} is empty`);
        assert.ok(!/TODO|TBD|lorem|XXX/i.test(value), `${tag}: ${key} has a placeholder`);
      }
    }
  });
  test(`${name}: the Russian dictionary is complete`, () => {
    const ru = read('ru')!;
    assert.deepEqual(
      Object.keys(en).filter((k) => !(k in ru)),
      [],
    );
  });
  test(`${name}: complete country packs are fully translated; partial packs may fall back to English`, () => {
    for (const pack of enabledPacks()) {
      if (!(tags as readonly string[]).includes(pack.defaultLocale)) continue; // the dictionary lands with the pack's own task (INTL-UZ, INTL-GE, …)
      const dict = read(pack.defaultLocale)!;
      const missing = Object.keys(en).filter((k) => !(k in dict));
      if (pack.status === 'complete') assert.deepEqual(missing, [], `${pack.code}: ${pack.defaultLocale} is missing ${missing.length} keys`);
    }
  });
  test(`${name}: no Russian-provider names anywhere`, () => {
    for (const tag of tags) for (const [key, value] of Object.entries(read(tag)!)) assert.ok(!/\u042F\u043D\u0434\u0435\u043A\u0441|Yandex|\u0412\u041A\u043E\u043D\u0442\u0430\u043A\u0442\u0435|\u0421\u0431\u0435\u0440|Sber|GigaChat/i.test(value), `${tag}: ${key}`);
  });
}

test('restricted places never have a dictionary of their own', () => {
  assert.equal(getPack('RU'), null);
});

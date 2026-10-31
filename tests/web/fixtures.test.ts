import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { toPublicPerson, toPublicProject } from '@trustwork/contracts/client';
import { FIXTURE_FILES, PeopleFileSchema, ProjectsFileSchema } from '../../apps/web/fixtures/schemas.js';
import { appDictionary } from './i18n/helpers.js';

/** apps/web fixtures must satisfy the frozen contract schemas and be labelled synthetic (runs without a browser). */
const root = resolve('apps/web/fixtures');

for (const [file, schema] of Object.entries(FIXTURE_FILES)) {
  test(`fixture ${file} parses with its contract-backed schema`, () => {
    const json: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    const result = schema.safeParse(json);
    assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues.slice(0, 5)));
    assert.equal((json as { synthetic?: unknown }).synthetic, true, 'fixtures are labelled synthetic');
  });
}

test('every fixture JSON file is registered', () => {
  const files = readdirSync(root).filter((name) => name.endsWith('.json'));
  assert.deepEqual(files.sort(), Object.keys(FIXTURE_FILES).sort());
});

/** Locale overrides (ADR-009): every pointer exists in the base fixture, the result still parses, and the copy is in the target script. */
for (const locale of ['en', 'uz-Latn', 'ka', 'hy', 'az-Latn'] as const) {
  test(`fixture overrides for ${locale} point at existing strings and parse`, () => {
    const overrides = JSON.parse(readFileSync(resolve(root, 'i18n', `${locale}.json`), 'utf8')) as Record<string, Record<string, string>>;
    const cyrillic: string[] = [];
    for (const [file, map] of Object.entries(overrides)) {
      const base = JSON.parse(readFileSync(resolve(root, `${file}.json`), 'utf8')) as Record<string, unknown>;
      const copy = structuredClone(base);
      for (const [path, text] of Object.entries(map)) {
        const parts = path.split('/');
        let node: unknown = copy;
        for (const part of parts.slice(0, -1)) node = Array.isArray(node) ? node[Number(part)] : (node as Record<string, unknown> | undefined)?.[part];
        const last = parts[parts.length - 1]!;
        const exists = Array.isArray(node) ? Number(last) < node.length : Boolean(node && typeof node === 'object' && last in node);
        assert.ok(exists, `${locale}: ${file}:${path} does not exist in the base fixture`);
        const current = Array.isArray(node) ? node[Number(last)] : (node as Record<string, unknown>)[last];
        assert.equal(typeof current, 'string', `${locale}: ${file}:${path} is not a string`);
        if (/[\u0400-\u04FF]/.test(text)) cyrillic.push(`${file}:${path}`);
        if (Array.isArray(node)) node[Number(last)] = text;
        else (node as Record<string, unknown>)[last] = text;
      }
      const schema = FIXTURE_FILES[`${file}.json` as keyof typeof FIXTURE_FILES];
      assert.ok(schema, `${file}.json is not a registered fixture`);
      const result = schema.safeParse(copy);
      assert.ok(result.success, result.success ? '' : `${locale}/${file}: ${JSON.stringify(result.error.issues.slice(0, 5))}`);
    }
    assert.deepEqual(cyrillic, [], `${locale} overrides must not contain Cyrillic`);
  });
}

/** The English layer is the fallback for every other locale, so it must replace every Cyrillic base string. */
test('English overrides cover every Cyrillic string of the base fixtures', () => {
  const english = JSON.parse(readFileSync(resolve(root, 'i18n', 'en.json'), 'utf8')) as Record<string, Record<string, string>>;
  const missing: string[] = [];
  const walk = (node: unknown, path: string, covered: Record<string, string>) => {
    if (typeof node === 'string') {
      if (/[\u0400-\u04FF]/.test(node) && !(path in covered)) missing.push(path);
    } else if (Array.isArray(node)) node.forEach((child, index) => walk(child, `${path}/${index}`, covered));
    else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(child, path ? `${path}/${key}` : key, covered);
  };
  for (const file of Object.keys(FIXTURE_FILES)) {
    const name = file.replace(/\.json$/, '');
    walk(JSON.parse(readFileSync(resolve(root, file), 'utf8')), '', english[name] ?? {});
  }
  assert.deepEqual(missing, [], `base strings without an English override: ${missing.length}`);
});

/** ADR-009 owner decision 10: every engine language carries its own copy of every localized string, so readers never get an English fallback. */
for (const locale of ['uz-Latn', 'ka', 'hy', 'az-Latn'] as const) {
  test(`fixture overrides for ${locale} cover every English override`, () => {
    const english = JSON.parse(readFileSync(resolve(root, 'i18n', 'en.json'), 'utf8')) as Record<string, Record<string, string>>;
    const own = JSON.parse(readFileSync(resolve(root, 'i18n', `${locale}.json`), 'utf8')) as Record<string, Record<string, string>>;
    const missing = Object.entries(english).flatMap(([file, map]) => Object.keys(map).filter((pointer) => !(pointer in (own[file] ?? {}))).map((pointer) => `${file}:${pointer}`));
    assert.deepEqual(missing, [], `${locale} strings falling back to English: ${missing.length}`);
  });
}

test('projection rules: a private profile and an unpublished project are not public', () => {
  const people = PeopleFileSchema.parse(JSON.parse(readFileSync(resolve(root, 'people.json'), 'utf8')));
  const projects = ProjectsFileSchema.parse(JSON.parse(readFileSync(resolve(root, 'projects.json'), 'utf8')));
  const ivan = people.people.find((p) => p.slug === 'ivan-mostov');
  const dacha = projects.projects.find((p) => p.slug === 'dacha-petra');
  assert.ok(ivan && dacha);
  assert.equal(toPublicPerson(ivan.person), null);
  assert.equal(toPublicProject(dacha.project), null);
  const school = projects.projects.find((p) => p.slug === 'shkola-na-reke');
  assert.ok(school);
  const pub = toPublicProject(school.project);
  assert.ok(pub);
  assert.equal('budgets' in pub, false);
  assert.equal('privateFiles' in pub, false);
});

test('locale additions have no English product copy and no duplicate package keys', () => {
  const additions = appDictionary('ru') as Record<string, unknown>;
  const base = JSON.parse(readFileSync(resolve('packages/ui/locales/ru.json'), 'utf8')) as Record<string, unknown>;
  const leaves: Array<[string, string]> = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') leaves.push([path, node]);
    else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
  };
  walk(additions, '');
  const baseKeys = new Set<string>();
  const walkBase = (node: unknown, path: string) => {
    if (typeof node === 'string') baseKeys.add(path);
    else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) walkBase(value, path ? `${path}.${key}` : key);
  };
  walkBase(base, '');
  const duplicates = leaves.filter(([key]) => baseKeys.has(key)).map(([key]) => key);
  assert.deepEqual(duplicates, [], 'additions must not redefine package keys');
  const english = leaves.filter(([key, value]) => key !== '$comment' && /\b(?!PDF\b|ID\b|Google\b|Apple\b|BIM\b|Word\b|Excel\b|Trustwork\b)[A-Za-z]{3,}\b/.test(value.replace(/\b(plural|one|few|many|other)\b|\{[a-zA-Z]+/g, '')));
  assert.deepEqual(
    english.map(([key]) => key),
    [],
    'additions must be Russian',
  );
});

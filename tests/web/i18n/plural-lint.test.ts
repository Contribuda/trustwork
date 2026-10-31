import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { REPO, appDictionary, leaves, uiDictionary } from './helpers.js';

/**
 * Lint rule (INTL-003, audit finding E3): plural forms come only from ICU messages in the locale files,
 * whose category the design system's formatter takes from `Intl.PluralRules`. A hand-written helper (the
 * Russian one/few/many rule was copied into seven files and applied to every language) is rejected here,
 * as is a dictionary that splits one word into `…One`/`…Few`/`…Many` keys instead of one plural message.
 */
const ROOTS = ['apps/web/app', 'apps/web/components', 'packages/ui/src'];
const ALLOWED = [resolve(REPO, 'packages/ui/src/i18n')]; // the ICU formatter itself

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.next') ? [] : sources(path);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [path] : [];
  });
}

/** Problems in one source file; exported shape kept small so the rule can be tested on a sample. */
export function pluralProblems(source: string): string[] {
  const problems: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const helper = /\b(?:function\s+|(?:const|let|var)\s+)(plurali[sz]e\w*|plural\w*)\s*[=(<:]/i.exec(code);
  if (helper) problems.push(`local plural helper \`${helper[1]}\``);
  if (/%\s*10\b/.test(code) && /%\s*100\b/.test(code)) problems.push('hand-written plural arithmetic (% 10 with % 100)');
  if (/new\s+Intl\.PluralRules\b/.test(code)) problems.push('Intl.PluralRules outside the ICU formatter');
  return problems;
}

test('the rule catches the helper it replaced', () => {
  const old = `function plural(n: number, one: string, few: string, many: string): string {\n  const m10 = n % 10;\n  const m100 = n % 100;\n  return m10 === 1 && m100 !== 11 ? one : many;\n}`;
  assert.equal(pluralProblems(old).length, 2);
  assert.equal(pluralProblems('export const pluralize = (n: number) => n;').length, 1);
  assert.equal(pluralProblems("t('companies.foundNoun', { count })").length, 0);
  assert.equal(pluralProblems('const usePhoto = h % 10 < 6;').length, 0);
});

test('no local plural helpers in the web app or the design system', () => {
  const found: string[] = [];
  for (const root of ROOTS)
    for (const file of sources(resolve(REPO, root))) {
      if (ALLOWED.some((allowed) => file.startsWith(allowed))) continue;
      for (const problem of pluralProblems(readFileSync(file, 'utf8'))) found.push(`${relative(REPO, file)}: ${problem}`);
    }
  assert.deepEqual(found, [], `use an ICU plural message, e.g. "{count, plural, one {# project} other {# projects}}", and t(key, { count })\n${found.join('\n')}`);
});

test('dictionaries keep one ICU message per counted word, never …One/…Few/…Many keys', () => {
  for (const [name, dictionary] of [['app', appDictionary('en')], ['ui', uiDictionary('en')]] as const) {
    const keys = new Set(leaves(dictionary).map(([key]) => key));
    const split = [...keys].filter((key) => key.endsWith('One') && (keys.has(key.replace(/One$/, 'Few')) || keys.has(key.replace(/One$/, 'Many'))));
    assert.deepEqual(split, [], `${name}: ${split.join(', ')}`);
  }
});

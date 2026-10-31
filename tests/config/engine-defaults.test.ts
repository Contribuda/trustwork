import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { COUNTRIES, RESTRICTED } from '@trustwork/country-packs';
import { REPO } from './helpers.js';

/**
 * CFG-001 acceptance: engine code contains no country-specific branch or default. Which countries exist, which one a
 * visitor starts in and what each one needs is data (country packs, the ISO dataset) and deployment configuration;
 * code never compares a country code with a literal, never falls back to a named country and never keeps a
 * `DEFAULT_COUNTRY`. The restricted-places list is the one deliberate exception: it is a legal rule applied to every
 * deployment alike, and it lives in data (`packs/restricted.json`) and in the compliance package.
 */
const ENGINE_SOURCES = ['apps/api/src', 'apps/worker/src', 'apps/web/app', 'apps/web/components', 'apps/web/brand', 'apps/web/proxy.ts', 'apps/web/instrumentation.ts', 'apps/web/next.config.ts', 'packages'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'tests', 'stories', 'tools', 'migrations', 'packs', 'countries', 'locales', 'fixtures', 'dist', '.next']);
/** Files allowed to name countries: the restricted-places rule, and synthetic examples documented as such. */
const ALLOWED = new Set(['packages/compliance/src/index.ts']);

function sources(path: string): string[] {
  const absolute = join(REPO, path);
  if (statSync(absolute).isFile()) return /\.(ts|tsx|mjs)$/.test(path) ? [absolute] : [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRECTORIES.has(entry.name) ? [] : sources(join(path, entry.name));
    return /\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [join(absolute, entry.name)] : [];
  });
}

const CODES = new Set([...COUNTRIES.map((c) => c.code), ...RESTRICTED.places.map((p) => p.code).filter((code) => /^[A-Z]{2}$/.test(code))]);
const QUOTED = `['"\`]([A-Z]{2})['"\`]`;
const PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'DEFAULT_COUNTRY constant', regex: /\bDEFAULT_COUNTRY\b/g },
  { name: 'country compared with a literal', regex: new RegExp(`\\b\\w*(?:country|Country|COUNTRY|code|Code)\\b(?:\\?\\.\\w+)?\\s*(?:===|!==|==|!=)\\s*${QUOTED}`, 'g') },
  { name: 'literal compared with a country', regex: new RegExp(`${QUOTED}\\s*(?:===|!==|==|!=)\\s*\\w*(?:country|Country|code|Code)\\b`, 'g') },
  { name: 'switch on a country code', regex: new RegExp(`\\bcase\\s+${QUOTED}\\s*:`, 'g') },
  { name: 'country defaulted to a literal', regex: new RegExp(`\\b\\w*(?:country|Country|COUNTRY)\\w*\\s*(?:\\?\\?|\\|\\||=|:)\\s*${QUOTED}`, 'g') },
  { name: 'country falling back to a literal', regex: new RegExp(`\\b\\w*(?:country|Country|COUNTRY)\\w*\\b[^;\\n]*?(?:\\?\\?|\\|\\|)\\s*${QUOTED}`, 'g') },
  { name: 'pack looked up by a literal', regex: new RegExp(`\\b(?:getPack|getCountryPack|getCountry|genericPack)\\(\\s*${QUOTED}`, 'g') },
];

export function countryBranches(text: string): { name: string; code: string; line: number }[] {
  const found: { name: string; code: string; line: number }[] = [];
  for (const { name, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const code = match[1] ?? 'DEFAULT_COUNTRY';
      if (match[1] && !CODES.has(code)) continue;
      found.push({ name, code, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

test('the lint recognises country-specific branches and defaults', () => {
  for (const sample of ["export const DEFAULT_COUNTRY = 'UZ';", "if (pack.code === 'US') {}", "if ('GE' !== countryCode) {}", "switch (c) { case 'AM': break; }", "const country = env.X ?? 'AZ';", "const store = { locale: 'en', country: 'UZ' };", "getCountryPack('US')"]) {
    assert.ok(countryBranches(sample).length > 0, sample);
  }
  for (const sample of ["const country = defaultCountryCode();", "if (code === 'ZZ') {}", "if (status === 'OK') {}", "const currency = 'USD';", "if (pack.code === other.code) {}"]) {
    assert.deepEqual(countryBranches(sample), [], sample);
  }
});

test('engine code contains no country-specific branch or default (CFG-001)', () => {
  const offences: string[] = [];
  for (const file of ENGINE_SOURCES.flatMap(sources)) {
    const path = relative(REPO, file);
    if (ALLOWED.has(path)) continue;
    for (const hit of countryBranches(readFileSync(file, 'utf8'))) offences.push(`${path}:${hit.line} ${hit.name} (${hit.code})`);
  }
  assert.deepEqual(offences, [], `country-specific code found; move it into a country pack or the deployment configuration:\n${offences.join('\n')}`);
});

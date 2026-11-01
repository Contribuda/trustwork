import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AUTOMATION_DOMAINS, CONSOLE_SECOND_PERSON_ACTIONS, HUB_LIFECYCLE, HUB_MODULES, HUB_STAFF_ROLES, HUMAN_GATES, LAUNCH_GATES, PROVIDER_CAPABILITIES } from '@trustwork/contracts/client';
import { REJECT_CODES } from '../../../../apps/web/app/admin/_data/commands.js';
import { STAFF_PERSONA_IDS } from '../../../../apps/web/app/admin/_data/personas.js';
import { HEALTH_CHECKS, INSTALL_CHECKS, LEGAL_DOCUMENT_KINDS, QUEUE_IDS, TAXONOMY_KINDS } from '../../../../apps/web/app/admin/_data/schemas.js';
import { GROUP_IDS } from '../../../../apps/web/app/admin/_data/section-types.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';
import { STEP_SLUGS } from '../../../../apps/web/app/admin/setup/steps.js';

/**
 * ADM-002: the console's `admin` namespace (apps/web/locales/<tag>/admin.json). Every key the code looks up exists in
 * the English reference, every value family built from contract enums is complete, every engine language has every
 * key, and no non-English dictionary keeps English copy.
 */

const LOCALES = resolve('apps/web/locales');
const CODE = resolve('apps/web/app/admin');
const tags = readdirSync(LOCALES).filter((name) => statSync(join(LOCALES, name)).isDirectory());

function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}
const dictionary = (tag: string) => new Map(leaves(JSON.parse(readFileSync(join(LOCALES, tag, 'admin.json'), 'utf8'))));
const en = dictionary('en');
const has = (key: string) => en.has(key);

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? codeFiles(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

test('every engine language has an admin namespace', () => {
  for (const tag of ['en', 'uz-Latn', 'ka', 'hy', 'az-Latn', 'es']) assert.ok(tags.includes(tag), tag);
  for (const tag of tags) assert.ok(statSync(join(LOCALES, tag, 'admin.json')).isFile(), `${tag}/admin.json`);
});

test('every static key the console code looks up exists in the English reference', () => {
  const missing: string[] = [];
  for (const file of codeFiles(CODE)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\('(admin\.[A-Za-z0-9_.-]+)'/g)) if (!has(match[1]!)) missing.push(`${file.slice(CODE.length)}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('value families built from contract vocabularies are complete', () => {
  const families: Array<[string, readonly string[]]> = [
    ['admin.roles', HUB_STAFF_ROLES],
    ['admin.lifecycle', HUB_LIFECYCLE],
    ['admin.nav', GROUP_IDS],
    ['admin.hub.launch.gates', LAUNCH_GATES],
    ['admin.hub.modules.names', HUB_MODULES],
    ['admin.capabilities', PROVIDER_CAPABILITIES],
    ['admin.errors', REJECT_CODES],
    ['admin.demo.personas', STAFF_PERSONA_IDS],
    ['admin.overview.queue', QUEUE_IDS],
    ['admin.overview.healthCheck', HEALTH_CHECKS],
    ['admin.hub.modes.domains', AUTOMATION_DOMAINS],
    ['admin.hub.modes.gates', HUMAN_GATES],
    ['admin.hub.legal.kinds', LEGAL_DOCUMENT_KINDS],
    ['admin.hub.taxonomy.kinds', TAXONOMY_KINDS],
    ['admin.setup.check.items', INSTALL_CHECKS],
    ['admin.setup.check.help', INSTALL_CHECKS],
  ];
  const missing = families.flatMap(([prefix, values]) => values.filter((v) => !has(`${prefix}.${v}`)).map((v) => `${prefix}.${v}`));
  for (const action of CONSOLE_SECOND_PERSON_ACTIONS) if (!has(`admin.approvals.actions.${action}`)) missing.push(`admin.approvals.actions.${action}`);
  for (const { group, section } of SECTIONS) {
    if (section.labelKey) {
      for (const tag of tags) {
        const navigation = new Map(leaves(JSON.parse(readFileSync(join(LOCALES, tag, 'console-navigation.json'), 'utf8'))));
        if (!navigation.get(section.labelKey)?.trim()) missing.push(`${tag}:${section.labelKey}`);
      }
    } else if (!has(`admin.sections.${group.id}.${section.id}`)) missing.push(`admin.sections.${group.id}.${section.id}`);
  }
  for (const slug of Object.values(STEP_SLUGS)) for (const leaf of ['title', 'purpose']) if (!has(`admin.setup.${slug}.${leaf}`)) missing.push(`admin.setup.${slug}.${leaf}`);
  assert.deepEqual(missing, []);
});

test('every language defines exactly the English keys, with the same placeholders', () => {
  for (const tag of tags) {
    const dict = dictionary(tag);
    assert.deepEqual([...en.keys()].filter((k) => !dict.has(k)), [], `${tag}: missing keys`);
    assert.deepEqual([...dict.keys()].filter((k) => !en.has(k)), [], `${tag}: keys not in English`);
    for (const [key, value] of dict) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
      assert.deepEqual(names(value), names(en.get(key)!), `${tag}: ${key} placeholders`);
      assert.ok(value.trim().length > 0, `${tag}: ${key} is empty`);
    }
  }
});

/** Values that may legitimately read the same in every language: pure placeholders and punctuation. */
const SAME_EVERYWHERE = new Set(['admin.hub.identity.percent', 'admin.overview.gatesOf']);
/** International words that are spelled the same in another Latin-script language (Uzbek, Azerbaijani, Spanish). */
const COGNATES = new Set(['Moderator', 'Auditor', 'Audit', 'Operator', 'Region', 'Status', 'Editor', 'Editorial', 'Manual', 'Hub', 'Model', 'Adapter']);
/** Product names and technical tokens that stay Latin in every script. */
const LATIN_TOKENS = /\b(US-CA:san-diego|US-TX:austin|US-CA:cslb|build\.example\.org|materials\.steel|ev-counsel-letter-2|Trustwork|OpenRouter|HTTPS|MCP|A2A|SPF|DKIM|DMARC|DNS|10DLC|localhost|Escape|Tab|ISO|SMS|USD|US-CA|US-TX|US|UZ|OK|ID|URL|plural|one|two|few|many|other|zero|en|es)\b/g;

test('no English copy is left in non-English dictionaries', () => {
  for (const tag of tags.filter((t) => t !== 'en')) {
    const dict = dictionary(tag);
    const same = [...dict].filter(([key, value]) => value === en.get(key) && !SAME_EVERYWHERE.has(key) && !COGNATES.has(value) && /[A-Za-z]{3}/.test(value.replace(/\{[^}]*\}/g, '').replace(LATIN_TOKENS, '')));
    assert.deepEqual(same.map(([key]) => key), [], `${tag}: values identical to English`);
    if (tag.endsWith('-Latn')) {
      const cyrillic = [...dict].filter(([, value]) => /[\u0400-\u04FF]/.test(value));
      assert.deepEqual(cyrillic.map(([key]) => key), [], `${tag}: Cyrillic letters in a Latin-script dictionary`);
    }
    if (tag === 'ru' || tag === 'ka' || tag === 'hy') {
      const latin = [...dict].filter(([, value]) => /[A-Za-z]{3,}/.test(value.replace(/\{[^}]*\}/g, '').replace(LATIN_TOKENS, '')));
      assert.deepEqual(latin.map(([key, value]) => `${key}: ${value}`), [], `${tag}: Latin words in a non-Latin dictionary`);
    }
  }
});

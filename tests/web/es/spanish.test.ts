import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import { intlTagFor } from '@trustwork/ui/i18n';
import { formatMoney, longDate, shortDate, t } from '../../../apps/web/app/_lib/i18n.js';
import { FIXTURE_FILES } from '../../../apps/web/fixtures/schemas.js';
import { probe } from '../../config/helpers.js';
import { MAIL_LOCALES, renderMail, resolveLocale, type RenderConfig } from '../../../apps/worker/src/mail/index.js';
import { REPO, appDictionary, layersFor, leaves, namespacesOf, uiDictionary } from '../i18n/helpers.js';

/**
 * LANG-ES: Spanish is the seventh engine language, added as data only (ADR 012 decision 10, INTL-004, CFG-001).
 * The dictionary must be complete (no key falls back to English), keep every ICU argument and plural of the
 * English reference, keep the brand Trustwork, carry no Cyrillic, cover every English demo-content override and
 * format dates and numbers by the visitor's country (es-US in the United States hub).
 */

const flat = (messages: unknown): Record<string, string> => Object.fromEntries(leaves(messages));
const CYRILLIC = /[Ѐ-ӿ]/;

/** Argument names of an ICU message (`{name}`, `{count, plural, …}`), including those inside plural cases. */
export function icuArguments(template: string): string[] {
  const found = new Set<string>();
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) return;
      let depth = 0;
      let close = open;
      for (; close < text.length; close++) {
        if (text[close] === '{') depth++;
        else if (text[close] === '}' && --depth === 0) break;
      }
      const inner = text.slice(open + 1, close);
      const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
      if (plural) {
        found.add(plural[1]!);
        for (const branch of pluralCases(plural[2]!).values()) walk(branch);
      } else found.add(inner.trim());
      i = close + 1;
    }
  };
  walk(template);
  return [...found].sort();
}

/** The cases of a plural body: `one {…} many {…} other {…}` → Map(selector → text). */
export function pluralCases(body: string): Map<string, string> {
  const cases = new Map<string, string>();
  const re = /\s*(=\d+|[a-z]+)\s*\{/g;
  let at = 0;
  while (at < body.length) {
    re.lastIndex = at;
    const head = re.exec(body);
    if (!head || head.index !== at) break;
    let depth = 1;
    let end = re.lastIndex;
    for (; end < body.length && depth > 0; end++) {
      if (body[end] === '{') depth++;
      else if (body[end] === '}') depth--;
    }
    cases.set(head[1]!, body.slice(re.lastIndex, end - 1));
    at = end;
    while (at < body.length && /\s/.test(body[at]!)) at++;
  }
  return cases;
}

/** Every plural body in a message, top level and nested. */
function pluralBodies(template: string): string[] {
  return [...template.matchAll(/\{\s*\w+\s*,\s*plural\s*,/g)].map((match) => {
    let depth = 0;
    let end = match.index!;
    for (; end < template.length; end++) {
      if (template[end] === '{') depth++;
      else if (template[end] === '}' && --depth === 0) break;
    }
    return template.slice(match.index! + match[0].length, end);
  });
}

const enApp = flat(appDictionary('en'));
const esApp = flat(appDictionary('es'));
const enUi = flat(uiDictionary('en'));
const esUi = flat(uiDictionary('es'));
const DICTIONARIES = [
  ['apps/web/locales/es', enApp, esApp],
  ['packages/ui/locales/es.json', enUi, esUi],
] as const;

test('the argument parser reads plain, plural and nested arguments', () => {
  assert.deepEqual(icuArguments('Hola, {name}: {count, plural, one {# archivo de {owner}} other {# archivos}}'), ['count', 'name', 'owner']);
  assert.deepEqual([...pluralCases(' =0 {ninguno} one {# uno} many {# muchos} other {# otros}').keys()], ['=0', 'one', 'many', 'other']);
});

test('Spanish has every namespace file of the English reference', () => {
  assert.deepEqual(namespacesOf('es'), namespacesOf('en'));
  assert.ok(existsSync(resolve(REPO, 'packages/ui/locales/es.json')), 'the design-system dictionary exists');
  assert.ok(existsSync(resolve(REPO, 'apps/web/fixtures/i18n/es.json')), 'the demo-content overrides exist');
});

for (const [name, en, es] of DICTIONARIES) {
  test(`${name}: complete, no extra keys, no empty or placeholder values`, () => {
    assert.deepEqual(Object.keys(en).filter((key) => !(key in es)), [], 'keys missing in es (they would fall back to English)');
    assert.deepEqual(Object.keys(es).filter((key) => !(key in en)), [], 'keys that are not in the English reference');
    for (const [key, value] of Object.entries(es)) {
      assert.ok(value.trim().length > 0, `${key} is empty`);
      assert.ok(!/\bTODO\b|\bTBD\b|FIXME|XXX|[Ll]orem ipsum|\?\?\?/.test(value), `${key} has a placeholder`); // case-sensitive: Spanish «todo»/«todos» is a word
    }
  });

  test(`${name}: every ICU argument of the reference is kept`, () => {
    const diff = Object.keys(en).filter((key) => JSON.stringify(icuArguments(en[key]!)) !== JSON.stringify(icuArguments(es[key]!)));
    assert.deepEqual(diff.map((key) => `${key}: ${icuArguments(en[key]!).join(',')} → ${icuArguments(es[key]!).join(',')}`), []);
  });

  test(`${name}: plurals use the Spanish CLDR categories and keep exact selectors`, () => {
    const categories = new Set(new Intl.PluralRules('es').resolvedOptions().pluralCategories);
    for (const [key, value] of Object.entries(es)) {
      const enBodies = pluralBodies(en[key]!);
      const esBodies = pluralBodies(value);
      assert.equal(esBodies.length, enBodies.length, `${key}: the number of plural messages differs from English`);
      esBodies.forEach((body, index) => {
        const selectors = [...pluralCases(body).keys()];
        assert.ok(selectors.includes('one') && selectors.includes('other'), `${key}: one and other are required`);
        for (const selector of selectors) assert.ok(selector.startsWith('=') || categories.has(selector as Intl.LDMLPluralRule), `${key}: ${selector} is not a Spanish plural category`);
        const exact = [...pluralCases(enBodies[index]!).keys()].filter((selector) => selector.startsWith('='));
        for (const selector of exact) assert.ok(selectors.includes(selector), `${key}: the exact case ${selector} of English is missing`);
      });
    }
  });

  test(`${name}: the brand reads Trustwork and nothing is Cyrillic`, () => {
    for (const [key, value] of Object.entries(es)) {
      assert.ok(!CYRILLIC.test(value), `${key} contains Cyrillic`);
      if (en[key]!.includes('Trustwork')) assert.ok(value.includes('Trustwork'), `${key} lost the brand Trustwork`);
    }
  });
}

test('the design-system brand keys keep the Trustwork name and wordmark', () => {
  assert.equal(esUi['brand.name'], 'Trustwork');
  assert.equal(esUi['bootstrap.title'], 'Trustwork');
  assert.equal(esUi['brand.wordmarkLine1'], 'trust');
  assert.equal(esUi['brand.wordmarkLine2'], 'work');
});

test('counted words resolve in Spanish for 0, 1, 2, 21, 101 and a million', () => {
  setLocaleStore({ locale: 'es', country: 'US', layers: layersFor('es') });
  assert.deepEqual([0, 1, 2, 21, 1_000_000].map((count) => t('companies.foundNoun', { count })), ['empresas', 'empresa', 'empresas', 'empresas', 'empresas']);
  assert.deepEqual([1, 2, 1250].map((count) => t('articles.materialsCount', { count })), ['1 material', '2 materiales', '1,250 materiales']);
  assert.equal(t('settings.security.othersEnded', { count: 0 }), 'No había otras sesiones activas.');
  assert.equal(t('settings.security.othersEnded', { count: 1 }), 'Se cerró 1 sesión más.');
  for (const key of ['companies.foundNoun', 'events.foundNoun', 'people.foundNoun', 'projects.foundNoun', 'search.resultNoun'] as const)
    for (const count of [0, 1, 2, 21, 101, 1_000_000]) {
      const text = t(key, { count });
      assert.ok(text.length > 0 && !/[{}#]/.test(text), `${key} ${count}: ${text}`);
    }
});

test('with country US, dates and numbers use es-US formats; other countries use their own', () => {
  assert.equal(intlTagFor('es', 'US'), 'es-US');
  setLocaleStore({ locale: 'es', country: 'US', layers: layersFor('es') });
  assert.equal(longDate('2026-10-27'), '27 de octubre de 2026');
  assert.equal(shortDate('2026-10-27'), new Intl.DateTimeFormat('es-US', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date('2026-10-27T12:00:00Z')));
  assert.equal(formatMoney('123450', 'USD'), '$1,234.50', 'US dollars, comma thousands and a decimal point');
  assert.equal(t('articles.materialsCount', { count: 1250 }), '1,250 materiales');
  setLocaleStore({ locale: 'es', country: 'MX', layers: layersFor('es') });
  assert.equal(intlTagFor('es', 'MX'), 'es-MX');
  setLocaleStore({ locale: 'es', country: 'ES', layers: layersFor('es') });
  assert.equal(intlTagFor('es', 'ES'), 'es-ES');
  assert.match(formatMoney('123450', 'EUR'), /^1234,50\s€$/u, 'Spain groups no four-digit amounts and puts the euro sign after');
  setLocaleStore({ locale: 'es', country: 'US', layers: layersFor('es') });
});

test('Spanish demo-content overrides cover every English override, point at existing strings and parse', () => {
  const root = resolve(REPO, 'apps/web/fixtures');
  const english = JSON.parse(readFileSync(resolve(root, 'i18n/en.json'), 'utf8')) as Record<string, Record<string, string>>;
  const spanish = JSON.parse(readFileSync(resolve(root, 'i18n/es.json'), 'utf8')) as Record<string, Record<string, string>>;
  const missing = Object.entries(english).flatMap(([file, map]) => Object.keys(map).filter((pointer) => !(pointer in (spanish[file] ?? {}))).map((pointer) => `${file}:${pointer}`));
  assert.deepEqual(missing, [], `Spanish strings falling back to English: ${missing.length}`);
  for (const [file, map] of Object.entries(spanish)) {
    const copy = structuredClone(JSON.parse(readFileSync(resolve(root, `${file}.json`), 'utf8'))) as Record<string, unknown>;
    for (const [pointer, text] of Object.entries(map)) {
      assert.ok(pointer in (english[file] ?? {}), `${file}:${pointer} is not an English override`);
      assert.ok(text.trim().length > 0 && !CYRILLIC.test(text), `${file}:${pointer} is empty or Cyrillic`);
      const parts = pointer.split('/');
      let node: unknown = copy;
      for (const part of parts.slice(0, -1)) node = Array.isArray(node) ? node[Number(part)] : (node as Record<string, unknown>)[part];
      const last = parts.at(-1)!;
      const target = node as Record<string, unknown>;
      assert.equal(typeof target[last], 'string', `${file}:${pointer} is not a string in the base fixture`);
      target[last] = text;
    }
    const schema = FIXTURE_FILES[`${file}.json` as keyof typeof FIXTURE_FILES];
    const result = schema.safeParse(copy);
    assert.ok(result.success, result.success ? '' : `${file}: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
  }
});

test('Spanish demo content keeps the markdown structure of the English text', () => {
  const english = JSON.parse(readFileSync(resolve(REPO, 'apps/web/fixtures/i18n/en.json'), 'utf8')) as Record<string, Record<string, string>>;
  const spanish = JSON.parse(readFileSync(resolve(REPO, 'apps/web/fixtures/i18n/es.json'), 'utf8')) as Record<string, Record<string, string>>;
  const shape = (text: string) => [/^## /gm, /^- /gm, /^> /gm, /\n\n/g].map((re) => (text.match(re) ?? []).length).join('/');
  const differ = Object.entries(english).flatMap(([file, map]) => Object.entries(map).filter(([pointer, text]) => shape(text) !== shape(spanish[file]![pointer]!)).map(([pointer]) => `${file}:${pointer}`));
  assert.deepEqual(differ, []);
});

test('a fresh server start offers Spanish with no configuration and no code change (data only)', () => {
  const started = probe({ TRUSTWORK_DEFAULT_COUNTRY: 'US' });
  assert.ok(started.offeredLanguages.includes('es'), `offered: ${started.offeredLanguages.join(', ')}`);
  assert.ok(started.fixtureLanguages.includes('es'), 'the demo-content overrides are discovered by file name');
  assert.deepEqual(started.visitor, { country: 'US', locale: 'en', chosen: false }, 'English stays the default language of the US hub (ADR 012 decision 27)');
  assert.equal(new Intl.DisplayNames(['es'], { type: 'language' }).of('es'), 'español', 'the picker names the language by Intl');
});

test('transactional mail has a Spanish template set: chosen for a Spanish browser, Trustwork, es plurals', () => {
  assert.ok(MAIL_LOCALES.includes('es'));
  assert.equal(resolveLocale(['es-MX', 'en'], MAIL_LOCALES, 'en'), 'es');
  const config: RenderConfig = {
    defaultLocale: 'en', locales: MAIL_LOCALES, brandName: null, brandOverlay: 'stroyreputation-ru',
    links: { origin: 'https://hub.example', paths: { verifyEmail: '/verify-email/{token}', emailChange: '/verify-email/{token}', recovery: '/recover/{token}', invitation: '/invitations/{membershipId}/{token}', signIn: '/login', recover: '/recover' } },
  };
  const verify = renderMail(config, { localePreferences: ['es-US'], template: 'verify_email', params: { hours: '24' }, secret: 'tok-verify' });
  assert.equal(verify.locale, 'es');
  assert.equal(verify.subject, 'Confirme su dirección de correo electrónico en Trustwork');
  assert.match(verify.text, /vence en 24 horas/);
  assert.match(verify.text, /https:\/\/hub\.example\/verify-email\/tok-verify\?lang=es/);
  assert.ok(!CYRILLIC.test(verify.text) && !CYRILLIC.test(verify.html));
  const recovery = renderMail(config, { localePreferences: ['es'], template: 'recovery', params: { minutes: '1' }, secret: 'tok-recovery' });
  assert.match(recovery.text, /vence en 1 minuto\./);
});

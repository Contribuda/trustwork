import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_LOCALES } from '@trustwork/country-packs';
import { MAIL_TEMPLATES } from '@trustwork/data';
import {
  assertDictionariesComplete, buildLink, dictionaryKeys, formatMessage, MAIL_DICTIONARIES, MAIL_LOCALES, MissingTranslationError, placeholdersOf,
  REFERENCE_LOCALE, renderMail, resolveLocale, SECURITY_EVENTS, TemplateParameterError, type MailDictionary, type RenderConfig, type RenderInput,
} from '../../../apps/worker/src/mail/index.js';

const CYRILLIC = /[Ѐ-ӿ]/;
const RU_BRAND = 'Строй Репутация';
const config = (overrides: Partial<RenderConfig> = {}): RenderConfig => ({
  defaultLocale: 'en', locales: MAIL_LOCALES, brandName: null, brandOverlay: 'stroyreputation-ru',
  links: { origin: 'https://hub.example', paths: { verifyEmail: '/verify-email/{token}', emailChange: '/verify-email/{token}', recovery: '/recover/{token}', invitation: '/invitations/{membershipId}/{token}', signIn: '/login', recover: '/recover' } },
  ...overrides,
});

/** One valid input per template (and per security event). */
function inputs(locale: string): RenderInput[] {
  const base = { localePreferences: [locale] };
  return [
    { ...base, template: 'verify_email', params: { hours: '24' }, secret: 'tok-verify' },
    { ...base, template: 'already_registered', params: {}, secret: null },
    { ...base, template: 'recovery', params: { minutes: '30' }, secret: 'tok-recovery' },
    { ...base, template: 'email_change', params: { hours: '1' }, secret: 'tok-change' },
    { ...base, template: 'membership_invitation', params: { company: 'Acme <Builders> & Sons', membershipId: '0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f', days: '7' }, secret: 'tok-invite' },
    ...SECURITY_EVENTS.map((event) => ({ ...base, template: 'security_notice' as const, params: { event, ...(event.startsWith('provider_') ? { provider: 'google' } : {}) }, secret: null })),
    // COMMS-001: subject and body pre-rendered from the hub's active template version.
    { ...base, template: 'notification', params: { subject: 'New message: <Roof> & gutters', body: 'Demo Owner wrote in "Roof".\n\nOpen the project to answer.', path: '/app/projects/0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f', transactional: 'false' }, secret: null },
  ];
}

test('MAIL-001 templates: every engine language has a complete mail dictionary', async (t) => {
  await t.test('the mail languages are exactly the engine languages, and every directory is registered', () => {
    for (const locale of ALL_LOCALES) assert.ok(MAIL_LOCALES.includes(locale), `engine language ${locale} has no mail dictionary`);
    const directories = readdirSync(resolve('apps/worker/src/mail/locales')).sort();
    assert.deepEqual(directories, [...MAIL_LOCALES].sort(), 'every locales/<tag>/mail.json is registered in MAIL_DICTIONARIES');
  });

  const reference = dictionaryKeys(MAIL_DICTIONARIES[REFERENCE_LOCALE]!);
  const lookup = (dict: MailDictionary, key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict) as string;

  await t.test('every dictionary defines exactly the reference keys, non-empty, without placeholders left over', () => {
    for (const [locale, dict] of Object.entries(MAIL_DICTIONARIES)) {
      const keys = dictionaryKeys(dict);
      assert.deepEqual([...keys].sort(), [...reference].sort(), `${locale}: keys differ from ${REFERENCE_LOCALE}`);
      for (const key of keys) {
        const value = lookup(dict, key);
        assert.ok(value.trim().length > 0, `${locale}: ${key} is empty`);
        assert.ok(!/TODO|TBD|lorem|XXX/i.test(value), `${locale}: ${key} has a placeholder`);
      }
    }
  });

  await t.test('every message uses the same parameters as the reference and has a valid plural', () => {
    for (const [locale, dict] of Object.entries(MAIL_DICTIONARIES)) {
      for (const key of reference) {
        const expected = placeholdersOf(lookup(MAIL_DICTIONARIES.en!, key));
        assert.deepEqual(placeholdersOf(lookup(dict, key)), expected, `${locale}: ${key} parameters`);
        assert.doesNotThrow(() => formatMessage(lookup(dict, key), { brand: 'B', company: 'C', provider: 'P', hours: 2, minutes: 5, days: 21 }, locale), `${locale}: ${key} formats`);
      }
    }
  });

  await t.test('only brand.name names the brand; no message hard-codes it and no non-Russian file contains Cyrillic', () => {
    for (const [locale, dict] of Object.entries(MAIL_DICTIONARIES)) {
      for (const key of reference.filter((k) => k !== 'brand.name')) assert.ok(!/trustwork/i.test(lookup(dict, key)), `${locale}: ${key} hard-codes the brand`);
      if (locale !== 'ru') for (const key of reference) assert.ok(!CYRILLIC.test(lookup(dict, key)), `${locale}: ${key} contains Cyrillic`);
    }
  });

  await t.test('every template renders in every language (subject, text, HTML) with its link', () => {
    for (const locale of MAIL_LOCALES) {
      for (const input of inputs(locale)) {
        const mail = renderMail(config(), input);
        assert.equal(mail.locale, locale);
        assert.ok(mail.subject.length > 0 && !/[\r\n]/.test(mail.subject), `${locale} ${input.template} subject`);
        assert.ok(mail.text.includes('https://hub.example/'), `${locale} ${input.template} link in text`);
        assert.match(mail.html, new RegExp(`^<!doctype html>\\n<html lang="${locale}" dir="ltr">`));
        assert.ok(!/\{[a-z]+\}/i.test(mail.text), `${locale} ${input.template}: unformatted placeholder`);
        if (input.secret) assert.ok(mail.text.includes(input.secret), `${locale} ${input.template}: token link`);
      }
    }
  });

  await t.test('a missing key fails: rendering and the start-up check throw instead of falling back to English', () => {
    const original = MAIL_DICTIONARIES.ka!;
    const broken = structuredClone(original) as { recovery: Record<string, string> };
    delete broken.recovery.expiry;
    (MAIL_DICTIONARIES as Record<string, MailDictionary>).ka = broken as unknown as MailDictionary;
    try {
      assert.throws(() => renderMail(config(), inputs('ka')[2]!), (e: unknown) => e instanceof MissingTranslationError && e.key === 'recovery.expiry' && e.locale === 'ka');
      assert.throws(() => assertDictionariesComplete(['en', 'ka']), MissingTranslationError);
      assert.doesNotThrow(() => assertDictionariesComplete(['en', 'ru']));
    } finally {
      (MAIL_DICTIONARIES as Record<string, MailDictionary>).ka = original;
    }
    assert.throws(() => assertDictionariesComplete(['pl']), MissingTranslationError);
    assert.doesNotThrow(() => assertDictionariesComplete(MAIL_LOCALES));
  });
});

test('MAIL-001 templates: brand, language choice, links and escaping', async (t) => {
  await t.test('Trustwork everywhere; the Russian overlay name only in Russian; configuration decides', () => {
    for (const locale of MAIL_LOCALES) {
      const mail = renderMail(config(), inputs(locale)[0]!);
      if (locale === 'ru') {
        assert.ok(mail.subject.includes(RU_BRAND) && !mail.text.includes('Trustwork'), 'ru uses the overlay');
        assert.equal(mail.fromName, RU_BRAND);
      } else {
        assert.ok(mail.subject.includes('Trustwork') && mail.fromName === 'Trustwork', `${locale} says Trustwork`);
        assert.ok(!mail.text.includes(RU_BRAND) && !mail.html.includes(RU_BRAND), `${locale} never shows the Russian name`);
      }
    }
    assert.ok(renderMail(config({ brandOverlay: null }), inputs('ru')[0]!).subject.includes('Trustwork'), 'TRUSTWORK_BRAND=none');
    const custom = renderMail(config({ brandOverlay: null, brandName: 'Builders Hub' }), inputs('ka')[0]!);
    assert.ok(custom.subject.includes('Builders Hub') && !custom.text.includes('Trustwork'), 'MAIL_BRAND_NAME replaces the engine name');
    assert.ok(renderMail(config({ brandName: 'Builders Hub' }), inputs('ru')[0]!).subject.includes(RU_BRAND), 'the overlay still wins in its language');
  });

  await t.test('language: exact tag, then same language, then the hub default; only served languages', () => {
    assert.equal(resolveLocale(['ru-RU', 'en'], MAIL_LOCALES, 'en'), 'ru');
    assert.equal(resolveLocale(['uz'], MAIL_LOCALES, 'en'), 'uz-Latn');
    assert.equal(resolveLocale(['az-AZ'], MAIL_LOCALES, 'en'), 'az-Latn');
    assert.equal(resolveLocale(['pl', 'hy'], MAIL_LOCALES, 'en'), 'hy');
    assert.equal(resolveLocale(['pl'], MAIL_LOCALES, 'ka'), 'ka');
    assert.equal(resolveLocale([], MAIL_LOCALES, 'en'), 'en');
    assert.equal(resolveLocale(['ru'], ['en', 'ka'], 'en'), 'en', 'a language the hub does not serve is never chosen');
    assert.equal(renderMail(config({ locales: ['en', 'ka'] }), { ...inputs('ru')[0]!, localePreferences: ['ru'] }).locale, 'en');
  });

  await t.test('Russian plurals come from Intl.PluralRules', () => {
    const msg = (MAIL_DICTIONARIES.ru!.verifyEmail as Record<string, string>).expiry!;
    assert.match(formatMessage(msg, { hours: 1 }, 'ru'), /1 час\./);
    assert.match(formatMessage(msg, { hours: 3 }, 'ru'), /3 часа\./);
    assert.match(formatMessage(msg, { hours: 24 }, 'ru'), /24 часа\./);
    assert.match(formatMessage(msg, { hours: 25 }, 'ru'), /25 часов\./);
    assert.match(formatMessage((MAIL_DICTIONARIES.en!.verifyEmail as Record<string, string>).expiry!, { hours: 1 }, 'en'), /1 hour\./);
  });

  await t.test('links: configured origin and paths, encoded values, lang only outside the default language', () => {
    assert.equal(buildLink(config(), 'recovery', 'en', { token: 'a/b+c' }), 'https://hub.example/recover/a%2Fb%2Bc');
    assert.equal(buildLink(config(), 'recovery', 'ka', { token: 'x' }), 'https://hub.example/recover/x?lang=ka');
    assert.equal(buildLink(config({ defaultLocale: 'ka' }), 'signIn', 'ka', {}), 'https://hub.example/login');
    assert.throws(() => buildLink(config(), 'invitation', 'en', { token: 'x' }), TemplateParameterError);
  });

  await t.test('HTML escapes every value; parameters are validated; a token is required exactly when the link needs one', () => {
    const invite = renderMail(config(), inputs('en')[4]!);
    assert.ok(invite.html.includes('Acme &lt;Builders&gt; &amp; Sons') && !invite.html.includes('<Builders>'));
    assert.ok(invite.text.includes('Acme <Builders> & Sons'), 'the text part is plain text');
    assert.throws(() => renderMail(config(), { ...inputs('en')[0]!, params: {} }), TemplateParameterError);
    assert.throws(() => renderMail(config(), { ...inputs('en')[0]!, params: { hours: '-1' } }), TemplateParameterError);
    assert.throws(() => renderMail(config(), { ...inputs('en')[0]!, secret: null }), TemplateParameterError);
    assert.throws(() => renderMail(config(), { ...inputs('en')[1]!, secret: 'unexpected' }), TemplateParameterError);
    assert.throws(() => renderMail(config(), { localePreferences: [], template: 'security_notice', params: { event: 'something_else' }, secret: null }), TemplateParameterError);
    assert.throws(() => renderMail(config(), { localePreferences: [], template: 'security_notice', params: { event: 'provider_linked', provider: 'evil' }, secret: null }), TemplateParameterError);
    assert.equal(MAIL_TEMPLATES.length, 7);
    const notification = renderMail(config(), inputs('en').at(-1)!);
    assert.equal(notification.subject, 'New message: <Roof> & gutters');
    assert.ok(notification.html.includes('&lt;Roof&gt; &amp; gutters') && !notification.html.includes('<Roof>'), 'pre-rendered texts are escaped');
    assert.ok(notification.text.includes('https://hub.example/app/projects/0b9c3f9e-8f1c-4a57-9f0e-2c1d3b4a5e6f'));
    assert.throws(() => renderMail(config(), { ...inputs('en').at(-1)!, params: { subject: 's', body: 'b', path: 'https://evil.example/' } }), TemplateParameterError);
    assert.throws(() => renderMail(config(), { ...inputs('en').at(-1)!, params: { subject: 'two\nlines', body: 'b', path: '/app/x' } }), TemplateParameterError);
  });
});

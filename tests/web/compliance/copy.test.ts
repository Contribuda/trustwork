import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { mailConfigFromEnv, renderMail } from '../../../apps/worker/src/mail/index.js';
import { SCREENING_NOTICE_KINDS, screeningTranslationReview } from '../../../apps/worker/src/mail/templates/screening/index.js';
import { AppealAssignmentViewSchema } from '../../../packages/contracts/src/screening-notices.js';

const root = resolve('apps/web/locales');
const locales = readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort();
const keys = (value: Record<string, unknown>, prefix = ''): string[] => Object.entries(value).flatMap(([key, v]) =>
  key.startsWith('$') ? [] : typeof v === 'string' ? [`${prefix}${key}`] : keys(v as Record<string, unknown>, `${prefix}${key}.`));

test('SANC-007: every jurisdiction, screening and participant key exists in all seven locales, with explicit unreviewed flags', () => {
  assert.deepEqual(locales, ['az-Latn', 'en', 'es', 'hy', 'ka', 'ru', 'uz-Latn']);
  for (const namespace of ['jurisdiction', 'screening', 'compliance']) {
    const reference = keys(JSON.parse(readFileSync(`${root}/en/${namespace}.json`, 'utf8'))).sort();
    for (const locale of locales) {
      const dictionary = JSON.parse(readFileSync(`${root}/${locale}/${namespace}.json`, 'utf8'));
      assert.deepEqual(keys(dictionary).sort(), reference, `${locale}/${namespace}`);
      assert.ok(!/""|TODO|TBD/.test(JSON.stringify(dictionary)));
      assert.equal(screeningTranslationReview[locale]?.nativeReviewed, false);
      assert.equal(screeningTranslationReview[locale]?.counselReviewed, false);
    }
  }
});

test('SANC-007: every outbound kind is localized, generic, identifier-free and refuses injected parameters', () => {
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid' }).render;
  for (const locale of locales) for (const kind of SCREENING_NOTICE_KINDS) {
    const input = { template: 'screening_notice' as const, localePreferences: [locale], params: { kind }, secret: null };
    const mail = renderMail(config, input);
    assert.equal(mail.locale, locale);
    assert.ok(mail.subject && mail.text && mail.html);
    assert.match(mail.text, /https:\/\/hub.example.invalid\/app\/settings\/account\/compliance/);
    for (const part of [mail.subject, mail.text, mail.html]) {
      assert.doesNotMatch(part, /OFAC|SDN|92000|93000|Fictivsky|Exampleton|SYNTHETIC-[A-Z]|listCode|entryUid|reviewerId|subjectId|matchId/i);
      assert.doesNotMatch(part, /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i);
    }
    for (const key of ['person', 'entryUid', 'listCode', 'reason', 'evidence', 'reviewerId', 'path', 'subject', 'body']) {
      assert.throws(() => renderMail(config, { ...input, params: { ...input.params, [key]: 'forbidden private data' } }));
    }
    assert.throws(() => renderMail(config, { ...input, secret: 'not-allowed' }));
  }
  assert.throws(() => renderMail(config, { template: 'screening_notice', localePreferences: ['en'], params: { kind: 'unreviewed_custom_notice' }, secret: null }));
});

test('assignment projection rejects decision evidence and subject data', () => {
  const good = { appealId: '11111111-1111-4111-8111-111111111111', originalDecisionId: '22222222-2222-4222-8222-222222222222', reviewerId: null, assignedAt: '2026-11-01T00:00:00.000Z' };
  assert.ok(AppealAssignmentViewSchema.safeParse(good).success);
  for (const key of ['reason', 'entryName', 'subjectId', 'evidence']) assert.equal(AppealAssignmentViewSchema.safeParse({ ...good, [key]: 'private' }).success, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocaleStore } from '@trustwork/i18n-runtime';
// Registers every engine language's design-system dictionary (only English is built into the bundle).
import '../../src/i18n/dictionaries';
import { formatDate, formatMessage, formatNumber, message, t } from '../../src/i18n/index';

// These tests describe the Russian dictionary and rules; the reference locale is English.
setLocaleStore({ locale: 'ru', country: 'UZ', layers: [] });

test('interpolates named parameters', () => {
  assert.equal(formatMessage('Версия {version} от {date}', { version: 2, date: '27.10.2026' }), 'Версия 2 от 27.10.2026');
});

test('selects Russian plural categories one / few / many', () => {
  const template = '{count, plural, one {# проект} few {# проекта} many {# проектов}}';
  assert.equal(formatMessage(template, { count: 1 }), '1 проект');
  assert.equal(formatMessage(template, { count: 3 }), '3 проекта');
  assert.equal(formatMessage(template, { count: 5 }), '5 проектов');
  assert.equal(formatMessage(template, { count: 21 }), '21 проект');
  assert.equal(formatMessage(template, { count: 11 }), '11 проектов');
  assert.equal(formatMessage(template, { count: 1250 }), `${formatNumber(1250)} проектов`);
});

test('plural inside a sentence keeps surrounding text', () => {
  assert.equal(t('shell.notificationsCount', { count: 2 }), 'Уведомления, 2 новых');
  assert.equal(t('assistant.launcherUnread', { count: 1 }), 'Помощник, 1 непрочитанное');
});

test('throws for unknown keys and reads array entries by index', () => {
  assert.throws(() => message('shell.doesNotExist' as never), /Missing locale key/);
  assert.equal(t('publicNav.7'), 'Журнал');
});

test('date-only strings are calendar dates in any time zone and use the DS-000 long form without « г.»', () => {
  assert.equal(formatDate('2026-10-27'), '27 октября 2026');
  assert.equal(formatDate('2026-10-27', 'short'), '27.10.2026');
  assert.equal(formatDate('2026-01-01'), '1 января 2026');
  assert.equal(formatDate(new Date(2026, 9, 27, 12, 0, 0)), '27 октября 2026');
});

test('non-finite plural counts fall back to the many form and stay visible', () => {
  // Intl renders NaN in Russian («не число»); the form is `many` so the sentence stays grammatical and the gap is visible.
  assert.equal(formatMessage('{count, plural, one {# день} few {# дня} many {# дней}}', { count: Number.NaN }), `${formatNumber(Number.NaN)} дней`);
});

test('rate-limit message pluralises minutes', () => {
  assert.equal(t('auth.error.rateLimited', { minutes: 1 }), 'Слишком много попыток. Попробуйте через 1 минуту.');
  assert.equal(t('auth.error.rateLimited', { minutes: 5 }), 'Слишком много попыток. Попробуйте через 5 минут.');
});

test('unknown parameters are left visible so missing data is noticed in review', () => {
  assert.equal(formatMessage('Обновлено {time}'), 'Обновлено {time}');
});

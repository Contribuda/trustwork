import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h, Fragment, Suspense, use, type ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { LocaleScope, getLocaleStore } from '@trustwork/i18n-runtime';
import { intlTag } from '@trustwork/ui/i18n';
import { currentLocale, formatDate, t } from '../../../apps/web/app/_lib/i18n.js';
import { layersFor } from './helpers.js';

/**
 * INTL-003, audit finding E2: the server-side rendering pass of client components runs many requests in one
 * process. Two renders in different languages are interleaved on purpose (each suspends after its locale
 * provider rendered, so the other request's provider renders in between) and every probe must still read its
 * own request's language. A process-global store, as before, mixes under exactly this schedule; the control
 * below proves the schedule really interleaves.
 */
const COUNTRY: Record<string, string> = { en: 'US', ru: 'UZ', ka: 'GE', 'uz-Latn': 'UZ', hy: 'AM', 'az-Latn': 'AZ' };

const delays = new Map<string, Promise<void>>();
function wait(key: string, ms: number): void {
  let pending = delays.get(key);
  if (!pending) {
    pending = new Promise((done) => setTimeout(done, ms));
    delays.set(key, pending);
  }
  use(pending);
}

function Probe({ id, ms }: { id: string; ms: number }): ReactNode {
  if (ms >= 0) wait(id, ms);
  const store = getLocaleStore();
  return h('p', { 'data-probe': id }, [currentLocale(), store.country, t('events.online'), t('common.save'), intlTag(), formatDate('2026-10-27')].join('|'));
}

// Control: the pre-INTL-003 design, a module-level store written by the provider during render.
let legacyStore = '';
function LegacyScope({ locale, children }: { locale: string; children: ReactNode }): ReactNode {
  legacyStore = locale;
  return children;
}
function LegacyProbe({ id, ms }: { id: string; ms: number }): ReactNode {
  wait(id, ms);
  return h('i', { 'data-legacy': id }, legacyStore);
}

function page(id: string, locale: string, ms: number): ReactNode {
  const children = h(
    Fragment,
    null,
    h(Probe, { id: `${id}-sync`, ms: -1 }),
    h(Suspense, { fallback: null }, h(Probe, { id: `${id}-late`, ms })),
    h(LegacyScope, { locale, children: h(Suspense, { fallback: null }, h(LegacyProbe, { id: `${id}-legacy`, ms })) }),
  );
  return h(LocaleScope, { locale, country: COUNTRY[locale]!, layers: layersFor(locale), children });
}

async function render(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}

function expected(locale: string): string {
  const own = layersFor(locale);
  const pick = (key: string) =>
    own
      .map((layer) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), layer))
      .find((value) => typeof value === 'string') as string | undefined;
  return [locale, COUNTRY[locale], pick('events.online'), pick('common.save') ?? 'Save'].join('|');
}

function probes(html: string): Map<string, string> {
  return new Map([...html.matchAll(/data-probe="([^"]+)">([^<]*)</g)].map((m) => [m[1]!, m[2]!.replace(/&#x27;/g, "'").replace(/&amp;/g, '&')]));
}

test('two locales rendered concurrently never mix, while a process-global store would', async () => {
  // English suspends longest: Russian's provider renders and resolves in between.
  const [en, ru] = await Promise.all([render(page('a', 'en', 40)), render(page('b', 'ru', 5))]);
  for (const [html, locale] of [[en, 'en'], [ru, 'ru']] as const) {
    for (const [id, text] of probes(html)) assert.ok(text.startsWith(`${expected(locale)}|`), `${locale} ${id}: ${text}`);
  }
  const enProbe = probes(en).get('a-late')!;
  assert.match(enProbe, /\|Online\|Save\|en-US\|October 27, 2026$/);
  assert.match(probes(ru).get('b-late')!, /\|Онлайн\|Сохранить\|ru\|27 октября 2026$/);
  assert.doesNotMatch(en, /[Ѐ-ӿ]/, 'no Cyrillic in the English render');
  // The control store saw the Russian provider last, so the English legacy probe reads Russian.
  assert.match(en, /data-legacy="a-legacy">ru</, 'the schedule interleaves the two requests');
});

test('forty interleaved renders in six languages each keep their own language', async () => {
  const locales = ['en', 'ru', 'ka', 'uz-Latn', 'hy', 'az-Latn'];
  const jobs = Array.from({ length: 40 }, (_, i) => {
    const locale = locales[i % locales.length]!;
    return render(page(`r${i}`, locale, (i * 7) % 23)).then((html) => ({ locale, html }));
  });
  let checked = 0;
  for (const { locale, html } of await Promise.all(jobs)) {
    for (const [id, text] of probes(html)) {
      assert.ok(text.startsWith(`${expected(locale)}|`), `${locale} ${id}: ${text}`);
      checked += 1;
    }
    if (locale !== 'ru') assert.doesNotMatch([...probes(html).values()].join(' '), /[Ѐ-ӿ]/, `${locale}: Cyrillic leaked`);
  }
  assert.equal(checked, 80);
});

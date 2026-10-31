import { Suspense, type ReactNode } from 'react';
import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@trustwork/ui/tokens.css';
import '@trustwork/ui/base.css';
import '@/app/globals.css';
import '@/app/locale.css';
import { currentDeployment } from '@trustwork/config/server';
import { UiProvider } from '@/components/ui';
import { AppRouterProvider } from '@/components/AppRouterProvider';
import { DemoBanner } from '@/components/DemoBanner';
import { defaultPersona } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';
import { primeLocale, rootClientLocale, type ActiveLocale } from '@/app/_lib/locale';
import { DATA_SOURCE } from '@/app/_lib/data';
import { siteUrl } from '@/app/_lib/site';
import { LocaleProvider } from '@/components/locale/LocaleProvider';
import { FirstVisitGate } from '@/components/locale/LocaleControls';

/** Golos Text (OFL) for UI and public pages; PT Serif (OFL) for article, magazine and reader bodies. Both self-hosted from packages/ui. */
const golos = localFont({
  src: '../../../packages/ui/fonts/GolosText[wght].woff2',
  weight: '400 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-golos',
});

/**
 * Script fallbacks (OFL, see packages/ui/fonts/PROVENANCE.md): fetched only when Georgian or Armenian text is on the
 * page, so they are never preloaded (a preload would download them on every page and defeat the `unicode-range`).
 */
const notoGeorgian = localFont({
  src: '../../../packages/ui/fonts/NotoSansGeorgian-georgian.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--font-georgian',
  declarations: [{ prop: 'unicode-range', value: 'U+0589, U+10A0-10FF, U+1C90-1CBA, U+1CBD-1CBF, U+205A, U+2D00-2D2F, U+2E31' }],
});

const notoArmenian = localFont({
  src: '../../../packages/ui/fonts/NotoSansArmenian-armenian.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--font-armenian',
  declarations: [{ prop: 'unicode-range', value: 'U+0308, U+0530-058F, U+2010, U+2024, U+25CC, U+FB13-FB17' }],
});

/**
 * Reading face for article, magazine and reader bodies only: not preloaded (WEB-005), so the four files (about 1.4 MB of
 * TrueType) are fetched by the pages whose text uses them instead of competing with every page's first paint on a phone.
 */
const ptSerif = localFont({
  src: [
    { path: '../../../packages/ui/fonts/PT_Serif-Web-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../../../packages/ui/fonts/PT_Serif-Web-Italic.ttf', weight: '400', style: 'italic' },
    { path: '../../../packages/ui/fonts/PT_Serif-Web-Bold.ttf', weight: '700', style: 'normal' },
    { path: '../../../packages/ui/fonts/PT_Serif-Web-BoldItalic.ttf', weight: '700', style: 'italic' },
  ],
  display: 'swap',
  preload: false,
  variable: '--font-pt-serif',
});

/**
 * Metadata every document shares: the deployment's public URL from its runtime configuration (CFG-001, so one image
 * serves any host), the brand title template and the tagline. Call after the locale is primed.
 */
export function documentMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: t('brand.name'), template: `%s — ${t('brand.name')}` },
    description: t('publicShell.tagline'),
  };
}

/**
 * The HTML document (WEB-005). There is no shared root layout any more: the public tree (`app/(public)/[lang]`) renders
 * it for the language in the URL and the visitor's country, never reading the session; the workspace, sign-in,
 * onboarding, console and refusal documents render it for the visitor's cookie language. Every document is rendered per
 * request with its CSP nonce. `gate` shows the first-visit country window while no country is chosen (`server`), or
 * never (`none`: the jurisdiction refusal page, where there is nothing to choose a country for).
 */
export function RootDocument({ active, gate, children }: { active: ActiveLocale; gate: 'server' | 'none'; children: ReactNode }) {
  const demo = DATA_SOURCE === 'fixtures';
  return (
    <html lang={active.locale} className={`${golos.variable} ${notoGeorgian.variable} ${notoArmenian.variable} ${ptSerif.variable}`}>
      <body>
        {/* The banner is last in DOM order (keyboard order starts at the shell) and first visually (CSS order). */}
        <LocaleProvider locale={active.locale} country={active.country} defaultLanguage={currentDeployment().languages.default} {...rootClientLocale(active.locale)}>
          <UiProvider>
            <AppRouterProvider>
              {children}
              {demo ? (
                <Suspense fallback={<DemoBanner defaultPersona={defaultPersona()} static />}>
                  <DemoBanner defaultPersona={defaultPersona()} />
                </Suspense>
              ) : null}
              {gate === 'none' ? null : <FirstVisitGate active={active} />}
            </AppRouterProvider>
          </UiProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}

/**
 * The document of private and per-visitor pages (workspace, sign-in, onboarding, not-found): the language and country
 * come from the visitor's cookies.
 */
export async function VisitorDocument({ children, gate = 'server' }: { children: ReactNode; gate?: 'server' | 'none' }) {
  const active = await primeLocale();
  return (
    <RootDocument active={active} gate={gate}>
      {children}
    </RootDocument>
  );
}

/** Metadata of private and per-visitor documents: shared metadata, never indexed. */
export async function visitorDocumentMetadata(): Promise<Metadata> {
  await primeLocale();
  return { ...documentMetadata(), robots: { index: false, follow: false } };
}

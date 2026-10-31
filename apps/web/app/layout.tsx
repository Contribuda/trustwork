import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import '@trustwork/ui/tokens.css';
import '@trustwork/ui/base.css';
import './globals.css';
import './locale.css';
import { UiProvider } from '@/components/ui';
import { AppRouterProvider } from '@/components/AppRouterProvider';
import { DemoBanner } from '@/components/DemoBanner';
import { defaultPersona } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { appLayers } from '@/app/_lib/locale-data';
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

/** Script fallbacks (OFL, see packages/ui/fonts/PROVENANCE.md): fetched only when Georgian or Armenian text is on the page. */
const notoGeorgian = localFont({
  src: '../../../packages/ui/fonts/NotoSansGeorgian-georgian.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-georgian',
  declarations: [{ prop: 'unicode-range', value: 'U+0589, U+10A0-10FF, U+1C90-1CBA, U+1CBD-1CBF, U+205A, U+2D00-2D2F, U+2E31' }],
});

const notoArmenian = localFont({
  src: '../../../packages/ui/fonts/NotoSansArmenian-armenian.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-armenian',
  declarations: [{ prop: 'unicode-range', value: 'U+0308, U+0530-058F, U+2010, U+2024, U+25CC, U+FB13-FB17' }],
});

const ptSerif = localFont({
  src: [
    { path: '../../../packages/ui/fonts/PT_Serif-Web-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../../../packages/ui/fonts/PT_Serif-Web-Italic.ttf', weight: '400', style: 'italic' },
    { path: '../../../packages/ui/fonts/PT_Serif-Web-Bold.ttf', weight: '700', style: 'normal' },
    { path: '../../../packages/ui/fonts/PT_Serif-Web-BoldItalic.ttf', weight: '700', style: 'italic' },
  ],
  display: 'swap',
  variable: '--font-pt-serif',
});

/**
 * Every route is server-rendered per request: the cookie-less demo persona lives in the query string
 * and must be known while rendering shells. Private `/app/*` pages therefore never share a cache.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000'),
    title: { default: t('brand.name'), template: `%s — ${t('brand.name')}` },
    description: t('publicShell.tagline'),
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  return (
    <html lang={active.locale} className={`${golos.variable} ${notoGeorgian.variable} ${notoArmenian.variable} ${ptSerif.variable}`}>
      <body>
        {/* The banner is last in DOM order (keyboard order starts at the shell) and first visually (CSS order). */}
        <LocaleProvider locale={active.locale} country={active.country} layers={appLayers(active.locale)}>
          <UiProvider>
            <AppRouterProvider>
              {children}
              <DemoBanner defaultPersona={defaultPersona()} />
              <FirstVisitGate />
            </AppRouterProvider>
          </UiProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}

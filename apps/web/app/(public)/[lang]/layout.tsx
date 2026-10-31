import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
// The document (and its global stylesheets) first, so the public stylesheets come after them in the cascade.
import { RootDocument, documentMetadata } from '@/components/RootDocument';
import '../public.css';
import { currentDeployment } from '@trustwork/config/server';
import { PublicShell } from '@/components/public/PublicShell';
import { ViewerProvider, type DemoViewers } from '@/components/public/viewer';
import { HeaderLocaleSwitcher } from '@/components/locale/LocaleControls';
import { data } from '@/app/_lib/data';
import { PERSONAS, defaultPersona, demoModeEnabled } from '@/app/_lib/persona';
import { clientLayers, isPrefixedLanguage, primePublicLocale, type LangParams } from '@/app/_lib/locale';
import { publicRobots } from '@/app/_lib/site';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

/**
 * Public pages (WEB-005, ADR 012 decision 27): one address per language; the language is the URL segment (the proxy maps
 * unprefixed addresses to the default language) and the country is the visitor's chosen one, else the hub's
 * (`primePublicLocale`). They are rendered per request because every document carries the per-request script nonce of
 * the Content Security Policy (Next stamps it from the request). They never read the session: the visitor's own parts
 * (account, owner actions) come from the browser (`components/public/viewer.tsx`). Full-page caching is deferred until a
 * no-inline-script or build-time hash approach is proven (follow-up in docs/engine/architecture.md).
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: LangParams }): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  return { ...documentMetadata(), robots: publicRobots() };
}

export default async function PublicLayout({ children, params }: { children: ReactNode; params: LangParams }) {
  const { lang } = await params;
  if (lang !== currentDeployment().languages.default && !isPrefixedLanguage(lang)) notFound();
  const active = await primePublicLocale(lang);
  const demoMode = demoModeEnabled();
  const fallback = defaultPersona(demoMode);
  // Demo only: every synthetic persona's display name and ids, the browser picks by `?persona=`. Live: nothing here;
  // the browser asks `/app/viewer` with the visitor's own cookie.
  const demoViewers: DemoViewers | null = demoMode
    ? (Object.fromEntries(
        await Promise.all(
          PERSONAS.map(async (persona) => {
            const principal = await data.principalFor({ persona, scenario: 'default', fromQuery: false, defaultPersona: fallback });
            return [persona, principal ? { name: principal.displayName, personId: principal.personId, companyId: principal.company?.id ?? null } : null] as const;
          }),
        ),
      ) as DemoViewers)
    : null;
  return (
    <RootDocument active={active} gate="server">
      <LocaleNamespaces {...clientLayers(active.locale, 'public')}>
        <ViewerProvider demoMode={demoMode} defaultPersona={fallback} demoViewers={demoViewers}>
          <PublicShell demoMode={demoMode} localeControl={<HeaderLocaleSwitcher active={active} />}>
            {children}
          </PublicShell>
        </ViewerProvider>
      </LocaleNamespaces>
    </RootDocument>
  );
}

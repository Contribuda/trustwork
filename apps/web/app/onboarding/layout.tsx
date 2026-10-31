import type { ReactNode } from 'react';
// The document (and its global stylesheets) first, so route stylesheets come after them in the cascade.
import { VisitorDocument, visitorDocumentMetadata } from '@/components/RootDocument';
import '../auth.css';
import { clientLayers, primeLocale } from '@/app/_lib/locale';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

/** Per visitor (cookies, session), never cached. */
export const dynamic = 'force-dynamic';
export async function generateMetadata() {
  return visitorDocumentMetadata();
}

/** Onboarding routes share the auth stylesheet (au-* and ob-* classes); the shell itself is rendered by each step. */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  return (
    <VisitorDocument>
      <LocaleNamespaces {...clientLayers(active.locale, 'onboarding')}>{children}</LocaleNamespaces>
    </VisitorDocument>
  );
}

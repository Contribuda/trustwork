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

/** Auth routes (login, signup, recovery) share the auth stylesheet; the frame is rendered by each page. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  return (
    <VisitorDocument>
      <LocaleNamespaces {...clientLayers(active.locale, 'auth')}>{children}</LocaleNamespaces>
    </VisitorDocument>
  );
}

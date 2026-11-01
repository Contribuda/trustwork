import type { ReactNode } from 'react';
import { clientLayers, primeLocale } from '@/app/_lib/locale';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

/** The password step-up dialog needs the auth dictionary, only on this route. */
export default async function ComplianceLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  return <LocaleNamespaces {...clientLayers(active.locale, 'auth')}>{children}</LocaleNamespaces>;
}

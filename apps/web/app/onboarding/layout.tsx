import type { ReactNode } from 'react';
import '../auth.css';
import { clientLayers, primeLocale } from '@/app/_lib/locale';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

/** Onboarding routes share the auth stylesheet (au-* and ob-* classes); the shell itself is rendered by each step. */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  return <LocaleNamespaces {...clientLayers(active.locale, 'onboarding')}>{children}</LocaleNamespaces>;
}

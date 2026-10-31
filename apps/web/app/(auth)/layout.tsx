import type { ReactNode } from 'react';
import '../auth.css';
import { clientLayers, primeLocale } from '@/app/_lib/locale';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

/** Auth routes (login, signup, recovery) share the auth stylesheet; the frame is rendered by each page. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  return <LocaleNamespaces {...clientLayers(active.locale, 'auth')}>{children}</LocaleNamespaces>;
}

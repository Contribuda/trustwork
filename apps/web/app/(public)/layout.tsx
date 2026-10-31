import type { ReactNode } from 'react';
import './public.css';
import { PublicShell, type ShellAccount } from '@/components/public/PublicShell';
import { HeaderLocaleSwitcher } from '@/components/locale/LocaleControls';
import { data } from '@/app/_lib/data';
import { PERSONAS, defaultPersona, type Persona } from '@/app/_lib/persona';
import { primeLocale } from '@/app/_lib/locale';

/**
 * Public resource shell. Rendered per request (see root layout) so the demo persona from the query is
 * known during server rendering; accounts per persona are display names only.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  await primeLocale();
  const fallback = defaultPersona();
  const accounts = Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (persona) => {
        const principal = await data.principalFor({ persona, scenario: 'default', fromQuery: false, defaultPersona: fallback });
        return [persona, principal ? { name: principal.displayName } : null] as const;
      }),
    ),
  ) as Record<Persona, ShellAccount>;
  return (
    <PublicShell accounts={accounts} defaultPersona={fallback} localeControl={<HeaderLocaleSwitcher />}>
      {children}
    </PublicShell>
  );
}

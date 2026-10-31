import type { ReactNode } from 'react';
import './public.css';
import { PublicShell, type ShellAccount } from '@/components/public/PublicShell';
import { HeaderLocaleSwitcher } from '@/components/locale/LocaleControls';
import { data } from '@/app/_lib/data';
import { LIVE_CONTEXT, PERSONAS, defaultPersona, demoModeEnabled, type Persona } from '@/app/_lib/persona';
import { clientLayers, primeLocale } from '@/app/_lib/locale';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

/**
 * Public resource shell. Rendered per request (see root layout) so the demo persona from the query is
 * known during server rendering; accounts per persona are display names only.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  const demoMode = demoModeEnabled();
  const fallback = defaultPersona(demoMode);
  // Demo: one account per persona, the client picks by `?persona=`. Live: the session's account under the default key only.
  const personas: readonly Persona[] = demoMode ? PERSONAS : [fallback];
  const accounts = Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (persona) => {
        if (!personas.includes(persona)) return [persona, null] as const;
        const principal = await data.principalFor(demoMode ? { persona, scenario: 'default', fromQuery: false, defaultPersona: fallback } : LIVE_CONTEXT);
        return [persona, principal ? { name: principal.displayName } : null] as const;
      }),
    ),
  ) as Record<Persona, ShellAccount>;
  return (
    <LocaleNamespaces {...clientLayers(active.locale, 'public')}>
      <PublicShell accounts={accounts} defaultPersona={fallback} demoMode={demoMode} localeControl={<HeaderLocaleSwitcher />}>
        {children}
      </PublicShell>
    </LocaleNamespaces>
  );
}

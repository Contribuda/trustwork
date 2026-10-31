import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../auth.css';
import './workspace.css';
import { WorkspaceShell, type ShellData } from '@/components/workspace/WorkspaceShell';
import { HeaderLocaleSwitcher } from '@/components/locale/LocaleControls';
import { data } from '@/app/_lib/data';
import { LIVE_CONTEXT, PERSONAS, defaultPersona, demoModeEnabled, type Persona } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';
import { clientLayers, primeLocale } from '@/app/_lib/locale';
import { LocaleNamespaces } from '@/components/locale/LocaleProvider';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: { default: t('shell.navLabel'), template: `%s — ${t('brand.name')}` }, robots: { index: false, follow: false } };
}

/**
 * Workspace segment: private, rendered per request, never cached. Shell data for each demo persona is
 * computed here (server) and the client shell selects the active one from the query; pages gate access
 * with `requirePrincipal` and redirect anonymous visitors to `/login?next=`.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const active = await primeLocale();
  const demoMode = demoModeEnabled();
  const fallback = defaultPersona(demoMode);
  const shells: Partial<Record<Persona, ShellData>> = {};
  // Demo: one shell per persona, the client picks by `?persona=`. Live: the session's shell under the default key only.
  for (const persona of demoMode ? PERSONAS : [fallback]) {
    const principal = await data.principalFor(demoMode ? { persona, scenario: 'default', fromQuery: persona !== fallback, defaultPersona: fallback } : LIVE_CONTEXT);
    if (!principal) continue;
    shells[persona] = {
      name: principal.displayName,
      pinned: principal.pinned,
      attention: principal.attention,
      notifications: principal.notifications,
      assistantUnread: principal.assistant.unread,
      isPlatformAdmin: principal.isPlatformAdmin,
    };
  }
  return (
    <LocaleNamespaces {...clientLayers(active.locale, 'workspace')}>
      <WorkspaceShell shells={shells} defaultPersona={fallback} demoMode={demoMode} localeControl={<HeaderLocaleSwitcher />}>
        {children}
      </WorkspaceShell>
    </LocaleNamespaces>
  );
}

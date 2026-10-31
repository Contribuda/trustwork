import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../auth.css';
import './workspace.css';
import { WorkspaceShell, type ShellData } from '@/components/workspace/WorkspaceShell';
import { HeaderLocaleSwitcher } from '@/components/locale/LocaleControls';
import { data } from '@/app/_lib/data';
import { PERSONAS, defaultPersona, type Persona } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

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
  await primeLocale();
  const fallback = defaultPersona();
  const shells: Partial<Record<Persona, ShellData>> = {};
  for (const persona of PERSONAS) {
    const principal = await data.principalFor({ persona, scenario: 'default', fromQuery: persona !== fallback, defaultPersona: fallback });
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
    <WorkspaceShell shells={shells} defaultPersona={fallback} localeControl={<HeaderLocaleSwitcher />}>
      {children}
    </WorkspaceShell>
  );
}
